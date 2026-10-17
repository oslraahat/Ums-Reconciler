/* Course Cancel (cc*) — the decisions, with no page and no network behind them.
 *
 * Loaded in two places: by app.html, where menus/cc/cc.js turns a sheet into jobs, and into the UMS
 * Cancel Course page itself (background.js injects it beside cc-page.js), where a filled form is
 * checked before anything is sent. Kept apart from both so tests/course-cancel.js runs every rule
 * under node.
 *
 * This is a menu that WRITES to UMS, and a cancellation cannot be taken back from here. So the
 * rules lean one way throughout: when a row, a column or a form is not exactly what it should be,
 * the answer is "skip it and say why", never "guess and send".
 */
(function (root) {
  "use strict";

  const cell = function (v) { return String(v == null ? "" : v).trim(); };

  /* A Registration/Roll header, by whole WORDS — the test lib/import.js uses, so "Enrollment",
     "Payroll" or "Region" is never taken for the Reg column — plus the run-together spellings a
     database export writes: the first live sheet (17 Oct 2026) headed it "RegistrationNo", which
     the word list alone refused, and the whole sheet with it. */
  const REG_WORDS = ["reg", "regn", "regno", "registration", "roll", "rollno",
    "registrationno", "registrationnumber", "regnumber", "rollnumber"];
  function looksReg(h) {
    const toks = String(h).toLowerCase().replace(/[._/]/g, " ").split(/[^a-z0-9]+/).filter(Boolean);
    for (let i = 0; i < toks.length; i++) {
      if (REG_WORDS.indexOf(toks[i]) >= 0) return true;
    }
    return false;
  }

  /* Which column is which.
   *
   * A header names them. Without one the order is Reg, StudentProgramId, CourseId — the order the
   * request was made in. A header that names some columns and not others is refused rather than
   * filled in by position: here a wrong guess sends a real cancellation for the wrong course.
   *
   * CourseId is looked for first, because "Course Id" must not be read as a Program Id, and an id
   * column wins over a "Course Name" column beside it.
   *
   * StudentProgramId is looked for by its full name before any bare "Program Id": a database export
   * carries both ("ProgramId" 279 — the programme — sitting left of "StudentProgramId"), and taking
   * the first match took the programme's id for every student's, so every row would have come back
   * "programme not found". A lone "Program Id" column still counts, the way lib/import.js reads one.
   *
   * Two optional columns ride along when a header names them — Approved By and the Cancellation
   * Reason — so the values the sheet was written with are the ones used (see parseInput). */
  function detectCols(rows) {
    const first = (rows[0] || []).map(function (c) { return cell(c).toLowerCase(); });
    let reg = -1, spid = -1, course = -1, appr = -1, reason = -1;
    const take = function (test) {
      for (let i = 0; i < first.length; i++) {
        if (i !== reg && i !== spid && i !== course && i !== appr && i !== reason && test(first[i])) return i;
      }
      return -1;
    };
    course = take(function (h) { return /course\s*[-_ ]?id/.test(h); });
    if (course < 0) course = take(function (h) { return /course/.test(h); });
    spid = take(function (h) { return /spid|student\s*[-_ ]?program\s*[-_ ]?id/.test(h); });
    if (spid < 0) spid = take(function (h) { return /program\s*[-_ ]?id/.test(h); });
    reg = take(looksReg);
    appr = take(function (h) { return /approv/.test(h); });
    reason = take(function (h) { return /reason/.test(h); });
    const named = [reg, spid, course].filter(function (x) { return x >= 0; }).length;
    /* A first row with any letters in it is a header, even one that cannot be read — treating it
       as data would only fail later, one row at a time, with a less useful message. */
    const wordy = first.some(function (c) { return /[a-zঀ-৿]/.test(c); });
    if (!named && !wordy) return { reg: 0, spid: 1, course: 2, hdr: false };
    if (named === 3) return { reg: reg, spid: spid, course: course, appr: appr, reason: reason, hdr: true };
    const lost = [];
    if (reg < 0) lost.push("Reg");
    if (spid < 0) lost.push("StudentProgramId");
    if (course < 0) lost.push("CourseId");
    return { hdr: true, lost: lost };
  }

  /* One sheet row → one request, or the reason (an error code) it cannot be one.
   *
   * Reg is what the UMS search box takes, and that box wants 7 digits (Reg) or 11 (Roll). Two
   * numbers in the cell are refused, not trimmed to the first: Payment History can afford that
   * guess, a cancellation cannot. A CourseId cell may hold several ids ("2472, 2729") — those
   * courses are cancelled together, on one receipt. */
  function parseRow(r, cols, line) {
    const reg = cell(r[cols.reg]), spid = cell(r[cols.spid]);
    /* Without a header every cell after the second is a CourseId — "5574185 7714428 2472 2729"
       typed on one line means two courses, and reading only the third cell would drop 2729
       without a word. With a header only the named column counts: a fourth column there is
       something else (a name, an amount) and must never be taken for a course. */
    const courseCell = cols.hdr ? cell(r[cols.course])
      : r.slice(cols.course).map(cell).filter(Boolean).join(",");
    const out = { line: line, reg: reg, spid: spid, courses: [] };
    if (!reg) { out.err = "reg_blank"; return out; }
    if (!/^\d+$/.test(reg)) { out.err = /\d\s+\d/.test(reg) ? "reg_two" : "reg_digits"; return out; }
    if (reg.length !== 7 && reg.length !== 11) { out.err = "reg_len"; return out; }
    if (!spid) { out.err = "spid_blank"; return out; }
    if (!/^\d+$/.test(spid)) { out.err = "spid_digits"; return out; }
    if (!courseCell) { out.err = "course_blank"; return out; }
    if (/[^\d\s,;/|+]/.test(courseCell)) { out.err = "course_digits"; return out; }
    courseCell.split(/[\s,;/|+]+/).forEach(function (c) {
      if (c && out.courses.indexOf(c) < 0) out.courses.push(c);
    });
    if (!out.courses.length) out.err = "course_blank";
    return out;
  }

  /* The paste box. Cells copied out of Excel arrive tab-separated, and a tab is the only separator
     that can never be part of a value — so a line whose tabs give the three cells is split on tabs
     and nothing else, and "2472, 2729" stays one cell.
     A line of numbers whose tabs do NOT give three cells was put together by hand — two cells copied
     from Excel and the course typed after a space: "3142995⇥7505542 2738" (seen 17 Oct 2026). Split
     on tabs alone, that made "7505542 2738" one StudentProgramId and left the course blank; such a
     line is split on any tab, space or comma instead.
     A line with letters in it (a header) keeps the old rule — tabs, else commas, else spaces — so
     "Course Id" is not torn into two words. */
  function splitPaste(text) {
    return String(text || "").replace(/^﻿/, "").split(/\r?\n/).map(function (line) {
      const filled = function (cells) { return cells.filter(function (c) { return c !== ""; }).length; };
      if (/[a-zঀ-৿]/i.test(line)) {
        if (line.indexOf("\t") >= 0) return line.split("\t").map(cell);
        if (line.indexOf(",") >= 0) return line.split(",").map(cell);
        return line.trim().split(/\s+/);
      }
      if (line.indexOf("\t") >= 0) {
        const tabbed = line.split("\t").map(cell);
        if (filled(tabbed) >= 3) return tabbed;
      }
      return line.trim().split(/[\s,;]+/).filter(Boolean);
    }).filter(function (r) { return r.some(function (c) { return c !== ""; }); });
  }

  /** rows: the sheet as arrays of cells →
   *  { rows: parsed rows (each with .err or not), lost?, empty?,
   *    pins / reasons: the distinct Approved By / Cancellation Reason values the sheet itself gives
   *    (only when its header has those columns; blanks ignored) } */
  function parseInput(rows) {
    // number the rows BEFORE dropping blanks, so "line 11" in the preview is line 11 of what was given
    const kept = [];
    (rows || []).forEach(function (r, i) {
      if (r && r.some(function (c) { return cell(c) !== ""; })) kept.push({ r: r, line: i + 1 });
    });
    if (!kept.length) return { rows: [], empty: true };
    const cols = detectCols([kept[0].r]);
    if (cols.lost) return { rows: [], lost: cols.lost, cols: cols };
    const data = cols.hdr ? kept.slice(1) : kept;
    const distinct = function (ix) {
      if (!(ix >= 0)) return [];
      const seen = [];
      data.forEach(function (x) { const v = cell(x.r[ix]); if (v && seen.indexOf(v) < 0) seen.push(v); });
      return seen;
    };
    return { cols: cols, rows: data.map(function (x) { return parseRow(x.r, cols, x.line); }),
      pins: distinct(cols.appr), reasons: distinct(cols.reason) };
  }

  /* One job per student programme. Two rows for the same Reg + StudentProgramId become one
     submission with both courses unticked — one receipt, the way a person would do it by hand —
     and the same course listed twice is cancelled once. */
  function groupJobs(parsed) {
    const jobs = [], at = {};
    let dupes = 0;
    parsed.forEach(function (r) {
      if (r.err) return;
      const k = r.reg + "|" + r.spid;
      let j = at[k];
      if (!j) { j = at[k] = { reg: r.reg, spid: r.spid, courses: [], lines: [] }; jobs.push(j); }
      j.lines.push(r.line);
      r.courses.forEach(function (c) {
        if (j.courses.indexOf(c) < 0) j.courses.push(c); else dupes++;
      });
    });
    return { jobs: jobs, dupes: dupes };
  }

  /* The Approved By box offers everyone whose name, phone or PIN contains what was typed — "260"
     also finds 2601 and 12603. Only an exact PIN is taken. "00260" and "260" are the same PIN. */
  function pickApprover(list, pin) {
    const want = cell(pin);
    if (!want) return null;
    const same = function (v) {
      v = cell(v);
      return v === want || (/^\d+$/.test(v) && /^\d+$/.test(want) && Number(v) === Number(want));
    };
    return (list || []).filter(function (x) { return x && same(x.Value); })[0] || null;
  }

  const fmt = function (n) { return isFinite(n) ? Number(n).toLocaleString("en-US") : "—"; };

  /* The UMS form, read back after the course boxes were clicked. The page's own Submit checks the
     same things (/Scripts/Student/CancelCourse.js, the #courseCancelPayment handler) and silently
     refuses to send when one fails — so they are checked here first, to say WHICH one, and Submit
     is only pressed on a form UMS will accept. null = fine to send. */
  function checkForm(f) {
    /* "Is there anything to cancel?" is asked the way the page asks it — is any subject unticked —
       and NOT by the amount. A course whose subjects cost 0 (a free trial exam: course 3156 "Medical
       Trial Exam For HSC'26 Batch", 17 Oct 2026) cancels at Cancellation 0, and UMS accepts that;
       refusing every zero amount skipped the very rows the sheet was written for. */
    if (!(f.untickedSubjects > 0)) return { code: "nothing", why: "বাতিল করার মতো কিছু নেই — কোনো subject-এর টিক ওঠেনি (UMS নিজেও 'Nothing to cancel' বলত)" };
    if (!isFinite(f.cancellation) || f.cancellation < 0) return { code: "form", why: "Cancellation Amount পড়া যায়নি (" + fmt(f.cancellation) + ")" };
    if (!isFinite(f.consideration)) return { code: "form", why: "Consideration Amount ফাঁকা" };
    if (f.consideration < 0) return { code: "form", why: "Consideration Amount ঋণাত্মক (" + fmt(f.consideration) + ")" };
    if (f.consideration > f.cancellation) return { code: "form", why: "Consideration (" + fmt(f.consideration) + ") Cancellation-এর (" + fmt(f.cancellation) + ") চেয়ে বেশি" };
    if (f.cashBack > f.paid) return { code: "form", why: "Cash Back (" + fmt(f.cashBack) + ") আগে দেওয়া টাকার (" + fmt(f.paid) + ") চেয়ে বেশি" };
    if (f.currentDue > 0 && f.allCancelled) return { code: "alldue", why: "Program-এর সব course বাতিল হলে বকেয়া রাখা যায় না — Current Due " + fmt(f.currentDue) + ", আগে বকেয়া মেটাতে হবে" };
    if (f.currentDue > 0 && !cell(f.nextDate)) return { code: "needdate", why: "Current Due " + fmt(f.currentDue) + " থাকছে — Next Receiving Date লাগবে" };
    return null;
  }

  /* The "zero taka only" guard (💰, on whenever the menu opens). The first live sheet cancels free
     courses — course 3156, a trial exam at 0 — so a taka anywhere on the form means the row is not
     the kind the sheet was written for, and it is skipped before anything is sent (asked for on
     17 Oct 2026: "onno amount ashle oyta skip korbe"). Every money field the form shows is read. A
     blank Deduction counts as 0 — the page leaves that box empty until a course is clicked — but any
     other blank or unreadable amount is NOT zero. null = every amount is 0. */
  const MONEY = [["due", "Previous Due"], ["cancellation", "Cancellation"], ["deduction", "Deduction"],
    ["discount", "Discount"], ["consideration", "Consideration"], ["cashBack", "Cash Back"], ["currentDue", "Current Due"]];
  function nonZero(f) {
    const hit = MONEY.filter(function (m) {
      const v = f[m[0]];
      if (m[0] === "deduction" && !isFinite(v)) return false;
      return !(isFinite(v) && v === 0);
    });
    if (!hit.length) return null;
    return { code: "money", why: "শুধু ০ টাকার বাতিল চালু — " +
      hit.map(function (m) { return m[1] + " " + fmt(f[m[0]]); }).join(" · ") + " — বাদ, কিছু পাঠানো হয়নি" };
  }

  /* where UMS sends the browser after a successful cancellation:
     /Student/Payment/GenerateMoneyReciept/<id> — the id is a path segment here, not ?id= */
  function receiptOf(url) {
    const s = String(url || "");
    let m = s.match(/\/Student\/Payment\/GenerateMoneyReciept\/([^?#/]+)/i);
    if (!m) m = s.match(/GenerateMoneyReciept[^?#]*\?(?:[^#]*&)?(?:id|studentPaymentIdList)=([^&#]+)/i);
    if (!m) return null;
    try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
  }
  function isLogin(url) { return /\/Account\/Login/i.test(String(url || "")); }

  /* Which servers this menu may write to: osl.team (the test/staging UMS New Admission also writes
     to) and orgbd.net, where the cancellations were asked for. umsbd.net — and anything else — stays
     read-only, as it is for New Admission (menus/adm/adm.js admIsOsl). Over https only, and by the
     host's last labels, so "orgbd.net.example.com" is not orgbd.net. background.js ccCanWrite draws
     the same line again on its side. */
  function canWrite(base) {
    try { const u = new URL(base); return /^https:$/i.test(u.protocol) && /(^|\.)(osl\.team|orgbd\.net)$/i.test(u.hostname); }
    catch (e) { return false; }
  }

  root.UMSCANCEL = {
    looksReg: looksReg, detectCols: detectCols, parseRow: parseRow, splitPaste: splitPaste,
    parseInput: parseInput, groupJobs: groupJobs, pickApprover: pickApprover, checkForm: checkForm, nonZero: nonZero,
    receiptOf: receiptOf, isLogin: isLogin, canWrite: canWrite, fmt: fmt
  };
})(self);
