/* CSV reading and column detection, split out of app.js.
   parseCSV and detectCols are pure. swapCheck asks UMS which way round the columns are, so it
   reaches resolvePrograms through self.APP — the one app-level call it makes, wrapped below so the
   body still names it plainly (which is also how the tests lift and run it).

   The import ORCHESTRATION stays in app.js on purpose: applyImported, renderPreview, the sheet
   picker and setSource are welded to `entries` (which the whole run reads) and to importSrc/srcBase
   (which the checkpoint writes and reads too), and the tests pin all three as bare identifiers in
   app.js. Moving them would mean setters that the assertions forbid, so only the pure readers move,
   the same way lib/xlsx.js took the pure workbook engine and left the wiring behind. */
(function () {
  "use strict";
  /* the single app-level call swapCheck makes; kept plain so the body reads the same whoever runs it */
  function resolvePrograms(reg) { return self.APP.resolvePrograms(reg); }

  function parseCSV(text) {
    text = String(text).replace(/^﻿/, "");
    const rows = []; let row = [], cur = "", q = false;
    for (let i = 0; i < text.length; i++) { const ch = text[i]; if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; } else if (ch === '"') q = true; else if (ch === ",") { row.push(cur); cur = ""; } else if (ch === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; } else if (ch !== "\r") cur += ch; }
    if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (c) { return String(c).trim() !== ""; }); });
  }
  function detectCols(rows) {
    /* Is a header a Registration/Roll column? Match whole WORDS, not substrings — a substring
       /reg|roll/ wrongly grabs "Enrollment", "Payroll", "Region", "Aggregate" and would then read
       every row against the wrong id (the whole sheet silently comes back "wrong reg / no permission").
       Kept nested so the test harness, which lifts detectCols out by name, carries it along. */
    const looksReg = function (h) {
      const toks = String(h).replace(/[._/]/g, " ").split(/[^a-z0-9]+/).filter(Boolean);
      for (let i = 0; i < toks.length; i++) {
        const w = toks[i];
        if (w === "reg" || w === "regn" || w === "regno" || w === "registration" || w === "roll" || w === "rollno") return true;
      }
      return false;
    };
    const first = rows[0].map(function (c) { return String(c).toLowerCase().trim(); });
    let reg = -1, spid = -1, prog = -1, hdr = false, regHdr = false;
    first.forEach(function (h, i) {
      if (reg < 0 && looksReg(h)) { reg = i; hdr = true; regHdr = true; }   // regHdr: the Reg column was actually NAMED (not a positional guess)
      if (spid < 0 && /spid|program\s*id/.test(h)) { spid = i; hdr = true; }   // matches "spid", "programid", "program id", "student program id"
      if (prog < 0 && !/program\s*id/.test(h) && /program\s*session|programsession|(^|[^a-z])program([^a-z]|$)/.test(h)) { prog = i; hdr = true; }
    });
    if (reg < 0) reg = 0;
    let mode, val;
    /* Remember whether a header actually named the columns. When it did not, reg and val below are
       nothing more than "first column" and "second column" — see swapCheck(), which asks UMS which
       way round they really are instead of trusting the order. */
    if (spid >= 0) { mode = "spid"; val = spid; }
    else if (prog >= 0 && prog !== reg) { mode = "program"; val = prog; }
    else { mode = "spid"; val = (reg === 1 ? 0 : 1); }
    return { reg: reg, val: val, mode: mode, hdr: hdr, regHdr: regHdr };
  }
  /* Are the Reg and Student PID columns the right way round?
   *
   * When the sheet has no header row, detectCols() can only go by position: first column Reg,
   * second Student PID. A file written the other way round then produces a URL with each id in the
   * other's slot. Program Wise still answers — it looks the student up by only one of them — so the
   * run completes and every single row reports "Course Wise page did not open (wrong reg, or no
   * permission?)". Twenty-three rows came back that way, all of them wrong in the same silent
   * direction, and nothing in the numbers gives it away: a Reg and a Student PID are both seven
   * digits.
   *
   * UMS knows the answer, so ask it. resolvePrograms(x) returns the programmes of the student
   * registered as x, each with its real Student PID. Take a few sample rows and try both readings:
   *
   *   as written   resolvePrograms(colA) contains colB   → colA is Reg
   *   swapped      resolvePrograms(colB) contains colA   → colB is Reg
   *
   * Whichever reading more rows agree with wins. A tie, or no answer at all (offline, no
   * permission, an empty sheet), changes nothing — the guess stands, because a wrong correction
   * would be worse than the wrong guess it replaced.
   */
  async function swapCheck(rows, d) {
    /* Verify unless the Reg column was actually NAMED. A header row may exist (d.hdr) yet not name
       Reg — then reg is a positional guess and still needs UMS to confirm which way round it is. */
    if (d.regHdr || d.mode !== "spid" || d.reg === d.val) return null;
    /* A row whose two values are equal cannot tell the two readings apart — swapping them gives
       the identical pair — yet has(a,b) and has(b,a) are then the same call, so it would cast a
       free vote for "as written" while carrying no information. Out of three votes that is enough
       to hold a genuinely swapped sheet the wrong way round, so such rows are not sampled. */
    const sample = rows.filter(function (r) {
      const a = String(r[d.reg] || "").trim(), b = String(r[d.val] || "").trim();
      return /^\d+$/.test(a) && /^\d+$/.test(b) && a !== b;
    }).slice(0, 3);
    if (!sample.length) return null;

    let asWritten = 0, swapped = 0;
    for (const r of sample) {
      const a = String(r[d.reg]).trim(), b = String(r[d.val]).trim();
      const has = async function (reg, spid) {
        try {
          const list = await resolvePrograms(reg);
          return list.some(function (p) { return String(p.spid) === spid; });
        } catch (e) { return null; }        // no permission / offline — this row says nothing
      };
      if (await has(a, b)) asWritten++;
      else if (await has(b, a)) swapped++;
    }
    return swapped > asWritten ? { reg: d.val, val: d.reg } : null;
  }

  self.APP = self.APP || {};
  self.APP.imp = { parseCSV: parseCSV, detectCols: detectCols, swapCheck: swapCheck };
})();
