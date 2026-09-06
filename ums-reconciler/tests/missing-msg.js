/* A receipt on one page and not the other used to be announced three times over:
 *
 *     রসিদটা এক পাতায় নেই — মূল: [Program ↔ Course] CRN 9643224756 — শুধু Program Wise-এ আছে
 *     একই রসিদ Program Wise-এ আছে, Course Wise-এ নেই (বা উল্টো) — টাকার হিসাব এক পাতায় অসম্পূর্ণ
 *
 * — the category name, the finding and the explanation all saying the same sentence, and not one
 * of them saying how much money was involved. It is now one line that names the page, the
 * receipts and the amount:
 *
 *     Course Wise-এ রসিদটা নেই — CRN 9643224756 · 20,000 টাকার
 *
 *   node tests/missing-msg.js
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

/* a paid receipt both pages agree on, so only the cancellation is at issue */
const PAID_PW = pwRow({ mrn: "M1", date: "10/09/2022", income: "23,000", receivable: "23,000", received: "23,000" });
const PAID_CW = cwRow({ mrn: "M1", date: "10/09/2022", course: "Physics", income: "23,000",
  receivable: "23,000", grossReceived: "23,000", netReceived: "23,000" });

/* real: reg 1893997 — a 20,000 refund Program Wise has and Course Wise never got */
{
  const r = U.compare(
    side([PAID_PW, pwRow({ crn: "9643224756", date: "07/04/2023", consideration: "20,000", cashBack: "20,000" })]),
    side([PAID_CW]), { tolerance: 0 });
  const line = U.summary(r);

  check("one line, not three", line.split("\n").length === 1 && line.length < 90, line.length + ": " + line);
  check("names the page that is missing it", /Course Wise-এ/.test(line), line);
  check("names the receipt", /9643224756/.test(line), line);
  check("says how much money — the part that was never reported", /20,000/.test(line), line);
  check("does not repeat itself", (line.match(/Course Wise/g) || []).length === 1 &&
    (line.match(/Program Wise/g) || []).length === 0, line);
  check("no leftover 'মূল:' / 'এর ফলে আরও' scaffolding", !/মূল:|এর ফলে/.test(line), line);

  const cat = U.classify(r);
  check("marked self-evident so the UI drops the explanation", cat.selfEvident === true, cat.code);
}

/* several missing at once — counted and totalled, not listed forever */
{
  const r = U.compare(
    side([PAID_PW,
      pwRow({ crn: "A1", date: "01/01/2023", consideration: "8,166", cashBack: "8,166" }),
      pwRow({ crn: "A2", date: "02/01/2023", consideration: "24,334", cashBack: "24,334" })]),
    side([PAID_CW]), { tolerance: 0 });
  const line = U.summary(r);
  check("counts them", /২ টি রসিদ নেই/.test(line), line);
  check("adds the money up", /32,500/.test(line), line);
}
{
  const many = [PAID_PW];
  for (let i = 1; i <= 6; i++) many.push(pwRow({ crn: "B" + i, date: "0" + i + "/01/2023", consideration: "1,000", cashBack: "1,000" }));
  const line = U.summary(U.compare(side(many), side([PAID_CW]), { tolerance: 0 }));
  check("long lists are trimmed, not dumped", /আরও ৩ টি/.test(line) && line.length < 120, line);
}

/* the other direction reads the same way */
{
  const r = U.compare(
    side([PAID_PW]),
    side([PAID_CW, cwRow({ mrn: "C1", date: "07/04/2023", course: "Physics", income: "5,000",
      receivable: "5,000", grossReceived: "5,000", netReceived: "5,000" })]), { tolerance: 0 });
  const line = U.summary(r);
  check("missing from Program Wise says so", /Program Wise-এ/.test(line) && !/Course Wise-এ রসিদ/.test(line), line);
}

/* ---- the short form must NOT swallow anything else ---- */
{
  /* a missing receipt AND a broken amount — the compact line would hide the second fault */
  const r = U.compare(
    side([
      pwRow({ mrn: "M2", date: "10/09/2022", income: "23,000", receivable: "23,000", received: "20,000", currentDue: "2,900" }),
      pwRow({ crn: "D1", date: "07/04/2023", consideration: "20,000", cashBack: "20,000" })
    ]),
    side([cwRow({ mrn: "M2", date: "10/09/2022", course: "Physics", income: "23,000",
      receivable: "23,000", grossReceived: "20,000", netReceived: "20,000", currentDue: "2,900" })]),
    { tolerance: 0 });
  const line = U.summary(r);
  check("mixed faults fall back to the full headline", /মূল:/.test(line), line);
  check("…and the classification is not 'missing'", U.classify(r).code !== "missing", U.classify(r).code);
}

/* ---- the app must honour selfEvident ---- */
{
  const APP = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  const REC = fs.readFileSync(path.join(__dirname, "..", "reconcile.js"), "utf8");
  check("Batch list drops the repeated explanation", /whySelf/.test(APP), "app.js");
  check("Excel / CSV drops it too", /!cat\.selfEvident/.test(APP), "app.js");
  check("Single Reconcile report drops it", /cat\.selfEvident \?/.test(REC), "reconcile.js");
}

console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
process.exit(fail ? 1 : 0);
