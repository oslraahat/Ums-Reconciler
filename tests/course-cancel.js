/* Course Cancel (menus/cc) — a menu that writes to UMS.
 *
 * Two kinds of check. The rules in menus/cc/cc-core.js run for real: which column is which, which
 * rows are refused, how rows become jobs, which approver is taken, when a filled form must not be
 * sent, and which servers may be written to. Then the wiring is checked by reading the source,
 * because the property that matters most cannot be shown by running anything here: that Submit is
 * pressed in exactly one place, only after the form was checked, never on a dry run, never twice.
 *
 * The form amounts are the ones UMS DEV (ums-2) worked out on 17 Oct 2026 for reg 5574185 / spid
 * 7714428 when course 2472 was unticked (dry run, nothing sent): Cancellation 25,000 (five
 * subjects), 1,000 offer discount → Consideration 24,000, Cash Back 24,000, Current Due 0, paid
 * 38,000. The approver list is UMS's real answer for "260".
 *
 *   node tests/course-cancel.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

const g = {};
new Function("self", read("menus/cc/cc-core.js"))(g);
const C = g.UMSCANCEL;

let fail = 0;
const check = (name, ok, extra) => { if (!ok) fail++; console.log((ok ? "PASS  " : "FAIL  ") + name + (!ok && extra !== undefined ? "   " + extra : "")); };
const J = JSON.stringify;

/* ---- columns ---- */
{
  let d = C.detectCols([["Reg No", "StudentProgramId", "Course Id"]]);
  check("header by name", d.hdr && d.reg === 0 && d.spid === 1 && d.course === 2, J(d));
  d = C.detectCols([["Course ID", "Student Reg", "Student Program Id"]]);
  check("…in any order", d.course === 0 && d.reg === 1 && d.spid === 2, J(d));
  d = C.detectCols([["Registration", "Course Name", "spid", "CourseId"]]);
  check("…the CourseId column, not Course Name", d.course === 3 && d.spid === 2 && d.reg === 0, J(d));
  /* the same whole-word rule as lib/import.js: "Enrollment" is not a Reg column */
  d = C.detectCols([["Enrollment", "StudentProgramId", "CourseId"]]);
  check("'Enrollment' is not taken for Reg", !!d.lost && d.lost.join() === "Reg", J(d));
  d = C.detectCols([["5574185", "7714428", "2472"]]);
  check("no header → Reg, StudentProgramId, CourseId by position", !d.hdr && d.reg === 0 && d.spid === 1 && d.course === 2, J(d));
  d = C.detectCols([["Reg", "StudentProgramId"]]);
  check("a header that misses a column is refused, not guessed", !!d.lost && d.lost.join() === "CourseId", J(d));
  d = C.detectCols([["নাম", "ঠিকানা", "ফোন"]]);
  check("a header nobody can read is refused", !!d.lost && d.lost.length === 3, J(d));

  /* The first live sheet (17 Oct 2026, "Bulk Cancel live.xlsx", 1,241 rows) — a database export.
     Two things in it broke the first cut: "RegistrationNo" run together, and a "ProgramId" column
     (279, the programme) to the LEFT of "StudentProgramId". */
  const LIVE = ["RegistrationNo", "StudentId", "ProgramId", "SessionId", "StudentProgramId", "CourseId", "ApprovedBy", "CancellationReason"];
  d = C.detectCols([LIVE]);
  check("live sheet: 'RegistrationNo' is the Reg column", d.reg === 0, J(d));
  check("live sheet: StudentProgramId, NOT the ProgramId left of it", d.spid === 4, J(d));
  check("live sheet: CourseId", d.course === 5, J(d));
  check("live sheet: its ApprovedBy and CancellationReason columns are found", d.appr === 6 && d.reason === 7, J(d));
  check("…and 'StudentId' is never taken for anything", [d.reg, d.spid, d.course, d.appr, d.reason].indexOf(1) < 0, J(d));
  d = C.detectCols([["Reg", "Program Id", "CourseId"]]);
  check("a lone 'Program Id' still counts as StudentProgramId", d.spid === 1, J(d));
  check("'Registration Number' and 'Roll No.' are Reg too",
    C.looksReg("registration number") && C.looksReg("registrationnumber") && C.looksReg("roll no.") && !C.looksReg("enrollment") && !C.looksReg("payroll"));
}

/* ---- the live sheet's own Approved By and reason ---- */
{
  const LIVE = ["RegistrationNo", "StudentId", "ProgramId", "SessionId", "StudentProgramId", "CourseId", "ApprovedBy", "CancellationReason"];
  const p = C.parseInput([LIVE,
    ["3142995", "2187152", "279", "66", "7735604", "3156", "260", "Wrong Admissin"],
    ["1382720", "396971", "279", "66", "7722447", "3157", "260", "Wrong Admissin"]]);
  check("live rows parse with the right ids", p.rows.length === 2 && !p.rows[0].err && p.rows[0].reg === "3142995" &&
    p.rows[0].spid === "7735604" && p.rows[0].courses.join() === "3156" && p.rows[1].courses.join() === "3157", J(p.rows));
  check("the sheet's one approver and one reason are handed up", J(p.pins) === J(["260"]) && J(p.reasons) === J(["Wrong Admissin"]), J([p.pins, p.reasons]));
  const m = C.parseInput([LIVE,
    ["3142995", "1", "279", "66", "7735604", "3156", "260", "Wrong Admissin"],
    ["1382720", "2", "279", "66", "7722447", "3156", "261", "Wrong Admissin"]]);
  check("two different approvers in one sheet are both reported (the menu refuses that sheet)", J(m.pins) === J(["260", "261"]), J(m.pins));
  const n = C.parseInput([["Reg", "StudentProgramId", "CourseId"], ["5574185", "7714428", "2472"]]);
  check("a sheet without those columns hands up none", J(n.pins) === "[]" && J(n.reasons) === "[]", J([n.pins, n.reasons]));
}

/* ---- rows ---- */
{
  const p = C.parseInput([
    ["Reg", "StudentProgramId", "CourseId"],
    ["5574185", "7714428", "2472"],
    ["5574185", "7714428", "2729, 3037"],
    ["123", "7714428", "2472"],
    ["1957189 1536554", "7714428", "2472"],
    ["5574185", "", "2472"],
    ["5574185", "7714428", ""],
    ["5574185", "7714428", "Biology"],
    ["", "", ""],
    ["12345678901", "7714428", "2472"]
  ]);
  const r = p.rows;
  check("blank rows are dropped, the rest keep their sheet line", r.length === 8 && r[0].line === 2 && r[7].line === 10, r.map((x) => x.line).join(","));
  check("a good row", !r[0].err && r[0].courses.join() === "2472", J(r[0]));
  check("several CourseIds in one cell", !r[1].err && r[1].courses.join() === "2729,3037", J(r[1]));
  check("Reg must be 7 or 11 digits", r[2].err === "reg_len", r[2].err);
  check("two numbers in Reg are refused, not trimmed", r[3].err === "reg_two", r[3].err);
  check("blank StudentProgramId", r[4].err === "spid_blank", r[4].err);
  check("blank CourseId", r[5].err === "course_blank", r[5].err);
  check("a course NAME is not a CourseId", r[6].err === "course_digits", r[6].err);
  check("an 11-digit Roll is accepted", !r[7].err, r[7].err);

  /* without a header everything after the second cell is a course; with one, only the named column */
  const q = C.parseInput([["5574185", "7714428", "2472", "2729"]]).rows[0];
  check("no header: '… 2472 2729' is two courses, not one", q.courses.join() === "2472,2729", J(q));
  const h = C.parseInput([["Reg", "StudentProgramId", "CourseId", "Amount"], ["5574185", "7714428", "2472", "5000"]]).rows[0];
  check("with a header a 4th column is never a course", h.courses.join() === "2472", J(h));
  const x = C.parseInput([["5574185", "7714428", "2472"], ["5574186", "7714429", "2472", "Rahim"]]).rows[1];
  check("…and stray text in it refuses the row instead of guessing", !!x.err, J(x));
  const w = C.parseInput([["5574185", "7714428", "2472", "Rahim"]]);
  check("a first row with words is a header — if unreadable, nothing runs", !!w.lost && !w.rows.length, J(w));
  check("nothing at all says so", C.parseInput([[""], []]).empty === true);
}

/* ---- the paste box ---- */
{
  const rows = C.splitPaste("﻿Reg\tStudentProgramId\tCourseId\r\n5574185\t7714428\t2472, 2729\r\n\r\n5574186,7714429,2472\n5574187 7714430 3037\n");
  check("a pasted header survives", J(rows[0]) === J(["Reg", "StudentProgramId", "CourseId"]), J(rows[0]));
  check("tabs: '2472, 2729' stays one cell", rows[1].length === 3 && rows[1][2] === "2472, 2729", J(rows[1]));
  check("blank lines are dropped", rows.length === 4, rows.length);
  check("a typed line with commas", J(rows[2]) === J(["5574186", "7714429", "2472"]), J(rows[2]));
  check("a typed line with spaces", J(rows[3]) === J(["5574187", "7714430", "3037"]), J(rows[3]));

  /* 17 Oct 2026, ums-3: two cells copied from Excel, the course typed after a space —
     "3142995⇥7505542 2738". Split on tabs alone it became StudentProgramId "7505542 2738". */
  const mixed = C.splitPaste("3142995\t7505542 2738");
  check("tab + space on one line: three cells, not two", J(mixed[0]) === J(["3142995", "7505542", "2738"]), J(mixed));
  const mr = C.parseInput(mixed).rows[0];
  check("…so it parses into Reg, StudentProgramId and CourseId", !mr.err && mr.reg === "3142995" && mr.spid === "7505542" && mr.courses.join() === "2738", J(mr));
  check("a trailing tab does not count as a cell", J(C.splitPaste("3142995\t7505542 2738\t")[0]) === J(["3142995", "7505542", "2738"]));
  check("a non-breaking space separates too", J(C.splitPaste("3142995 7505542 2738")[0]) === J(["3142995", "7505542", "2738"]));
  check("comma and space mixed", J(C.splitPaste("3142995, 7505542 2738")[0]) === J(["3142995", "7505542", "2738"]));
  check("a properly tabbed line still keeps '2472, 2729' as one cell",
    J(C.splitPaste("5574185\t7714428\t2472, 2729")[0]) === J(["5574185", "7714428", "2472, 2729"]));
  check("…and a Reg cell holding two numbers is still refused, not shifted along",
    C.parseInput(C.splitPaste("1957189 1536554\t7714428\t2472")).rows[0].err === "reg_two");
  check("a tabbed header keeps its multi-word names",
    J(C.splitPaste("Reg No\tStudent Program Id\tCourse Id")[0]) === J(["Reg No", "Student Program Id", "Course Id"]));
}

/* ---- jobs ---- */
{
  const parsed = C.parseInput([
    ["5574185", "7714428", "2472"],
    ["5574185", "7714428", "2729"],
    ["5574185", "7714428", "2472"],
    ["5574186", "7714429", "2472"],
    ["123", "7714428", "9999"]
  ]).rows;
  const g2 = C.groupJobs(parsed);
  check("one job per Reg + StudentProgramId", g2.jobs.length === 2, g2.jobs.length);
  check("…its courses together, on one receipt", g2.jobs[0].courses.join() === "2472,2729", J(g2.jobs[0]));
  check("…the same course twice is cancelled once, and counted", g2.dupes === 1, g2.dupes);
  check("…with the sheet lines it came from", g2.jobs[0].lines.join() === "1,2,3", J(g2.jobs[0].lines));
  check("a refused row never becomes a job", !g2.jobs.some((j) => j.courses.indexOf("9999") >= 0));
}

/* ---- Approved By ---- */
{
  const real = [{ Disabled: false, Group: null, Selected: false, Text: "8801313368630 - (00260) - Anik", Value: "260" }];
  check("PIN 260 → Anik", (C.pickApprover(real, "260") || {}).Text === real[0].Text);
  const many = [{ Text: "x (02601)", Value: "2601" }, { Text: "y (12603)", Value: "12603" }, { Text: "z (00260)", Value: "260" }];
  check("only the exact PIN, not 2601 or 12603", (C.pickApprover(many, "260") || {}).Value === "260");
  check("no exact PIN → nobody", C.pickApprover(many.slice(0, 2), "260") === null);
  check("'00260' is the same PIN as '260'", (C.pickApprover(real, "00260") || {}).Value === "260");
  check("no PIN → nobody", C.pickApprover(real, " ") === null);
}

/* ---- the filled form ---- */
{
  const good = { cancellation: 25000, consideration: 24000, cashBack: 24000, currentDue: 0, paid: 38000, nextDate: "", allCancelled: false, untickedSubjects: 5 };
  check("the real dry run passes", C.checkForm(good) === null, J(C.checkForm(good)));
  const t = (o) => C.checkForm(Object.assign({}, good, o));
  /* the page's own rule: nothing to cancel = no subject unticked (CancelCourse.js 'Nothing to cancel.') */
  check("nothing to cancel = no subject unticked", (t({ untickedSubjects: 0 }) || {}).code === "nothing");
  /* 17 Oct 2026: course 3156 "Medical Trial Exam For HSC'26 Batch" — a free course, every amount 0.
     It was skipped as "nothing to cancel"; UMS accepts it. */
  check("a free course cancels at 0 — it is NOT skipped", t({ cancellation: 0, consideration: 0, cashBack: 0, currentDue: 0, untickedSubjects: 3 }) === null,
    J(t({ cancellation: 0, consideration: 0, cashBack: 0, currentDue: 0, untickedSubjects: 3 })));
  check("an amount that could not be read is refused", (t({ cancellation: NaN }) || {}).code === "form");
  check("blank Consideration", (t({ consideration: NaN }) || {}).code === "form");
  check("negative Consideration", (t({ consideration: -1 }) || {}).code === "form");
  check("Consideration above Cancellation", (t({ consideration: 25001 }) || {}).code === "form");
  check("Cash Back above what was paid", (t({ cashBack: 38001 }) || {}).code === "form");
  check("a due left behind needs a Next Receiving Date", (t({ cashBack: 0, currentDue: 500 }) || {}).code === "needdate");
  check("…and passes with one", t({ cashBack: 0, currentDue: 500, nextDate: "2026-11-01" }) === null);
  check("every course cancelled with a due left → refused, as UMS does",
    (t({ cashBack: 0, currentDue: 500, nextDate: "2026-11-01", allCancelled: true }) || {}).code === "alldue");
  check("…but with nothing due it is fine", t({ allCancelled: true }) === null);
}

/* ---- 💰 zero taka only ---- */
{
  // course 3156, the free trial exam: every money field on the form reads 0
  const free = { due: 0, cancellation: 0, deduction: 0, discount: 0, consideration: 0, cashBack: 0, currentDue: 0 };
  const z = (o) => C.nonZero(Object.assign({}, free, o));
  check("an all-zero form passes the zero-taka guard", z({}) === null, J(z({})));
  check("a blank Deduction box counts as 0 (the page leaves it empty until a course is clicked)", z({ deduction: NaN }) === null);
  const paid = z({ cancellation: 25000, consideration: 24000, cashBack: 24000, discount: 1000 });
  check("the ums-2 paid course is skipped", !!paid && paid.code === "money", J(paid));
  check("…and the reason names every field that is not 0, with its amount",
    !!paid && /Cancellation 25,000/.test(paid.why) && /Cash Back 24,000/.test(paid.why) && /Discount 1,000/.test(paid.why) && !/Previous Due/.test(paid.why), paid && paid.why);
  check("a Previous Due alone is enough to skip", (z({ due: 500 }) || {}).code === "money");
  check("so is a Current Due alone", (z({ currentDue: 1 }) || {}).code === "money");
  check("an amount that could not be read is NOT taken for zero", (z({ cashBack: NaN }) || {}).code === "money");
}

/* ---- where the tab ends up, and where writing is allowed ---- */
{
  check("receipt id off the success address (a path segment)", C.receiptOf("https://ums-2.osl.team/Student/Payment/GenerateMoneyReciept/987654") === "987654");
  check("…several ids", C.receiptOf("https://x.osl.team/Student/Payment/GenerateMoneyReciept/1%2C2?print=1") === "1,2");
  check("…the ?id= form too", C.receiptOf("https://x.osl.team/Student/Payment/GenerateMoneyReciept?id=55") === "55");
  check("…and nothing off any other page", C.receiptOf("https://x.osl.team/Student/CancelCourse/CancelCourse?studentProgramId=1") === null);
  check("the login page is recognised", C.isLogin("https://ums-2.osl.team/Account/Login?ReturnUrl=%2FStudent") && !C.isLogin("https://ums-2.osl.team/Student/CancelCourse/CancelCourseOrSubject"));
  check("osl.team may be written to", C.canWrite("https://ums-2.osl.team") && C.canWrite("https://ums-41.osl.team/"));
  /* asked for on 17 Oct 2026: "https://orgbd.net e run korte hobe" — the bare domain, and its subdomains */
  check("orgbd.net may be written to", C.canWrite("https://orgbd.net") && C.canWrite("https://orgbd.net/") && C.canWrite("https://ums.orgbd.net"));
  check("…umsbd.net may not", !C.canWrite("https://ums.umsbd.net") && !C.canWrite("https://umsbd.net"));
  check("…nor a look-alike, a lookalike suffix or plain http",
    !C.canWrite("https://osl.team.evil.com") && !C.canWrite("https://orgbd.net.evil.com") && !C.canWrite("https://notorgbd.net") &&
    !C.canWrite("http://orgbd.net") && !C.canWrite("http://ums-2.osl.team") && !C.canWrite("not a url"));
}

/* ---- the wiring: Submit in one place, after the checks, never on a dry run ---- */
const fnBody = (src, name) => {
  const at = src.indexOf("function " + name + "(");
  if (at < 0) return "";
  let depth = 0;
  for (let j = src.indexOf("{", at); j < src.length; j++) {
    if (src[j] === "{") depth++;
    else if (src[j] === "}") { depth--; if (!depth) return src.slice(at, j + 1); }
  }
  return "";
};
{
  const PAGE = read("menus/cc/cc-page.js");
  const presses = PAGE.match(/#courseCancelPayment"\)\.click\(\)/g) || [];
  check("UMS's Submit is pressed in exactly one place", presses.length === 1, presses.length);
  const submit = fnBody(PAGE, "submit"), fill = fnBody(PAGE, "fill");
  check("…inside submit()", /#courseCancelPayment"\)\.click\(\)/.test(submit));
  check("…never inside fill()", fill.length > 0 && !/courseCancelPayment"\)\.click/.test(fill));
  check("submit() re-checks the form before pressing",
    submit.indexOf("C.checkForm(f)") >= 0 && submit.indexOf("C.checkForm(f)") < submit.indexOf('#courseCancelPayment").click()'));
  check("…against the amounts fill() reported", /msg\.expect\.cancellation/.test(submit) && /msg\.expect\.cashBack/.test(submit));
  check("fill() refuses a course that is already unticked BEFORE clicking anything",
    fill.indexOf("unticked.length") >= 0 && fill.indexOf("unticked.length") < fill.indexOf(".click()"));
  check("fill() checks it opened the right student's form", fill.indexOf("rightForm(msg.spid)") >= 0 && fill.indexOf("rightForm(msg.spid)") < fill.indexOf(".click()"));
  check("the page script only acts when called", !/chrome\.runtime\.onMessage/.test(PAGE) && /self\.UMSCCPAGE = \{/.test(PAGE));
  check("fill() applies the zero-taka guard before it reports the form ready",
    fill.indexOf("msg.zeroOnly ? C.nonZero(f)") >= 0 && fill.indexOf("msg.zeroOnly ? C.nonZero(f)") < fill.indexOf("return { ok: true"));
  check("…and submit() applies it again before pressing",
    submit.indexOf("msg.zeroOnly ? C.nonZero(f)") >= 0 && submit.indexOf("msg.zeroOnly ? C.nonZero(f)") < submit.indexOf('#courseCancelPayment").click()'));
  const search = fnBody(PAGE, "search");
  check("search() clears what an earlier student left before reading", search.indexOf('view.innerHTML = ""') >= 0 && search.indexOf('view.innerHTML = ""') < search.indexOf("btn.click()"));
}
{
  const BG = read("background.js");
  const run = fnBody(BG, "ccBrowserRun");
  check("background: the Course Cancel run is there", run.length > 0);
  const subs = BG.match(/UMSCCPAGE\.submit\(/g) || [];
  check("background asks for Submit in one place", subs.length === 1, subs.length);
  check("…inside ccBrowserRun", /UMSCCPAGE\.submit\(/.test(run));
  check("…after the dry-run exit", run.indexOf("if (p.dry)") >= 0 && run.indexOf("if (p.dry)") < run.indexOf("UMSCCPAGE.submit("));
  check("…which comes after the form was filled and found sound",
    run.indexOf('"fill"') >= 0 && run.indexOf('"fill"') < run.indexOf("if (!f.ok)") && run.indexOf("if (!f.ok)") < run.indexOf("if (p.dry)"));
  {
    // the lookup may be repeated; the Submit must sit after the end of that loop, not in it
    const loopAt = run.indexOf("for (let a = 0");
    let depth = 0, loopEnd = -1;
    for (let j = run.indexOf("{", loopAt); loopAt >= 0 && j < run.length; j++) {
      if (run[j] === "{") depth++;
      else if (run[j] === "}") { depth--; if (!depth) { loopEnd = j; break; } }
    }
    check("…outside the retry loop", loopEnd > 0 && run.indexOf("UMSCCPAGE.submit(") > loopEnd && (run.match(/for \(/g) || []).length === 1,
      "loop ends " + loopEnd + ", submit at " + run.indexOf("UMSCCPAGE.submit("));
  }
  check("an unsure Submit is looked at again, not sent again", /ccRecheck\(/.test(run) && !/submit/i.test(fnBody(BG, "ccRecheck").replace(/Submit-/g, "")));
  check("the background draws the same server line before opening anything",
    run.indexOf("ccCanWrite(p.base)") >= 0 && run.indexOf("ccCanWrite(p.base)") < run.indexOf("ccEnsureTab("));
  {
    // the two copies of the line must agree — host by host, on the same cases
    const g3 = {};
    new Function("self", read("menus/cc/cc-core.js"))(g3);
    const bgLine = new Function(BG.match(/function ccCanWrite\([^\n]*/)[0] + "\nreturn ccCanWrite;")();
    const hosts = ["https://orgbd.net", "https://ums.orgbd.net", "https://ums-2.osl.team", "https://ums.umsbd.net",
      "https://orgbd.net.evil.com", "https://notorgbd.net", "http://orgbd.net", "https://osl.team.x.com", "garbage"];
    const differ = hosts.filter((h) => bgLine(h) !== g3.UMSCANCEL.canWrite(h));
    check("…and it is the same line cc-core.js draws", differ.length === 0, differ.join(", "));
  }
  check("the tab only follows a link on the same UMS", /new URL\(s\.href\)\.host !== new URL\(p\.base\)\.host/.test(run));
  check("the zero-taka switch reaches both the fill and the submit step",
    (run.match(/zeroOnly: p\.zeroOnly === true/g) || []).length === 2);
  /* the fast path (17 Oct 2026): straight to the form's address, confirmed by UMS's own lookup */
  check("fast path: the form address is built from the row's StudentProgramId and Reg, escaped",
    /\/Student\/CancelCourse\/CancelCourse\?studentProgramId=" \+ encodeURIComponent\(p\.spid\)/.test(run) &&
    /stdRollOrRegistrationNo=" \+ encodeURIComponent\(p\.reg\)/.test(run));
  check("fast path: UMS's lookup ('check') runs before anything is filled",
    run.indexOf('"check"') >= 0 && run.indexOf('"check"') < run.indexOf('"fill"'));
  check("fast path: the pair counts as confirmed only on a yes from the lookup",
    (run.match(/confirmed = true/g) || []).length === 1 && /if \(c\.ok\) \{ confirmed = true;/.test(run));
  check("fast path: a 'no' from UMS skips the student; only an unreadable answer falls back",
    /else if \(c\.code !== "lookup" && c\.code !== "page"\) return \{ status: "skip"/.test(run));
  check("…and the fallback is the click-through, before the fill",
    run.indexOf("if (!confirmed)") >= 0 && run.indexOf("if (!confirmed)") < run.indexOf('ccStep(tabId, "search"') &&
    run.indexOf('ccStep(tabId, "search"') < run.indexOf('"fill"'));
  /* the 🔎 switch (17 Oct 2026): the old way on its own — "cancel course e gia reg input kore cancel e click kore" */
  check("🔎 search route: the direct address and the lookup are skipped entirely",
    /if \(p\.route !== "search"\) \{\s*const g = await ccGo\(tabId, href, CC_FORM_RE, p\.base\);/.test(run) &&
    run.indexOf('if (p.route !== "search")') < run.indexOf('ccStep(tabId, "check"'));
  check("🔎 the old way presses the programme's own Cancel Course button, it does not type its address",
    /self\.UMSCCPAGE\.follow\(m\)/.test(run) && !/ccGo\(tabId, href, CC_FORM_RE, p\.base\);\s*if \(!g2\.ok\)/.test(run) &&
    run.indexOf("UMSCCPAGE.follow(") > run.indexOf('ccStep(tabId, "search"') && run.indexOf("UMSCCPAGE.follow(") < run.indexOf('"fill"'));
  {
    const fol = fnBody(read("menus/cc/cc-page.js"), "follow");
    check("follow() clicks only this StudentProgramId's link for this Reg, on this same UMS, a tick later",
      /get\("studentProgramId"\) === String\(msg\.spid\)/.test(fol) && /\.host !== location\.host/.test(fol) &&
      fol.indexOf(".host !== location.host") < fol.indexOf("a.click()") && /setTimeout\(function \(\) \{ a\.click\(\); \}, 0\)/.test(fol));
  }
  {
    const PAGE = read("menus/cc/cc-page.js"), chk = fnBody(PAGE, "check");
    check("check() is on the right form before it asks", chk.indexOf("rightForm(msg.spid)") >= 0 && chk.indexOf("rightForm(msg.spid)") < chk.indexOf("fetch("));
    check("check() asks exactly what the search page asks, with the search page as referrer",
      /\/Student\/CancelCourse\/GenerateStudentProgramDetails/.test(chk) && /referrer: "\/Student\/CancelCourse\/CancelCourseOrSubject"/.test(chk) &&
      /"stdRollOrRegistrationNo=" \+ encodeURIComponent\(msg\.reg\)/.test(chk));
    check("check() touches nothing on the form", !/\.click\(\)|\.value =|dispatchEvent/.test(chk));
    check("check() and search() pick the programme the same way", /return pickProgramme\(grid, msg\)/.test(chk) && /return pickProgramme\(got\.grid, msg\)/.test(fnBody(PAGE, "search")));
  }
  /* 17 Oct 2026: after every successful cancel the tab sat on a blank page for ~10 s. ccGo parked it
     on about:blank and waited for that address — which Chrome never shows an extension without the
     "tabs" permission. Now no detour, and the wait goes by load status. */
  check("no about:blank detour between students", !/about:blank/.test(fnBody(BG, "ccGo")) && !/about:blank/.test(fnBody(BG, "ccLoad")));
  const listener = BG.slice(BG.indexOf("chrome.runtime.onMessage.addListener"));
  check("only the extension's own pages can start a cancellation",
    listener.indexOf("sender.id !== chrome.runtime.id") >= 0 && listener.indexOf("sender.id !== chrome.runtime.id") < listener.indexOf('"ccBrowser"'));
}

/* ---- ccLoad, run for real against a fake chrome.tabs ---- */
const loadTest = (async function () {
  const BG = read("background.js");
  const src = fnBody(BG, "ccLoadBy") + "\n" + fnBody(BG, "ccLoad");
  const makeChrome = function (script) {
    const listeners = [];
    const chrome = {
      runtime: { lastError: null },
      tabs: {
        onUpdated: { addListener: (h) => listeners.push(h), removeListener: (h) => { const i = listeners.indexOf(h); if (i >= 0) listeners.splice(i, 1); } },
        update: function (id, props, cb) { script(listeners, chrome, cb); }
      }
    };
    chrome.fire = (id, info) => listeners.slice().forEach((h) => h(id, info, {}));
    chrome.listeners = listeners;
    return chrome;
  };
  const run = (chrome, ms) => new Function("chrome", src + "\nreturn ccLoad;")(chrome)(7, "https://x.orgbd.net/Student/CancelCourse/CancelCourseOrSubject", ms);

  // the OLD page reports complete first (it was already loaded) — that must not count; ours does
  let c = makeChrome(function (ls, ch, cb) {
    setTimeout(() => { ch.fire(7, { status: "complete" }); ch.fire(7, { status: "loading" }); ch.fire(9, { status: "complete" }); ch.fire(7, { status: "complete" }); }, 5);
    cb && cb();
  });
  let t0 = Date.now(), r = await run(c, 3000);
  check("ccLoad: the old page's 'complete' is ignored, ours is taken — at once, not after a timeout",
    r === "complete" && Date.now() - t0 < 1000, r + " in " + (Date.now() - t0) + " ms");
  check("ccLoad: the listener is removed afterwards", c.listeners.length === 0, c.listeners.length);

  // a 'complete' with no 'loading' before it is the old page — wait, and give up at the limit
  c = makeChrome(function (ls, ch, cb) { setTimeout(() => ch.fire(7, { status: "complete" }), 5); cb && cb(); });
  r = await run(c, 120);
  check("ccLoad: no new load → 'timeout', not a false 'complete'", r === "timeout", r);

  // the tab was closed: tabs.update reports an error
  c = makeChrome(function (ls, ch, cb) { ch.runtime.lastError = { message: "No tab with id: 7" }; cb(); ch.runtime.lastError = null; });
  r = await run(c, 3000);
  check("ccLoad: a closed tab → 'gone'", r === "gone", r);

  // ccLoadBy with a click instead of an address (the old way's Cancel Course button)
  const runBy = (chrome, kick, ms) => new Function("chrome", src + "\nreturn ccLoadBy;")(chrome)(7, kick, ms);
  c = makeChrome(function () {});
  t0 = Date.now();
  r = await runBy(c, function () { setTimeout(() => { c.fire(7, { status: "loading" }); c.fire(7, { status: "complete" }); }, 5); return true; }, 3000);
  check("ccLoadBy: a click that navigates → 'complete', at once", r === "complete" && Date.now() - t0 < 1000, r);
  r = await runBy(makeChrome(function () {}), function () { return false; }, 3000);
  check("ccLoadBy: a kick that declines (no button to press) → 'refused', not a wait", r === "refused", r);
})();
{
  const UI = read("menus/cc/cc.js"), HTML = read("app.html");
  check("a real run asks first", /confirm\(/.test(fnBody(UI, "ccRun")) && fnBody(UI, "ccRun").indexOf("if (!dry)") < fnBody(UI, "ccRun").indexOf("confirm("));
  check("the dry run is ON in the markup", /<input type="checkbox" id="ccDry" checked>/.test(HTML));
  check("…and switched back on every time the page is opened", /\$\("ccDry"\)\.checked = true/.test(fnBody(UI, "ccOnShow")));
  check("…and never remembered", !/ccDry[^;]*storage|storage[^;]*ccDry/.test(UI) && !/dry:/.test(fnBody(UI, "ccSave")));
  check("💰 zero taka only is ON in the markup", /<input type="checkbox" id="ccZero" checked>/.test(HTML));
  check("…switched back on every time the page is opened", /\$\("ccZero"\)\.checked = true/.test(fnBody(UI, "ccOnShow")));
  check("…never remembered", !/zero/i.test(fnBody(UI, "ccSave")));
  check("…and sent with every job", /zeroOnly: zeroOnly/.test(fnBody(UI, "ccRun")));
  check("the route switch (⚡ / 🔎) is remembered and sent with every job",
    /ccRoute: ccRoute/.test(fnBody(UI, "ccSave")) && /route: ccRoute/.test(fnBody(UI, "ccRun")) &&
    /id="ccDirect"/.test(HTML) && /id="ccSearch"/.test(HTML));
  check("the run ends by closing the UMS tab — no filled form left behind", /ccBrowserClose/.test(fnBody(UI, "ccRun")));
  check("app.html loads the rules before the menu, and both before app.js",
    HTML.indexOf('src="menus/cc/cc-core.js"') > 0 && HTML.indexOf('src="menus/cc/cc-core.js"') < HTML.indexOf('src="menus/cc/cc.js"') &&
    HTML.indexOf('src="menus/cc/cc.js"') < HTML.indexOf('src="app.js"'));
  check("the menu has its button and its page", /id="navCc"/.test(HTML) && /<section id="pgCc" class="page">/.test(HTML));
}

/* ---- the manifest ---- */
{
  const M = JSON.parse(read("manifest.json"));
  check("no new permission was needed", J(M.permissions) === J(["storage", "downloads", "nativeMessaging", "declarativeNetRequestWithHostAccess", "scripting"]), J(M.permissions));
  check("the page script is injected on demand, not declared on every UMS page",
    !(M.content_scripts || []).some((c) => c.js.some((f) => /menus\/cc\//.test(f))));
  const war = (M.web_accessible_resources || [])[0] || { resources: [] };
  check("app.html's new scripts are listed beside the other menus",
    war.resources.indexOf("menus/cc/cc.js") >= 0 && war.resources.indexOf("menus/cc/cc-core.js") >= 0);
}

loadTest.then(function () {
  console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
  process.exit(fail ? 1 : 0);
}, function (e) { console.log("FAIL  the ccLoad test threw: " + ((e && e.stack) || e)); process.exit(1); });
