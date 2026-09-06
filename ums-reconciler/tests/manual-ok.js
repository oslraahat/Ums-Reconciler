/* "I checked this one in UMS myself and it is fine."
 *
 * Four of the mismatches reported in one week turned out to be the tool's own rules, not the data.
 * Until each was fixed the same students came back every run, and there was no way to say "looked
 * at it, it is correct" — so the work list never shrank and the real faults sat among the noise.
 *
 * ✓ Mark as Matched records that verdict. Two things it must NOT do:
 *   1. pretend the receipt was clean — the finding stays on the row and in the export, and the
 *      status says a person moved it, not the tool;
 *   2. stay stuck — the verdict is filed against the exact wording of the finding it answers, so
 *      when a rule changes or the receipt does, the signature stops matching and the student comes
 *      back for a fresh look instead of being silently cleared for ever.
 *
 *   node tests/manual-ok.js
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
    const at = APP.search(new RegExp("\\n  (?:function " + n + "\\s*\\(|const " + n + "\\s*=)"));
    if (at < 0) throw new Error("could not find " + n + " in app.js");
    let i = APP.indexOf("{", at), depth = 0;
    for (let j = i; j < APP.length; j++) {
      if (APP[j] === "{") depth++;
      else if (APP[j] === "}") { depth--; if (!depth) return APP.slice(at, j + 1); }
    }
    throw new Error("unbalanced " + n);
  }).join("\n");
  // the bits markStudent() calls to repaint — irrelevant here, so they are no-ops
  return new Function("manualOk", "saveManual", "recountAll", "paintTiles", "rerenderList",
    "applyFilterAll", src + "\n; return { applyManual: applyManual, markStudent: markStudent, notOk: notOk };");
}
const build = lift(["notOk", "manualKey", "applyManual", "markStudent"]);
function fresh(store) {
  const saved = { n: 0 };
  const api = build(store, function () { saved.n++; }, function () {}, function () {},
    function () {}, function () {});
  api.saved = saved;
  return api;
}

const row = (st, spid, detail) => ({ res: { st: st, spid: spid, detail: detail } });
const FIND = "Cash Back মিলছে না · [Program ↔ Course] CRN 9643232014 — Program Wise 0 ≠ Course Wise 5,185";

/* ---- marking one flagged student ---- */
{
  const store = {};
  const api = fresh(store);
  const stu = { reg: "2365277", results: [row("no", "2394829", FIND)] };
  api.markStudent(stu, false);

  check("the row stops counting as a problem", api.notOk(stu.results[0].res.st) === false, stu.results[0].res.st);
  check("…and is flagged as a human verdict, not the tool's", stu.results[0].res.manual === true);
  check("…which remembers what it used to be", stu.results[0].res.manualOf === "no", stu.results[0].res.manualOf);
  /* the finding is the record of what was wrong; clearing the verdict must not erase it, or the
     export would claim the receipt was clean */
  check("the finding itself is untouched", stu.results[0].res.detail === FIND);
  check("the verdict is stored under Reg + Student PID", store["2365277|2394829"] === FIND,
    JSON.stringify(Object.keys(store)));
  check("…and written to storage", api.saved.n === 1, api.saved.n);
}

/* ---- undo ---- */
{
  const store = {};
  const api = fresh(store);
  const stu = { reg: "2365277", results: [row("no", "2394829", FIND)] };
  api.markStudent(stu, false);
  api.markStudent(stu, true);
  check("undo puts the mismatch back", stu.results[0].res.st === "no", stu.results[0].res.st);
  check("…and clears the flag", !stu.results[0].res.manual);
  check("…and forgets the verdict", Object.keys(store).length === 0, JSON.stringify(store));
}

/* ---- a card holding several programs ---- */
{
  const store = {};
  const api = fresh(store);
  const stu = { reg: "R1", results: [row("no", "A", "x"), row("ok", "B", "সব মিলেছে"), row("cw", "C", "y")] };
  api.markStudent(stu, false);
  check("every flagged program on the card is cleared",
    stu.results[0].res.manual === true && stu.results[2].res.manual === true);
  /* an already-clean row must not be marked — it was never a verdict anyone made, and undo would
     then hand it a status it never had */
  check("…but a clean one is left alone", !stu.results[1].res.manual && stu.results[1].res.st === "ok");
  check("…and only the cleared ones are stored", Object.keys(store).length === 2, JSON.stringify(Object.keys(store)));
  api.markStudent(stu, true);
  check("undo restores each to its own status",
    stu.results[0].res.st === "no" && stu.results[2].res.st === "cw" && stu.results[1].res.st === "ok",
    stu.results.map((x) => x.res.st).join(","));
}

/* ---- the signature guard: the whole point of storing the wording ---- */
{
  const store = { "2365277|2394829": FIND };
  const api = fresh(store);

  const same = { st: "no", spid: "2394829", detail: FIND };
  api.applyManual(same, "2365277");
  check("a run that finds the same thing stays cleared", same.st === "ok" && same.manual === true);

  /* the amount moved, so this is not the finding that was checked */
  const moved = { st: "no", spid: "2394829", detail: FIND.replace("5,185", "9,999") };
  api.applyManual(moved, "2365277");
  check("a finding that changed comes back for a fresh look", moved.st === "no" && !moved.manual,
    moved.st);

  const otherStudent = { st: "no", spid: "9999999", detail: FIND };
  api.applyManual(otherStudent, "2365277");
  check("…and the verdict does not spread to another program", otherStudent.st === "no");

  const clean = { st: "ok", spid: "2394829", detail: FIND };
  api.applyManual(clean, "2365277");
  check("a clean row is never touched", clean.st === "ok" && !clean.manual);

  const zero = { st: "zero", spid: "2394829", detail: FIND };
  api.applyManual(zero, "2365277");
  check("…nor is Zero Pay, which is not a problem either", zero.st === "zero" && !zero.manual);
}

/* ---- the wiring ---- */
{
  const HTML = fs.readFileSync(path.join(__dirname, "..", "app.html"), "utf8");
  check("the button sits on the student header", /<span class="mut">[\s\S]{0,140}\+ mk \+/.test(APP), "app.js");
  check("…pushed to the right edge", /\.stu \.sh \.mk\{[^}]*margin-left:auto/.test(HTML), "app.html");
  check("…and only where there is something to clear",
    /const mk = \(anyManual \|\| anyBad\)/.test(APP), "app.js");
  check("clicking it is handled by delegation, so late cards work too",
    /e\.target\.closest\(".mk"\)/.test(APP), "app.js");
  check("the row says a person cleared it", /x\.res\.manual \? t\("pill_manual"\)/.test(APP), "app.js");
  check("…and so does the exported Status", /x\.res\.manual \? "Matched \(manual\)"/.test(APP), "app.js");
  check("the verdicts are reloaded on the next run", /if \(o\.manualOk\) manualOk = o\.manualOk/.test(APP), "app.js");
  check("…and applied as each result comes in", /applyManual\(res0, stu\.reg\)/.test(APP), "app.js");

  ["mk_do", "mk_undo", "mk_tip", "mk_tip_undo", "pill_manual"].forEach(function (k) {
    const m = APP.match(new RegExp(k + ': \\{ bn: "([^"]*)", en: "([^"]*)" \\}'));
    check(k + " exists in both languages", !!m, k);
    if (m) check(k + " — the English carries no Bangla", !/[ঀ-৿]/.test(m[2]), m[2]);
  });
}

console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
process.exit(fail ? 1 : 0);
