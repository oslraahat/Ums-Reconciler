/* How fast is it going?
 *
 * "It is slower than yesterday" could not be checked. The progress line counted answers and it
 * timed the run, but it never divided one by the other, and the only number that settles the
 * question arrived when the run was already over, against a sheet that was probably a different
 * size. So two runs were compared by memory.
 *
 * The first attempt at a rate was T.done ÷ elapsed, and it was wrong twice.
 *
 * It answered the wrong question. That is an average over the whole run, and on a run that lasts
 * hours it is sticky: one that opened fast and has since been throttled goes on quoting the fast
 * number all afternoon, and the estimate built on it promises a finishing time already passed.
 *
 * And on a resumed run it answered with the wrong numerator. ckResume() puts every answer the
 * last run finished back into T.done before the new one starts, so tens of thousands of answers
 * were divided by seconds — a speed the run had never reached, reported to someone deciding
 * whether the tool was fast enough.
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
const constOf = (n) => +(new RegExp("const " + n + " = (\\d+);").exec(APP) || [])[1];

/* One run, with a clock we hold. The real rateNow() and prog() are lifted in; everything they
   read is supplied, and time only moves when this says so — a rate measured over a window cannot
   be checked any other way. */
function run(opts) {
  const el = { textContent: "" };
  const T = { done: opts.startDone || 0, total: opts.total };
  const marks = [];
  let NOW = 0;
  const state = { live: opts.live === undefined ? 25 : opts.live };
  const mmss = new Function("return " + src("mmss") + "\nreturn mmss;")();
  const span = new Function("mmss", src("span") + "\nreturn span;")(mmss);
  const made = new Function("T", "t0", "running", "live", "conc", "lang", "$", "t", "mmss", "span",
    "Date", "RATE_WINDOW", "rateMarks",
    src("rateNow") + src("prog") + "\nreturn { prog: prog, rate: rateNow };")(
    T, 0, opts.running || 0, state.live, opts.conc === undefined ? 25 : opts.conc,
    opts.lang || "en", (id) => (id === "prog" ? el : null),
    (k) => (DICT[k] ? DICT[k][opts.lang || "en"] || DICT[k].en : k),
    mmss, span, { now: () => NOW }, constOf("RATE_WINDOW"), marks);
  return {
    /* answers arriving over time, the way the worker loop reports them */
    work: function (seconds, perSecond) {
      for (let i = 0; i < seconds; i++) {
        NOW += 1000;
        T.done += perSecond;
        made.prog();
      }
      return this;
    },
    line: function () { return el.textContent; },
    rate: function () { return made.rate(); },
    marks: marks
  };
}

/* ---------- the edges, where a rate is a liability ---------- */
check("nothing is claimed in the first seconds",
  !/\/min/.test(run({ total: 100000 }).work(4, 5).line()),
  run({ total: 100000 }).work(4, 5).line());
check("…nor on a handful of answers, however long it has been",
  !/\/min/.test(run({ total: 100000 }).work(40, 0).line()),
  run({ total: 100000 }).work(40, 0).line());
check("…and the count and the clock are there while it waits",
  /20\/100000/.test(run({ total: 100000 }).work(4, 5).line()),
  run({ total: 100000 }).work(4, 5).line());

/* ---------- the arithmetic, once it is worth stating ---------- */
{
  /* five a second is three hundred a minute */
  const r = run({ total: 100000 }).work(30, 5);
  check("five answers a second reads as 300/min", /300\/min/.test(r.line()), r.line());
  /* 99,850 left at 300/min is 332.83 minutes — five and a half hours, said as hours */
  check("…and the time left follows from that rate", /~5:32:50 left/.test(r.line()), r.line());
}
/* "332:50" is arithmetically right and tells nobody anything; below an hour, mm:ss is what a
   short run wants and an hours field would only be a leading zero. */
{
  const r = run({ total: 1000 }).work(30, 5);
  check("under an hour it stays mm:ss", /~02:50 left/.test(r.line()), r.line());
}
check("a slow run says so plainly", /60\/min/.test(run({ total: 100000 }).work(30, 1).line()),
  run({ total: 100000 }).work(30, 1).line());
check("the rate is said in Bengali too",
  /মিনিট/.test(run({ total: 100000, lang: "bn" }).work(30, 5).line()),
  run({ total: 100000, lang: "bn" }).work(30, 5).line());

/* ---------- how fast it IS going, not how fast it has been ----------
   This is the whole point of the window. A run that spent five minutes at 600/min and has since
   been throttled to 60 must say 60: the average still says over 400, and an estimate built on it
   promises a finish that will not happen. */
{
  const r = run({ total: 100000 }).work(300, 10).work(120, 1);
  const avg = Math.round(r.marks.length ? (300 * 10 + 120) / 420 * 60 : 0);
  check("a run that has slowed reports the slow number, not the average",
    /60\/min/.test(r.line()), r.line() + "   (the average would say " + avg + ")");
  check("…and one that has sped up reports the fast one",
    /600\/min/.test(run({ total: 100000 }).work(300, 1).work(120, 10).line()),
    run({ total: 100000 }).work(300, 1).work(120, 10).line());
}
check("the window is a minute, and does not grow without limit",
  run({ total: 100000 }).work(600, 5).marks.length < 700,
  String(run({ total: 100000 }).work(600, 5).marks.length));

/* ---------- a resumed run ----------
   51,000 answers come back from the checkpoint before the clock starts. Counting them against
   this run's seconds said 306,000/min ten seconds in. Only the new work is this run's. */
{
  const r = run({ total: 100000, startDone: 51000 }).work(30, 5);
  check("a resumed run does not count the answers it was handed",
    /300\/min/.test(r.line()), r.line());
  check("…and its estimate is built on the same honest rate", / left/.test(r.line()), r.line());
  /* and the count on screen is still the whole job, which is what it is for */
  check("…while the progress still counts the whole sheet", /51150\/100000/.test(r.line()), r.line());
}

/* ---------- and the line that is quoted afterwards ---------- */
{
  const at = APP.lastIndexOf('"✅ " + t("p_done")');
  const tail = APP.slice(APP.lastIndexOf("const took", at), APP.indexOf(";", APP.indexOf("save_failed", at)));
  check("the finished line carries the rate as well as the clock",
    /t\("p_rate"\)/.test(tail), tail.slice(0, 120));
  check("…over what THIS run did, not what it inherited",
    /const mine = T\.done - done0;/.test(tail) && /mine \/ \(took \/ 1000\)/.test(tail),
    tail.slice(0, 260));
  check("…and over the run's own elapsed time", /mmss\(took\)/.test(tail), tail.slice(0, 200));
}
/* done0 has to be taken inside the run, after a resume has filled T.done */
check("the run marks where its own counting begins",
  /const done0 = T\.done;/.test(APP) && APP.indexOf("const done0 = T.done;") > APP.indexOf("async function startRun"),
  "startRun");
check("…and starts each run with an empty window", /rateMarks = \[\];/.test(APP), "startRun");

/* The rest of the progress line is Latin numerals — the counts, the clock — because it is a line
   of instruments rather than a sentence. A bare toLocaleString() follows the BROWSER's locale, so
   on a Bengali Windows the rate alone would come out in Bengali digits beside a Latin count: one
   line, two numbering systems. The conc note has the opposite convention and states it too. */
check("the rate is in the same numerals as the count beside it",
  (APP.match(/rate\.toLocaleString\("en-US"\)/g) || []).length === 2 &&
  !/rate\.toLocaleString\(\)/.test(APP),
  (APP.match(/rate\.toLocaleString\([^)]*\)/g) || []).join(", "));

check("both new lines are said in both languages",
  /p_rate: \{ bn: "[^"]+", en: "[^"]+" \}/.test(APP) &&
  /p_left: \{ bn: "[^"]+", en: "[^"]+" \}/.test(APP), "DICT");

console.log(fail ? "\n" + fail + " FAILED" : "\nall good");
process.exit(fail ? 1 : 0);
