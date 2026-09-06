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
    /while \(cwTries < 3 && !cwSettled\(c, cw\)\)/.test(APP), "app.js");
  check("…up to three times in all", /let cwTries = 1;/.test(APP), "app.js");
  check("…pausing longer each time", /await sleep\(600 \* cwTries\)/.test(APP), "app.js");
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


console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
process.exit(fail ? 1 : 0);
