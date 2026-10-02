/* The due chain is read off consecutive receipts: what one closes at, the next opens at. If a
 * receipt is missing from one ledger, the chain there has a hole, and the two rows either side of
 * it disagree by exactly what the missing receipt did. Blaming the row after the hole is wrong —
 * that row is correct, and the missing receipt is already reported on its own.
 *
 * Real: reg 1960915 loses cancellation CRN 9643203886, which consumed a 6,000 due, so Course Wise
 * read "Previous Due 6,000 হওয়ার কথা, আছে 0" on a row with nothing wrong with it.
 *
 * The danger of suppressing it is obvious, so this pins the other half too: a chain that breaks
 * with no missing receipt to explain it must still be reported.
 *
 *   node tests/chain-gap.js
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
const chain = (r) => r.errors.filter((e) => e.kind === "chain");
const lines = (r) => r.errors.map((e) => U.shortError(e)).join("\n        ");

/* real: reg 1960915 — 04/01 leaves 6,000 owed, the 15/01 cancellation eats it, 16/02 opens at 0.
   Course Wise never got the cancellation, so its chain jumps 6,000 → 0. */
const PW_1960915 = [
  pwRow({ mrn: "1915012327", date: "04/01/2022", income: "16,000", receivable: "16,000", received: "10,000", currentDue: "6,000" }),
  pwRow({ crn: "9643203886", date: "15/01/2022", consideration: "16,000", previousDue: "6,000",
    receivable: "6,000", cashBack: "10,000" }),
  pwRow({ mrn: "5520355532", date: "16/02/2022", income: "17,000", receivable: "17,000", received: "17,000" })
];
const CW_1960915 = [
  cwRow({ mrn: "5520355532", date: "16/02/2022", course: "Varsity 'KA' Full Course", income: "17,000",
    receivable: "17,000", grossReceived: "17,000", netReceived: "17,000" }),
  cwRow({ mrn: "1915012327", date: "04/01/2022", course: "Varsity 'KA' Full Course", income: "16,000",
    receivable: "16,000", grossReceived: "10,000", netReceived: "10,000", currentDue: "6,000" })
];

{
  const r = U.compare(side(PW_1960915), side(CW_1960915), { tolerance: 0 });
  check("hole left by a missing receipt → no chain error", chain(r).length === 0, lines(r));
  check("…the missing receipt itself is still reported",
    r.errors.some((e) => e.field === "Transaction" && /9643203886/.test(e.key)), lines(r));
  check("…and that is the only finding", r.errors.length === 1, lines(r));
}

/* the same ledgers with the cancellation present in Course Wise too — nothing is missing, so the
   chain has to hold, and it does */
{
  /* Course Wise চলে নতুন→পুরনো, তাই বাতিলটা মাঝখানে বসাতে হবে — শেষে দিলে ক্রমই ভাঙে */
  const cw = [CW_1960915[0],
    cwRow({ crn: "9643203886", date: "15/01/2022", course: "Varsity 'KA' Full Course",
      consideration: "16,000", previousDue: "6,000", receivable: "6,000",
      cashBack: "10,000", netReceived: "-10,000" }),
    CW_1960915[1]];
  const r = U.compare(side(PW_1960915), side(cw), { tolerance: 0 });
  check("nothing missing → chain holds", chain(r).length === 0, lines(r));
}

/* ---- the half that must NOT be suppressed ---- */
{
  /* both ledgers carry every receipt; the middle one simply opens at the wrong figure */
  const pw = [
    pwRow({ mrn: "A", date: "01/01/2025", receivable: "10,000", received: "4,000", currentDue: "6,000" }),
    pwRow({ mrn: "B", date: "01/02/2025", previousDue: "1,000", receivable: "1,000", received: "1,000" })
  ];
  const cw = [
    cwRow({ mrn: "A", date: "01/01/2025", course: "Math", receivable: "10,000",
      grossReceived: "4,000", netReceived: "4,000", currentDue: "6,000" }),
    cwRow({ mrn: "B", date: "01/02/2025", course: "Math", previousDue: "1,000", receivable: "1,000",
      grossReceived: "1,000", netReceived: "1,000" })
  ];
  const r = U.compare(side(pw), side(cw), { tolerance: 0 });
  check("genuine chain break, nothing missing → caught", chain(r).length > 0, lines(r) || "MISSED");
  check("…caught on both ledgers",
    chain(r).some((e) => /Program Wise/.test(e.field)) && chain(r).some((e) => /Course Wise/.test(e.field)),
    chain(r).map((e) => e.field).join(" | "));
}
{
  /* a receipt IS missing, but it sits after the break, so it explains nothing */
  const pw = [
    pwRow({ mrn: "A", date: "01/01/2025", receivable: "10,000", received: "4,000", currentDue: "6,000" }),
    pwRow({ mrn: "B", date: "01/02/2025", previousDue: "1,000", receivable: "1,000", received: "1,000" }),
    pwRow({ crn: "Z", date: "01/03/2025", consideration: "5,000", cashBack: "5,000" })
  ];
  const cw = [
    cwRow({ mrn: "A", date: "01/01/2025", course: "Math", receivable: "10,000",
      grossReceived: "4,000", netReceived: "4,000", currentDue: "6,000" }),
    cwRow({ mrn: "B", date: "01/02/2025", course: "Math", previousDue: "1,000", receivable: "1,000",
      grossReceived: "1,000", netReceived: "1,000" })
  ];
  const r = U.compare(side(pw), side(cw), { tolerance: 0 });
  check("missing receipt AFTER the break does not excuse it", chain(r).length > 0, lines(r) || "MISSED");
}
{
  /* and one BEFORE the break excuses nothing either */
  const pw = [
    pwRow({ crn: "Z", date: "01/12/2024", consideration: "5,000", cashBack: "5,000" }),
    pwRow({ mrn: "A", date: "01/01/2025", receivable: "10,000", received: "4,000", currentDue: "6,000" }),
    pwRow({ mrn: "B", date: "01/02/2025", previousDue: "1,000", receivable: "1,000", received: "1,000" })
  ];
  const cw = [
    cwRow({ mrn: "A", date: "01/01/2025", course: "Math", receivable: "10,000",
      grossReceived: "4,000", netReceived: "4,000", currentDue: "6,000" }),
    cwRow({ mrn: "B", date: "01/02/2025", course: "Math", previousDue: "1,000", receivable: "1,000",
      grossReceived: "1,000", netReceived: "1,000" })
  ];
  const r = U.compare(side(pw), side(cw), { tolerance: 0 });
  check("missing receipt BEFORE the break does not excuse it", chain(r).length > 0, lines(r) || "MISSED");
}

/* ---- a discount on the carried due is not a chain break ----
   reg 1959425 UDVASH Varsity Math: the 04/01 receipt leaves 4,319 owed; the 12/03 receipt writes
   624 of it off as a Special Discount, so UMS shows its Previous Due net at 3,695 (= 4,319 − 624).
   That drop is explained by the discount on the receipt, so it must not be reported as a chain break
   — while §3.5 still verifies the receipt's own arithmetic. */
{
  const pw = [
    pwRow({ mrn: "A", date: "04/01/2022", receivable: "10,000", received: "5,681", currentDue: "4,319" }),
    pwRow({ mrn: "B", date: "12/03/2022", income: "0", previousDue: "3,695", receivable: "3,695",
      special: "624", received: "3,695" })
  ];
  const cw = [
    cwRow({ mrn: "A", date: "04/01/2022", course: "UDVASH Varsity Math", receivable: "10,000",
      grossReceived: "5,681", netReceived: "5,681", currentDue: "4,319" }),
    cwRow({ mrn: "B", date: "12/03/2022", course: "UDVASH Varsity Math", previousDue: "3,695",
      receivable: "3,695", special: "624", grossReceived: "3,695", netReceived: "3,695" })
  ];
  const r = U.compare(side(pw), side(cw), { tolerance: 0 });
  check("a Special Discount on the carried due → no chain break",
    chain(r).length === 0, lines(r) || "(none)");
  /* but a drop that the discount does NOT account for is still a break */
  const cw2 = [cw[0], cwRow({ mrn: "B", date: "12/03/2022", course: "UDVASH Varsity Math",
    previousDue: "3,000", receivable: "3,000", special: "624", grossReceived: "3,000", netReceived: "3,000" })];
  const r2 = U.compare(side([pw[0], pwRow({ mrn: "B", date: "12/03/2022", previousDue: "3,000",
    receivable: "3,000", special: "624", received: "3,000" })]), side(cw2), { tolerance: 0 });
  check("…but a drop bigger than the discount is still caught", chain(r2).length > 0, lines(r2) || "MISSED");
}

/* ---- receipts out of order are not a chain break if the money still links up ----
   reg 1991339 Medical & Dental Full: 12,000 → (a 23/02 receipt writes off 2,000) → 10,000 → 0. The
   write-off receipt was dated late, so the chain ordered it last and read 12,000 → 10,000 directly.
   But 10,000 is exactly where that receipt closes, so every opening still matches some closing — the
   money is continuous, only the order is off (which the row-order check reports on its own). */
{
  const pw = [
    pwRow({ mrn: "R1", date: "01/01/2025", income: "12,000", receivable: "12,000", currentDue: "12,000" }),
    pwRow({ mrn: "R2", date: "09/09/2025", previousDue: "12,000", receivable: "12,000", special: "2,000", currentDue: "10,000" }),
    pwRow({ mrn: "R3", date: "05/01/2025", previousDue: "10,000", receivable: "10,000", received: "10,000", currentDue: "0" })
  ];
  const cw = [
    cwRow({ mrn: "R1", date: "01/01/2025", course: "Full", income: "12,000", receivable: "12,000", currentDue: "12,000" }),
    cwRow({ mrn: "R2", date: "09/09/2025", course: "Full", previousDue: "12,000", receivable: "12,000", special: "2,000", currentDue: "10,000" }),
    cwRow({ mrn: "R3", date: "05/01/2025", course: "Full", previousDue: "10,000", receivable: "10,000", grossReceived: "10,000", netReceived: "10,000", currentDue: "0" })
  ];
  const r = U.compare(side(pw), side(cw), { tolerance: 0 });
  check("out-of-order receipts that still link → no chain break", chain(r).length === 0, lines(r) || "(none)");
  /* a true gap, where an opening matches NO receipt's closing, is still caught */
  const cwBad = [cw[0], cw[2], cwRow({ mrn: "R2", date: "09/09/2025", course: "Full",
    previousDue: "7,000", receivable: "7,000", special: "2,000", currentDue: "5,000" })];
  const pwBad = [pw[0], pw[2], pwRow({ mrn: "R2", date: "09/09/2025", previousDue: "7,000",
    receivable: "7,000", special: "2,000", currentDue: "5,000" })];
  const rBad = U.compare(side(pwBad), side(cwBad), { tolerance: 0 });
  check("…while an opening that links to nothing is still caught", chain(rBad).length > 0, lines(rBad) || "MISSED");

  /* a due that VANISHED to zero must still be caught — 0 is where every paid receipt closes, so the
     "links to some closing" rule must not excuse an opening of 0 just because another receipt ends at 0 */
  const pwZero = [
    pwRow({ mrn: "Z1", date: "01/01/2025", income: "5,000", receivable: "5,000", currentDue: "5,000" }),
    pwRow({ mrn: "Z2", date: "02/01/2025", previousDue: "0", receivable: "0", currentDue: "0" }),
    pwRow({ mrn: "Z3", date: "03/01/2025", income: "1,000", receivable: "1,000", received: "1,000", currentDue: "0" })
  ];
  const cwZero = [
    cwRow({ mrn: "Z1", date: "01/01/2025", course: "Full", income: "5,000", receivable: "5,000", currentDue: "5,000" }),
    cwRow({ mrn: "Z2", date: "02/01/2025", course: "Full", previousDue: "0", receivable: "0", currentDue: "0" }),
    cwRow({ mrn: "Z3", date: "03/01/2025", course: "Full", income: "1,000", receivable: "1,000", grossReceived: "1,000", netReceived: "1,000", currentDue: "0" })
  ];
  const rZero = U.compare(side(pwZero), side(cwZero), { tolerance: 0 });
  check("…and a due that vanished to 0 is not excused by another paid receipt ending at 0",
    chain(rZero).length > 0, lines(rZero) || "MISSED");
}

console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
process.exit(fail ? 1 : 0);
