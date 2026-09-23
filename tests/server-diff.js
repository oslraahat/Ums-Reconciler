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

/* every comparison this file runs, kept for the invariant checked further down */
const ALL_RESULTS = [];
{
  const real = U.compareServers;
  U.compareServers = function () {
    const out = real.apply(U, arguments);
    ALL_RESULTS.push(out);
    return out;
  };
}

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

/* ---- a row that carried no money is not money going missing ----
   reg 2000000: four cancellation rows on Expected that Actual does not have, every figure on them
   zero, reported as "ডেটা হারিয়েছে — মাইগ্রেশনে সারিটা যায়নি" — the second most serious verdict a
   run can reach. Nothing was lost; there was nothing on those rows to lose.

   The single-server engine has had a rule for this shape all along ("সব ঘর ০ — …, তবে টাকার হিসাবে
   কিছু বদলায় না"). Its reasoning does not carry over — Program Wise and Course Wise owe each other
   only the AMOUNTS, while two servers should hold the same ROWS — so the row is still reported. It
   just stops being called money. */
{
  const ZERO_HEAD = ["Date", "Course", "MRN", "CRN", "Income", "Consideration Amount", "Previous Due",
    "Deducted Amount", "Receivable", "Pre. Std. Discount", "Booking Discount", "Special Discount",
    "Gross Received", "Due Adjustment Amount", "Cash Back Amount", "Net Received", "Current Due"];
  const zRow = (crn, course) => ["07/11/2024", course, "-", crn].concat(new Array(13).fill("-"));
  const pRow = (mrn, course, amt) => ["07/11/2024", course, mrn, "-", amt || "5,000", "-", "-", "-",
    amt || "5,000", "-", "-", "-", amt || "5,000", "-", "-", amt || "5,000", "-"];
  const mkZ = (rows) => U.parseTable(table([tr(ZERO_HEAD.map((h) => td(h)))].concat(
    rows.map((r) => tr(r.map((v) => td(v)))))), "cw");
  const none = { ok: true, rows: [], header: [], cols: {}, totalRow: null, noData: true };
  const EXP = [zRow("9643263624", "Employee Training Course"), zRow("9643263625", "Employee Training B"),
    pRow("2220262250", "Engineering")];

  /* the reported case: only the two moneyless rows are absent */
  const quiet = U.compareServers({ pw: none, cw: mkZ(EXP) },
    { pw: none, cw: mkZ([pRow("2220262250", "Engineering")]) }, { tolerance: 0 });
  check("a moneyless row that did not cross is still reported",
    quiet.errors.length === 2, quiet.errors.length + " findings");
  check("…but not as money going missing",
    quiet.errors.every((e) => e.kind === "srvempty"), kinds(quiet).join(","));
  check("…and the line says the money did not change",
    /কোনো টাকা নেই/.test(U.shortError(quiet.errors[0])), U.shortError(quiet.errors[0]));
  check("…under a category that says the same",
    U.classifyServers(quiet).code === "srvempty", U.classifyServers(quiet).code);

  /* the rule must not swallow the finding it exists beside */
  const real = U.compareServers({ pw: none, cw: mkZ(EXP) },
    { pw: none, cw: mkZ([zRow("9643263624", "Employee Training Course")]) }, { tolerance: 0 });
  check("a row that DID carry money is still money going missing",
    real.errors.some((e) => e.kind === "srvlost"), kinds(real).join(","));
  check("…and that is what the student is filed under",
    U.classifyServers(real).code === "srvlost", U.classifyServers(real).code);

  /* and a real amount outranks it, because that is the thing someone has to go and fix */
  const both = U.compareServers({ pw: none, cw: mkZ(EXP) },
    { pw: none, cw: mkZ([pRow("2220262250", "Engineering", "4,000")]) }, { tolerance: 0 });
  check("a changed amount outranks a moneyless missing row",
    U.classifyServers(both).code === "srvcell", U.classifyServers(both).code);

  /* one non-zero column anywhere on the row and it is money again — the single-server engine draws
     the line the same way, and the two must not disagree about what "no money" means */
  const oneCol = zRow("9643263624", "Employee Training Course").slice();
  oneCol[6] = "1,500";                       // Previous Due alone
  const carried = U.compareServers({ pw: none, cw: mkZ([oneCol]) }, { pw: none, cw: mkZ([]) }, { tolerance: 0 });
  check("one non-zero column anywhere makes it money again",
    carried.errors[0].kind === "srvlost", carried.errors[0].kind);

  /* an extra row on Actual gets the same treatment from the other side */
  const extra = U.compareServers({ pw: none, cw: mkZ([]) },
    { pw: none, cw: mkZ([zRow("9643263624", "Employee Training Course")]) }, { tolerance: 0 });
  check("an extra row with no money is judged the same way",
    extra.errors[0].kind === "srvempty", extra.errors[0].kind);
  check("…and its line says which side it appeared on",
    /Actual-এ বাড়তি/.test(U.shortError(extra.errors[0])), U.shortError(extra.errors[0]));
}

/* ---- the headline explains the verdict ----
   reg 1628880 was filed under "Actual-এ সারি নেই — ডেটা হারিয়েছে" and then opened with
   "মূল: User আলাদা … rahman.4039@ / abdurrahman.4039@" — a username, from the other page. The
   headline was errors[0], which is whichever page was read first, and it had nothing to do with
   the verdict above it. */
{
  const PWH = ["Date", "MRN", "CRN", "Income", "Consideration Amount", "Previous Due",
    "Deducted Amount", "Receivable", "Prev. Std. Discount", "Booking Discount", "Special Discount",
    "Received", "Cash Back", "Current Due", "User"];
  const pRow = (mrn, user) => ["19/05/2022", mrn, "-", "5,000", "-", "-", "-", "5,000", "-", "-",
    "-", "5,000", "-", "-", user];
  const mkP = (rows) => U.parseTable(table([tr(PWH.map((h) => td(h)))].concat(
    rows.map((r) => tr(r.map((v) => td(v)))))), "pw");
  const cRow = (mrn, course) => ["2070163", "19/05/2022", course, "Dhaka", mrn, "-", "5,000", "-",
    "-", "-", "5,000", "-", "-", "-", "5,000", "-", "-", "5,000", "-"];

  /* Program Wise differs only by a username; Course Wise is missing a row. Program Wise is read
     first, so the username lands at errors[0] while the verdict comes from the missing row. */
  const exp = { pw: mkP([pRow("2320012622", "rahman.4039@udvash.net")]),
    cw: mkCw([cRow("2320012622", "Engineering"), cRow("2320012700", "Physics")]) };
  const act = { pw: mkP([pRow("2320012622", "abdurrahman.4039@udvash.net")]),
    cw: mkCw([cRow("2320012622", "Engineering")]) };
  const r = U.compareServers(exp, act, { tolerance: 0 });

  check("the verdict is the missing row, not the username",
    U.classifyServers(r).code === "srvlost", U.classifyServers(r).code);
  check("…and the headline is about that same finding",
    r.errors.filter((e) => e.primary)[0].kind === "srvlost",
    r.errors.filter((e) => e.primary)[0].kind);
  check("…so the line does not open with the username",
    !/User আলাদা/.test(U.summaryServers(r)), U.summaryServers(r).slice(0, 80));
  check("…even though the username is still reported",
    r.errors.some((e) => e.kind === "srvtext"), kinds(r).join(","));

  /* The invariant, over every comparison this file has run: the headline is always of the kind
     the student was filed under, whatever order the findings arrived in. compareServers is wrapped
     at the top of the file so each result is collected as it is made — naming them here instead
     would reach into blocks they are scoped to. */
  const cases = ALL_RESULTS;
  const off = cases.filter(function (x) {
    if (!x || !x.errors || !x.errors.length) return false;
    const p = x.errors.filter(function (e) { return e.primary; })[0];
    return !p || p.kind !== U.classifyServers(x).code;
  });
  check("the headline always matches the verdict, on every case in this file",
    off.length === 0,
    off.map(function (x) {
      return U.classifyServers(x).code + "≠" + (x.errors.filter((e) => e.primary)[0] || {}).kind;
    }).join(" "));
  check("…and exactly one finding is ever the headline",
    cases.every(function (x) {
      return !x || !x.errors.length || x.errors.filter(function (e) { return e.primary; }).length === 1;
    }));
}

/* ---- "is there money here" and "how much" have to be one question ----
   They were two lists: fourteen columns for the first, six for the second. A cancellation falls
   between them — its money sits in Cash Back and Due Adjustment, in neither of the six — so
   reg 1633497 CRN 9643297957 was reported as money that did not survive the migration and then
   could not say how much, on a row holding 1,815 written off and 5,185 handed back.

   Every column is checked here, one at a time, because the gap was exactly the columns nobody
   thought to put in both lists. */
{
  const CW_MONEY = ["income", "consideration", "previousDue", "receivable", "prevStd", "booking",
    "special", "grossReceived", "dueAdjustment", "cashBack", "netReceived", "currentDue", "deducted"];
  /* build a Course Wise row that is blank everywhere except the one column under test */
  const only = (field, amount) => {
    const cells = CW_HEAD.map(function (h) {
      const norm = String(h).toLowerCase().replace(/[^a-z0-9]/g, "");
      const names = U.CW_COLS[field] || [];
      if (names.indexOf(norm) >= 0) return amount;
      if (norm === "date") return "01/01/2025";
      if (norm === "course") return "Employee Training Course";
      if (norm === "crn") return "9643297957";
      return "-";
    });
    return cells;
  };
  const none = { ok: true, rows: [], header: [], cols: {}, totalRow: null, noData: true };

  const silent = [];
  CW_MONEY.forEach(function (field) {
    const row = only(field, "1,815");
    const parsed = mkCw([row]);
    /* the fixture has to actually put the money where it says, or the check proves nothing */
    if (!parsed.rows.length || !/1,815/.test(String(parsed.rows[0][field] || ""))) {
      silent.push(field + "(not set)"); return;
    }
    const r = U.compareServers({ pw: none, cw: parsed }, { pw: none, cw: mkCw([]) }, { tolerance: 0 });
    const e = r.errors[0];
    if (!e || e.kind !== "srvlost" || !e.amount) silent.push(field + "→" + (e ? e.kind + "/" + e.amount : "none"));
  });
  check("money in any single column is money, and is named",
    silent.length === 0, silent.join(" "));

  /* the cancellation that started it: nothing in the six old columns, 7,000 of movement */
  const cancel = only("cashBack", "5,185");
  CW_HEAD.forEach(function (h, i) {
    if (String(h).toLowerCase().replace(/[^a-z0-9]/g, "").indexOf("dueadjustment") === 0) cancel[i] = "1,815";
  });
  const rc = U.compareServers({ pw: none, cw: mkCw([cancel]) }, { pw: none, cw: mkCw([]) }, { tolerance: 0 });
  check("a cancellation's money is not invisible",
    rc.errors[0].kind === "srvlost" && rc.errors[0].amount === 5185,
    rc.errors[0].kind + " / " + rc.errors[0].amount);
  check("…and the line says the figure",
    /5,185 টাকার/.test(U.shortError(rc.errors[0])), U.shortError(rc.errors[0]).slice(0, 100));

  /* and the two questions are one answer, so they can never part again */
  check("the worth and the has-money test are the same test",
    /function rowHasMoney\(r\) \{ return srvWorth\(r\) !== 0; \}/.test(
      fs.readFileSync(path.join(__dirname, "..", "reconcile.js"), "utf8")),
    "reconcile.js");
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
