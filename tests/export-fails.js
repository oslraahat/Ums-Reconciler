/* An export that cannot be built has to say so.
 *
 * Two things can stop a report being written, and both arrive at the end of a run that took hours.
 * A sheet with more rows than Excel opens is refused deliberately — Excel does not report such a
 * workbook, it "repairs" it, which means opens it empty, so the tool refuses first and says why.
 * And any builder can meet the ceiling a JavaScript string has, about 512 MB, which is what the
 * streamed worksheet exists to avoid and the HTML report still reaches past a million students.
 *
 * None of it was caught. The click handler rejected, the browser logged it where nobody looks, and
 * the button did nothing when pressed. Silence is the one answer that cannot be acted on.
 *
 *   node tests/export-fails.js
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
  const star = APP.indexOf("function* " + name + "(");
  if (star >= 0 && (at < 0 || star < at)) at = star;
  if (at < 0) throw new Error("no such function: " + name);
  if (APP.slice(at - 6, at) === "async ") at -= 6;
  let d = 0;
  for (let j = APP.indexOf("{", at); j < APP.length; j++) {
    if (APP[j] === "{") d++;
    else if (APP[j] === "}") { d--; if (!d) return APP.slice(at, j + 1); }
  }
  throw new Error("unbalanced " + name);
}
const line = (re) => { const m = re.exec(APP); if (!m) throw new Error("not found: " + re); return m[0]; };

/* ---------- the workbook refuses a sheet Excel cannot open ---------- */
{
  const W = new Function("srvMode", "t", "zipPack", "sheetChunks", "ctXml", "wbXml", "wbrXml",
    "RELS", "STY", "TextEncoder",
    line(/const XLSX_MAX_ROWS = .*\n/) + src("xlsxTab") + src("buildBook") +
    "\nreturn { buildBook: buildBook, xlsxTab: xlsxTab, XLSX_MAX_ROWS: XLSX_MAX_ROWS };")(
    false,
    (k) => (k === "xlsx_toobig" ? "too many rows: {n} of {m}" : k),
    async () => new Uint8Array(0), () => [], () => "", () => "", () => "", "", "", TextEncoder);

  const rows = function (n) {
    const out = new Array(n);
    for (let i = 0; i < n; i++) out[i] = { status: "Matched", reg: "1", spid: "2", program: "",
      link: "", link2: "", remarks: "", details: "", result: "ok", color: "g" };
    return out;
  };

  /* one row under the ceiling (the header takes one) is written; one over is refused */
  const small = W.buildBook([W.xlsxTab("t", rows(W.XLSX_MAX_ROWS - 1))]).then(
    function () { return "written"; }, function (e) { return "refused: " + e.message; });
  const big = W.buildBook([W.xlsxTab("t", rows(W.XLSX_MAX_ROWS))]).then(
    function () { return "(written — nothing refused it)"; }, function (e) { return e.message; });

  Promise.all([small, big]).then(function (r) {
    check("a workbook that fits is written", r[0] === "written", r[0]);
    check("a sheet with more rows than Excel opens is refused", /too many rows/.test(r[1]), r[1]);
    check("…and the message says both numbers", /1,048,577.*1,048,576/.test(r[1]), r[1]);
    stage2();
  });
}

/* ---------- and every button says so rather than doing nothing ---------- */
function stage2() {
  ["exportHtml", "exportRaw", "exportXlsx"].forEach(function (n) {
    const f = src(n);
    check(n + " catches a builder that throws",
      /catch \(e\) \{ exportFailed\(e\); \}/.test(f), f.replace(/\s+/g, " ").slice(0, 90));
  });

  /* it has to be visible, and it must not eat the line the run left behind */
  const ef = src("exportFailed");
  check("the message goes where the run reports", /\$\("prog"\)/.test(ef), "exportFailed");
  check("…carrying what actually went wrong", /e && e\.message/.test(ef), "exportFailed");
  check("…and falls back to a sentence when there is no message",
    /t\("dl_failed"\)/.test(ef) && /dl_failed: \{ bn: "[^"]+", en: "[^"]+" \}/.test(APP), "dl_failed");
  /* a run that has just finished says "✅ Done · saved" — losing that to a transient warning
     would trade one silence for another */
  check("…and puts the run's own line back afterwards",
    /progWas\b/.test(ef) && /setTimeout/.test(ef), "exportFailed");
  check("…rather than stacking up if it fails twice",
    /if \(progWas === null\)/.test(ef) && /clearTimeout\(progTimer\)/.test(ef), "exportFailed");

  console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
  process.exit(fail ? 1 : 0);
}
