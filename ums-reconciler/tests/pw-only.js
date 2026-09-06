/* When Course Wise is empty the two pages cannot be compared — but Program Wise can still be read.
 * compare() used to return the moment it saw an empty Course Wise, so every such student went
 * through completely unchecked: the largest bucket in a run, and the one place a Program Wise
 * fault could hide forever.
 *
 * reg 1924307 is exactly that: Receivable 20,000 − Prev.Std 1,000 − Received 10,000 = 9,000, but
 * Current Due says 7,000. Nothing on the Course Wise side to compare against, and nobody looking.
 *
 *   node tests/pw-only.js
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
const side = (rows) => ({ ok: true, rows, cols: {}, totalRow: null, noData: false });
const EMPTY = { ok: true, rows: [], cols: {}, totalRow: null, noData: true };

let fail = 0;
const check = (name, ok, extra) => { if (!ok) fail++; console.log((ok ? "PASS  " : "FAIL  ") + name + (!ok && extra ? "   " + extra : "")); };
const lines = (r) => r.errors.map((e) => U.shortError(e)).join("\n        ");

/* ---- real: reg 1295763 — one row, and the Booking Discount is what makes it balance ---- */
{
  const r = U.compare(side([pwRow({ mrn: "1218058678", date: "20/05/2018", income: "12,000",
    receivable: "12,000", booking: "500", received: "11,500" })]), EMPTY, { tolerance: 0 });
  check("12,000 − 500 booking − 11,500 = 0 → clean", r.errors.length === 0, lines(r));
  check("…and it is still reported as a Course Wise gap", r.emptyCourseWise === true);
}
{
  /* drop the discount and the same row no longer adds up — this is what was never being caught */
  const r = U.compare(side([pwRow({ mrn: "M1", date: "20/05/2018", income: "12,000",
    receivable: "12,000", received: "11,500" })]), EMPTY, { tolerance: 0 });
  check("without the discount the 500 gap is caught", r.errors.length > 0, lines(r) || "MISSED");
}

/* ---- real: reg 1924307 — 2,000 unaccounted, Course Wise empty ---- */
{
  const r = U.compare(side([pwRow({ mrn: "7519067832", date: "01/04/2022", income: "18,000",
    previousDue: "2,000", receivable: "20,000", prevStd: "1,000", received: "10,000",
    currentDue: "7,000" })]), EMPTY, { tolerance: 0 });
  check("reg 1924307 — 9,000 expected, 7,000 stored → caught",
    r.errors.some((e) => e.kind === "identity" && Math.abs(e.delta) === 2000), lines(r) || "MISSED");
}

/* ---- the other Program Wise rules run too ---- */
{
  /* due chain: 6,000 left owed, next receipt opens at 1,000 */
  const r = U.compare(side([
    pwRow({ mrn: "A", date: "01/01/2025", income: "10,000", receivable: "10,000", received: "4,000", currentDue: "6,000" }),
    pwRow({ mrn: "B", date: "01/02/2025", previousDue: "1,000", receivable: "1,000", received: "1,000" })
  ]), EMPTY, { tolerance: 0 });
  check("the due chain is checked", r.errors.some((e) => e.kind === "chain"), lines(r) || "MISSED");
}
{
  /* rows out of date order */
  const r = U.compare(side([
    pwRow({ mrn: "A", date: "01/03/2025", income: "1,000", receivable: "1,000", received: "1,000" }),
    pwRow({ mrn: "B", date: "01/01/2025", income: "1,000", receivable: "1,000", received: "1,000" }),
    pwRow({ mrn: "C", date: "01/05/2025", income: "1,000", receivable: "1,000", received: "1,000" })
  ]), EMPTY, { tolerance: 0 });
  check("row order is checked", r.errors.some((e) => e.kind === "order"), lines(r) || "MISSED");
}
{
  /* a discount larger than the Receivable behind it */
  const r = U.compare(side([pwRow({ mrn: "A", date: "01/01/2025", income: "1,000",
    receivable: "1,000", special: "3,000" })]), EMPTY, { tolerance: 0 });
  check("over-discount is checked", r.errors.some((e) => e.kind === "overdiscount"), lines(r) || "MISSED");
}

/* ---- and the guard that stops it crying wolf ---- */
{
  /* real: reg 1785439 — an over-payment leaves Receivable at −2,000 with no discount at all.
     0 > −2,000 is true, so the over-discount rule used to fire on a row with nothing discounted. */
  const r = U.compare(side([
    pwRow({ mrn: "1920219383", date: "26/04/2022", income: "3,000", receivable: "3,000",
      received: "5,000", currentDue: "-2,000" }),
    pwRow({ crn: "9643208657", date: "26/04/2022", consideration: "3,000", previousDue: "-2,000",
      receivable: "-2,000", cashBack: "5,000" })
  ]), EMPTY, { tolerance: 0 });
  check("negative Receivable with no discount → not called over-discount",
    !r.errors.some((e) => e.kind === "overdiscount"), lines(r));
}
{
  /* but a real discount against a negative Receivable is still wrong */
  const r = U.compare(side([pwRow({ mrn: "A", date: "01/01/2025", receivable: "-2,000",
    special: "1,000" })]), EMPTY, { tolerance: 0 });
  check("a real discount over a negative Receivable → still caught",
    r.errors.some((e) => e.kind === "overdiscount"), lines(r) || "MISSED");
}

/* ---- an all-zero ledger stays quiet ---- */
{
  const r = U.compare(side([pwRow({ mrn: "A", date: "01/01/2025" })]), EMPTY, { tolerance: 0 });
  check("nothing on the page → nothing to report", r.errors.length === 0, lines(r));
  check("…and it is flagged as an ordinary zero-payment", r.zeroPayment === true);
}

/* ---- the early return must not come back ---- */
{
  const REC = fs.readFileSync(path.join(__dirname, "..", "reconcile.js"), "utf8");
  const block = REC.slice(REC.indexOf("if (cw.noData || !cw.rows.length)"),
    REC.indexOf("/* --- present on one side only --- */"));
  ["dueIdentity(pw.rows", "dueChain(pw.rows", "rowSanity(pw.rows", "sortOrder(pw.rows"]
    .forEach(function (fn) {
      check("empty-Course-Wise path still runs " + fn.replace("(pw.rows", "()"), block.indexOf(fn) > 0);
    });
  check("the over-discount rule keeps its disc > 0 guard", /disc > 0 && disc > rcvbl/.test(REC));
}
/* ---- …and the finding has to REACH the report ----
   Running the rules was only half of it: summary() and app.js's itemDetail() both returned early
   on an empty Course Wise, so everything found above was computed and thrown away. The largest
   bucket of a run showed "Course Wise ফাঁকা" and nothing else, on screen and in the export. */
{
  const r = U.compare(side([pwRow({ mrn: "9643200001", date: "01/01/2023", income: "20000",
    receivable: "20000", prevStd: "1000", received: "10000", currentDue: "7000" })]), EMPTY, { tolerance: 0 });
  const s = U.summary(r);
  check("the Program Wise fault is found", r.errors.length === 1, "errors=" + r.errors.length);
  check("summary still says Course Wise is empty", /Course Wise ফাঁকা/.test(s), s);
  check("…and no longer stops there", s.length > "Course Wise ফাঁকা — Program Wise-এ 1 টি রসিদ আছে".length, s);
  check("…it names the fault", /নিজস্ব গরমিল/.test(s) && /Due ভুল/.test(s), s);
  check("…with the amount, so it can be acted on", /9,000/.test(s) && /7,000/.test(s), s);
  check("pwFindings is exported for app.js to reuse", typeof U.pwFindings === "function");
}

/* a clean Program Wise behind an empty Course Wise must read exactly as it always did */
{
  const r = U.compare(side([pwRow({ mrn: "9643200002", date: "01/01/2023", income: "5000",
    receivable: "5000", received: "5000", currentDue: "0" })]), EMPTY, { tolerance: 0 });
  check("clean Program Wise gains no tail", U.pwFindings(r) === "", U.pwFindings(r));
  check("…and its line is unchanged", U.summary(r) === "Course Wise ফাঁকা — Program Wise-এ 1 টি রসিদ আছে", U.summary(r));
}

/* the export path is a second, separate early return — it has to list them too */
{
  const APP = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  const cw = APP.slice(APP.indexOf('if (st === "cw") {'), APP.indexOf("const cat = r.errors.length"));
  check("itemDetail() lists the Program Wise findings", /r\.errors \|\| \[\]\)\.forEach/.test(cw), "app.js");
  check("…numbered, like every other row", /\(i \+ 1\) \+ "\) " \+ U\.shortError\(e\)/.test(cw), "app.js");
  check("…and still keeps the notes", /r\.notes \|\| \[\]\)\.forEach/.test(cw), "app.js");
  // the "N attempts" note sits between the two now; the findings must still come after it
  check("a Course Wise that never opened keeps them too",
    /t\("d_cwredir"\)[^;]*U\.pwFindings\(out\.result\)/.test(APP), "app.js");
}

/* ---- §3.3 on the Course-Wise-empty path ----
   identities() only ever runs on receipts that reached BOTH pages, so "Previous Due = Receivable −
   Income" — the one §3 rule that lives there — never ran on the largest bucket of a run. §3.5, the
   due chain, row sanity and row order all did. It needs no partner row either. */
{
  const r = U.compare(side([pwRow({ mrn: "9643200001", date: "01/01/2023",
    income: "1000", receivable: "5000", previousDue: "0", received: "5000", currentDue: "0" })]),
    EMPTY, { tolerance: 0 });
  const hit = r.errors.filter(function (e) { return /Previous Due-র হিসাব/.test(e.field); });
  check("§3.3 now runs with no Course Wise to pair against", hit.length === 1, lines(r));
  check("…it says what the Previous Due should have been", /4,000/.test(hit[0].note), hit[0].note);
  check("…and reaches the one-line summary", /4,000/.test(U.summary(r)), U.summary(r));
}

/* Deducted Amount exists only on a Cancellation row (UMS, per the user), and there the printed
   Consideration Amount is already the remainder after the deduction. So the column can never move
   §3.3: on an ordinary receipt it is 0, and on a cancellation Income is 0 while Receivable equals
   the Previous Due. A cancellation carrying a deduction must stay silent here. */
{
  const r = U.compare(side([pwRow({ mrn: "-", crn: "9643299999", date: "01/01/2023", income: "0",
    receivable: "4000", previousDue: "4000", deducted: "500", consideration: "3500", currentDue: "500" })]),
    EMPTY, { tolerance: 0 });
  const hit = r.errors.filter(function (e) { return /Previous Due-র হিসাব/.test(e.field); });
  check("a deduction on a cancellation does not break §3.3", hit.length === 0, lines(r));
}

/* an ordinary, correct receipt must gain nothing from any of this */
{
  const r = U.compare(side([pwRow({ mrn: "9643200003", date: "01/01/2023", income: "6000",
    previousDue: "4000", receivable: "10000", received: "10000", currentDue: "0" })]), EMPTY, { tolerance: 0 });
  check("a clean receipt still reports nothing", r.errors.length === 0, lines(r));
}

/* the rule must be wired in, and its formula must not be written twice */
{
  const REC = fs.readFileSync(path.join(__dirname, "..", "reconcile.js"), "utf8");
  const block = REC.slice(REC.indexOf("if (cw.noData || !cw.rows.length)"),
    REC.indexOf("/* --- present on one side only --- */"));
  check("empty-Course-Wise path runs prevDueIdentity()", block.indexOf("prevDueIdentity(pw.rows") > 0);
  check("the §3.3 formula lives in exactly one place",
    (REC.match(/money\(r\.receivable\) - money\(r\.income\)/g) || []).length === 1, REC.match(/money\(r\.receivable\) - money\(r\.income\)/g));
  check("…and identities() reads it from there too",
    /prevDueOff\(pr\)/.test(REC) && /prevDueOff\(r\)/.test(REC), "reconcile.js");
  check("the reason Deducted stays out is written down", /Deducted Amount does not belong in it/.test(REC), "reconcile.js");
}


console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
process.exit(fail ? 1 : 0);
