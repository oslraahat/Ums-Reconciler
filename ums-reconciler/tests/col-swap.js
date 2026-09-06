/* A sheet with no header row, written Student PID first and Reg second.
 *
 * Twenty-three rows came back saying "Course Wise page did not open (wrong reg, or no permission?)
 * — Program Wise loaded fine (3 attempts)". Every one of them was wrong the same way: detectCols()
 * had no header to read, fell back to "first column is Reg, second is Student PID", and the file
 * was the other way round. Checked against the database, not one of the 23 "Reg" values was a
 * registration number — all 23 were StudentProgramIds, and all 23 "Student PID" values were the
 * registration numbers of those very programmes' students.
 *
 * Nothing in the data betrays it. Both ids are seven digits. Program Wise still answers, because it
 * finds the student from one id alone, so the run completes and looks like a permissions problem on
 * the Course Wise side.
 *
 * So the extension asks UMS instead of guessing: resolvePrograms(reg) lists that student's real
 * Student PIDs, and whichever way round makes the pair agree is the way the sheet is written.
 *
 *   node tests/col-swap.js
 */
"use strict";
const fs = require("fs");
const path = require("path");

const APP = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

let fail = 0;
const check = (name, ok, extra) => { if (!ok) fail++; console.log((ok ? "PASS  " : "FAIL  ") + name + (!ok && extra ? "   " + extra : "")); };

/* ---- lift the real functions out of app.js so this cannot drift from what ships ---- */
function lift(names) {
  const src = names.map(function (n) {
    const at = APP.search(new RegExp("\\n  (?:async function " + n + "\\s*\\(|function " + n + "\\s*\\(|const " + n + "\\s*=)"));
    if (at < 0) throw new Error("could not find " + n + " in app.js");
    let i = APP.indexOf("{", at), depth = 0;
    for (let j = i; j < APP.length; j++) {
      if (APP[j] === "{") depth++;
      else if (APP[j] === "}") { depth--; if (!depth) return APP.slice(at, j + 1); }
    }
    throw new Error("unbalanced " + n);
  }).join("\n");
  return new Function("inputMode", "resolvePrograms",
    src + "\n; return { detectCols: detectCols, swapCheck: swapCheck };");
}
const build = lift(["detectCols", "swapCheck"]);

/* The real pairs, from the run that failed. First value is the StudentProgramId, second the
   registration number — confirmed against StudentProgram and Student in the database. */
const REAL = [
  ["6719222", "5047342"], ["6727277", "3889972"], ["6729105", "5053099"],
  ["6741817", "5058991"], ["6746967", "1618670"]
];

/* a stand-in UMS: knows which programmes belong to which registration number */
function ums(pairs) {
  const byReg = {};
  pairs.forEach(function (p) { (byReg[p[1]] = byReg[p[1]] || []).push({ spid: p[0] }); });
  const asked = [];
  const fn = async function (reg) { asked.push(reg); return byReg[String(reg)] || []; };
  fn.asked = asked;
  return fn;
}

const api = (mode, resolve) => build(mode || "auto", resolve);

(async function () {
  /* ---- the bug ---- */
  {
    const rows = REAL.map(function (p) { return [p[0], p[1]]; });   // PID first, Reg second
    const a = api("auto", ums(REAL));
    const d = a.detectCols(rows);
    check("with no header, the columns are only a guess", d.hdr === false);
    check("…and the guess is the wrong way round here", d.reg === 0 && d.val === 1);

    const flip = await a.swapCheck(rows, d);
    check("asking UMS finds the swap", !!flip);
    if (flip) {
      check("…and puts Reg on the column that really holds it", flip.reg === 1, String(flip.reg));
      check("…and Student PID on the other", flip.val === 0, String(flip.val));
    }
  }

  /* ---- a correctly written sheet must be left alone ---- */
  {
    const rows = REAL.map(function (p) { return [p[1], p[0]]; });   // Reg first, PID second
    const a = api("auto", ums(REAL));
    const flip = await a.swapCheck(rows, a.detectCols(rows));
    check("a sheet already the right way round is not touched", flip === null);
  }

  /* ---- a named header is trusted; no round-trip ---- */
  {
    const rows = [["StudentProgramId", "Registration No."]].concat(REAL.map(function (p) { return [p[0], p[1]]; }));
    const resolve = ums(REAL);
    const a = api("auto", resolve);
    const d = a.detectCols(rows);
    check("a header names the columns without help", d.hdr === true && d.reg === 1 && d.val === 0,
      "reg=" + d.reg + " val=" + d.val);
    check("…and no request is made when it does", (await a.swapCheck(rows.slice(1), d)) === null &&
      resolve.asked.length === 0, resolve.asked.length + " requests");
  }

  /* ---- UMS unreachable: the guess must stand ---- */
  {
    const rows = REAL.map(function (p) { return [p[0], p[1]]; });
    const dead = async function () { throw new Error("no permission"); };
    const a = api("auto", dead);
    /* a wrong correction is worse than the wrong guess it replaces: at least the guess is the one
       the sheet's own order implies, and the failure is reported honestly */
    check("no answer from UMS changes nothing", (await a.swapCheck(rows, a.detectCols(rows))) === null);
  }

  /* ---- rows that cannot decide ---- */
  {
    const rows = [["", ""], ["abc", "def"]];
    const a = api("auto", ums(REAL));
    check("non-numeric rows are not used to decide",
      (await a.swapCheck(rows, a.detectCols(rows))) === null);
  }

  /* ---- the wiring ---- */
  {
    check("the check runs on import", /const flip = await swapCheck\(/.test(APP), "app.js");
    check("…and applyImported waits for it", /async function applyImported\(/.test(APP), "app.js");
    check("the swap is reported, not applied silently",
      /if \(flip\) note \+= .*imp_swap/.test(APP), "app.js");
    check("…and the wait says what it is for", /t\("imp_checking"\)/.test(APP), "app.js");
    ["imp_swap", "imp_checking"].forEach(function (k) {
      const m = APP.match(new RegExp(k + ': \\{ bn: "([^"]*)", en: "([^"]*)" \\}'));
      check(k + " exists in both languages", !!m, k);
      if (m) check(k + " — the English carries no Bangla", !/[ঀ-৿]/.test(m[2]), m[2]);
    });
  }

  console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
  process.exit(fail ? 1 : 0);
})();
