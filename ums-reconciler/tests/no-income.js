/* Some students have rows with no Income at all — the money was raised earlier and is only being
 * carried forward or collected against. Those rows are still fully checkable, and their arithmetic
 * must still tie; what they must NOT do is get flagged merely for having no Income.
 *
 * The idle-receipt rule used to do exactly that: Receivable = Current Due with nothing collected
 * reads as "a receipt that records nothing", but with a Previous Due behind it that is an ordinary
 * carry-forward. It is only a fault when the Receivable came from nowhere.
 *
 *   node tests/no-income.js
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
const idle = (r) => r.errors.filter((e) => e.kind === "idle");
const lines = (r) => r.errors.map((e) => U.shortError(e)).join("\n        ");

/* ---- 1. no Income, money collected against an old due — arithmetic ties ---- */
{
  const r = U.compare(
    side([pwRow({ mrn: "1", date: "01/01/2025", previousDue: "5,000", receivable: "5,000", received: "2,000", currentDue: "3,000" })]),
    side([cwRow({ mrn: "1", date: "01/01/2025", course: "A", previousDue: "5,000", receivable: "5,000",
      grossReceived: "2,000", netReceived: "2,000", currentDue: "3,000" })]),
    { tolerance: 0 });
  check("no Income, collection ties → clean", r.errors.length === 0, lines(r));
}

/* ---- 2. no Income, nothing collected — a due simply carried forward ---- */
{
  const r = U.compare(
    side([pwRow({ mrn: "2", date: "01/01/2025", previousDue: "5,000", receivable: "5,000", currentDue: "5,000" })]),
    side([cwRow({ mrn: "2", date: "01/01/2025", course: "A", previousDue: "5,000", receivable: "5,000", currentDue: "5,000" })]),
    { tolerance: 0 });
  check("no Income, pure carry-forward → clean", r.errors.length === 0, lines(r));
  check("carry-forward is not called an idle receipt", idle(r).length === 0);
}

/* ---- 3. no Income and the arithmetic is wrong — must still be caught ---- */
{
  const r = U.compare(
    side([pwRow({ mrn: "3", date: "01/01/2025", previousDue: "5,000", receivable: "5,000", received: "2,000", currentDue: "2,900" })]),
    side([cwRow({ mrn: "3", date: "01/01/2025", course: "A", previousDue: "5,000", receivable: "5,000",
      grossReceived: "2,000", netReceived: "2,000", currentDue: "2,900" })]),
    { tolerance: 0 });
  check("no Income but ৳100 short → caught", r.errors.length > 0, lines(r));
  check("caught on both ledgers", r.errors.some((e) => /Program Wise/.test(e.field)) &&
    r.errors.some((e) => /Course Wise/.test(e.field)), lines(r));
}

/* ---- 4. no Income, ৳1 off — the band must not swallow it ---- */
{
  const r = U.compare(
    side([pwRow({ mrn: "4", date: "01/01/2025", previousDue: "5,000", receivable: "5,000", received: "2,000", currentDue: "2,999" })]),
    side([cwRow({ mrn: "4", date: "01/01/2025", course: "A", previousDue: "5,000", receivable: "5,000",
      grossReceived: "2,000", netReceived: "2,000", currentDue: "2,999" })]),
    { tolerance: 0 });
  check("no Income, ৳1 short → caught", r.errors.length > 0, lines(r) || "MISSED");
}

/* ---- 5. no Income, no Previous Due, yet a Receivable exists — still a real fault ---- */
{
  const r = U.compare(
    side([pwRow({ mrn: "5", date: "01/01/2025", receivable: "5,000", currentDue: "5,000" })]),
    side([cwRow({ mrn: "5", date: "01/01/2025", course: "A", receivable: "5,000", currentDue: "5,000" })]),
    { tolerance: 0 });
  check("Receivable from nowhere → still caught", idle(r).length > 0, lines(r) || "MISSED");
}

/* ---- 6. no Income anywhere on the ledger, several rows, all consistent ---- */
{
  const r = U.compare(
    side([
      pwRow({ mrn: "6", date: "01/01/2025", previousDue: "9,000", receivable: "9,000", received: "3,000", currentDue: "6,000" }),
      pwRow({ mrn: "7", date: "01/02/2025", previousDue: "6,000", receivable: "6,000", received: "6,000", currentDue: "0" })
    ]),
    side([
      cwRow({ mrn: "6", date: "01/01/2025", course: "A", previousDue: "9,000", receivable: "9,000",
        grossReceived: "3,000", netReceived: "3,000", currentDue: "6,000" }),
      cwRow({ mrn: "7", date: "01/02/2025", course: "A", previousDue: "6,000", receivable: "6,000",
        grossReceived: "6,000", netReceived: "6,000", currentDue: "0" })
    ]),
    { tolerance: 0 });
  check("whole ledger with no Income → clean", r.errors.length === 0, lines(r));
}

console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
process.exit(fail ? 1 : 0);
