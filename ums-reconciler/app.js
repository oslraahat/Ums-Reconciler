/* UMS Payment Verify — full-screen dashboard (extension page).
 * Runs in the user's session (cross-origin fetch with credentials, host permission).
 * Reconcile logic reused from reconcile.js (self.UMSREC). */
(function () {
  "use strict";
  const U = self.UMSREC;
  const $ = function (id) { return document.getElementById(id); };
  const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  /* Minutes past a hundred stop reading as a duration: a run with five and a half hours to go
     said "332:50", which is arithmetically right and tells nobody anything. Hours get their own
     field once there are any; below an hour it stays mm:ss, which is what a short run wants. */
  function span(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 3600) return mmss(ms);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h + ":" + String(m).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0");
  }
  function mmss(ms) { const s = Math.floor(ms / 1000); return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0"); }

  // tol 0 like the CLI: at 1 the near() test swallows exactly the ৳1 row-wise differences we are
  // hunting for. Still editable in Settings if a run needs slack.
  let baseUrl = "https://ums-5.osl.team", conc = 25, tol = 0;
  /* Two-server mode. baseUrl is the Expected (reference) server and baseUrl2 the Actual one being
     checked; srvMode says which question a run is answering — one server's two views against each
     other, or one page across two servers. Off by default: the single-server run is what this page
     has always done and nothing about it changes. */
  let baseUrl2 = "https://ums-41.osl.team", srvMode = false;
  let entries = [];
  let students = [], run = null, _token = null, renderBuf = null;

  // b omitted = the Expected server, so every existing caller keeps its meaning
  function payBase(b) { return String(b || baseUrl).replace(/\/+$/, "") + "/Student/Payment/"; }

  /* How hard the runner tries before it will say anything at all.
     A page that never arrived proves nothing about the student, so it is asked again rather than
     filed as a fault — "load error" and "পাতা খোলেনি" both read as findings about the data, and
     neither is one. These numbers are deliberately generous: waiting costs a slower run, giving up
     early costs a wrong answer that nobody will ever go back and re-check. */
  const NET_TRIES = 6;        // one page — attempts before the fetch itself gives up
  const CW_TRIES = 6;         // Course Wise must produce a real answer, not a half-built page
  const ITEM_TRIES = 5;       // one student, end to end
  const SWEEP_ROUNDS = 6;     // whole-run passes over whatever still has no answer
  /* A request that has said nothing for this long is not coming back — but each retry allows
     longer, because a server that is merely slow should be given the time it actually needs
     instead of being cut off at the same mark over and over. */
  const reqTimeout = function (a) { return Math.min(45000 * (a + 1), 180000); };

  /* Growing, jittered pause. The jitter matters at 25 parallel requests: without it every worker
     that hit the same hiccup comes back at the same instant and hits it together again. */
  function backoff(attempt, retryAfter) {
    const ra = parseFloat(retryAfter);
    const ms = (isFinite(ra) && ra > 0) ? Math.min(ra * 1000, 30000)
      : Math.min(800 * Math.pow(2, attempt), 20000);
    return sleep(Math.round(ms * (0.75 + Math.random() * 0.5)));
  }

  /* Twenty-five parallel requests is often what makes a struggling server struggle. Count how many
     refusals are arriving and make every worker wait before its next page while they pile up: the
     run slows down instead of the server falling over, which is the difference between finishing
     late and finishing with a page full of "load error". */
  let pressure = 0;
  function netPressure(bad) { pressure = bad ? Math.min(pressure + 1, 20) : Math.max(0, pressure - 1); }
  /* Shorter than it was. It used to reach three seconds because it was the only brake there was;
     now that the number of workers comes down too, a long blanket sleep on top of a narrower run
     is braking twice for one problem — and it is the pause everyone takes together, which is the
     part that bunches the traffic back up when it ends. */
  function breathe() { return pressure > 2 ? sleep(Math.min(pressure * 120, 1500)) : Promise.resolve(); }

  /* How many workers may be running right now, against how many the user allowed.

     Falling is quick: by the time refusals have been counted the server has been struggling for a
     while already, and 30% off each time reaches a gentle rate in a few steps. Climbing is slow
     and only while nothing at all is being refused — a server that has just stopped refusing is
     not yet a server that wants twenty-five more pages. The floor is 2 rather than 1 so a run can
     always still make progress, and the ceiling is always conc. */
  let live = 0, liveAt = 0;
  function pace() {
    const now = Date.now();
    if (pressure > 3) {
      if (now - liveAt < 4000) return;
      liveAt = now;
      live = Math.max(2, Math.floor(live * 0.7));
    } else if (pressure === 0 && live < conc) {
      if (now - liveAt < 12000) return;
      liveAt = now;
      live = Math.min(conc, live + Math.max(1, Math.round(conc / 10)));
    }
  }

  // ---------- i18n ----------
  let lang = "bn";
  const DICT = {
    subtitle: { bn: "Program Wise ⇄ Course Wise — Registration No. ও StudentProgramId দিন, রান চাপুন, রিপোর্ট পান", en: "Program Wise ⇄ Course Wise — enter Registration No. & StudentProgramId, run, get the report" },
    p_eased: { bn: "সার্ভার চাপে — একসাথে {n}টি", en: "server under strain — {n} at a time" },
    dl_failed: { bn: "রিপোর্টটা বানানো গেল না — ফিল্টার বেছে (যেমন Total Problem) আবার চেষ্টা করো, বা শিটটা ভাগ করে চালাও", en: "the report could not be built — choose a filter (Total Problem, say) and try again, or run the sheet in parts" },
    tab_all: { bn: "ফলাফল", en: "Result" },
    tab_problem: { bn: "সমস্যা", en: "Problems" },
    tab_ok: { bn: "ঠিক আছে", en: "Matched" },
    s_tab_problem: { bn: "আলাদা", en: "Different" },
    s_tab_ok: { bn: "দুই সার্ভারে এক", en: "Identical" },
    xlsx_toobig: { bn: "Excel-এ এক শিটে {m} সারির বেশি ধরে না, এখানে {n} সারি — ফিল্টার বেছে (যেমন Total Problem) আবার Export করো, বা শিটটা ভাগ করে চালাও", en: "Excel holds at most {m} rows in one sheet and this is {n} — choose a filter (Total Problem, say) and export again, or run the sheet in parts" },
    /* The number, in the units the box above is set in — "all of them" named nothing a reader
       could point at, and the protocol that explains it belongs with the rest of the explanation,
       in the tooltip. */
    conc_real: { bn: "✓ {n} ছাত্র = {r}টি অনুরোধ একসাথে", en: "✓ {n} students = {r} requests at once" },
    conc_capped: { bn: "⚠ {n} ছাত্র যাচ্ছে, {c} নয় — {r}টি অনুরোধ",
      en: "⚠ {n} students go at once, not {c} — {r} requests" },
    /* The one thing the tool cannot see: the other machines. Said in the tooltip because the
       number in the box is per browser, and a server is met by all of them together. */
    conc_many_pc: { bn: "এক ছাত্র মানে {e}টি পাতা, তাই {n} লিখলে এই ব্রাউজার থেকে {r}টি অনুরোধ একসাথে যায়। কয়েকটা PC থেকে একসাথে চালালে সার্ভার পায় তার গুণফল — ৪টি PC হলে {r4}টি।",
      en: "One student is {e} pages, so {n} here means {r} requests at once from this browser. Run it from several PCs and the server meets the sum of them — {r4} from four." },
    /* The ✓ has two different reasons behind it and they lead to opposite advice, so it gets two
       tooltips. Saying "the server speaks HTTP/2" under a ✓ that only means "4 is under the
       browser's 6" would be false — and it is the sentence someone reads before deciding whether
       raising the number is worth anything. */
    conc_why_h2: { bn: "সার্ভার HTTP/2 ({p}) বলে, তাই সব অনুরোধ একটাই সংযোগে ভাগাভাগি হয় — ব্রাউজারের ৬টির সীমা এখানে খাটে না। বাকি সীমাটা সার্ভারের নিজের (সাধারণত ১০০-র কাছাকাছি), তাই সংখ্যা বাড়িয়ে দেখা যায়: সার্ভার আপত্তি করলে রান নিজেই সরু হবে আর progress লাইনে তা লিখে জানাবে।", en: "The server speaks HTTP/2 ({p}), so every request shares one connection and the browser's six-per-host limit does not apply. What is left is the server's own limit (commonly around 100), so the number is worth raising: if the server objects, the run narrows itself and says so on the progress line." },
    conc_why_room: { bn: "সার্ভার {p} বলে। এতে ব্রাউজার এক সার্ভারে একসাথে ৬টির বেশি সংযোগ রাখে না — তোমার সংখ্যাটা এখনো তার নিচে, তাই পুরোটাই সার্ভারে পৌঁছাচ্ছে। ৬-এর (দুই সার্ভারে ১২-র) বেশি লিখলে বাড়তিগুলো ব্রাউজারেই লাইনে দাঁড়াবে, রান দ্রুত হবে না।", en: "The server speaks {p}, so the browser keeps at most 6 connections to one server — your number is still under that, so all of it reaches the server. Above 6 (12 across two servers) the extra ones queue in the browser and the run gets no faster." },
    conc_why_capped: { bn: "সার্ভার {p} বলে। এতে ব্রাউজার এক সার্ভারে একসাথে ৬টির বেশি সংযোগ রাখে না — বাকিগুলো ব্রাউজারেই লাইনে দাঁড়িয়ে থাকে, সার্ভারে পৌঁছায় না। এর চেয়ে বড় সংখ্যা লিখলে রান দ্রুত হয় না।", en: "The server speaks {p}, so the browser keeps at most 6 connections to one server — the rest queue inside the browser and never reach it. A bigger number here will not make the run faster." },
    ck_upto: { bn: "পর্যন্ত সেভ করা আছে", en: "saved so far" },
    ck_go: { bn: "▶ বাকিটা চালাও", en: "▶ Carry on" },
    ck_drop: { bn: "✕ বাদ দাও", en: "✕ Discard" },
    ck_loading: { bn: "⏳ সেভ করা ফল ফিরিয়ে আনা হচ্ছে…", en: "⏳ Loading the saved answers…" },
    ck_src: { bn: "আগের অসম্পূর্ণ রান", en: "an unfinished run" },
    /* Not an error — a run with nowhere chosen still saves, to Downloads, and that is a real
       answer for someone who never wanted a folder. But it is a poor thing to find out after a
       run instead of before one, so it is put as a question while the folder can still be
       chosen, and Start says why it did nothing if the answer is no. */
    /* The menu, and the two places it leads. */
    nav_head: { bn: "বিভাগ", en: "Sections" },
    nav_pay: { bn: "Payment History", en: "Payment History" },
    nav_crm: { bn: "CRM", en: "CRM" },
    nav_adm: { bn: "New Admission", en: "New Admission" },
    adm_sub: { bn: "নতুন Admission — যত খুশি, নিজের সেশনে", en: "New Admission — as many as you like, on your session" },
    adm_h: { bn: "New Admission", en: "New Admission" },
    adm_load: { bn: "⟳ তথ্য আনো", en: "⟳ Fetch Data" },
    adm_loading: { bn: "⏳ আনছে…", en: "⏳ loading…" },
    adm_defaults: { bn: "▸ Gender · Religion · Branch · Campus · Amount · Institute · Discount", en: "▸ Gender · Religion · Branch · Campus · Amount · Institute · Discount" },
    adm_gender_l: { bn: "Gender", en: "Gender" },
    adm_religion_l: { bn: "Religion", en: "Religion" },
    adm_session_l: { bn: "Session", en: "Session" },
    adm_branch_l: { bn: "Branch", en: "Branch" },
    adm_campus_l: { bn: "Campus", en: "Campus" },
    adm_inst_l: { bn: "Institute", en: "Institute" },
    adm_discount_l: { bn: "Special Discount — ঐচ্ছিক", en: "Special Discount — optional" },
    adm_appr_l: { bn: "Discount Approved By", en: "Discount Approved By" },
    adm_pick_prog: { bn: "— আগে Fetch Data চাপো —", en: "— press Fetch Data first —" },
    adm_courses_l: { bn: "Courses (টিক দাও · পাশে batch দেখাবে)", en: "Courses (tick · batch shown)" },
    adm_courses_hint: { bn: "ফর্ম আনলে কোর্স এখানে আসবে", en: "courses appear here once the form is loaded" },
    adm_no_courses: { bn: "এই প্রোগ্রামে কোর্স নেই", en: "no courses on this program" },
    adm_seq: { bn: "একজন একজন", en: "One at a time" },
    adm_par: { bn: "একসাথে", en: "All at once" },
    adm_intro: { bn: "⟳ Fetch Data চাপো, dropdown বেছে নাও, মোবাইল ও সংখ্যা দিয়ে ▶ Run। ⚠ আসল admission তৈরি হয় — টেস্ট সার্ভারে চালাও।",
      en: "Press ⟳ Fetch Data, pick the dropdowns, give the mobile and count, then ▶ Run. ⚠ Creates real admissions — use a test server." },
    adm_base_l: { bn: "UMS ঠিকানা", en: "UMS address" },
    adm_mobile_l: { bn: "Mobile Number", en: "Mobile Number" },
    adm_prog_l: { bn: "Program", en: "Program" },
    adm_amount_l: { bn: "Amount", en: "Amount" },
    adm_count_l: { bn: "Count", en: "Count" },
    adm_r_reg: { bn: "রেজি", en: "Reg" },
    adm_r_roll: { bn: "রোল", en: "Roll" },
    adm_r_mr: { bn: "রসিদ", en: "MR" },
    adm_r_id: { bn: "রসিদ-id", en: "MR id" },
    adm_r_paid: { bn: "দেওয়া", en: "Paid" },
    adm_r_due: { bn: "বাকি", en: "Due" },
    adm_http_l: { bn: "⚡ HTTP", en: "⚡ HTTP" },
    adm_browser_l: { bn: "🌐 ব্রাউজার", en: "🌐 Browser" },
    adm_browser_t: { bn: "ব্রাউজারে আসল ফর্ম খুলে দৃশ্যমান করে চালায় (ধীর, একজন একজন)", en: "opens the real form in a tab and runs it visibly (slower, one at a time)" },
    adm_pool_l: { bn: "একসাথে", en: "at once" },
    adm_need_load: { bn: "আগে ⟳ ফর্ম আনো চাপো", en: "press ⟳ Load form first" },
    adm_need_course: { bn: "অন্তত একটা কোর্স টিক দাও", en: "tick at least one course" },
    adm_inst_ph: { bn: "নাম টাইপ করো…", en: "type a name…" },
    adm_appr_ph: { bn: "PIN / Mobile / Name", en: "PIN / Mobile / Name" },
    adm_mobile_ph: { bn: "8801XXXXXXXXX", en: "8801XXXXXXXXX" },
    adm_amount_ph: { bn: "min (অটো)", en: "min (auto)" },
    adm_discount_ph: { bn: "0", en: "0" },
    adm_need_appr: { bn: "Discount দিলে Discount Approved By বেছে নাও", en: "pick Discount Approved By when a discount is set" },
    adm_loaded: { bn: "✓ {n}টা program এলো", en: "✓ {n} programs loaded" },
    adm_no_program: { bn: "কোনো program পাওয়া গেল না", en: "no programs found" },
    adm_run: { bn: "▶ Run Admission", en: "▶ Run Admission" },
    adm_running: { bn: "⏳ চলছে…", en: "⏳ running…" },
    adm_stop: { bn: "✕ থামাও", en: "✕ Stop" },
    adm_run_hint: { bn: "প্রতিটার Reg No দেখায়, শেষে কয়টা সফল/ব্যর্থ। ✕ থামায়।",
      en: "Shows each Reg No, then how many passed/failed. ✕ stops it." },
    adm_need_base: { bn: "আগে UMS ঠিকানা দাও", en: "fill in the UMS address first" },
    adm_need_mobile: { bn: "মোবাইল নম্বর দাও", en: "enter a mobile number" },
    crm_sub: { bn: "CRM — আলাদা নিয়মে কাজ", en: "CRM — a different set of rules" },
    crm_dash: { bn: "Dashboard", en: "Dashboard" },
    crm_dash_h: { bn: "CRM · Dashboard", en: "CRM · Dashboard" },
    /* CRM · Dashboard is a load-test configurator: it cannot run the test — one browser is one
       session — so it builds the users.txt and the command for the separate crm-loadtest tool. */
    crm_lt_intro: { bn: "অনেকজন একসাথে CRM Dashboard খুললে ধীর হয় কিনা মেপে দেখো। নিচে ঠিকানা ও ইউজার দাও, তারপর ▶ Run।",
      en: "See if the CRM Dashboard slows when many open it at once. Add the address and users below, then press ▶ Run." },
    crm_mode_l: { bn: "কীভাবে ভিজিট করবে", en: "How to visit" },
    crm_parallel: { bn: "একসাথে", en: "All at once" },
    crm_sequential: { bn: "একজন একজন", en: "One at a time" },
    crm_base_l: { bn: "UMS ঠিকানা", en: "UMS address" },
    crm_count_l: { bn: "একসাথে কতজন", en: "How many at once" },
    crm_headed: { bn: "ব্রাউজার দেখাও", en: "Show the browser" },
    crm_users_ph: { bn: "প্রতি লাইনে: username, password", en: "one per line: username, password" },
    crm_import: { bn: "⬆ Import Excel", en: "⬆ Import Excel" },
    crm_link_ph: { bn: "…অথবা Google Sheet লিংক", en: "…or a Google Sheet link" },
    crm_link_btn: { bn: "↧ Sheet Link", en: "↧ Sheet Link" },
    crm_clear: { bn: "✕ Clear", en: "✕ Clear" },
    crm_pairs: { bn: "{n} জন", en: "{n} users" },
    crm_dl: { bn: "⬇ users.txt", en: "⬇ users.txt" },
    crm_cmd_l: { bn: "crm-loadtest ফোল্ডারে চালাও", en: "Run in the crm-loadtest folder" },
    crm_copy: { bn: "⧉ Copy", en: "⧉ Copy" },
    crm_run: { bn: "▶ চালাও", en: "▶ Run" },
    crm_running: { bn: "⏳ চলছে…", en: "⏳ running…" },
    crm_run_hint: { bn: "লগইন করে Dashboard খোলে, সময় মাপে। ব্রাউজার খোলা থাকলে Sequential-এ আবার Run চাপলে পরের জন যোগ হয়; ✕ দিয়ে বন্ধ।",
      en: "Logs in, opens the Dashboard, and times it. While the browser stays open, Run again in Sequential adds the next user; ✕ closes it." },
    crm_manual_sum: { bn: "▸ অথবা নিজে টার্মিনালে চালাও", en: "▸ or run it yourself in a terminal" },
    crm_need_users: { bn: "আগে username, password দাও", en: "add some username,password lines first" },
    crm_need_base: { bn: "আগে UMS ঠিকানা দাও", en: "fill in the UMS address first" },
    crm_host_missing: { bn: "সহায়ক প্রোগ্রামটা ইনস্টল নেই। crm-loadtest/host ফোল্ডারে টার্মিনাল খুলে চালাও:  node install.js  — তারপর এক্সটেনশন reload করো।",
      en: "The helper isn't installed. Open a terminal in crm-loadtest/host and run:  node install.js  — then reload the extension." },
    crm_close: { bn: "ভিজিটের পর বন্ধ করো", en: "Close after each visit" },
    crm_max: { bn: "স্ক্রিনজুড়ে বড় করো", en: "Maximize to screen" },
    crm_reach_ok: { bn: "✓ সার্ভার পাওয়া গেছে", en: "✓ Server reachable" },
    crm_reach_no: { bn: "✗ পৌঁছানো যায়নি — ঠিকানা দেখো", en: "✗ Can't reach — check the address" },
    crm_stop: { bn: "✕ ব্রাউজার বন্ধ", en: "✕ Close Browser" },
    crm_closed: { bn: "— ব্রাউজার বন্ধ, আবার প্রথম থেকে —", en: "— browser closed, back to the start —" },
    crm_next: { bn: "পরের: {u}  ({n}/{m})", en: "next: {u}  ({n}/{m})" },
    crm_next_wrap: { bn: "সব শেষ — আবার প্রথম জন থেকে", en: "reached the end — starts over from the first" },
    crm_copied: { bn: "✓ কপি হয়েছে", en: "✓ copied" },
    crm_steps: { bn: "১) ⬇ users.txt চেপে ফাইলটা crm-loadtest ফোল্ডারে রাখো  ২) প্রথমবার: npm install  ৩) উপরের কমান্ডটা চালাও।  ছোট সংখ্যায় শুরু করো — এটা সার্ভারে সত্যিকারের চাপ ফেলে।",
      en: "1) press ⬇ users.txt and save it into the crm-loadtest folder  2) first time only: npm install  3) run the command above.  Start with a small number — this puts real load on the server." },
    save_nodir_ask: { bn: "“ফল সেভ করো” চালু আছে, কিন্তু কোনো ফোল্ডার বাছা হয়নি।\n\nএভাবে চালালে ফল যাবে Downloads / UMS Reconciler-এ।\n\nএভাবেই চালাব?",
      en: "“Save the result” is on, but no folder has been chosen.\n\nRun anyway and the files go to Downloads / UMS Reconciler.\n\nStart like that?" },
    save_nodir_stopped: { bn: "শুরু করা হয়নি — “📁 ফোল্ডার” চেপে জায়গা বেছে নাও, নয়তো “ফল সেভ করো” বন্ধ করো।",
      en: "Not started — press “📁 Folder” to choose somewhere, or switch “Save the result” off." },
    /* A fault in the tool, not a verdict about anybody's data — and the difference decides
       whether the next thing someone does is look at a student or tell you. */
    run_broke: { bn: "রান থেমে গেছে — টুলের ভেতরে একটা গোলমাল", en: "The run stopped — something went wrong inside the tool" },
    ck_kept: { bn: "শুরু করা হয়নি — আগের রানটা রাখা আছে, উপরে “▶ বাকিটা চালাও” আছে",
      en: "Not started — the earlier run is kept; “▶ Carry on” is at the top" },
    ck_dead: { bn: "⚠ এই রানটা সেভ হচ্ছে না — থামলে বা ট্যাব বন্ধ হলে আবার শুরু থেকে চালাতে হবে।",
      en: "⚠ This run is not being saved — if it stops, or the tab closes, it starts over." },
    ck_ask: { bn: "আগের রানের {n} টি ফল সেভ করা আছে। নতুন করে শুরু করলে সেগুলো মুছে যাবে।\n\nউপরের “▶ বাকিটা চালাও” চাপলে ওখান থেকেই চলবে।\n\nতবু নতুন করে শুরু করবে?",
      en: "{n} answers from the last run are saved. Starting fresh throws them away.\n\n“▶ Carry on” at the top picks up where it stopped.\n\nStart fresh anyway?" },
    ck_ask_other: { bn: "অন্য একটা শিটের অসম্পূর্ণ রান সেভ করা আছে ({n} টি ফল)। এই শিট দিয়ে শুরু করলে সেটা মুছে যাবে।\n\nশুরু করব?",
      en: "An unfinished run on a different sheet is saved ({n} answers). Starting this one throws it away.\n\nStart?" },
    ck_hint: { bn: "আগের রানটা শেষ হয়নি — ট্যাব বন্ধ হয়েছিল বা তুমি থামিয়েছিলে। শিট আবার import করতে হবে না।", en: "The last run did not finish — the tab closed, or you stopped it. The sheet does not need importing again." },
    /* not s_-prefixed: t() looks for "s_" + key first, so a key that already begins with s_ and
       has no base reads as a twin whose base has been deleted */
    srv_tag: { bn: "দুই সার্ভার", en: "two servers" },
    ago_now: { bn: "এই মাত্র", en: "just now" },
    ago_min: { bn: "{n} মিনিট আগে", en: "{n} min ago" },
    ago_hr: { bn: "{n} ঘণ্টা আগে", en: "{n} hr ago" },
    ago_day: { bn: "{n} দিন আগে", en: "{n} days ago" },
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
    clear_btn: { bn: "✕ Clear", en: "✕ Clear" }, pv_reg: { bn: "Reg No.", en: "Reg No." },
    pv_search_ph: { bn: "খুঁজুন…", en: "Search…" },
    pv_more: { bn: "দেখাচ্ছে {a}টি / মোট {b}টি", en: "showing {a} of {b}" }, pv_none: { bn: "কিছু মিলল না", en: "no match" },
    
    imp_dropped: { bn: "টি ডুপ্লিকেট বাদ", en: "duplicate(s) dropped" }, imp_will_run: { bn: "টি চলবে", en: "will run" }, imp_noreg: { bn: "টিতে Reg নেই", en: "without a Reg" }, imp_trim: { bn: "টিতে Reg ঘরে একাধিক সংখ্যা ছিল, প্রথমটা নেওয়া হয়েছে", en: "had more than one number in the Reg cell — first one used" },
    imp_checking: { bn: "কোন কলামে কী, UMS-এ মিলিয়ে দেখা হচ্ছে…", en: "checking with UMS which column is which…" },
    imp_swap: { bn: "কলাম উল্টো ছিল — Reg আর Student PID বদলে নেওয়া হয়েছে", en: "columns were the wrong way round — Reg and Student PID swapped back" },
    rr_run: { bn: "টি আবার চালাও", en: "to re-run" }, rr_none: { bn: "কিছু নেই", en: "nothing here" }, rr_busy: { bn: "চলছে…", en: "running…" },
    settings_h: { bn: "সেটিংস ও রান", en: "Settings & Run" }, tol_l: { bn: "গ্রহণযোগ্য পার্থক্য", en: "Tolerance" }, conc_l: { bn: "একসাথে কয়টি ছাত্র", en: "Students at once" },
    run_btn: { bn: "▶ Start", en: "▶ Start" },
    imp_row: { bn: "টি", en: "entries" }, imp_empty: { bn: "ফাইল খালি", en: "File empty" },
    imp_excel: { bn: "⏳ Excel পড়ছি…", en: "⏳ Reading Excel…" }, imp_excel_fail: { bn: "Excel পড়া গেল না", en: "Could not read Excel" },
    imp_sheet: { bn: "⏳ Sheet আনছি…", en: "⏳ Fetching Sheet…" }, imp_login: { bn: "Google লগইন/অ্যাক্সেস দরকার", en: "Google login/access needed" }, imp_fail: { bn: "আনা গেল না", en: "Could not fetch" }, imp_badlink: { bn: "লিংক ঠিক নয়", en: "Invalid link" },
    e_need: { bn: "spid বা program দাও", en: "give spid or program" }, e_pw: { bn: "Program Wise data নেই (redirect/ভুল spid?)", en: "No Program Wise data (redirect/wrong spid?)" }, e_perm: { bn: "search permission নেই", en: "no search permission" }, e_regspid: { bn: "এই সারিতে Reg আর Student PID একই সংখ্যা — এক ঘরের নম্বরই দুই ঘরে বসে গেছে কিনা দেখো (কলাম উল্টে দিলেও এই সারিতে কিছু বদলাত না)", en: "Reg and Student PID are the same number on this row — check one value has not been pasted into both cells (swapping the columns would change nothing here)" },
    results_h: { bn: "ফলাফল", en: "Results" }, ready: { bn: "প্রস্তুত", en: "Ready" },
    t_ok: { bn: "মিলেছে", en: "Matched" }, t_no: { bn: "অমিল", en: "Mismatch" }, t_cw: { bn: "CW ফাঁকা", en: "CW Empty" }, t_zero: { bn: "Zero Pay", en: "Zero Pay" }, t_stu: { bn: "Total Problem", en: "Total Problem" }, t_nf: { bn: "Program পাওয়া যায়নি", en: "Program Not Found" }, 
    tt_prob: { bn: "অমিল + CW ফাঁকা + Program পাওয়া যায়নি + লোড এরর — সব মিলিয়ে (Reg + Student PID ধরে)। Zero Pay এতে নেই — টাকাই ওঠেনি, মেলানোর কিছু নেই", en: "Mismatch + CW empty + Program not found + Load error, all together (by Reg + Student PID). Zero Pay is not in it — no money was ever taken, so there is nothing to reconcile" },
    f_all: { bn: "সব", en: "All" }, f_no: { bn: "শুধু অমিল", en: "Mismatch" }, f_ok: { bn: "শুধু মিলেছে", en: "Matched" }, f_cw: { bn: "শুধু CW ফাঁকা", en: "CW Empty" }, f_zero: { bn: "Zero Pay", en: "Zero Pay" }, f_nf: { bn: "Program পাওয়া যায়নি", en: "Program Not Found" },
    pill_ok: { bn: "✓ মিলেছে", en: "✓ Matched" }, pill_no: { bn: "✕ অমিল", en: "✕ Mismatch" }, pill_cw: { bn: "CW ফাঁকা", en: "CW Empty" }, pill_zero: { bn: "Zero Pay", en: "Zero Pay" }, pill_nf: { bn: "Program পাওয়া যায়নি", en: "Program Not Found" }, pill_error: { bn: "লোড এরর", en: "Load error" },
    /* per minute, and the time still to go. Both are read off the run rather than estimated
       from the setting, because what the setting allows and what the server gives are two
       different numbers and only the second one is the run. */
    p_rate: { bn: "{n}/মিনিট", en: "{n}/min" },
    /* Where a finished run's time actually went. Only said when a phase took long enough to be
       worth explaining — on a short run the three numbers would be noise. */
    p_phases: { bn: "রান {a} · আবার-চাওয়া {b} · সেভ {c}",
      en: "run {a} · re-asking {b} · saving {c}" },
    p_left: { bn: "আর ~{t}", en: "~{t} left" },
    p_verifying: { bn: "যাচাই", en: "Verified" }, p_running: { bn: "চলছে", en: "running" }, p_done: { bn: "শেষ", en: "Done" }, p_input: { bn: "ইনপুট দাও", en: "Enter input" },
    conn_ok: { bn: "✓ লগইন আছে", en: "✓ Logged in" }, conn_no: { bn: "✗ লগইন নেই", en: "✗ Not logged in" }, conn_fail: { bn: "✗ সংযোগ ব্যর্থ", en: "✗ Connection failed" },
    items: { bn: "টি", en: "items" }, stu_checked: { bn: "টি Program যাচাই · মোট", en: "program(s) checked · of" }, stu_of: { bn: "টির মধ্যে", en: "total" },
    d_allmatch: { bn: "সব মিলেছে", en: "all matched" }, d_cwempty: { bn: "Course Wise ফাঁকা (No Data)", en: "Course Wise empty (No Data)" }, d_tries: { bn: "বার চেষ্টা করা হয়েছে", en: "attempts" }, d_zero: { bn: "কোনো Payment হয়নি — সব ঘরে ০, Course Wise ফাঁকা থাকাই স্বাভাবিক", en: "No payment at all — every figure is 0, so an empty Course Wise is expected" },
    d_cwredir: { bn: "Course Wise পাতাটা খুললই না (reg ভুল, নাকি permission নেই?) — Program Wise ঠিকই এসেছে", en: "Course Wise page did not open (wrong reg, or no permission?) — Program Wise loaded fine" },
    d_cwnotable: { bn: "Course Wise পাতা এসেছে, কিন্তু টেবিলটাই পাওয়া গেল না (permission, নাকি পাতার markup বদলেছে?) — ফাঁকা নয়, কিছুই পড়া হয়নি", en: "Course Wise page loaded but its table was not found (permission, or the page markup changed?) — not empty, nothing was read at all" },
    d_noprog: { bn: "এই Student-এর এমন কোনো Program নেই", en: "This student has no such program" }, d_has: { bn: "· আছে:", en: "· has:" },
    
    sheet_l: { bn: "কোন শিট পড়া হবে", en: "Which sheet to read" },
    sheet_unknown: { bn: "শিটের তালিকা পড়া গেল না — ফাইলের প্রথম worksheet নেওয়া হয়েছে, তাই শিট বাছার বাক্সটা নেই", en: "could not read the workbook’s sheet list — the first worksheet in the file was used, so there is no sheet picker" },
    src_sheet: { bn: "শিট", en: "Sheet" }, src_link: { bn: "Google Sheet", en: "Google Sheet" }, src_paste: { bn: "✎ পেস্ট বক্স", en: "✎ Paste box" },
    mk_do: { bn: "✓ Mark as Matched", en: "✓ Mark as Matched" }, mk_undo: { bn: "↺ Undo", en: "↺ Undo" },
    mk_tip: { bn: "UMS-এ হাতে দেখে ঠিক পেয়েছি — মিলেছে ধরো", en: "Checked by hand in UMS and found correct — treat as matched" },
    mk_tip_undo: { bn: "হাতে-দেওয়া রায় তুলে নাও", en: "Take the manual verdict back" },
    pill_manual: { bn: "✓ মিলেছে · হাতে দেখা", en: "✓ Matched · checked" },
    saved: { bn: "✓ সেভ হয়েছে", en: "✓ Saved" }, checking: { bn: "যাচাই হচ্ছে…", en: "checking…" },
    conn_exp: { bn: "Expected", en: "Expected" }, conn_act: { bn: "Actual", en: "Actual" },
    pause: { bn: "⏸ Pause", en: "⏸ Pause" }, resume: { bn: "▶ Resume", en: "▶ Resume" }, paused: { bn: "⏸ থামানো (Resume চাপো)", en: "⏸ Paused (press Resume)" },
    stopping: { bn: "⏹ থামানো হচ্ছে…", en: "⏹ Stopping…" },
    p_retry: { bn: "{n} টির উত্তর আসেনি — আবার চাইছি (রাউন্ড {r})", en: "{n} unanswered — asking again (round {r})" },
    save_l: { bn: "রান শেষে", en: "When the run ends" },
    save_run: { bn: "ফল সেভ করো", en: "Save the results" },
    save_pick: { bn: "কোথায় সেভ হবে — ফোল্ডার বাছো", en: "Where to save — choose a folder" },
    save_pick_b: { bn: "📁 ফোল্ডার", en: "📁 Folder" },
    save_folder: { bn: "প্রতি রানে তারিখ-সময়ের ফোল্ডার", en: "a dated folder per run" },
    save_downloads: { bn: "Downloads / UMS Reconciler / তারিখ-সময়ের ফোল্ডার", en: "Downloads / UMS Reconciler / a dated folder" },
    save_nopicker: { bn: "এই ব্রাউজার ফোল্ডার বাছতে দেয় না — Downloads-এ যাবে", en: "this browser cannot pick a folder — it will go to Downloads" },
    /* Three clauses, and they are the three things worth knowing standing at this switch: what
       is saved, that the page is a button rather than part of it, and where it lands if no
       folder was chosen. The reasons behind each are in the README, which is where a reason
       gets read — under a toggle it is just small grey type nobody finishes. */
    save_hint: { bn: "report.xlsx — দুই ট্যাব (সমস্যা, ঠিক আছে), ফিল্টার যা-ই থাক পুরো রান। HTML চাইলে ⬇ HTML Report। ফোল্ডার না বাছলে Downloads-এ যাবে।",
      en: "report.xlsx — two tabs (problems, matched), the whole run whatever the filter says. For a page, press ⬇ HTML Report. Without a folder it goes to Downloads." },
    save_failed: { bn: "সেভ করা গেল না", en: "could not save" },
    p_saving: { bn: "ফল সেভ করা হচ্ছে…", en: "saving the results…" },
    list_capped: { bn: "নিচে প্রথম {a} টি দেখানো হচ্ছে · মোট {b} টি — পুরোটা HTML / Excel রিপোর্টে আছে", en: "showing the first {a} of {b} below — the HTML and Excel reports carry them all" },
    p_unanswered: { bn: "{n} টিতে উত্তর নেই", en: "{n} unanswered" },
    /* Not "the server is busy" — a busy server refuses, and refusals are counted. This is a
       server answering promptly with a page that has no table on it, for everyone. */
    p_none_answered: { bn: "⚠ {n} টি ({p}%) ছাত্রের উত্তর আসেনি — সার্ভার সাড়া দিচ্ছে কিন্তু টেবিল দিচ্ছে না। লগইন আর ঠিকানা দেখো; আবার চাওয়ার মানে নেই, তাই চাওয়া হয়নি।",
      en: "⚠ {n} students ({p}%) went unanswered — the server replies but has no table on the page. Check the login and the address; asking again would prove nothing, so it was not done." },
    d_noanswer: { bn: "সার্ভার সাড়া দেয়নি — {n} বার চাওয়া হয়েছে, ডেটা নিয়ে কিছুই বলা যায়নি", en: "no answer from the server — asked {n} times; nothing was concluded about the data" },

    /* ---- two-server mode ---- */
    srv_mode: { bn: "দুই সার্ভার মেলাও (Expected ↔ Actual)", en: "Compare two servers (Expected ↔ Actual)" },
    srv_hint: { bn: "একই Reg + StudentProgramId দুই সার্ভারে খুলে প্রতিটা সারির প্রতিটা ঘর মিলিয়ে দেখা হবে। দুই সার্ভারেই লগইন থাকতে হবে।", en: "Opens the same Reg + StudentProgramId on both servers and compares every cell of every row. You must be logged in to both." },
    s_base_l: { bn: "Expected URL (যেটাকে ঠিক ধরা হচ্ছে)", en: "Expected URL (the reference)" },
    base_act_l: { bn: "Actual URL (যেটা যাচাই হবে)", en: "Actual URL (the one being checked)" },
    e_pw_both: { bn: "কোনো সার্ভারেই Program Wise পাওয়া গেল না (ভুল reg/spid?)", en: "No Program Wise on either server (wrong reg/spid?)" },
    s_subtitle: { bn: "Expected ⇄ Actual — একই ছাত্র দুই সার্ভারে, প্রতিটা ঘর মিলিয়ে দেখা", en: "Expected ⇄ Actual — one student on two servers, every cell compared" },
    s_t_ok: { bn: "দুই সার্ভারে এক", en: "Identical" }, s_t_no: { bn: "ডেটা আলাদা", en: "Data differs" },
    s_t_cw: { bn: "Actual-এ সারি নেই", en: "Missing on Actual" }, s_t_zero: { bn: "Actual-এ বাড়তি", en: "Extra on Actual" },
    s_t_nf: { bn: "পাতা পড়া যায়নি", en: "Page not read" },
    s_pill_ok: { bn: "✓ এক", en: "✓ Identical" }, s_pill_no: { bn: "✕ আলাদা", en: "✕ Differs" },
    s_pill_cw: { bn: "Actual-এ নেই", en: "Missing on Actual" }, s_pill_zero: { bn: "Actual-এ বাড়তি", en: "Extra on Actual" },
    s_pill_nf: { bn: "পাতা পড়া যায়নি", en: "Page not read" },
    s_f_ok: { bn: "শুধু এক", en: "Identical" }, s_f_no: { bn: "শুধু আলাদা", en: "Differs" },
    s_f_cw: { bn: "Actual-এ নেই", en: "Missing on Actual" }, s_f_zero: { bn: "Actual-এ বাড়তি", en: "Extra on Actual" },
    s_f_nf: { bn: "পাতা পড়া যায়নি", en: "Page not read" },
    s_d_allmatch: { bn: "দুই সার্ভারে হুবহু এক", en: "identical on both servers" },
    s_tt_prob: { bn: "দুই সার্ভারে যা এক নয় — ডেটা আলাদা + Actual-এ নেই + Actual-এ বাড়তি + পাতা পড়া যায়নি + লোড এরর (Reg + Student PID ধরে)", en: "Everything that is not identical — data differs + missing on Actual + extra on Actual + page not read + load error (by Reg + Student PID)" },
    s_verify_h: { bn: "কোন ছাত্রদের মেলানো হবে", en: "Which students to compare" }
  };
  /* In two-server mode a key with an "s_" twin resolves to the twin. One lookup, so a label that
     means something different across two servers cannot be updated in one place and forgotten in
     the other. */
  function t(k) { const e = (srvMode && DICT["s_" + k]) || DICT[k]; return e ? (e[lang] || e.bn) : k; }
  function applyLang(l) {
    lang = (l === "en") ? "en" : "bn";
    document.querySelectorAll("[data-i18n]").forEach(function (el) { const s = t(el.getAttribute("data-i18n")); if (s != null) el.textContent = s; });
    document.querySelectorAll("[data-ph]").forEach(function (el) { const s = t(el.getAttribute("data-ph")); if (s != null) el.setAttribute("placeholder", s); });
    /* a tooltip is the third thing an element can say, and an icon-only button has nothing else */
    document.querySelectorAll("[data-title]").forEach(function (el) { const s = t(el.getAttribute("data-title")); if (s != null) el.setAttribute("title", s); });
    const b = $("lang"); if (b) b.textContent = (lang === "bn" ? "EN" : "BN");
    /* The import summary is a sentence built at import time out of counts and the file's name;
       there is nothing to translate it back from, so switching language clears it. The count it
       carried is still on the card's badge, which updateCount() repaints below. */
    const imp = $("impNote"); if (imp) imp.innerHTML = "";
    /* the reachability pills are written by JS (no data-i18n), so repaint them in the new language */
    if (typeof crmSetConn === "function") crmSetConn(crmConnState);
    if (typeof admSetConn === "function") admSetConn(admConnState);
    const pv = $("preview"); if (pv) pv.removeAttribute("data-col"); // force head rebuild in the new language
    /* Everything whose words are written by JS rather than by a data-i18n node has to be
       repainted here too, or it keeps the language it was first drawn in. paintSaveRow() runs
       during wire(), before the stored language is applied, so the save line stayed Bengali under
       an English interface. */
    updateCount(); rerenderList(); renderPreview(); paintRerun(); paintConn(); paintSaveRow();
    crmRender();
    measureTop();   // the words in the topbar just changed, and so may its height
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
  /* The header, as TEXT — which is what content.js hands headScore() from a rendered page.
     Handing it markup instead meant also searching tag names and attribute values, so a table
     whose header reads "Sl. Reg Date Course" but whose markup carries data-col="current due" and
     class="received" scored 0 in the panel and 4 here: the same page, a different table read, and
     two different reports about one student. */
  function headOf(frag) {
    const th = frag.match(/<thead[\s\S]*?<\/thead>/i);
    const part = th ? th[0] : (frag.match(/(?:<tr[\s\S]*?<\/tr>\s*){1,3}/i) || [""])[0];
    return part.replace(/<[^>]*>/g, " ");
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

  /* Waiting is not failing. A request that times out, is refused, or comes back 5xx/429/408 has
     said nothing about the student, so it is asked again — with a growing jittered pause, and
     honouring Retry-After when the server sends one. Only a real reply, or Stop, ends the loop.

     The per-request timeout is what keeps a run moving: without it one socket that goes quiet
     holds its worker for as long as the browser allows, and at 25 workers a handful of those is
     the whole run stopped. It aborts THAT request only — run.ac stays the user's Stop button. */
  async function fetchHtml(url) {
    let last;
    for (let a = 0; a < NET_TRIES; a++) {
      const ac = (typeof AbortController !== "undefined") ? new AbortController() : null;
      const stopIt = function () { if (ac) try { ac.abort(); } catch (e) {} };
      const runSig = (run && run.ac) ? run.ac.signal : null;
      if (runSig && ac) { if (runSig.aborted) stopIt(); else runSig.addEventListener("abort", stopIt); }
      let timer = null, timedOut = false;
      if (ac) timer = setTimeout(function () { timedOut = true; stopIt(); }, reqTimeout(a));
      try {
        const r = await fetch(url, { credentials: "include", signal: ac ? ac.signal : undefined });
        if (r.status >= 500 || r.status === 429 || r.status === 408) {
          netPressure(true);
          last = new Error("HTTP " + r.status);
          /* On the last attempt hand the response back rather than throwing: the caller can still
             tell a redirect from a table, and a 503 body is at least a fact about the page. */
          if (a < NET_TRIES - 1) { await backoff(a, r.headers.get("retry-after")); continue; }
          return { html: await r.text(), redirected: r.redirected, status: r.status, ok: r.ok };
        }
        netPressure(false);
        return { html: await r.text(), redirected: r.redirected, status: r.status, ok: r.ok };
      } catch (e) {
        // Stop is the user's decision, not a slow server — it is never retried
        if (run && run.stop) { const a2 = new Error("stopped"); a2.name = "AbortError"; throw a2; }
        if (e && e.name === "AbortError" && !timedOut) throw e;
        netPressure(true);
        last = timedOut ? new Error("timeout after " + Math.round(reqTimeout(a) / 1000) + "s") : e;
        if (a < NET_TRIES - 1) await backoff(a);
      } finally {
        if (timer) clearTimeout(timer);
        if (runSig && ac) try { runSig.removeEventListener("abort", stopIt); } catch (e) {}
      }
    }
    throw last || new Error("fetch failed");
  }
  function pwUrl(reg, spid, b) { return payBase(b) + "HistoryOfPayment?studentProgramId=" + encodeURIComponent(spid) + "&programId=0&sessionId=0&stdRollOrRegistrationNo=" + encodeURIComponent(reg); }
  function cwUrl(reg, spid, b) { return payBase(b) + "HistoyOfPaymentCourseWise?studentProgramId=" + encodeURIComponent(spid) + "&stdRollOrRegistrationNo=" + encodeURIComponent(reg); }

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
    while (cwTries < CW_TRIES && !cwSettled(c, cw)) {
      await backoff(cwTries - 1);
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

  /* Both pages of ONE server, with the same wait for Course Wise the single-server path uses:
     a redirect or a table-less page is not an answer, so it is asked again before being believed. */
  async function fetchTables(base, reg, spid) {
    const pP = fetchHtml(pwUrl(reg, spid, base)), pC = fetchHtml(cwUrl(reg, spid, base));
    let p;
    try { p = await pP; } catch (e) { pC.catch(function () {}); throw e; }
    const pwT = p.redirected ? null : parseFrag(sliceTable(p.html, "program"));
    const pw = pwT ? scrape(pwT, "program") : null;
    let c = null;
    try { c = await pC; } catch (e) { if (e && e.name === "AbortError") throw e; }
    let cw = (c && !c.redirected) ? scrape(parseFrag(sliceTable(c.html, "course")), "course") : null;
    let tries = 1;
    /* Asking again is for a Course Wise page that has not finished being built — a real answer
       is a moment away, and the ladder waits for it. It is not for a server that has stopped
       producing pages: when THIS server gave no Program Wise table either, the two blanks have
       one cause — the session, the permission, or a student it does not hold — and no amount of
       asking for the other page will change it.

       Walking the ladder anyway costs 0.8 + 1.6 + 3.2 + 6.4 + 12.8 seconds of waiting and five
       more requests, per student, at the exact moment the server is least able to serve them;
       then sweepUnanswered() takes every one of them round again. Measured on ten students with
       one side blind: 354 seconds and 36 requests each, against 0.2 seconds and 4.

       The single-server path has always done this — testOne() returns the moment Program Wise
       comes back without a table, and never opens the Course Wise loop. This is the two-server
       path catching up with it. */
    const serverIsAnswering = !!(pw && pw.ok);
    while (serverIsAnswering && tries < CW_TRIES && !(c && cwSettled(c, cw))) {
      await backoff(tries - 1);
      try { c = await fetchHtml(cwUrl(reg, spid, base)); }
      catch (e) { if (e && e.name === "AbortError") throw e; break; }
      cw = c.redirected ? null : scrape(parseFrag(sliceTable(c.html, "course")), "course");
      tries++;
    }
    /* { ok: false } is "nothing was read", which compareServers() reports as its own finding
       rather than as a difference — a page that never arrived proves nothing about the data. */
    return { pw: (pw && pw.ok) ? pw : { ok: false }, cw: (cw && cw.ok) ? cw : { ok: false }, tries: tries };
  }

  async function testOneServers(reg, spid) {
    /* allSettled, not Promise.all: the second server's failure must still be handled even when the
       first one throws first, or a run leaves unhandled rejections behind it. */
    const got = await Promise.allSettled([fetchTables(baseUrl, reg, spid), fetchTables(baseUrl2, reg, spid)]);
    const bad = got.filter(function (x) { return x.status === "rejected"; })[0];
    if (bad) throw bad.reason;
    const exp = got[0].value, act = got[1].value;
    /* Neither server knows this pair — that is a wrong reg/spid, not a difference between them. */
    if (!exp.pw.ok && !act.pw.ok) return { kind: "error", msg: t("e_pw_both"), notFound: true };
    return { kind: "done", srv: true, exp: exp, act: act,
      cwTries: Math.max(exp.tries, act.tries),
      result: U.compareServers(exp, act, { tolerance: tol }) };
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
  /* Two-server verdict, most serious first. A page that was never read outranks everything, since
     nothing was measured; then a row that did not survive the move, then a cell that changed,
     then a row that appeared out of nowhere. Same six buckets as the single-server run, so the
     tiles, the filter, the re-run button and the exports all work untouched — only the labels
     change (see the s_ entries in DICT). */
  function statusOfSrv(out) {
    const r = out.result, has = {};
    (r.errors || []).forEach(function (e) { has[e.kind] = 1; });
    if (has.srvside) return "nf";
    if (!r.errors.length) return "ok";
    if (has.srvlost) return "cw";
    if (has.srvcell || has.srvtext || has.srvcol) return "no";
    if (has.srvextra) return "zero";
    return "no";
  }
  function statusOf(out) {
    // no Program Wise rows means the program was not found for this reg/spid — its own bucket,
    // not a load error and not a reconciliation failure
    if (out.kind === "error") return out.notFound ? "nf" : "error";
    if (out.srv) return statusOfSrv(out);
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
    if (out.srv) return U.summaryServers(out.result);
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
    if (out.srv) {
      const rs = out.result;
      if (!rs.errors.length) return U.summaryServers(rs);
      const cs = U.classifyServers(rs), ps = [];
      if (cs) ps.push(cs.label + (cs.why ? " (" + cs.why + ")" : ""));
      rs.errors.forEach(function (e, i) { ps.push((i + 1) + ") " + U.shortError(e)); });
      (rs.notes || []).forEach(function (nt) { ps.push(nt.detail); });
      return ps.join("   ");
    }
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
    /* No status function returns "warn" any more, so the fallback this used to have could not
       be reached — and the phrase it reached for was never translated. */
    return parts.join("   ");
  }

  /* prior: the result being re-asked about, if this is a sweep round — its attempt count carries
     forward so the line can say how many times the server was actually asked, not how many times
     the last round asked. */
  async function processItem(stu, item, prior) {
    let spid = item.spid;
    if (!spid) {
      if (!item.program) return { st: "error", detail: t("e_need"), spid: "" };
      if (!stu._resolved) { try { stu._resolved = await resolvePrograms(stu.reg); } catch (e) { return { st: "error", detail: String(e.message || e), spid: "" }; } }
      const m = matchEntry(stu._resolved, item);
      if (!m) return { st: "nf", detail: t("d_noprog") + (stu._resolved.length ? " " + t("d_has") + " " + stu._resolved.map(function (x) { return x.program; }).join(", ") : ""), spid: "" };
      spid = m.spid;
    }
    /* Equal numbers are a hint, not a verdict — see the note on e_regspid. The student is checked
       like any other; the hint is added below only if UMS then has no such programme, which is
       where it explains something. */
    const regEqSpid = String(spid).trim() === String(stu.reg).trim();
    /* A load failure is the session or the network, not the data, so it retries itself — twice
       more, with a growing pause. There is no Load error tile to press ⟳ on any more (the slot is
       Zero Pay now), and a fault that clears on its own should never have needed a person.
       fetchHtml() already retries a 5xx/429 inside one attempt; this covers the whole student. */
    let out, attempts = 0;
    for (let a = 0; a < ITEM_TRIES; a++) {
      attempts = a + 1;
      try { out = srvMode ? await testOneServers(stu.reg, spid) : await testOne(stu.reg, spid); break; }
      catch (e) {
        out = { kind: "error", msg: String((e && e.message) || e) };
        if (e && e.name === "AbortError") break;      // Stop was pressed — do not keep trying
        if (a < ITEM_TRIES - 1) await backoff(a);
      }
    }
    const st = statusOf(out);
    const cat = (out.result && out.result.errors && out.result.errors.length)
      ? (out.srv ? U.classifyServers(out.result) : U.classify(out.result)) : null;
    /* Keep the raw cells of anything that still needs a person. Arguing about whether a receipt is
       really a mismatch takes the actual numbers off both pages, and pulling those out of UMS by
       hand — one student at a time, eleven columns each — is where the day goes. They are already
       parsed and in memory; holding them costs a couple of KB per flagged student and nothing at
       all for the clean ones, which are the overwhelming majority. */
    const raw = (notOk(st) && out.kind === "done")
      ? (out.srv
        ? U.rawTextServers(out.exp, out.act, { spid: spid, reg: stu.reg,
          expUrl: pwUrl(stu.reg, spid), actUrl: pwUrl(stu.reg, spid, baseUrl2) })
        : U.rawText(out.pw, out.cw, { spid: spid, reg: stu.reg })) : "";
    const res0 = { st: st, detail: shortLine(st, out), detailFull: itemDetail(st, out),
      why: cat ? cat.why : "", whySelf: !!(cat && cat.selfEvident), raw: raw,
      spid: spid, program: item.program || "" };
    /* Say it on the line. "লোড এরর" alone reads as a fact about the student; what happened is that
       the server was asked N times and never replied, and the difference decides whether anyone
       goes and looks at the data or at the network. */
    /* …and here, where it is the likeliest explanation for a programme UMS says it does not have.
       On a student who checks out fine it is said nowhere, because there is nothing to explain. */
    if (regEqSpid && out.notFound) {
      res0.detail += " · " + t("e_regspid");
      if (res0.detailFull) res0.detailFull += " · " + t("e_regspid");
    }
    res0.unanswered = unanswered(out);
    res0.tried = ((prior && prior.tried) || 0) + attempts;
    if (res0.unanswered) res0.detail += " · " + t("d_noanswer").replace("{n}", res0.tried);
    applyManual(res0, stu.reg);
    return res0;
  }

  /* Did the servers actually answer about this student?
     A table with rows is an answer. A table that says No Data is an answer — the server has spoken.
     A page that never arrived, was redirected away, or came back without its table is NOT: nothing
     was read, so nothing can be concluded, and the verdict on screen would be about the network
     while reading as a verdict about the money. Everything marked here goes back into the queue —
     see sweepUnanswered(). */
  function unanswered(out) {
    if (!out || out.kind === "error") return true;
    if (out.notFound) return true;    // Program Wise produced no table — could be the server, not the id
    if (out.srv) return (((out.result || {}).errors) || []).some(function (e) { return e.kind === "srvside"; });
    return !!(out.cwRedirect || out.cwNoTable);
  }
  function countUnanswered() {
    let k = 0;
    students.forEach(function (stu) {
      (stu.results || []).forEach(function (x) { if (x.res && x.res.unanswered) k++; });
    });
    return k;
  }

  /* Rounds of asking again, with a growing pause between them, for every student the servers never
     answered about. A run is not finished while any of them is outstanding — a slow server is
     allowed to delay the result, never to decide it.

     It ends when there is nothing left, when Stop is pressed, or when two whole rounds in a row
     change nothing — at that point the server is saying no rather than saying nothing, and the
     line says exactly that, with the number of attempts behind it, instead of pretending. */
  /* One case the rounds cannot help with, and it is the expensive one.

     If a large share of the sheet came back unanswered while the servers were answering
     promptly — no timeouts, no 5xx, pressure at zero — then nothing is struggling. The pages
     are arriving and the tables are not on them, which is a session that has expired, a
     permission, or an address: one cause, shared by every row it touches, and unchanged by
     asking again.

     Flakiness does not look like this. A server that is dropping requests refuses them —
     timeouts, 5xx, 429 — and every refusal is counted into pressure, so pressure at zero is
     what separates a server that cannot keep up from one that is answering and saying nothing.
     That, rather than the share, is what this rests on.

     A QUARTER, not all of them. "All" was the first version of this rule and it was too narrow
     to catch the run that prompted it: 798,950 students, 351,335 of them blank — 44%, so the
     guard held its peace and the sweep spent four and a half hours, 63% of the whole run,
     re-asking 351,335 students and rescuing none of them. Below a quarter the rounds still run:
     that is the per-student flakiness they exist for.

     Nothing is lost by declining. The answers that did arrive are kept and reported, the count
     is on the finished line, and a login fixed in a minute costs one more run rather than a
     morning of asking a healthy server for pages it has already refused. */
  const SWEEP_POINTLESS = 0.25;
  function mostlyUnanswered() {
    return T.total >= 20 && !pressure && countUnanswered() >= T.total * SWEEP_POINTLESS;
  }
  async function sweepUnanswered(t0) {
    if (mostlyUnanswered()) return;   // …the finished line says so, where it will still be read
    let barren = 0;
    for (let round = 1; round <= SWEEP_ROUNDS && run && !run.stop; round++) {
      const jobs = [];
      students.forEach(function (stu) {
        (stu.results || []).forEach(function (x) { if (x.res && x.res.unanswered) jobs.push({ stu: stu, slot: x }); });
      });
      if (!jobs.length) return;
      $("prog").textContent = "⏳ " + t("p_retry").replace("{n}", jobs.length).replace("{r}", round) +
        " · ⏱ " + mmss(Date.now() - t0);
      await sleep(Math.min(2000 * round, 15000));
      if (run.stop) return;
      let fixed = 0, next = 0, done = 0;
      const tick = function () {
        $("prog").textContent = "⏳ " + t("p_retry").replace("{n}", jobs.length).replace("{r}", round) +
          " · " + done + "/" + jobs.length + " · ⏱ " + mmss(Date.now() - t0);
      };
      async function worker() {
        while (!run.stop) {
          const i = next++; if (i >= jobs.length) return;
          const j = jobs[i];
          await breathe();
          if (run.stop) return;
          let res;
          // a re-ask that itself blows up must not lose the slot — keep what was there
          try { res = await processItem(j.stu, j.slot.item, j.slot.res); }
          catch (e) { res = j.slot.res; }
          if (run.stop) return;
          if (!res.unanswered) fixed++;
          j.slot.res = res;
          done++; tick();
        }
      }
      /* Half the usual parallelism: the server has already shown it cannot keep up, and asking
         harder is what put these here. */
      await Promise.all(Array.from({ length: Math.min(Math.max(1, Math.ceil(conc / 2)), jobs.length) },
        function () { return worker(); }));
      recountAll(); paintTiles(); rerenderList(); applyFilterAll();
      barren = fixed ? 0 : barren + 1;
      /* Give up only when the server is answering normally and STILL has nothing for these. While
         it is visibly struggling (pressure > 0), a round that fixed nothing says nothing about the
         data either — it says the server is busy, which is the one case the sweep exists for. */
      if (barren >= 3 && !pressure) return;
    }
  }

  /* Total Problem = everything that still needs a person. "ok" is clean; so is "zero" — a student
     who never paid has nothing to reconcile, and counting them as problems put hundreds of
     perfectly ordinary records on the work list. */
  /* "zero" is Zero Pay on a single-server run — nothing to reconcile, so not a problem. On a
     two-server run the same slot holds "Actual has a row Expected never had", which very much is
     one, so the exemption does not carry over. */
  const notOk = function (st) { return srvMode ? st !== "ok" : (st !== "ok" && st !== "zero"); };
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
  /* which counter a verdict belongs to — one definition, so the tally can be moved both ways */
  const tileKey = function (st) {
    return (st === "ok" || st === "no" || st === "cw" || st === "zero" || st === "nf") ? st : "err";
  };
  function bumpTile(st) { T[tileKey(st)]++; if (notOk(st)) T.stu++; }
  function dropTile(st) { T[tileKey(st)]--; if (notOk(st)) T.stu--; }
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
      });
    });
  }
  /* The tally already knows how many are in each bucket, so ask it. This used to call
     pickByStatus() once per ⟳ button — six walks of every student and every result, each BUILDING
     AN ARRAY of the matches only to read .length off it — and paintTiles() calls it on every
     repaint, about eight times a second. At 100,000 students that measured 30 ms a repaint: a
     quarter of the main thread spent counting things it had just finished counting, which is
     thread the run needs to dispatch its fetches. */
  const bucketCount = function (st) { return st === "prob" ? T.stu : (st === "error" ? T.err : T[st] || 0); };
  function paintRerun() {
    const busy = !!run;
    [].slice.call(document.querySelectorAll(".rr")).forEach(function (b) {
      const st = b.getAttribute("data-rr");
      const n = bucketCount(st);
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
        await breathe();
        if (run.stop) return;
        let res;
        // one bad item must not sink the whole re-run — record it and carry on
        try { res = await processItem(j.stu, j.slot.item, j.slot.res); }
        catch (e) { res = { st: "error", detail: String((e && e.message) || e), spid: j.slot.res.spid || "" }; }
        if (run.stop) return;
        /* Move the two counters this slot touches instead of re-counting the sheet. recountAll()
           walks every student, and running it every ten items cost about four seconds of pure
           counting on 50,000 — time the re-run needed for its own fetches, growing with the square
           of the sheet. The recount in the finally block below still has the last word. */
        dropTile(j.slot.res.st);
        j.slot.res = res;            // replace in place — order and student grouping stay put
        bumpTile(res.st);
        done++; tick();
        if (done % 10 === 0) paintTiles();   // tiles move while it runs
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

  /* How fast it is going — which is not how fast it has been on average since it started.
     Those two diverge on a run that lasts hours, and it is the first one an estimate needs: a
     run that opened fast and has since been throttled goes on quoting the fast number for the
     rest of the afternoon, and promises a finishing time it passed long ago. So the rate is
     read over the last minute of work rather than over the whole run. */
  const RATE_WINDOW = 60000;
  let rateMarks = [];

  /* ---------- the checkpoint ----------
     Written as the run goes, so that closing the page costs the students still in flight and
     nothing else. Batched, because writing a hundred thousand answers every few seconds would
     cost more than the work it protects: each write appends only what has finished since the
     last one, and the run is never re-read to make it.

     Nothing here may stop a run. A database that is full, blocked by another tab, or turned off
     entirely sets ckOff and the run carries on exactly as it did before — unprotected, but
     running, which is the way round that matters. */
  const CK_EVERY = 300;      // students between writes
  const CK_MS = 15000;       // …and never longer than this, so a slow run still checkpoints
  let ckKey = "", ckSeq = 0, ckBuf = [], ckLast = 0, ckOff = false;
  /* A database that is full, blocked by another tab, or switched off stops the checkpoint and
     not the run — that much has to stay true. But it was also silent, so a run could go for an
     hour with nothing behind it and the only way to find out was to lose it. */
  function ckDie() { ckOff = true; const e = $("ckDead"); if (e) e.style.display = ""; }
  function ckAlive() { ckOff = false; const e = $("ckDead"); if (e) e.style.display = "none"; }

  /* What this run is: the sheet, the servers, and the question being asked. Resuming into a
     different sheet — or into the other mode — would graft answers onto the wrong students, so
     the signature has to move when any of those move. FNV-1a over the pairs in order: a few
     milliseconds at 100,000 rows, and it changes if two rows merely swap places, which is right,
     because the students are addressed by their position in the list. */
  function ckSig() {
    let h = 2166136261 >>> 0;
    const add = function (s) {
      s = String(s == null ? "" : s);
      for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    };
    entries.forEach(function (e) {
      add(e.reg); add("\u0001"); add(e.spid); add("\u0001"); add(e.program); add("\u0002");
    });
    add(srvMode ? "srv" : "one"); add(baseUrl); add(srvMode ? baseUrl2 : ""); add(String(tol));
    return entries.length + "-" + h.toString(36);
  }
  /* Which file and which tab the rows came from travels with the checkpoint. Without it a resumed
     run says only "an unfinished run", and the thing setSource() exists to prevent — two tabs of
     one workbook, or last week's copy of the same file, being indistinguishable once the rows are
     in — comes straight back for exactly the run that has been going longest. */
  function ckMeta(done) {
    return { sig: ckKey, total: T.total, done: done, at: Date.now(), srv: srvMode,
      url: baseUrl, url2: srvMode ? baseUrl2 : "", tol: tol, lang: lang, src: srcBase };
  }
  /* Every key this run owns, and only this run's: the sheet, the meta line, and the chunks. */
  function ckWipe(sig) {
    return idb(function (st) {
      st.delete(IDBKeyRange.bound(sig + "|", sig + "|\uffff"));
      st.delete("last");
    }, "ck").catch(function () {});
  }
  /* Everything in the store that is not the run named here. Only one checkpoint is ever
     offered — the one "last" points at — so anything else is a run that was stopped and then
     not picked up, and it is not small: the whole imported sheet is kept beside the answers, so
     an abandoned 100,000-row run is tens of megabytes that nothing will ever read again. Left
     to accumulate they are a database that grows for as long as the tool is used, on exactly
     the machines that use it most. Swept when a run starts and when the page opens. */
  function ckSweep(keep) {
    return idb(function (st) { return st.getAllKeys(); }, "ck").then(function (keys) {
      const dead = (keys || []).filter(function (k) {
        k = String(k);
        return k !== "last" && (!keep || k.indexOf(keep + "|") !== 0);
      });
      if (!dead.length) return 0;
      return idb(function (st) { dead.forEach(function (k) { st.delete(k); }); }, "ck")
        .then(function () { return dead.length; });
    }).catch(function () { return 0; });
  }
  function ckStart() {
    ckKey = ckSig(); ckSeq = 0; ckBuf = []; ckLast = Date.now(); ckAlive();
    return ckSweep(ckKey).then(function () {
      return ckWipe(ckKey);
    }).then(function () {
      return idb(function (st) {
        /* the sheet travels with the checkpoint, so resuming does not ask for the file again */
        st.put(entries, ckKey + "|ent");
        st.put(ckMeta(0), ckKey + "|meta");
        st.put(ckKey, "last");
      }, "ck");
    }).catch(ckDie);
  }
  function ckFlush() {
    if (ckOff || !ckKey || !ckBuf.length) return Promise.resolve();
    const rows = ckBuf, seq = ckSeq++;
    ckBuf = []; ckLast = Date.now();
    const meta = ckMeta(T.done);
    return idb(function (st) {
      st.put(rows, ckKey + "|c" + seq);
      st.put(meta, ckKey + "|meta");
      st.put(ckKey, "last");
    }, "ck").catch(ckDie);
  }
  /* Only whole students are checkpointed. A student stopped between its two programmes would come
     back on resume looking answered with half its rows missing, and no tile would ever disagree. */
  function ckPush(i, stu) {
    if (ckOff || !ckKey) return;
    ckBuf.push({ i: i, r: stu.results.map(function (x) { return x.res; }) });
    if (ckBuf.length >= CK_EVERY || Date.now() - ckLast >= CK_MS) ckFlush();
  }
  /* Read one back. Returns null for anything incomplete or unreadable — a checkpoint that cannot
     be trusted whole is worth less than no checkpoint at all. */
  function ckRead(sig) {
    return idb(function (st) { return st.getAllKeys(IDBKeyRange.bound(sig + "|", sig + "|\uffff")); }, "ck")
      .then(function (keys) {
        if (!keys || !keys.length) return null;
        return idb(function (st) {
          const out = {};
          keys.forEach(function (k) { const r = st.get(k); r.onsuccess = function () { out[k] = r.result; }; });
          return { result: out };
        }, "ck").then(function (out) {
          const meta = out[sig + "|meta"], ent = out[sig + "|ent"];
          if (!meta || !ent || !ent.length) return null;
          const chunks = [];
          keys.forEach(function (k) {
            const m = String(k).match(/\|c(\d+)$/);
            if (m) chunks.push({ seq: +m[1], rows: out[k] || [] });
          });
          chunks.sort(function (a, b) { return a.seq - b.seq; });
          return { sig: sig, meta: meta, entries: ent, chunks: chunks,
            seq: chunks.length ? chunks[chunks.length - 1].seq + 1 : 0 };
        });
      }).catch(function () { return null; });
  }

  /* Show it, hide it, or say what it found. Kept apart from ckOffer() so that finishing a run
     can take the bar down without having to know anything about how it was put up. */
  let ckFound = null;
  function ckBar(found) {
    ckFound = found || null;
    const bar = $("ckBar"); if (!bar) return;
    if (!ckFound) { bar.style.display = "none"; return; }
    const m = ckFound.meta, n = ckFound.done;
    const num = function (v) { return lang === "bn" ? Number(v).toLocaleString("bn-BD") : Number(v).toLocaleString(); };
    $("ckTxt").innerHTML = "<b>" + num(n) + "</b> / " + num(m.total) + " " +
      t("ck_upto") + " · " + ago(m.at) + (m.srv ? " · " + t("srv_tag") : "");
    bar.style.display = "";
  }
  /* "3 minutes ago" beats a timestamp here: the question the bar answers is whether this is the
     run you were watching or one from last week. */
  function ago(ts) {
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 90) return t("ago_now");
    const mn = Math.round(s / 60);
    if (mn < 90) return t("ago_min").replace("{n}", mn);
    const hr = Math.round(mn / 60);
    if (hr < 36) return t("ago_hr").replace("{n}", hr);
    return t("ago_day").replace("{n}", Math.round(hr / 24));
  }
  /* Is there something to come back to? Only ever one — the last run to be interrupted. */
  async function ckOffer() {
    if (run) return;
    let sig = "";
    try { sig = await idb(function (st) { return st.get("last"); }, "ck"); } catch (e) { return; }
    /* Whatever else is in there is from a run nobody came back for. This is the only moment the
       tool is reliably idle, so it is where the clearing out happens. */
    ckSweep(sig);
    if (!sig) return;
    const got = await ckRead(sig);
    if (!got) { ckWipe(sig); return; }
    let done = 0;
    got.chunks.forEach(function (c) { (c.rows || []).forEach(function (r) { done += (r.r || []).length; }); });
    if (!done || done >= got.meta.total) { ckWipe(sig); return; }
    got.done = done;
    ckBar(got);
  }
  /* Put the saved half back on screen, then run only the other half. Everything is rebuilt from
     the sheet that travelled with the checkpoint — buildStudents() is deterministic, so student i
     here is the same student i that was saved, and the tiles are counted up from the answers
     rather than trusted from the meta line. */
  async function ckResume() {
    const got = ckFound; if (!got || run) return;
    ckBar(null);
    $("prog").textContent = t("ck_loading");
    /* the mode the run was asking in, or the answers would meet a different question */
    if (!!got.meta.srv !== srvMode) { srvMode = !!got.meta.srv; $("srvSw").checked = srvMode; applySrvMode(); }
    if (got.meta.url) { baseUrl = got.meta.url; $("base").value = baseUrl; }
    if (got.meta.url2) { baseUrl2 = got.meta.url2; $("base2").value = baseUrl2; }
    if (got.meta.tol != null) { tol = got.meta.tol; $("tol").value = tol; }

    entries = got.entries;
    /* both facts: where the rows came from, and that this run was picked up rather than begun.
       A checkpoint written before the source travelled with it has only the second. */
    srcBase = got.meta.src || "";
    importSrc = srcBase ? srcBase + "  ·  " + t("ck_src") : t("ck_src");
    students = buildStudents(entries);
    ["ok", "no", "cw", "zero", "nf", "err", "stu", "done"].forEach(function (k) { T[k] = 0; });
    T.total = entries.length;
    got.chunks.forEach(function (c) {
      (c.rows || []).forEach(function (row) {
        const stu = students[row.i]; if (!stu || stu._ck) return;
        const rs = row.r || [];
        /* a chunk that does not line up with the sheet is a checkpoint from another run wearing
           this one's signature — vanishingly unlikely, and silently wrong if it were let through */
        if (rs.length !== stu.items.length) return;
        stu.results = rs.map(function (res, k) { return { item: stu.items[k], res: res }; });
        stu._ck = 1;
        rs.forEach(function (res) { bumpTile(res.st); T.done++; });
      });
    });
    ckKey = got.sig; ckSeq = got.seq; ckBuf = []; ckLast = Date.now(); ckAlive();
    renderPreview(); updateCount();
    $("impNote").innerHTML = '<span class="isrc">' + esc(importSrc) + "</span>";
    rerenderList(); applyFilterAll(); paintTiles();
    await startRun(true);
  }

  /* Start sits an inch from the offer and used to eat it without a word: ckStart() wipes the
     saved run before the first fetch goes out. Whoever has just lost four hours to a closed
     laptop reaches for the button they know, so the button has to ask first. */
  /* Saving is switched on and nothing has been chosen to save into.

     Start is a click, so the picker can be opened right here — which is the useful thing to do,
     because the person meant to choose a folder and can still do it. Dismissing the picker is an
     answer too, and the run is then told plainly where the files will go, rather than reporting it
     hours later on the finished line beside work that cannot be repeated cheaply. Saying no stops
     the run before a single page is fetched. */
  async function readyToSave() {
    if (!saveOnFinish || dirHandle) return true;
    await pickDir();
    if (dirHandle) return true;
    try { return confirm(t("save_nodir_ask")); } catch (e) { return true; }
  }

  async function startPressed() {
    /* Both of these spend the click, so they come before anything that could let it lapse: the
       picker and the permission prompt are the two things here a browser will only open for a
       gesture. */
    if (!(await readyToSave())) { $("prog").textContent = t("save_nodir_stopped"); return; }
    await claimDir();
    if (ckFound && !run) {
      const same = entries.length && ckFound.sig === ckSig();
      const n = lang === "bn" ? Number(ckFound.done).toLocaleString("bn-BD")
        : Number(ckFound.done).toLocaleString();
      let ok = false;
      try { ok = confirm(t(same ? "ck_ask" : "ck_ask_other").replace("{n}", n)); } catch (e) { ok = true; }
      /* Escape closes that dialog as surely as Cancel does, and a Start that answers a press by
         doing nothing at all is indistinguishable from a Start that is broken. Say which. */
      if (!ok) { $("prog").textContent = t("ck_kept"); return; }
    }
    startRun();
  }

  async function startRun(resumed) {
    /* only ckResume() passes this, and only ever as true — anything else is a caller that did not
       mean to say it, which is how the Start button once started a run with no students in it */
    resumed = resumed === true;
    if (!entries.length) { $("prog").textContent = t("p_input"); return; }
    if (!resumed) students = buildStudents(entries);
    run = { stop: false, paused: false, ac: (typeof AbortController !== "undefined" ? new AbortController() : null) };
    if (!resumed) ["ok", "no", "cw", "zero", "nf", "err", "stu", "done"].forEach(function (k) { T[k] = 0; });
    /* One unit of work is one Reg + Student PID pair — the key duplicates are dropped on at import,
       and the basis every tile counts on. students[] groups by Reg alone (a Reg against two
       programs is ONE card carrying two rows), so its length is the card count, not the work
       count: a 10,515-pair sheet spread over 9,832 Regs read "Done · 9832/9832" while the tiles
       above it added up to 10,515. Count the pairs — entries.length is exactly Σ items.length. */
    T.total = entries.length;
    if (!resumed) { $("list").innerHTML = ""; listShown = 0; listTotal = 0; paintListNote(); }
    { const sn = $("srvNote"); if (sn) { sn.style.display = "none"; sn.textContent = ""; } }
    paintTiles(); $("fill").style.width = (T.total ? Math.round(T.done / T.total * 100) : 0) + "%";
    /* Whichever way a run starts, the offer is over: resuming takes it, and starting afresh
       wipes it in ckStart() below — leaving the bar up would keep offering a checkpoint that no
       longer exists, and it would still be there when this run ended. */
    ckBar(null);
    /* Nothing wrote the progress line until the first student came back, so on a big sheet — or a
       slow server — Start looked like it had done nothing at all for minutes. Which is also why
       the checkpoint is written after this line and not before it: opening a database and writing
       a hundred thousand rows of sheet to it is a round trip, and putting one in front of the
       first thing Start says would bring the silence straight back. */
    $("prog").textContent = "⏳ 0/" + T.total + " · " + t("p_running");
    if (!resumed) await ckStart();
    $("run").disabled = true; $("stop").disabled = false; $("pause").disabled = false; $("pause").textContent = t("pause");
    paintBusy();
    $("html").disabled = true; $("xlsx").disabled = true; $("raw").disabled = true;
    const t0 = Date.now();
    /* Where this run's own counting begins. A resumed run arrives with T.done already holding
       everything the last one finished — tens of thousands of answers — against a clock that
       starts now, and dividing one by the other reported a speed the run had never reached. */
    const done0 = T.done;
    rateMarks = [];
    let next = 0, running = 0;
    /* When the run has narrowed itself, say so. Without it the tool simply looks slow, and the
       one thing worth knowing — that it is the server, and that the run is adapting rather than
       failing — is the thing nobody can see. */
    /* The first seconds of a run are all latency and no answers, and a rate computed over them
       says 0/min and then 4,000/min. Wait for both a little time and a few answers before
       claiming a speed — an honest blank beats a number that swings by a factor of ten.

       Everything is measured from a mark taken inside this run, so the answers a resume brought
       with it are on both sides of the subtraction and cancel. */
    function rateNow() {
      const now = Date.now();
      rateMarks.push({ at: now, done: T.done });
      while (rateMarks.length > 2 && now - rateMarks[0].at > RATE_WINDOW) rateMarks.shift();
      const from = rateMarks[0];
      const secs = (now - from.at) / 1000, got = T.done - from.done;
      if (secs < 10 || got < 5) return 0;
      return Math.round(got / secs * 60);
    }
    function prog() {
      const pct = T.total ? Math.round(T.done / T.total * 100) : 0;
      const rate = rateNow(), left = T.total - T.done;
      $("prog").textContent = "⏳ " + T.done + "/" + T.total + " · " + pct + "% · ⏱ " + mmss(Date.now() - t0) +
        (rate ? " · ⚡ " + t("p_rate").replace("{n}", rate.toLocaleString("en-US")) : "") +
        (rate && left > 0 ? " · " + t("p_left").replace("{t}", span(left / rate * 60000)) : "") +
        " · " + t("p_running") + " " + running +
        (live < conc ? " · 🐢 " + t("p_eased").replace("{n}", live) : "");
    }
    // Batched UI: DOM cards + tiles + progress repaint at most ~every 120ms so the main thread stays free to dispatch fetches.
    renderBuf = document.createDocumentFragment();
    let lastUI = 0, uiTimer = null;
    /* Painting must never be able to end a run.
       ui() schedules this on a timer, and a timer is nobody's call stack: a throw in here does not
       land in startRun()'s try, it lands on window.onerror, and the run goes on waiting for a
       flush that will never come — buttons disabled, nothing said, forever. So the paint is
       wrapped where it happens rather than where it is asked for, which covers the direct call
       too. A repaint that fails is a repaint missed; the next one is 120 ms away. */
    function flushUI() {
      if (uiTimer) { clearTimeout(uiTimer); uiTimer = null; }
      lastUI = Date.now();
      try {
        if (renderBuf && renderBuf.childNodes.length) {
          // re-apply the filter on the way in, in case it changed while these were queued
          [].slice.call(renderBuf.childNodes).forEach(function (n) { if (n.nodeType === 1) applyFilterTo(n); });
          $("list").appendChild(renderBuf); renderBuf = document.createDocumentFragment();
        }
        $("fill").style.width = (T.total ? Math.round(T.done / T.total * 100) : 0) + "%";
        /* the cap note has to move while the run fills the list, not only when the list is rebuilt —
           otherwise a long run silently stops adding cards and never says why */
        paintTiles(); paintListNote(); prog();
        if (T.done > 0) { $("html").disabled = false; $("xlsx").disabled = false; $("raw").disabled = false; }
      } catch (e) { /* see above — the run outranks its own progress bar */ }
    }
    function ui() { const now = Date.now(); if (now - lastUI >= 120) flushUI(); else if (!uiTimer) uiTimer = setTimeout(flushUI, 120 - (now - lastUI)); }
    /* A worker numbered beyond the current limit parks here rather than exiting, so the run can
       widen again later without starting more workers than the user allowed — and it parks BEFORE
       taking a student, so a parked worker is never sitting on work nobody is doing. */
    async function slot(n) {
      /* …and only while there is still work for the room to be made for. The queue can empty while
         a worker is parked here, and pressure only moves when a fetch answers — so a run that had
         narrowed itself would leave its parked workers waiting on a gauge that nothing could
         change, and never finish at all. */
      while (!run.stop && n >= live && next < students.length) { pace(); await sleep(200); }
    }
    async function worker(n) {
      while (!run.stop) {
        while (run.paused && !run.stop) { $("prog").textContent = t("paused"); await sleep(200); }
        if (run.stop) return;
        await slot(n);
        if (run.stop) return;
        const i = next++; if (i >= students.length) return;
        const stu = students[i];
        if (stu._ck) continue;    // answered before the tab closed — see the checkpoint above
        await breathe();          // the server is refusing — slow down rather than pile on
        if (run.stop) return;
        running++;
        for (let j = 0; j < stu.items.length && !run.stop; j++) {
          const res = await processItem(stu, stu.items[j]);
          if (run.stop) break;   // aborted mid-flight — don't record partial/error result
          stu.results.push({ item: stu.items[j], res: res });
          bumpTile(res.st);              // Reg + PID, and T.stu with it
          T.done++;                       // per pair, like T.total — not once per card
          ui();                           // …so a Reg with many programs cannot stall the counter
        }
        renderStudent(stu);
        /* Stop breaks out of the loop above mid-student, and renderStudent() still draws what
           there is. Checkpointing that would freeze a half-answered student as answered. */
        if (!run.stop && stu.results.length === stu.items.length) { stu._ck = 1; ckPush(i, stu); }
        running--;
        pace();     // …and reconsider the width of the run, whether or not anyone is parked
        ui();
      }
    }
    /* Start at the ceiling: the user's number is what they asked for, and nothing has gone wrong
       yet. pace() is what takes it down, and only a refusing server makes it do so.

       Including the pressure gauge: it is what the LAST run met, and a run started by hand — maybe
       hours later — should not begin already throttled by it. If the server is still struggling
       the first refusals say so within seconds. */
    const workers = Math.min(Math.max(1, conc), students.length);
    live = workers; liveAt = Date.now(); pressure = 0;
    /* Everything from here to the end runs inside a try, and the buttons come back in the finally.

       Start disables itself and enables Stop as its first act, and the line that undoes that sat
       at the very end of the happy path. So anything that threw in between — a builder, a render,
       a browser refusing memory to a hundred-thousand-row page — left Start disabled, Stop
       enabled, `run` still set and not one word on screen: a tool that had stopped and looked
       exactly like a tool still working, until the tab was reloaded and the hours went with it.

       The checkpoint is flushed rather than wiped: whatever the run had answered is still worth
       having, and the resume offer is the whole point of keeping it. */
    try {
    await Promise.all(Array.from({ length: workers }, function (_, n) { return worker(n); }));
    flushUI(); renderBuf = null;
    /* A run is three things, and the clock only ever named the sum. The rate on screen is the
       first one — it stops moving when the workers do — but the ⏱ keeps counting through the
       other two, so a run reporting 8,000/min could take twenty minutes for a hundred thousand
       rather than twelve, with the missing eight minutes attributable to nothing on screen. */
    const msRun = Date.now() - t0;
    /* Not done yet. Everything the servers never actually answered about goes round again before
       the run calls itself finished — nothing is left standing on a non-answer. */
    await sweepUnanswered(t0);
    const msSweep = Date.now() - t0 - msRun;
    const left = countUnanswered();
    /* Stopped is the case the checkpoint exists for, so it stays and the bar offers it back.
       Finished, it is only clutter — and a stale offer to resume a run that has already been
       saved and exported is worse than clutter. */
    const stopped = !!(run && run.stop);
    await ckFlush();
    if (!stopped) { await ckWipe(ckKey); ckKey = ""; ckBar(null); }
    /* Written before the buttons are re-enabled, so "finished" and "saved" are one moment and
       nobody closes the tab in between. */
    let saved = "";
    const beforeSave = Date.now();
    if (saveOnFinish) {
      $("prog").textContent = "💾 " + t("p_saving");
      try { saved = await saveRun(); } catch (e) { saved = ""; }
    }
    const msSave = Date.now() - beforeSave;
    /* Said again when it is over, because this is the number someone quotes when they say the
       tool was faster last week — and without it the comparison is two half-remembered
       stopwatch readings over sheets of different sizes. */
    const took = Date.now() - t0;
    /* what THIS run did, in the time this run took — a resumed one inherits the count but not
       the hours that produced it */
    const mine = T.done - done0;
    const rate = took > 1000 && mine > 0 ? Math.round(mine / (took / 1000) * 60) : 0;
    /* The rate above is over the whole run including the two tails, so it is smaller than the
       one that was on screen while the workers were going. That is not a contradiction, and the
       breakdown is what makes it read as one rather than as a discrepancy. Below ten seconds a
       tail explains nothing, so it is not mentioned. */
    const tails = (msSweep >= 10000 || msSave >= 10000)
      ? " · " + t("p_phases").replace("{a}", span(msRun))
        .replace("{b}", span(msSweep)).replace("{c}", span(msSave)) : "";
    /* 798950/798950 says one number twice; when a run is stopped the two differ and both are
       worth seeing. Grouped, because six digits unbroken is not a number anyone reads. */
    const n3 = function (v) { return Number(v).toLocaleString("en-US"); };
    const count = T.done === T.total ? n3(T.total) : n3(T.done) + "/" + n3(T.total);
    /* The destination, not the timestamp. Which folder it went to is the fact worth reading —
       the chosen one or Downloads, which is what the fallback looks like from outside — and the
       timestamped subfolder underneath is both the longest part of the path and the least
       surprising. The whole thing is a hover away; see the title below. */
    const where = saved ? String(saved).split(" / ")[0] : "";
    $("prog").textContent = "✅ " + t("p_done") + " · " + count + " · ⏱ " + span(took) + tails +
      (rate ? " · ⚡ " + t("p_rate").replace("{n}", rate.toLocaleString("en-US")) : "") +
      (left ? " · ⚠ " + t("p_unanswered").replace("{n}", n3(left)) : "") +
      (saved ? " · 💾 " + where : (saveOnFinish ? " · ⚠ " + t("save_failed") : ""));
    /* what would not fit: the full path, and the phases when they were too short to be named */
    $("prog").title = (saved ? saved + "\n" : "") +
      t("p_phases").replace("{a}", span(msRun)).replace("{b}", span(msSweep)).replace("{c}", span(msSave));
    /* …and when the rounds were declined, why — under the line rather than in it, because it
       is the one thing here that asks the reader to go and do something. */
    const sn = $("srvNote");
    if (sn) {
      const dead = left > 0 && mostlyUnanswered();
      sn.style.display = dead ? "" : "none";
      sn.textContent = dead ? t("p_none_answered").replace("{n}", n3(left))
        .replace("{p}", Math.round(left / Math.max(1, T.total) * 100)) : "";
    }
    run = null;
    if (stopped) ckOffer();       // …and here is where you left off, should you want it back
    } catch (e) {
      /* Not a verdict about anybody's data — a fault in the tool, said as one. What was answered
         is kept, and the offer to carry on is put back up beside it. */
      try { await ckFlush(); } catch (e2) {}
      $("prog").textContent = "⚠ " + t("run_broke") + " · " + ((e && e.message) || e);
      run = null;
      ckOffer();
    } finally {
      /* Whatever happened, the page comes back: Start pressable, Stop and Pause not, and the
         re-run arrows repainted — which has to be after `run` is cleared, because flushUI() paints
         them while a run is still going and would leave them all disabled. */
      run = null;
      $("run").disabled = !entries.length; $("stop").disabled = true; $("pause").disabled = true;
      paintBusy();
      paintRerun();
    }
  }

  // ---------- render ----------
  /* One card per student is fine for a few thousand and ruinous for a hundred thousand: the
     browser relayouts the whole document on every append, and appending is what a run does all
     day. The list is for looking at; the HTML and Excel reports are the deliverable and still
     carry every row, so the list stops here and says so. */
  const LIST_MAX = 1000;
  let listShown = 0, listTotal = 0;
  function paintListNote() {
    const el = $("listNote"); if (!el) return;
    const capped = listTotal > listShown;
    el.style.display = capped ? "" : "none";
    if (capped) el.textContent = t("list_capped").replace("{a}", listShown.toLocaleString())
      .replace("{b}", listTotal.toLocaleString());
  }
  const PILLC = { ok: "ok", no: "no", cw: "mut", zero: "mut", nf: "mut", error: "no" };
  /* Quotes too: this output goes into attributes (data-reg, data-copy, and a sheet name in an
     <option value>), and a Reg or a tab called \u0022x\u0022 would otherwise close the attribute early
     and take the rest of the tag with it. */
  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function rerenderList() {
    const l = $("list"); if (!l) return;
    l.innerHTML = ""; listShown = 0; listTotal = 0;
    /* Straight into the list. During a run renderStudent() appends to the pending fragment, and
       rendering into that would leave the list empty until the next flush — and would then add
       these cards a second time. Whatever was pending is rebuilt here anyway. */
    const buf = renderBuf;
    renderBuf = null;
    students.forEach(function (s) { if (s.results && s.results.length) renderStudent(s); });
    if (buf) renderBuf = document.createDocumentFragment();
    paintListNote();
  }
  function renderStudent(stu) {
    /* Decide from the answers, before composing anything. The filter's verdict on a card is
       already settled by the statuses it holds, and building a hundred thousand cards' worth of
       HTML only to throw it away is what made re-rendering on a filter change unaffordable — which
       is why it did not happen during a run, which is why the list disagreed with the tiles. */
    const shows = (stu.results || []).some(function (x) { return matchFilter(x.res.st); });
    if (!shows) return;
    listTotal++;                 // matching students, so the note counts what the filter would show
    if (listShown >= LIST_MAX) return;
    listShown++;

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
        /* Each address gets the ⧉ the Reg and the SPID already have: opening it is one thing,
           pasting it into a message or another browser profile is another, and until now the only
           way to get the text was to open the page and copy the address bar. */
        const eUrl = pwUrl(stu.reg, x.res.spid);
        pn += ' <span class="mut">—</span> <a href="' + eUrl + '" target="_blank" style="color:#8fb4ff" title="' + (srvMode ? "Expected" : "Open Payment History") + '">↗' + (srvMode ? " E" : "") + '</a>';
        pn += ' <span class="cpy" data-copy="' + esc(eUrl) + '" title="' + (srvMode ? "Copy the Expected link" : "Copy the link") + '">⧉</span>';
        // both servers, one click each — the whole point of the mode is reading them side by side
        if (srvMode) {
          const aUrl = pwUrl(stu.reg, x.res.spid, baseUrl2);
          pn += ' <a href="' + aUrl + '" target="_blank" style="color:#ffb454" title="Actual">↗ A</a>';
          pn += ' <span class="cpy" data-copy="' + esc(aUrl) + '" title="Copy the Actual link">⧉</span>';
        }
      }
      /* the headline names the fault; this says what it actually means, which until now was
         written but never shown anywhere */
      const why = (x.res.why && !x.res.whySelf) ? '<div class="pwhy">' + esc(x.res.why) + "</div>" : "";
      h += '<div class="prow" data-st="' + x.res.st + '"><span class="pill ' + pcls + '">' + plbl + '</span>' +
        '<div class="pinfo"><div class="pn">' + pn + '</div>' +
        '<div class="' + dcls + '">' + esc(x.res.detail) + "</div>" + why + "</div></div>";
    });
    div.innerHTML = h;
    /* the card is shown; this hides the rows inside it that the filter does not want */
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
    /* Hiding what is on screen cannot show what was never drawn, and the cards past the cap are
       exactly the ones a filter is chosen to find. This used to be skipped during a run — and a run
       is when people filter, because a run at this size takes hours. */
    rerenderList();
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
    if (spid >= 0) { mode = "spid"; val = spid; }
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
    /* A row whose two values are equal cannot tell the two readings apart — swapping them gives
       the identical pair — yet has(a,b) and has(b,a) are then the same call, so it would cast a
       free vote for "as written" while carrying no information. Out of three votes that is enough
       to hold a genuinely swapped sheet the wrong way round, so such rows are not sampled. */
    const sample = rows.filter(function (r) {
      const a = String(r[d.reg] || "").trim(), b = String(r[d.val] || "").trim();
      return /^\d+$/.test(a) && /^\d+$/.test(b) && a !== b;
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
  /* The box is about five rows tall and the rest scrolls, so drawing all of them was only ever
     paid for, never seen. At 100,000 rows that is 100,000 <tr> built, painted and laid out — and
     renderPreview() re-runs on every keystroke in the search box, so it is paid again per letter.
     Search still looks at every row; only the drawing stops at PV_MAX. */
  var PV_MAX = 500;
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
  /* Every tab, in the order Excel shows them along the bottom. workbook.xml carries the names a
     person sees, but the order of its <sheet> elements is NOT the order of the sheetN.xml files —
     the link between them is the relationship id, so it is followed through the rels rather than
     read off the position. Picking by filename is how "the first tab" came to mean sheet1.xml,
     which is frequently the second or third tab and sometimes a Summary nobody meant to import.
     Best effort: an unreadable workbook part costs the names, never the import. */
  function sheetsOf(files, dec) {
    const out = [];
    try {
      const wbx = files["xl/workbook.xml"];
      if (!wbx) return out;
      const rels = {}, rlx = files["xl/_rels/workbook.xml.rels"];
      if (rlx) {
        const rd = new DOMParser().parseFromString(dec.decode(rlx), "application/xml");
        [].slice.call(rd.getElementsByTagName("Relationship")).forEach(function (n) {
          rels[n.getAttribute("Id")] = String(n.getAttribute("Target") || "").replace(/^\/?(xl\/)?/, "");
        });
      }
      const wd = new DOMParser().parseFromString(dec.decode(wbx), "application/xml");
      [].slice.call(wd.getElementsByTagName("sheet")).forEach(function (nd) {
        const rid = nd.getAttributeNS(RELS_NS, "id") || nd.getAttribute("r:id");
        const tgt = (rid && rels[rid]) ? "xl/" + rels[rid] : "";
        /* only tabs whose worksheet actually came out of the zip — a chart sheet has a <sheet>
           entry and no rows, and offering it would be offering an empty import */
        if (tgt && files[tgt]) out.push({ name: nd.getAttribute("name") || tgt, target: tgt });
      });
    } catch (e) {}
    return out;
  }
  /* Where the rows came from. Two tabs of one workbook can look identical in the preview, and so
     can last week's file — once the rows are in, nothing on screen said which file or which tab
     produced them, so a run against the wrong one was invisible. The note now leads with it. */
  /* Two things, deliberately: where the rows came from, and the line on screen about them. They
     were one string, and ckMeta() stored it — so a resumed run saved "…xlsx · an unfinished run"
     as its source, and resuming THAT wrote "…xlsx · an unfinished run · an unfinished run", once
     more for every time the run was picked up. srcBase is what travels; importSrc is what reads. */
  let importSrc = "", srcBase = "";
  function setSource(name, sheetName) {
    const bits = [];
    if (name) bits.push(name);
    if (sheetName) bits.push(t("src_sheet") + ": " + sheetName);
    importSrc = srcBase = bits.join("  ·  ");
  }
  function shared(xml) { const out = []; if (!xml) return out; const d = new DOMParser().parseFromString(xml, "application/xml"); const si = d.getElementsByTagName("si"); for (let i = 0; i < si.length; i++) { const ts = si[i].getElementsByTagName("t"); let s = ""; for (let j = 0; j < ts.length; j++) s += ts[j].textContent; out.push(s); } return out; }
  function sheet(xml, sh) { const d = new DOMParser().parseFromString(xml, "application/xml"); const re = d.getElementsByTagName("row"); const rows = []; for (let i = 0; i < re.length; i++) { const cs = re[i].getElementsByTagName("c"); const arr = []; for (let j = 0; j < cs.length; j++) { const c = cs[j]; let idx = c.getAttribute("r") ? colIdx(c.getAttribute("r")) : j; if (idx < 0) idx = j; const t = c.getAttribute("t"); let v = ""; if (t === "s") { const vv = c.getElementsByTagName("v")[0]; if (vv) v = sh[parseInt(vv.textContent, 10)] || ""; } else if (t === "inlineStr") { const is = c.getElementsByTagName("t")[0]; if (is) v = is.textContent; } else { const vv = c.getElementsByTagName("v")[0]; if (vv) v = vv.textContent; } arr[idx] = v; } for (let k = 0; k < arr.length; k++) if (arr[k] === undefined) arr[k] = ""; rows.push(arr); } return rows.filter(function (r) { return r.some(function (c) { return String(c).trim() !== ""; }); }); }
  /** want: the target of the tab to read; omitted means the workbook's FIRST tab. */
  async function readXlsx(buf, want) {
    const f = await unzip(new Uint8Array(buf));
    const dec = new TextDecoder("utf-8");
    const sh = shared(f["xl/sharedStrings.xml"] ? dec.decode(f["xl/sharedStrings.xml"]) : "");
    const tabs = sheetsOf(f, dec);
    /* The workbook's order first, so "the first tab" means what it means in Excel. The filename
       guess is only a last resort, for a workbook whose own index will not parse. */
    let key = (want && f[want]) ? want : ((tabs[0] && tabs[0].target) || "");
    if (!key) {
      key = Object.keys(f).find(function (x) { return /^xl\/worksheets\/sheet1\.xml$/i.test(x); }) ||
        Object.keys(f).find(function (x) { return /^xl\/worksheets\/.*\.xml$/i.test(x); });
    }
    if (!key) throw new Error("worksheet নেই");
    const hit = tabs.filter(function (x) { return x.target === key; })[0];
    return { rows: sheet(dec.decode(f[key]), sh), sheet: hit ? hit.name : "", sheets: tabs, target: key };
  }
  /* The workbook a tab can be picked from, and what it holds. The File itself is kept rather
     than the unzipped parts: switching tab costs one more unzip, against holding every worksheet
     inflated for as long as the page is open — on a workbook with a 100,000-row tab that is
     hundreds of megabytes sitting there for tabs nobody asked for. */
  let xlsxFile = null, xlsxTabs = [], xlsxTarget = "";
  function paintSheetPicker() {
    const row = $("sheetRow"), sel = $("sheetSel");
    if (!row || !sel) return;
    /* One tab is not a choice. A picker with a single entry only asks a question that has no other
       answer, so it stays out of the way until a workbook actually has tabs. */
    if (xlsxTabs.length < 2) { row.style.display = "none"; sel.innerHTML = ""; return; }
    row.style.display = "";
    sel.innerHTML = xlsxTabs.map(function (x) {
      return '<option value="' + esc(x.target) + '">' + esc(x.name) + "</option>";
    }).join("");
    sel.value = xlsxTarget;
  }
  function clearSheetPicker() { xlsxFile = null; xlsxTabs = []; xlsxTarget = ""; paintSheetPicker(); }

  /** want: the tab to read; omitted means the workbook's first. */
  function loadXlsx(file, want) {
    xlsxFile = file;
    const r = new FileReader();
    r.onload = function () {
      $("impNote").textContent = t("imp_excel");
      readXlsx(r.result, want).then(function (x) {
        xlsxTabs = x.sheets || []; xlsxTarget = x.target || "";
        paintSheetPicker();
        setSource("📄 " + file.name, x.sheet);
        return applyImported(x.rows).then(function () {
          /* An .xlsx whose own index will not parse still imports — readXlsx falls back to the
             first worksheet file it can find — but then there is no tab list, so no picker, and
             nothing on screen to say why. Silence here reads as "the feature does not work". */
          if (!xlsxTabs.length) {
            $("impNote").innerHTML += '<br><span class="mut">' + esc(t("sheet_unknown")) + "</span>";
          }
        });
      }).catch(function (e) {
        // name the file that failed — "Excel পড়া গেল না" alone left you guessing which one
        clearSheetPicker();
        setSource("📄 " + file.name, "");
        $("impNote").textContent = importSrc + " — " + t("imp_excel_fail") + " (" + (e.message || e) + ")";
      });
    };
    r.readAsArrayBuffer(file);
  }
  function onImport(file) {
    const r = new FileReader();
    r.onload = function () {
      const u8 = new Uint8Array(r.result);
      const zip = u8.length > 3 && u8[0] === 0x50 && u8[1] === 0x4B && (u8[2] === 0x03 || u8[2] === 0x05 || u8[2] === 0x07);
      if (zip) { loadXlsx(file); return; }
      // a .csv has one sheet by definition — leave no picker behind from a previous workbook
      clearSheetPicker();
      setSource("📄 " + file.name, "");
      applyImported(parseCSV(new TextDecoder("utf-8").decode(u8)));
    };
    r.readAsArrayBuffer(file);
  }

  // ---------- CSV / xlsx export ----------
  const STLBL_SRV = { ok: "Identical", no: "Data differs", error: "Error",
    cw: "Missing on Actual", zero: "Extra on Actual", nf: "Page not read" };
  const STLBL = { ok: "Matched", no: "Mismatch", error: "Error", cw: "CW Empty", zero: "Zero Pay", nf: "Program Not Found" };
  /* Green means nothing to do, red means money, amber means look at it. Which bucket is which
     depends on the mode — the same rule the tiles follow, so a row in the Excel file is the colour
     its tile was on screen. */
  function statusColor(st) {
    if (srvMode) {
      /* cw = Missing on Actual (money that did not survive the move) · zero = Extra on Actual */
      if (st === "ok") return "g";
      if (st === "no" || st === "cw" || st === "error") return "r";
      return "y";
    }
    return (st === "ok" || st === "zero") ? "g" : ((st === "no" || st === "error") ? "r" : "y");
  }
  /* all: ignore the on-screen filter. The buttons honour it — that is the point of exporting
     "only mismatches" — but an automatic archive that quietly held whatever chip happened to be
     selected would be worse than no archive at all. */
  function flatRows(all) {
    const out = [];
    students.forEach(function (stu) {
      stu.results.forEach(function (x) {
        if (!all && !matchFilter(x.res.st)) return;   // export honours the selected filter
        const spid = x.res.spid || "";
        out.push({
          status: (x.res.manual ? "Matched (manual)" : ((srvMode ? STLBL_SRV : STLBL)[x.res.st] || x.res.st)),
          reg: stu.reg,
          spid: spid,
          program: x.res.program || x.item.program || "",
          link: spid ? pwUrl(stu.reg, spid) : "",
          link2: (srvMode && spid) ? pwUrl(stu.reg, spid, baseUrl2) : "",
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
  /* What the file is about, in its name. Fixed English words rather than the interface's labels:
     a filename that changes with the language is one nobody can search for later, and Bengali in a
     filename travels badly between machines. The two modes name the same chips differently on
     screen, so they name them differently here too. */
  const FILE_TAG = { all: "all", ok: "matched", no: "mismatch", cw: "cw-empty",
    zero: "zero-pay", nf: "no-program", prob: "problems" };
  const FILE_TAG_SRV = { all: "all", ok: "identical", no: "different", cw: "missing-on-actual",
    zero: "extra-on-actual", nf: "not-read", prob: "problems" };
  function fileTag(n) {
    const m = srvMode ? FILE_TAG_SRV : FILE_TAG;
    return (m[filter] || filter) + "-" + n;
  }
  function dl(blob, ext, tag) {
    const u = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = u;
    a.download = "ums-verify-" + (tag ? tag + "-" : "") + stamp() + "." + ext;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(u); }, 1000);
  }
  /* Say it where the run says everything else, and put back what was there.
     A report too big to build is the one failure a person can do something about — choose a
     filter, or run the sheet in parts — and it is no use to them in the console. */
  let progWas = null, progTimer = null;
  function exportFailed(e) {
    const el = $("prog"); if (!el) return;
    if (progWas === null) progWas = { text: el.textContent, cls: el.className };
    el.textContent = "⚠ " + ((e && e.message) || t("dl_failed"));
    el.className = "badge";
    if (progTimer) clearTimeout(progTimer);
    progTimer = setTimeout(function () {
      if (progWas) { el.textContent = progWas.text; el.className = progWas.cls; progWas = null; }
      progTimer = null;
    }, 12000);
  }

  function exportHtml() {
    const rows = flatRows(); if (!rows.length) return;
    try { dl(new Blob([buildHtml(rows)], { type: "text/html;charset=utf-8;" }), "html", fileTag(rows.length)); }
    catch (e) { exportFailed(e); }
  }
  function buildHtml(rows) {
    const LBL = srvMode ? STLBL_SRV : STLBL;
    const cnt = {}; rows.forEach(function (r) { cnt[r.result] = (cnt[r.result] || 0) + 1; });
    const regSet = {}; rows.forEach(function (r) { regSet[r.reg] = 1; }); const nStu = Object.keys(regSet).length;
    const chip = function (k, lbl) { return cnt[k] ? '<span class="chip ' + (LBL[k] ? k : "") + '"><b>' + cnt[k] + '</b> ' + (lbl || LBL[k] || k) + '</span>' : ''; };
    /* The link is the same sentence on every row with two numbers changed, and both numbers are
       already in their own cells beside it — 26 MB of the 70 at 100,000 students, spent writing
       them out again. The anchors are built when the page opens, from the cells that are there:
       still real links, still middle-clickable, for the price of one loop.

       The colour was carried three times too — class="r-x" on the row, class="st-x" on the first
       cell, and the status attribute, which the filter needs anyway. CSS reads that one for all
       three now, and it is called d= because it is written once per row and there are a hundred
       thousand of them. */
    /* No classes on the cells: which column a cell is in is what those classes were saying, and
       the stylesheet can see that for itself. The status attribute stays — the filter reads it —
       under a shorter name, because it is written once per row and there are a hundred thousand
       of them. Together, 4 MB of the 30 at that size. */
    /* k marks a link cell, n one with no Student PID to build a link from. Two letters, because
       they are written once per row and there have been eight hundred thousand of them. */
    const LK = srvMode ? '<td class="k"></td><td class="k"></td>' : '<td class="k"></td>';
    const NOLK = srvMode ? '<td class="k n"></td><td class="k n"></td>' : '<td class="k n"></td>';
    let body = "";
    rows.forEach(function (r) {
      body += '<tr d="' + r.result + '">' +
        "<td>" + xesc(LBL[r.result] || r.result) + "</td>" +
        "<td>" + xesc(r.reg) + "</td><td>" + xesc(r.spid) + "</td>" + (r.spid ? LK : NOLK) +
        "<td>" + xesc(r.remarks || "") + "</td>" +
        "<td>" + xesc(r.details || "") + "</td></tr>";
    });
    const html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>UMS Reconciler — Report</title><style>' +
      'body{margin:0;background:#0d0f1a;color:#eef1fb;padding:24px;' +
      /* the same stack the app itself uses — this file is mostly Bengali and is the one that
         gets mailed to people whose machines are not this one */
      'font:14px/1.5 system-ui,"Segoe UI",Roboto,"Noto Sans Bengali",sans-serif}' +
      'h1{font-size:20px;margin:0 0 4px}.sub{color:#8b91b4;margin:0 0 16px;font-size:13px}' +
      '.chips{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 16px}' +
      '.chip{background:#161a2b;border:1px solid #2a3050;border-radius:20px;padding:5px 12px;font-size:13px}' +
      '.chip.ok{border-color:#37d18b}.chip.no,.chip.error{border-color:#ff6b7d}.chip.warn,.chip.nf{border-color:#ffb454}.chip.cw,.chip.zero{border-color:#8b91b4}' +
      /* …and the same two swap meaning in two-server mode, so they swap colour with them */
      (srvMode ? '.chip.cw{border-color:#ff6b7d}.chip.zero{border-color:#ffb454}' : "") +
      '.bar{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 12px}' +
      '.f{cursor:pointer;background:#161a2b;border:1px solid #2a3050;color:#eef1fb;border-radius:8px;padding:6px 12px;font-size:13px}' +
      '.f.active{background:#5b4ff0;border-color:#5b4ff0}' +
      'table{border-collapse:collapse;width:100%;font-size:13px}' +
      'th,td{border:1px solid #2a3050;padding:7px 10px;text-align:left;vertical-align:top;color:#c3c8e6}' +
      'th{background:#161a2b;color:#8b91b4;position:sticky;top:0}' +
      /* the colour comes off d=, the attribute the filter needs on every row anyway — carrying it
         a second and third time as classes cost 8 MB at 100,000 students and said nothing new */
      'td:first-child{font-weight:700;white-space:nowrap}' +
      'tr[d=ok] td:first-child{color:#37d18b;box-shadow:inset 3px 0 #37d18b}' +
      'tr[d=zero] td:first-child,tr[d=nf] td:first-child{color:#ffb454;box-shadow:inset 3px 0 #ffb454}' +
      'tr[d=no] td:first-child,tr[d=error] td:first-child,tr[d=cw] td:first-child{color:#ff6b7d;box-shadow:inset 3px 0 #ff6b7d}' +
      (srvMode
        ? 'tr[d=cw] td:first-child{color:#ff6b7d;box-shadow:inset 3px 0 #ff6b7d}' +
          'tr[d=zero] td:first-child{color:#ffb454;box-shadow:inset 3px 0 #ffb454}'
        : 'tr[d=cw] td:first-child{color:#8b91b4;box-shadow:inset 3px 0 #8b91b4}' +
          'tr[d=zero] td:first-child{color:#8b91b4;box-shadow:inset 3px 0 #8b91b4}') +
      /* the last column is the quiet one and the link columns are the fourth and fifth — the
         cells no longer carry a class to say what their position already says */
      '#tb td:last-child{font-size:12px;color:#8b91b4}' +
      '#tb td:nth-child(4) a,#tb td:nth-child(5) a{color:#8fb4ff;text-decoration:none}' +
      '#tb td:nth-child(4) a:hover,#tb td:nth-child(5) a:hover{text-decoration:underline}' +
      /* An empty link cell says "Open ↗" without carrying the words: written by the
         stylesheet, it costs nothing per row, and the moment a real anchor goes in the cell
         stops being empty and the rule stops applying. */
      '#tb td.k:empty::after{content:"Open ↗";color:#8fb4ff;cursor:pointer}' +
      '#tb td.k:empty:hover::after{text-decoration:underline}' +
      '#tb td.k.n:empty::after{content:"—";color:#8b91b4;cursor:default;text-decoration:none}' +
      '.hide{display:none}' +
      '@media print{.bar{display:none}body{background:#fff;color:#000}th{background:#eee}}' +
      '</style></head><body>' +
      '<h1>UMS Reconciler — Report</h1>' +
      '<p class="sub">' + xesc(baseUrl) + ' · ' + nStu + ' students · ' + rows.length + ' rows · ' + xesc(new Date().toLocaleString()) + '</p>' +
      '<div class="chips">' + chip("ok") + chip("no") + chip("error") + chip("cw") + chip("zero") + chip("nf") + '</div>' +
      '<div class="bar">' +
      '<button class="f active" data-f="all">All</button>' +
      '<button class="f" data-f="no">' + xesc(LBL.no) + '</button>' +
      '<button class="f" data-f="cw">' + xesc(LBL.cw) + '</button>' +
      '<button class="f" data-f="zero">' + xesc(LBL.zero) + '</button>' +
      '<button class="f" data-f="ok">' + xesc(LBL.ok) + '</button>' +
      '<button class="f" data-f="nf">' + xesc(LBL.nf) + '</button></div>' +
      '<table><thead><tr><th>Status</th><th>Student Reg</th><th>Program Id</th>' +
      (srvMode ? '<th>Expected Link</th><th>Actual Link</th>' : '<th>Payment History Link</th>') +
      '<th>Remarks</th><th>Details</th></tr></thead>' +
      '<tbody id="tb">' + body + '</tbody></table>' +
      /* The two ids are in cells 2 and 3 and the rest of the address is the same on every row,
         so it is written once here and the anchor is made from it — but only for the row the
         pointer is actually over.

         Building all of them up front is what this used to do, and at the sizes the tool now
         produces it is what stopped the page working: two innerHTML assignments a row, 1.6
         million anchors on an 800,000-row report, on a page already 660 MB. Measured at 400,000
         rows: 6.8 s of parsing HTML into anchors — and then the browser holds every one of
         them. The report was that the links never appeared at all.

         A row is filled when the pointer arrives on it, which is before any click, any
         middle-click and any right-click — so Open in new tab and Copy link address all still
         work, on the row you are pointing at. Nothing is built for the rows nobody visits.
         Touch has no hover, so a click on an unfilled cell opens it directly. */
      '<script>(function(){var E=' + JSON.stringify(payBase()) + ',A=' + JSON.stringify(srvMode ? payBase(baseUrl2) : "") + ';' +
      'function u(b,reg,spid){return b+"HistoryOfPayment?studentProgramId="+encodeURIComponent(spid)+' +
      '"&programId=0&sessionId=0&stdRollOrRegistrationNo="+encodeURIComponent(reg)}' +
      'var tb=document.getElementById("tb");' +
      'function fill(tr){if(!tr||tr.__k)return;tr.__k=1;var c=tr.cells,reg=c[1].textContent,spid=c[2].textContent;' +
      'if(!spid)return;' +
      'function mk(td,b){var a=document.createElement("a");a.href=u(b,reg,spid);a.target="_blank";' +
      'a.rel="noopener";a.textContent="Open ↗";td.appendChild(a)}' +
      'mk(c[3],E);if(A)mk(c[4],A)}' +
      'tb.addEventListener("mouseover",function(e){var tr=e.target.closest("tr");if(tr)fill(tr)});' +
      'tb.addEventListener("click",function(e){var td=e.target.closest("td");' +
      'if(!td||td.querySelector("a"))return;var i=td.cellIndex;if(i!==3&&(i!==4||!A))return;' +
      'var c=td.parentNode.cells,spid=c[2].textContent;if(!spid)return;' +
      'window.open(u(i===3?E:A,c[1].textContent,spid),"_blank","noopener")});' +
      'var bar=document.querySelector(".bar");bar.addEventListener("click",function(e){var b=e.target.closest(".f");if(!b)return;' +
      '[].forEach.call(bar.children,function(x){x.classList.remove("active")});b.classList.add("active");var f=b.getAttribute("data-f");' +
      '[].forEach.call(document.querySelectorAll("#tb tr"),function(tr){var st=tr.getAttribute("d");var show=f==="all"||st===f||(f==="no"&&st==="error");tr.classList.toggle("hide",!show)})})})();<\/script>' +
      '</body></html>';
    return html;
  }
  const CRC = (function () { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
  /* Carried across chunks, so a worksheet that is never assembled can still be checksummed. */
  function crc32Run(c, u8) { for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return c; }
  function crc32(u8) { return (crc32Run(0xFFFFFFFF, u8) ^ 0xFFFFFFFF) >>> 0; }
  function cat(a) { let n = 0; a.forEach(function (x) { n += x.length; }); const o = new Uint8Array(n); let p = 0; a.forEach(function (x) { o.set(x, p); p += x.length; }); return o; }
  function xesc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function cl(n) { let s = ""; n++; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
  /* the fill a row's colour maps to, and the same fill wearing the link font */
  const FILL_STYLE = { g: 1, r: 2, y: 4 };
  const LINK_STYLE = { g: 6, r: 7, y: 8 };

  /* Excel will not open a sheet with more rows than this, and a workbook that says it has more
     is "repaired" — which means emptied — rather than refused. */
  const XLSX_MAX_ROWS = 1048576;

  /** One row, as XML. Both writers below call this, so the streaming one and the whole-string one
      cannot drift into producing different workbooks.
      linkCols: column indexes holding a URL. They are written as HYPERLINK() and read "Open ↗". */
  /* Cells carry no r="A2".
     Every one of those is a different string sprinkled between every pair of compressible cells,
     and that is what stops deflate finding matches: dropping it takes the report from 3.97 MB to
     1.94 at 100,000 students, and a third off the time. The attribute is optional — a reader takes
     the cells in order — and every row below writes every column with no gaps, so order says
     exactly what the address said. The row keeps its own r=, which anchors it absolutely.
     Excel was asked rather than trusted: it opens the file, both tabs, every value in its right
     column, the Bengali intact and the HYPERLINK formula live, and repairs nothing.

     s="0" is the default style, and xml:space only matters to text with a space at either end. */
  function rowXml(row, rn, cc, isLink, isHeader) {
    const s = isHeader ? 3 : (FILL_STYLE[cc] || 0);
    let x = '<row r="' + rn + '">';
    row.forEach(function (cell, ci) {
      if (!isHeader && isLink[ci] && cell) {
        /* A formula, not a hyperlink relationship: Excel caps those at 65,530 per sheet and a
           100,000-row report in two-server mode would want 200,000, at which point Excel
           "repairs" the file by dropping them all. A double quote inside a formula string is
           written twice; a URL built with encodeURIComponent has none, but a hand-edited base
           address could. */
        const url = String(cell).replace(/"/g, '""');
        x += '<c s="' + (LINK_STYLE[cc] || 5) + '" t="str">' +
          "<f>HYPERLINK(&quot;" + xesc(url) + "&quot;,&quot;Open ↗&quot;)</f><v>Open ↗</v></c>";
        return;
      }
      const v = String(cell == null ? "" : cell);
      x += "<c" + (s ? ' s="' + s + '"' : "") + ' t="inlineStr"><is><t' +
        (/^\s|\s$/.test(v) ? ' xml:space="preserve"' : "") + ">" + xesc(v) + "</t></is></c>";
    });
    return x + "</row>";
  }

  /* The worksheet in pieces, front to back.
     Nothing needs the whole thing to exist at once — it is written once, straight into a deflate
     stream — and a JavaScript string cannot exceed about 512 MB, which 560,000 students cross.
     Measured: at 500,000 the XML is 479 MB and the workbook takes seven seconds; at 560,000 the
     old writer threw "Invalid string length" and produced no file at all, at the end of a run
     that had taken hours. */
  function* sheetChunks(header, rows, colors, linkCols, per, selected) {
    const isLink = {}; (linkCols || []).forEach(function (i) { isLink[i] = 1; });
    // Remarks and Details need room; the rest are short. A link column shows six characters now,
    // not a hundred-and-twenty-character query string, so it can be narrow.
    const W = header.length >= 7 ? [14, 12, 12, 11, 11, 62, 90] : [14, 12, 12, 11, 62, 90];
    let cols = '<cols>'; W.forEach(function (w, i) { cols += '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>'; }); cols += '</cols>';
    /* sheetViews comes before cols — the schema fixes the order, and a worksheet with them the
       other way round is a repaired (emptied) workbook rather than an error message. */
    const view = selected ? '<sheetViews><sheetView tabSelected="1" workbookViewId="0"/></sheetViews>' : "";
    yield '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      view + cols + '<sheetData>' + rowXml(header, 1, null, isLink, true);
    const step = per || 4000;
    for (let i = 0; i < rows.length; i += step) {
      let buf = "";
      for (let j = i; j < rows.length && j < i + step; j++) buf += rowXml(rows[j], j + 2, colors[j], isLink, false);
      yield buf;
    }
    // AutoFilter so Status (and other columns) are filterable in Excel
    yield "</sheetData><autoFilter ref=\"A1:" + cl(header.length - 1) + (rows.length + 1) + "\"/></worksheet>";
  }

  /* The same worksheet as one string — small reports, and the tests that read it back. */
  function sheetXml(header, rows, colors, linkCols) {
    let s = "";
    for (const c of sheetChunks(header, rows, colors, linkCols)) s += c;
    return s;
  }
  /* Built from the sheets rather than written out for one, so the workbook can carry a tab per
     kind of answer. All three have to agree about how many worksheets there are and what they are
     called: Excel repairs — that is, empties — a workbook whose parts disagree. */
  function ctXml(n) {
    let s = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>';
    for (let i = 1; i <= n; i++) {
      s += '<Override PartName="/xl/worksheets/sheet' + i + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
    }
    return s + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>';
  }
  /* A tab name Excel will accept: no : \\ / ? * [ ], no more than 31 characters, and not empty. */
  function tabName(s, i) {
    const n = String(s == null ? "" : s).replace(/[:\\\/?*\[\]]/g, " ").slice(0, 31).trim();
    return n || ("Sheet" + i);
  }
  function wbXml(names) {
    /* Which tab opens, said out loud. Sheet order and the active sheet are different things, and
       with neither declared every reader decides for itself — a report saved to put the problems
       in front of someone would then open on whichever tab that reader preferred. */
    let s = '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<bookViews><workbookView activeTab="0"/></bookViews><sheets>';
    names.forEach(function (n, i) {
      s += '<sheet name="' + xesc(tabName(n, i + 1)) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>';
    });
    return s + "</sheets></workbook>";
  }
  function wbrXml(n) {
    let s = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
    for (let i = 1; i <= n; i++) {
      s += '<Relationship Id="rId' + i + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + i + '.xml"/>';
    }
    /* the styles part takes the id after the last sheet, so it moves when a tab is added */
    return s + '<Relationship Id="rId' + (n + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>';
  }
  const RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
  const STY = '<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><u/><color rgb="FF0563C1"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="6"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFC6EFCE"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFC7CE"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE0E0E0"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFFFEB9C"/></patternFill></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="9"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf><xf numFmtId="0" fontId="0" fillId="2" borderId="0" xfId="0" applyFill="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf><xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf><xf numFmtId="0" fontId="0" fillId="4" borderId="0" xfId="0" applyFill="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf><xf numFmtId="0" fontId="0" fillId="5" borderId="0" xfId="0" applyFill="1" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="top"/></xf><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="top"/></xf><xf numFmtId="0" fontId="1" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="top"/></xf><xf numFmtId="0" fontId="1" fillId="5" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="top"/></xf></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
  /* deflate-raw is what a .zip entry wants. Without it the workbook is its XML verbatim — 79 MB
     for 100,000 rows, against 3.2 MB compressed, which is the difference between a file that can be
     mailed and one that cannot. Where the browser has no CompressionStream, or an entry comes out
     bigger compressed than it went in (a 200-byte .rels does), that entry is stored instead. */
  async function deflateRaw(u8) {
    if (typeof CompressionStream === "undefined") return null;
    try {
      const s = new Response(u8).body.pipeThrough(new CompressionStream("deflate-raw"));
      return new Uint8Array(await new Response(s).arrayBuffer());
    } catch (e) { return null; }
  }
  /* The same, for something too big to hold: chunks go in as they are made and only the compressed
     output is kept. Returns the pieces, the CRC and the uncompressed length — everything the zip's
     local header needs, which is why the header is written after the data rather than before. */
  async function deflateChunks(gen) {
    if (typeof CompressionStream === "undefined") return null;
    const enc = new TextEncoder();
    try {
      const cs = new CompressionStream("deflate-raw");
      const w = cs.writable.getWriter(), rd = cs.readable.getReader();
      const out = [];
      /* read while writing: the stream only takes more once what it has produced is drained */
      const pump = (async function () {
        for (;;) { const r = await rd.read(); if (r.done) break; out.push(r.value); }
      })();
      let crc = 0xFFFFFFFF, size = 0;
      for (const piece of gen) {
        const b = enc.encode(piece);
        crc = crc32Run(crc, b); size += b.length;
        await w.write(b);
      }
      await w.close();
      await pump;
      return { parts: out, crc: (crc ^ 0xFFFFFFFF) >>> 0, size: size };
    } catch (e) { return null; }
  }
  async function zipPack(files) {
    const enc = new TextEncoder();
    const u16 = function (n) { return new Uint8Array([n & 255, (n >> 8) & 255]); };
    const u32 = function (n) { n >>>= 0; return new Uint8Array([n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255]); };
    const chunks = [], central = []; let off = 0;
    for (let i = 0; i < files.length; i++) {
      const f = files[i], name = enc.encode(f.name);
      let crc, raw, parts, method = 8;
      if (f.chunks) {
        /* An entry too big to hold: the pieces go straight into the deflate stream and only the
           compressed output is kept. The header below needs the CRC and the uncompressed size,
           which is why they are accumulated on the way past rather than measured afterwards.

           f.chunks MAKES the pieces; it is not the pieces. A generator can be read once, and this
           reads them twice when the first attempt fails — measured against a stream that died on
           its second chunk: 12,001 rows in, 0 out, and no error anywhere. */
        const z = await deflateChunks(f.chunks());
        if (z) { parts = z.parts; crc = z.crc; raw = z.size; }
        else {
          /* No CompressionStream, or the stream failed. Store it — as BYTES, joined once, never
             as one string: a Uint8Array has no half-gigabyte ceiling, and that ceiling is the
             whole reason this path exists. */
          const bs = []; let n = 0;
          for (const piece of f.chunks()) { const b = enc.encode(piece); bs.push(b); n += b.length; }
          const whole = cat(bs);
          parts = [whole]; crc = crc32(whole); raw = n; method = 0;
        }
      } else {
        crc = crc32(f.data); raw = f.data.length;
        const body = await deflateRaw(f.data);
        if (!body || body.length >= raw) { parts = [f.data]; method = 0; }
        else parts = [body];
      }
      let csize = 0; parts.forEach(function (p) { csize += p.length; });
      /* a tiny entry can come out bigger compressed than it went in — store those */
      if (method === 8 && !f.chunks && csize >= raw) { parts = [f.data]; csize = raw; method = 0; }
      const lh = cat([u32(0x04034b50), u16(20), u16(0), u16(method), u16(0), u16(0),
        u32(crc), u32(csize), u32(raw), u16(name.length), u16(0), name]);
      chunks.push(lh);
      parts.forEach(function (p) { chunks.push(p); });
      central.push({ name: name, crc: crc, csize: csize, size: raw, off: off, method: method });
      off += lh.length + csize;
    }
    const cds = off, cdc = [];
    central.forEach(function (c) {
      cdc.push(cat([u32(0x02014b50), u16(20), u16(20), u16(0), u16(c.method), u16(0), u16(0),
        u32(c.crc), u32(c.csize), u32(c.size), u16(c.name.length), u16(0), u16(0), u16(0), u16(0),
        u32(0), u32(c.off), c.name]));
    });
    const cdb = cat(cdc); chunks.push(cdb);
    chunks.push(cat([u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length),
      u32(cdb.length), u32(cds), u16(0)]));
    return cat(chunks);
  }
  /* kept for the reader's sake: zipPack writes what this wrote, plus compression */
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
    /* the raw file holds only the rows that kept their cells, so it says its own count */
    try { dl(new Blob([buildRaw(rows)], { type: "text/plain;charset=utf-8;" }), "txt", fileTag(rows.length)); }
    catch (e) { exportFailed(e); }
  }
  function buildRaw(rows) {
    /* Two seventy-eight-character rules per student came to 22% of the file — a fifth of it spent
       on ink. A blank line above each heading and one short rule under it separate the students
       just as clearly, and what is left is the cells, which are why the file exists. */
    const NL = "\n", THIN = "-".repeat(20) + NL;
    let out = "UMS Reconciler " + ver() + " · " + new Date().toLocaleString() +
      " · " + rows.length + " flagged" + NL + baseUrl + NL;
    rows.forEach(function (r) {
      out += NL +
        r.status + " · reg " + r.reg + " · spid " + r.spid +
        (r.program ? " · " + r.program : "") + NL +
        r.remarks + NL + THIN + r.raw;
    });
    return out;
  }

  async function exportXlsx() {
    const rows = flatRows(); if (!rows.length) return;
    try {
      dl(new Blob([await buildXlsx(rows)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "xlsx", fileTag(rows.length));
    } catch (e) { exportFailed(e); }
  }
  /* async because compressing is: CompressionStream has no synchronous form. */
  /* one tab: a name and the rows that go on it */
  function xlsxTab(name, rows) {
    const header = srvMode
      ? ["Status", "Student Reg", "Program Id", "Expected Link", "Actual Link", "Remarks", "Details"]
      : ["Status", "Student Reg", "Program Id", "Payment History Link", "Remarks", "Details"];
    const mat = rows.map(function (r) {
      return srvMode
        ? [r.status, r.reg, r.spid, r.link, r.link2, r.remarks, r.details]
        : [r.status, r.reg, r.spid, r.link, r.remarks, r.details];
    });
    return { name: name, header: header, mat: mat,
      colors: rows.map(function (r) { return r.color; }),
      links: srvMode ? [3, 4] : [3] };
  }

  /* A workbook of one tab or several. Every part that names the sheets is built from the same
     list, so they cannot disagree — and a workbook whose parts disagree is not refused by Excel,
     it is "repaired", which means opened empty. */
  async function buildBook(tabs) {
    const enc = new TextEncoder();
    tabs.forEach(function (s) {
      /* Excel will not open a sheet with more rows than this, and a workbook claiming more is
         repaired rather than refused, so it is better to say so than to write one. */
      if (s.mat.length + 1 > XLSX_MAX_ROWS) {
        throw new Error(t("xlsx_toobig")
          .replace("{n}", (s.mat.length + 1).toLocaleString())
          .replace("{m}", XLSX_MAX_ROWS.toLocaleString()));
      }
    });
    const parts = [
      { name: "[Content_Types].xml", data: enc.encode(ctXml(tabs.length)) },
      { name: "_rels/.rels", data: enc.encode(RELS) },
      { name: "xl/workbook.xml", data: enc.encode(wbXml(tabs.map(function (s) { return s.name; }))) },
      { name: "xl/_rels/workbook.xml.rels", data: enc.encode(wbrXml(tabs.length)) },
      { name: "xl/styles.xml", data: enc.encode(STY) }
    ];
    tabs.forEach(function (s, i) {
      /* in pieces: see sheetChunks — the whole worksheet as one string stops existing at about
         560,000 students, which is a size this tool is asked for.
         The first tab is the selected one, matching activeTab="0" in the workbook above. */
      parts.push({ name: "xl/worksheets/sheet" + (i + 1) + ".xml",
        chunks: function () { return sheetChunks(s.header, s.mat, s.colors, s.links, 0, i === 0); } });
    });
    return zipPack(parts);
  }

  /* what the ⬇ Excel Report button writes: one tab, holding whatever the filter selected */
  async function buildXlsx(rows) {
    return buildBook([xlsxTab(t("tab_all"), rows)]);
  }

  /* …and what the run saves by itself: the same split the Total Problem tile makes, so the tab
     that needs someone can be opened without filtering a sheet of ninety thousand rows first. */
  async function buildBookSplit(rows) {
    /* r.result, not r.status — status is the sentence on screen ("Matched (manual)"), result is
       the code the tiles count. A student marked matched by hand already carries "ok" here, so the
       two tabs and the Total Problem tile always name the same students. */
    const bad = rows.filter(function (r) { return notOk(r.result); });
    const ok = rows.filter(function (r) { return !notOk(r.result); });
    return buildBook([
      xlsxTab(t("tab_problem") + " (" + bad.length + ")", bad),
      xlsxTab(t("tab_ok") + " (" + ok.length + ")", ok)
    ]);
  }

  /* ---------- saving a finished run ----------
     Switched on, everything the run produced goes into a folder of its own, named for when the run
     finished, so two runs never land on top of each other. */
  let saveOnFinish = false, dirHandle = null, dirName = "";

  /* A directory handle is not JSON, so chrome.storage cannot hold it; IndexedDB can, and that is
     the only way the chosen folder survives closing the page. */
  function idb(fn, store) {
    store = store || "kv";
    return new Promise(function (res, rej) {
      let rq;
      try { rq = indexedDB.open("umsrec", 2); } catch (e) { rej(e); return; }
      /* Version 2 adds "ck", the run checkpoint. Both stores are created by name and only when
         absent, so a browser arriving from version 1 keeps the folder handle already in "kv". */
      rq.onupgradeneeded = function () {
        const db = rq.result;
        if (!db.objectStoreNames.contains("kv")) db.createObjectStore("kv");
        if (!db.objectStoreNames.contains("ck")) db.createObjectStore("ck");
      };
      rq.onerror = function () { rej(rq.error); };
      rq.onsuccess = function () {
        const db = rq.result;
        let out;
        try {
          const tx = db.transaction(store, "readwrite");
          const r = fn(tx.objectStore(store));
          tx.oncomplete = function () { db.close(); res(r ? r.result : undefined); };
          tx.onerror = function () { db.close(); rej(tx.error); };
        } catch (e) { db.close(); rej(e); }
        return out;
      };
    });
  }

  /* Permission to write does not survive closing the page, and asking again needs a click — which
     is exactly what there is none of at the end of a long run. So it is asked for when the folder
     is chosen and only CHECKED when the run ends; if it has lapsed the run falls back to Downloads
     rather than losing what it just spent an hour producing. */
  async function dirUsable(h) {
    if (!h || !h.queryPermission) return false;
    try { return (await h.queryPermission({ mode: "readwrite" })) === "granted"; }
    catch (e) { return false; }
  }

  /* Permission to write to the chosen folder does not survive the page being closed: the handle
     comes back out of IndexedDB, the grant does not. Getting it back needs a user gesture, and
     the end of a run is the one moment there is certainly no click — so saveRun() could only
     ever ask whether it still had permission, find that it did not, and quietly write to
     Downloads instead. Chosen folder, switch on, and the files somewhere else, every session
     after the first.

     Start is a click. That is the whole fix: ask here, before the run, and by the time it
     finishes the answer is already known. A refusal is not fatal — the run still saves, to
     Downloads, and the progress line says where it went. */
  async function claimDir() {
    if (!saveOnFinish || !dirHandle || !dirHandle.queryPermission) return;
    try {
      if ((await dirHandle.queryPermission({ mode: "readwrite" })) === "granted") return;
      if (dirHandle.requestPermission) await dirHandle.requestPermission({ mode: "readwrite" });
    } catch (e) { /* refused, or the folder is gone — saveRun() falls back to Downloads */ }
    paintSaveRow();
  }

  /* Local time, and safe on every filesystem — no colons, no slashes. Seconds are in it because
     re-running a small sheet twice in one minute is ordinary. */
  function runFolder() {
    const d = new Date(), p = function (n) { return String(n).padStart(2, "0"); };
    return "UMS " + d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) +
      " " + p(d.getHours()) + "-" + p(d.getMinutes()) + "-" + p(d.getSeconds());
  }

  /* Two files, both holding the whole run — whatever the filter on screen says, because nobody
     chose it for the archive.

     The page is the big one: a hundred thousand rows take about seventeen seconds to become
     usable, against under a second for five thousand, and no amount of trimming bytes changes
     that — the rows are the wait. It carries them anyway. Someone reading a saved run wants the
     clean students in front of them too, and the filter chips at the top of the page put either
     half on screen in a click. */
  /* The workbook, and only the workbook.

     The page used to be written beside it, on the reasoning that someone opening a saved run
     wants to read it rather than open Excel. But it is the expensive half — a hundred thousand
     rows of HTML is tens of megabytes to build and write, at the end of a run, while the tab is
     still the thing standing between the work and its report — and the workbook already holds
     every row, in two tabs, problems first. The ⬇ HTML button is still there for the times a
     page is what is wanted, and it makes one from whatever is on screen in a second or two. */
  async function runFiles() {
    const rows = flatRows(true);
    if (!rows.length) return [];
    return [
      /* two tabs — what needs a person first, then what came out clean. buildXlsx() (the ⬇
         button) stays one tab, because there the filter has already chosen what the file is. */
      { name: "report.xlsx", blob: new Blob([await buildBookSplit(rows)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }) }
    ];
  }

  /* Downloads cannot be given an absolute path — whatever is asked for lands inside the user's
     Downloads folder — so this is the fallback, not the main road. */
  function saveViaDownloads(folder, files) {
    return new Promise(function (res) {
      let n = 0;
      const done = function () { if (++n >= files.length) res("Downloads / UMS Reconciler / " + folder); };
      files.forEach(function (f) {
        const url = URL.createObjectURL(f.blob);
        try {
          chrome.downloads.download({ url: url, filename: "UMS Reconciler/" + folder + "/" + f.name,
            saveAs: false, conflictAction: "uniquify" }, function () {
              setTimeout(function () { URL.revokeObjectURL(url); }, 30000);
              done();
            });
        } catch (e) { URL.revokeObjectURL(url); done(); }
      });
      if (!files.length) res("");
    });
  }

  /** Returns where it went, or "" if it did not run or produced nothing. */
  async function saveRun() {
    if (!saveOnFinish) return "";
    const files = await runFiles();
    if (!files.length) return "";
    const folder = runFolder();
    if (await dirUsable(dirHandle)) {
      try {
        const sub = await dirHandle.getDirectoryHandle(folder, { create: true });
        for (let i = 0; i < files.length; i++) {
          const fh = await sub.getFileHandle(files[i].name, { create: true });
          const w = await fh.createWritable();
          await w.write(files[i].blob);
          await w.close();
        }
        return dirName + " / " + folder;
      } catch (e) { /* the folder moved, was deleted, or is not writable — fall through */ }
    }
    return saveViaDownloads(folder, files);
  }

  function paintSaveRow() {
    const sw = $("saveSw"); if (sw) { sw.checked = saveOnFinish; if (sw.parentNode) sw.parentNode.classList.toggle("on", saveOnFinish); }
    const btn = $("pickDir"); if (btn) btn.disabled = !saveOnFinish;
    const el = $("saveWhere");
    if (el) el.textContent = saveOnFinish
      ? (dirName ? "→ " + dirName + " / " + t("save_folder") : "→ " + t("save_downloads"))
      : "";
  }

  async function pickDir() {
    if (!window.showDirectoryPicker) { const el = $("saveWhere"); if (el) el.textContent = t("save_nopicker"); return; }
    try {
      const h = await window.showDirectoryPicker({ mode: "readwrite", id: "umsrec" });
      if (h.requestPermission && (await h.requestPermission({ mode: "readwrite" })) !== "granted") return;
      dirHandle = h; dirName = h.name;
      try { await idb(function (st) { return st.put(h, "dir"); }); } catch (e) {}
      try { chrome.storage.local.set({ saveDirName: dirName }); } catch (e) {}
      paintSaveRow();
    } catch (e) { /* the picker was cancelled — nothing to say */ }
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
  /* What the last test found on each server: null = never tested, "busy" = asking now.
     Both badges are drawn from here and nowhere else — they used to carry their own data-i18n, so
     switching language repainted a tested badge back to "not checked" and asked for the test
     again for no reason. */
  const connState = { conn: null, conn2: null };
  const CONN_CLS = { ok: "ok", no: "no", fail: "no" };
  const connProto = { conn: "", conn2: "" };
  function paintConn() {
    const c2 = $("conn2"); if (c2) c2.style.display = srvMode ? "" : "none";
    [["conn", "conn_exp"], ["conn2", "conn_act"]].forEach(function (p) {
      const el = $(p[0]); if (!el) return;
      const st = connState[p[0]];
      /* Two badges side by side must say which is which, or a red one sends you to the wrong
         server. With one server there is nothing to disambiguate, so the tag stays off. */
      const tag = srvMode ? t(p[1]) + " · " : "";
      el.textContent = tag + (st === null ? t("conn_unchecked") : st === "busy" ? t("checking")
        : st === "ok" ? t("conn_ok") : st === "no" ? t("conn_no") : t("conn_fail"));
      el.className = "badge " + (st === null || st === "busy" ? "mut" : CONN_CLS[st] || "no");
    });
  }
  /* What the browser will actually do with "একসাথে কয়টি অনুরোধ".

     Over HTTP/1.1 Chrome opens at most six connections to one host and queues everything else, so
     a run set to 25 has 25 fetches outstanding and six on the wire. Over HTTP/2 they share one
     connection and the setting means what it says. Measured, not assumed: fifty simultaneous
     fetches to an HTTP/1.1 host arrived six at a time.

     The connection test has just loaded a page from this server, so the answer is already in the
     Resource Timing entry for it. */
  const HOST_LIMIT_H1 = 6;
  /* One student is not one request. Program Wise and Course Wise are fetched together, and in
     two-server mode that pair goes to each server at once — so the box, which is set in
     students, is a number of pages twice or four times its size. It said "requests" for a long
     time, which mattered most to whoever was holding it down to protect the server. */
  function pagesPerStudent() { return srvMode ? 4 : 2; }
  function pagesPerHost() { return 2; }   // …and both of them go to the same host
  function protoOf(url) {
    try {
      const es = performance.getEntriesByType("resource");
      for (let i = es.length - 1; i >= 0; i--) {
        if (es[i].name === url && es[i].nextHopProtocol) return es[i].nextHopProtocol;
      }
    } catch (e) {}
    return "";
  }
  /* How many STUDENTS can be in flight at once, given what the servers speak.

     Two servers are two hosts and two connection pools — but a student needs both of them, so
     the two pools do not add up: the run goes at the speed of whichever host allows fewer
     students, and each host is asked for two pages per student, not one. Summing the pools and
     counting a student as a request said 12 where the truth is 3, which is the number someone
     reads before deciding the tool is fast enough. */
  function realConc() {
    const ps = [connProto.conn, srvMode ? connProto.conn2 : null].filter(function (p) { return p; });
    if (!ps.length) return null;                       // not tested yet — say nothing
    let cap = Infinity;
    ps.forEach(function (p) {
      const students = /^h2|^h3/.test(p) ? 1000 : Math.floor(HOST_LIMIT_H1 / pagesPerHost());
      if (students < cap) cap = students;
    });
    return Math.min(conc, Math.max(1, cap));
  }
  async function testOneConn(badge, base) {
    if (!$(badge)) return;
    connState[badge] = "busy"; connProto[badge] = ""; paintConn();
    try {
      const url = payBase(base) + "PaymentHistory";
      const r = await fetchHtml(url);
      const ok = r.ok && !/Account\/Login/i.test(r.html) && /stdRollOrRegistrationNo/i.test(r.html);
      connState[badge] = ok ? "ok" : "no";
      connProto[badge] = protoOf(url);
    } catch (e) { connState[badge] = "fail"; }
    paintConn(); paintConc();
  }
  /* Said under the Parallel box, where the number that may be a fiction actually is. */
  function paintConc() {
    const el = $("concNote"); if (!el) return;
    const real = realConc();
    if (real === null) { el.textContent = ""; el.className = "cnote"; return; }
    const p = connProto.conn || "http/1.1";
    const capped = real < conc;
    /* {n} is what actually goes at once, {c} what the box says — the same number when nothing is
       holding the run back, which is all the ✓ claims. Numerals go through the same localisation
       as every other number on the page; a Latin 25 inside a Bengali sentence is a different kind
       of wrong from a bad translation and just as visible. */
    const num = function (v) { return lang === "bn" ? Number(v).toLocaleString("bn-BD") : String(v); };
    const each = pagesPerStudent(), reqs = real * each;
    el.textContent = t(capped ? "conc_capped" : "conc_real")
      .replace("{n}", num(real)).replace("{c}", num(conc)).replace("{r}", num(reqs));
    /* two sentences: what the browser will let through, and what the box means in pages */
    el.title = t(capped ? "conc_why_capped" : (/^h2|^h3/.test(p) ? "conc_why_h2" : "conc_why_room"))
      .replace("{p}", p) + "\n\n" + t("conc_many_pc")
        .replace("{e}", num(each)).replace("{n}", num(conc))
        .replace("{r}", num(conc * each)).replace("{r4}", num(conc * each * 4));
    el.className = "cnote " + (capped ? "warn" : "ok");
  }
  /* Both servers, because a run needs a session on both — one green badge would say the run is
     ready when half of it cannot load a page. */
  async function testConn() {
    await testOneConn("conn", baseUrl);
    if (srvMode) await testOneConn("conn2", baseUrl2);
    paintConc();
  }
  function saveCfg() { try { chrome.storage.local.set({ baseUrl: baseUrl, baseUrl2: baseUrl2, srvMode: srvMode, appConc: conc, appTol: tol }); $("saveCfg").textContent = t("saved"); setTimeout(function () { $("saveCfg").textContent = t("save"); }, 1500); } catch (e) {} }

  /* Show what the chosen mode needs and relabel everything for it. t() already resolves the s_
     twins, so applyLang() repainting the data-i18n nodes is the whole relabelling — the tiles, the
     filters and the pills follow from it. */
  function applySrvMode() {
    const row = $("base2row"); if (row) row.style.display = srvMode ? "" : "none";
    /* the track has to gain a column with the field, or the buttons land in the wrong one */
    const cg = $("connGrid"); if (cg) cg.classList.toggle("two", srvMode);
    /* The tiles and chips are the same six buckets in both modes, but not the same severities:
       grey means "nothing to do here" on a single-server run and "money did not survive the
       migration" on a two-server one. One class on body, and the colours follow the meaning. */
    document.body.classList.toggle("srv", srvMode);
    const sh = $("srvHint"); if (sh) sh.style.display = srvMode ? "" : "none";
    const sw = $("srvSw"); if (sw && sw.parentNode) sw.parentNode.classList.toggle("on", srvMode);
    /* every mode-dependent word, in one sweep: t() resolves the s_ twins and applyLang() repaints
       each data-i18n node from it, so nothing here writes a label by hand and no label can be set
       and then quietly overwritten. */
    applyLang(lang);
    paintConc();      // two servers means two connection pools, so the ceiling moves with the mode
  }
  function setSrvMode(v) {
    srvMode = !!v;
    applySrvMode();
    /* A finished run answered the other question — its verdicts do not carry over, and leaving the
       cards on screen under the new labels would put two different meanings on one word. */
    students = []; $("list").innerHTML = "";
    ["ok", "no", "cw", "zero", "nf", "err", "stu", "done"].forEach(function (k) { T[k] = 0; });
    T.total = 0; paintTiles(); $("fill").style.width = "0%";
    $("html").disabled = true; $("xlsx").disabled = true; $("raw").disabled = true;
    $("prog").textContent = t("ready");
    try { chrome.storage.local.set({ srvMode: srvMode }); } catch (e) {}
  }

  /* What the sticky topbar leaves for everything under it.
     Measured, not assumed: 61px on a wide screen and 77px once the subtitle wraps onto a
     second line, and it moves again with the language, the theme's font or a zoom. Anything
     that sticks below the topbar reads this, so it is taken from the element and re-taken
     whenever the thing that changes it changes. */
  function measureTop() {
    const t = document.querySelector(".topbar"); if (!t) return;
    const h = Math.round(t.getBoundingClientRect().height);
    if (h) document.documentElement.style.setProperty("--top-h", h + "px");
  }

  /* ---------- sections ----------
     Both live in this document and one of them is shown. Nothing is torn down on the way out:
     a run in Payment History keeps its workers, its answers and its list, because none of that
     survives a page that is left. */
  let page = "pay";
  /* ── New Admission load test — session-based, no helper, no credentials ───────────
     Like Payment History, this runs on the browser's own UMS login. It drives the real
     NewStudentAdmission flow with fetch() against the same endpoints the page's own JS calls
     (/Scripts/Student/NewAdmission.js): GetProgramByClass → GetSessionByProgram →
     GetBranchByProgramSession → GetCampus… → GetBatch(Day/Time) cascade → CalculateCourseFee →
     StudentRegistration → DuePayment. These AJAX POSTs need only the session cookie (no antiforgery
     token). The name is auto; the mobile and the counts come from the user. It measures how fast N
     admissions complete. ⚠ creates REAL records — a test/demo server only. */
  let admBusyFlag = false, admStopFlag = false, admConnSeq = 0, admConnTimer = null, admConnState = null, admToken = "";
  const ADM_PATH = "/Student/Admission/NewStudentAdmission";
  function admBusy(on) {
    admBusyFlag = on;
    const b = $("admRun"); if (b) { b.disabled = on; b.textContent = t(on ? "adm_running" : "adm_run"); }
    if ($("admStop")) $("admStop").disabled = !on;
  }
  /* colour each line by its lead marker — ✓ ok, ✗ fail, ⚠ warn, → start, ── summary — so a run is
     scannable; textContent keeps UMS-supplied text safe from HTML injection */
  function admOutLine(s) {
    const o = $("admOut"); if (!o) return; o.style.display = "";
    const cls = /^\s*✓/.test(s) ? "ok" : /^\s*✗/.test(s) ? "no" : /^\s*⚠/.test(s) ? "warn" : /^\s*──/.test(s) ? "mut" : /^\s*→/.test(s) ? "info" : "";
    const span = document.createElement("span"); if (cls) span.className = cls;
    span.textContent = (o.childNodes.length ? "\n" : "") + s;
    o.appendChild(span); o.scrollTop = o.scrollHeight;
  }
  function admCount() { return Math.max(1, Math.min(1000, parseInt($("admCount").value, 10) || 1)); }
  function admPool() { return Math.max(1, Math.min(20, parseInt($("admPool").value, 10) || 1)); }
  function admBaseUrl() { return (($("admBase") && $("admBase").value) || "").trim().replace(/\/+$/, ""); }
  function admSetConn(state) {
    admConnState = state || null;
    const el = $("admConn"); if (!el) return;
    el.className = "crmconn" + (state ? " " + state : "");
    el.textContent = state === "busy" ? t("checking")
      : state === "ok" ? t("crm_reach_ok") : state === "no" ? t("crm_reach_no") : t("conn_unchecked");
  }
  async function admTestConn() {
    const base = admBaseUrl();
    if (!base) { admSetConn(null); return; }
    const mine = ++admConnSeq; admSetConn("busy");
    let ok = false;
    try { const r = await fetchHtml(base + ADM_PATH); ok = !!(r && r.status); }
    catch (e) { ok = false; }
    if (mine === admConnSeq) admSetConn(ok ? "ok" : "no");
  }
  function admConnDebounced() { if (admConnTimer) clearTimeout(admConnTimer); admConnTimer = setTimeout(admTestConn, 700); }

  /* ---- session fetch helpers ---- */
  function admUrl(path) {
    const base = admBaseUrl();
    if (!/^https?:\/\//i.test(base)) throw new Error("UMS ঠিকানা ঠিক নেই: \"" + base + "\" (https://ums-4.osl.team এর মতো হবে)");
    return base + path;
  }
  /* UMS denies admission AJAX that does not look like it came from the admission page, so rewrite
     the Referer (and Origin) of our own requests to that page — fetch cannot set a cross-origin
     Referer, but declarativeNetRequest can. Scoped to this base's host, which is in host_permissions. */
  async function admInstallRefererRule() {
    try {
      if (!(chrome.declarativeNetRequest && chrome.declarativeNetRequest.updateSessionRules)) return false;
      const base = admBaseUrl();
      const host = base.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [8801],
        addRules: [{
          id: 8801, priority: 1,
          action: { type: "modifyHeaders", requestHeaders: [
            { header: "referer", operation: "set", value: base + ADM_PATH },
            { header: "origin", operation: "set", value: base }
          ] },
          condition: { requestDomains: [host], resourceTypes: ["xmlhttprequest"] }
        }]
      });
      return true;
    } catch (e) { admOutLine("⚠ Referer rule: " + ((e && e.message) || e)); return false; }
  }
  /* strip a UMS warning/error HTML page down to its human message (title + visible body text) */
  function admHtmlMessage(txt) {
    let doc; try { doc = new DOMParser().parseFromString(txt, "text/html"); } catch (e) { return txt.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 300); }
    const title = ((doc.querySelector("title") && doc.querySelector("title").textContent) || "").trim();
    Array.prototype.forEach.call(doc.querySelectorAll("style,script,link,head"), function (n) { n.remove(); });
    const body = ((doc.body && doc.body.textContent) || "").replace(/\s+/g, " ").trim();
    const msg = (body || title || "").slice(0, 300);
    return (title && msg.toLowerCase().indexOf(title.toLowerCase()) < 0 ? title + " — " : "") + msg;
  }
  async function admPost(path, data) {
    const body = new URLSearchParams();
    Object.keys(data).forEach(function (k) {
      const v = data[k];
      if (Array.isArray(v)) v.forEach(function (x) { body.append(k, x); });
      else body.append(k, v == null ? "" : v);
    });
    if (admToken) body.append("__RequestVerificationToken", admToken);   // also as a form field, the standard antiforgery spot
    const url = admUrl(path);
    const headers = { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest" };
    if (admToken) headers["RequestVerificationToken"] = admToken;   // UMS validates the antiforgery token on POST
    let r;
    try {
      r = await fetch(url, { method: "POST", credentials: "include", headers: headers, body: body.toString() });
    } catch (e) { throw new Error("fetch ব্যর্থ (" + ((e && e.message) || e) + ") → " + url); }
    const txt = await r.text();
    if (/Account\/Login/i.test(r.url || "") || /name=["']?Password["']?/i.test(txt.slice(0, 4000))) throw new Error("not logged in (" + path.split("/").pop() + ")");
    if (/PermissionDenied|Permission Denied/i.test(txt.slice(0, 2000))) throw new Error("PermissionDenied — " + path.split("/").pop() + " (token/অনুমতি)");
    /* UMS answers a rejected action with a styled HTML page titled Warning/Error instead of JSON —
       pull the readable message out of it (a genuine HTML payload like a DuePayment receipt has no
       such title, so it passes through untouched) */
    const errTitle = (txt.slice(0, 3000).match(/<title>\s*(warning|error|access denied|permission[^<]*)\s*<\/title>/i) || [])[1];
    if (errTitle) throw new Error(path.split("/").pop() + ": " + admHtmlMessage(txt));
    try { return JSON.parse(txt); } catch (e) { return txt; }
  }
  async function admGetDoc(path) {
    const url = admUrl(path);
    let r;
    try { r = await fetch(url, { credentials: "include" }); }
    catch (e) { throw new Error("fetch ব্যর্থ (" + ((e && e.message) || e) + ") → " + url); }
    const txt = await r.text();
    if (/Account\/Login/i.test(r.url || "")) throw new Error("not logged in — আগে ব্রাউজারে ওই সার্ভারে লগইন করো");
    return new DOMParser().parseFromString(txt, "text/html");
  }
  /* the money receipt is a base64 PDF in #moneyReceiptData; decode it, inflate each FlateDecode content
     stream (zlib) and return the visible text so Reg No / Roll / amounts can be read */
  /* hex like "0052" or "00520069" → the characters it encodes (2 bytes per code unit) */
  function admHexToStr(hex) {
    let s = ""; for (let i = 0; i + 4 <= hex.length; i += 4) s += String.fromCharCode(parseInt(hex.substr(i, 4), 16));
    return s;
  }
  /* merge every ToUnicode CMap (beginbfchar / beginbfrange) in the PDF into one glyph→char map */
  function admBuildCMap(streams) {
    const map = {}; let m;
    streams.forEach(function (txt) {
      if (txt.indexOf("beginbfchar") < 0 && txt.indexOf("beginbfrange") < 0) return;
      const charRe = /beginbfchar([\s\S]*?)endbfchar/g;
      while ((m = charRe.exec(txt))) {
        const pr = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g; let p;
        while ((p = pr.exec(m[1]))) map[p[1].toUpperCase().padStart(4, "0")] = admHexToStr(p[2]);
      }
      const rangeRe = /beginbfrange([\s\S]*?)endbfrange/g;
      while ((m = rangeRe.exec(txt))) {
        const rr = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([\s\S]*?)\])/g; let r;
        while ((r = rr.exec(m[1]))) {
          const lo = parseInt(r[1], 16), hi = parseInt(r[2], 16), w = Math.max(4, r[1].length);
          if (r[3]) { let d = parseInt(r[3], 16); for (let c = lo; c <= hi; c++) map[c.toString(16).toUpperCase().padStart(w, "0")] = String.fromCharCode(d++); }
          else if (r[4]) { const arr = r[4].match(/<([0-9A-Fa-f]+)>/g) || []; for (let c = lo, i = 0; c <= hi && i < arr.length; c++, i++) map[c.toString(16).toUpperCase().padStart(w, "0")] = admHexToStr(arr[i].replace(/[<>]/g, "")); }
        }
      }
    });
    return map;
  }
  /* decode a content stream's <hex> glyph runs (in Tj and [ ]TJ) through the cmap; a big Td/space
     between runs becomes a space so words stay separable */
  function admDecodeContent(txt, map) {
    let out = "";
    const re = /\[([\s\S]*?)\]\s*TJ|<([0-9A-Fa-f]+)>\s*Tj|(-?\d+(?:\.\d+)?)\s+0\s+Td/g; let m;
    while ((m = re.exec(txt))) {
      if (m[3] !== undefined) { if (Math.abs(parseFloat(m[3])) > 20) out += " "; continue; }
      const hexes = m[1] !== undefined ? (m[1].match(/<([0-9A-Fa-f]+)>/g) || []).map(function (h) { return h.replace(/[<>]/g, ""); }) : [m[2]];
      hexes.forEach(function (hex) { hex = hex.toUpperCase(); for (let i = 0; i + 4 <= hex.length; i += 4) { const g = map[hex.substr(i, 4)]; out += (g !== undefined ? g : ""); } });
    }
    return out;
  }
  async function admReceiptText(payId) {
    const rc = await admGetDoc("/Student/Payment/GenerateMoneyReciept?id=" + encodeURIComponent(payId));
    const el = rc.querySelector("#moneyReceiptData") || rc.querySelector('[name="moneyReceiptData"]');
    const b64 = el ? (el.getAttribute("value") || el.value || el.textContent || "") : "";
    if (!b64) return "";
    const bytes = Uint8Array.from(atob(b64.replace(/\s+/g, "")), function (c) { return c.charCodeAt(0); });
    let bin = ""; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    let idx = 0; const inflated = [];
    while (true) {
      const s = bin.indexOf("stream", idx); if (s < 0) break;
      let start = s + 6; if (bin[start] === "\r") start++; if (bin[start] === "\n") start++;
      const e = bin.indexOf("endstream", start); if (e < 0) break;
      idx = e + 9;
      let end = e; while (end > start && (bin[end - 1] === "\n" || bin[end - 1] === "\r")) end--;   // drop the EOL before endstream
      let got = false;
      for (const fmt of ["deflate", "deflate-raw"]) {
        try {
          const inf = await new Response(new Blob([bytes.subarray(start, end)]).stream().pipeThrough(new DecompressionStream(fmt))).arrayBuffer();
          inflated.push(new TextDecoder("latin1").decode(new Uint8Array(inf))); got = true;
          break;
        } catch (e2) {}
      }
      if (!got) {   // uncompressed stream (a plain-text ToUnicode CMap or content) — read it as-is
        const raw = bin.slice(start, end);
        if (raw.indexOf("beginbf") >= 0 || raw.indexOf("Tj") >= 0 || raw.indexOf("TJ") >= 0) inflated.push(raw);
      }
    }
    const cmap = admBuildCMap(inflated);
    let out = "";
    inflated.forEach(function (txt) { if (txt.indexOf("Tj") >= 0 || txt.indexOf("TJ") >= 0) out += admDecodeContent(txt, cmap) + " "; });
    return out.replace(/[ \t]+/g, " ").trim();
  }
  function admOpts(html) {
    const doc = new DOMParser().parseFromString("<select>" + String(html || "") + "</select>", "text/html");
    return Array.prototype.map.call(doc.querySelectorAll("option"), function (o) { return { value: o.getAttribute("value") || o.value, text: (o.textContent || "").trim() }; })
      .filter(function (o) { return o.value && String(o.value).trim(); });
  }
  function admPick(opts, prefer) {
    if (!opts || !opts.length) return null;
    if (prefer) for (let i = 0; i < prefer.length; i++) { const f = opts.find(function (o) { return o.text.toLowerCase().indexOf(prefer[i].toLowerCase()) >= 0; }); if (f) return f; }
    return opts[0];
  }
  function admDocOpts(doc, sel, prefer) {
    return admPick(Array.prototype.map.call(doc.querySelectorAll(sel), function (o) { return { value: o.getAttribute("value") || o.value, text: (o.textContent || "").trim() }; }).filter(function (o) { return o.value && String(o.value).trim(); }), prefer);
  }
  /* a course's subjects live in the CourseView as .course-<id>-subjects checkboxes carrying
     data-course-subject-id/name/payment and data-group-no; readonly ones are compulsory */
  function admSubjectsOf(doc, courseId) {
    const cbs = doc.querySelectorAll(".course-" + courseId + "-subjects");
    return Array.prototype.map.call(cbs, function (s) {
      return { Id: s.getAttribute("data-course-subject-id"), Name: s.getAttribute("data-course-subject-name"),
        Payment: s.getAttribute("data-course-subject-payment") || "0", group: s.getAttribute("data-group-no") || "0",
        readonly: s.hasAttribute("readonly") || s.readOnly === true, checked: s.checked || s.hasAttribute("checked") };
    }).filter(function (s) { return s.Id; });
  }
  /* the course fee is the sum of the CHECKED subjects' payment; take the compulsory (readonly/checked)
     ones, then fill up to the minimum, one per non-zero group, never past the max */
  function admPickSubjects(subs, minN, maxN) {
    const picked = [], groupUsed = {}, max = maxN || subs.length;
    const take = function (s) {
      if (picked.length >= max) return;
      const g = s.group; if (g && g !== "0") { if (groupUsed[g]) return; groupUsed[g] = 1; }
      picked.push({ Id: s.Id, Name: s.Name, Payment: s.Payment, IsTaken: true });
    };
    subs.forEach(function (s) { if (s.readonly || s.checked) take(s); });
    subs.forEach(function (s) { if (picked.length < (minN || 0) && !s.readonly && !s.checked) take(s); });
    return picked;
  }
  function admCourses(courseViewHtml) {
    const doc = new DOMParser().parseFromString(String(courseViewHtml || ""), "text/html");
    let cbs = doc.querySelectorAll(".course-name-check");
    if (!cbs.length) cbs = doc.querySelectorAll('input[data-course-id]:not([class*="-subjects"]), input[type=checkbox][class*="course-name"]');
    return Array.prototype.map.call(cbs, function (cb) {
      let id = cb.getAttribute("data-course-id") || cb.getAttribute("data-courseid");
      if (!id) { const m = (cb.className || "").match(/course-(\d+)/); if (m) id = m[1]; }
      let name = cb.getAttribute("data-course-name") || "";
      if (!name) { const row = cb.closest("tr,label,li,div"); name = row ? (row.textContent || "").replace(/\s+/g, " ").trim().slice(0, 60) : id; }
      return { id: id, name: name,
        programId: cb.getAttribute("data-program-id"), sessionId: cb.getAttribute("data-session-id"),
        officeMinSub: cb.getAttribute("data-officeminsub"), maxSubject: cb.getAttribute("data-maximumsubject"),
        isOfficeCompulsary: cb.getAttribute("data-isofficecompulsary"),
        minPay: parseFloat(cb.getAttribute("data-officeminpayment") || cb.getAttribute("data-publicminpayment") || cb.getAttribute("data-officeminpay") || "0") || 0,
        isFromOther: String(cb.getAttribute("data-isfromshowonotherprogram")).toLowerCase() === "true",
        isAcademic: String(cb.getAttribute("data-isacademicgroup")).toLowerCase() === "true",
        subjects: admSubjectsOf(doc, id) };
    }).filter(function (c) { return c.id; });
  }
  /* batch endpoints return arrays whose item may be a string or {Value/Text} — take the first usable */
  function admFirstVal(arr) {
    if (!arr) return "";
    const a = Array.isArray(arr) ? arr : (arr.BatchDays || arr.BatchTime || arr.Batch || []);
    for (let i = 0; i < a.length; i++) {
      const it = a[i];
      const v = (it && typeof it === "object") ? (it.Value != null ? it.Value : (it.value != null ? it.value : it.Id)) : it;
      if (v != null && String(v).trim()) return v;
    }
    return "";
  }
  const ADM_NAMES = "Rahim Karim Faruk Hasan Mahmud Jahid Rakib Arif Monir Sumon Milon Rubel Shakil Tanvir".split(" ");
  let _admSeq = 0;
  /* letters only — the admission form strips digits from the name (/[^a-zA-Z-\s]/), so a base36 suffix
     with numbers would be rejected; a 4-letter random tail keeps each nick name distinct */
  function admName() {
    const r = function () { return ADM_NAMES[Math.floor(Math.random() * ADM_NAMES.length)]; };
    const L = "abcdefghijklmnopqrstuvwxyz"; let suf = "";
    for (let i = 0; i < 4; i++) suf += L[Math.floor(Math.random() * L.length)];
    _admSeq++; return r() + " " + r() + suf;
  }

  /* ---- interactive form: the dropdowns are fetched from UMS, the user picks ---- */
  let admLoaded = false, admClassId = "", admVersion = "", admCourseView = "", admBatchOf = {};
  let admBoardRows = [], admPayMethod = 0, admBoardView = "", admPhysBranch = "", admShowAcademic = false;   // captured at load / on session change
  /* a <select>'s chosen value inside a parsed (non-live) page: the option carrying `selected`, else
     the first real option */
  function admSelVal(doc, sel) {
    const el = doc.querySelector(sel); if (!el) return "";
    const o = el.querySelector("option[selected]") || el.querySelector('option[value]:not([value=""])') || (el.options && el.options[0]);
    return o ? (o.getAttribute("value") || o.value || "") : "";
  }
  /* the Board Exam rows the real form submits (SSC/HSC …). They live in GetBranchByProgramSession's
     ExamBoardView, so discover the rows straight from the examBoard_/examId_/examYear_ fields present
     (don't rely on #hasBoardInfo — that hidden flag sits on the main page, not in this fragment).
     Year/Roll/Reg may stay blank; each row still carries its StudentExamId and selected BoardId. */
  function admBoardInfoFrom(doc) {
    const idx = {};
    Array.prototype.forEach.call(doc.querySelectorAll('[id^="examBoard_"],[id^="examId_"],[id^="examYear_"]'), function (el) {
      const m = (el.id || "").match(/_(\d+)$/); if (m) idx[m[1]] = 1;
    });
    return Object.keys(idx).map(Number).sort(function (a, b) { return a - b; }).map(function (i) {
      const v = function (id) { const e = doc.querySelector("#" + id + "_" + i); return (e && e.value) || ""; };
      return { StudentExamId: v("examId") || "0", Year: v("examYear"), BoardId: admSelVal(doc, "#examBoard_" + i) || "0",
        BoardRoll: v("boardRoll"), RegistrationNumber: v("registrationNumber") };
    });
  }
  function admFill(id, opts, prefer, placeholder) {
    const sel = $(id); if (!sel) return null;
    let html = placeholder ? '<option value="">' + placeholder + "</option>" : "";
    opts.forEach(function (o) { html += '<option value="' + String(o.value).replace(/"/g, "&quot;") + '">' + (o.text || "").replace(/</g, "&lt;") + "</option>"; });
    sel.innerHTML = html; sel.disabled = opts.length === 0;
    const pick = prefer ? admPick(opts, prefer) : (opts[0] || null);
    if (pick) sel.value = pick.value;
    return pick;
  }
  async function admLoadForm() {
    const base = admBaseUrl(); if (!base) { admOutLine(t("adm_need_base")); return; }
    if ($("admLoad")) { $("admLoad").disabled = true; $("admLoad").textContent = t("adm_loading"); }
    try {
      await admInstallRefererRule();   // make our AJAX look like it came from the admission page
      const page = await admGetDoc(ADM_PATH);
      /* the antiforgery token every POST must carry — take the LAST one on the page (the admission
         form's, not the logout form's) as some UMS setups tie the token to its own form */
      const toks = page.querySelectorAll('input[name="__RequestVerificationToken"]');
      admToken = toks.length ? (toks[toks.length - 1].getAttribute("value") || toks[toks.length - 1].value || "") : "";
      if (!admToken) throw new Error("antiforgery token পেলাম না — ঠিক পেজ এসেছে তো?");
      admPayMethod = parseInt("0" + admSelVal(page, "#PaymentMethods"), 10) || 0;   // e.g. Cash (board rows come later, from ExamBoardView)
      const classOpt = admDocOpts(page, "#StudentClass option", ["Admission"]);
      if (!classOpt) throw new Error("no Student Class");
      admClassId = classOpt.value;
      admVersion = (admDocOpts(page, "#VersionOfStudy option", ["Bangla"]) || {}).value || "";
      const pr = await admPost("/Student/Admission/GetProgramByClass", { classId: admClassId });
      admCourseView = pr.CourseView || pr.courseView || pr.CourseList || "";
      /* the page names this returnProgramList; be tolerant of casing and fall back to any HTML-ish
         field, then to a raw dump so a mismatch is visible instead of silently empty */
      const listHtml = pr.returnProgramList || pr.ReturnProgramList || pr.programList || pr.ProgramList ||
        pr.returnProgram || pr.Programs || (typeof pr === "string" ? pr : "");
      const progs = admOpts(listHtml);
      if (!progs.length) {
        admOutLine("⚠ " + t("adm_no_program") + " (classId=" + admClassId + ")");
        admOutLine("keys: " + (pr && typeof pr === "object" ? Object.keys(pr).join(", ") : typeof pr));
        admOutLine("resp: " + String(typeof pr === "string" ? pr : JSON.stringify(pr)).slice(0, 400));
        return;
      }
      const nonDemo = progs.filter(function (o) { return o.text.toLowerCase().indexOf("demo") < 0; });
      admFill("admProgram", progs, ["medical admission", "medical"], "— Program —");
      if (nonDemo.length) { const md = admPick(nonDemo, ["medical admission", "medical"]); if (md) $("admProgram").value = md.value; }
      admLoaded = true;
      admOutLine(t("adm_loaded").replace("{n}", progs.length));
      await admOnProgram();
      admSetConn("ok");
    } catch (e) { admOutLine("⚠ " + ((e && e.message) || e)); }
    finally { if ($("admLoad")) { $("admLoad").disabled = false; $("admLoad").textContent = t("adm_load"); } }
  }
  async function admOnProgram() {
    if (!admLoaded || !$("admProgram").value) return;
    const se = await admPost("/Student/Admission/GetSessionByProgram", { programId: $("admProgram").value, sessionId: "" });
    if (se.CourseView) admCourseView = se.CourseView;
    admShowAcademic = !!(se.IsShowAcademicGroupOptionInAdmission || se.isShowAcademicGroupOptionInAdmission);   // program needs an Academic Group
    admFill("admSession", admOpts(se.SessionOptions), ["2025"], null);
    await admOnSession();
  }
  async function admOnSession() {
    if (!admLoaded) return;
    /* isOnlyBranch:false is what makes GetBranchByProgramSession also return CourseView (the course
       list for this program+session) — with true it returns only the branch options and no courses */
    const br = await admPost("/Student/Admission/GetBranchByProgramSession", { programId: $("admProgram").value, sessionId: $("admSession").value, studentId: 0, isOffice: true, versionStudy: admVersion, gender: $("admGender").value, isOnlyBranch: false, selectedCourseId: 0 });
    const opts = admOpts((br && (br.BrunchOptions || br.BranchOptions || br.brunchOptions || br.branchOptions)) || (typeof br === "string" ? br : ""));
    admFill("admBranch", opts, ["Farmgate", "Rajshahi"], null);   // single option auto-selects (admFill picks opts[0])
    if (!opts.length) admOutLine("⚠ Branch খালি — resp: " + String(typeof br === "string" ? br : JSON.stringify(br)).slice(0, 300));
    if (br && br.CourseView) admCourseView = br.CourseView;        // the real courses arrive here
    /* the Board Exam section (SSC/HSC rows) rides along as ExamBoardView in this same response, not on
       the initial page — parse it here so registration can submit the board rows the form would */
    admBoardView = (br && (br.ExamBoardView || br.examBoardView)) || "";
    admBoardRows = admBoardInfoFrom(new DOMParser().parseFromString(String(admBoardView), "text/html"));
    /* when GetBranchByProgramSession offers Attached Physical Branch options (count > 0) the form makes
       that field required — pick the first real option, else leave it blank */
    const physCount = parseInt("0" + (br && (br.attachedPhysicalBrunchOptionsCount || br.AttachedPhysicalBrunchOptionsCount)), 10) || 0;
    const physReal = admOpts((br && (br.AttachedPhysicalBrunchOptions || br.attachedPhysicalBrunchOptions)) || "").filter(function (o) { return o.value && !/select/i.test(o.text); });
    admPhysBranch = (physCount > 0 && physReal.length) ? physReal[0].value : "";
    admRenderCourses();
    await admOnBranch();
  }
  async function admOnBranch() {
    if (!admLoaded || !$("admBranch").value) return;
    const ca = await admPost("/Student/Admission/GetCampusByProgramSessionAndBranch", { branchId: $("admBranch").value, campusId: 0, programId: $("admProgram").value, sessionId: $("admSession").value, versionStudy: admVersion, gender: $("admGender").value });
    const opts = admOpts((ca && (ca.CampusOptions || ca.campusOptions)) || (typeof ca === "string" ? ca : ""));
    admFill("admCampus", opts, null, null);
    if (!opts.length) admOutLine("⚠ Campus খালি — resp: " + String(typeof ca === "string" ? ca : JSON.stringify(ca)).slice(0, 200));
  }
  function admRenderCourses() {
    const box = $("admCourseBox"); if (!box) return;
    admBatchOf = {};
    const courses = admCourses(admCourseView);
    if (!courses.length) {
      box.innerHTML = '<span class="hint" style="margin:0">' + t("adm_no_courses") + "</span>";
      admOutLine("⚠ courses খালি — view(" + String(admCourseView || "").length + "): " + String(admCourseView || "(empty)").replace(/[<>]/g, function (c) { return c === "<" ? "‹" : "›"; }).slice(0, 400));
      return;
    }
    box.innerHTML = "";
    courses.forEach(function (c) {
      const row = document.createElement("div"); row.className = "admcrow";
      row.innerHTML = '<label><input type="checkbox" class="admc-cb" data-cid="' + c.id + '"><span>' + (c.name || c.id).replace(/</g, "&lt;") + '</span></label>' +
        '<span class="admc-batch"></span>';
      const cb = row.querySelector(".admc-cb"); cb.__course = c;
      cb.addEventListener("change", function () { admCourseCheck(cb); });
      box.appendChild(row);
      // no auto-tick: ticking fetches the batch cascade, so leaving it off keeps Fetch Data fast
    });
  }
  /* the Amount box shows the sum of the ticked courses' minimum payment (data-officeminpayment) */
  function admUpdateAmount() {
    if (!$("admAmount")) return;
    let sum = 0;
    Array.prototype.forEach.call(document.querySelectorAll("#admCourseBox .admc-cb"), function (cb) {
      if (cb.checked && cb.__course) sum += (cb.__course.minPay || 0);
    });
    $("admAmount").value = sum > 0 ? sum : "";
  }
  /* Batch cascade for one course. GetBatchDay returns, per course, { CourseId, Days[], Times[],
     BatchNames:[{BatchId, RemainingCapacity, NameWithRemainingCapacity}] }. When there is a single
     day+time the BatchNames (with BatchId) are already there; otherwise pick a day → GetBatchTime
     (which itself returns Batch[] when the time is single) → GetBatch. Prefer a batch with capacity. */
  function admPickBatch(batches) {
    if (!batches || !batches.length) return null;
    const withCap = batches.find(function (b) { return (parseInt(b.RemainingCapacity, 10) || 0) > 0; });
    return withCap || batches[0];
  }
  function admBatchName(b) { return (b && (b.NameWithRemainingCapacity || b.BatchName || b.Name || b.Text)) || ""; }
  /* resolves the batch for a course and returns {batchId, day, time, name} so the row can show it */
  async function admGetBatchId(p, courseId) {
    const bd = await admPost("/Student/Admission/GetBatchDayByProgramSessionBranchAndCampus", Object.assign({}, p, { courseIds: [courseId] }));
    const days = (bd && bd.BatchDays) || [];
    const entry = days.find(function (v) { return String(v.CourseId) === String(courseId); }) || days[0];
    if (!entry) return null;
    const day = (entry.Days && entry.Days[0]) || "";
    if (entry.BatchNames && entry.BatchNames.length) {
      const b = admPickBatch(entry.BatchNames);
      if (b && b.BatchId) return { batchId: String(b.BatchId), day: day, time: (entry.Times && entry.Times[0]) || "", name: admBatchName(b) };
    }
    if (!day) return null;
    const bt = await admPost("/Student/Admission/GetBatchTimeByProgramSessionBranchCampusAndBatchDay", Object.assign({}, p, { batchDay: day, courseId: courseId }));
    const time = (bt && bt.BatchTime && bt.BatchTime[0]) || (entry.Times && entry.Times[0]) || "";
    if (bt && bt.Batch && bt.Batch.length) {
      const b = admPickBatch(bt.Batch);
      if (b && b.BatchId) return { batchId: String(b.BatchId), day: day, time: time, name: admBatchName(b) };
    }
    if (!time) return null;
    const bb = await admPost("/Student/Admission/GetBatchByProgramSessionBranchCampusAndBatchDayTime", Object.assign({}, p, { batchDay: day, batchTime: time, courseId: courseId }));
    const b = admPickBatch(bb && bb.Batch);
    if (b && b.BatchId) return { batchId: String(b.BatchId), day: day, time: time, name: admBatchName(b) };
    return null;
  }
  function admShowBatch(cb, info) {
    const row = cb.closest && cb.closest(".admcrow"); if (!row) return;
    const el = row.querySelector(".admc-batch"); if (!el) return;
    el.textContent = info ? [info.day, info.time, info.name].filter(Boolean).join(" · ") : "";
  }
  async function admCourseCheck(cb) {
    const c = cb.__course;
    if (!cb.checked) { delete admBatchOf[c.id]; admShowBatch(cb, null); admUpdateAmount(); return; }
    const p = { programId: $("admProgram").value, sessionId: $("admSession").value, branchId: $("admBranch").value, campusId: $("admCampus").value, versionStudy: admVersion, gender: $("admGender").value };
    admShowBatch(cb, { name: "…" });
    try {
      const info = await admGetBatchId(p, c.id);
      if (!info || !info.batchId) throw new Error("no batch");
      admBatchOf[c.id] = { batchId: info.batchId, course: c, day: info.day, time: info.time, name: info.name };
      admShowBatch(cb, info);
    } catch (e) { cb.checked = false; delete admBatchOf[c.id]; admShowBatch(cb, null); admOutLine("  ⚠ " + (c.name || c.id) + ": এই শাখায় batch নেই"); }
    admUpdateAmount();
  }
  async function admResolveInstitute() {
    const q = (($("admInst") && $("admInst").value) || "").trim();
    if (!q) return { name: "", id: "" };
    /* the "[108258]" in the display name is the EIIN, not the internal id — GetInstituteList maps a
       name to its real id (Value). Query on the name alone (bracket stripped) for a clean match. */
    const query = q.replace(/\s*\[[^\]]*\]\s*$/, "").trim() || q;
    try {
      const r = await admPost("/Administration/CommonAjax/GetInstituteList", { query: query });
      const list = (r && r.returnList) || [];
      const hit = list.find(function (x) { return (x.Text || "").toLowerCase() === q.toLowerCase(); })
        || list.find(function (x) { return (x.Text || "").toLowerCase().indexOf(query.toLowerCase()) >= 0; })
        || list[0];
      if (hit) return { name: hit.Text, id: hit.Value };
    } catch (e) {}
    return { name: q, id: "" };
  }
  /* every field StudentPaymentModel() carries, defaulted — CalculateCourseFee 500s if StudentPayment
     is missing or partial, and the fee call in the real form always sends a full (zeroed) one */
  function admDefaultPayment() {
    return { OfferedDiscount: 0, NetReceivable: 0, CashBackAmount: 0, ConsiderationAmount: 0,
      CourseFees: 0, CourseFee: 0, DiscountAmount: 0, DueAmount: 0, NextReceivedDate: "",
      PayableAmount: 0, PaymentMethod: 0, PaymentType: 0, ReceiptNo: "", ReceivedAmount: 0,
      ReceivableAmount: 0, ReceivedDate: "", ReferrerId: 0, ReferrerNameId: "", DiscountApprovedBy: "",
      SpDiscountAmount: 0, Remarks: "", SpReferenceNote: "", PreviousStudentDiscountAmount: 0,
      BookingDiscountAmount: 0, OfferedDiscountViewModels: [], PreviousStudentDiscountViewModels: [],
      SpecialDiscountViewModels: [] };
  }
  /* true when any ticked course is flagged data-isacademicgroup — such a course also makes the
     Academic Group required (mirrors the form's ShowMBBSStatusAndAcademicGroup) */
  function admAnyAcademicTicked() {
    return Object.keys(admBatchOf).some(function (cid) { return admBatchOf[cid].course && admBatchOf[cid].course.isAcademic; });
  }
  function admBuildStudent(sel, name) {
    const courseVMs = Object.keys(admBatchOf).map(function (cid) {
      const b = admBatchOf[cid], c = b.course;
      /* course-level BranchId/CampusId carry the student's branch/campus — the per-course
         .branch-course-<id> / .campus-course-<id> selects default to them, and the fee endpoint needs
         them to find the branch-specific fee (with 0 it returns TotalCourseFee 0). */
      return { Id: c.id, Name: c.name, ProgramId: c.programId || sel.program, SessionId: c.sessionId || sel.session,
        BranchId: parseInt(sel.branch, 10) || 0, CampusId: parseInt(sel.campus, 10) || 0, AttachedPhysicalBranchId: 0,
        Batch: 0, BatchId: b.batchId, IsTaken: true, maxSubject: c.maxSubject, OfficeMinSub: c.officeMinSub,
        PublicMinSubject: 0, OfficeMinPayment: 0, PublicMinPayment: 0,   // stays 0 like the real form (server computes the fee)
        IsOfficeCompulsary: c.isOfficeCompulsary, IsPublicCompulsary: false, IsComplementaryCourse: false,
        IsFromShowOnOtherProgram: c.isFromOther,
        SubjectViewModels: admPickSubjects(c.subjects || [], parseInt(c.officeMinSub, 10) || 0, parseInt(c.maxSubject, 10) || 0) };
    });
    return { Id: 0, Name: name, MobNumber: sel.mobile, Program: sel.program, Session: sel.session, Branch: sel.branch,
      AttachedPhysicalBranch: admPhysBranch, Campus: sel.campus, VersionOfStudy: admVersion, Gender: sel.gender, Religion: sel.religion,
      Email: "", LastInstituteName: sel.instName, LastInstituteId: sel.instId, CourseViewModels: courseVMs,
      /* medical programs show a "2nd Timer Status" (MbbsBdsStatus) radio; the working form has its first
         option (value "10") selected. null 500s the fee endpoint on those programs. AcademicGroup is
         required (Science=10 default) when the program opts in or a ticked course is academic-group. */
      StudentPayment: admDefaultPayment(), MbbsBdsStatus: "10",
      AcademicGroup: (admShowAcademic || admAnyAcademicTicked()) ? "10" : null };
  }
  /* the course ids currently ticked in our UI (browser mode lets the form pick each one's batch) */
  function admTickedCourseIds() {
    return Array.prototype.filter.call(document.querySelectorAll("#admCourseBox .admc-cb"), function (cb) { return cb.checked; })
      .map(function (cb) { return cb.__course && cb.__course.id; }).filter(Boolean);
  }
  /* Browser mode: drive the real admission form in a tab (background.js does the tab + injection);
     read each payment id off the receipt URL and reuse the receipt decode for Reg/Roll */
  async function admRunBrowser(mobile) {
    const inst = await admResolveInstitute();
    const courseIds = admTickedCourseIds();
    const base = { base: admBaseUrl(), program: $("admProgram").value, session: $("admSession").value,
      gender: $("admGender").value, religion: $("admReligion").value, version: admVersion,
      branch: $("admBranch").value, campus: $("admCampus").value, physBranch: admPhysBranch,
      instName: inst.name, instId: inst.id, courseIds: courseIds, mobile: mobile,
      received: ($("admAmount").value || "").trim() };
    const count = admCount();
    admOutLine("→ " + count + " admission · 🖥 ব্রাউজারে · একজন একজন");
    const t0 = Date.now(); let ok = 0, fail = 0;
    for (let i = 0; i < count && !admStopFlag; i++) {
      const n = i + 1;
      try {
        const params = Object.assign({}, base, { name: admName() });
        const r = await new Promise(function (resolve) { chrome.runtime.sendMessage({ type: "admBrowser", params: params }, function (resp) { resolve(resp || { ok: false, message: chrome.runtime.lastError ? chrome.runtime.lastError.message : "সাড়া নেই" }); }); });
        if (!r || !r.ok) throw new Error((r && r.message) || "ব্যর্থ");
        let branch = "", mrNo = "", regNo = "", roll = "";
        try {
          const rtxt = r.payId ? await admReceiptText(r.payId) : "";
          const g = function (re) { const m = rtxt.match(re); return m ? m[1].trim() : ""; };
          regNo = g(/Registration\s*(?:Number|No\.?)?\s*[:\-]?\s*(\d{4,})/i);
          roll = g(/Roll\s*(?:Number|No\.?)?\s*[:\-]?\s*(\d{4,})/i);
          branch = g(/Branch\s*[:\-]?\s*([A-Za-z][A-Za-z .]+?)\s*(?:\d|$)/i);
          mrNo = g(/Money\s*Receipt[^#]*#\s*(\d+)/i);
        } catch (e) {}
        ok++;
        const parts = ["✓ #" + n + "/" + count, params.name];
        if (regNo) parts.push(t("adm_r_reg") + " " + regNo);
        if (roll) parts.push(t("adm_r_roll") + " " + roll);
        if (branch) parts.push(branch);
        if (mrNo) parts.push(t("adm_r_mr") + " #" + mrNo);
        if (r.payId) parts.push(t("adm_r_id") + " " + r.payId);
        admOutLine("  " + parts.join(" · "));
      } catch (e) { fail++; admOutLine("  ✗ #" + n + "/" + count + " — " + ((e && e.message) || e)); }
    }
    admOutLine("── " + ok + " ok · " + fail + " failed of " + (ok + fail) + " · " + ((Date.now() - t0) / 1000).toFixed(1) + "s" + (admStopFlag ? " (stopped)" : ""));
  }
  async function admRun() {
    if (admBusyFlag) return;
    if (!admLoaded) { admOutLine(t("adm_need_load")); return; }
    const mobile = ($("admMobile").value || "").trim();
    if (!mobile) { admOutLine(t("adm_need_mobile")); return; }
    if (!admTickedCourseIds().length) { admOutLine(t("adm_need_course")); return; }
    if (admBrowserMode) { admStopFlag = false; admBusy(true); const out = $("admOut"); if (out) { out.style.display = ""; out.textContent = ""; } try { await admRunBrowser(mobile); } catch (e) { admOutLine("⚠ " + ((e && e.message) || e)); } admBusy(false); return; }
    if (!Object.keys(admBatchOf).length) { admOutLine(t("adm_need_course")); return; }
    admStopFlag = false; admBusy(true);
    const out = $("admOut"); if (out) { out.style.display = ""; out.textContent = ""; }
    try {
      const inst = await admResolveInstitute();
      const discount = parseInt("0" + ((($("admDiscount") && $("admDiscount").value) || "").trim()), 10) || 0;
      /* one special-discount total → the server checks it equals the sum of the course-wise entries,
         so put the whole amount on the first ticked course; a discount needs an approver id */
      let approver = { name: "", id: "" };
      if (discount > 0) { approver = await admResolveApprover(); if (!approver.id) throw new Error(t("adm_need_appr")); }
      const cids = Object.keys(admBatchOf);
      const discOf = {};
      if (discount > 0 && cids.length) discOf[cids[0]] = discount;
      const sel = { program: $("admProgram").value, session: $("admSession").value, branch: $("admBranch").value,
        campus: $("admCampus").value, gender: $("admGender").value, religion: $("admReligion").value,
        mobile: mobile, instName: inst.name, instId: inst.id, approverId: approver.id };
      const amount = ($("admAmount").value || "").trim();
      const intOf = function (v) { return parseInt("0" + v, 10) || 0; };

      const feeVM = admBuildStudent(sel, admName());
      const totalSpDiscount = Object.keys(discOf).reduce(function (s, k) { return s + (discOf[k] || 0); }, 0);
      const feeJson = JSON.stringify(feeVM);
      const fee = await admPost("/Student/Admission/CalculateCourseFee", { format: "json", studentViewModelJson: feeJson, previousStudentId: 0, bookingId: 0 });
      if (fee && fee.IsSuccess === false) throw new Error("[fee] " + (Array.isArray(fee.Message) ? (fee.Message[0] && fee.Message[0].ErrorMessage) : fee.Message));
      const net = intOf(fee && fee.NetReceivableAmount), totalFee = intOf(fee && fee.TotalCourseFee), receivable = intOf(fee && fee.ReceivableAmount);
      if (!net) admOutLine("  ⚠ fee net=0 — " + (fee && typeof fee === "object" ? "keys: " + Object.keys(fee).join(",") + " · " + JSON.stringify(fee).slice(0, 300) : String(fee).slice(0, 300)));
      const netAfter = Math.max(0, net - totalSpDiscount);
      let received = (amount !== "") ? Math.min(parseInt(amount, 10) || 0, netAfter) : netAfter; if (received < 0) received = 0;
      const specialDiscounts = Object.keys(discOf).filter(function (k) { return discOf[k] > 0; }).map(function (k) { return { CourseId: k, DiscountAmount: discOf[k] }; });
      const d = new Date(); d.setDate(d.getDate() + 2);
      const nextDate = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");   // YYYY-MM-DD, as the form's date field uses
      const payment = Object.assign(admDefaultPayment(), { CourseFee: totalFee, CourseFees: totalFee,
        OfferedDiscount: intOf(fee && fee.OfferedDiscount), OfferedDiscountViewModels: [],
        PreviousStudentDiscountAmount: intOf(fee && fee.PreviousStudentDiscount), PreviousStudentDiscountViewModels: [],
        SpDiscountAmount: totalSpDiscount, SpecialDiscountViewModels: specialDiscounts, ReceivableAmount: receivable,
        BookingDiscountAmount: intOf(fee && fee.BookingDiscount), NetReceivable: netAfter, ReceivedAmount: received,
        DueAmount: netAfter - received, ReferrerId: 0, ReferrerNameId: "", Remarks: "",
        DiscountApprovedBy: (totalSpDiscount > 0 ? sel.approverId : ""), SpReferenceNote: "", PaymentMethod: admPayMethod, NextReceivedDate: nextDate });

      const count = admCount(), pool = admMode === "parallel" ? admPool() : 1;
      admOutLine("→ " + count + " admission · " + (admMode === "parallel" ? pool + " একসাথে" : "একজন একজন") + " · net ৳" + netAfter + " · paying ৳" + received);
      const t0 = Date.now(); let next = 0, ok = 0, fail = 0;
      async function worker() {
        while (!admStopFlag) {
          const i = next++; if (i >= count) break; const n = i + 1;
          try {
            const vm = admBuildStudent(sel, admName()); vm.StudentPayment = payment;
            /* the real "Submit" posts to NewStudentAdmission with {studentObj, boardInfos}; it answers
               {IsSuccess, AdditionalValue:"<paymentId,paymentId>"} and the receipt is fetched from
               GenerateCoursewiseMoneyReciept?studentPaymentIdList=… (boardInfos "[]" = no board rows) */
            const boardInfos = JSON.stringify(admBoardRows || []);
            const reg = await admPost("/Student/Admission/NewStudentAdmission", { studentObj: JSON.stringify(vm), boardInfos: boardInfos });
            if (!reg || reg.IsSuccess !== true) {
              const rm = reg && (Array.isArray(reg.Message)
                ? reg.Message.map(function (x) { return x && (x.ErrorMessage || x.Message || x); }).join("; ")
                : (reg.ErrorMessage || reg.Message));
              throw new Error(rm || ("no success — " + String(typeof reg === "string" ? reg : JSON.stringify(reg)).slice(0, 300)));
            }
            /* success answers {IsSuccess, PaymentId}; Reg No / Roll / Money-Receipt no. come from the
               receipt PDF, while paid/due are the amounts we already computed (reliable) */
            const payId = String(reg.PaymentId || reg.AdditionalValue || reg.additionalValue || "").split(",")[0].trim();
            let branch = "", mrNo = "", regNo = "", roll = "";
            try {
              const rtxt = payId ? await admReceiptText(payId) : "";
              const g = function (re) { const m = rtxt.match(re); return m ? m[1].trim() : ""; };
              regNo = g(/Registration\s*(?:Number|No\.?)?\s*[:\-]?\s*(\d{4,})/i);
              roll = g(/Roll\s*(?:Number|No\.?)?\s*[:\-]?\s*(\d{4,})/i);
              branch = g(/Branch\s*[:\-]?\s*([A-Za-z][A-Za-z .]+?)\s*(?:\d|$)/i);
              mrNo = g(/Money\s*Receipt[^#]*#\s*(\d+)/i);
            } catch (e) {}
            ok++;
            const money = function (v) { return "৳" + Number(v).toLocaleString("en-US"); };
            const parts = ["✓ #" + n + "/" + count, vm.Name];
            if (regNo) parts.push(t("adm_r_reg") + " " + regNo);
            if (roll) parts.push(t("adm_r_roll") + " " + roll);
            if (branch) parts.push(branch);
            if (mrNo) parts.push(t("adm_r_mr") + " #" + mrNo);
            parts.push(t("adm_r_id") + " " + payId);
            parts.push(t("adm_r_paid") + " " + money(received));
            if (netAfter - received > 0) parts.push(t("adm_r_due") + " " + money(netAfter - received));
            admOutLine("  " + parts.join(" · "));
          } catch (e) { fail++; admOutLine("  ✗ #" + n + "/" + count + " — " + ((e && e.message) || e)); }
        }
      }
      await Promise.all(Array.from({ length: Math.min(pool, count) }, function () { return worker(); }));
      const secs = (Date.now() - t0) / 1000;
      admOutLine("── " + ok + " ok · " + fail + " failed of " + (ok + fail) + " · " + secs.toFixed(1) + "s" + (admStopFlag ? " (stopped)" : ""));
    } catch (e) { admOutLine("⚠ " + ((e && e.message) || e)); }
    admBusy(false);
  }
  let admMode = "sequential";
  let admBrowserMode = false;
  function admSetRunMode(browser) {
    admBrowserMode = !!browser;
    if ($("admBrowserBtn")) $("admBrowserBtn").classList.toggle("on", admBrowserMode);
    if ($("admHttp")) $("admHttp").classList.toggle("on", !admBrowserMode);
  }
  function admSetMode(m) {
    admMode = m === "parallel" ? "parallel" : "sequential";
    const par = admMode === "parallel";
    if ($("admPar")) $("admPar").classList.toggle("on", par);
    if ($("admSeq")) $("admSeq").classList.toggle("on", !par);
    if ($("admPoolWrap")) $("admPoolWrap").style.display = par ? "inline-flex" : "none";
  }
  function admStop() { admStopFlag = true; admOutLine("⏹ থামানো হচ্ছে…"); }
  let admInstTimer = null;
  let admApprTimer = null;
  async function admInstSearch() {
    const q = (($("admInst") && $("admInst").value) || "").trim(); if (q.length < 2) return;
    try {
      const r = await admPost("/Administration/CommonAjax/GetInstituteList", { query: q });
      const dl = $("admInstDl"); if (dl) dl.innerHTML = ((r && r.returnList) || []).slice(0, 20).map(function (x) { return '<option value="' + (x.Text || "").replace(/"/g, "&quot;") + '">'; }).join("");
    } catch (e) {}
  }
  /* the discount approver — one field like Institute: the datalist shows names, and at run time we
     re-query GetDiscountApprovedBy to turn the typed name back into its id (Value) */
  async function admResolveApprover() {
    const q = (($("admApprover") && $("admApprover").value) || "").trim();
    if (!q) return { name: "", id: "" };
    try {
      const r = await admPost("/Student/Admission/GetDiscountApprovedBy", { query: q });
      const list = (r && r.returnList) || [];
      const hit = list.find(function (x) { return (x.Text || "").toLowerCase() === q.toLowerCase(); })
        || list.find(function (x) { return (x.Text || "").toLowerCase().indexOf(q.toLowerCase()) >= 0; })
        || list[0];
      if (hit) return { name: hit.Text, id: hit.Value };
    } catch (e) {}
    return { name: q, id: "" };
  }
  async function admApprSearch() {
    const q = (($("admApprover") && $("admApprover").value) || "").trim(); if (q.length < 2) return;
    try {
      const r = await admPost("/Student/Admission/GetDiscountApprovedBy", { query: q });
      const dl = $("admApprDl"); if (dl) dl.innerHTML = ((r && r.returnList) || []).slice(0, 20).map(function (x) { return '<option value="' + (x.Text || "").replace(/"/g, "&quot;") + '">'; }).join("");
    } catch (e) {}
  }
  function admOnShow() {
    const b = $("admBase"); if (b && !b.value) b.value = "https://ums-4.osl.team";
    admTestConn();
  }

  function showPage(p) {
    page = (p === "crm" || p === "adm") ? p : "pay";
    const set = function (id, yes) { const e = $(id); if (e) e.classList.toggle("on", yes); };
    set("pgPay", page === "pay"); set("pgCrm", page === "crm"); set("pgAdm", page === "adm");
    set("navPay", page === "pay"); set("navCrm", page === "crm"); set("navAdm", page === "adm");
    /* what is inside CRM is listed only while CRM is the open section */
    set("crmSub", page === "crm");
    if (page === "crm") showCrm(crmTab);
    if (page === "adm") admOnShow();
    /* The subtitle belongs to whichever section is open. Written as a data-i18n key rather than
       as text, so applyLang() keeps it right when the language changes under it. */
    const key = page === "pay" ? "subtitle" : page === "crm" ? "crm_sub" : "adm_sub";
    const sub = $("sub");
    if (sub) { sub.setAttribute("data-i18n", key); sub.textContent = t(key); }
    try { chrome.storage.local.set({ page: page }); } catch (e) {}
    measureTop();      // the subtitle changed, and on a narrow screen that changes the height
  }
  /* Which of CRM's own pages is open. One so far; the shape is here so that the second is a
     button and a div rather than a rearrangement. */
  let crmTab = "dash";
  /* One username,password per line, split the way the tool itself splits them: a comma or a
     tab, else the FIRST space, since a username holds no spaces and the password may. Blank
     lines, # comments and a header row are dropped, so the count matches what will actually
     run. Kept in step with crm-loadtest/loadtest.js readUsers(). */
  /* Excel/Sheets almost always carry a header row (UserName, Password — with any capitalisation,
     an inner space like "User Name", or "Login"/"Pwd"). It is not a login, so it is dropped: at
     import time by crmFillRows so the box never shows it, and here too for pasted text. */
  function crmIsHeader(u, pw) {
    return /^(user\s*(name|id)?|login|email)$/i.test(u) && /^(pass\s*(word)?|pwd)$/i.test(pw);
  }
  function crmParse(text) {
    const out = [];
    String(text || "").split(/\r?\n/).forEach(function (line, i) {
      const t = line.trim();
      if (!t || t.charAt(0) === "#") return;
      let u, pw;
      if (t.indexOf(",") >= 0) { const a = t.split(","); u = a[0]; pw = a.slice(1).join(","); }
      else if (t.indexOf("\t") >= 0) { const a = t.split("\t"); u = a[0]; pw = a.slice(1).join("\t"); }
      else { const at = t.indexOf(" "); if (at < 0) { u = t; pw = ""; } else { u = t.slice(0, at); pw = t.slice(at + 1); } }
      u = u.trim(); pw = pw.trim();
      if (i === 0 && crmIsHeader(u, pw)) return;
      if (u) out.push({ user: u, pass: pw });
    });
    return out;
  }
  /* The command stays ASCII on purpose — it is pasted into a shell, so the count is a Latin
     number even under a Bengali interface, and the base falls back to a visible placeholder so
     the shape is shown before anything is filled in. */
  function crmCommand() {
    const base = ($("crmBase").value || "").trim() || "<base-url>";
    const headed = $("crmHeaded").checked ? " --headed" : "";
    const keep = ($("crmClose") && $("crmClose").checked) ? "" : " --keep-open";
    const max = ($("crmMax") && $("crmMax").checked) ? " --maximize" : "";
    return "node loadtest.js --base " + base + " --users users.txt --count " + crmCount() + headed + max + keep;
  }
  function crmRender() {
    if (!$("crmUsers")) return;
    const pairs = crmParse($("crmUsers").value);
    const badge = $("crmPairs");
    const num = lang === "bn" ? pairs.length.toLocaleString("bn-BD") : String(pairs.length);
    if (badge) badge.textContent = t("crm_pairs").replace("{n}", num);
    if ($("crmDl")) $("crmDl").disabled = pairs.length === 0;
    if ($("crmCmd")) $("crmCmd").textContent = crmCommand();
  }
  /* users.txt, normalised to exactly what the tool reads — its own name, not the export tag. */
  function crmClear() {
    if ($("crmUsers")) $("crmUsers").value = "";
    if ($("crmLink")) $("crmLink").value = "";
    crmSay("");
    crmRender();
    if (typeof crmNextLabel === "function") crmNextLabel();
    if ($("crmUsers")) $("crmUsers").focus();
  }
  function crmDownload() {
    const pairs = crmParse($("crmUsers").value);
    if (!pairs.length) return;
    const body = pairs.map(function (x) { return x.user + "," + x.pass; }).join("\n") + "\n";
    const u = URL.createObjectURL(new Blob([body], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a"); a.href = u; a.download = "users.txt";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(u); }, 1000);
  }
  function crmCopy() {
    const cmd = crmCommand(), btn = $("crmCopy"), was = btn ? btn.textContent : "";
    const done = function () { if (btn) { btn.textContent = t("crm_copied"); setTimeout(function () { btn.textContent = was; }, 1500); } };
    try { navigator.clipboard.writeText(cmd).then(done, function () { legacyCopy(cmd); done(); }); }
    catch (e) { legacyCopy(cmd); done(); }
  }
  function legacyCopy(text) {
    const ta = document.createElement("textarea"); ta.value = text; document.body.appendChild(ta);
    ta.select(); try { document.execCommand("copy"); } catch (e) {} ta.remove();
  }
  /* Excel, a Sheet or a paste all end here: take the first two columns of every row as
     username and password, and write them into the box the paste option already fills — so the
     three ways share one destination and one live count. */
  function crmFillRows(rows) {
    rows = (rows || []).slice();
    if (rows.length && crmIsHeader(String(rows[0][0] == null ? "" : rows[0][0]).trim(),
      String(rows[0][1] == null ? "" : rows[0][1]).trim())) rows.shift();   // drop the column-name row
    const lines = rows.map(function (r) { return String(r[0] == null ? "" : r[0]).trim() + "," + String(r[1] == null ? "" : r[1]).trim(); })
      .filter(function (l) { return l.replace(/,/g, "").trim(); });
    $("crmUsers").value = lines.join("\n");
    crmRender();
  }
  async function crmImportFile(file) {
    try {
      if (/\.xlsx$/i.test(file.name)) { const buf = await file.arrayBuffer(); const x = await readXlsx(buf); crmFillRows(x.rows); }
      else { const txt = await file.text(); crmFillRows(parseCSV(txt)); }
      crmSay("");
    } catch (e) { crmSay(t("imp_excel_fail")); }
  }
  /* The same Google export URL the payment side uses; kept apart so that path stays untouched,
     and the CSV is fed into crmFillRows rather than the reg/spid importer. */
  function crmImportSheet() {
    const link = ($("crmLink").value || "").trim();
    const m = link.match(/\/spreadsheets\/d\/([a-zA-Z0-9\-_]+)/);
    if (!m) { crmSay(t("imp_badlink")); return; }
    const g = link.match(/[#&?]gid=(\d+)/), gid = g ? g[1] : "0";
    const url = "https://docs.google.com/spreadsheets/d/" + m[1] + "/export?format=csv&gid=" + gid;
    crmSay(t("imp_sheet"));
    fetch(url, { credentials: "include" }).then(function (r) { if (!r.ok) throw new Error("HTTP " + r.status); return r.text(); })
      .then(function (txt) {
        if (/^\s*<(!doctype|html)/i.test(txt)) { crmSay(t("imp_login")); return; }
        crmSay(""); crmFillRows(parseCSV(txt));
      }).catch(function (e) { crmSay(t("imp_fail") + " — " + String((e && e.message) || e)); });
  }
  function crmSay(msg) { const e = $("crmNote"); if (e) { e.textContent = msg || ""; e.style.display = msg ? "" : "none"; } }
  /* The button. connectNative spawns the host (install.js registered it); a host that is not
     there disconnects at once with nothing sent, which is how "not installed" is told from a
     real run. Every line the host forwards is a line loadtest.js printed, so the report reads
     exactly as it would in a terminal. */
  /* Parallel opens the Dashboard for everyone at once — the concurrency the test is about.
     Sequential is one login and one visit at a time, which is --count 1 to the tool: a baseline,
     or just a check that the login works. The count only means anything in parallel, so it hides
     in sequential. */
  let crmMode = "parallel";
  function crmSetMode(m) {
    crmMode = m === "sequential" ? "sequential" : "parallel";
    const par = crmMode === "parallel";
    if ($("crmPar")) $("crmPar").classList.toggle("on", par);
    if ($("crmSeq")) $("crmSeq").classList.toggle("on", !par);
    if ($("crmCountWrap")) $("crmCountWrap").style.display = par ? "inline-flex" : "none";
    crmRender();
    if (typeof crmNextLabel === "function") crmNextLabel();
  }
  function crmCount() { return crmMode === "sequential" ? 1 : Math.max(1, parseInt($("crmCount").value, 10) || 1); }
  const CRM_HOST = "com.umsreconciler.crmloadtest";
  let crmPort = null;
  function crmOutLine(s) { const o = $("crmOut"); if (!o) return; o.style.display = ""; o.textContent += (o.textContent ? "\n" : "") + s; o.scrollTop = o.scrollHeight; }
  function crmBusy(on) { const b = $("crmRun"); if (b) { b.disabled = on; b.textContent = t(on ? "crm_running" : "crm_run"); } }
  /* The port is kept open across presses: while the browser is up, pressing Run again sends the
     next message on the same connection, which is how one window can gather user after user.
     crmCursor is where Sequential is up to; Close (or the host going away) resets it. */
  let crmCursor = 0, crmInFlight = false, crmSawMsg = false;
  function crmNextLabel() {
    const el = $("crmNext"); if (!el) return;
    if (crmMode !== "sequential") { el.textContent = ""; return; }
    const users = crmParse($("crmUsers").value);
    if (!users.length) { el.textContent = ""; return; }
    const i = crmCursor % users.length;
    el.textContent = t("crm_next").replace("{u}", users[i].user)
      .replace("{n}", i + 1).replace("{m}", users.length);
  }
  function crmConnect() {
    crmSawMsg = false;
    try { crmPort = chrome.runtime.connectNative(CRM_HOST); }
    catch (e) { crmPort = null; return false; }
    crmPort.onMessage.addListener(function (m) {
      crmSawMsg = true;
      if (m.type === "out") crmOutLine(m.text);
      else if (m.type === "error") crmOutLine("⚠ " + m.text);
      else if (m.type === "done") { crmInFlight = false; crmBusy(false);
        const kept = m.keepOpen;                 // closed after the visit? then there's nothing to stop
        if ($("crmStop")) $("crmStop").disabled = !kept;
        if (!kept) crmCursor = 0;                // browser gone — next Sequential press starts over
        crmNextLabel(); crmOutLine(""); }
    });
    crmPort.onDisconnect.addListener(function () {
      const err = chrome.runtime.lastError, missing = !crmSawMsg;
      crmPort = null; crmInFlight = false; crmCursor = 0; crmBusy(false);
      if ($("crmStop")) $("crmStop").disabled = true;
      if (missing) { crmOutLine(t("crm_host_missing")); if (err && err.message) crmOutLine("(" + err.message + ")"); }
      crmNextLabel();
    });
    return true;
  }
  function crmRun() {
    if (crmInFlight) return;
    const users = crmParse($("crmUsers").value);
    if (!users.length) { crmSay(t("crm_need_users")); return; }
    const base = ($("crmBase").value || "").trim();
    if (!base) { crmSay(t("crm_need_base")); return; }
    crmSay("");
    const fresh = !crmPort;
    if (fresh) { const out = $("crmOut"); if (out) { out.style.display = ""; out.textContent = ""; } crmCursor = 0; }
    if (!crmPort && !crmConnect()) { crmOutLine(t("crm_host_missing")); return; }
    const keepOpen = !($("crmClose") && $("crmClose").checked);
    let batch, count;
    if (crmMode === "sequential") {
      if (crmCursor >= users.length) { crmCursor = 0; crmOutLine(t("crm_next_wrap")); }
      batch = [users[crmCursor]]; count = 1; crmCursor++;
    } else {
      /* "how many at once" = exactly this many parallel visits. If the list is shorter it is
         cycled, so one user with a count of 5 means that same user visits five times at once. */
      const n = crmCount();
      batch = Array.from({ length: n }, function (_, i) { return users[i % users.length]; });
      count = batch.length;
    }
    crmInFlight = true; crmBusy(true);
    if ($("crmStop")) $("crmStop").disabled = false;
    crmPort.postMessage({ base: base, count: count, headed: $("crmHeaded").checked,
      maximize: !!($("crmMax") && $("crmMax").checked), keepOpen: keepOpen, users: batch });
    crmNextLabel();
  }
  function crmStop() {
    if (!crmPort) return;
    try { crmPort.postMessage({ action: "close" }); } catch (e) {}
    try { crmPort.disconnect(); } catch (e) {}
    crmPort = null; crmInFlight = false; crmCursor = 0; crmBusy(false);
    if ($("crmStop")) $("crmStop").disabled = true;
    crmOutLine("\n" + t("crm_closed")); crmNextLabel();
  }

  function showCrm(tab) {
    crmTab = tab === "dash" ? "dash" : "dash";
    const set = function (id, yes) { const e = $(id); if (e) e.classList.toggle("on", yes); };
    set("crmDash", crmTab === "dash");
    set("navCrmDash", crmTab === "dash");
    /* a convenience only — the Payment History address is usually the one under test too */
    const cb = $("crmBase"); if (cb && !cb.value && baseUrl) { cb.value = baseUrl; }
    crmRender();
    crmTestConn();
  }

  /* A reachability check for the CRM base — not a login check. The run logs in with the given
     username/password through the host, so whether *this browser* happens to hold a CRM session is
     both irrelevant and unreliable to read (it came back signed-out on a first visit yet signed-in
     after a reload). All that matters before pressing Run is that the address answers: fetch the
     Dashboard and, if the server responds at all (the page, or a redirect to its login), the address
     is good; only a network/DNS/permission failure — nothing came back — means it is wrong. */
  let crmConnSeq = 0, crmConnTimer = null, crmConnState = null;
  function crmSetConn(state) {
    crmConnState = state || null;
    const el = $("crmConn"); if (!el) return;
    el.className = "crmconn" + (state ? " " + state : "");
    el.textContent = state === "busy" ? t("checking")
      : state === "ok" ? t("crm_reach_ok") : state === "no" ? t("crm_reach_no")
      : t("conn_unchecked");
  }
  async function crmTestConn() {
    const base = (($("crmBase") && $("crmBase").value) || "").trim();
    if (!base) { crmSetConn(null); return; }
    const mine = ++crmConnSeq;
    crmSetConn("busy");
    let ok = false;
    try {
      const r = await fetchHtml(base.replace(/\/+$/, "") + "/Student/CrmConversation/Dashboard");
      ok = !!(r && r.status);                          // any HTTP answer means the server is there
    } catch (e) { ok = false; }
    if (mine === crmConnSeq) crmSetConn(ok ? "ok" : "no");   // ignore a check the user has outrun
  }
  function crmConnDebounced() {
    if (crmConnTimer) clearTimeout(crmConnTimer);
    crmConnTimer = setTimeout(crmTestConn, 700);
  }

  /* …and the menu says whether the other section is busy, since leaving it running is the whole
     point of keeping both in one page */
  function paintBusy() {
    const b = $("navPay"); if (b) b.classList.toggle("running", !!run);
  }

  // ---------- wire ----------
  /* toggle, not assign: body also carries .srv, which says the tiles are counting a different set
     of things, and an outright assignment threw that away every time the theme was switched. */
  function applyTheme(t) {
    document.body.classList.toggle("light", t === "light");
    /* The page's own scrollbar belongs to the ROOT element, and the theme class is on <body> — so
       the CSS rule above reaches every box inside the page but not the one down the side of it.
       This does. */
    try { document.documentElement.style.colorScheme = (t === "light" ? "light" : "dark"); } catch (e) {}
    const b = $("theme"); if (b) b.textContent = (t === "light" ? "🌙 Dark" : "☀ Light");
  }
  function wire() {
    try { const v = chrome.runtime.getManifest().version; const el = $("ver"); if (el) el.textContent = "v" + v; } catch (e) {}
    $("base").value = baseUrl; $("conc").value = conc; $("tol").value = tol;
    $("base").addEventListener("input", function () { baseUrl = this.value.trim() || "https://ums-5.osl.team"; });
    if ($("base2")) {
      $("base2").value = baseUrl2;
      $("base2").addEventListener("input", function () { baseUrl2 = this.value.trim() || "https://ums-41.osl.team"; });
    }
    if ($("srvSw")) {
      $("srvSw").checked = srvMode;
      $("srvSw").addEventListener("change", function () { setSrvMode(this.checked); testConn(); });
    }
    applySrvMode();
    /* Painted from the settings that are already loaded, not from the folder handle: the handle
       arrives later, or never (IndexedDB can be unavailable), and until it did the switch read OFF
       while saving was on — so the run wrote files the page said it would not. All the handle adds
       is the folder name. */
    paintSaveRow();
    $("conc").addEventListener("input", function () { let v = parseInt(this.value, 10); if (isNaN(v)) return; conc = Math.max(1, Math.min(300, v)); if (v !== conc) this.value = conc; paintConc(); try { chrome.storage.local.set({ appConc: conc }); } catch (e) {} });
    $("tol").addEventListener("input", function () { const v = parseFloat(this.value); tol = isNaN(v) ? 0 : Math.max(0, v); try { chrome.storage.local.set({ appTol: tol }); } catch (e) {} });
    /* "Carry on" is a run starting, and every reason Start has to ask for the folder first
       applies here twice over: a resumed run is one whose page was closed, which is exactly when
       the write permission was lost. Without this the recovered run — the one that cost hours —
       is the one that quietly saves itself to Downloads instead of the chosen folder. */
    $("ckGo").addEventListener("click", async function () { await claimDir(); ckResume(); });
    $("ckDrop").addEventListener("click", function () {
      const g = ckFound; ckBar(null); if (g) ckWipe(g.sig);
    });
    $("theme").addEventListener("click", function () { const th = document.body.classList.contains("light") ? "dark" : "light"; applyTheme(th); try { chrome.storage.local.set({ theme: th }); } catch (e) {} });
    $("lang").addEventListener("click", function () { const l = (lang === "bn" ? "en" : "bn"); applyLang(l); try { chrome.storage.local.set({ lang: l }); } catch (e) {} });
    // Clear empties the whole "What to Reconciliation" card — paste box, sheet link, the chosen
    // file, the preview and its search — so the next import starts from nothing.
    $("clearImp").addEventListener("click", function () {
      entries = []; importSrc = srcBase = "";
      clearSheetPicker();
      ["paste", "link", "pvSearch", "file"].forEach(function (id) {
        const el = $(id); if (el) el.value = "";
      });
      const pv = $("preview"); if (pv) { pv.innerHTML = ""; pv.removeAttribute("data-col"); }
      renderPreview(); updateCount();
      $("impNote").textContent = "";
    });
    $("testConn").addEventListener("click", testConn);
    $("saveCfg").addEventListener("click", saveCfg);
    /* not startRun directly: a click handler is handed the MouseEvent, and startRun's first
       argument means "this is a resumed run" — an event object is a truthy one. */
    $("run").addEventListener("click", startPressed);
    measureTop();
    window.addEventListener("resize", measureTop);
    $("navPay").addEventListener("click", function () { showPage("pay"); });
    $("navCrm").addEventListener("click", function () { showPage("crm"); });
    $("navCrmDash").addEventListener("click", function () { showPage("crm"); showCrm("dash"); });
    if ($("navAdm")) $("navAdm").addEventListener("click", function () { showPage("adm"); });
    if ($("admRun")) $("admRun").addEventListener("click", admRun);
    if ($("admStop")) $("admStop").addEventListener("click", admStop);
    if ($("admSeq")) $("admSeq").addEventListener("click", function () { admSetMode("sequential"); });
    if ($("admPar")) $("admPar").addEventListener("click", function () { admSetMode("parallel"); });
    if ($("admHttp")) $("admHttp").addEventListener("click", function () { admSetRunMode(false); });
    if ($("admBrowserBtn")) $("admBrowserBtn").addEventListener("click", function () { admSetRunMode(true); });
    if ($("admLoad")) $("admLoad").addEventListener("click", admLoadForm);
    if ($("admProgram")) $("admProgram").addEventListener("change", admOnProgram);
    if ($("admSession")) $("admSession").addEventListener("change", admOnSession);
    if ($("admBranch")) $("admBranch").addEventListener("change", admOnBranch);
    if ($("admGender")) $("admGender").addEventListener("change", function () { if (admLoaded) admOnSession(); });   // branch depends on gender
    if ($("admInst")) $("admInst").addEventListener("input", function () { if (admInstTimer) clearTimeout(admInstTimer); admInstTimer = setTimeout(admInstSearch, 350); });
    if ($("admApprover")) $("admApprover").addEventListener("input", function () { if (admApprTimer) clearTimeout(admApprTimer); admApprTimer = setTimeout(admApprSearch, 350); });
    admSetMode("sequential");
    if ($("admBase")) $("admBase").addEventListener("input", function () { try { chrome.storage.local.set({ admBase: this.value }); } catch (e) {} admConnDebounced(); });
    ["crmBase", "crmCount", "crmUsers"].forEach(function (id) { const e = $(id); if (e) e.addEventListener("input", crmRender); });
    if ($("crmBase")) $("crmBase").addEventListener("input", function () { try { chrome.storage.local.set({ crmBase: this.value }); } catch (e) {} crmConnDebounced(); });
    if ($("crmUsers")) $("crmUsers").addEventListener("input", crmNextLabel);
    if ($("crmHeaded")) $("crmHeaded").addEventListener("change", crmRender);
    if ($("crmClose")) $("crmClose").addEventListener("change", crmRender);
    if ($("crmMax")) $("crmMax").addEventListener("change", crmRender);
    if ($("crmFile")) $("crmFile").addEventListener("change", function (ev) { const f = ev.target.files && ev.target.files[0]; if (f) crmImportFile(f); ev.target.value = ""; });
    if ($("crmLinkBtn")) $("crmLinkBtn").addEventListener("click", crmImportSheet);
    if ($("crmLink")) $("crmLink").addEventListener("keydown", function (e) { if (e.key === "Enter") crmImportSheet(); });
    if ($("crmDl")) $("crmDl").addEventListener("click", crmDownload);
    if ($("crmClear")) $("crmClear").addEventListener("click", crmClear);
    if ($("crmRun")) $("crmRun").addEventListener("click", crmRun);
    if ($("crmStop")) $("crmStop").addEventListener("click", crmStop);
    if ($("crmPar")) $("crmPar").addEventListener("click", function () { crmSetMode("parallel"); });
    if ($("crmSeq")) $("crmSeq").addEventListener("click", function () { crmSetMode("sequential"); });
    crmSetMode(crmMode);
    if ($("crmCopy")) $("crmCopy").addEventListener("click", crmCopy);
    crmRender();
    $("stop").addEventListener("click", function () { if (run) { run.stop = true; run.paused = false; if (run.ac) try { run.ac.abort(); } catch (e) {} } this.disabled = true; $("pause").disabled = true; $("prog").textContent = t("stopping"); });
    $("pause").addEventListener("click", function () { if (!run) return; run.paused = !run.paused; this.textContent = run.paused ? t("resume") : t("pause"); });
    if ($("saveSw")) $("saveSw").addEventListener("change", function () {
      saveOnFinish = this.checked;
      try { chrome.storage.local.set({ saveOnFinish: saveOnFinish }); } catch (e) {}
      paintSaveRow();
      /* Asking for the folder the moment it is switched on: this is the click, and at the end of
         the run there will not be another one. */
      if (saveOnFinish && !dirHandle) pickDir();
    });
    if ($("pickDir")) $("pickDir").addEventListener("click", pickDir);
    $("html").addEventListener("click", exportHtml);
    $("xlsx").addEventListener("click", exportXlsx);
    $("raw").addEventListener("click", exportRaw);
    $("file").addEventListener("change", function (ev) { const f = ev.target.files && ev.target.files[0]; if (f) onImport(f); });
    /* Changing tab re-imports from the same file, so column detection, the swap probe, the
       de-duplication and the preview all run again — a different tab is a different sheet. */
    if ($("sheetSel")) $("sheetSel").addEventListener("change", function () { if (xlsxFile) loadXlsx(xlsxFile, this.value); });
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
    clearSheetPicker();
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
      clearSheetPicker();
      if (nm && cut > 0) setSource("↧ " + nm.slice(0, cut), nm.slice(cut + 3));
      else setSource("↧ " + (nm || t("src_link")), nm ? "" : "gid " + gid);
      applyImported(parseCSV(txt));
    }).catch(function (e) {
      $("impNote").textContent = t("imp_fail") + " — " + String((e && e.message) || e);
    });
  }

  try { chrome.storage.local.get(["baseUrl", "baseUrl2", "srvMode", "appConc", "appTol", "tolMigrated", "theme", "lang", "manualOk", "saveOnFinish", "saveDirName", "page", "crmBase", "admBase"], function (o) { if (o.manualOk) manualOk = o.manualOk;
    saveOnFinish = o.saveOnFinish === true; dirName = o.saveDirName || "";
    showPage((o.page === "crm" || o.page === "adm") ? o.page : "pay");
    if (o.crmBase && $("crmBase")) $("crmBase").value = o.crmBase;
    if ($("admBase")) $("admBase").value = o.admBase || "https://ums-4.osl.team";
    admSetConn(null);
    crmSetConn(null);
    /* The handle comes back from IndexedDB, but the permission on it may not have — dirUsable()
       decides that at the end of the run, when it matters. */
    idb(function (st) { return st.get("dir"); }).then(function (h) { if (h) dirHandle = h; paintSaveRow(); }).catch(function () { paintSaveRow(); }); if (o.baseUrl) baseUrl = o.baseUrl; if (o.baseUrl2) baseUrl2 = o.baseUrl2; srvMode = o.srvMode === true; if (o.appConc) conc = o.appConc;
    // 1 was the old default and it hides exactly the ৳1 mismatches — drop it once, keep any other choice
    if (o.appTol != null) { if (o.appTol === 1 && !o.tolMigrated) { tol = 0; try { chrome.storage.local.set({ appTol: 0, tolMigrated: true }); } catch (e) {} } else tol = o.appTol; } wire(); applyTheme(o.theme || "dark"); applyLang(o.lang || "en"); testConn(); ckOffer(); }); }
  catch (e) { wire(); applyTheme("dark"); applyLang("en"); }
})();
