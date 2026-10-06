/* "If the gross-up is forgiven, can a REAL missing taka hide behind it?"  — No.
 *
 * On a cancellation the Received and Cash Back columns are forgiven for money that merely moves
 * from one course to another on the SAME receipt: it never reached the student, so Program Wise
 * nets it out while Course Wise shows it grossed-up. (reg 3853681 on orgbd.net: 600 of a 5,600
 * release cleared another course's 600 due, so Course Wise Cash Back 5,600 ↔ Program Wise 5,000.)
 *
 * The worry: does that forgiveness also wave through a genuine missing / extra taka? It cannot —
 * the forgiveness lives ONLY in the Received / Cash Back column checks, and two other checks run on
 * the same receipt with NO such allowance:
 *
 *   1. the per-receipt Current Due identity — "ভাগ করলেও যোগফল মূল টাকার সমান থাকতে হবে":
 *        Receivable − Consideration − discounts − NetReceived  ==  Σ Current Due   (±tol only)
 *   2. the Cash Back allowance is itself bounded — it forgives EXACTLY what moved
 *        (Gross Received − header Received), never an arbitrary amount.
 *
 * So the gross-up passes only when every net figure still balances — i.e. when no taka was lost or
 * gained. The moment one actually goes missing, the student stops being clean. This proves it on
 * the real reg 2365277 migration (5,185 moves course→course, correctly matched).
 *
 *   node tests/moved-guard.js
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
const lines = (r) => r.errors.map((e) => U.shortError(e)).join("\n        ");
const field = (r, f) => r.errors.filter((e) => e.field === f);

/* reg 2365277 · CRN 9643232014 — the Biology course is cancelled; its 7,000 comes back as 1,815
   Due Adjustment + 5,185 Cash Back, and that 5,185 is received again on the Engineering line of the
   SAME receipt. Nothing reached the student, so Program Wise's Cash Back is 0. The cancellation
   lines can be overridden to inject a fault. */
const ENG = "Engineering Full Course", BIO = "UNMESH Biology Course";
function student(engOver, bioOver) {
  return U.compare(
    side([
      pwRow({ date: "27/03/2023", mrn: "3121353558", income: "27000", receivable: "27000",
        received: "20000", currentDue: "7000" }),
      pwRow({ date: "15/10/2023", crn: "9643232014", consideration: "7000", previousDue: "7000",
        receivable: "7000" })
    ]),
    side([
      cwRow(Object.assign({ date: "15/10/2023", course: ENG, crn: "9643232014", previousDue: "5185",
        receivable: "5185", grossReceived: "5185", netReceived: "5185" }, engOver)),
      cwRow(Object.assign({ date: "15/10/2023", course: BIO, crn: "9643232014", consideration: "7000",
        previousDue: "1815", receivable: "1815", dueAdjustment: "1815", cashBack: "5185",
        netReceived: "(5185)" }, bioOver)),
      cwRow({ date: "27/03/2023", course: BIO, mrn: "3121353558", income: "7000",
        receivable: "7000", grossReceived: "5185", netReceived: "5185", currentDue: "1815" }),
      cwRow({ date: "27/03/2023", course: ENG, mrn: "3121353558", income: "20000",
        receivable: "20000", grossReceived: "14815", netReceived: "14815", currentDue: "5185" })
    ]),
    { tolerance: 0 });
}

/* ---- the gross-up itself: forgiven, and read as matched ---- */
{
  const r = student();
  check("5,185 moving course→course → clean (the gross-up is forgiven)", r.errors.length === 0, lines(r));
  check("…and reads as matched", U.summary(r) === "সব মিলেছে", U.summary(r));
  check("…with the movement written down as a note, not hidden",
    (r.notes || []).some((n) => /Course-এর মাঝে সরানো 5,185/.test(n.detail || "")),
    (r.notes || []).map((n) => n.detail).join(" | "));
}

/* ---- Backstop 1: a wrong Current Due distribution is caught even though Cash Back is forgiven ----
   Put a phantom 600 Current Due on the cancelled line. Cash Back still nets out (unchanged), but the
   receipt's Current Due no longer adds up to what the money says it should — and that check has no
   "moved" allowance, so it fires. A real 600 cannot ride through on the Cash Back forgiveness. */
{
  const r = student(null, { currentDue: "600" });
  check("phantom 600 Current Due on the forgiven receipt → NOT clean", r.errors.length > 0, "MISSED");
  check("…caught by the exact Current Due identity, not the Cash Back allowance",
    field(r, "Course-ভাগের যোগফল মিলছে না").length === 1, lines(r) || "MISSED");
  check("…and the Cash Back column is still forgiven (no Cash Back error)",
    field(r, "Cash Back").length === 0, lines(r));
}

/* ---- Backstop 2: the allowance is bounded to what actually moved ----
   600 of the released 5,185 never comes back on another line (Engineering receives 600 less). That
   600 genuinely left, so the forgiveness — which only covers Gross Received − header Received — can
   no longer absorb the full Cash Back, and it is reported. */
{
  const r = student({ grossReceived: "4585", netReceived: "4585" });
  check("600 that left did not come back on another line → NOT clean", r.errors.length > 0, "MISSED");
  check("…and the Cash Back shortfall is named", field(r, "Cash Back").length === 1, lines(r) || "MISSED");
}

/* ---- the forgiveness must stay pinned to a cancellation ----
   The same gross-up shape on an ordinary (non-cancellation) receipt has no "money moved" story, so
   the Received difference is a real one and must be reported. */
{
  const r = U.compare(
    side([pwRow({ mrn: "M9", date: "01/02/2025", income: "5000", receivable: "5000",
      received: "4000", currentDue: "1000" })]),
    side([
      cwRow({ mrn: "M9", date: "01/02/2025", course: "A", income: "3000", receivable: "3000",
        grossReceived: "3000", netReceived: "3000", currentDue: "0" }),
      cwRow({ mrn: "M9", date: "01/02/2025", course: "B", income: "2000", receivable: "2000",
        grossReceived: "1600", netReceived: "1600", currentDue: "400" })
    ]),
    { tolerance: 0 });
  check("gross-up on a non-cancellation receipt is NOT forgiven",
    field(r, "Received").length === 1, lines(r) || "MISSED");
}

console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
process.exit(fail ? 1 : 0);
