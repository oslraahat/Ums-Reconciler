/* Two faults met in one row: "Reg: 1957189 1536554 — SPID: 1606502 — Course Wise redirect".
 *
 *   1. A Reg cell holding two numbers (a Reg and a Roll pasted into one column) went to UMS
 *      verbatim. Program Wise ignores the reg and answers 200; Course Wise rejects it with a 302.
 *      Verified against the live site: either number alone returns the table, the pair does not.
 *   2. That 302 was filed as a Load Error, so it sat in the retry bucket — and every re-run sent
 *      the same broken reg and failed identically. It is not a load failure at all: Program Wise
 *      loaded, only the Course Wise side is empty, which is its own bucket.
 *
 *   node tests/bad-reg.js
 */
"use strict";
const fs = require("fs");
const path = require("path");

const APP = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

let fail = 0;
const check = (name, ok, extra) => { if (!ok) fail++; console.log((ok ? "PASS  " : "FAIL  ") + name + (extra ? "   " + extra : "")); };

/* ---- 1. the Reg cell is reduced to one number ---- */
{
  /* run the real helper, lifted out of app.js so the test cannot drift from the code */
  const src = APP.match(/const oneReg = function \(s\) \{[\s\S]*?\n    \};/);
  check("oneReg() exists in app.js", !!src);
  if (src) {
    const oneReg = new Function("let trimmed = 0;" + src[0] +
      "return { reg: oneReg, count: function () { return trimmed; } };")();
    check("a normal reg is untouched", oneReg.reg("1957189") === "1957189");
    check("Reg + Roll in one cell keeps the Reg", oneReg.reg("1957189 1536554") === "1957189");
    check("tabs and double spaces too", oneReg.reg("1957189\t1536554") === "1957189" &&
      oneReg.reg("1957189  1536554") === "1957189");
    check("leading/trailing space is not a second number", oneReg.reg("  1536554  ") === "1536554");
    check("only the multi-number rows are counted", oneReg.count() === 3, "counted " + oneReg.count());
  }
  check("app.js counts how many rows were trimmed", /trimmed\+\+/.test(APP) && /imp_trim/.test(APP));
  check("the count is shown in the import note", (APP.match(/imp_trim/g) || []).length >= 3, "en+bn+note");
}

/* ---- 2. a Course Wise redirect is no longer a Load Error ---- */
{
  check("the old early return is gone",
    !/if \(c\.redirected\) return \{ kind: "error"/.test(APP), "app.js");
  // `let`, not `const`, since the Course Wise page is re-fetched while it has not answered
  check("a redirect yields an empty Course Wise instead",
    /cTable = c\.redirected \? null : parseFrag/.test(APP), "app.js");
  check("…and is still flagged as a redirect, not silently 'empty'",
    /cwRedirect: !!c\.redirected/.test(APP), "app.js");
  check("the list says the page never opened",
    /st === "cw" && out\.cwRedirect/.test(APP) && /d_cwredir/.test(APP), "app.js");
  // a third cause joined this line later (see below) — the redirect must still get its own words
  check("the detail line distinguishes it too",
    /out\.cwRedirect \? t\("d_cwredir"\) :/.test(APP), "app.js");
}

/* ---- the status ladder must actually route it to the CW bucket ---- */
{
  /* statusOf(): error → nf/error, then cwEmpty → "cw". With kind:"done" it can no longer be
     "error", and cwEmpty is true because the parsed Course Wise has no rows. */
  const m = APP.match(/function statusOf\([\s\S]*?\n  \}/);
  check("statusOf() reads cwEmpty before counting errors", !!m &&
    m[0].indexOf("cwEmpty") < m[0].indexOf("errors.length"), m ? "ok" : "not found");
  check("a redirect returns kind 'done', so it cannot land in Load Error",
    /return \{ kind: "done", pw: pw, cw: cwData, cwEmpty: cwEmpty, cwRedirect/.test(APP), "app.js");
}

/* ---- the message must not claim the Program Wise side failed ---- */
{
  const m = APP.match(/d_cwredir: \{ bn: "([^"]+)", en: "([^"]+)" \}/);
  check("the wording exists in both languages", !!m);
  if (m) {
    check("it says Course Wise did not open", /Course Wise/.test(m[1]) && /খুলল|খোলে/.test(m[1]), m[1]);
    check("it says Program Wise was fine", /Program Wise/.test(m[1]), m[1]);
    check("the English carries no Bangla", !/[ঀ-৿]/.test(m[2]), m[2]);
  }
}
/* ---- and a third case that used to hide inside the same bucket ----
   "Course Wise ফাঁকা (No Data)" covered three different things: the page never opened, the page
   opened but its table was not in the HTML, and the table was there and genuinely empty. Only the
   last is benign — the middle one read nothing at all, so calling it "empty" claims a fact that
   was never established. Each is named now. */
{
  check("testOne tells 'no table' apart from 'redirected'",
    /const cwNoTable = !c\.redirected && !cTable;/.test(APP), "app.js");
  check("…and hands it to the caller", /cwNoTable: cwNoTable/.test(APP), "app.js");

  const m = APP.match(/d_cwnotable: \{ bn: "([^"]+)", en: "([^"]+)" \}/);
  check("the wording exists in both languages", !!m);
  if (m) {
    check("it says the page did arrive", /পাতা এসেছে/.test(m[1]), m[1]);
    check("…but the table did not", /টেবিল/.test(m[1]), m[1]);
    check("…and that this is not the same as empty", /ফাঁকা নয়/.test(m[1]), m[1]);
    check("the English carries no Bangla", !/[ঀ-৿]/.test(m[2]), m[2]);
  }

  check("the one-line headline uses it", /out\.cwNoTable\) return t\("d_cwnotable"\)/.test(APP), "app.js");
  check("…and so does the exported detail",
    /out\.cwRedirect \? t\("d_cwredir"\) : out\.cwNoTable \? t\("d_cwnotable"\) : t\("d_cwempty"\)/.test(APP), "app.js");
  // the attempt count slots in between now — the findings must still come after it
  check("Program Wise findings survive this branch too",
    /t\("d_cwnotable"\)[^;]*U\.pwFindings\(out\.result\)/.test(APP), "app.js");

  // three causes, three sentences — no two may collapse back into one
  const say = ["d_cwredir", "d_cwempty", "d_cwnotable"].map(function (k) {
    const x = APP.match(new RegExp(k + ': \{ bn: "([^"]+)"'));
    return x ? x[1] : k;
  });
  check("all three read differently", new Set(say).size === 3, say.join(" / "));

  // it stays a CW-empty row: nothing was retried, so it must not move into the Load Error bucket
  check("…without moving the student to another tile",
    /if \(out\.cwEmpty \|\| r\.emptyCourseWise\) return "cw";/.test(APP), "app.js");
}

/* ---- wait for Course Wise to actually answer ----
   The batch runner took the first reply and filed the student under CW ফাঁকা for good, while the
   in-page panel had always waited for the table to appear (content.js captureWhenReady). A slow
   session or a half-built response therefore became a permanent verdict. Now an unanswered Course
   Wise is fetched again — but only an UNANSWERED one: a table that says No Data has been answered,
   and a run holds hundreds of those. */
{
  // cwSettled() lifted from app.js — the whole decision lives in it
  const at = APP.search(/\n  function cwSettled\s*\(/);
  check("cwSettled() exists", at > 0, "app.js");
  let i = APP.indexOf("{", at), depth = 0, end = -1;
  for (let j = i; j < APP.length; j++) {
    if (APP[j] === "{") depth++;
    else if (APP[j] === "}") { depth--; if (!depth) { end = j + 1; break; } }
  }
  const cwSettled = new Function(APP.slice(at, end) + "; return cwSettled;")();
  const page = (o) => Object.assign({ redirected: false }, o);
  const tbl = (o) => Object.assign({ ok: true, rows: [], noData: false }, o);

  check("rows on the page → answered", cwSettled(page(), tbl({ rows: [{}] })) === true);
  check("the table says No Data → answered", cwSettled(page(), tbl({ noData: true })) === true);
  check("a redirect → not an answer", cwSettled(page({ redirected: true }), null) === false);
  check("no table at all → not an answer", cwSettled(page(), null) === false);
  check("a table that would not parse → not an answer", cwSettled(page(), { ok: false }) === false);
  check("empty table, no No Data marker → not an answer", cwSettled(page(), tbl()) === false);
}

{
  check("testOne re-fetches while Course Wise has not answered",
    /while \(cwTries < CW_TRIES && !cwSettled\(c, cw\)\)/.test(APP), "app.js");
  /* The bound is a named constant, not a number written into the loop: it has been raised once
     already (3 → 6) and the guard must protect the behaviour, not the figure. What it may never
     become is 1 — that is "ask once and file whatever came back", which is the bug. */
  check("…and how many times is a named, generous bound",
    /const CW_TRIES = (\d+);/.test(APP) && +/const CW_TRIES = (\d+);/.exec(APP)[1] >= 3,
    (/const CW_TRIES = (\d+);/.exec(APP) || [])[1]);
  check("…starting the count at one", /let cwTries = 1;/.test(APP), "app.js");
  /* Exponential and jittered now, not a flat multiple: at 25 parallel workers a fixed pause brings
     everyone that hit the same hiccup back at the same instant to hit it together again. */
  check("…pausing longer each time", /await backoff\(cwTries - 1\)/.test(APP), "app.js");
  check("…and the pause really does grow, with jitter",
    /Math\.min\(800 \* Math\.pow\(2, attempt\), 20000\)/.test(APP) &&
    /0\.75 \+ Math\.random\(\) \* 0\.5/.test(APP), "app.js");
  check("…honouring Retry-After when the server sends one",
    /backoff\(a, r\.headers\.get\("retry-after"\)\)/.test(APP), "app.js");
  check("…only the Course Wise page, not the whole student",
    /c = await fetchHtml\(cwUrl\(reg, spid\)\)/.test(APP), "app.js");
  check("…and Stop cuts the wait short",
    /catch \(e\) \{ if \(e && e\.name === "AbortError"\) throw e; break; \}/.test(APP), "app.js");
  check("the attempt count reaches the caller", /cwTries: cwTries/.test(APP), "app.js");
  check("…and the line says it waited", /out\.cwTries > 1 \?/.test(APP), "app.js");

  // a settled No Data must never be re-requested — hundreds of them in one run
  const body = APP.slice(APP.indexOf("let cwTries = 1;"), APP.indexOf("const cwEmpty ="));
  check("a genuine No Data is not fetched again", /!cwSettled\(c, cw\)/.test(body), "app.js");
}

/* ---- a slow server may delay the result; it may never decide it ----
   Three quick tries and then "load error" filed the network under the student's name: the row read
   as a finding about the money when nothing had been read at all. Every one of these is a way that
   can come back. */
{
  check("a hung request is cut off and asked again, not waited on forever",
    /setTimeout\(function \(\) \{ timedOut = true; stopIt\(\); \}, reqTimeout\(a\)\)/.test(APP), "app.js");
  /* the timeout aborts THAT request; run.ac stays the Stop button, or Stop and a slow page would
     be indistinguishable and one of them would cancel the wrong thing */
  check("…on its own controller, so Stop still means Stop",
    /if \(run && run\.stop\) \{ const a2 = new Error\("stopped"\); a2\.name = "AbortError"; throw a2; \}/.test(APP) &&
    /if \(e && e\.name === "AbortError" && !timedOut\) throw e;/.test(APP), "app.js");
  /* a server that is slow rather than broken has to be given the time it needs, so the allowance
     grows with each attempt instead of cutting off at the same mark every time */
  check("…allowing longer on each retry", /Math\.min\(45000 \* \(a \+ 1\), 180000\)/.test(APP), "app.js");

  check("refusals make the whole run back off instead of piling on",
    /function netPressure\(bad\)/.test(APP) && /await breathe\(\)/.test(APP), "app.js");

  /* the heart of it: a page that never answered is not an answer, and must not be left standing
     as one — no rows, No Data and "nothing came back" are three different things */
  check("a non-answer is marked as one", /function unanswered\(out\)/.test(APP), "app.js");
  check("…a No Data table is NOT a non-answer",
    !/noData/.test(APP.slice(APP.indexOf("function unanswered(out)"), APP.indexOf("function countUnanswered"))),
    "app.js");
  check("…and the run sweeps them until they answer",
    /await sweepUnanswered\(t0\);/.test(APP) && /const SWEEP_ROUNDS = \d+;/.test(APP), "app.js");
  check("…re-asking more gently than the first pass did",
    /Math\.ceil\(conc \/ 2\)/.test(APP), "app.js");
  /* and it does not stop while the server is the reason. A barren round against a healthy
     server means the answer is not coming; a barren round against a struggling one means
     nothing at all, and stopping there is the "three quick tries" bug in a new hat. */
  check("giving up needs several barren rounds AND a server that is answering fine",
    /barren = fixed \? 0 : barren \+ 1;[\s\S]*?if \(barren >= 3 && !pressure\) return;/.test(APP), "app.js");
  check("…and Stop ends the sweep at once",
    /for \(let round = 1; round <= SWEEP_ROUNDS && run && !run\.stop; round\+\+\)/.test(APP), "app.js");
  /* and then it says so, with the count — "load error" alone sent people to look at the data */
  check("the line says the server never answered, and how often it was asked",
    /res0\.detail \+= " · " \+ t\("d_noanswer"\)\.replace\("\{n\}", res0\.tried\)/.test(APP), "app.js");
  check("…and the attempt count carries across sweep rounds",
    /res0\.tried = \(\(prior && prior\.tried\) \|\| 0\) \+ attempts;/.test(APP), "app.js");
  check("…and the finished run reports what is still outstanding",
    /t\("p_unanswered"\)\.replace\("\{n\}", left\)/.test(APP), "app.js");
  ["p_retry", "p_unanswered", "d_noanswer"].forEach(function (k) {
    const m = APP.match(new RegExp(k + ': \\{ bn: "[^"]*", en: "([^"]*)" \\}'));
    check(k + " has clean English", !!m && !/[ঀ-৿]/.test(m[1]), m ? m[1] : "not found");
  });
}


console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
process.exit(fail ? 1 : 0);
