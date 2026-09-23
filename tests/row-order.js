/* Which way round is this table sorted, and who gets blamed when a row is out of place.
 *
 * Both places that asked used to answer with the first pair of differing dates found anywhere in
 * the list. One row sitting out of place at the top therefore set the direction for the whole
 * table, and then everything below it disagreed with that direction:
 *
 *   05/01  10/01  09/01  08/01  07/01     ← newest-first, apart from the first row
 *   → read as oldest→newest, and rows 3, 4 and 5 reported as "সারির ক্রম ভাঙা".
 *
 * Three findings for one misplaced row, and never the row that moved — and `order` is a verdict
 * code, so such a student lands on someone's work list under a heading that names the wrong rows.
 *
 * chronological() is the worse of the two, because it is not reporting anything: it puts the rows
 * in the order the due chain is read in. Backwards, and every link opens on the wrong figure, so
 * the student comes back covered in "Previous Due ভুল" lines that are all consequences of the sort.
 *
 *   node tests/row-order.js
 */
"use strict";
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "reconcile.js"), "utf8");
const g = {};
new Function("self", SRC)(g);
const U = g.UMSREC;

let fail = 0;
const check = (name, ok, extra) => {
  if (!ok) fail++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (!ok && extra !== undefined ? "   " + extra : ""));
};

function lift(name) {
  let at = SRC.indexOf("function " + name + "(");
  if (at < 0) throw new Error("no such function: " + name);
  let d = 0;
  for (let j = SRC.indexOf("{", at); j < SRC.length; j++) {
    if (SRC[j] === "{") d++;
    else if (SRC[j] === "}") { d--; if (!d) return SRC.slice(at, j + 1); }
  }
  throw new Error("unbalanced " + name);
}

const toDate = (s) => { const m = /(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(String(s || "")); return m ? new Date(+m[3], +m[2] - 1, +m[1]).getTime() : null; };
const mk = (name, deps) => new Function(...Object.keys(deps),
  lift("sortedWay") + "\n" + lift(name) + "\nreturn " + name + ";")(...Object.values(deps));

const sortOrder = mk("sortOrder", { toDate: toDate, rowKey: (r) => r.mrn, isCancel: () => false });
const chronological = mk("chronological", { toDate: toDate });

const rows = (dates) => dates.map((d, i) => ({ mrn: String.fromCharCode(65 + i), date: d }));
const blamed = (ds) => { const e = []; sortOrder(rows(ds), "Course Wise", e); return e.map((x) => x.key); };
const order = (ds, dflt) => chronological(rows(ds), dflt).map((r) => r.mrn).join("");

/* ---------- a table with nothing wrong ---------- */
check("a table in date order is not reported",
  blamed(["01/01/2025", "02/01/2025", "03/01/2025", "04/01/2025"]).length === 0,
  blamed(["01/01/2025", "02/01/2025", "03/01/2025", "04/01/2025"]).join(","));
check("…and neither is the other way round",
  blamed(["04/01/2025", "03/01/2025", "02/01/2025", "01/01/2025"]).length === 0,
  blamed(["04/01/2025", "03/01/2025", "02/01/2025", "01/01/2025"]).join(","));

/* ---------- one row out of place ---------- */
{
  /* the case that produced three findings and named none of them correctly */
  const ds = ["05/01/2025", "10/01/2025", "09/01/2025", "08/01/2025", "07/01/2025"];
  const b = blamed(ds);
  check("one misplaced row is one finding", b.length === 1, b.length + ": " + b.join(","));
  check("…against the row that actually moved", b[0] === "B", b.join(","));
}
{
  /* and the mirror: mostly oldest-first with one late row wedged in near the top */
  const ds = ["10/01/2025", "01/01/2025", "02/01/2025", "03/01/2025", "04/01/2025"];
  const b = blamed(ds);
  check("…the same the other way round", b.length === 1 && b[0] === "B", b.join(","));
}

/* ---------- the ordering used by the due chain ---------- */
check("the due chain reads a newest-first table oldest-first",
  order(["04/01/2025", "03/01/2025", "02/01/2025", "01/01/2025"], true) === "DCBA",
  order(["04/01/2025", "03/01/2025", "02/01/2025", "01/01/2025"], true));
check("…and is not turned round by one row out of place",
  order(["05/01/2025", "10/01/2025", "09/01/2025", "08/01/2025", "07/01/2025"], true) === "EDCBA",
  order(["05/01/2025", "10/01/2025", "09/01/2025", "08/01/2025", "07/01/2025"], true));

/* ---------- when there is genuinely no answer ---------- */
check("a table of one date has no order to break",
  blamed(["01/01/2025", "01/01/2025", "01/01/2025"]).length === 0,
  blamed(["01/01/2025", "01/01/2025", "01/01/2025"]).join(","));
check("…nor has a table with no dates at all",
  blamed(["-", "", "-"]).length === 0, blamed(["-", "", "-"]).join(","));
{
  /* A genuine tie: one step up, one step down, and nothing in the dates to break the deadlock.
     (Four rows alternating would NOT be a tie — up, down, up is a majority of one, which is the
     point of counting.)

     Answering "cannot say" here would drop a real finding: three rows with one step each way is
     an out-of-order table by anyone's reading. So the ledger's own convention settles it — the
     order the table was supposed to be in — and the row that breaks THAT is the one named. */
  const TIE = ["01/01/2025", "05/01/2025", "01/01/2025"];
  const e = [];
  sortOrder(rows(TIE), "Course Wise", e);
  check("a tie is settled by the ledger's own convention",
    e.length === 1 && e[0].key === "B", e.map(function (x) { return x.key; }).join(","));
  const e2 = [];
  sortOrder(rows(TIE), "Program Wise", e2);
  check("…which runs the other way on the other ledger",
    e2.length === 1 && e2[0].key === "C", e2.map(function (x) { return x.key; }).join(","));
  check("…and the due chain still falls back to the caller's default",
    order(TIE, true) === "ABC" && order(TIE, false) === "CBA",
    order(TIE, true) + " / " + order(TIE, false));
}

/* ---------- and it is really one answer, not two that can drift ---------- */
{
  const so = lift("sortOrder"), ch = lift("chronological");
  check("both callers ask the same question",
    so.indexOf("sortedWay(") >= 0 && ch.indexOf("sortedWay(") >= 0, "reconcile.js");
  check("…and neither still guesses from the first differing pair",
    so.indexOf("break outer") < 0 && ch.indexOf("break outer") < 0, "reconcile.js");
}

/* ---------- a real student still reads the same ---------- */
{
  /* the order finding must survive as a verdict — this is what puts it on the work list */
  const has = U.CATS.some(function (c) { return c.code === "order"; });
  check("\"সারির ক্রম ভাঙা\" is still a verdict a student can get", has, "CATS");
}

console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
process.exit(fail ? 1 : 0);
