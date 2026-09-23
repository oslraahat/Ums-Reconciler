/* Cancellation rows used to be excused ("Due Adjustment may sit on another course") and shown as a
 * warning. The real reason the formula failed was simpler: Due Adjustment was never subtracted.
 * Now it is, and only rounding is forgiven — anything past ±2৳ is a mismatch.
 *
 * Numbers below are taken from real students seen during this work.
 *
 *   node tests/cancel.js
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
const side = (rows, extra) => Object.assign({ ok: true, rows, cols: {}, totalRow: null, noData: false }, extra || {});

let fail = 0;
const check = (name, ok, extra) => { if (!ok) fail++; console.log((ok ? "PASS  " : "FAIL  ") + name + (extra ? "   " + extra : "")); };
const dueErrors = (r) => r.errors.filter((e) => /Current Due-র হিসাব/.test(e.field));

/* real: reg 2078680, CRN 9643220794 — Biology cancelled, Due Adjustment 4,200 wipes its 4,200 due */
{
  const r = U.compare(
    side([pwRow({ crn: "9643220794", date: "11/02/2023", previousDue: "4,200", receivable: "4,200" })]),
    side([cwRow({ crn: "9643220794", date: "11/02/2023", course: "UNMESH Biology",
      previousDue: "4,200", receivable: "4,200", dueAdjustment: "4,200", currentDue: "0" })]),
    { tolerance: 0 });
  check("Due Adjustment accounted for → cancellation row is clean", dueErrors(r).length === 0,
    dueErrors(r).map((e) => e.note).join(" | "));
  /* filtering to one field is how a second rule managed to flag this same correct row for a
     while — a Cancellation that ties must come back clean on EVERY rule, so check them all. */
  check("…and no other rule flags it either", r.errors.length === 0,
    r.errors.map((e) => U.shortError(e)).join("\n        "));
}

/* Due Adjustment on a row that is not a cancellation at all (no CRN) — that is the one thing
   the Current Due identity cannot object to, so the §2 placement rule still must. */
{
  const r = U.compare(
    side([pwRow({ mrn: "M1", date: "11/02/2023", previousDue: "4,200", receivable: "4,200", currentDue: "0" })]),
    side([cwRow({ mrn: "M1", date: "11/02/2023", course: "UNMESH Biology",
      previousDue: "4,200", receivable: "4,200", dueAdjustment: "4,200", currentDue: "0" })]),
    { tolerance: 0 });
  check("Due Adjustment without a cancellation → caught",
    r.errors.some((e) => /Due Adjustment ভুল জায়গায়/.test(e.field)),
    r.errors.map((e) => U.shortError(e)).join("\n        ") || "MISSED");
}

/* same shape, but the adjustment does not cover the due — 4,200 owed, only 1,000 adjusted */
{
  const r = U.compare(
    side([pwRow({ crn: "C2", date: "11/02/2023", previousDue: "4,200", receivable: "4,200" })]),
    side([cwRow({ crn: "C2", date: "11/02/2023", course: "UNMESH Biology",
      previousDue: "4,200", receivable: "4,200", dueAdjustment: "1,000", currentDue: "0" })]),
    { tolerance: 0 });
  check("shortfall beyond rounding → mismatch", dueErrors(r).length > 0,
    dueErrors(r).map((e) => e.note).join(" | "));
}

/* real: reg 1516901 — off by exactly 1৳ after the adjustment; that is the split rounding */
{
  const r = U.compare(
    side([pwRow({ crn: "C3", date: "19/01/2023", receivable: "1", previousDue: "1" })]),
    side([cwRow({ crn: "C3", date: "19/01/2023", course: "HSC Board Standard Revision",
      previousDue: "1", receivable: "1", dueAdjustment: "0", currentDue: "0" })]),
    { tolerance: 0 });
  check("±1৳ after the adjustment → forgiven", dueErrors(r).length === 0,
    dueErrors(r).map((e) => e.note).join(" | "));
}

/* the bucket itself is gone: nothing may land in warnings any more */
{
  const r = U.compare(
    side([pwRow({ mrn: "9", date: "01/01/2022", income: "5,000", receivable: "5,000", previousDue: "3,000" })]),
    side([cwRow({ mrn: "9", date: "01/01/2022", course: "A", income: "5,000", receivable: "5,000",
      previousDue: "3,000", grossReceived: "100", netReceived: "0", roll: "R1" }),
          cwRow({ mrn: "9", date: "01/01/2022", course: "B", roll: "R2" })]),
    { tolerance: 0 });
  check("no warnings bucket left", (r.warnings || []).length === 0, "warnings=" + (r.warnings || []).length);
  check("§3.3 / §3.4 / §6 now count as errors", r.errors.length > 0, "errors=" + r.errors.length);
  const kinds = [...new Set(r.errors.map((e) => e.kind))].join(",");
  check("kinds carried for classify()", /identity|struct/.test(kinds), kinds);
}

console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
process.exit(fail ? 1 : 0);
