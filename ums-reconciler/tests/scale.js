/* A 100,000-row sheet.
 *
 * Four things each cost the whole main thread at that size, and the first one is the reason a run
 * could sit for minutes showing nothing: paintRerun() called pickByStatus() once per ⟳ button —
 * six walks of every student and every result, each building an array of the matches only to read
 * .length off it — and paintTiles() calls it about eight times a second.
 *
 * The risky half of that fix is the counting: the tally must agree with the walk for every bucket,
 * or the ⟳ buttons show wrong numbers and disable themselves on students that are really there.
 * That equivalence is checked here against both implementations, not asserted.
 *
 *   node tests/scale.js
 */
"use strict";
const fs = require("fs");
const path = require("path");

const APP = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const HTML = fs.readFileSync(path.join(__dirname, "..", "app.html"), "utf8");

let fail = 0;
const check = (name, ok, extra) => {
  if (!ok) fail++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (!ok && extra !== undefined ? "   " + extra : ""));
};
function src(name) {
  let at = APP.indexOf("function " + name + "(");
  if (at < 0) throw new Error("no such function: " + name);
  if (APP.slice(at - 6, at) === "async ") at -= 6;
  let depth = 0;
  for (let j = APP.indexOf("{", at); j < APP.length; j++) {
    if (APP[j] === "{") depth++;
    else if (APP[j] === "}") { depth--; if (!depth) return APP.slice(at, j + 1); }
  }
  throw new Error("unbalanced " + name);
}
const line = (re) => (re.exec(APP) || [""])[0];

/* the six ⟳ buttons the page actually has */
const BUTTONS = (HTML.match(/data-rr="(\w+)"/g) || []).map((m) => /"(\w+)"/.exec(m)[1]);
check("every tile carries a ⟳ button", BUTTONS.length >= 6, BUTTONS.join(","));

/* ---------- the tally must agree with the walk, bucket for bucket ---------- */
{
  const build = (students) => new Function("students", "srvMode",
    line(/const T = \{[^\n]*\};/) + "\n" +
    line(/const notOk = function \(st\) \{[^\n]*\};/) + "\n" +
    line(/const bucketCount = function \(st\) \{[^\n]*\};/) + "\n" +
    line(/const tileKey = function \(st\) \{[\s\S]*?\};/) + "\n" +
    src("bumpTile") + "\n" + src("recountAll") + "\n" + src("pickByStatus") + "\n" +
    "return { T: T, recountAll: recountAll, pickByStatus: pickByStatus, bucketCount: bucketCount };"
  )(students, false);

  /* every status a run can produce, including a Reg carrying several programs */
  const STS = ["ok", "no", "cw", "zero", "nf", "error"];
  const students = [];
  for (let i = 0; i < 3000; i++) {
    const n = 1 + (i % 3);
    const results = [];
    for (let j = 0; j < n; j++) results.push({ item: {}, res: { st: STS[(i + j) % STS.length], spid: String(j) } });
    students.push({ reg: "R" + i, results: results });
  }
  const api = build(students);
  api.recountAll();

  let agreed = 0;
  BUTTONS.forEach(function (b) {
    const walked = api.pickByStatus(b).length, counted = api.bucketCount(b);
    check("⟳ " + b + ": the tally matches the walk", walked === counted, counted + " vs " + walked);
    if (walked === counted) agreed++;
  });
  check("every bucket agrees", agreed === BUTTONS.length, agreed + "/" + BUTTONS.length);
  /* the one that is not a status at all but a union of them */
  check("Total Problem is still the sum of the failing buckets",
    api.bucketCount("prob") === api.T.no + api.T.cw + api.T.nf + api.T.err,
    api.bucketCount("prob") + " vs " + (api.T.no + api.T.cw + api.T.nf + api.T.err));
  /* nothing at all — the buttons must go quiet, not read NaN */
  const empty = build([]); empty.recountAll();
  BUTTONS.forEach(function (b) {
    check("⟳ " + b + " reads 0 on an empty run", empty.bucketCount(b) === 0, String(empty.bucketCount(b)));
  });
}

/* ---------- and it must be cheap, which was the whole point ---------- */
{
  const N = 100000;
  const students = [];
  for (let i = 0; i < N; i++) {
    students.push({ reg: "R" + i, results: [{ item: {}, res: { st: ["ok", "ok", "ok", "no", "cw"][i % 5] } }] });
  }
  const api = new Function("students", "srvMode",
    line(/const T = \{[^\n]*\};/) + "\n" +
    line(/const notOk = function \(st\) \{[^\n]*\};/) + "\n" +
    line(/const bucketCount = function \(st\) \{[^\n]*\};/) + "\n" +
    line(/const tileKey = function \(st\) \{[\s\S]*?\};/) + "\n" +
    src("bumpTile") + "\n" + src("recountAll") + "\n" + src("pickByStatus") + "\n" +
    "return { recountAll: recountAll, pickByStatus: pickByStatus, bucketCount: bucketCount };"
  )(students, false);
  api.recountAll();

  const time = (fn) => { const t = process.hrtime.bigint(); fn(); return Number(process.hrtime.bigint() - t) / 1e6; };
  const walked = time(() => BUTTONS.forEach((b) => api.pickByStatus(b).length));
  const counted = time(() => BUTTONS.forEach((b) => api.bucketCount(b)));

  /* paintTiles() runs this about eight times a second while a run is going, so anything that
     scales with the sheet is main thread the run needed for its own fetches */
  check("one repaint at 100,000 students costs under a millisecond",
    counted < 1, counted.toFixed(3) + " ms  (walking them: " + walked.toFixed(1) + " ms)");
  check("…and does not grow with the sheet",
    /const n = bucketCount\(st\);/.test(APP) && !/pickByStatus\(st\)\.length/.test(APP),
    "app.js");
  /* pickByStatus is still needed — the ⟳ press has to know WHICH students to re-run, not how many */
  check("…while ⟳ itself still collects the real students",
    /const jobs = pickByStatus\(st\);/.test(APP), "app.js");
}

/* ---------- the preview is a preview ---------- */
{
  const m = /var PV_MAX = (\w+);/.exec(APP);
  check("PV_MAX is a finite cap", !!m && m[1] !== "Infinity" && +m[1] > 0 && +m[1] <= 2000,
    m ? m[1] : "not found");
  /* the box is ~5 rows tall and the rest scrolls, so drawing 100k of them was paid for and never
     seen — and renderPreview() re-runs on every keystroke in the search box */
  check("…and search still looks at every row, only the drawing stops",
    /matched\.push\(\{ e: e, i: i \}\);/.test(APP) && /const show = matched\.slice\(0, PV_MAX\);/.test(APP),
    "app.js");
  check("…and it says how many it is not showing", /t\("pv_more"\)/.test(APP), "app.js");
}

/* ---------- the results list stops growing ---------- */
{
  check("the list has a cap", /const LIST_MAX = (\d+);/.test(APP), "app.js");
  check("…applied when a card is built",
    /listTotal\+\+;[^\n]*\s*if \(listShown >= LIST_MAX\) return;/.test(APP), "app.js");
  check("…counting the ones it does not draw, so it can say so",
    /function paintListNote\(\)/.test(APP) && /id="listNote"/.test(HTML), "app.js / app.html");
  /* and it has to say it WHILE the run fills the list — a long run stops adding cards a
     thousand in, and without this the list just quietly stops growing with nothing to
     explain it */
  check("…and says so during the run, not only when the list is rebuilt",
    /paintTiles\(\); paintListNote\(\); prog\(\);/.test(APP), "app.js");
  /* A card the filter hides must not spend a slot. Measured with 5,000 students whose 64
     mismatches all sat past row 1,200 — where a sheet sorted by Reg puts them — and "শুধু অমিল"
     selected: 1,000 cards drawn, 0 visible, every mismatch missing from the one view meant to
     show them. The cap is for the browser; it must never decide what the user gets to see. */
  /* The decision is now taken from the answers before any HTML is composed, which is also what
     makes re-rendering on a filter change affordable. tests/filter-shows.js checks the behaviour;
     this checks that the order has not slipped back. */
  {
    const rs = src("renderStudent");
    const decide = rs.indexOf("matchFilter");
    const count = rs.indexOf("listTotal++");
    const build = rs.indexOf("div.innerHTML = h;");
    check("a hidden card does not spend a slot",
      decide > 0 && decide < count && count < build, "renderStudent");
  }
  check("…and a re-render starts the count over",
    /l\.innerHTML = ""; listShown = 0; listTotal = 0;/.test(APP), "app.js");
  /* Hiding cards is not enough once the list is capped: the ones that match may be past the cap
     and never drawn at all, so changing the filter has to re-pick which LIST_MAX are on screen —
     during a run too, which is when a run of this size is actually looked at. Reported from a real
     run as "Mismatch says 3, the list shows 1". */
  check("changing the filter re-picks which cards are drawn",
    /rerenderList\(\);/.test(src("setFilter")) && !/applyFilterAll/.test(src("setFilter")), "setFilter");
  const en = /list_capped: \{ bn: "[^"]*", en: "([^"]*)" \}/.exec(APP);
  check("the note has clean English", !!en && !/[ঀ-৿]/.test(en[1]), en ? en[1] : "not found");
  /* the list is for looking at; the reports are the deliverable and must still carry everything */
  check("the exports are NOT capped",
    !/LIST_MAX/.test(APP.slice(APP.indexOf("function flatRows"), APP.indexOf("function ver()"))),
    "app.js");
}

/* ---------- Start says something the moment it is pressed ---------- */
{
  /* inside startRun, and before ITS worker — there are other worker() functions in the file
     (the sweep, the ⟳ re-run), so the comparison has to be made within the one that matters */
  const body = src("startRun");
  const at = body.indexOf('$("prog").textContent = "⏳ 0/" + T.total');
  check("the progress line is written before the workers start",
    at > 0 && at < body.indexOf("async function worker(n) {"),
    at < 0 ? "not in startRun" : "written after the workers");
  /* and Start must not leave the previous run's count sitting there while the new one warms up */
  check("…after the tally is cleared, so it starts from zero",
    body.indexOf("T.total = entries.length;") < at, "app.js");
}

console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
process.exit(fail ? 1 : 0);
