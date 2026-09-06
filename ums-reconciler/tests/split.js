/* Ratio splitting may round each course line, but the parts must still add up to the whole:
 * 100 divided across courses can come back as 33+67, never as 34+67 = 101.
 *
 * So the ±2৳ forgiveness applies to a single line only — the receipt's total is exact.
 *
 *   node tests/split.js
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
const sumErr = (r) => r.errors.filter((e) => /যোগফল মিলছে না/.test(e.field));
const lineErr = (r) => r.errors.filter((e) => /Current Due-র হিসাব/.test(e.field));

/* 100 due split 1:2 → 33.33 / 66.67. Stored as 33 + 67 = 100 — each line off by a third of a
   taka, the total exact. That is ordinary rounding. */
{
  const r = U.compare(
    side([pwRow({ mrn: "1", date: "01/01/2025", income: "100", receivable: "100", currentDue: "100" })]),
    side([cwRow({ mrn: "1", date: "01/01/2025", course: "A", income: "33", receivable: "33", currentDue: "33" }),
          cwRow({ mrn: "1", date: "01/01/2025", course: "B", income: "67", receivable: "67", currentDue: "67" })]),
    { tolerance: 0 });
  check("33 + 67 = 100 → clean", r.errors.length === 0,
    r.errors.map((e) => e.field).join(" | "));
}

/* the same split stored as 34 + 67 = 101. Each line is within a taka of its share, so the per-line
   check forgives both — but a hundred became a hundred and one. */
{
  const r = U.compare(
    side([pwRow({ mrn: "2", date: "01/01/2025", income: "100", receivable: "100", currentDue: "100" })]),
    side([cwRow({ mrn: "2", date: "01/01/2025", course: "A", income: "34", receivable: "34", currentDue: "34" }),
          cwRow({ mrn: "2", date: "01/01/2025", course: "B", income: "67", receivable: "67", currentDue: "67" })]),
    { tolerance: 0 });
  check("34 + 67 = 101 → caught", r.errors.length > 0, r.errors.map((e) => e.field).join(" | "));
  check("caught as a PW↔CW column gap", r.errors.some((e) => /Receivable|Current Due মিলছে না|Previous Due/.test(e.field)),
    r.errors.map((e) => U.shortError(e)).join("\n        "));
}

/* lines that drift in opposite directions and cancel out: 1,137/3,863 stored as 1,136/3,864.
   Total 5,000 either way — forgiven per line, and the sum still ties. */
{
  const r = U.compare(
    side([pwRow({ mrn: "3", date: "01/01/2025", previousDue: "10,000", receivable: "10,000", received: "5,000", currentDue: "5,000" })]),
    side([cwRow({ mrn: "3", date: "01/01/2025", course: "A", previousDue: "2,273", receivable: "2,273", grossReceived: "1,136", netReceived: "1,136", currentDue: "1,136" }),
          cwRow({ mrn: "3", date: "01/01/2025", course: "B", previousDue: "7,727", receivable: "7,727", grossReceived: "3,864", netReceived: "3,864", currentDue: "3,864" })]),
    { tolerance: 0 });
  check("±1 that cancels out → clean", sumErr(r).length === 0 && lineErr(r).length === 0,
    r.errors.map((e) => e.field).join(" | ") || "no errors");
}

/* both lines drift the same way — 1,137/3,863 stored as 1,138/3,864. Each is within a taka, but
   the receipt now claims 5,002 where 5,000 is due. */
{
  const r = U.compare(
    side([pwRow({ mrn: "4", date: "01/01/2025", previousDue: "10,000", receivable: "10,000", received: "5,000", currentDue: "5,002" })]),
    side([cwRow({ mrn: "4", date: "01/01/2025", course: "A", previousDue: "2,273", receivable: "2,273", grossReceived: "1,136", netReceived: "1,136", currentDue: "1,138" }),
          cwRow({ mrn: "4", date: "01/01/2025", course: "B", previousDue: "7,727", receivable: "7,727", grossReceived: "3,864", netReceived: "3,864", currentDue: "3,864" })]),
    { tolerance: 0 });
  check("same-direction drift → sum check catches it", sumErr(r).length > 0,
    sumErr(r).map((e) => e.note).join(" | ") || "MISSED");
}

console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
process.exit(fail ? 1 : 0);
