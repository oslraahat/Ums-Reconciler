/* Smoke test — parse a real-shaped HTML table through the extension's own parseTable(),
 * then compare + render. Catches the kind of breakage a refactor causes: a renamed field,
 * a dropped helper, a report that throws.
 *
 *   node tests/smoke.js
 */
"use strict";
const fs = require("fs");
const path = require("path");

const g = {};
new Function("self", fs.readFileSync(path.join(__dirname, "..", "reconcile.js"), "utf8"))(g);
const U = g.UMSREC;

/* ---- the smallest DOM parseTable() actually touches ---- */
function td(text, colspan) {
  return {
    textContent: text,
    getAttribute: (a) => (a === "colspan" && colspan ? String(colspan) : null)
  };
}
function tr(cells) { return { querySelectorAll: () => cells }; }
function table(rows) {
  return {
    querySelectorAll: (sel) => (sel === "tr" ? rows : []),
    querySelector: () => null
  };
}

const PW_HEAD = ["SL", "Date", "MRN", "CRN", "Income", "Consideration Amount", "Previous Due",
  "Deducted Amount", "Receivable", "Prev. Std. Discount", "Booking Discount", "Special Discount",
  "Received", "Cash Back", "Current Due"];
const CW_HEAD = ["Registration No.", "Date", "Course", "Branch", "MRN", "CRN", "Income",
  "Deducted Amount", "Consideration Amount", "Previous Due", "Receivable", "Pre. Std. Discount",
  "Booking Discount", "Special Discount", "Gross Received", "Due Adjustment Amount",
  "Cash Back Amount", "Net Received", "Current Due"];

const pwTable = table([
  tr(PW_HEAD.map((h) => td(h))),
  tr(["1", "01/01/2025", "111", "-", "17,000", "-", "-", "-", "17,000", "-", "-", "-", "10,000", "-", "7,000"].map((v) => td(v))),
  tr(["2", "05/01/2025", "222", "-", "-", "-", "7,000", "-", "7,000", "-", "-", "-", "7,000", "-", "-"].map((v) => td(v))),
  tr([td("Total Summary", 4), td("17,000"), td("-"), td("-"), td("-"), td("17,000"),
      td("-"), td("-"), td("-"), td("17,000"), td("-"), td("-")])
]);

const cwTable = table([
  tr(CW_HEAD.map((h) => td(h))),
  tr(["2070163", "05/01/2025", "Physics", "Dhaka", "222", "-", "-", "-", "-", "7,000", "7,000",
      "-", "-", "-", "7,000", "-", "-", "7,000", "-"].map((v) => td(v))),
  tr(["2070163", "01/01/2025", "Physics", "Dhaka", "111", "-", "17,000", "-", "-", "-", "17,000",
      "-", "-", "-", "10,000", "-", "-", "10,000", "7,000"].map((v) => td(v)))
]);

let fail = 0;
const check = (name, ok, extra) => {
  if (!ok) fail++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (extra ? "   " + extra : ""));
};

/* ---- parse ---- */
const pw = U.parseTable(pwTable, "pw");
const cw = U.parseTable(cwTable, "cw");

check("PW parsed", pw.ok && pw.rows.length === 2, "rows=" + pw.rows.length);
check("CW parsed", cw.ok && cw.rows.length === 2, "rows=" + cw.rows.length);
check("colspan'd Total Summary row separated", !!pw.totalRow && pw.rows.length === 2);
check("PW columns mapped", pw.cols.mrn != null && pw.cols.received != null && pw.cols.currentDue != null);
check("CW Gross Received → grossReceived", cw.cols.grossReceived != null);
check("money('(4,831)') = -4831", U.money("(4,831)") === -4831);
check("money('৳ 500') = 500", U.money("৳ 500") === 500);

/* ---- compare ---- */
const r = U.compare(pw, cw, { tolerance: 0 });
check("clean data → no errors", r.errors.length === 0, "errors=" + r.errors.length + " warnings=" + r.warnings.length);
check("groups built per receipt", r.groups.length === 2, "groups=" + r.groups.length);
check("summary reads clean", /মিলেছে/.test(U.summary(r)), U.summary(r));

/* ---- a real fault must surface ---- */
const broken = JSON.parse(JSON.stringify(cw));
broken.rows[1].currentDue = "6,000";          // 7,000 → 6,000
const r2 = U.compare(pw, broken, { tolerance: 0 });
check("broken Current Due caught", r2.errors.length > 0, "errors=" + r2.errors.length);
check("category assigned", !!U.classify(r2), (U.classify(r2) || {}).code);
/* the tag names the UMS page in full — tests/ledger-names.js guards the wording itself */
check("shortError has ledger + receipt + rule",
  /\[(Program Wise|Course Wise|Program ↔ Course|দুই পাতার মোট)\]/.test(U.shortError(r2.errors[0])) &&
  /\{/.test(U.shortError(r2.errors[0])),
  U.shortError(r2.errors[0]));

/* ---- render must not throw and must mention the receipt ---- */
let html = "";
try { html = U.renderReport(r2, pw, broken); } catch (e) { html = "THREW: " + e.message; }
check("renderReport works", html.indexOf("THREW") < 0 && html.indexOf("MRN 111") >= 0,
  html.indexOf("THREW") < 0 ? html.length + " chars" : html);

console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
process.exit(fail ? 1 : 0);
