/* Program Wise reports the cash that actually left; Course Wise bundles the Due Adjustment into
 * the same Cash Back column, because there the write-off and the refund both drain the course's
 * balance. The gap between them is therefore not "Course Wise may be bigger" — it is exactly:
 *
 *     Course Wise Cash Back − Due Adjustment = Program Wise Cash Back
 *
 * reg 1436567 CRN 9643297107: 17,000 − 7,000 = 10,000. Of the 17,000 taken back, 7,000 was still
 * owed and only cancelled the debt; 10,000 had been paid and came back as cash.
 *
 * The old test only asked whether Course Wise was the larger of the two, so any inflated figure
 * passed. Measured over 1,085 students / 1,545 shared receipts: 12 differ, and all 12 satisfy the
 * exact identity — tightening it costs nothing and closes the hole.
 *
 *   node tests/cashback-bundle.js
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
const check = (name, ok, extra) => { if (!ok) fail++; console.log((ok ? "PASS  " : "FAIL  ") + name + (!ok && extra ? "   " + extra : "")); };
const cbErr = (r) => r.errors.filter((e) => e.field === "Cash Back");
const lines = (r) => r.errors.map((e) => U.shortError(e)).join("\n        ");

/* The cancellation cannot stand alone: the 10,000 it refunds was collected by an earlier receipt,
   and without that receipt the program-wide §5.2 total sees a refund with nothing behind it. So
   this is the real pair — 02/05 collects, 04/05 cancels. */
const PAID_PW = pwRow({ mrn: "2717036065", date: "02/05/2026", income: "18,000",
  receivable: "18,000", prevStd: "1,000", received: "10,000", currentDue: "7,000" });
const PAID_CW = cwRow({ mrn: "2717036065", date: "02/05/2026", course: "51st BCS Preli",
  income: "18,000", receivable: "18,000", prevStd: "1,000", grossReceived: "10,000",
  netReceived: "10,000", currentDue: "7,000" });

function run(cwOver, pwOver) {
  return U.compare(
    side([PAID_PW, pwRow(Object.assign({ crn: "9643297107", date: "04/05/2026", consideration: "17,000",
      previousDue: "7,000", receivable: "7,000", cashBack: "10,000" }, pwOver))]),
    side([cwRow(Object.assign({ crn: "9643297107", date: "04/05/2026", course: "51st BCS Preli",
      consideration: "17,000", previousDue: "7,000", receivable: "7,000", dueAdjustment: "7,000",
      cashBack: "17,000", netReceived: "-17,000" }, cwOver)), PAID_CW]),
    { tolerance: 0 });
}

/* ---- the real receipt ---- */
{
  const r = run();
  check("reg 1436567 — 17,000 − 7,000 = 10,000 → clean", r.errors.length === 0, lines(r));
  check("…and the note explains the gap rather than hiding it",
    (r.notes || []).some((n) => /Due Adjustment 7,000/.test(n.detail || "")),
    (r.notes || []).map((n) => n.detail).join(" | "));
}

/* ---- the hole the old rule left open ---- */
{
  /* Course Wise inflated to 25,000: still larger than Program Wise, so the old test passed it */
  const r = run({ cashBack: "25,000", netReceived: "-25,000" });
  check("Course Wise inflated beyond the adjustment → caught", cbErr(r).length === 1, lines(r) || "MISSED");
  check("…and the message shows the subtraction",
    cbErr(r)[0] && /25,000 − Due Adjustment 7,000 = 18,000/.test(cbErr(r)[0].note),
    cbErr(r)[0] ? cbErr(r)[0].note : "—");
}
{
  /* no write-off at all behind a 17,000 refund where only 10,000 was paid */
  const r = run({ dueAdjustment: "0" });
  check("bundled figure with no Due Adjustment behind it → caught", cbErr(r).length === 1, lines(r) || "MISSED");
}

/* ---- the direction the old rule did catch must still be caught ---- */
{
  const r = run({ cashBack: "4,000", netReceived: "-4,000", dueAdjustment: "0" });
  check("Course Wise smaller than Program Wise → caught", cbErr(r).length === 1, lines(r) || "MISSED");
}

/* ---- equal on both sides needs no explaining ---- */
{
  const r = U.compare(
    side([pwRow({ mrn: "M1", date: "01/01/2025", income: "5,000", receivable: "5,000",
      received: "5,000", cashBack: "1,000" })]),
    side([cwRow({ mrn: "M1", date: "01/01/2025", course: "Math", income: "5,000", receivable: "5,000",
      grossReceived: "5,000", cashBack: "1,000", netReceived: "4,000", currentDue: "1,000" })]),
    { tolerance: 0 });
  check("equal Cash Back → no error and no note", cbErr(r).length === 0 &&
    !(r.notes || []).some((n) => /Cash Back/.test(n.detail || "")), lines(r));
}

/* ---- split across two course rows, summed before comparing ---- */
{
  const r = U.compare(
    side([pwRow({ crn: "C1", date: "04/05/2026", consideration: "17,000", previousDue: "7,000",
      receivable: "7,000", cashBack: "10,000" })]),
    side([
      cwRow({ crn: "C1", date: "04/05/2026", course: "A", consideration: "10,000", previousDue: "4,000",
        receivable: "4,000", dueAdjustment: "4,000", cashBack: "10,000", netReceived: "-10,000" }),
      cwRow({ crn: "C1", date: "04/05/2026", course: "B", consideration: "7,000", previousDue: "3,000",
        receivable: "3,000", dueAdjustment: "3,000", cashBack: "7,000", netReceived: "-7,000" })
    ]), { tolerance: 0 });
  check("two course rows: (10,000+7,000) − (4,000+3,000) = 10,000 → clean",
    cbErr(r).length === 0, lines(r));
}

/* ---- ±2৳ of split rounding is forgiven, more is not ---- */
{
  check("৳1 of rounding → forgiven", cbErr(run({ cashBack: "17,001" })).length === 0);
  check("৳5 past the band → caught", cbErr(run({ cashBack: "17,005" })).length === 1);
}

/* ---- the source must not slip back to the loose comparison ---- */
{
  const REC = fs.readFileSync(path.join(__dirname, "..", "reconcile.js"), "utf8");
  check("the 'Course Wise ≥ Program Wise' shortcut is gone",
    !/ccb < pcb - 1e-6/.test(REC), "reconcile.js");
  // the Due Adjustment identity is still one of the figures tested, not a ≥ / ≤ allowance
  check("the exact identity is what is tested",
    /const cands = \[ccb - adj - moved, ccb - moved\];/.test(REC), "reconcile.js");
  check("…and what moved between courses is measured, not assumed",
    /Math\.max\(0, \(grp\.sum\.grossReceived \|\| 0\) - money\(pr\.received\)\)/.test(REC), "reconcile.js");
  check("…only on a cancellation", /isCancel\(pr\) \? Math\.max\(0, \(grp\.sum\.grossReceived/.test(REC), "reconcile.js");
}

/* ---- reg 2365277 · CRN 9643232014 — "Biology porbena" ----
 *
 * Program Wise says Cash Back 0, Course Wise says 5,185, and that was the most serious category in
 * the report — "একই রসিদে দুই পাতায় দুই রকম টাকা". It is not a mismatch at all. The Biology course
 * is cancelled and its 7,000 comes back in two parts: 1,815 as a Due Adjustment (clearing the
 * Biology due) and 5,185 as Cash Back — which is immediately received again on the Engineering
 * line of the SAME receipt, settling its 5,185 due. Nothing reached the student, so the header's 0
 * is right. The Received rule already forgave this movement; Cash Back did not.
 */
{
  const ENG = "Engineering Full Course", BIO = "UNMESH Biology Course";
  const r = U.compare(
    side([pwRow({ date: "27/03/2023", mrn: "3121353558", income: "27000", receivable: "27000",
            received: "20000", currentDue: "7000" }),
          pwRow({ date: "15/10/2023", crn: "9643232014", consideration: "7000", previousDue: "7000",
            receivable: "7000" })]),
    side([cwRow({ date: "15/10/2023", course: ENG, crn: "9643232014", previousDue: "5185",
            receivable: "5185", grossReceived: "5185", netReceived: "5185" }),
          cwRow({ date: "15/10/2023", course: BIO, crn: "9643232014", consideration: "7000",
            previousDue: "1815", receivable: "1815", dueAdjustment: "1815", cashBack: "5185",
            netReceived: "(5185)" }),
          cwRow({ date: "27/03/2023", course: BIO, mrn: "3121353558", income: "7000",
            receivable: "7000", grossReceived: "5185", netReceived: "5185", currentDue: "1815" }),
          cwRow({ date: "27/03/2023", course: ENG, mrn: "3121353558", income: "20000",
            receivable: "20000", grossReceived: "14815", netReceived: "14815", currentDue: "5185" })]),
    { tolerance: 0 });
  check("the whole student comes back clean", r.errors.length === 0,
    r.errors.map((e) => U.shortError(e)).join("\n        "));
  check("…and reads as matched", U.summary(r) === "সব মিলেছে", U.summary(r));
  check("…with the movement written down, not silently dropped",
    (r.notes || []).some((n) => /Course-এর মাঝে সরানো 5,185/.test(n.detail)),
    (r.notes || []).map((n) => n.detail).join(" | "));
}

/* money that did NOT come back on another line is still cash out the door */
{
  const r = U.compare(
    side([pwRow({ date: "15/10/2023", crn: "9643232014", consideration: "7000", previousDue: "7000",
      receivable: "7000" })]),
    side([cwRow({ date: "15/10/2023", course: "UNMESH Biology Course", crn: "9643232014",
      consideration: "7000", previousDue: "1815", receivable: "1815", dueAdjustment: "1815",
      cashBack: "5185", netReceived: "(5185)" })]),
    { tolerance: 0 });
  const cb = r.errors.filter((e) => e.field === "Cash Back");
  check("nothing received it back → Cash Back still reported", cb.length === 1,
    r.errors.map((e) => U.shortError(e)).join("\n        "));
}

console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
process.exit(fail ? 1 : 0);
