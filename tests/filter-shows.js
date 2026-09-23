/* The list has to show what the tiles count.
 *
 * Reported from a real run: the Mismatch tile said 3 and the list showed 1.
 *
 * The list draws at most LIST_MAX cards. A hidden card no longer spends that allowance — but a
 * card that was never drawn cannot be hidden or shown, and during a run the filter only hid and
 * showed what was already on screen:
 *
 *     if (run) applyFilterAll(); else rerenderList();
 *
 * On a run of 90,385 students the first thousand were drawn under "All"; pressing "Mismatch" hid
 * 999 of them. The other two mismatches were students 1,200 and 40,000 — never drawn, and hiding
 * cannot bring them back. The tiles counted all three, because tiles count answers, not cards.
 * A run that size takes hours, which is exactly when someone stands there filtering.
 *
 * What this checks is the invariant behind the complaint: for any filter, the number of cards on
 * screen is what that filter is worth — every matching student, up to the cap, and no fewer.
 *
 *   node tests/filter-shows.js
 */
"use strict";
const fs = require("fs");
const path = require("path");

const APP = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

let fail = 0;
const check = (name, ok, extra) => {
  if (!ok) fail++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (!ok && extra !== undefined ? "   " + extra : ""));
};

function src(name) {
  let at = APP.indexOf("function " + name + "(");
  if (at < 0) throw new Error("no such function: " + name);
  let d = 0;
  for (let j = APP.indexOf("{", at); j < APP.length; j++) {
    if (APP[j] === "{") d++;
    else if (APP[j] === "}") { d--; if (!d) return APP.slice(at, j + 1); }
  }
  throw new Error("unbalanced " + name);
}
const LIST_MAX = +(/const LIST_MAX = (\d+);/.exec(APP) || [])[1];

/* A DOM small enough to be honest: cards are objects, appendChild collects them, and the only
   thing being measured is which students got drawn. */
function board(students, filter, duringRun) {
  /* `children` is the same array the cards land in — the old code hid what was already on screen
     by walking it, and without it a revert would throw here instead of reporting what it drew. */
  const list = { kids: [], innerHTML: "", appendChild: function (d) { this.kids.push(d); } };
  Object.defineProperty(list, "children", { get: function () { return this.kids; } });
  const env = {
    students: students,
    filter: "all",     // a page starts here; setFilter is what moves it
    listShown: 0, listTotal: 0,
    renderBuf: null,
    LIST_MAX: LIST_MAX,
    $: function (id) { return id === "list" ? list : null; },
    document: { createElement: function () { return { className: "", style: {}, innerHTML: "", querySelectorAll: function () { return []; } }; },
      createDocumentFragment: function () { return { childNodes: [], appendChild: function (d) { this.childNodes.push(d); } }; },
      querySelectorAll: function () { return []; } },
    esc: function (s) { return String(s == null ? "" : s); },
    t: function (k) { return k; },
    PILLC: { ok: "ok", no: "no", cw: "mut", zero: "mut", nf: "mut", error: "no" },
    notOk: function (st) { return st !== "ok" && st !== "zero"; },
    pwUrl: function () { return "#"; },
    srvMode: false, baseUrl2: "",
    paintListNote: function () {},
    applyFilterTo: function () {},
    run: duringRun ? { stop: false } : null
  };
  const names = Object.keys(env);
  /* Driven through setFilter(), not by calling rerenderList() directly — the fault was in what
     setFilter decides to do while a run is going, so that decision is what has to be exercised. */
  const fn = new Function(...names,
    src("matchFilter") + "\n" + src("renderStudent") + "\n" + src("rerenderList") + "\n" +
    src("applyFilterAll") + "\n" + src("setFilter") +
    "\nreturn function (list, want) { setFilter(want); return { drawn: list.kids.length, shown: listShown, total: listTotal }; };");
  return fn(...names.map(function (k) { return env[k]; }))(list, filter);
}

/* one card per student; a mismatch student carries a "no" row */
function sheet(n, badAt) {
  const bad = new Set(badAt);
  const out = [];
  for (let i = 0; i < n; i++) {
    const st = bad.has(i) ? "no" : "ok";
    out.push({ reg: String(100000 + i), items: [{ spid: "1" }], _resolved: null,
      results: [{ item: { spid: "1" }, res: { st: st, detail: "", why: "", spid: "1", program: "" } }] });
  }
  return out;
}

/* ---------- the run that was reported ---------- */
{
  /* three mismatches, two of them far past the cap — the shape of the screenshot */
  const students = sheet(90385, [4, 1200, 40000]);
  const all = board(students, "all");
  check("under All the list stops at the cap", all.drawn === LIST_MAX,
    all.drawn + " cards of " + LIST_MAX);

  const no = board(students, "no");
  check("under Mismatch every mismatch is drawn", no.drawn === 3,
    no.drawn + " cards for 3 mismatches");
  check("…and the note counts the same three", no.total === 3, no.total);

  /* the reported case exactly: the filter pressed while the run is still going */
  const mid = board(students, "no", true);
  check("…and the same while the run is still going", mid.drawn === 3,
    mid.drawn + " cards for 3 mismatches — the tile would say 3");
}

/* ---------- and the cap still holds when the matches themselves are many ---------- */
{
  const many = [];
  for (let i = 0; i < 5000; i++) many.push(i);
  const students = sheet(20000, many);
  const no = board(students, "no");
  check("more matches than the cap still stops at the cap", no.drawn === LIST_MAX,
    no.drawn + " cards");
  check("…while the note says how many there really are", no.total === 5000, no.total);
}

/* ---------- every filter, on one sheet ---------- */
{
  const students = [];
  const mix = { ok: 40, no: 7, cw: 5, zero: 3, nf: 2 };
  Object.keys(mix).forEach(function (st) {
    for (let i = 0; i < mix[st]; i++) {
      students.push({ reg: st + i, items: [{ spid: "1" }], _resolved: null,
        results: [{ item: { spid: "1" }, res: { st: st, detail: "", why: "", spid: "1", program: "" } }] });
    }
  });
  Object.keys(mix).forEach(function (st) {
    const r = board(students, st);
    check("the " + st + " filter draws all " + mix[st] + " of them", r.drawn === mix[st], r.drawn + " drawn");
  });
  const prob = board(students, "prob");
  check("Total Problem draws every student that needs one",
    prob.drawn === mix.no + mix.cw + mix.nf, prob.drawn + " drawn, expected " + (mix.no + mix.cw + mix.nf));
  const all = board(students, "all");
  check("All draws everyone", all.drawn === students.length, all.drawn + " drawn");
}

/* ---------- and the wiring that made it wrong ---------- */
{
  const sf = src("setFilter");
  check("changing the filter re-renders, run or no run",
    /rerenderList\(\);/.test(sf) && !/if \(run\)/.test(sf), "setFilter");
  /* the reason it could not afford to: a card was composed and then discarded */
  const rs = src("renderStudent");
  const decide = rs.indexOf("matchFilter");
  const build = rs.indexOf("div.innerHTML = h;");
  check("…which it can afford, because the card is not built until it is wanted",
    decide > 0 && decide < build, "renderStudent");
}

console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
process.exit(fail ? 1 : 0);
