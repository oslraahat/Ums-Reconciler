/* When a large part of the sheet came back with nothing on it.
 *
 * Two reports, a day apart, the same fault seen from both ends.
 *
 * Mid-run: "351335 unanswered — asking again (round 1) · 10856/351335 · ⏱ 29:33".
 * And afterwards: "Done · 798950/798950 · ⏱ 428:09 · run 2:39:05 · re-asking 4:28:34 ·
 * saving 00:28 · ⚡ 1,866/min · ⚠ 351335 still unanswered" — four and a half hours of re-asking,
 * 63% of the whole run, that began with 351,335 unanswered and ended with 351,335 unanswered.
 *
 * The sweep is for a server that is struggling: a slow one may delay a result, never decide it, so
 * everything it never spoke about goes round again. But a struggling server REFUSES — timeouts,
 * 5xx, 429 — and every refusal is counted into `pressure`. A server answering promptly with a page
 * that has no table on it is not struggling. It is a session that has expired, a permission, or an
 * address: one cause, shared by every row it touches, and unchanged by asking again.
 *
 * The first version of this guard asked for ALL of them and so held its peace at 44%. It is a
 * quarter now. Below that the rounds still run — that is the per-student flakiness they exist for
 * — and the cases that must still sweep are checked here as carefully as the ones that must not.
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
const SHARE = +(/const SWEEP_POINTLESS = ([\d.]+);/.exec(APP) || [])[1];
const MIN = +(/T\.total >= (\d+)/.exec(src("mostlyUnanswered")) || [])[1];

/* the real mostlyUnanswered(), over the real countUnanswered() and a sheet of results */
function verdict(total, unansweredCount, pressure) {
  const students = [];
  for (let i = 0; i < total; i++) {
    students.push({ results: [{ res: { unanswered: i < unansweredCount } }] });
  }
  return new Function("T", "pressure", "students", "SWEEP_POINTLESS",
    src("countUnanswered") + src("mostlyUnanswered") + "\nreturn mostlyUnanswered();")(
    { total: total }, pressure, students, SHARE);
}

check("the share is written down once, and is a share", SHARE > 0 && SHARE < 1, String(SHARE));
check("…and so is the smallest sheet worth judging", MIN >= 20, String(MIN));

/* ---------- the two reported runs ---------- */
check("798,950 students with 351,335 blank: the rounds are not run",
  verdict(798950, 351335, 0) === true, "44%");
check("…and every student blank, all the more so", verdict(400, 400, 0) === true);

/* ---------- either side of the line ---------- */
check("a quarter of the sheet is enough", verdict(400, 100, 0) === true, "100 of 400");
check("…and a hair under it is not", verdict(400, 99, 0) === false, "99 of 400");

/* ---------- the cases the sweep exists for, which must still run ---------- */
check("a tenth of a sheet still sweeps", verdict(400, 40, 0) === false);
check("a single unanswered student still sweeps", verdict(400, 1, 0) === false);
check("nothing unanswered, nothing to decide", verdict(400, 0, 0) === false);

/* ---------- a struggling server is not a refusing one ----------
   This is what the whole thing rests on — not the share, which only says how much is at stake.
   Refusals are counted into pressure, and while any are outstanding a run of blanks says the
   server is busy, which is exactly the case the rounds are for. Only a server answering promptly
   and producing nothing is making a statement about the data. */
check("every student blank WHILE the server is refusing: the rounds still run",
  verdict(798950, 798950, 1) === false, "pressure 1");
check("…however hard it is refusing", verdict(798950, 798950, 20) === false, "pressure 20");

/* ---------- a handful of students is not evidence of anything ---------- */
check("a tiny sheet is left alone", verdict(3, 3, 0) === false, "3 of 3");
check("…right up to the threshold", verdict(MIN - 1, MIN - 1, 0) === false, (MIN - 1) + " students");
check("…and judged from it", verdict(MIN, MIN, 0) === true, MIN + " students");

/* ---------- and where it is said ---------- */
const sweep = src("sweepUnanswered");
check("the sweep declines before its first round",
  /^\s*if \(mostlyUnanswered\(\)\) return;/m.test(sweep), sweep.slice(0, 160));

/* The badge holds a line of status tokens and this is a sentence — 936px of text in 926px of room
   before it was even added. The count goes on the line; the reason goes under it, in the strip
   that already exists for telling someone something is wrong. */
check("the finished line carries the count, not the sentence",
  /\(left \? " · ⚠ " \+ t\("p_unanswered"\)\.replace\("\{n\}", n3\(left\)\) : ""\)/.test(APP), "startRun");
check("…and the reason goes in a strip of its own",
  /const dead = left > 0 && mostlyUnanswered\(\);/.test(APP) &&
  /sn\.textContent = dead \? t\("p_none_answered"\)/.test(APP), "startRun");
check("…which app.html has somewhere to put", /id="srvNote"/.test(
  fs.readFileSync(path.join(__dirname, "..", "app.html"), "utf8")), "app.html");
check("…and which a new run clears before it starts",
  /\{ const sn = \$\("srvNote"\); if \(sn\) \{ sn\.style\.display = "none"; sn\.textContent = ""; \} \}/.test(APP),
  "startRun");
check("the message names what to check, in both languages",
  /p_none_answered: \{ bn: "[^"]*লগইন[^"]*",\s*\n?\s*en: "[^"]*login[^"]*" \}/.test(APP), "DICT");
check("…and how many, and what share of the sheet",
  /p_none_answered: \{ bn: "[^"]*\{n\}[^"]*\{p\}[^"]*"/.test(APP), "DICT");

console.log(fail ? "\n" + fail + " FAILED" : "\nall good");
process.exit(fail ? 1 : 0);
