/* What the two-server check must NOT say.
 *
 * Every false alarm reported against this tool came from one place: compareServers() shouting about
 * something the single-server engine — built and measured on 1,082 real students — treats as
 * nothing. A renumbered Sl. column. A nickname repeated on every row. A row with no money on it.
 * Each was found by a person reading a run, one at a time.
 *
 * So this goes the other way round: take two servers holding the same student and change only
 * things that are known not to be faults. Anything reported here is the next one of those bugs.
 *
 * The exception is Branch, and it is deliberate. Within one server a program's courses may run at
 * different branches — the single-server engine says so and ignores it. Between two servers the
 * same course's branch changing is a real difference, so it is reported, in the mildest kind there
 * is. If that ever becomes noise on a real migration it is a decision to take, not a bug to fix.
 *
 *   node tests/srv-quiet.js
 */
"use strict";
const fs = require("fs");
const path = require("path");

const g = {};
new Function("self", fs.readFileSync(path.join(__dirname, "..", "reconcile.js"), "utf8"))(g);
const U = g.UMSREC;

let fail = 0;
const check = (name, ok, extra) => {
  if (!ok) fail++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (!ok && extra !== undefined ? "   " + extra : ""));
};

/* a Course Wise table with every column UMS prints, so nothing is left out of the comparison */
const CW = ["Sl.", "Registration No.", "Nick Name", "Date", "Course", "Branch", "Campus", "MRN", "CRN",
  "Income", "Consideration Amount", "Previous Due", "Deducted Amount", "Receivable",
  "Pre. Std. Discount", "Booking Discount", "Special Discount", "Gross Received",
  "Due Adjustment Amount", "Cash Back Amount", "Net Received", "Current Due", "Payment Method",
  "Remarks", "User"];
const row = (o) => {
  o = o || {};
  const c = { "Sl.": o.sl || "1", "Registration No.": "1633497", "Nick Name": "Adiba Alam",
    Date: o.date || "15/06/2026", Course: o.course || "Engineering", Branch: o.branch || "Dhaka",
    Campus: o.campus || "Main", MRN: o.mrn || "2320012622", CRN: o.crn || "-",
    Income: "5,000", "Consideration Amount": "-", "Previous Due": "-", "Deducted Amount": "-",
    Receivable: "5,000", "Pre. Std. Discount": "-", "Booking Discount": "-",
    "Special Discount": "-", "Gross Received": o.gross || "5,000", "Due Adjustment Amount": "-",
    "Cash Back Amount": "-", "Net Received": o.net || "5,000", "Current Due": "-",
    "Payment Method": "Cash", Remarks: "-", User: "rahman.4039@udvash.net" };
  return CW.map((h) => c[h]);
};
const td = (v) => ({ textContent: v, getAttribute: () => null });
const mk = (rows, head) => U.parseTable({
  querySelectorAll: (s) => (s === "tr" ? [{ querySelectorAll: () => (head || CW).map(td) }]
    .concat(rows.map((r) => ({ querySelectorAll: () => r.map(td) }))) : []),
  querySelector: () => null
}, "cw");
const none = { ok: true, rows: [], header: [], cols: {}, totalRow: null, noData: true };
const edit = (r, i, v) => { const c = r.slice(); c[i] = v; return c; };
const col = (name) => CW.indexOf(name);

const A = row({ sl: "1", mrn: "2320012622", course: "Engineering" });
const B = row({ sl: "2", mrn: "2320012623", course: "Physics" });
const C = row({ sl: "3", mrn: "2320012624", course: "Chemistry" });

function run(expRows, actRows, actHead) {
  return U.compareServers({ pw: none, cw: mk(expRows) },
    { pw: none, cw: mk(actRows, actHead) }, { tolerance: 0 });
}
function quiet(name, expRows, actRows, actHead) {
  const r = run(expRows, actRows, actHead);
  check(name, r.errors.length === 0,
    r.errors.length + " reported — " + (r.errors[0] ? U.shortError(r.errors[0]).slice(0, 90) : ""));
}

/* ---------- the same student, told differently ---------- */
quiet("two servers holding the same rows say nothing", [A, B, C], [A, B, C]);
/* the rows are keyed by receipt, so the order the page prints them in cannot matter */
quiet("…nor when the rows come in a different order", [A, B, C], [C, A, B]);
/* and reordering renumbers the serial column, which is the position in the list, not a figure */
quiet("…nor when that renumbers the Sl. column", [A, B, C],
  [row({ sl: "1", mrn: "2320012624", course: "Chemistry" }),
   row({ sl: "2", mrn: "2320012622", course: "Engineering" }),
   row({ sl: "3", mrn: "2320012623", course: "Physics" })]);

/* ---------- the same values, written differently ---------- */
quiet("1,000 and 1000 and 1000.00 are one amount",
  [row({ gross: "5,000", net: "5,000" })], [row({ gross: "5000", net: "5000.00" })]);
quiet("…a dash and a blank are both nothing",
  [row()], [edit(row(), col("Deducted Amount"), "")]);
quiet("…and a cell is not its whitespace",
  [row()], [edit(row(), col("Course"), "  Engineering  ")]);
quiet("…including whitespace inside it",
  [row({ course: "Employee  Training Course" })], [row({ course: "Employee Training Course" })]);

/* ---------- the same table, laid out differently ---------- */
quiet("the columns may be in any order",
  [A], [(function () { const r = row(); return r.slice(0, 7).concat(r.slice(9), r.slice(7, 9)); })()],
  CW.slice(0, 7).concat(CW.slice(9), CW.slice(7, 9)));
/* parseTable lifts the footer out of the rows; if it ever stopped, this would be a phantom row */
quiet("a Total Summary row is not a row", [A, B],
  [A, B, ["Total Summary"].concat(new Array(CW.length - 1).fill("10,000"))]);

/* ---------- and the things that must still be said ---------- */
{
  const money = run([A, B], [A, edit(B, col("Net Received"), "4,000")]);
  check("a changed amount is still caught", money.errors.some((e) => e.kind === "srvcell"),
    money.errors.map((e) => e.kind).join(","));
  const lost = run([A, B], [A]);
  check("a row that did not cross is still caught", lost.errors.some((e) => e.kind === "srvlost"),
    lost.errors.map((e) => e.kind).join(","));

  /* Deliberate, and the one thing this file reports: within one server a program's courses may run
     at different branches, and the single-server engine ignores that. Between two servers the same
     course changing branch is a difference — reported, in the mildest kind there is. */
  const branch = run([row({ branch: "Dhaka" })], [row({ branch: "Chittagong" })]);
  check("a branch that changed between servers is reported",
    branch.errors.length === 1 && branch.errors[0].kind === "srvtext",
    branch.errors.map((e) => e.kind).join(","));
  check("…as the mildest verdict there is, not as money",
    U.classifyServers(branch).code === "srvtext", U.classifyServers(branch).code);
}

console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
process.exit(fail ? 1 : 0);
