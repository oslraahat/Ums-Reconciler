/* On a Cancellation row (CRN present) the Consideration is what is being taken back and the
 * Previous Due — which on these rows equals the Receivable — is what was owed:
 *
 *     Cash Back   = Consideration − Previous Due + Due Adjustment   (0 if negative)
 *     Current Due = Previous Due − Consideration − Due Adjustment   (0 if negative)
 *
 * Due Adjustment is the part that never leaves — written off against the debt rather than handed
 * back. Drop it and the whole Cash Back reads as cash going out the door, which condemns correct
 * receipts: reg 2146018 CRN 9643214968 takes back 5,000 and refunds 5,000, of which 1,137 clears
 * the Biology due and 3,863 reappears as Gross Received on the Engineering course of the same
 * receipt. Nothing is lost.
 *
 * Measured over 1,082 real students / 289 such rows: with Due Adjustment counted both identities
 * hold 289/289. Without it the Cash Back one fails 12 times — every one a false alarm, and the
 * same 11 programs the §5.2 total was wrongly accusing.
 *
 *   node tests/cancel-shape.js
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
const shape = (r) => r.errors.filter((e) => e.kind === "cancelshape");
const cbErr = (r) => shape(r).filter((e) => /Cash Back/.test(e.field));
const duErr = (r) => shape(r).filter((e) => /Current Due/.test(e.field));
const lines = (r) => shape(r).map((e) => U.shortError(e)).join("\n        ");

/* one cancellation row, put on the Course Wise side (which carries every column) */
function run(cw) {
  return U.compare(
    side([pwRow({ crn: cw.crn, date: "10/02/2023" })]),
    side([cwRow(Object.assign({ date: "10/02/2023", course: "Biology" }, cw))]),
    { tolerance: 0 });
}

/* ---- taken back == owed → both come out zero ---- */
{
  const r = run({ crn: "C1", consideration: "4,200", previousDue: "4,200", receivable: "4,200",
    cashBack: "0", currentDue: "0", dueAdjustment: "4,200" });
  check("cons == owed → Cash Back 0, Current Due 0 → clean", shape(r).length === 0, lines(r));
}

/* ---- taken back > owed → the excess refunds, exactly ---- */
{
  const r = run({ crn: "C2", consideration: "23,000", previousDue: "0", receivable: "0",
    cashBack: "23,000", netReceived: "-23,000" });
  check("23,000 − 0 = 23,000 refunded → clean", shape(r).length === 0, lines(r));
}
{
  const r = run({ crn: "C3", consideration: "14,000", previousDue: "8,000", receivable: "8,000",
    cashBack: "6,000", currentDue: "0" });
  check("14,000 − 8,000 = 6,000 refunded → clean", shape(r).length === 0, lines(r));
}
/* real: reg 1805479 — the whole Consideration was refunded, ignoring the 8,000 still owed */
{
  const r = run({ crn: "C4", consideration: "14,000", previousDue: "8,000", receivable: "8,000",
    cashBack: "14,000", dueAdjustment: "8,000", currentDue: "0" });
  check("real: reg 1805479 — 8,000 written off, 6,000 refunded → clean", shape(r).length === 0, lines(r));
}
{
  /* the same receipt with nothing written off — now 8,000 really did walk out */
  const r = run({ crn: "C4b", consideration: "14,000", previousDue: "8,000", receivable: "8,000",
    cashBack: "14,000", dueAdjustment: "0", currentDue: "0" });
  check("no write-off behind it → caught", cbErr(r).length === 1, lines(r) || "MISSED");
  check("…and the excess is named exactly", cbErr(r)[0] && cbErr(r)[0].delta === 8000,
    cbErr(r)[0] ? "delta=" + cbErr(r)[0].delta : "—");
}
{
  const r = run({ crn: "C5", consideration: "23,000", previousDue: "0", receivable: "0", cashBack: "0" });
  check("nothing refunded at all → caught", cbErr(r).length === 1, lines(r) || "MISSED");
}

/* ---- taken back < owed → the remainder stays owed, exactly ---- */
{
  const r = run({ crn: "C6", consideration: "1,000", previousDue: "4,200", receivable: "4,200",
    cashBack: "0", currentDue: "3,200" });
  check("4,200 − 1,000 = 3,200 still owed → clean", shape(r).length === 0, lines(r));
}
{
  /* written off instead of left owed — the Due Adjustment accounts for it, so this is correct */
  const r = run({ crn: "C7", consideration: "1,000", previousDue: "4,200", receivable: "4,200",
    cashBack: "0", currentDue: "0", dueAdjustment: "3,200" });
  check("the remainder written off by a Due Adjustment → clean", shape(r).length === 0, lines(r));
}
{
  /* nothing written off, nothing refunded, and the 3,200 still vanished */
  const r = run({ crn: "C7b", consideration: "1,000", previousDue: "4,200", receivable: "4,200",
    cashBack: "0", currentDue: "0", dueAdjustment: "0" });
  check("the remaining 3,200 vanished → caught", duErr(r).length === 1, lines(r) || "MISSED");
}
{
  const r = run({ crn: "C8", consideration: "1,000", previousDue: "4,200", receivable: "4,200",
    cashBack: "0", currentDue: "4,200" });
  check("too much left owed → caught", duErr(r).length === 1, lines(r) || "MISSED");
}

/* ---- the two are independent: a row can break one and keep the other ---- */
{
  const r = run({ crn: "C9", consideration: "14,000", previousDue: "8,000", receivable: "8,000",
    cashBack: "14,000", currentDue: "0" });
  check("wrong Cash Back does not drag Current Due in", cbErr(r).length === 1 && duErr(r).length === 0,
    lines(r));
}

/* ---- guards ---- */
{
  const r = U.compare(
    side([pwRow({ mrn: "M1", date: "10/02/2023", consideration: "5,000", receivable: "1,000", currentDue: "0" })]),
    side([cwRow({ mrn: "M1", date: "10/02/2023", course: "Biology", consideration: "5,000",
      receivable: "1,000", currentDue: "0" })]), { tolerance: 0 });
  check("no CRN → rule does not apply", shape(r).length === 0, lines(r));
}
{
  const r = run({ crn: "D1", previousDue: "4,200", receivable: "4,200", currentDue: "0", dueAdjustment: "4,200" });
  check("cancellation without Consideration → rule does not apply", shape(r).length === 0, lines(r));
}
{
  /* split rounding may shift a line by a taka or two — that is the arithmetic, not a fault */
  const r = run({ crn: "D2", consideration: "14,000", previousDue: "8,000", receivable: "8,000",
    cashBack: "6,001", currentDue: "0" });
  check("৳1 of split rounding → forgiven", shape(r).length === 0, lines(r));
}
{
  const r = run({ crn: "D3", consideration: "14,000", previousDue: "8,000", receivable: "8,000",
    cashBack: "6,003", currentDue: "0" });
  check("৳3 is past the rounding band → caught", cbErr(r).length === 1, lines(r) || "MISSED");
}

/* ---- the program-wide §5.2 total must not repeat what the row already said ---- */
{
  const r = run({ crn: "E1", consideration: "14,000", previousDue: "8,000", receivable: "8,000",
    grossReceived: "6,000", cashBack: "14,000", currentDue: "0" });
  check("row-level over-refund reported once, not twice",
    cbErr(r).length === 1 && r.errors.filter((e) => e.kind === "cashback").length === 0,
    r.errors.map((e) => e.kind + ":" + e.field).join(" | "));
}
{
  /* an over-refund no cancellation row explains — the program total is still the only witness */
  const r = U.compare(
    side([pwRow({ mrn: "M2", date: "10/02/2023", received: "1,000", cashBack: "5,000" })]),
    side([cwRow({ mrn: "M2", date: "10/02/2023", course: "Biology", grossReceived: "1,000",
      cashBack: "5,000", netReceived: "-4,000" })]), { tolerance: 0 });
  check("unexplained over-refund still caught by the total",
    r.errors.some((e) => e.kind === "cashback"),
    r.errors.map((e) => U.shortError(e)).join("\n        ") || "MISSED");
}
/* ---- reg 1618736 · CRN 9643244358 · 17/01/2024 — reported as a mismatch, and it is not ----
 *
 *   Consideration 19,000 · Previous Due 9,000 · Due Adjustment 9,000 · Cash Back 10,000
 *
 * 19,000 is reversed: 9,000 clears the debt (Due Adjustment, so Current Due lands on 0) and 10,000
 * goes back as cash. 9,000 + 10,000 = 19,000 — every taka accounted for. Three findings fired, all
 * from two assumptions:
 *
 *   1. §3.5 and the receipt-sum check subtracted the Due Adjustment from a Consideration that
 *      already contained it, so the expected Current Due came out at −9,000 against a stored 0.
 *      UMS never writes a negative due; the cancellation identity below always knew that and
 *      clamped, those two did not.
 *   2. The Cash Back rule demanded the BUNDLED form (…+ Due Adjustment). UMS uses both: here the
 *      column holds only the cash that actually left. Nothing on the row says which convention was
 *      used, so either has to be a pass.
 */
{
  const CRS = "Engineering Full Course (Offli";
  const pay = { date: "05/03/2023", mrn: "9643100001", crn: "", income: "19000", previousDue: "0",
    receivable: "19000", currentDue: "9000" };
  const can = { date: "17/01/2024", mrn: "-", crn: "9643244358", income: "0", consideration: "19000",
    previousDue: "9000", receivable: "9000", currentDue: "0" };
  const r = U.compare(
    side([pwRow(Object.assign({}, pay, { received: "10000" })),
          pwRow(Object.assign({}, can, { received: "0", cashBack: "10000" }))]),
    side([cwRow(Object.assign({}, can, { course: CRS, grossReceived: "0", dueAdjustment: "9000",
            cashBack: "10000", netReceived: "-10000" })),
          cwRow(Object.assign({}, pay, { course: CRS, grossReceived: "10000", netReceived: "10000" }))]),
    { tolerance: 0 });
  check("the whole student comes back clean", r.errors.length === 0, U.summary(r));
  check("…no cancellation-shape complaint", shape(r).length === 0, lines(r));
  check("…and it reads as matched", U.summary(r) === "সব মিলেছে", U.summary(r));
}

/* the un-bundled Cash Back on its own — the row above, read by itself */
{
  const can = (o) => Object.assign({ date: "17/01/2024", mrn: "-", crn: "9643244358", income: "0",
    consideration: "19000", previousDue: "9000", receivable: "9000", currentDue: "0",
    course: "C", grossReceived: "0", dueAdjustment: "9000", netReceived: "-10000" }, o);
  // separate: the column holds only the cash that left
  const sep = U.compare(side([pwRow({ date: "17/01/2024", mrn: "-", crn: "9643244358",
    consideration: "19000", previousDue: "9000", receivable: "9000", cashBack: "10000", currentDue: "0" })]),
    side([cwRow(can({ cashBack: "10000" }))]), { tolerance: 0 });
  check("Cash Back = Consideration − Previous Due passes", cbErr(sep).length === 0, lines(sep));
  // bundled: the write-off is written into the column too — the 12 measured rows
  const bun = U.compare(side([pwRow({ date: "17/01/2024", mrn: "-", crn: "9643244358",
    consideration: "19000", previousDue: "9000", receivable: "9000", cashBack: "10000", currentDue: "0" })]),
    side([cwRow(can({ cashBack: "19000", netReceived: "-19000" }))]), { tolerance: 0 });
  check("…and so does the bundled form, still", cbErr(bun).length === 0, lines(bun));
  // neither reading explains this one, so it is still a fault
  const bad = U.compare(side([pwRow({ date: "17/01/2024", mrn: "-", crn: "9643244358",
    consideration: "19000", previousDue: "9000", receivable: "9000", cashBack: "10000", currentDue: "0" })]),
    side([cwRow(can({ cashBack: "4000", netReceived: "-4000" }))]), { tolerance: 0 });
  check("a Cash Back that fits neither is still caught", cbErr(bad).length === 1, lines(bad));
  check("…and the message offers both readings", /19,000 বা 10,000/.test((cbErr(bad)[0] || {}).note || ""),
    (cbErr(bad)[0] || {}).note);
  /* Program Wise carries no Due Adjustment column at all (PW_COLS), so the bundled reading cannot
     even be expressed there — §2 says that side holds the cash that actually left. Both fixtures
     above therefore put the un-bundled figure on Program Wise and vary only Course Wise. */
  check("…and it is the Course Wise row that carries the two readings",
    (cbErr(bad)[0] || {}).cw !== "—", JSON.stringify((cbErr(bad)[0] || {}).cw));
}

/* the clamp: a cancellation may reverse more than was owed, and UMS stores 0, not a negative */
{
  const r = U.compare(
    side([pwRow({ date: "17/01/2024", mrn: "-", crn: "9643299999", consideration: "19000",
      previousDue: "9000", receivable: "9000", cashBack: "10000", currentDue: "0" })]),
    side([cwRow({ date: "17/01/2024", mrn: "-", crn: "9643299999", course: "C", consideration: "19000",
      previousDue: "9000", receivable: "9000", dueAdjustment: "9000", cashBack: "10000",
      netReceived: "-10000", currentDue: "0" })]), { tolerance: 0 });
  const due = r.errors.filter((e) => e.kind === "identity");
  check("a negative expected due is not reported against a stored 0", due.length === 0,
    due.map((e) => U.shortError(e)).join("\n        "));
  // …but a real gap on a cancellation is still a gap: stored 5,000 where 0 was expected
  const r2 = U.compare(
    side([pwRow({ date: "17/01/2024", mrn: "-", crn: "9643299999", consideration: "19000",
      previousDue: "9000", receivable: "9000", cashBack: "10000", currentDue: "5000" })]),
    side([cwRow({ date: "17/01/2024", mrn: "-", crn: "9643299999", course: "C", consideration: "19000",
      previousDue: "9000", receivable: "9000", dueAdjustment: "9000", cashBack: "10000",
      netReceived: "-10000", currentDue: "5000" })]), { tolerance: 0 });
  check("…while a stored due that should be 0 still is", r2.errors.filter((e) => e.kind === "identity").length > 0,
    "errors=" + r2.errors.length);
}

/* ---- reg 2035886 · CRN 9643217712 — the same write-off subtracted twice ----
 *
 * Two courses, 17,500 owed between them. The Maths course is cancelled: Consideration 5,000 comes
 * back as Due Adjustment 3,889 (clearing the Maths due) + Cash Back 1,111, and that 1,111 is
 * received again on the Medical line of the same receipt. Due 17,500 → 12,500, and
 * 17,500 − 5,000 = 12,500 exactly.
 *
 * The identity subtracted the Consideration AND the Due Adjustment, though the 3,889 is inside the
 * 5,000 — so it expected 8,611 and reported "বকেয়ার অঙ্ক মিলছে না", short by exactly the write-off.
 * The other convention (reg 1436567) needs that subtraction, so both readings are accepted.
 */
{
  const MED = "Medical & Dental Full Course 2022", MTH = "UDVASH Varsity Math Course 2022";
  const r = U.compare(
    side([pwRow({ date: "10/08/2022", mrn: "6919077352", income: "22500", receivable: "22500",
            received: "5000", currentDue: "17500" }),
          pwRow({ date: "10/08/2022", mrn: "9641350568", previousDue: "17500", receivable: "17500",
            currentDue: "17500" }),
          pwRow({ date: "09/01/2023", crn: "9643217712", consideration: "5000", previousDue: "17500",
            receivable: "17500", currentDue: "12500" })]),
    side([cwRow({ date: "09/01/2023", course: MED, crn: "9643217712", previousDue: "13611",
            receivable: "13611", grossReceived: "1111", netReceived: "1111", currentDue: "12500" }),
          cwRow({ date: "09/01/2023", course: MTH, crn: "9643217712", consideration: "5000",
            previousDue: "3889", receivable: "3889", dueAdjustment: "3889", cashBack: "1111",
            netReceived: "(1111)" }),
          cwRow({ date: "10/08/2022", course: MTH, mrn: "9641350568", previousDue: "3889",
            receivable: "3889", currentDue: "3889" }),
          cwRow({ date: "10/08/2022", course: MED, mrn: "9641350568", previousDue: "13611",
            receivable: "13611", currentDue: "13611" }),
          cwRow({ date: "10/08/2022", course: MTH, mrn: "6919077352", income: "5000",
            receivable: "5000", grossReceived: "1111", netReceived: "1111", currentDue: "3889" }),
          cwRow({ date: "10/08/2022", course: MED, mrn: "6919077352", income: "17500",
            receivable: "17500", grossReceived: "3889", netReceived: "3889", currentDue: "13611" })]),
    { tolerance: 0 });
  check("the whole student comes back clean", r.errors.length === 0,
    r.errors.map((e) => U.shortError(e)).join("\n        "));
  check("…and reads as matched", U.summary(r) === "সব মিলেছে", U.summary(r));
}

/* both conventions pass; a due that fits NEITHER is still a fault */
{
  const one = (curDue) => U.compare(
    side([pwRow({ date: "05/03/2023", mrn: "9643100001", income: "19000", receivable: "19000",
            received: "10000", currentDue: "9000" }),
          pwRow({ date: "17/01/2024", crn: "9643244358", consideration: "19000", previousDue: "9000",
            receivable: "9000", cashBack: "10000", currentDue: curDue })]),
    side([cwRow({ date: "17/01/2024", course: "Engineering Full Course", crn: "9643244358",
            consideration: "19000", previousDue: "9000", receivable: "9000", dueAdjustment: "9000",
            cashBack: "10000", netReceived: "(10000)", currentDue: curDue }),
          cwRow({ date: "05/03/2023", course: "Engineering Full Course", mrn: "9643100001",
            income: "19000", receivable: "19000", grossReceived: "10000", netReceived: "10000",
            currentDue: "9000" })]),
    { tolerance: 0 });
  check("the separate convention passes", one("0").errors.length === 0,
    one("0").errors.map((e) => U.shortError(e)).join("\n        "));
  const bad = one("5000");
  const due = bad.errors.filter((e) => e.kind === "identity");
  check("a due matching neither reading is still caught", due.length >= 2, "identity errors=" + due.length);
  check("…and it is reported against 0, not against a guess",
    /হওয়ার কথা 0, আছে 5,000/.test(U.shortError(due[0])), U.shortError(due[0]));
}


console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
process.exit(fail ? 1 : 0);
