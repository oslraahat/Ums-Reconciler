/* Every finding has to say which page to open. "[PW]" / "[CW]" meant nothing to anyone who had
 * not written them, so the tag names the page the way UMS names it — and says it once, not twice
 * ("Course Wise: বাতিলে Cash Back · [CW] …" announced the same ledger in two places).
 *
 *   node tests/ledger-names.js
 */
"use strict";
const fs = require("fs");
const path = require("path");

const g = {};
new Function("self", fs.readFileSync(path.join(__dirname, "..", "reconcile.js"), "utf8"))(g);
const U = g.UMSREC;

const pwRow = (o) => Object.assign({ date: "", mrn: "", crn: "", income: "0", consideration: "0",
  previousDue: "0", deducted: "0", receivable: "0", prevStd: "0", booking: "0", special: "0",
  received: "0", cashBack: "0", currentDue: "0" }, o);
const cwRow = (o) => Object.assign({ date: "", course: "", branch: "", campus: "", roll: "", regNo: "",
  programSession: "", mrn: "", crn: "", income: "0", deducted: "0", consideration: "0", previousDue: "0",
  receivable: "0", prevStd: "0", booking: "0", special: "0", grossReceived: "0", dueAdjustment: "0",
  cashBack: "0", netReceived: "0", currentDue: "0" }, o);
const side = (rows) => ({ ok: true, rows, cols: {}, totalRow: null, noData: false });

let fail = 0;
const check = (name, ok, extra) => { if (!ok) fail++; console.log((ok ? "PASS  " : "FAIL  ") + name + (extra ? "   " + extra : "")); };

/* a spread of faults: one per ledger, one across both, one program-wide */
const r = U.compare(
  side([
    pwRow({ mrn: "M1", date: "01/01/2025", previousDue: "5,000", receivable: "5,000", received: "2,000", currentDue: "2,900" }),
    pwRow({ crn: "C1", date: "10/02/2023" })
  ]),
  side([
    cwRow({ mrn: "M1", date: "01/01/2025", course: "Math", previousDue: "5,000", receivable: "5,000",
      grossReceived: "2,000", netReceived: "2,000", currentDue: "2,900" }),
    cwRow({ crn: "C1", date: "10/02/2023", course: "UNMESH Biology Course 2022",
      consideration: "14,000", previousDue: "8,000", receivable: "8,000", cashBack: "14,000" })
  ]),
  { tolerance: 0 });

const texts = r.errors.map((e) => U.shortError(e));
check("there are findings to inspect", texts.length > 0, texts.length + " findings");

/* ---- no bare abbreviations anywhere a person reads ---- */
const abbrev = texts.filter((t) => /\[(PW|CW|PW↔CW)\]|(^|[\s(])(PW|CW)([\s:.,)]|$)/.test(t));
check("no [PW] / [CW] / bare PW · CW left", abbrev.length === 0, abbrev.join("\n        "));

/* ---- every finding names its page ---- */
const NAMES = ["[Program Wise]", "[Course Wise]", "[Program ↔ Course]", "[দুই পাতার মোট]"];
const unnamed = texts.filter((t) => !NAMES.some((n) => t.indexOf(n) === 0 || t.indexOf(n) > 0));
check("every finding carries a page name", unnamed.length === 0, unnamed.join("\n        "));

/* ---- and names it once ---- */
const twice = texts.filter((t) => {
  const m = t.match(/Program Wise|Course Wise/g) || [];
  /* a PW↔CW comparison legitimately names both sides while quoting the two values */
  return t.indexOf("[Program Wise]") === 0 || t.indexOf("[Course Wise]") === 0
    ? m.length > 1 : false;
});
check("a one-ledger finding does not repeat the ledger", twice.length === 0, twice.join("\n        "));

/* ---- the ledger a finding points at is the right one ---- */
const cwOnly = texts.filter((t) => t.indexOf("[Course Wise]") >= 0);
check("Course Wise findings exist and name the course", cwOnly.length > 0 && /Math|UNMESH/.test(cwOnly.join(" ")),
  cwOnly.slice(0, 2).join("\n        "));
const pwOnly = texts.filter((t) => t.indexOf("[Program Wise]") >= 0);
check("Program Wise findings exist", pwOnly.length > 0, pwOnly.slice(0, 2).join("\n        "));
const both = texts.filter((t) => t.indexOf("[Program ↔ Course]") >= 0);
check("cross-ledger findings say both values with their page names",
  both.some((t) => /Program Wise .* ≠ Course Wise /.test(t)),
  both.slice(0, 2).join("\n        "));

/* ---- the program-wide total gets a name a person can read ---- */
{
  const t = U.compare(
    side([pwRow({ mrn: "M2", date: "10/02/2023", received: "1,000", cashBack: "5,000" })]),
    side([cwRow({ mrn: "M2", date: "10/02/2023", course: "Biology", grossReceived: "1,000",
      cashBack: "5,000", netReceived: "-4,000" })]), { tolerance: 0 })
    .errors.filter((e) => e.kind === "cashback").map((e) => U.shortError(e));
  check("program-wide finding is tagged [দুই পাতার মোট]",
    t.length === 1 && t[0].indexOf("[দুই পাতার মোট]") > 0, t.join(" | ") || "MISSED");
}

/* ---- the source must not reintroduce them ---- */
{
  const src = fs.readFileSync(path.join(__dirname, "..", "reconcile.js"), "utf8");
  /* strip comments — they may still say PW/CW as shorthand for the reader */
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  const bad = (code.match(/"[^"]*\b(PW|CW)\b[^"]*"/g) || [])
    .filter((s) => !/PW_COLS|CW_COLS|"pw"|"cw"/.test(s));
  check("no user-facing string in reconcile.js says PW or CW", bad.length === 0, bad.join("  "));
}

console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
process.exit(fail ? 1 : 0);
