/* Extension ⇄ CLI parity harness.
 *
 *   node tests/parity.js
 *
 * Loads the CLI's real compare()/classify()/money() and the extension's reconcile.js, runs both on
 * identical fixtures and diffs every error, warning, note and the chosen category.
 *
 * The two are NOT expected to agree everywhere — the extension carries rules the CLI does not (and
 * drops some the CLI has), all listed in EXPECTED_DIFFS below. A case that differs and is NOT in
 * that list is a real drift; a case in the list that suddenly matches means the CLI caught up and
 * the entry should be removed.
 */
"use strict";
const fs = require("fs");
const path = require("path");

const CLI = "C:/Users/Raahat/Desktop/UMS-Payment-Verify/lib/";
const EXT = path.join(__dirname, "..", "reconcile.js");

let cliCompare, cliCategory, cliParse;
try {
  cliCompare = require(CLI + "compare.js");
  cliCategory = require(CLI + "category.js");
  cliParse = require(CLI + "parse.js");
} catch (e) {
  console.log("CLI টুল পাওয়া গেল না (" + CLI + ") — শুধু এক্সটেনশনের নিজের পরীক্ষা চলবে।\n");
}
/* Without the CLI there is nothing to compare against, and the run used to end on
   "0 same · 0 expected-diff · 0 drift" with exit 0 — which reads exactly like a clean parity
   check when in fact not one case was checked. Say SKIPPED instead, and let a strict run
   (UMSREC_STRICT=1, e.g. on a machine that is supposed to have the CLI) fail on it. */
const HAVE_CLI = !!(cliCompare && cliCategory && cliParse);
const STRICT = process.env.UMSREC_STRICT === "1";

const g = {};
new Function("self", fs.readFileSync(EXT, "utf8"))(g);
const U = g.UMSREC;

/* rules the extension has on purpose that the CLI does not, and vice versa */
const EXPECTED_DIFFS = {
  /* the extension has no warning bucket at all — every §3 identity, structural and idle-receipt
     finding is an error there, while the CLI still reports them as warnings */
  "received moved on cancellation": "extension: warnings promoted to errors",
  "chain break": "extension: warnings promoted to errors",
  "previous due gap": "extension: idle-receipt warning",
  "bracket negative + structure": "extension: Branch/Campus dropped",
  "overdiscount": "extension only: overdiscount rule",
  "cashback over program total": "extension only: cashback rule",
  "idle receipt": "extension only: idle-receipt warning",
  "duplicate course in one receipt": "extension only: duprow rule",
  "cancellation money move stays clean": "extension only: course money-movement warning",
  /* PW is one row per receipt, CW one row per course — the two owe each other agreement about
     amounts. An all-blank receipt has no amount, so the extension does not call its absence from
     the other ledger a mismatch; the CLI still does. */
  "all-zero receipt on one side only": "extension: no money, so no mismatch"
};

/* ------------------------------------------------------------------ fixtures */

const pwRow = (o) => Object.assign({
  date: "", mrn: "", crn: "", income: "0", consideration: "0", previousDue: "0", deducted: "0",
  receivable: "0", prevStd: "0", booking: "0", special: "0", received: "0", cashBack: "0", currentDue: "0"
}, o);

const cwRow = (o) => Object.assign({
  date: "", course: "", branch: "", campus: "", roll: "", regNo: "", programSession: "",
  mrn: "", crn: "", income: "0", deducted: "0", consideration: "0", previousDue: "0",
  receivable: "0", prevStd: "0", booking: "0", special: "0", grossReceived: "0",
  dueAdjustment: "0", cashBack: "0", netReceived: "0", currentDue: "0"
}, o);

const side = (rows, extra) =>
  Object.assign({ ok: true, rows, cols: {}, totalRow: null, noData: false }, extra || {});

const CASES = {
  "clean": [
    side([pwRow({ mrn: "1", date: "01/01/2025", income: "5,000", receivable: "5,000", special: "500", received: "4,500" })]),
    side([cwRow({ mrn: "1", date: "01/01/2025", course: "Physics", income: "5,000", receivable: "5,000", special: "500", grossReceived: "4,500", netReceived: "4,500" })])
  ],
  /* real: reg 1517656 — an all-blank Cancellation sits in PW and never reached CW */
  "all-zero receipt on one side only": [
    side([pwRow({ mrn: "1", date: "01/01/2025", income: "5,000", receivable: "5,000", special: "500", received: "4,500" }),
          pwRow({ crn: "9643210963", date: "16/08/2022" })]),
    side([cwRow({ mrn: "1", date: "01/01/2025", course: "Physics", income: "5,000", receivable: "5,000", special: "500", grossReceived: "4,500", netReceived: "4,500" })])
  ],
  "previous due gap": [
    side([pwRow({ mrn: "2", date: "01/01/2025", previousDue: "11,000", receivable: "11,000", currentDue: "11,000" })]),
    side([cwRow({ mrn: "2", date: "01/01/2025", course: "Physics", previousDue: "0", receivable: "11,000", currentDue: "11,000" })])
  ],
  "received moved on cancellation": [
    side([pwRow({ crn: "77", date: "02/01/2025", previousDue: "2,000", receivable: "2,000", consideration: "2,000" })]),
    side([cwRow({ crn: "77", date: "02/01/2025", course: "Biology", previousDue: "2,000", receivable: "2,000", consideration: "2,000", dueAdjustment: "2,000", grossReceived: "2,000", netReceived: "2,000" })])
  ],
  "chain break": [
    side([pwRow({ mrn: "3a", date: "01/01/2025", income: "5,000", receivable: "5,000", received: "2,000", currentDue: "3,000" }),
          pwRow({ mrn: "3b", date: "05/01/2025", previousDue: "3,000", receivable: "3,000", received: "1,000", currentDue: "2,000" })]),
    side([cwRow({ mrn: "3b", date: "05/01/2025", course: "Physics", previousDue: "500", receivable: "3,000", grossReceived: "1,000", netReceived: "1,000", currentDue: "2,000" }),
          cwRow({ mrn: "3a", date: "01/01/2025", course: "Physics", income: "5,000", receivable: "5,000", grossReceived: "2,000", netReceived: "2,000", currentDue: "3,000" })])
  ],
  "cw empty": [
    side([pwRow({ mrn: "4", date: "01/01/2025", income: "5,000", receivable: "5,000", received: "5,000" })]),
    side([], { noData: true })
  ],
  "bracket negative + structure": [
    side([pwRow({ mrn: "5", date: "01/01/2025", income: "5,000", receivable: "5,000", received: "5,000", cashBack: "(4,831)" })]),
    side([cwRow({ mrn: "5", date: "01/01/2025", course: "A", branch: "Dhanmondi", income: "2,500", receivable: "2,500", grossReceived: "2,500", netReceived: "2,500" }),
          cwRow({ mrn: "5", date: "01/01/2025", course: "", branch: "Uttara", income: "2,500", receivable: "2,500", grossReceived: "2,500", netReceived: "2,500" })])
  ],
  "overdiscount": [
    side([pwRow({ mrn: "9", date: "01/01/2022", income: "5,000", receivable: "5,000", special: "8,000" })]),
    side([cwRow({ mrn: "9", date: "01/01/2022", course: "A", income: "5,000", receivable: "5,000", special: "8,000" })])
  ],
  "cashback over program total": [
    side([pwRow({ mrn: "A", date: "15/02/2022", income: "17,000", receivable: "17,000", received: "10,000", currentDue: "6,000" })]),
    side([cwRow({ mrn: "A", date: "15/02/2022", course: "Medical", receivable: "17,000", grossReceived: "10,000", netReceived: "10,000", currentDue: "6,000" }),
          cwRow({ crn: "C1", date: "25/12/2022", course: "Medical", cashBack: "16,000", netReceived: "(16,000)" })])
  ],
  "idle receipt": [
    side([pwRow({ mrn: "48", date: "10/01/2022", previousDue: "6,000", receivable: "6,000", currentDue: "6,000" })]),
    side([cwRow({ mrn: "48", date: "10/01/2022", course: "A", previousDue: "6,000", receivable: "6,000", currentDue: "6,000" })])
  ],
  "cancellation money move stays clean": [
    side([pwRow({ crn: "55", date: "01/01/2022" })]),
    side([cwRow({ crn: "55", date: "01/01/2022", course: "Varsity KA", grossReceived: "2,381" }),
          cwRow({ crn: "55", date: "01/01/2022", course: "UNMESH GK", cashBack: "2,381", netReceived: "(2,381)" })])
  ],
  "duplicate course in one receipt": [
    side([pwRow({ crn: "88", date: "11/02/2023" })]),
    side([cwRow({ crn: "88", date: "11/02/2023", course: "Biology", previousDue: "4,200", receivable: "4,200", dueAdjustment: "4,200" }),
          cwRow({ crn: "88", date: "11/02/2023", course: "Biology", cashBack: "4,556", netReceived: "(4,556)" })])
  ]
};

/* ------------------------------------------------------------------- compare */

/* the extension spells the spec reference out ("— §3.3: Previous Due = …") where the CLI just
   tags it ("(§3.3)"). Same finding, different wording — strip it so it is not read as drift. */
const plain = (s) => String(s == null ? "" : s)
  .replace(/\s*—\s*§[0-9.]+:.*$/, "")
  .replace(/\s*\(§[0-9.]+\)\s*$/, "")
  .trim();

const norm = (r) => JSON.stringify({
  errors: (r.errors || []).map((e) => [e.key, e.field, e.pw, e.cw, e.diff, e.note, e.kind, e.delta, e.cancel]),
  warnings: (r.warnings || []).map((w) => [w.key, w.field, plain(w.detail)]),
  notes: (r.notes || []).map((n) => [n.key, n.detail]),
  stats: r.stats || null, emptyCourseWise: !!r.emptyCourseWise, worthyCount: r.worthyCount
}, null, 1);

let same = 0, expected = 0, drift = 0;

for (const [name, [pw, cw]] of Object.entries(CASES)) {
  const b = U.compare(pw, cw, { tolerance: 0 });
  if (!cliCompare) {
    console.log(`  ·  ${name}   ext err=${b.errors.length}/warn=${b.warnings.length}`);
    continue;
  }
  const a = cliCompare.compare(pw, cw, { tolerance: 0 });
  const agree = norm(a) === norm(b) &&
    JSON.stringify(cliCategory.classify({ errors: a.errors, stats: a.stats })) ===
    JSON.stringify(U.classify({ errors: b.errors, stats: b.stats }));

  if (agree) { same++; console.log(`SAME      ${name}`); continue; }
  if (EXPECTED_DIFFS[name]) {
    expected++;
    console.log(`EXPECTED  ${name}  — ${EXPECTED_DIFFS[name]}   (cli ${a.errors.length}e/${a.warnings.length}w · ext ${b.errors.length}e/${b.warnings.length}w)`);
    continue;
  }
  drift++;
  console.log(`DRIFT     ${name}   (cli ${a.errors.length}e/${a.warnings.length}w · ext ${b.errors.length}e/${b.warnings.length}w)`);
  const A = norm(a).split("\n"), B = norm(b).split("\n");
  for (let i = 0; i < Math.max(A.length, B.length); i++) {
    if (A[i] !== B[i]) console.log(`            cli: ${A[i]}\n            ext: ${B[i]}`);
  }
}

/* money() must parse the awkward values identically */
if (cliParse) {
  ["1,234", "(4,831)", "-", "", "৳ 500", "N/A", "12.50", "--"].forEach((v) => {
    if (cliParse.money(v) !== U.money(v)) {
      drift++;
      console.log(`DRIFT     money(${JSON.stringify(v)})  cli=${cliParse.money(v)}  ext=${U.money(v)}`);
    }
  });
}

if (!HAVE_CLI) {
  console.log(`\nSKIPPED — parity NOT checked (CLI absent at ${CLI})`);
  console.log("এক্সটেনশনের নিজের কেসগুলো উপরে চলেছে, কিন্তু CLI-র সাথে মিলিয়ে দেখা হয়নি।");
  console.log("CLI আছে এমন মেশিনে বাধ্যতামূলক করতে: UMSREC_STRICT=1 node tests/parity.js");
  process.exit(STRICT ? 1 : 0);
}
console.log(`\n${same} same · ${expected} expected-diff · ${drift} drift`);
process.exit(drift ? 1 : 0);
