/* How fast is it going?
 *
 * "It is slower than yesterday" could not be checked. The progress line counted answers and it
 * timed the run, but it never divided one by the other, and the only number that settles the
 * question — how long the whole thing took — arrived when the run was already over, against a
 * sheet that was probably a different size. So two runs were compared by memory.
 *
 * A rate is easy to compute and easy to get wrong at the edges: the first seconds of a run are
 * all latency and no answers, so a rate taken over them says 0/min, then 4,000/min, then settles.
 * A number that swings by a factor of ten is worse than no number, because it will be quoted.
 *
 *   node tests/rate.js
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
const DICT = new Function("return " + (/const DICT = \{[\s\S]*?\n  \};/.exec(APP) || [""])[0]
  .replace(/^const DICT = /, "").replace(/;$/, ""))();

/* the real prog(), with the run's state supplied */
function line(state) {
  const el = { textContent: "" };
  const now = state.t0 + state.elapsedMs;
  new Function("T", "t0", "running", "live", "conc", "lang", "$", "t", "mmss", "Date",
    src("rateNow") + src("prog") + "\nprog();")(
    { done: state.done, total: state.total }, state.t0, state.running || 0,
    state.live === undefined ? 25 : state.live, 25, state.lang || "en",
    (id) => (id === "prog" ? el : null),
    (k) => (DICT[k] ? DICT[k][state.lang || "en"] || DICT[k].en : k),
    new Function("return " + src("mmss").replace(/^function mmss/, "function mmss") + "\nreturn mmss;")(),
    { now: () => now });
  return el.textContent;
}

/* ---------- the edges, where a rate is a liability ---------- */
check("nothing is claimed in the first seconds",
  !/\/min/.test(line({ t0: 0, elapsedMs: 3000, done: 2, total: 1000 })),
  line({ t0: 0, elapsedMs: 3000, done: 2, total: 1000 }));
check("…nor on a handful of answers, however long it has been",
  !/\/min/.test(line({ t0: 0, elapsedMs: 60000, done: 3, total: 1000 })),
  line({ t0: 0, elapsedMs: 60000, done: 3, total: 1000 }));
check("…and the count and clock are still there while it waits",
  /2\/1000/.test(line({ t0: 0, elapsedMs: 3000, done: 2, total: 1000 })),
  line({ t0: 0, elapsedMs: 3000, done: 2, total: 1000 }));

/* ---------- and the arithmetic, once it is worth stating ---------- */
{
  /* 300 answers in 60 seconds is 300 a minute, and 700 left at that rate is 2:20 */
  const l = line({ t0: 0, elapsedMs: 60000, done: 300, total: 1000 });
  check("300 in a minute reads as 300/min", /300\/min/.test(l), l);
  check("…and the time left follows from it, not from the setting", /02:20 left/.test(l), l);
}
{
  const l = line({ t0: 0, elapsedMs: 120000, done: 100, total: 1000 });
  check("a slow run says so plainly", /50\/min/.test(l), l);
}
{
  /* the last answer: nothing left, so no estimate to give */
  const l = line({ t0: 0, elapsedMs: 60000, done: 1000, total: 1000 });
  check("no time is left when nothing is left", /1,?000\/min/.test(l) && !/left/.test(l), l);
}
check("the rate is said in Bengali too",
  /মিনিট/.test(line({ t0: 0, elapsedMs: 60000, done: 300, total: 1000, lang: "bn" })),
  line({ t0: 0, elapsedMs: 60000, done: 300, total: 1000, lang: "bn" }));

/* ---------- what the narrowing looks like beside it ---------- */
{
  const l = line({ t0: 0, elapsedMs: 60000, done: 300, total: 1000, live: 4 });
  check("a run that has narrowed still says both", /\/min/.test(l) && /🐢/.test(l), l);
}

/* ---------- and the line that is quoted afterwards ---------- */
{
  /* the run's own ✅, not the re-run sweep's — there is more than one line that ticks */
  const at = APP.lastIndexOf('"✅ " + t("p_done")');
  const tail = APP.slice(APP.lastIndexOf("const took", at), APP.indexOf(";", APP.indexOf("save_failed", at)));
  check("the finished line carries the rate as well as the clock",
    /const rate = took > 1000/.test(tail) && /t\("p_rate"\)/.test(tail), tail.slice(0, 120));
  /* it is the run's own elapsed time, not a fresh clock read after the file writing */
  check("…measured over the run, not including the saving", /mmss\(took\)/.test(tail), tail.slice(0, 200));
}

/* both languages, like every other line on the page */
check("both new lines are said in both languages",
  /p_rate: \{ bn: "[^"]+", en: "[^"]+" \}/.test(APP) &&
  /p_left: \{ bn: "[^"]+", en: "[^"]+" \}/.test(APP), "DICT");

console.log(fail ? "\n" + fail + " FAILED" : "\nall good");
process.exit(fail ? 1 : 0);
