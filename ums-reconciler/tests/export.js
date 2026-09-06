/* Does the Remarks column survive the trip into the files? The text is Bangla, carries ·  — ↔ ≠
 * and (for a stray course name) characters XML cares about, and it is written by hand into both an
 * .xlsx (a hand-rolled zip + sheet XML) and an .html table. Reading the code is not proof, so this
 * builds a real workbook with the real helpers, unpacks it, and reads the cell back out.
 *
 *   node tests/export.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const APP = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const g = {};
new Function("self", fs.readFileSync(path.join(__dirname, "..", "reconcile.js"), "utf8"))(g);
const U = g.UMSREC;

let fail = 0;
/* the extra text explains a failure — printing it beside PASS reads like a warning */
const check = (name, ok, extra) => { if (!ok) fail++; console.log((ok ? "PASS  " : "FAIL  ") + name + (!ok && extra ? "   " + extra : "")); };

/* Pull the export helpers straight out of app.js so this cannot drift from what ships. Balance
   braces rather than matching an end pattern — these run from one-liners to twenty-line loops. */
function lift(names) {
  const src = names.map(function (n) {
    const at = APP.search(new RegExp("\\n  (?:function " + n + "\\s*\\(|const " + n + "\\s*=)"));
    if (at < 0) throw new Error("could not find " + n + " in app.js");
    let i = APP.indexOf("{", at), depth = 0;
    for (let j = i; j < APP.length; j++) {
      const c = APP[j];
      if (c === "{") depth++;
      else if (c === "}") { depth--; if (!depth) { i = j; break; } }
    }
    /* the closing brace is not always the end of the statement — `const CRC = (function () {…})();`
       still has `)();` to go, and `const f = function () {…};` a semicolon */
    let end = i + 1;
    while (end < APP.length && /[)(;\s]/.test(APP[end]) && APP[end] !== "\n") end++;
    return APP.slice(at, end);
  }).join("\n");
  return new Function(src + "\nreturn {" + names.join(",") + "};")();
}
const X = lift(["xesc", "cl", "CRC", "crc32", "cat", "sheetXml", "zipStore"]);
check("export helpers lifted from app.js", !!X.sheetXml && !!X.zipStore);

/* ---- a realistic Remarks string, straight out of the engine ---- */
const pwRow = (o) => Object.assign({ date: "", mrn: "", crn: "", income: "0", consideration: "0",
  previousDue: "0", deducted: "0", receivable: "0", prevStd: "0", booking: "0", special: "0",
  received: "0", cashBack: "0", currentDue: "0" }, o);
const cwRow = (o) => Object.assign({ date: "", course: "", branch: "", campus: "", roll: "", regNo: "",
  programSession: "", mrn: "", crn: "", income: "0", deducted: "0", consideration: "0", previousDue: "0",
  receivable: "0", prevStd: "0", booking: "0", special: "0", grossReceived: "0", dueAdjustment: "0",
  cashBack: "0", netReceived: "0", currentDue: "0" }, o);
const side = (rows) => ({ ok: true, rows, cols: {}, totalRow: null, noData: false });

/* real: reg 1893997 — a 20,000 refund Course Wise never got, on a course named with an ampersand */
const r = U.compare(
  side([
    pwRow({ mrn: "M1", date: "10/09/2022", income: "23,000", receivable: "23,000", received: "23,000" }),
    pwRow({ crn: "9643224756", date: "07/04/2023", consideration: "20,000", cashBack: "20,000" })
  ]),
  side([cwRow({ mrn: "M1", date: "10/09/2022", course: "Medical & Dental <Full>", income: "23,000",
    receivable: "23,000", grossReceived: "23,000", netReceived: "23,000" })]),
  { tolerance: 0 });

/* itemDetail() is what the export stores; rebuild it the way app.js does */
const cat = U.classify(r);
const remarks = [cat.label + (cat.why && !cat.selfEvident ? " (" + cat.why + ")" : "")]
  .concat(r.errors.map(function (e) { return "✕ " + U.shortError(e); })).join(" · ");

check("the remark is not empty", remarks.length > 30, remarks);
check("it names the receipt", /9643224756/.test(remarks), remarks);
check("it carries the amount into the export too", /20,000/.test(remarks), remarks);

/* ---- .xlsx: build it, unzip it, read the cell back ---- */
const header = ["Status", "Student Reg", "Program Id", "Payment History Link", "Remarks"];
const link = "https://ums-5.osl.team/Student/Payment/HistoryOfPayment?studentProgramId=1&a=b&c=d";
const NASTY = 'Medical & Dental <Full> "2022" — ৳5,000';   // every character XML argues about
const mat = [["Mismatch", "1893997", "1992462", link, remarks], ["Mismatch", "1", "2", "", NASTY]];
const sheet = X.sheetXml(header, mat, ["r", "r"]);

check("sheet XML declares UTF-8", /encoding="UTF-8"/.test(sheet));
check("cells are inline strings, so no sharedStrings table is needed", /t="inlineStr"/.test(sheet));
check("& in the link is escaped", sheet.indexOf("a=b&amp;c=d") > 0 && !/a=b&c=d/.test(sheet), "link cell");
check("< > in a course name are escaped", /&lt;Full&gt;/.test(sheet) && sheet.indexOf("<Full>") < 0);
check("no raw & survives anywhere", !/&(?!amp;|lt;|gt;)/.test(sheet));
check("xml:space is preserved, so leading/trailing spaces are not eaten", /xml:space="preserve"/.test(sheet));
/* header + 2 data rows across 5 columns, so Status stays filterable in Excel */
check("the row is filterable in Excel", /<autoFilter ref="A1:E3"\/>/.test(sheet), (sheet.match(/autoFilter[^/]*/) || [])[0]);

/* the zip the browser would download */
const enc = new TextEncoder();
const bytes = X.zipStore([{ name: "xl/worksheets/sheet1.xml", data: enc.encode(sheet) }]);
const buf = Buffer.from(bytes);

check("it is a zip", buf.slice(0, 4).toString("hex") === "504b0304", buf.slice(0, 4).toString("hex"));
{
  /* local header: 30 bytes + name + extra, stored (method 0) so the bytes are the file itself */
  const method = buf.readUInt16LE(8);
  const csize = buf.readUInt32LE(18), usize = buf.readUInt32LE(22);
  const nlen = buf.readUInt16LE(26), elen = buf.readUInt16LE(28);
  const start = 30 + nlen + elen;
  const raw = buf.slice(start, start + csize);
  check("stored, not deflated", method === 0, "method=" + method);
  check("declared size matches the payload", csize === usize && usize === enc.encode(sheet).length,
    csize + " / " + usize);

  const back = raw.toString("utf8");
  check("the Bangla remark survives the round trip", back.indexOf(remarks.replace(/&/g, "&amp;")
    .replace(/</g, "&lt;").replace(/>/g, "&gt;")) > 0, "not found in sheet");
  check("Bangla is real UTF-8, not mojibake", /রসিদ/.test(back) && !/à¦/.test(back));
  check("the CRC is right", (function () {
    const crc = buf.readUInt32LE(14);
    return crc === X.crc32(enc.encode(sheet));
  })(), "crc mismatch — Excel would call the file corrupt");
  void zlib;
}

/* ---- .html: the same remark, escaped ---- */
{
  const cellHtml2 = X.xesc(NASTY);
  check("HTML export escapes < > and &", /&lt;Full&gt;/.test(cellHtml2) && /Medical &amp; Dental/.test(cellHtml2), cellHtml2);
  const cellHtml = '<td class="dt">' + X.xesc(remarks) + "</td>";
  check("HTML export keeps the Bangla", /রসিদ/.test(cellHtml));
  const m = APP.match(/<th>Status<\/th>[\s\S]{0,200}?<\/tr>/);
  check("the HTML table has a Remarks column", !!m && /Remarks/.test(m[0]), m ? m[0] : "header not found");
  check("HTML rows use xesc for the remark", /xesc\(r\.remarks \|\| ""\)/.test(APP));
}

/* ---- Remarks must be the very line the tool shows on screen ---- */
check("Remarks is the on-screen line, not the internal listing",
  /remarks: x\.res\.detail \|\| ""/.test(APP) && !/remarks: x\.res\.detailFull/.test(APP), "app.js");
check("the listing moves to its own Details column", /details: x\.res\.detailFull/.test(APP), "app.js");
check("xlsx sends both columns",
  /\[r\.status, r\.reg, r\.spid, r\.link, r\.remarks, r\.details\]/.test(APP));
check("the HTML table has both columns", /<th>Remarks<\/th><th>Details<\/th>/.test(APP), "app.js");

/* ---- and the sheet has to be readable once opened ---- */
check("columns are widened, so Remarks is not a sliver", /customWidth="1"/.test(APP), "app.js");
check("long text wraps instead of being cut off", /wrapText="1"/.test(APP), "app.js");
check("findings are numbered, not run together with ✕",
  /\(i \+ 1\) \+ "\) "/.test(APP) && !/"✕ " \+ U\.shortError/.test(APP), "app.js");

check("the broken dead CSV export is gone", !/function exportCsv/.test(APP) && !/r\.detail\b/.test(APP));

/* ---- ⬇ কাঁচা সারি ----
   The HTML and Excel reports say what the tool CONCLUDED. When a conclusion is disputed — and three
   of them turned out to be the tool's own bugs — the argument only moves on what it READ, and
   fetching that back out of UMS by hand, page by page and student by student, was the slow part of
   every round. One file, every flagged receipt, both pages, verbatim. */
{
  const src = APP.match(/  function exportRaw\(\) \{[\s\S]*?\n  \}/);
  check("exportRaw() exists", !!src, "app.js");
  let out = null;
  const rows = [
    { status: "Mismatch", reg: "2365277", spid: "2394829", program: "", remarks: "Cash Back মিলছে না",
      raw: "## Program Wise — 2 rows\ndate\tmrn\n27/03/2023\t3121353558\n\n## Course Wise — 4 rows\ndate\tcourse\n15/10/2023\tEngineering\n" },
    { status: "CW empty", reg: "2035886", spid: "1968849", program: "Eng", remarks: "Course Wise ফাঁকা",
      raw: "## Program Wise — 1 rows\ndate\n01/01/2024\n" },
    { status: "Matched", reg: "999", spid: "1", program: "", remarks: "সব মিলেছে", raw: "" }
  ];
  new Function("flatRows", "dl", "Blob", "baseUrl", "ver", "Date", src[0] + "; return exportRaw;")(
    () => rows, (b) => { out = b; }, function (parts) { this.text = parts.join(""); },
    "https://ums-5.osl.team", () => "v13.5.0", Date)();
  const txt = out.text;

  check("the file names the version and the count", /v13\.5\.0/.test(txt) && /2 flagged/.test(txt), txt.split("\n")[0]);
  /* a clean student has nothing to argue about and would bury the ones that do — 10,160 of them in
     one run, so this is the difference between a usable file and an unopenable one */
  check("clean students are left out", !/reg 999/.test(txt) && !/সব মিলেছে/.test(txt));
  check("each flagged student is named", /reg 2365277 · spid 2394829/.test(txt) && /reg 2035886 · spid 1968849/.test(txt));
  check("…with the verdict beside it, so the file reads on its own", /Cash Back মিলছে না/.test(txt));
  check("…and the program where there is one", /spid 1968849 · Eng/.test(txt));
  check("both pages come through", /## Program Wise/.test(txt) && /## Course Wise/.test(txt));
  check("the cells stay tab-separated", /27\/03\/2023\t3121353558/.test(txt));
  // without a divider two students' tables run together and the second looks like more rows of the first
  check("students are divided", (txt.match(/^={70,}$/gm) || []).length === 2,
    (txt.match(/^={70,}$/gm) || []).length + " rules");

  check("nothing flagged → no empty file", (function () {
    let hit = null;
    new Function("flatRows", "dl", "Blob", "baseUrl", "ver", "Date", src[0] + "; return exportRaw;")(
      () => [rows[2]], (b) => { hit = b; }, function () {}, "u", () => "v", Date)();
    return hit === null;
  })());
}

/* the wiring: the button, the filter it honours, and when it becomes usable */
{
  const HTML = fs.readFileSync(path.join(__dirname, "..", "app.html"), "utf8");
  check("the page carries the button", /id="raw"/.test(HTML), "app.html");
  check("it is wired up", /\$\("raw"\)\.addEventListener\("click", exportRaw\)/.test(APP), "app.js");
  check("…disabled until something has run", /\$\("raw"\)\.disabled = true;/.test(APP), "app.js");
  check("…and enabled once it has", /\$\("raw"\)\.disabled = false;/.test(APP), "app.js");
  /* flatRows() already drops anything the filter hides, so "Only Mismatch" exports only those —
     the same rule the HTML and Excel reports follow */
  check("it exports through flatRows(), so the filter applies",
    /const rows = flatRows\(\)\.filter\(function \(r\) \{ return r\.raw; \}\)/.test(APP), "app.js");
  check("raw cells are kept only for what needs a person",
    /const raw = \(notOk\(st\) && out\.kind === "done"\)/.test(APP), "app.js");
  check("…and they travel with the row", /raw: x\.res\.raw \|\| ""/.test(APP), "app.js");
}

console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
process.exit(fail ? 1 : 0);
