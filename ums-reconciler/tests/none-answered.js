/* When nothing came back for anyone.
 *
 * Reported, mid-run: "351335 unanswered — asking again (round 1) · 10856/351335 · ⏱ 29:33". Every
 * student in the sheet, unanswered, and the sweep starting on all of them.
 *
 * The sweep is for a server that is struggling — a slow one is allowed to delay a result, never to
 * decide it, so everything it never spoke about goes round again. But a struggling server refuses:
 * timeouts, 5xx, 429, and every one of those is counted into `pressure`. A server answering
 * promptly with a page that has no table on it is not struggling. It is a session that has
 * expired, a permission, or the wrong address — one cause, shared by every row, and unchanged by
 * asking again. Six rounds of four requests each over 351,335 students is upwards of a million
 * requests to prove that, aimed at the server the tool is trying not to overwhelm.
 *
 * The existing guard reaches the same conclusion after three barren rounds. When it is ALL of
 * them, one round of nothing is already the whole story.
 *
 * The risk in the fix is the opposite mistake: giving up on a run that the rounds would have
 * rescued. So the partly-unanswered cases are checked as carefully as the total one.
 *
 *   node tests/none-answered.js
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
  if (APP.slice(at - 6, at) === "async ") at -= 6;
  let d = 0;
  for (let j = APP.indexOf("{", at); j < APP.length; j++) {
    if (APP[j] === "{") d++;
    else if (APP[j] === "}") { d--; if (!d) return APP.slice(at, j + 1); }
  }
  throw new Error("unbalanced " + name);
}

/* the real noneAnswered(), over the real countUnanswered() and a sheet of results */
function verdict(total, unansweredCount, pressure) {
  const students = [];
  for (let i = 0; i < total; i++) {
    students.push({ results: [{ res: { unanswered: i < unansweredCount } }] });
  }
  return new Function("T", "pressure", "students",
    src("countUnanswered") + src("noneAnswered") + "\nreturn noneAnswered();")(
    { total: total }, pressure, students);
}

/* ---------- the reported run ---------- */
check("every student unanswered, servers answering: the rounds are not run",
  verdict(351335, 351335, 0) === true);
check("…and the same at any size worth the name", verdict(40, 40, 0) === true);

/* ---------- the cases the sweep exists for, which must still run ---------- */
check("one student short of all still sweeps", verdict(40, 39, 0) === false,
  "39 of 40");
check("half a sheet still sweeps", verdict(40, 20, 0) === false);
check("a single unanswered student still sweeps", verdict(40, 1, 0) === false);
check("nothing unanswered, nothing to decide", verdict(40, 0, 0) === false);

/* ---------- a struggling server is not a refusing one ---------- */
/* This is the whole distinction. Refusals — timeouts, 5xx, 429 — are counted into pressure, and
   while any are outstanding a run of blanks says the server is busy, which is exactly what the
   rounds are for. Only a server answering promptly and producing nothing is making a statement. */
check("all unanswered WHILE the server is refusing: the rounds still run",
  verdict(351335, 351335, 1) === false, "pressure 1");
check("…however hard it is refusing", verdict(351335, 351335, 20) === false, "pressure 20");

/* ---------- a handful of students is not evidence of anything ---------- */
check("a tiny sheet is left alone", verdict(3, 3, 0) === false, "3 of 3");
check("…and the threshold is stated once", /T\.total >= (\d+)/.test(src("noneAnswered")),
  src("noneAnswered"));

/* ---------- and where it is said ---------- */
const sweep = src("sweepUnanswered");
check("the sweep declines before its first round", /^\s*if \(noneAnswered\(\)\) return;/m.test(sweep),
  sweep.slice(0, 160));
/* the progress line is overwritten by the finished line a moment later, so saying it inside the
   sweep would have been saying it to nobody */
check("…and the finished line is where it is said", /noneAnswered\(\) \? t\("p_none_answered"\)/.test(APP),
  "startRun");
check("…instead of the count, which would read as a tally rather than a cause",
  /: "⚠ " \+ t\("p_unanswered"\)/.test(APP), "startRun");
check("the message names what to check, in both languages",
  /p_none_answered: \{ bn: "[^"]*লগইন[^"]*",\s*\n?\s*en: "[^"]*login[^"]*" \}/.test(APP), "DICT");

console.log(fail ? "\n" + fail + " FAILED" : "\nall good");
process.exit(fail ? 1 : 0);
