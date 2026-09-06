/* Program Wise holds one row per receipt — the courses added up. Course Wise holds one row per
 * course of that same receipt. So the two ledgers owe each other agreement about *amounts*.
 *
 * A receipt whose every column is blank carries no amount, so its absence from the other side
 * costs nothing and must not be reported as a mismatch. The moment any column is non-zero the
 * receipt does have money in it, and a missing side is a real fault again.
 *
 *   node tests/one-sided.js
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
const oneSided = (r) => r.errors.filter((e) => e.field === "Transaction");
const lines = (r) => r.errors.map((e) => U.shortError(e)).join("\n        ");

/* a paid receipt, split across two courses — the ordinary shape, nothing to report */
const paidPw = pwRow({ mrn: "P", date: "06/02/2022", income: "22,000", receivable: "22,000",
  prevStd: "1,000", special: "21,000" });
const paidCw = [
  cwRow({ mrn: "P", date: "06/02/2022", course: "Math", income: "5,000", receivable: "5,000", special: "5,000" }),
  cwRow({ mrn: "P", date: "06/02/2022", course: "Medical", income: "17,000", receivable: "17,000",
    prevStd: "1,000", special: "16,000" })
];

/* ---- 1. real: reg 1517656 — an all-blank Cancellation in PW that CW never got ---- */
{
  const r = U.compare(
    side([paidPw, pwRow({ crn: "9643210963", date: "16/08/2022" })]),
    side(paidCw), { tolerance: 0 });
  check("all-zero cancellation missing from CW → forgiven", r.errors.length === 0, lines(r));
  check("…and said so in the notes",
    (r.notes || []).some((n) => /সব ঘর ০/.test(n.detail || "")),
    (r.notes || []).map((n) => n.detail).join(" | "));
}

/* ---- 2. the same but the other way round ---- */
{
  const r = U.compare(
    side([paidPw]),
    side(paidCw.concat([cwRow({ crn: "9643210963", date: "16/08/2022", course: "Math" })])),
    { tolerance: 0 });
  check("all-zero row only in CW → forgiven", r.errors.length === 0, lines(r));
}

/* ---- 3. money on the row → still a fault, both directions ---- */
{
  const r = U.compare(
    side([paidPw, pwRow({ crn: "C9", date: "16/08/2022", receivable: "4,200", currentDue: "4,200" })]),
    side(paidCw), { tolerance: 0 });
  check("receipt with money missing from CW → caught", oneSided(r).length === 1, lines(r) || "MISSED");
}
{
  const r = U.compare(
    side([paidPw]),
    side(paidCw.concat([cwRow({ crn: "C9", date: "16/08/2022", course: "Math",
      receivable: "4,200", currentDue: "4,200" })])),
    { tolerance: 0 });
  check("receipt with money missing from PW → caught", oneSided(r).length === 1, lines(r) || "MISSED");
}

/* ---- 4. even ৳1 counts as money ---- */
{
  const r = U.compare(
    side([paidPw, pwRow({ crn: "C1", date: "16/08/2022", receivable: "1", currentDue: "1" })]),
    side(paidCw), { tolerance: 0 });
  check("৳1 receipt missing from CW → caught", oneSided(r).length === 1, lines(r) || "MISSED");
}

/* ---- 5. and a column the sum keys do not cover (Gross Received) still counts ---- */
{
  const r = U.compare(
    side([paidPw]),
    side(paidCw.concat([cwRow({ crn: "C2", date: "16/08/2022", course: "Math", grossReceived: "500" })])),
    { tolerance: 0 });
  check("Gross Received alone counts as money", oneSided(r).length === 1, lines(r) || "MISSED");
}

/* ---- 6. PW one row ⇄ CW many rows for the same receipt — the normal mapping ---- */
{
  const r = U.compare(side([paidPw]), side(paidCw), { tolerance: 0 });
  check("1 PW row ⇄ 2 CW course rows → clean", r.errors.length === 0, lines(r));
}

console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
process.exit(fail ? 1 : 0);
