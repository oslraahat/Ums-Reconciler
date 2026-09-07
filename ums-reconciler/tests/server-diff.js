/* Expected ↔ Actual — the two-server (migration) check.
 *
 * compare() asks whether one server's two pages agree; compareServers() asks whether two servers
 * hold the same student. Different question, different failure modes, so it gets its own guards:
 * a row that never crossed, a row that appeared, a cell that changed, a column that vanished —
 * and, just as importantly, the things that must NOT be reported: "1,000" against "1000", "-"
 * against "", a reordered column list.
 *
 *   node tests/server-diff.js
 */
"use strict";
const fs = require("fs");
const path = require("path");

const g = {};
new Function("self", fs.readFileSync(path.join(__dirname, "..", "reconcile.js"), "utf8"))(g);
const U = g.UMSREC;

function td(text, colspan) {
  return {
    textContent: text,
    getAttribute: (a) => (a === "colspan" && colspan ? String(colspan) : null)
  };
}
function tr(cells) { return { querySelectorAll: () => cells }; }
function table(rows) {
  return {
    querySelectorAll: (sel) => (sel === "tr" ? rows : []),
    querySelector: () => null
  };
}

const PW_HEAD = ["SL", "Date", "MRN", "CRN", "Income", "Consideration Amount", "Previous Due",
  "Deducted Amount", "Receivable", "Prev. Std. Discount", "Booking Discount", "Special Discount",
  "Received", "Cash Back", "Current Due", "Payment Method", "Remarks", "User"];
const CW_HEAD = ["Registration No.", "Date", "Course", "Branch", "MRN", "CRN", "Income",
  "Deducted Amount", "Consideration Amount", "Previous Due", "Receivable", "Pre. Std. Discount",
  "Booking Discount", "Special Discount", "Gross Received", "Due Adjustment Amount",
  "Cash Back Amount", "Net Received", "Current Due"];

const PW_R1 = ["1", "01/01/2025", "111", "-", "17,000", "-", "-", "-", "17,000", "-", "-", "-",
  "10,000", "-", "7,000", "Cash", "-", "admin"];
const PW_R2 = ["2", "05/01/2025", "222", "-", "-", "-", "7,000", "-", "7,000", "-", "-", "-",
  "7,000", "-", "-", "Cash", "-", "admin"];
const CW_R1 = ["2070163", "05/01/2025", "Physics", "Dhaka", "222", "-", "-", "-", "-", "7,000",
  "7,000", "-", "-", "-", "7,000", "-", "-", "7,000", "-"];
const CW_R2 = ["2070163", "01/01/2025", "Physics", "Dhaka", "111", "-", "17,000", "-", "-", "-",
  "17,000", "-", "-", "-", "10,000", "-", "-", "10,000", "7,000"];

const mkPw = (rows) => U.parseTable(table([tr(PW_HEAD.map((h) => td(h)))].concat(
  rows.map((r) => tr(r.map((v) => td(v)))))), "pw");
const mkCw = (rows) => U.parseTable(table([tr(CW_HEAD.map((h) => td(h)))].concat(
  rows.map((r) => tr(r.map((v) => td(v)))))), "cw");

const side = () => ({ pw: mkPw([PW_R1, PW_R2]), cw: mkCw([CW_R1, CW_R2]) });
const edit = (row, i, v) => { const c = row.slice(); c[i] = v; return c; };

let fail = 0;
const check = (name, ok, extra) => {
  if (!ok) fail++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (extra ? "   " + extra : ""));
};
const kinds = (r) => r.errors.map((e) => e.kind);

/* ---- identical servers ---- */
const same = U.compareServers(side(), side(), { tolerance: 0 });
check("identical servers → no findings", same.errors.length === 0,
  "errors=" + same.errors.length + (same.errors[0] ? " · " + same.errors[0].note : ""));
check("clean summary says so", /হুবহু এক/.test(U.summaryServers(same)), U.summaryServers(same));
check("no category when clean", U.classifyServers(same) === null);

/* ---- formatting is not a difference ---- */
const fmtAct = { pw: mkPw([edit(edit(PW_R1, 4, "17000"), 14, "7000.00"), PW_R2]), cw: mkCw([CW_R1, CW_R2]) };
check("'17,000' ↔ '17000' is not a difference",
  U.compareServers(side(), fmtAct, { tolerance: 0 }).errors.length === 0);
const dashAct = { pw: mkPw([edit(PW_R1, 5, ""), PW_R2]), cw: mkCw([CW_R1, CW_R2]) };
check("'-' ↔ '' is not a difference",
  U.compareServers(side(), dashAct, { tolerance: 0 }).errors.length === 0);

/* ---- a changed amount ---- */
const cellAct = { pw: mkPw([edit(PW_R1, 12, "9,000"), PW_R2]), cw: mkCw([CW_R1, CW_R2]) };
const rCell = U.compareServers(side(), cellAct, { tolerance: 0 });
check("changed Received caught", kinds(rCell).indexOf("srvcell") >= 0, kinds(rCell).join(","));
const cellErr = rCell.errors.filter((e) => e.kind === "srvcell")[0];
check("delta is Actual − Expected", cellErr.delta === -1000, "delta=" + cellErr.delta);
check("both values named", /Expected 10,000/.test(cellErr.note) && /Actual 9,000/.test(cellErr.note), cellErr.note);
check("category = srvcell", U.classifyServers(rCell).code === "srvcell");
check("finding names the two servers",
  /\[Expected ↔ Actual · Program Wise\]/.test(U.shortError(cellErr)), U.shortError(cellErr));

/* ---- a text column that changed ---- */
const txtAct = { pw: mkPw([edit(PW_R1, 15, "Bank"), PW_R2]), cw: mkCw([CW_R1, CW_R2]) };
const rTxt = U.compareServers(side(), txtAct, { tolerance: 0 });
check("changed Payment Method caught (all columns, not just money)",
  kinds(rTxt).indexOf("srvtext") >= 0, kinds(rTxt).join(","));
check("text diff carries no delta", rTxt.errors[0].delta === 0);

/* ---- a row that never crossed, and one that appeared ---- */
const lostAct = { pw: mkPw([PW_R1]), cw: mkCw([CW_R1, CW_R2]) };
const rLost = U.compareServers(side(), lostAct, { tolerance: 0 });
check("row missing on Actual caught", kinds(rLost).indexOf("srvlost") >= 0, kinds(rLost).join(","));
check("missing row says what it was worth",
  /টাকার/.test(rLost.errors.filter((e) => e.kind === "srvlost")[0].note),
  rLost.errors.filter((e) => e.kind === "srvlost")[0].note);
check("missing row outranks a changed cell in the verdict",
  U.classifyServers(U.compareServers(side(), { pw: mkPw([edit(PW_R1, 12, "9,000")]), cw: mkCw([CW_R1, CW_R2]) },
    { tolerance: 0 })).code === "srvlost");

const PW_R3 = ["3", "09/01/2025", "333", "-", "500", "-", "-", "-", "500", "-", "-", "-", "500",
  "-", "-", "Cash", "-", "admin"];
const extraAct = { pw: mkPw([PW_R1, PW_R2, PW_R3]), cw: mkCw([CW_R1, CW_R2]) };
const rExtra = U.compareServers(side(), extraAct, { tolerance: 0 });
check("extra row on Actual caught", kinds(rExtra).indexOf("srvextra") >= 0, kinds(rExtra).join(","));
check("extra is not reported as lost", kinds(rExtra).indexOf("srvlost") < 0);

/* ---- Course Wise is keyed by receipt AND course ---- */
const CW_R2B = edit(CW_R2, 2, "Chemistry");
const courseAct = { pw: mkPw([PW_R1, PW_R2]), cw: mkCw([CW_R1, CW_R2B]) };
const rCourse = U.compareServers(side(), courseAct, { tolerance: 0 });
check("a course renamed on the same receipt is caught",
  rCourse.errors.length > 0, kinds(rCourse).join(","));

/* money moved between two courses of one receipt keeps the receipt total intact — keying on the
   receipt alone would compare sums and see nothing */
const CW_A = ["2070163", "01/01/2025", "Physics", "Dhaka", "111", "-", "10,000", "-", "-", "-",
  "10,000", "-", "-", "-", "6,000", "-", "-", "6,000", "4,000"];
const CW_B = ["2070163", "01/01/2025", "Chemistry", "Dhaka", "111", "-", "7,000", "-", "-", "-",
  "7,000", "-", "-", "-", "4,000", "-", "-", "4,000", "3,000"];
const expMoved = { pw: mkPw([PW_R1]), cw: mkCw([CW_A, CW_B]) };
const actMoved = { pw: mkPw([PW_R1]), cw: mkCw([edit(CW_A, 14, "5,000"), edit(CW_B, 14, "5,000")]) };
const rMoved = U.compareServers(expMoved, actMoved, { tolerance: 0 });
check("money moved between courses of one receipt is caught (receipt total unchanged)",
  rMoved.errors.filter((e) => e.kind === "srvcell").length === 2, kinds(rMoved).join(","));

/* ---- column set differences ---- */
const SHORT_HEAD = PW_HEAD.slice(0, 15);            // Payment Method / Remarks / User dropped
const colAct = {
  pw: U.parseTable(table([tr(SHORT_HEAD.map((h) => td(h))),
    tr(PW_R1.slice(0, 15).map((v) => td(v))), tr(PW_R2.slice(0, 15).map((v) => td(v)))]), "pw"),
  cw: mkCw([CW_R1, CW_R2])
};
const rCol = U.compareServers(side(), colAct, { tolerance: 0 });
check("a dropped column is caught", kinds(rCol).indexOf("srvcol") >= 0, kinds(rCol).join(","));
check("a dropped column is reported ONCE, not once per row",
  rCol.errors.filter((e) => e.kind === "srvcol").length === 1);
check("dropped columns are named",
  /Payment Method/.test(rCol.errors.filter((e) => e.kind === "srvcol")[0].note),
  rCol.errors.filter((e) => e.kind === "srvcol")[0].note);

/* reordering must not read as a difference — columns are matched by name, not position */
const ORD = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 12, 14, 15, 16, 17];   // Cash Back ↔ Received
const pick = (row) => ORD.map((i) => row[i]);
const swapAct = {
  pw: U.parseTable(table([tr(pick(PW_HEAD).map((h) => td(h))),
    tr(pick(PW_R1).map((v) => td(v))), tr(pick(PW_R2).map((v) => td(v)))]), "pw"),
  cw: mkCw([CW_R1, CW_R2])
};
check("reordered columns are not a difference",
  U.compareServers(side(), swapAct, { tolerance: 0 }).errors.length === 0,
  kinds(U.compareServers(side(), swapAct, { tolerance: 0 })).join(","));

/* ---- the serial number is the row's position, not a figure on the receipt ----
   reg 1956107 MRN 2220262250 came back as "একই ঘরে দুই সার্ভারে দুই অঙ্ক · Sl. Expected 4, Actual 5",
   the most serious category in the report, on a row that matched to the taka. One extra row near
   the top of one server renumbers every row below it, so a single real difference arrived as a
   finding on every row after it — and the row that actually differs is already reported, as the
   missing or extra one. */
{
  const SL_HEAD = ["Sl."].concat(PW_HEAD.slice(1));
  const withSl = (n, row) => [String(n)].concat(row.slice(1));
  const mkSl = (rows) => U.parseTable(table([tr(SL_HEAD.map((h) => td(h)))].concat(
    rows.map((r) => tr(r.map((v) => td(v)))))), "pw");

  const shifted = U.compareServers(
    { pw: mkSl([withSl(4, PW_R1), withSl(5, PW_R2)]), cw: mkCw([CW_R1, CW_R2]) },
    { pw: mkSl([withSl(5, PW_R1), withSl(6, PW_R2)]), cw: mkCw([CW_R1, CW_R2]) },
    { tolerance: 0 });
  check("a shifted serial number is not a difference", shifted.errors.length === 0,
    shifted.errors.map((e) => U.shortError(e)).join(" / "));
  check("…so the student does not get a category at all", U.classifyServers(shifted) === null);
  /* not silence either — the numbering did move, and one line says so */
  check("…but it is still mentioned, once, as a note",
    shifted.notes.length === 1 && /ক্রমিক নম্বর/.test(shifted.notes[0].detail),
    JSON.stringify(shifted.notes));
  check("…naming the column and how many rows", /Sl\./.test(shifted.notes[0].detail) &&
    /2 টি/.test(shifted.notes[0].detail), shifted.notes[0].detail);

  /* and it must not deafen the real check: money on the same row still differs */
  const both = U.compareServers(
    { pw: mkSl([withSl(4, PW_R1)]), cw: mkCw([CW_R1, CW_R2]) },
    { pw: mkSl([withSl(5, edit(PW_R1, 12, "9,000"))]), cw: mkCw([CW_R1, CW_R2]) },
    { tolerance: 0 });
  check("…while a real amount on a renumbered row is still caught",
    both.errors.filter((e) => e.kind === "srvcell").length === 1,
    both.errors.map((e) => e.field).join(","));
  check("…and the Sl. is not among the findings",
    !both.errors.some((e) => /Sl\./.test(e.field)), both.errors.map((e) => e.field).join(","));
}

/* ---- the course is named once ----
   shortError() prefixes e.course, and on Course Wise the key already ends with the course, because
   a receipt holds several and the key has to tell them apart. The line read
   "UDVASH Varsity Math · MRN 2220262250 · UDVASH Varsity Math · 01/01/2022". */
{
  const cwAct = { pw: mkPw([PW_R1, PW_R2]), cw: mkCw([CW_R1, edit(CW_R2, 14, "9,000")]) };
  const r = U.compareServers(side(), cwAct, { tolerance: 0 });
  const cell = r.errors.filter((e) => e.kind === "srvcell")[0];
  const line = U.shortError(cell);
  const times = line.split("Physics").length - 1;
  check("the course appears once in the line, not twice", times === 1, times + "× — " + line);
  check("…and it is still there at all", times >= 1, line);
}

/* ---- a student's own details are one fact, not one per row ----
   reg 1956423: Nick Name "Adiba Alam" against "Adiba", repeated on every course row because UMS
   prints the student's details on each of them. Four rows, four identical lines. And the quiet
   half: Registration No. and Roll are digits, so they went down the money path and a changed roll
   number was filed under "একই ঘরে দুই সার্ভারে দুই অঙ্ক — সবচেয়ে গুরুতর", which is what money
   going missing is called. */
{
  const PROF = ["Registration No.", "Nick Name", "Date", "Course", "MRN", "CRN", "Income",
    "Deducted Amount", "Consideration Amount", "Previous Due", "Receivable", "Pre. Std. Discount",
    "Booking Discount", "Special Discount", "Gross Received", "Due Adjustment Amount",
    "Cash Back Amount", "Net Received", "Current Due"];
  const pRow = (reg, nick, mrn, course, gross) => [reg, nick, "12/01/2022", course, mrn, "-",
    "5,000", "-", "-", "-", "5,000", "-", "-", "-", gross || "5,000", "-", "-", gross || "5,000", "-"];
  const mkP = (rows) => U.parseTable(table([tr(PROF.map((h) => td(h)))].concat(
    rows.map((r) => tr(r.map((v) => td(v)))))), "cw");
  const four = (nick, reg, gross) => [
    pRow(reg || "1956423", nick, "1418021511", "Class 8 Full Course", gross),
    pRow(reg || "1956423", nick, "1418021512", "Physics"),
    pRow(reg || "1956423", nick, "1418021513", "Chemistry"),
    pRow(reg || "1956423", nick, "1418021514", "Biology")];
  const empty = { ok: true, rows: [], header: [], cols: {}, totalRow: null, noData: true };

  const nick = U.compareServers({ pw: empty, cw: mkP(four("Adiba Alam")) },
    { pw: empty, cw: mkP(four("Adiba")) }, { tolerance: 0 });
  check("a changed nickname is reported once, not once per row",
    nick.errors.length === 1, nick.errors.length + ": " + nick.errors.map((e) => e.field).join(","));
  check("…saying how many rows carry it", /4 টি সারিতেই একই/.test(nick.errors[0].note), nick.errors[0].note);
  check("…and both values", /Adiba Alam/.test(nick.errors[0].note) && /«Adiba»/.test(nick.errors[0].note),
    nick.errors[0].note);
  /* the receipt key is meaningless here — every receipt carries the same value */
  check("…keyed to the student, not to a receipt", nick.errors[0].key === "ছাত্রের তথ্য", nick.errors[0].key);

  /* digits that are not an amount */
  const reg = U.compareServers({ pw: empty, cw: mkP(four("Adiba", "1956423")) },
    { pw: empty, cw: mkP(four("Adiba", "1956999")) }, { tolerance: 0 });
  check("a changed Registration No. is not filed as a money difference",
    reg.errors.length === 1 && reg.errors[0].kind === "srvtext",
    reg.errors.map((e) => e.kind).join(","));
  check("…so the verdict is the mildest one, not the most serious",
    U.classifyServers(reg).code === "srvtext", U.classifyServers(reg).code);
  check("…and it carries no delta, because there is no amount", reg.errors[0].delta === 0);

  /* and none of this may quieten the real check */
  const both = U.compareServers({ pw: empty, cw: mkP(four("Adiba Alam")) },
    { pw: empty, cw: mkP(four("Adiba", null, "4,000")) }, { tolerance: 0 });
  check("…while real money on one row is still caught, per receipt",
    both.errors.filter((e) => e.kind === "srvcell").length === 2,
    both.errors.map((e) => e.kind).join(","));
  check("…naming that receipt, since only it differs",
    both.errors.filter((e) => e.kind === "srvcell")
      .every((e) => /1418021511/.test(e.key)), "");
  check("…and the money verdict outranks the changed name",
    U.classifyServers(both).code === "srvcell", U.classifyServers(both).code);

  /* one row is nothing to collapse, and naming the receipt is more use than a count of one */
  const one = U.compareServers(
    { pw: empty, cw: mkP([pRow("1956423", "Adiba Alam", "1418021511", "Class 8 Full Course")]) },
    { pw: empty, cw: mkP([pRow("1956423", "Adiba", "1418021511", "Class 8 Full Course")]) },
    { tolerance: 0 });
  check("a single-row table is not collapsed — the receipt is still named",
    one.errors.length === 1 && /1418021511/.test(one.errors[0].key), one.errors[0].key);
}

/* ---- one side never read is not "the data differs" ---- */
const rSide = U.compareServers(side(), { pw: { ok: false }, cw: mkCw([CW_R1, CW_R2]) }, { tolerance: 0 });
check("unreadable page → srvside, not a mismatch", kinds(rSide).indexOf("srvside") >= 0, kinds(rSide).join(","));
check("unreadable page reports no per-cell findings", kinds(rSide).indexOf("srvcell") < 0);
check("srvside outranks everything in the verdict", U.classifyServers(rSide).code === "srvside");

/* ---- the raw dump carries all four tables ---- */
const raw = U.rawTextServers(side(), side(), { reg: "1659665", spid: "1977523" });
check("raw dump has both servers and both pages",
  /EXPECTED/.test(raw) && /ACTUAL/.test(raw) &&
  raw.split("## Program Wise").length === 3 && raw.split("## Course Wise").length === 3);

console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
process.exit(fail ? 1 : 0);
