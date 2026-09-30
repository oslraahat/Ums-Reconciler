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

/* ---------- and parseTable drops them, keeping the rest ---------- */
{
  const header = ["Date", "MRN", "CRN", "Income", "Receivable", "Current Due", "User", "Remarks"];
  const t = table(header, [
    ["01/01/2025", "111", "", "100", "100", "0", "rokeya@onnorokom.com", "manual"],
    ["02/01/2025", "222", "", "0", "6000", "6000", "system", "Auto inserted from scheduler"],
    ["03/01/2025", "333", "", "0", "0", "0", "liton@onnorokom.com", "auto"]
  ]);
  const out = U.parseTable(t, "pw");
  check("parseTable keeps the one human receipt", out.ok && out.rows.length === 1,
    out.ok ? "rows=" + out.rows.length : "not ok");
  check("…and it is the human one", out.rows.length === 1 && out.rows[0].mrn === "111",
    out.rows.map((r) => r.mrn).join(","));
  check("neither scheduler nor liton survives to any rule",
    out.rows.every((r) => r.mrn !== "222" && r.mrn !== "333"),
    out.rows.map((r) => r.mrn).join(","));
}

/* ---------- a chain that would break without the drop stays clean ---------- */
{
  /* Course "A": due goes 0 → (scheduler pushes a bogus 6,000) → 0. With the scheduler row present
     the chain reads 0≠6000 and 6000≠0, two errors; dropped, the two human receipts join 0→0. */
  const cw = (o) => Object.assign({ date: "", course: "A", mrn: "", crn: "", income: "0",
    deducted: "0", consideration: "0", previousDue: "0", receivable: "0", prevStd: "0", booking: "0",
    special: "0", grossReceived: "0", dueAdjustment: "0", cashBack: "0", netReceived: "0",
    currentDue: "0", user: "", remarks: "" }, o);
  const side = (rows) => ({ ok: true, rows, cols: {}, totalRow: null, noData: false });
  const human = side([
    cw({ date: "01/01/2025", mrn: "10", currentDue: "0", previousDue: "0" }),
    cw({ date: "03/01/2025", mrn: "12", currentDue: "0", previousDue: "0" })
  ]);
  const r = U.compare(side([]), human, { tolerance: 0 });
  check("the human-only chain reconciles clean", !r.errors.some((e) => /ধারাবাহিকতা/.test(e.field)),
    r.errors.map((e) => e.field).join(" | "));
}

console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
process.exit(fail ? 1 : 0);
