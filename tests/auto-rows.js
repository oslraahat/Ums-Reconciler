/* Rows the UMS scheduler writes on its own are not cashier activity, and must never reach a rule.
 *
 * Two markers say a row was machine-made: the text "Auto inserted from scheduler" (wherever the
 * column lands it), and the scheduler service account liton@onnorokom.com in the User column. A
 * receipt carrying either is dropped in parseTable() — before column arithmetic, the due chain or
 * the server-to-server diff can read it — so it cannot mint a false "Previous Due ভুল" or a broken
 * chain out of a due the cashier never entered. A row with neither marker is left exactly as it was.
 *
 *   node tests/auto-rows.js
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

/* the smallest DOM parseTable() touches: querySelectorAll("tr") → rows, each with
   querySelectorAll("th,td") → cells that answer textContent and getAttribute("colspan") */
function table(header, rows) {
  const cell = (text) => ({ textContent: text, getAttribute: () => null });
  const tr = (cells) => ({ querySelectorAll: () => cells.map(cell) });
  const trs = [tr(header)].concat(rows.map(tr));
  return { querySelectorAll: (sel) => (sel === "tr" ? trs : []) };
}

/* ---------- the predicate on its own ---------- */
check("the scheduler service account is a machine row",
  U.isAutoRow(["01/01/2025", "1", "100", "100", "liton@onnorokom.com"]) === true);
check("…in any letter case", U.isAutoRow(["LITON@ONNOROKOM.COM"]) === true);
check("the auto-insert note is a machine row",
  U.isAutoRow(["01/01/2025", "1", "", "", "Auto inserted from scheduler"]) === true);
check("…however its spacing runs", U.isAutoRow(["auto   inserted\tfrom  scheduler"]) === true);
check("a cashier's own row is left alone",
  U.isAutoRow(["01/01/2025", "1", "100", "100", "rokeya@onnorokom.com", "manual"]) === false);
check("an empty row is not a machine row", U.isAutoRow([]) === false);

/* ---------- inert vs. meaningful ---------- */
check("an inert row (due unchanged, no money) is inert",
  U.isInertRow({ previousDue: "4319", currentDue: "4319" }) === true);
check("…a discount that moves the due is NOT inert",
  U.isInertRow({ previousDue: "4319", currentDue: "3695", special: "624" }) === false);
check("…nor is a payment", U.isInertRow({ previousDue: "5000", currentDue: "0", netReceived: "5000" }) === false);
check("…nor new income", U.isInertRow({ previousDue: "0", currentDue: "5000", income: "5000" }) === false);

/* ---------- parseTable drops only INERT scheduler rows ---------- */
{
  const header = ["Date", "MRN", "CRN", "Income", "Previous Due", "Receivable", "Special Discount",
    "Net Received", "Current Due", "User", "Remarks"];
  const t = table(header, [
    ["01/01/2025", "111", "", "100", "0", "100", "", "100", "0", "rokeya@onnorokom.com", "manual"],
    ["02/01/2025", "222", "", "0", "5000", "5000", "", "", "5000", "system", "Auto inserted from scheduler"],
    ["03/01/2025", "333", "", "0", "5000", "5000", "624", "", "4376", "liton@onnorokom.com", "Auto inserted from scheduler"],
    ["04/01/2025", "444", "", "0", "4376", "4376", "", "", "4376", "liton@onnorokom.com", "Auto inserted from scheduler"]
  ]);
  const out = U.parseTable(t, "pw");
  const mrns = out.rows.map((r) => r.mrn);
  check("the human row and the meaningful scheduler row survive", out.ok && mrns.join(",") === "111,333", mrns.join(","));
  check("…the inert scheduler placeholders (222, 444) are dropped",
    mrns.indexOf("222") < 0 && mrns.indexOf("444") < 0, mrns.join(","));
}

/* ---------- a discount on a scheduler row keeps the chain intact ---------- */
{
  /* reg 1959425 UDVASH Varsity Math: the 624 Special Discount is on an "Auto inserted from scheduler"
     row (4319 → 3695); it must be KEPT, or the chain reads 4319 → 3695 and reports a 624 break. */
  const cw = (o) => Object.assign({ date: "", course: "A", mrn: "", crn: "", income: "0",
    deducted: "0", consideration: "0", previousDue: "0", receivable: "0", prevStd: "0", booking: "0",
    special: "0", grossReceived: "0", dueAdjustment: "0", cashBack: "0", netReceived: "0",
    currentDue: "0", user: "", remarks: "" }, o);
  const header = ["Date", "Course", "MRN", "CRN", "Income", "Deducted Amount", "Consideration Amount",
    "Previous Due", "Receivable", "Pre. Std. Discount", "Booking Discount", "Special Discount",
    "Gross Received", "Due Adjustment Amount", "Cash Back Amount", "Net Received", "Current Due", "User"];
  const row = (date, mrn, pd, sp, gr, nr, cd, user) =>
    [date, "A", mrn, "", "0", "", "", pd, (pd === "-" ? "0" : pd), "", "", sp, gr, "", "", nr, cd, user];
  const t = table(header, [
    row("01/01/2022", "M1", "-", "", "681", "681", "4319", "nerob@x"),             // opens, closes 4319
    row("02/02/2022", "M2", "4319", "", "", "", "4319", "liton@onnorokom.com"),   // inert scheduler carry → dropped
    row("03/03/2022", "M3", "4319", "624", "", "", "3695", "liton@onnorokom.com"),// 624 Special Discount → KEPT
    row("04/04/2022", "M4", "3695", "", "3695", "3695", "0", "nerob@x")           // pays 3695
  ]);
  // the first row's income column: set so it closes at 4319 (income 5000, net 681 → due 4319)
  const parsed = U.parseTable(t, "cw");
  parsed.rows.forEach(function (r) { if (r.mrn === "M1") { r.income = "5000"; r.receivable = "5000"; } });
  const side = (rows) => ({ ok: true, rows, cols: {}, totalRow: null, noData: false });
  const r = U.compare(side([]), side(parsed.rows), { tolerance: 0 });
  check("the 624-discount scheduler row survives", parsed.rows.some((x) => x.mrn === "M3"),
    parsed.rows.map((x) => x.mrn).join(","));
  check("…so the chain reads 4319 → 3695 via the discount, no break",
    !r.errors.some((e) => /ধারাবাহিকতা/.test(e.field)), r.errors.map((e) => e.field).join(" | "));
}

console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
process.exit(fail ? 1 : 0);
