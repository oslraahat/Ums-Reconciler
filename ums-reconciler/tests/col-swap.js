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

  /* ---- a row whose two values are equal is not a vote ----
     Swapping equal values gives the identical pair, so such a row cannot tell the two readings
     apart. But has(a,b) and has(b,a) are then the SAME call, so it used to be counted for "as
     written" — a free vote cast by a row carrying no information. Out of three sampled rows that
     is enough to hold a genuinely swapped sheet the wrong way round. */
  {
    /* a student whose registration number and programme id really are the same seven digits */
    /* Two of them, because the sample is three rows: one twin leaves the real rows in the
       majority, two do not. This is the size at which the free vote actually decides. */
    const TWIN = ["1733544", "1733544"], TWIN2 = ["1904221", "1904221"];
    const pairs = REAL.concat([TWIN, TWIN2]);
    /* the sheet is written PID-first, like the run that failed — and the twin row sits at the top,
       where the three-row sample will reach it */
    const rows = [TWIN, TWIN2].concat(REAL.map(function (p) { return [p[0], p[1]]; }));
    const a = api("auto", ums(pairs));
    const d = a.detectCols(rows);
    const flip = await a.swapCheck(rows, d);
    check("a swapped sheet is still found when a twin row is in the way", !!flip,
      JSON.stringify(flip));
    if (flip) check("…and swapped the right way", flip.reg === 1 && flip.val === 0, JSON.stringify(flip));

    /* and the twin row is never asked about, because there is nothing it could answer */
    const resolve = ums(pairs);
    await a.swapCheck(rows, d);
    const seen = api("auto", resolve);
    await seen.swapCheck(rows, seen.detectCols(rows));
    check("…the twin row is not put to UMS at all", resolve.asked.indexOf("1733544") < 0,
      resolve.asked.join(", "));

    /* a sheet that is genuinely the right way round still passes with a twin in it */
    const right = [TWIN, TWIN2].concat(REAL.map(function (p) { return [p[1], p[0]]; }));
    const b = api("auto", ums(pairs));
    check("…and a correct sheet is still left alone",
      (await b.swapCheck(right, b.detectCols(right))) === null);
  }

  /* ---- and one row where the two ids are equal is not proof of anything ----
     That used to be treated as a swapped column and the student was refused before a single page
     was fetched. But UMS issues the two numbers from separate counters over ranges that almost
     entirely overlap — registrations from 1,436,567, programme ids from 1,604,822, both seven
     digits, 760,455 values in common — so on a 100,000-row sheet the odds that some student's two
     numbers coincide are about one in eight. That student then became an error no re-run could
     clear, because the check fired before any fetch and the answer never changed.

     A swapped column is a whole-sheet mistake, and swapCheck() above already asks UMS about it
     before the run starts. What is left is a hint, and a hint belongs where the student fails. */
  {
    check("equal ids no longer refuse the student outright",
      !/=== String\(stu\.reg\)\.trim\(\)\) return \{ st: "error"/.test(APP) &&
      /const regEqSpid = String\(spid\)\.trim\(\) === String\(stu\.reg\)\.trim\(\);/.test(APP),
      "app.js");
    /* the whole point: the pages are fetched, so a genuine coincidence checks out like any student */
    check("…so the run reaches testOne like any other row",
      APP.indexOf("const regEqSpid") < APP.indexOf("out = srvMode ? await testOneServers"), "app.js");
    /* and it is mentioned only where it explains something — never on a student that checked out */
    check("…and the hint is attached only when the programme was not found",
      /if \(regEqSpid && out\.notFound\) \{/.test(APP), "app.js");
    check("…to the exported detail as well as the line on screen",
      /res0\.detail \+= " · " \+ t\("e_regspid"\);[\s\S]{0,120}?res0\.detailFull \+= " · " \+ t\("e_regspid"\);/.test(APP),
      "app.js");
    /* it reads as a verdict if it is worded as one */
    const m = /e_regspid: \{ bn: "([^"]*)", en: "([^"]*)" \}/.exec(APP);
    check("…and it is worded as a hint, not a verdict",
      !!m && /check|দেখো/.test(m[1] + m[2]), m ? m[2] : "not found");
    /* the real defence against a swapped column is still the one that asks UMS */
    check("…while swapCheck still guards the sheet as a whole",
      /async function swapCheck\(rows, d\)/.test(APP), "app.js");
  }

  console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
  process.exit(fail ? 1 : 0);
})();
