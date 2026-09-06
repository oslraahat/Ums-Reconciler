/* Every category carries a plain-words explanation of what its headline means. It was written
 * from the start and rendered in the Single Reconcile report — but the Batch list and the
 * Excel/CSV export both dropped it, so on screen a student read only
 *
 *     রসিদটা এক পাতায় নেই — মূল: [Program ↔ Course] CRN … — শুধু Program Wise-এ আছে
 *
 * with nothing saying what that means or what to do. This checks the text exists, reads as
 * sentences rather than jargon, and is actually carried to every place a person looks.
 *
 *   node tests/why-shown.js
 */
"use strict";
const fs = require("fs");
const path = require("path");

const g = {};
new Function("self", fs.readFileSync(path.join(__dirname, "..", "reconcile.js"), "utf8"))(g);
const U = g.UMSREC;

const APP = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const HTML = fs.readFileSync(path.join(__dirname, "..", "app.html"), "utf8");
const REC = fs.readFileSync(path.join(__dirname, "..", "reconcile.js"), "utf8");

let fail = 0;
const check = (name, ok, extra) => { if (!ok) fail++; console.log((ok ? "PASS  " : "FAIL  ") + name + (extra ? "   " + extra : "")); };

const pwRow = (o) => Object.assign({ date: "", mrn: "", crn: "", income: "0", consideration: "0",
  previousDue: "0", deducted: "0", receivable: "0", prevStd: "0", booking: "0", special: "0",
  received: "0", cashBack: "0", currentDue: "0" }, o);
const cwRow = (o) => Object.assign({ date: "", course: "", branch: "", campus: "", roll: "", regNo: "",
  programSession: "", mrn: "", crn: "", income: "0", deducted: "0", consideration: "0", previousDue: "0",
  receivable: "0", prevStd: "0", booking: "0", special: "0", grossReceived: "0", dueAdjustment: "0",
  cashBack: "0", netReceived: "0", currentDue: "0" }, o);
const side = (rows) => ({ ok: true, rows, cols: {}, totalRow: null, noData: false });

/* real: reg 2031382 — a cancellation Program Wise has and Course Wise never got */
const r = U.compare(
  side([
    pwRow({ mrn: "M1", date: "01/01/2022", income: "10,000", receivable: "10,000", received: "10,000" }),
    pwRow({ crn: "9643211024", date: "21/08/2022", consideration: "8,166", cashBack: "8,166" })
  ]),
  side([cwRow({ mrn: "M1", date: "01/01/2022", course: "Engineering Full Course", income: "10,000",
    receivable: "10,000", grossReceived: "10,000", netReceived: "10,000" })]),
  { tolerance: 0 });
const cat = U.classify(r);

check("the student is classified", !!cat, cat ? cat.code : "null");
check("category is 'missing', not the old catch-all 'ledger'", cat.code === "missing", cat.code);
check("headline says which page in words", /Program Wise|Course Wise|পাতা/.test(cat.label), cat.label);
check("an explanation exists", !!cat.why && cat.why.length > 20, cat.why);
check("the explanation names both pages", /Program Wise/.test(cat.why) && /Course Wise/.test(cat.why), cat.why);

/* ---- no category may be left without one, and none may hide behind jargon ---- */
{
  const codes = ["missing", "ledger", "overdiscount", "cashback", "duprow", "struct", "idle",
    "order", "lost", "cancel", "chain", "moved", "rounding", "other"];
  const bad = [], jargon = [];
  codes.forEach((code) => {
    /* pull the label/why straight out of the source table so every code is covered */
    const m = REC.match(new RegExp('code: "' + code + '", label: "([^"]+)"[\\s\\S]{0,200}?why: "([^"]+)"'));
    if (!m) { bad.push(code + ": not found"); return; }
    if (!m[2] || m[2].length < 15) bad.push(code + ": no explanation");
    if (/\bledger\b|\bPW\b|\bCW\b/.test(m[1] + " " + m[2])) jargon.push(code);
  });
  check("every category has an explanation", bad.length === 0, bad.join(" | "));
  check("no category text says 'ledger' / PW / CW", jargon.length === 0, jargon.join(", "));
}

/* ---- and it reaches every place a person reads ---- */
check("Single Reconcile report prints it", /esc\(cat\.why\)/.test(REC));
check("Batch list carries it through processItem", /why: cat \? cat\.why/.test(APP));
check("Batch list renders it", /pwhy/.test(APP) && /pwhy/.test(HTML), "app.js+app.html");
check("Excel / CSV remarks include it", /cat\.label \+ \(cat\.why/.test(APP));

/* ---- the headline itself stays short enough to read at a glance ---- */
const line = U.summary(r);
check("headline is one readable line", line.length < 160, line.length + " chars: " + line);
check("headline does not repeat the explanation", line.indexOf(cat.why) < 0, line);

console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
process.exit(fail ? 1 : 0);
