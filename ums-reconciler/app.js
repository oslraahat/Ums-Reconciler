/* UMS Payment Verify — full-screen dashboard (extension page).
 * Runs in the user's session (cross-origin fetch with credentials, host permission).
 * Reconcile logic reused from reconcile.js (self.UMSREC). */
(function () {
  "use strict";
  const U = self.UMSREC;
  const $ = function (id) { return document.getElementById(id); };
  const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  function mmss(ms) { const s = Math.floor(ms / 1000); return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0"); }

  // tol 0 like the CLI: at 1 the near() test swallows exactly the ৳1 row-wise differences we are
  // hunting for. Still editable in Settings if a run needs slack.
  let baseUrl = "https://ums-5.osl.team", conc = 25, tol = 0, inputMode = "auto";
  let importedRows = null, importedHeader = null, entries = [];
  let students = [], run = null, _token = null, renderBuf = null;

  function payBase() { return baseUrl.replace(/\/+$/, "") + "/Student/Payment/"; }

  // ---------- i18n ----------
  let lang = "bn";
  const DICT = {
    subtitle: { bn: "Program Wise ⇄ Course Wise — Registration No. ও StudentProgramId দিন, রান চাপুন, রিপোর্ট পান", en: "Program Wise ⇄ Course Wise — enter Registration No. & StudentProgramId, run, get the report" },
    conn_h: { bn: "সংযোগ", en: "Connection" }, conn_unchecked: { bn: "যাচাই করা হয়নি", en: "not checked" },
    base_l: { bn: "UMS ঠিকানা (Base URL)", en: "UMS address (Base URL)" }, test: { bn: "Test Connection", en: "Test Connection" }, save: { bn: "সেভ করুন", en: "Save" },
    sess_hint: { bn: "এই ব্রাউজারে UMS-এ লগইন থাকা অবস্থায় চলবে (সেশন ব্যবহার করে)। আলাদা email/password লাগে না।", en: "Works while you are logged in to UMS in this browser (uses the session). No separate email/password needed." },
    verify_h: { bn: "কী মিলিয়ে দেখা হবে", en: "What to Reconciliation" },
    in_hint: { bn: "Excel/CSV বা Google Sheet import করুন — Reg No ও StudentProgramId কলাম অটো ধরা পড়বে।", en: "Import an Excel/CSV file or a Google Sheet — the Reg No and StudentProgramId columns are auto-detected." },
    import_btn: { bn: "⬆ Import Excel", en: "⬆ Import Excel" }, link_btn: { bn: "↧ Sheet Link", en: "↧ Sheet Link" },
    link_ph: { bn: "…অথবা Google Sheet লিংক", en: "…or a Google Sheet link" },
    paste_ph: { bn: "…অথবা এখানে পেস্ট করো — প্রতি লাইনে: Student Reg, Student Program ID", en: "…or paste here — one line each: Student Reg, Student Program ID" },
    paste_btn: { bn: "✓ Check", en: "✓ Check" },
    paste_empty: { bn: "পেস্ট বক্সটা ফাঁকা — Reg ও Program Id বসিয়ে আবার Check চাপো", en: "Paste box is empty — put Reg and Program Id in it, then press Check" },
    paste_norow: { bn: "কোনো Reg পাওয়া গেল না — প্রতি লাইনে Reg (ও চাইলে Program Id) থাকতে হবে", en: "No Reg found — each line needs a Reg (and optionally a Program Id)" },
    imp_default: { bn: "", en: "" }, clear_btn: { bn: "✕ Clear", en: "✕ Clear" }, pv_reg: { bn: "Reg No.", en: "Reg No." },
    pv_search_ph: { bn: "খুঁজুন…", en: "Search…" },
    pv_more: { bn: "দেখাচ্ছে {a}টি / মোট {b}টি", en: "showing {a} of {b}" }, pv_none: { bn: "কিছু মিলল না", en: "no match" },
    imp_uniq: { bn: "টি ইউনিক Reg", en: "unique Reg" },
    imp_uniq_pair: { bn: "টি ইউনিক (Reg+Id)", en: "unique (Reg+Id)" }, imp_dropped: { bn: "টি ডুপ্লিকেট বাদ", en: "duplicate(s) dropped" }, imp_will_run: { bn: "টি চলবে", en: "will run" }, imp_noreg: { bn: "টিতে Reg নেই", en: "without a Reg" }, imp_trim: { bn: "টিতে Reg ঘরে একাধিক সংখ্যা ছিল, প্রথমটা নেওয়া হয়েছে", en: "had more than one number in the Reg cell — first one used" },
    imp_checking: { bn: "কোন কলামে কী, UMS-এ মিলিয়ে দেখা হচ্ছে…", en: "checking with UMS which column is which…" },
    imp_swap: { bn: "কলাম উল্টো ছিল — Reg আর Student PID বদলে নেওয়া হয়েছে", en: "columns were the wrong way round — Reg and Student PID swapped back" },
    rr_run: { bn: "টি আবার চালাও", en: "to re-run" }, rr_none: { bn: "কিছু নেই", en: "nothing here" }, rr_busy: { bn: "চলছে…", en: "running…" },
    settings_h: { bn: "সেটিংস ও রান", en: "Settings & Run" }, tol_l: { bn: "গ্রহণযোগ্য পার্থক্য", en: "Tolerance" }, conc_l: { bn: "একসাথে কয়টি অনুরোধ", en: "Parallel requests" },
    run_btn: { bn: "▶ Start", en: "▶ Start" },
    imp_row: { bn: "টি", en: "entries" }, imp_more: { bn: "আরও ফাইল দিতে ক্লিক করুন", en: "click to add more files" }, imp_empty: { bn: "ফাইল খালি", en: "File empty" },
    imp_excel: { bn: "⏳ Excel পড়ছি…", en: "⏳ Reading Excel…" }, imp_excel_fail: { bn: "Excel পড়া গেল না", en: "Could not read Excel" },
    imp_sheet: { bn: "⏳ Sheet আনছি…", en: "⏳ Fetching Sheet…" }, imp_login: { bn: "Google লগইন/অ্যাক্সেস দরকার", en: "Google login/access needed" }, imp_fail: { bn: "আনা গেল না", en: "Could not fetch" }, imp_badlink: { bn: "লিংক ঠিক নয়", en: "Invalid link" },
    e_need: { bn: "spid বা program দাও", en: "give spid or program" }, e_pw: { bn: "Program Wise data নেই (redirect/ভুল spid?)", en: "No Program Wise data (redirect/wrong spid?)" }, e_cw: { bn: "Course Wise redirect — reg/permission?", en: "Course Wise redirect — reg/permission?" }, e_perm: { bn: "search permission নেই", en: "no search permission" }, e_regspid: { bn: "reg == spid — কলাম ভুল?", en: "reg == spid — wrong column?" },
    results_h: { bn: "ফলাফল", en: "Results" }, ready: { bn: "প্রস্তুত", en: "Ready" },
    t_ok: { bn: "মিলেছে", en: "Matched" }, t_no: { bn: "অমিল", en: "Mismatch" }, t_cw: { bn: "CW ফাঁকা", en: "CW Empty" }, t_zero: { bn: "Zero Pay", en: "Zero Pay" }, t_stu: { bn: "Total Problem", en: "Total Problem" }, t_nf: { bn: "Program পাওয়া যায়নি", en: "Program Not Found" }, t_err: { bn: "লোড এরর", en: "Load error" },
    tt_prob: { bn: "অমিল + CW ফাঁকা + Program পাওয়া যায়নি + লোড এরর — সব মিলিয়ে (Reg + Student PID ধরে)। Zero Pay এতে নেই — টাকাই ওঠেনি, মেলানোর কিছু নেই", en: "Mismatch + CW empty + Program not found + Load error, all together (by Reg + Student PID). Zero Pay is not in it — no money was ever taken, so there is nothing to reconcile" },
    f_all: { bn: "সব", en: "All" }, f_no: { bn: "শুধু অমিল", en: "Mismatch" }, f_ok: { bn: "শুধু মিলেছে", en: "Matched" }, f_cw: { bn: "শুধু CW ফাঁকা", en: "CW Empty" }, f_zero: { bn: "Zero Pay", en: "Zero Pay" }, f_nf: { bn: "Program পাওয়া যায়নি", en: "Program Not Found" },
    pill_ok: { bn: "✓ মিলেছে", en: "✓ Matched" }, pill_no: { bn: "✕ অমিল", en: "✕ Mismatch" }, pill_cw: { bn: "CW ফাঁকা", en: "CW Empty" }, pill_zero: { bn: "Zero Pay", en: "Zero Pay" }, pill_nf: { bn: "Program পাওয়া যায়নি", en: "Program Not Found" }, pill_error: { bn: "লোড এরর", en: "Load error" },
    p_verifying: { bn: "যাচাই", en: "Verified" }, p_running: { bn: "চলছে", en: "running" }, p_done: { bn: "শেষ", en: "Done" }, p_input: { bn: "ইনপুট দাও", en: "Enter input" },
    conn_ok: { bn: "✓ লগইন আছে", en: "✓ Logged in" }, conn_no: { bn: "✗ লগইন নেই", en: "✗ Not logged in" }, conn_fail: { bn: "✗ সংযোগ ব্যর্থ", en: "✗ Connection failed" },
    items: { bn: "টি", en: "items" }, stu_checked: { bn: "টি Program যাচাই · মোট", en: "program(s) checked · of" }, stu_of: { bn: "টির মধ্যে", en: "total" },
    d_allmatch: { bn: "সব মিলেছে", en: "all matched" }, d_cwempty: { bn: "Course Wise ফাঁকা (No Data)", en: "Course Wise empty (No Data)" }, d_tries: { bn: "বার চেষ্টা করা হয়েছে", en: "attempts" }, d_zero: { bn: "কোনো Payment হয়নি — সব ঘরে ০, Course Wise ফাঁকা থাকাই স্বাভাবিক", en: "No payment at all — every figure is 0, so an empty Course Wise is expected" },
    d_cwredir: { bn: "Course Wise পাতাটা খুললই না (reg ভুল, নাকি permission নেই?) — Program Wise ঠিকই এসেছে", en: "Course Wise page did not open (wrong reg, or no permission?) — Program Wise loaded fine" },
    d_cwnotable: { bn: "Course Wise পাতা এসেছে, কিন্তু টেবিলটাই পাওয়া গেল না (permission, নাকি পাতার markup বদলেছে?) — ফাঁকা নয়, কিছুই পড়া হয়নি", en: "Course Wise page loaded but its table was not found (permission, or the page markup changed?) — not empty, nothing was read at all" },
    d_noprog: { bn: "এই Student-এর এমন কোনো Program নেই", en: "This student has no such program" }, d_has: { bn: "· আছে:", en: "· has:" },
    d_onlyprog: { bn: "শুধু Program-এ", en: "only in Program" }, d_onlycourse: { bn: "শুধু Course-এ", en: "only in Course" }, d_deduction: { bn: "Deduction", en: "Deduction" }, d_cross: { bn: "cross-view/timing", en: "cross-view/timing" },
    src_sheet: { bn: "শিট", en: "Sheet" }, src_link: { bn: "Google Sheet", en: "Google Sheet" }, src_paste: { bn: "✎ পেস্ট বক্স", en: "✎ Paste box" },
    mk_do: { bn: "✓ Mark as Matched", en: "✓ Mark as Matched" }, mk_undo: { bn: "↺ Undo", en: "↺ Undo" },
    mk_tip: { bn: "UMS-এ হাতে দেখে ঠিক পেয়েছি — মিলেছে ধরো", en: "Checked by hand in UMS and found correct — treat as matched" },
    mk_tip_undo: { bn: "হাতে-দেওয়া রায় তুলে নাও", en: "Take the manual verdict back" },
    pill_manual: { bn: "✓ মিলেছে · হাতে দেখা", en: "✓ Matched · checked" },
    saved: { bn: "✓ সেভ হয়েছে", en: "✓ Saved" }, checking: { bn: "…", en: "…" },
    pause: { bn: "⏸ Pause", en: "⏸ Pause" }, resume: { bn: "▶ Resume", en: "▶ Resume" }, paused: { bn: "⏸ থামানো (Resume চাপো)", en: "⏸ Paused (press Resume)" },
    stopping: { bn: "⏹ থামানো হচ্ছে…", en: "⏹ Stopping…" }
  };
  function t(k) { const e = DICT[k]; return e ? (e[lang] || e.bn) : k; }
  function applyLang(l) {
    lang = (l === "en") ? "en" : "bn";
    document.querySelectorAll("[data-i18n]").forEach(function (el) { const s = t(el.getAttribute("data-i18n")); if (s != null) el.textContent = s; });
    document.querySelectorAll("[data-ph]").forEach(function (el) { const s = t(el.getAttribute("data-ph")); if (s != null) el.setAttribute("placeholder", s); });
    const b = $("lang"); if (b) b.textContent = (lang === "bn" ? "EN" : "BN");
    const pv = $("preview"); if (pv) pv.removeAttribute("data-col"); // force head rebuild in the new language
    updateCount(); rerenderList(); renderPreview(); paintRerun();
  }

  // ---------- scrape ----------
  // Column naming, money parsing and table reading all live in reconcile.js (the CLI's parse.js).
  function scrape(table, type) { return U.parseTable(table, type === "course" ? "cw" : "pw"); }
  /* The header region of a table fragment: <thead> when there is one, else the first few rows —
     the same region content.js reads off the live DOM. Row one alone was not enough: a search or
     filter row, a grouped header, or a DataTables split header pushes the real labels below it,
     and the old test (row one must hold mrn AND current due AND received) then missed the table
     entirely. The student came back "Program পাওয়া যায়নি" while the in-page panel, which already
     scored the region, read the very same page. */
  function headOf(frag) {
    const th = frag.match(/<thead[\s\S]*?<\/thead>/i);
    return th ? th[0] : (frag.match(/(?:<tr[\s\S]*?<\/tr>\s*){1,3}/i) || [""])[0];
  }
  function sliceTable(html, type) {
    if (type === "course") { const i = html.indexOf('id="courseWisePaymentTable"'); if (i < 0) return null; const s = html.lastIndexOf("<table", i), e = html.indexOf("</table>", i); return (s >= 0 && e >= 0) ? html.slice(s, e + 8) : null; }
    // best-scoring table wins, exactly as in content.js findTable() — U.headScore is shared
    let idx = 0, best = null, bestScore = 0;
    while (true) {
      const s = html.indexOf("<table", idx); if (s < 0) break;
      const e = html.indexOf("</table>", s); if (e < 0) break;
      const frag = html.slice(s, e + 8);
      const sc = U.headScore(headOf(frag));
      if (sc > bestScore) { bestScore = sc; best = frag; }
      idx = e + 8;
    }
    return best;
  }
  function parseFrag(frag) { return frag ? new DOMParser().parseFromString(frag, "text/html").querySelector("table") : null; }

  async function fetchHtml(url) {
    let last;
    for (let a = 0; a < 3; a++) {   // up to 3 tries with growing back-off — fewer load errors at high concurrency
      try {
        const r = await fetch(url, { credentials: "include", signal: run && run.ac ? run.ac.signal : undefined });
        if ((r.status >= 500 || r.status === 429) && a < 2) { await sleep(400 * (a + 1)); continue; }
        return { html: await r.text(), redirected: r.redirected, status: r.status, ok: r.ok };
      } catch (e) { if (e && e.name === "AbortError") throw e; last = e; await sleep(400 * (a + 1)); }
    }
    throw last || new Error("fetch failed");
  }
  function pwUrl(reg, spid) { return payBase() + "HistoryOfPayment?studentProgramId=" + encodeURIComponent(spid) + "&programId=0&sessionId=0&stdRollOrRegistrationNo=" + encodeURIComponent(reg); }
  function cwUrl(reg, spid) { return payBase() + "HistoyOfPaymentCourseWise?studentProgramId=" + encodeURIComponent(spid) + "&stdRollOrRegistrationNo=" + encodeURIComponent(reg); }

  /* Has the Course Wise side given a real answer yet? A table with rows, or a table that says
     "No Data" in so many words, is settled — the server has spoken. A redirect, or a page with no
     table in it, is not an answer at all; nothing was read, so there is nothing to conclude. */
  function cwSettled(c, cw) {
    if (c.redirected) return false;
    if (!cw || !cw.ok) return false;
    return cw.rows.length > 0 || cw.noData === true;
  }

  async function testOne(reg, spid) {
    // Fetch both pages at once — the two round-trips overlap instead of running back-to-back.
    const pP = fetchHtml(pwUrl(reg, spid)), pC = fetchHtml(cwUrl(reg, spid));
    const p = await pP;
    const pw = scrape(parseFrag(sliceTable(p.html, "program")), "program");
    if (!pw || !pw.ok || !pw.rows.length) { pC.catch(function () {}); return { kind: "error", msg: t("e_pw"), notFound: true }; }
    /* Program Wise came back, so this student loaded fine — only the Course Wise side produced
       nothing. Calling that a Load Error put it in the wrong bucket and made it look like a
       connection problem worth retrying; it belongs with the other students whose Course Wise
       side is empty, where the Program Wise receipts are still listed and still checkable. */
    let c = await pC;
    let cTable = c.redirected ? null : parseFrag(sliceTable(c.html, "course"));
    let cw = cTable ? scrape(cTable, "course") : null;

    /* Wait for the Course Wise side to actually arrive. "Nothing came back" has two very different
       meanings, and only one of them is an answer: a table that is present and says No Data is the
       server's final word, while a page that redirected — or that arrived without the table in it
       at all — means nothing was ever read. The in-page panel already waits for the table to show
       up (content.js captureWhenReady); the batch runner took the first reply and filed the
       student under CW ফাঁকা for good, so a slow session or a half-built response became a
       permanent verdict. Unread answers are fetched again, twice, with a growing pause.
       A settled No Data is never re-requested — a run holds hundreds of them. */
    let cwTries = 1;
    while (cwTries < 3 && !cwSettled(c, cw)) {
      await sleep(600 * cwTries);
      try { c = await fetchHtml(cwUrl(reg, spid)); }
      catch (e) { if (e && e.name === "AbortError") throw e; break; }   // Stop pressed
      cTable = c.redirected ? null : parseFrag(sliceTable(c.html, "course"));
      cw = cTable ? scrape(cTable, "course") : null;
      cwTries++;
    }
    const cwEmpty = !cw || !cw.ok || cw.rows.length === 0;
    /* Three different things used to arrive as one "Course Wise ফাঁকা (No Data)":
         redirected   → the page never opened (wrong reg / no permission)
         no table     → the page opened, but #courseWisePaymentTable was not in it
         no rows      → the table is there and genuinely says No Data — the only benign one
       Only the last needs no action, and the middle one is not "empty" at all: nothing was ever
       read. Told apart, a run's largest bucket says which of the three each student is. */
    const cwNoTable = !c.redirected && !cTable;
    const cwData = (cw && cw.ok) ? cw : { ok: true, rows: [], cols: {}, totalRow: null, noData: true };
    return { kind: "done", pw: pw, cw: cwData, cwEmpty: cwEmpty, cwRedirect: !!c.redirected,
      cwNoTable: cwNoTable, cwTries: cwTries, result: U.compare(pw, cwData, { tolerance: tol }) };
  }

  // ---------- reg → program resolve ----------
  async function getToken() {
    if (_token != null) return _token;
    try { const r = await fetchHtml(payBase() + "PaymentHistory"); const m = r.html.match(/name="__RequestVerificationToken"[^>]*value="([^"]+)"/); _token = m ? m[1] : ""; }
    catch (e) { _token = ""; }
    return _token;
  }
  async function resolvePrograms(reg) {
    const tok = await getToken();
    const headers = { "X-Requested-With": "XMLHttpRequest", "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" };
    if (tok) headers["RequestVerificationToken"] = tok;
    const r = await fetch(payBase() + "GenerateStudentProgramDetails", { method: "POST", credentials: "include", headers: headers, body: "stdRollOrRegistrationNo=" + encodeURIComponent(reg) + "&isWithInactive=true&isPaymentHistory=true" });
    const html = await r.text();
    if (r.redirected || /Permission Denied|PermissionDenied/i.test(html)) throw new Error(t("e_perm"));
    const doc = new DOMParser().parseFromString(html, "text/html");
    return [].slice.call(doc.querySelectorAll("#DataGrid tbody tr")).map(function (tr) {
      const tds = tr.querySelectorAll("td"); const a = tr.querySelector('a[href*="studentProgramId="]');
      let spid = ""; if (a) { const m = a.getAttribute("href").match(/studentProgramId=(\d+)/); if (m) spid = m[1]; }
      return { program: tds[1] ? tds[1].textContent.trim() : "", session: tds[2] ? tds[2].textContent.trim() : "", spid: spid };
    }).filter(function (x) { return x.spid; });
  }
  function norm(s) { return String(s || "").toLowerCase().replace(/\s+/g, " ").trim(); }
  function matchEntry(list, e) {
    const wp = norm(e.program), ws = norm(e.session || "");
    if (ws) { const h = list.find(function (p) { return norm(p.program) === wp && norm(p.session) === ws; }); if (h) return h; }
    return list.find(function (p) { return norm(p.program) === wp; })
      || list.find(function (p) { return norm(p.program).indexOf(wp) >= 0 || wp.indexOf(norm(p.program)) >= 0; }) || null;
  }

  // ---------- input parsing ----------
  function parseEntries(text) {
    return text.split(/\n+/).map(function (ln) {
      const t = ln.trim(); if (!t) return null;
      let reg, rest;
      const ci = t.indexOf(",");
      if (ci >= 0) { reg = t.slice(0, ci).trim(); rest = t.slice(ci + 1).trim(); }
      else { const m = t.match(/^(\S+)\s+(.+)$/); if (m) { reg = m[1]; rest = m[2].trim(); } else { reg = t; rest = ""; } }
      if (!reg) return null;
      if (!rest) return { reg: reg };
      if (inputMode === "spid") return { reg: reg, spid: rest };
      if (inputMode === "program") return { reg: reg, program: rest };
      return /^\d+$/.test(rest) ? { reg: reg, spid: rest } : { reg: reg, program: rest };
    }).filter(Boolean);
  }
  function buildStudents(entries) {
    const map = {}; const order = [];
    entries.forEach(function (e) {
      if (!map[e.reg]) { map[e.reg] = { reg: e.reg, items: [], _resolved: null, results: [] }; order.push(e.reg); }
      map[e.reg].items.push({ program: e.program, session: e.session, spid: e.spid });
    });
    return order.map(function (r) { return map[r]; });
  }

  // ---------- run ----------
  // the CLI's runner.js ladder: error → Course Wise empty → errors → warnings → clean
  function statusOf(out) {
    // no Program Wise rows means the program was not found for this reg/spid — its own bucket,
    // not a load error and not a reconciliation failure
    if (out.kind === "error") return out.notFound ? "nf" : "error";
    const r = out.result;
    /* No payment was ever made: Program Wise has rows but every figure on them is 0, so Course
       Wise having nothing is the correct outcome, not a gap. It used to sit inside CW ফাঁকা and
       be counted as a problem — it is neither. compare() already tells them apart. */
    if (r.zeroPayment) return "zero";
    if (out.cwEmpty || r.emptyCourseWise) return "cw";
    if (r.errors.length) return "no";
    return "ok";
  }
  /* Course Wise is re-fetched while it has not really answered, so a line that still reports it
     empty should say the waiting happened — otherwise "try again" is the first thing anyone thinks. */
  function tries(out) { return out.cwTries > 1 ? " (" + out.cwTries + " " + t("d_tries") + ")" : ""; }
  // one-line headline for the on-screen list; the export keeps the full itemDetail()
  function shortLine(st, out) {
    if (out.kind === "error") return out.msg;
    if (st === "ok") return t("d_allmatch");
    if (st === "zero") return U.summary(out.result) || t("d_zero");
    // summary() reports "Course Wise ফাঁকা", which hides both the page never opening and its table
    // never being found — but Program Wise was still read and checked, so keep whatever it found
    if (st === "cw" && out.cwRedirect) return t("d_cwredir") + tries(out) + U.pwFindings(out.result);
    if (st === "cw" && out.cwNoTable) return t("d_cwnotable") + tries(out) + U.pwFindings(out.result);
    return U.summary(out.result) || itemDetail(st, out);
  }
  function itemDetail(st, out) {
    if (out.kind === "error") return out.msg;
    if (st === "ok") return t("d_allmatch");
    const r = out.result; const parts = [];
    if (st === "zero") return t("d_zero");
    if (st === "cw") {
      // "did not open", "table not found" and "opened but empty" all land here, and each needs a
      // different fix — only the last one is benign
      parts.push((out.cwRedirect ? t("d_cwredir") : out.cwNoTable ? t("d_cwnotable") : t("d_cwempty")) + tries(out));
      /* Course Wise being empty stops the two pages being compared — it does not stop Program
         Wise being checked, and compare() does check it (§3.5, due chain, row sanity, row order).
         Those findings were computed and then dropped right here, so the largest bucket of a run
         exported a Details column saying only "Course Wise ফাঁকা". Numbered, like the other rows. */
      (r.errors || []).forEach(function (e, i) { parts.push((i + 1) + ") " + U.shortError(e)); });
      (r.notes || []).forEach(function (n) { parts.push(n.detail); });
      return parts.join(" | ");
    }
    const cat = r.errors.length ? U.classify(r) : null;
    // label alone reads as jargon in an exported sheet, so carry the plain-words line with it
    if (cat) parts.push(cat.label + (cat.why && !cat.selfEvident ? " (" + cat.why + ")" : ""));
    /* numbered, so a cell holding six findings can be read; "✕ … · ✕ …" ran together */
    (r.errors || []).forEach(function (e, i) { parts.push((i + 1) + ") " + U.shortError(e)); });
    U.shortWarnings(r.warnings).forEach(function (w) { parts.push("⚠ " + w); });
    return parts.join("   ") || (st === "warn" ? t("d_cross") : "");
  }

  async function processItem(stu, item) {
    let spid = item.spid;
    if (!spid) {
      if (!item.program) return { st: "error", detail: t("e_need"), spid: "" };
      if (!stu._resolved) { try { stu._resolved = await resolvePrograms(stu.reg); } catch (e) { return { st: "error", detail: String(e.message || e), spid: "" }; } }
      const m = matchEntry(stu._resolved, item);
      if (!m) return { st: "nf", detail: t("d_noprog") + (stu._resolved.length ? " " + t("d_has") + " " + stu._resolved.map(function (x) { return x.program; }).join(", ") : ""), spid: "" };
      spid = m.spid;
    }
    if (String(spid).trim() === String(stu.reg).trim()) return { st: "error", detail: t("e_regspid"), spid: spid };
    /* A load failure is the session or the network, not the data, so it retries itself — twice
       more, with a growing pause. There is no Load error tile to press ⟳ on any more (the slot is
       Zero Pay now), and a fault that clears on its own should never have needed a person.
       fetchHtml() already retries a 5xx/429 inside one attempt; this covers the whole student. */
    let out;
    for (let a = 0; a < 3; a++) {
      try { out = await testOne(stu.reg, spid); break; }
      catch (e) {
        out = { kind: "error", msg: String((e && e.message) || e) };
        if (e && e.name === "AbortError") break;      // Stop was pressed — do not keep trying
        if (a < 2) await sleep(500 * (a + 1));
      }
    }
    const st = statusOf(out);
    const cat = out.result && out.result.errors && out.result.errors.length ? U.classify(out.result) : null;
    /* Keep the raw cells of anything that still needs a person. Arguing about whether a receipt is
       really a mismatch takes the actual numbers off both pages, and pulling those out of UMS by
       hand — one student at a time, eleven columns each — is where the day goes. They are already
       parsed and in memory; holding them costs a couple of KB per flagged student and nothing at
       all for the clean ones, which are the overwhelming majority. */
    const raw = (notOk(st) && out.kind === "done")
      ? U.rawText(out.pw, out.cw, { spid: spid, reg: stu.reg }) : "";
    const res0 = { st: st, detail: shortLine(st, out), detailFull: itemDetail(st, out),
      why: cat ? cat.why : "", whySelf: !!(cat && cat.selfEvident), raw: raw,
      spid: spid, program: item.program || "" };
    applyManual(res0, stu.reg);
    return res0;
  }

  /* Total Problem = everything that still needs a person. "ok" is clean; so is "zero" — a student
     who never paid has nothing to reconcile, and counting them as problems put hundreds of
     perfectly ordinary records on the work list. */
  const notOk = function (st) { return st !== "ok" && st !== "zero"; };
  /* Findings a person has gone to UMS, checked by hand, and judged correct. Kept against the
     exact wording of the finding they cleared: if the rules change, or the receipt does, the
     signature stops matching and the student comes back for a fresh look rather than staying
     silently cleared. Keyed by Reg + Student PID, the same pair everything else counts on. */
  let manualOk = {};
  const manualKey = function (reg, spid) { return reg + "|" + spid; };
  function saveManual() { try { chrome.storage.local.set({ manualOk: manualOk }); } catch (e) {} }
  /* A cleared finding still IS the finding — the detail stays, so the report never pretends the
     receipt was clean. Only the verdict moves, and `manual` says who moved it. */
  function applyManual(res, reg) {
    if (!notOk(res.st)) return res;
    if (manualOk[manualKey(reg, res.spid)] !== res.detail) return res;
    res.manualOf = res.st; res.st = "ok"; res.manual = true;
    return res;
  }
  function markStudent(stu, undo) {
    (stu.results || []).forEach(function (x) {
      const k = manualKey(stu.reg, x.res.spid);
      if (undo) {
        if (!x.res.manual) return;
        x.res.st = x.res.manualOf; x.res.manual = false; delete x.res.manualOf;
        delete manualOk[k];
      } else {
        if (!notOk(x.res.st)) return;
        x.res.manualOf = x.res.st; x.res.st = "ok"; x.res.manual = true;
        manualOk[k] = x.res.detail;      // the exact finding this verdict answers
      }
    });
    saveManual(); recountAll(); paintTiles(); rerenderList(); applyFilterAll();
  }
  const T = { ok: 0, no: 0, cw: 0, zero: 0, nf: 0, err: 0, stu: 0, done: 0, total: 0 };
  function bumpTile(st) { if (st === "ok") T.ok++; else if (st === "no") T.no++; else if (st === "cw") T.cw++; else if (st === "zero") T.zero++; else if (st === "nf") T.nf++; else T.err++; }
  function paintTiles() {
    $("t-ok").textContent = T.ok; $("t-no").textContent = T.no;
    $("t-cw").textContent = T.cw; $("t-stu").textContent = T.stu; $("t-nf").textContent = T.nf;
    if ($("t-zero")) $("t-zero").textContent = T.zero;
    /* Every failing bucket rolled into one number, on the same Reg + PID basis as the rest, so
       this tile is always their sum — if it ever is not, something above is miscounting. */
    const probTile = document.querySelector('.tile[data-f="prob"]');
    if (probTile) probTile.title = t("tt_prob");
    paintRerun();
  }

  /* Re-run just one bucket. A load error is usually the session or the network, not the data —
     re-running only those beats starting the whole sheet again. Works for any tile. */
  function pickByStatus(st) {
    const out = [];
    students.forEach(function (stu) {
      (stu.results || []).forEach(function (x) {
        const hit = st === "prob" ? notOk(x.res.st) : x.res.st === st;
        if (hit) out.push({ stu: stu, slot: x });
      });
    });
    return out;
  }
  function recountAll() {
    ["ok", "no", "cw", "zero", "nf", "err", "stu"].forEach(function (k) { T[k] = 0; });
    /* A student is one Reg + Student PID pair (that is the key duplicates are dropped on at
       import), so a Reg listed against two programs is two students here. Counting by Reg alone
       made this tile read one short of the buckets above it. */
    students.forEach(function (stu) {
      (stu.results || []).forEach(function (x) {
        bumpTile(x.res.st);
        if (notOk(x.res.st)) T.stu++;
      });
    });
  }
  function paintRerun() {
    const busy = !!run;
    [].slice.call(document.querySelectorAll(".rr")).forEach(function (b) {
      const st = b.getAttribute("data-rr");
      const n = pickByStatus(st).length;
      b.disabled = busy || n === 0;
      b.title = busy ? t("rr_busy") : (n ? n + " " + t("rr_run") : t("rr_none"));
    });
  }
  async function rerunStatus(st) {
    if (run) return;
    const jobs = pickByStatus(st);
    if (!jobs.length) return;
    run = { stop: false, paused: false, ac: (typeof AbortController !== "undefined" ? new AbortController() : null) };
    $("run").disabled = true; $("stop").disabled = false;
    $("pause").disabled = false; $("pause").textContent = t("pause");
    paintRerun();
    const t0 = Date.now();
    let done = 0, next = 0;
    const tick = function () {
      $("prog").textContent = "⟳ " + t("p_verifying") + " " + done + "/" + jobs.length + " · ⏱ " + mmss(Date.now() - t0);
    };
    tick();
    async function worker() {
      while (!run.stop) {
        while (run.paused && !run.stop) { $("prog").textContent = t("paused"); await sleep(200); }
        const i = next++; if (i >= jobs.length) return;
        const j = jobs[i];
        let res;
        // one bad item must not sink the whole re-run — record it and carry on
        try { res = await processItem(j.stu, j.slot.item); }
        catch (e) { res = { st: "error", detail: String((e && e.message) || e), spid: j.slot.res.spid || "" }; }
        if (run.stop) return;
        j.slot.res = res;            // replace in place — order and student grouping stay put
        done++; tick();
        if (done % 10 === 0) { recountAll(); paintTiles(); }   // tiles move while it runs
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.min(Math.max(1, conc), jobs.length) }, function () { return worker(); }));
    } finally {
      // whatever happened, never leave `run` set — that would disable every button for good
      const stopped = run && run.stop;
      run = null;
      recountAll(); paintTiles(); rerenderList(); applyFilterAll();
      $("run").disabled = !entries.length; $("stop").disabled = true; $("pause").disabled = true;
      $("prog").textContent = "✅ " + t("p_done") + " · " + done + "/" + jobs.length +
        " · ⏱ " + mmss(Date.now() - t0) + (stopped ? " · " + t("stopping") : "");
    }
  }

  async function startRun() {
    if (!entries.length) { $("prog").textContent = t("p_input"); return; }
    students = buildStudents(entries);
    run = { stop: false, paused: false, ac: (typeof AbortController !== "undefined" ? new AbortController() : null) };
    ["ok", "no", "cw", "zero", "nf", "err", "stu", "done"].forEach(function (k) { T[k] = 0; });
    /* One unit of work is one Reg + Student PID pair — the key duplicates are dropped on at import,
       and the basis every tile counts on. students[] groups by Reg alone (a Reg against two
       programs is ONE card carrying two rows), so its length is the card count, not the work
       count: a 10,515-pair sheet spread over 9,832 Regs read "Done · 9832/9832" while the tiles
       above it added up to 10,515. Count the pairs — entries.length is exactly Σ items.length. */
    T.total = entries.length;
    $("list").innerHTML = ""; paintTiles(); $("fill").style.width = "0%";
    $("run").disabled = true; $("stop").disabled = false; $("pause").disabled = false; $("pause").textContent = t("pause");
    $("html").disabled = true; $("xlsx").disabled = true; $("raw").disabled = true;
    const t0 = Date.now();
    let next = 0, running = 0;
    function prog() { const pct = T.total ? Math.round(T.done / T.total * 100) : 0; $("prog").textContent = "⏳ " + T.done + "/" + T.total + " · " + pct + "% · ⏱ " + mmss(Date.now() - t0) + " · " + t("p_running") + " " + running; }
    // Batched UI: DOM cards + tiles + progress repaint at most ~every 120ms so the main thread stays free to dispatch fetches.
    renderBuf = document.createDocumentFragment();
    let lastUI = 0, uiTimer = null;
    function flushUI() {
      if (uiTimer) { clearTimeout(uiTimer); uiTimer = null; }
      lastUI = Date.now();
      if (renderBuf && renderBuf.childNodes.length) {
        // re-apply the filter on the way in, in case it changed while these were queued
        [].slice.call(renderBuf.childNodes).forEach(function (n) { if (n.nodeType === 1) applyFilterTo(n); });
        $("list").appendChild(renderBuf); renderBuf = document.createDocumentFragment();
      }
      $("fill").style.width = (T.total ? Math.round(T.done / T.total * 100) : 0) + "%";
      paintTiles(); prog();
      if (T.done > 0) { $("html").disabled = false; $("xlsx").disabled = false; $("raw").disabled = false; }
    }
    function ui() { const now = Date.now(); if (now - lastUI >= 120) flushUI(); else if (!uiTimer) uiTimer = setTimeout(flushUI, 120 - (now - lastUI)); }
    async function worker() {
      while (!run.stop) {
        while (run.paused && !run.stop) { $("prog").textContent = t("paused"); await sleep(200); }
        if (run.stop) return;
        const i = next++; if (i >= students.length) return;
        running++;
        const stu = students[i];
        for (let j = 0; j < stu.items.length && !run.stop; j++) {
          const res = await processItem(stu, stu.items[j]);
          if (run.stop) break;   // aborted mid-flight — don't record partial/error result
          stu.results.push({ item: stu.items[j], res: res });
          bumpTile(res.st);
          if (notOk(res.st)) T.stu++;      // Reg + PID, same rule as recountAll()
          T.done++;                       // per pair, like T.total — not once per card
          ui();                           // …so a Reg with many programs cannot stall the counter
        }
        renderStudent(stu);
        running--;
        ui();
      }
    }
    await Promise.all(Array.from({ length: Math.min(Math.max(1, conc), students.length) }, function () { return worker(); }));
    flushUI(); renderBuf = null;
    $("prog").textContent = "✅ " + t("p_done") + " · " + T.done + "/" + T.total + " · ⏱ " + mmss(Date.now() - t0);
    $("run").disabled = !entries.length; $("stop").disabled = true; $("pause").disabled = true;
    run = null;
    paintRerun();   // must come AFTER run is cleared — flushUI() painted them while still busy
  }

  // ---------- render ----------
  const PILLC = { ok: "ok", no: "no", cw: "mut", zero: "mut", nf: "mut", error: "no" };
  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function rerenderList() { const l = $("list"); if (!l) return; l.innerHTML = ""; students.forEach(function (s) { if (s.results && s.results.length) renderStudent(s); }); }
  function renderStudent(stu) {
    const total = stu._resolved ? stu._resolved.length : stu.items.length;
    const div = document.createElement("div"); div.className = "stu";
    /* Marking sits on the student header, not on each finding: the verdict is "I went and looked
       at this student", which covers every row on the card. It only appears where there is
       something to clear — a clean card has nothing to say yes to. */
    const anyManual = (stu.results || []).some(function (x) { return x.res.manual; });
    const anyBad = (stu.results || []).some(function (x) { return notOk(x.res.st); });
    const mk = (anyManual || anyBad)
      ? '<button class="mk' + (anyManual ? ' on' : '') + '" data-reg="' + esc(stu.reg) + '" data-undo="' + (anyManual ? "1" : "") + '" title="' + esc(t(anyManual ? "mk_tip_undo" : "mk_tip")) + '">' + t(anyManual ? "mk_undo" : "mk_do") + '</button>'
      : "";
    let h = '<div class="sh"><span class="reg">' + esc(stu.reg) + '</span><span class="mut">· ' + stu.items.length + ' ' + t("stu_checked") + ' ' + total + ' ' + t("stu_of") + '</span>' + mk + '</div>';
    stu.results.forEach(function (x) {
      const pcls = PILLC[x.res.st] || "no";
      const plbl = x.res.manual ? t("pill_manual") : (t("pill_" + x.res.st) || x.res.st);
      const nm = x.res.program || x.item.program || "";
      const dcls = x.res.st === "ok" ? "pd okd" : ((x.res.st === "no" || x.res.st === "error") ? "pd" : "pd warnd");
      const reg = esc(stu.reg), spid = esc(x.res.spid || "");
      let pn = (nm ? esc(nm) + " — " : "");
      pn += '<span class="mut">Reg:</span> ' + reg + ' <span class="cpy" data-copy="' + reg + '" title="Copy Reg">⧉</span>';
      pn += ' <span class="mut">—</span> <span class="mut">SPID:</span> ' + (spid || "—");
      if (x.res.spid) {
        pn += ' <span class="cpy" data-copy="' + spid + '" title="Copy SPID">⧉</span>';
        pn += ' <span class="mut">—</span> <a href="' + pwUrl(stu.reg, x.res.spid) + '" target="_blank" style="color:#8fb4ff" title="Open Payment History">↗</a>';
      }
      /* the headline names the fault; this says what it actually means, which until now was
         written but never shown anywhere */
      const why = (x.res.why && !x.res.whySelf) ? '<div class="pwhy">' + esc(x.res.why) + "</div>" : "";
      h += '<div class="prow" data-st="' + x.res.st + '"><span class="pill ' + pcls + '">' + plbl + '</span>' +
        '<div class="pinfo"><div class="pn">' + pn + '</div>' +
        '<div class="' + dcls + '">' + esc(x.res.detail) + "</div>" + why + "</div></div>";
    });
    div.innerHTML = h;
    applyFilterTo(div);
    (renderBuf || $("list")).appendChild(div);   // during a run, cards accumulate in a fragment and flush in batches
  }

  // ---------- filter ----------
  let filter = "all";
  function matchFilter(st) {
    if (filter === "all") return true;
    if (filter === "ok") return st === "ok";
    if (filter === "no") return st === "no";
    if (filter === "error") return st === "error";
    if (filter === "cw") return st === "cw";
    if (filter === "zero") return st === "zero";
    if (filter === "nf") return st === "nf";
    if (filter === "prob") return notOk(st);
    return true;
  }
  function setFilter(f) {
    filter = f;
    [].slice.call(document.querySelectorAll(".fb")).forEach(function (b) { b.classList.toggle("active", b.getAttribute("data-f") === f); });
    applyFilterAll();
  }
  function applyFilterTo(stuDiv) {
    let visible = 0;
    [].slice.call(stuDiv.querySelectorAll(".prow")).forEach(function (pr) {
      const show = matchFilter(pr.getAttribute("data-st"));
      pr.style.display = show ? "" : "none"; if (show) visible++;
    });
    stuDiv.style.display = visible ? "" : "none";
  }
  // Cards that are still queued in the render buffer must be filtered too — otherwise they land in
  // the list carrying the display state they were built with, ignoring the filter chosen since.
  function applyFilterAll() {
    [].slice.call($("list").children).forEach(function (el) { applyFilterTo(el); });
    if (renderBuf) [].slice.call(renderBuf.childNodes).forEach(function (n) { if (n.nodeType === 1) applyFilterTo(n); });
  }

  // ---------- CSV / Excel import ----------
  function parseCSV(text) {
    text = String(text).replace(/^﻿/, "");
    const rows = []; let row = [], cur = "", q = false;
    for (let i = 0; i < text.length; i++) { const ch = text[i]; if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; } else if (ch === '"') q = true; else if (ch === ",") { row.push(cur); cur = ""; } else if (ch === "\n") { row.push(cur); rows.push(row); row = []; cur = ""; } else if (ch !== "\r") cur += ch; }
    if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
    return rows.filter(function (r) { return r.some(function (c) { return String(c).trim() !== ""; }); });
  }
  function detectCols(rows) {
    const first = rows[0].map(function (c) { return String(c).toLowerCase().trim(); });
    let reg = -1, spid = -1, prog = -1, hdr = false;
    first.forEach(function (h, i) {
      if (reg < 0 && /reg|roll/.test(h)) { reg = i; hdr = true; }
      if (spid < 0 && /spid|program\s*id/.test(h)) { spid = i; hdr = true; }   // matches "spid", "programid", "program id", "student program id"
      if (prog < 0 && !/program\s*id/.test(h) && /program\s*session|programsession|(^|[^a-z])program([^a-z]|$)/.test(h)) { prog = i; hdr = true; }
    });
    if (reg < 0) reg = 0;
    let mode, val;
    /* Remember whether a header actually named the columns. When it did not, reg and val below are
       nothing more than "first column" and "second column" — see swapCheck(), which asks UMS which
       way round they really are instead of trusting the order. */
    if (inputMode === "spid") { mode = "spid"; val = spid >= 0 ? spid : 1; }
    else if (inputMode === "program") { mode = "program"; val = prog >= 0 ? prog : 1; }
    else if (spid >= 0) { mode = "spid"; val = spid; }
    else if (prog >= 0 && prog !== reg) { mode = "program"; val = prog; }
    else { mode = "spid"; val = (reg === 1 ? 0 : 1); }
    return { reg: reg, val: val, mode: mode, hdr: hdr };
  }
  /* Are the Reg and Student PID columns the right way round?
   *
   * When the sheet has no header row, detectCols() can only go by position: first column Reg,
   * second Student PID. A file written the other way round then produces a URL with each id in the
   * other's slot. Program Wise still answers — it looks the student up by only one of them — so the
   * run completes and every single row reports "Course Wise page did not open (wrong reg, or no
   * permission?)". Twenty-three rows came back that way, all of them wrong in the same silent
   * direction, and nothing in the numbers gives it away: a Reg and a Student PID are both seven
   * digits.
   *
   * UMS knows the answer, so ask it. resolvePrograms(x) returns the programmes of the student
   * registered as x, each with its real Student PID. Take a few sample rows and try both readings:
   *
   *   as written   resolvePrograms(colA) contains colB   → colA is Reg
   *   swapped      resolvePrograms(colB) contains colA   → colB is Reg
   *
   * Whichever reading more rows agree with wins. A tie, or no answer at all (offline, no
   * permission, an empty sheet), changes nothing — the guess stands, because a wrong correction
   * would be worse than the wrong guess it replaced.
   */
  async function swapCheck(rows, d) {
    if (d.hdr || d.mode !== "spid" || d.reg === d.val) return null;
    const sample = rows.filter(function (r) {
      return /^\d+$/.test(String(r[d.reg] || "").trim()) && /^\d+$/.test(String(r[d.val] || "").trim());
    }).slice(0, 3);
    if (!sample.length) return null;

    let asWritten = 0, swapped = 0;
    for (const r of sample) {
      const a = String(r[d.reg]).trim(), b = String(r[d.val]).trim();
      const has = async function (reg, spid) {
        try {
          const list = await resolvePrograms(reg);
          return list.some(function (p) { return String(p.spid) === spid; });
        } catch (e) { return null; }        // no permission / offline — this row says nothing
      };
      if (await has(a, b)) asWritten++;
      else if (await has(b, a)) swapped++;
    }
    return swapped > asWritten ? { reg: d.val, val: d.reg } : null;
  }

  async function applyImported(all) {
    if (!all || !all.length) { $("impNote").textContent = t("imp_empty"); return; }
    const d = detectCols(all);
    /* the probe is a network round-trip; say what the wait is for rather than leaving the last
       import's counts on screen, which would read as this import's result */
    if (!d.hdr) $("impNote").textContent = t("imp_checking");
    const flip = await swapCheck(d.hdr ? all.slice(1) : all, d);
    if (flip) { d.reg = flip.reg; d.val = flip.val; }
    const data = d.hdr ? all.slice(1) : all;
    const kept = data.filter(function (r) { return String(r[d.reg] || "").trim(); });
    if (!kept.length) { $("impNote").textContent = t("paste_norow"); return; }
    importedRows = kept; importedHeader = d.hdr ? all[0] : null;
    /* A Reg cell holding two numbers ("1957189 1536554" — a Reg and a Roll pasted into one column)
       is sent to UMS verbatim and comes back as a redirect, which reads as "reg/permission?" and
       survives every re-run because the stored entry is still wrong. Reg numbers have no spaces,
       so keep the first number and say how many rows were trimmed. */
    let trimmed = 0;
    const oneReg = function (s) {
      const parts = String(s).trim().split(/\s+/);
      if (parts.length > 1) trimmed++;
      return parts[0];
    };
    const rawEntries = kept.map(function (r) {
      const reg = oneReg(r[d.reg]); const v = String(r[d.val] || "").trim();
      if (!v) return { reg: reg };
      return d.mode === "program" ? { reg: reg, program: v } : { reg: reg, spid: v };
    });
    // Rule (user): a Reg + StudentProgramId pair must be unique — drop exact-duplicate rows.
    const seen = {}; entries = [];
    rawEntries.forEach(function (e) {
      const k = e.reg + "|" + (e.spid || e.program || "");
      if (seen[k]) return; seen[k] = 1; entries.push(e);
    });
    const dropped = kept.length - entries.length;
    renderPreview();
    updateCount();
    /* Show the total the moment anything was dropped — otherwise "149 · 7 dropped" leaves you
       doing the addition yourself. When nothing was dropped the single number says it all. */
    const blank = data.length - kept.length;
    let note;
    if (dropped > 0 || blank > 0) {
      note = '✓ <b>' + data.length + '</b> ' + t("imp_row") + ' → <b>' + entries.length + '</b> ' + t("imp_will_run");
      if (dropped > 0) note += ' · <b>' + dropped + '</b> ' + t("imp_dropped");
      if (blank > 0) note += ' · <b>' + blank + '</b> ' + t("imp_noreg");
      if (trimmed > 0) note += ' · <b>' + trimmed + '</b> ' + t("imp_trim");
    } else if (trimmed > 0) {
      note = '✓ <b>' + entries.length + '</b> ' + t("imp_row") + ' · <b>' + trimmed + '</b> ' + t("imp_trim");
    } else {
      note = '✓ <b>' + entries.length + '</b> ' + t("imp_row");
    }
    /* Say so when the columns were turned round. Correcting it silently would leave the sheet and
       the run disagreeing about which column is which, with no way to tell which one was read. */
    if (flip) note += ' · <b>' + t("imp_swap") + '</b>';
    // lead with the file/tab the rows came from, so the counts below it can be trusted
    $("impNote").innerHTML = (importSrc ? '<span class="isrc">' + esc(importSrc) + "</span><br>" : "") + note;
  }
  var PV_MAX = Infinity;   // render ALL rows into the scroll box (box height ≈ 5 rows, rest scrolls)
  function renderPreview() {
    const box = $("preview"); const bar = $("pvWrap"); if (!box) return;
    if (!entries.length) { box.innerHTML = ""; if (bar) bar.style.display = "none"; return; }
    if (bar) bar.style.display = "block";
    const isProg = entries.some(function (e) { return e.program !== undefined; });
    const lastCol = isProg ? "Program" : "Student PID";
    // Head (with the search box in it) is built once — only the body is re-rendered while typing,
    // so the input keeps its focus and caret.
    let sb = $("pvSearch");
    if (!sb || box.getAttribute("data-col") !== lastCol) {
      const keep = sb ? sb.value : "";
      box.setAttribute("data-col", lastCol);
      box.innerHTML = '<table class="ptbl"><thead><tr><th>#</th><th>' + t("pv_reg") + '</th><th>' + lastCol +
        '</th><th class="pvs"><input id="pvSearch" class="pvsearch"></th></tr></thead>' +
        '<tbody id="pvBody"></tbody></table><div id="pvMore"></div>';
      sb = $("pvSearch");
      sb.placeholder = t("pv_search_ph");
      sb.value = keep;
      sb.addEventListener("input", renderPreview);
    }
    const q = sb.value.trim().toLowerCase();
    const matched = [];
    entries.forEach(function (e, i) {
      const val = String(e.spid || e.program || "");
      if (q && String(e.reg).toLowerCase().indexOf(q) < 0 && val.toLowerCase().indexOf(q) < 0) return;
      matched.push({ e: e, i: i });
    });
    const body = $("pvBody"), more = $("pvMore");
    if (!matched.length) {
      body.innerHTML = '<tr><td colspan="4" style="padding:14px;color:var(--muted);text-align:center">' + t("pv_none") + '</td></tr>';
      more.innerHTML = ""; return;
    }
    const show = matched.slice(0, PV_MAX);
    let h = "";
    show.forEach(function (m) {
      h += '<tr><td>' + (m.i + 1) + '</td><td>' + esc(m.e.reg) + '</td><td>' + esc(m.e.spid || m.e.program || "—") + '</td><td></td></tr>';
    });
    body.innerHTML = h;
    more.innerHTML = matched.length > show.length
      ? '<div style="padding:8px 10px;color:var(--muted);font-size:12px;text-align:center">' + t("pv_more").replace("{a}", show.length).replace("{b}", matched.length) + '</div>'
      : "";
  }
  async function inflateRaw(u8) { const ds = new DecompressionStream("deflate-raw"); const s = new Response(u8).body.pipeThrough(ds); return new Uint8Array(await new Response(s).arrayBuffer()); }
  async function unzip(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1; for (let i = u8.length - 22; i >= 0; i--) { if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; } }
    if (eocd < 0) throw new Error("ZIP নয়");
    const cd = dv.getUint16(eocd + 10, true); let off = dv.getUint32(eocd + 16, true); const td = new TextDecoder("utf-8"); const files = {};
    for (let n = 0; n < cd; n++) {
      if (dv.getUint32(off, true) !== 0x02014b50) break;
      const method = dv.getUint16(off + 10, true), cs = dv.getUint32(off + 20, true), nl = dv.getUint16(off + 28, true), el = dv.getUint16(off + 30, true), cl = dv.getUint16(off + 32, true), lho = dv.getUint32(off + 42, true);
      const fn = td.decode(u8.subarray(off + 46, off + 46 + nl));
      // workbook.xml + its rels come along for the tab name — see sheetNameOf()
      if (/^xl\/(sharedStrings\.xml|workbook\.xml|_rels\/workbook\.xml\.rels|worksheets\/.*\.xml)$/i.test(fn)) { const lnl = dv.getUint16(lho + 26, true), lel = dv.getUint16(lho + 28, true), ds = lho + 30 + lnl + lel; const comp = u8.subarray(ds, ds + cs); files[fn] = method === 0 ? comp.slice() : (method === 8 ? await inflateRaw(comp) : null); }
      off += 46 + nl + el + cl;
    }
    return files;
  }
  function colIdx(ref) { const m = String(ref).match(/^([A-Z]+)/i); if (!m) return -1; const s = m[1].toUpperCase(); let n = 0; for (let i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64); return n - 1; }
  /* Which tab did we just read? workbook.xml carries the names a person sees, but the order of
     <sheet> elements is not the order of the sheetN.xml files — the link between them is the
     relationship id, so it is looked up through the rels rather than by position. Best-effort: an
     unreadable workbook costs the name, never the import. */
  const RELS_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  function sheetNameOf(files, key, dec) {
    try {
      const wbx = files["xl/workbook.xml"];
      if (!wbx) return "";
      const rels = {}, rlx = files["xl/_rels/workbook.xml.rels"];
      if (rlx) {
        const rd = new DOMParser().parseFromString(dec.decode(rlx), "application/xml");
        [].slice.call(rd.getElementsByTagName("Relationship")).forEach(function (n) {
          rels[n.getAttribute("Id")] = String(n.getAttribute("Target") || "").replace(/^\/?(xl\/)?/, "");
        });
      }
      const wd = new DOMParser().parseFromString(dec.decode(wbx), "application/xml");
      const tabs = [].slice.call(wd.getElementsByTagName("sheet"));
      const want = String(key).replace(/^xl\//, "").toLowerCase();
      for (let i = 0; i < tabs.length; i++) {
        const rid = tabs[i].getAttributeNS(RELS_NS, "id") || tabs[i].getAttribute("r:id");
        if (rid && rels[rid] && rels[rid].toLowerCase() === want) return tabs[i].getAttribute("name") || "";
      }
      return tabs.length ? (tabs[0].getAttribute("name") || "") : "";
    } catch (e) { return ""; }
  }
  /* Where the rows came from. Two tabs of one workbook can look identical in the preview, and so
     can last week's file — once the rows are in, nothing on screen said which file or which tab
     produced them, so a run against the wrong one was invisible. The note now leads with it. */
  let importSrc = "";
  function setSource(name, sheetName) {
    const bits = [];
    if (name) bits.push(name);
    if (sheetName) bits.push(t("src_sheet") + ": " + sheetName);
    importSrc = bits.join("  ·  ");
  }
  function shared(xml) { const out = []; if (!xml) return out; const d = new DOMParser().parseFromString(xml, "application/xml"); const si = d.getElementsByTagName("si"); for (let i = 0; i < si.length; i++) { const ts = si[i].getElementsByTagName("t"); let s = ""; for (let j = 0; j < ts.length; j++) s += ts[j].textContent; out.push(s); } return out; }
  function sheet(xml, sh) { const d = new DOMParser().parseFromString(xml, "application/xml"); const re = d.getElementsByTagName("row"); const rows = []; for (let i = 0; i < re.length; i++) { const cs = re[i].getElementsByTagName("c"); const arr = []; for (let j = 0; j < cs.length; j++) { const c = cs[j]; let idx = c.getAttribute("r") ? colIdx(c.getAttribute("r")) : j; if (idx < 0) idx = j; const t = c.getAttribute("t"); let v = ""; if (t === "s") { const vv = c.getElementsByTagName("v")[0]; if (vv) v = sh[parseInt(vv.textContent, 10)] || ""; } else if (t === "inlineStr") { const is = c.getElementsByTagName("t")[0]; if (is) v = is.textContent; } else { const vv = c.getElementsByTagName("v")[0]; if (vv) v = vv.textContent; } arr[idx] = v; } for (let k = 0; k < arr.length; k++) if (arr[k] === undefined) arr[k] = ""; rows.push(arr); } return rows.filter(function (r) { return r.some(function (c) { return String(c).trim() !== ""; }); }); }
  async function readXlsx(buf) { const f = await unzip(new Uint8Array(buf)); const dec = new TextDecoder("utf-8"); const sh = shared(f["xl/sharedStrings.xml"] ? dec.decode(f["xl/sharedStrings.xml"]) : ""); const key = Object.keys(f).find(function (x) { return /^xl\/worksheets\/sheet1\.xml$/i.test(x); }) || Object.keys(f).find(function (x) { return /^xl\/worksheets\/.*\.xml$/i.test(x); }); if (!key) throw new Error("worksheet নেই"); return { rows: sheet(dec.decode(f[key]), sh), sheet: sheetNameOf(f, key, dec) }; }
  function onImport(file) {
    const r = new FileReader();
    r.onload = function () {
      const u8 = new Uint8Array(r.result);
      const zip = u8.length > 3 && u8[0] === 0x50 && u8[1] === 0x4B && (u8[2] === 0x03 || u8[2] === 0x05 || u8[2] === 0x07);
      if (zip) {
        $("impNote").textContent = t("imp_excel");
        readXlsx(r.result).then(function (x) { setSource("📄 " + file.name, x.sheet); applyImported(x.rows); })
          // name the file that failed — "Excel পড়া গেল না" alone left you guessing which one
          .catch(function (e) { setSource("📄 " + file.name, ""); $("impNote").textContent = importSrc + " — " + t("imp_excel_fail") + " (" + (e.message || e) + ")"; });
      } else { setSource("📄 " + file.name, ""); applyImported(parseCSV(new TextDecoder("utf-8").decode(u8))); }
    };
    r.readAsArrayBuffer(file);
  }

  // ---------- CSV / xlsx export ----------
  const STLBL = { ok: "Matched", no: "Mismatch", error: "Error", cw: "CW Empty", zero: "Zero Pay", nf: "Program Not Found" };
  function statusColor(st) { return (st === "ok" || st === "zero") ? "g" : ((st === "no" || st === "error") ? "r" : "y"); }
  function flatRows() {
    const out = [];
    students.forEach(function (stu) {
      stu.results.forEach(function (x) {
        if (!matchFilter(x.res.st)) return;   // export honours the selected filter
        const spid = x.res.spid || "";
        out.push({
          status: (x.res.manual ? "Matched (manual)" : (STLBL[x.res.st] || x.res.st)),
          reg: stu.reg,
          spid: spid,
          program: x.res.program || x.item.program || "",
          link: spid ? pwUrl(stu.reg, spid) : "",
          /* Remarks used to carry detailFull — the long internal listing — while the screen showed
             the short line, so the file never matched what was read on screen. Remarks is now that
             same sentence, and the listing moves to its own column for whoever needs it. */
          remarks: x.res.detail || "",
          details: x.res.detailFull && x.res.detailFull !== x.res.detail ? x.res.detailFull : "",
          result: x.res.st,
          raw: x.res.raw || "",
          color: statusColor(x.res.st)
        });
      });
    });
    return out;
  }
  function ver() { try { return "v" + chrome.runtime.getManifest().version; } catch (e) { return ""; } }
  function stamp() { const d = new Date(); const p = function (n) { return String(n).padStart(2, "0"); }; return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + "-" + p(d.getHours()) + p(d.getMinutes()); }
  function dl(blob, ext) { const u = URL.createObjectURL(blob); const a = document.createElement("a"); a.href = u; a.download = "ums-verify-" + stamp() + "." + ext; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(u); }, 1000); }
  function exportHtml() {
    const rows = flatRows(); if (!rows.length) return;
    const LBL = STLBL;
    const cnt = {}; rows.forEach(function (r) { cnt[r.result] = (cnt[r.result] || 0) + 1; });
    const regSet = {}; rows.forEach(function (r) { regSet[r.reg] = 1; }); const nStu = Object.keys(regSet).length;
    const chip = function (k, lbl) { return cnt[k] ? '<span class="chip ' + (LBL[k] ? k : "") + '"><b>' + cnt[k] + '</b> ' + (lbl || LBL[k] || k) + '</span>' : ''; };
    let body = "";
    rows.forEach(function (r) {
      const linkCell = r.link ? '<a href="' + xesc(r.link) + '" target="_blank">Open ↗</a>' : '—';
      body += '<tr class="r-' + r.color + '" data-st="' + r.result + '">' +
        '<td class="st st-' + r.color + '">' + xesc(LBL[r.result] || r.result) + '</td>' +
        '<td>' + xesc(r.reg) + '</td><td>' + xesc(r.spid) + '</td>' +
        '<td class="lk">' + linkCell + '</td>' +
        '<td class="dt">' + xesc(r.remarks || "") + '</td>' +
        '<td class="dt sm">' + xesc(r.details || "") + '</td></tr>';
    });
    const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>UMS Payment Reconciler — Report</title><style>' +
      'body{margin:0;background:#0d0f1a;color:#eef1fb;font:14px/1.5 system-ui,Segoe UI,Roboto,Arial,sans-serif;padding:24px}' +
      'h1{font-size:20px;margin:0 0 4px}.sub{color:#8b91b4;margin:0 0 16px;font-size:13px}' +
      '.chips{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 16px}' +
      '.chip{background:#161a2b;border:1px solid #2a3050;border-radius:20px;padding:5px 12px;font-size:13px}' +
      '.chip.ok{border-color:#37d18b}.chip.no,.chip.error{border-color:#ff6b7d}.chip.warn,.chip.nf{border-color:#ffb454}.chip.cw,.chip.zero{border-color:#8b91b4}' +
      '.bar{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 12px}' +
      '.f{cursor:pointer;background:#161a2b;border:1px solid #2a3050;color:#eef1fb;border-radius:8px;padding:6px 12px;font-size:13px}' +
      '.f.active{background:#5b4ff0;border-color:#5b4ff0}' +
      'table{border-collapse:collapse;width:100%;font-size:13px}' +
      'th,td{border:1px solid #2a3050;padding:7px 10px;text-align:left;vertical-align:top}' +
      'th{background:#161a2b;color:#8b91b4;position:sticky;top:0}' +
      '.st{font-weight:700;white-space:nowrap}.st-g{color:#37d18b}.st-y{color:#ffb454}.st-r{color:#ff6b7d}' +
      '.r-g td:first-child{box-shadow:inset 3px 0 #37d18b}.r-y td:first-child{box-shadow:inset 3px 0 #ffb454}.r-r td:first-child{box-shadow:inset 3px 0 #ff6b7d}' +
      '.dt{color:#c3c8e6}.sm{font-size:12px;color:#8b91b4}.hide{display:none}.lk a{color:#8fb4ff;text-decoration:none}.lk a:hover{text-decoration:underline}' +
      '@media print{.bar{display:none}body{background:#fff;color:#000}th{background:#eee}}' +
      '</style></head><body>' +
      '<h1>UMS Payment Reconciler — Report</h1>' +
      '<p class="sub">' + xesc(baseUrl) + ' · ' + nStu + ' students · ' + rows.length + ' rows · ' + xesc(new Date().toLocaleString()) + '</p>' +
      '<div class="chips">' + chip("ok") + chip("no") + chip("error") + chip("cw") + chip("zero") + chip("nf") + '</div>' +
      '<div class="bar">' +
      '<button class="f active" data-f="all">All</button>' +
      '<button class="f" data-f="no">Mismatch</button>' +
      '<button class="f" data-f="cw">CW Empty</button>' +
      '<button class="f" data-f="zero">Zero Pay</button>' +
      '<button class="f" data-f="ok">Matched</button>' +
      '<button class="f" data-f="nf">Program Not Found</button></div>' +
      '<table><thead><tr><th>Status</th><th>Student Reg</th><th>Program Id</th><th>Payment History Link</th><th>Remarks</th><th>Details</th></tr></thead>' +
      '<tbody id="tb">' + body + '</tbody></table>' +
      '<script>(function(){var bar=document.querySelector(".bar");bar.addEventListener("click",function(e){var b=e.target.closest(".f");if(!b)return;' +
      '[].forEach.call(bar.children,function(x){x.classList.remove("active")});b.classList.add("active");var f=b.getAttribute("data-f");' +
      '[].forEach.call(document.querySelectorAll("#tb tr"),function(tr){var st=tr.getAttribute("data-st");var show=f==="all"||st===f||(f==="no"&&st==="error");tr.classList.toggle("hide",!show)})})})();<\/script>' +
      '</body></html>';
    dl(new Blob([html], { type: "text/html;charset=utf-8;" }), "html");
  }
  const CRC = (function () { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
  function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function cat(a) { let n = 0; a.forEach(function (x) { n += x.length; }); const o = new Uint8Array(n); let p = 0; a.forEach(function (x) { o.set(x, p); p += x.length; }); return o; }
  function xesc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function cl(n) { let s = ""; n++; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
  function sheetXml(header, rows, colors) {
    const all = [header].concat(rows);
    const W = [14, 12, 12, 46, 62, 90];   // Remarks and Details need room; the rest are short
    let cols = '<cols>'; W.forEach(function (w, i) { cols += '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>'; }); cols += '</cols>';
    let x = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' + cols + '<sheetData>';
    all.forEach(function (row, ri) { const rn = ri + 1; const cc = colors[ri - 1]; const s = ri === 0 ? 3 : (cc === "g" ? 1 : cc === "r" ? 2 : cc === "y" ? 4 : 0); x += '<row r="' + rn + '">'; row.forEach(function (cell, ci) { x += '<c r="' + cl(ci) + rn + '" t="inlineStr" s="' + s + '"><is><t xml:space="preserve">' + xesc(cell) + '</t></is></c>'; }); x += "</row>"; });
    const ref = "A1:" + cl(header.length - 1) + all.length;   // AutoFilter so Status (and other columns) are filterable in Excel
    return x + "</sheetData><autoFilter ref=\"" + ref + "\"/></worksheet>";
  }
  const CT = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>';
  const RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
  const WB = '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Result" sheetId="1" r:id="rId1"/></sheets></workbook>';
  const WBR = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>';
  const STY = '<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="6"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFC6EFCE"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFC7CE"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE0E0E0"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFEB9C"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="5"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf><xf numFmtId="0" fontId="0" fillId="2" borderId="0" xfId="0" applyFill="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf><xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf><xf numFmtId="0" fontId="0" fillId="4" borderId="0" xfId="0" applyFill="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf><xf numFmtId="0" fontId="0" fillId="5" borderId="0" xfId="0" applyFill="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
  function zipStore(files) {
    const enc = new TextEncoder(); const u16 = function (n) { return new Uint8Array([n & 255, (n >> 8) & 255]); }; const u32 = function (n) { n >>>= 0; return new Uint8Array([n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255]); };
    const chunks = [], central = []; let off = 0;
    files.forEach(function (f) { const name = enc.encode(f.name), data = f.data, crc = crc32(data); const lh = cat([u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name]); chunks.push(lh); chunks.push(data); central.push({ name: name, crc: crc, size: data.length, off: off }); off += lh.length + data.length; });
    const cds = off; const cdc = [];
    central.forEach(function (c) { cdc.push(cat([u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(c.crc), u32(c.size), u32(c.size), u16(c.name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(c.off), c.name])); });
    const cdb = cat(cdc); chunks.push(cdb);
    chunks.push(cat([u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length), u32(cdb.length), u32(cds), u16(0)]));
    return cat(chunks);
  }
  /* Every flagged receipt's raw cells in one file. The HTML and Excel reports say WHAT the tool
     concluded; this says what it read. When a verdict is disputed the argument only moves on the
     numbers, and fetching them again by hand — page by page, student by student — is the slow part
     of every such round. Honours the chosen filter, so "Mismatch" exports only those. */
  function exportRaw() {
    const rows = flatRows().filter(function (r) { return r.raw; });
    if (!rows.length) return;
    const NL = "\n", RULE = "=".repeat(78) + NL, THIN = "-".repeat(78) + NL;
    let out = "UMS Payment Reconciler " + ver() + " · " + new Date().toLocaleString() +
      " · " + rows.length + " flagged" + NL + baseUrl + NL;
    rows.forEach(function (r) {
      out += NL + RULE +
        r.status + " · reg " + r.reg + " · spid " + r.spid +
        (r.program ? " · " + r.program : "") + NL +
        r.remarks + NL + THIN + r.raw;
    });
    dl(new Blob([out], { type: "text/plain;charset=utf-8;" }), "txt");
  }

  function exportXlsx() {
    const rows = flatRows(); if (!rows.length) return;
    const header = ["Status", "Student Reg", "Program Id", "Payment History Link", "Remarks", "Details"];
    const mat = rows.map(function (r) { return [r.status, r.reg, r.spid, r.link, r.remarks, r.details]; });
    const colors = rows.map(function (r) { return r.color; });
    const enc = new TextEncoder();
    const bytes = zipStore([
      { name: "[Content_Types].xml", data: enc.encode(CT) }, { name: "_rels/.rels", data: enc.encode(RELS) },
      { name: "xl/workbook.xml", data: enc.encode(WB) }, { name: "xl/_rels/workbook.xml.rels", data: enc.encode(WBR) },
      { name: "xl/styles.xml", data: enc.encode(STY) }, { name: "xl/worksheets/sheet1.xml", data: enc.encode(sheetXml(header, mat, colors)) }
    ]);
    dl(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "xlsx");
  }

  // ---------- misc ----------
  function updateCount() {
    const cn = $("cnt"); if (!cn) return;
    const n = entries.length;
    cn.textContent = (lang === "bn" ? n.toLocaleString("bn-BD") : n) + " " + t("items");
    // nothing to check → Start stays disabled (a run in progress keeps it disabled anyway)
    const btn = $("run");
    if (btn && !run) { btn.disabled = n === 0; btn.title = n ? "" : t("p_input"); }
  }
  async function testConn() {
    $("conn").textContent = t("checking"); $("conn").className = "badge mut";
    try { const r = await fetchHtml(payBase() + "PaymentHistory"); const ok = r.ok && !/Account\/Login/i.test(r.html) && /stdRollOrRegistrationNo/i.test(r.html); $("conn").textContent = ok ? t("conn_ok") : t("conn_no"); $("conn").className = "badge " + (ok ? "ok" : "no"); }
    catch (e) { $("conn").textContent = t("conn_fail"); $("conn").className = "badge no"; }
  }
  function saveCfg() { try { chrome.storage.local.set({ baseUrl: baseUrl, appConc: conc, appTol: tol }); $("saveCfg").textContent = t("saved"); setTimeout(function () { $("saveCfg").textContent = t("save"); }, 1500); } catch (e) {} }

  // ---------- wire ----------
  function applyTheme(t) { document.body.className = (t === "light" ? "light" : ""); const b = $("theme"); if (b) b.textContent = (t === "light" ? "🌙 Dark" : "☀ Light"); }
  function wire() {
    try { const v = chrome.runtime.getManifest().version; const el = $("ver"); if (el) el.textContent = "v" + v; } catch (e) {}
    $("base").value = baseUrl; $("conc").value = conc; $("tol").value = tol;
    $("base").addEventListener("input", function () { baseUrl = this.value.trim() || "https://ums-5.osl.team"; });
    $("conc").addEventListener("input", function () { let v = parseInt(this.value, 10); if (isNaN(v)) return; conc = Math.max(1, Math.min(300, v)); if (v !== conc) this.value = conc; try { chrome.storage.local.set({ appConc: conc }); } catch (e) {} });
    $("tol").addEventListener("input", function () { const v = parseFloat(this.value); tol = isNaN(v) ? 0 : Math.max(0, v); try { chrome.storage.local.set({ appTol: tol }); } catch (e) {} });
    $("theme").addEventListener("click", function () { const th = document.body.classList.contains("light") ? "dark" : "light"; applyTheme(th); try { chrome.storage.local.set({ theme: th }); } catch (e) {} });
    $("lang").addEventListener("click", function () { const l = (lang === "bn" ? "en" : "bn"); applyLang(l); try { chrome.storage.local.set({ lang: l }); } catch (e) {} });
    // Clear empties the whole "What to Reconciliation" card — paste box, sheet link, the chosen
    // file, the preview and its search — so the next import starts from nothing.
    $("clearImp").addEventListener("click", function () {
      entries = []; importedRows = null; importedHeader = null; importSrc = "";
      ["paste", "link", "pvSearch", "file"].forEach(function (id) {
        const el = $(id); if (el) el.value = "";
      });
      const pv = $("preview"); if (pv) { pv.innerHTML = ""; pv.removeAttribute("data-col"); }
      renderPreview(); updateCount();
      $("impNote").textContent = "";
    });
    $("testConn").addEventListener("click", testConn);
    $("saveCfg").addEventListener("click", saveCfg);
    $("run").addEventListener("click", startRun);
    $("stop").addEventListener("click", function () { if (run) { run.stop = true; run.paused = false; if (run.ac) try { run.ac.abort(); } catch (e) {} } this.disabled = true; $("pause").disabled = true; $("prog").textContent = t("stopping"); });
    $("pause").addEventListener("click", function () { if (!run) return; run.paused = !run.paused; this.textContent = run.paused ? t("resume") : t("pause"); });
    $("html").addEventListener("click", exportHtml);
    $("xlsx").addEventListener("click", exportXlsx);
    $("raw").addEventListener("click", exportRaw);
    $("file").addEventListener("change", function (ev) { const f = ev.target.files && ev.target.files[0]; if (f) onImport(f); });
    $("linkBtn").addEventListener("click", importFromLink);
    $("pasteBtn").addEventListener("click", importFromPaste);
    // Ctrl/Cmd+Enter runs it without reaching for the button
    $("paste").addEventListener("keydown", function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); importFromPaste(); }
    });
    [].slice.call(document.querySelectorAll("[data-f]")).forEach(function (b) {
      b.addEventListener("click", function (e) {
        if (e.target.closest && e.target.closest(".rr")) return;   // ⟳ চাপলে ফিল্টার বদলাবে না
        setFilter(b.getAttribute("data-f"));
      });
    });
    [].slice.call(document.querySelectorAll(".rr")).forEach(function (b) {
      b.addEventListener("click", function (e) { e.stopPropagation(); rerunStatus(b.getAttribute("data-rr")); });
    });
    // copy the ↗ URL to clipboard (event-delegated, since rows are added dynamically)
    /* Mark / Undo — event-delegated, since cards are added while the run is still going */
    $("list").addEventListener("click", function (e) {
      const b = e.target.closest ? e.target.closest(".mk") : null;
      if (!b) return;
      const stu = students.filter(function (x) { return String(x.reg) === b.getAttribute("data-reg"); })[0];
      if (stu) markStudent(stu, !!b.getAttribute("data-undo"));
    });
    $("list").addEventListener("click", function (e) {
      const c = e.target.closest ? e.target.closest(".cpy") : null;
      if (!c) return;
      const url = c.getAttribute("data-copy") || c.getAttribute("data-url"); if (!url) return;
      const done = function () { const o = c.textContent; c.textContent = "✓"; c.classList.add("ok"); setTimeout(function () { c.textContent = o; c.classList.remove("ok"); }, 1000); };
      try { navigator.clipboard.writeText(url).then(done, function () {}); }
      catch (err) { const ta = document.createElement("textarea"); ta.value = url; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); done(); } catch (e2) {} ta.remove(); }
    });
    // warn before refresh/close while a run is in progress
    window.addEventListener("beforeunload", function (e) {
      if (run && !run.stop) { e.preventDefault(); e.returnValue = ""; return ""; }
    });
  }
  /* Paste straight out of Excel or the sheet: one line per student, Reg and StudentProgramId
     separated by a tab, comma or spaces. Feeds the same path as a file/sheet import, so column
     detection, de-duplication and the preview all behave identically. */
  function importFromPaste() {
    // Copying out of a rendered table (Google Sheets, the UMS page, Word) yields non-breaking
    // spaces and zero-width marks. Left in, a "line" looks non-empty but every cell trims to "".
    const txt = String($("paste").value || "")
      .replace(/ /g, " ")
      .replace(/[​-‍﻿]/g, "");
    if (!txt.trim()) { $("impNote").textContent = t("paste_empty"); return; }
    // Pick ONE separator per line, strongest first. Splitting on every kind at once would tear
    // "Student Reg" apart at its own space and wreck the header detection.
    const cut = function (l) {
      if (l.indexOf("\t") >= 0) return l.split("\t");
      if (/[,;|]/.test(l)) return l.split(/\s*[,;|]\s*/);
      if (/\s{2,}/.test(l)) return l.split(/\s{2,}/);
      return l.split(/\s+/);
    };
    const rows = txt.split(/\r?\n/)
      .map(function (l) { return l.trim(); })
      .filter(function (l) { return l && !/^[\s,;|]+$/.test(l); })
      .map(function (l) { return cut(l).map(function (c) { return c.trim(); }).filter(function (c) { return c !== ""; }); });
    if (!rows.length) { $("impNote").textContent = t("paste_empty"); return; }
    importedHeader = null;
    setSource(t("src_paste"), "");
    applyImported(rows);
  }

  function importFromLink() {
    const link = $("link").value.trim(); const m = link.match(/\/spreadsheets\/d\/([a-zA-Z0-9\-_]+)/);
    if (!m) { $("impNote").textContent = t("imp_badlink"); return; }
    const g = link.match(/[#&?]gid=(\d+)/); const gid = g ? g[1] : "0";
    const url = "https://docs.google.com/spreadsheets/d/" + m[1] + "/export?format=csv&gid=" + gid;
    $("impNote").textContent = t("imp_sheet");
    /* A link is unreadable — nothing in it says which spreadsheet or which tab. Google does say:
       the CSV comes back as Content-Disposition: filename="<Spreadsheet> - <Tab>.csv". This page
       holds host permission for docs.google.com, so the header is readable here; where it is not,
       fall back to the ids out of the link rather than showing nothing at all. */
    let nm = "";
    // Google answers with a 307 to *.googleusercontent.com — that host must be in host_permissions
    // or the redirected request is blocked and lands in .catch() as a bare network failure.
    fetch(url, { credentials: "include" }).then(function (r) {
      if (!r.ok) throw new Error("HTTP " + r.status);
      try {
        const cd = r.headers.get("content-disposition") || "";
        const mm = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(cd);
        if (mm) nm = decodeURIComponent(mm[1].trim()).replace(/\.csv$/i, "").trim();
      } catch (e) {}
      return r.text();
    }).then(function (txt) {
      if (/^\s*<(!doctype|html)/i.test(txt)) { $("impNote").textContent = t("imp_login"); return; }
      // the tab is the part after the last " - "; a title containing one is still shown whole
      const cut = nm.lastIndexOf(" - ");
      if (nm && cut > 0) setSource("↧ " + nm.slice(0, cut), nm.slice(cut + 3));
      else setSource("↧ " + (nm || t("src_link")), nm ? "" : "gid " + gid);
      applyImported(parseCSV(txt));
    }).catch(function (e) {
      $("impNote").textContent = t("imp_fail") + " — " + String((e && e.message) || e);
    });
  }

  try { chrome.storage.local.get(["baseUrl", "appConc", "appTol", "tolMigrated", "theme", "lang", "manualOk"], function (o) { if (o.manualOk) manualOk = o.manualOk; if (o.baseUrl) baseUrl = o.baseUrl; if (o.appConc) conc = o.appConc;
    // 1 was the old default and it hides exactly the ৳1 mismatches — drop it once, keep any other choice
    if (o.appTol != null) { if (o.appTol === 1 && !o.tolMigrated) { tol = 0; try { chrome.storage.local.set({ appTol: 0, tolMigrated: true }); } catch (e) {} } else tol = o.appTol; } wire(); applyTheme(o.theme || "dark"); applyLang(o.lang || "en"); testConn(); }); }
  catch (e) { wire(); applyTheme("dark"); applyLang("en"); }
})();
