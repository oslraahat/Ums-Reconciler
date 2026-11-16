/* Function Check — the button test must never click a destructive button, not even on osl.team.
 *
 * The submit hold-back does not stop an AJAX save and confirm() is stubbed to answer OK, so a click
 * on a list's Delete really deleted a row on the shared test server. fnActionProbe runs inside the
 * page and cannot be required here, so its two patterns are read straight out of background.js —
 * the test checks the very regexes that ship.
 *
 *   node tests/fn-destructive.js
 */
"use strict";
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8");
const grab = (name) => {
  const m = new RegExp("var " + name + " = (/.+/[a-z]*);").exec(src);
  if (!m) throw new Error(name + " not found in background.js");
  return new Function("return " + m[1])();
};
const DESTRUCTIVE = grab("DESTRUCTIVE");
const DESTRUCTIVE_CODE = grab("DESTRUCTIVE_CODE");

let fail = 0;
const check = (name, ok) => { if (!ok) fail++; console.log((ok ? "PASS  " : "FAIL  ") + name); };

// button text that must be skipped
["Delete", "Remove", "Void Receipt", "Cancel Course", "Transfer", "Migrate", "Pay", "Pay Now",
 "Refund", "Settle", "Reset", "Reject", "Block", "মুছে ফেলুন", "বাতিল"].forEach((l) =>
  check("skip label: " + l, DESTRUCTIVE.test(l)));

// button text that must still be clicked
["View", "Search", "Show Report", "Load", "Filter", "Save", "Submit", "Calculate", "Check Now",
 "Display", "Preview", "Next", "Payment", "Udvash Payment Account", "View Due List"].forEach((l) =>
  check("click label: " + l, !DESTRUCTIVE.test(l)));

// an icon-only row button: the words are only in its id / handler
check("skip id: btnDeleteStudent", DESTRUCTIVE_CODE.test("btnDeleteStudent"));
check("skip onclick: cancelPayment(42)", DESTRUCTIVE_CODE.test("cancelPayment(42)"));
check("skip onclick: StudentMigration()", DESTRUCTIVE_CODE.test("StudentMigration()"));
check("click id: btnSearch", !DESTRUCTIVE_CODE.test("btnSearch"));
check("click id: viewReport", !DESTRUCTIVE_CODE.test("viewReport"));

// the skip has to sit BEFORE the click in the loop, or it guards nothing
const skipAt = src.indexOf("skipped — destructive");
const clickAt = src.indexOf("try { b.click(); }");
check("skip comes before b.click()", skipAt > 0 && clickAt > 0 && skipAt < clickAt);
// judged on the button's own words, not on the section heading appended for context
check("matched on ownLabel, not the context label", /DESTRUCTIVE\.test\(ownLabel\)/.test(src));

/* ---- a rebuilt panel is not a page full of new buttons ----
   Net Collection Summary Report's View reloads its panel, building the same four buttons again as new
   elements. Tracking "tested" by element re-clicked them 4× (16 clicks) and a hidden Headless tab ran
   past the 55s probe cap. Tracking is by signature now; pin that the element-identity check is gone. */
check("tested buttons are tracked by signature", /testedSig\[sig\]/.test(src));
check("no element-identity 'tested' list left", !/tested\.indexOf\(el\)/.test(src));

/* ---- ums-41 Payment reports: widgets, placeholders, labels ----
   Course Wise / Program Wise Due List failed every multiselect option ("Male", "Bangla"…) for not
   loading a table: the panel heading "...List" was appended to each label and read as a View word, the
   options used up the 16-click cap, and "Select Program" (value 0) was taken as already chosen. */
const PLACEHOLDER = grab("PLACEHOLDER");
check("placeholder: Select Program", PLACEHOLDER.test("Select Program"));
check("placeholder: -- Select Session --", PLACEHOLDER.test("-- Select Session --"));
check("not placeholder: All Branch", !PLACEHOLDER.test("All Branch"));
check("not placeholder: UDVASH", !PLACEHOLDER.test("UDVASH"));
const W = /var WIDGET = "([^"]+)"/.exec(src);
check("multiselect toggles and options are widgets", !!W && /\.multiselect\b/.test(W[1]) && /\.multiselect-container/.test(W[1]));
check("dual-listbox arrows are widgets", !!W && /bootstrap-duallistbox-container \.buttons/.test(W[1]));
check("View is judged by the button's own words", /var isView = VIEW\.test\(ownLabel\)/.test(src));
check("a held-back form submit counts as the button working", /__fnSubmitTried/.test(src) && /ফর্ম submit হলো/.test(src));

console.log(fail ? "\n" + fail + " টি ভুল" : "\nসব ঠিক আছে");
process.exit(fail ? 1 : 0);
