/* UMS Payment Reconciler — in-page panel.
 * Reads the Program Wise / Course Wise table on each page, stores per-receipt
 * (MRN+CRN) column sums, and verifies the two views reconcile.
 * Pure reconcile logic lives in reconcile.js (self.UMSREC).
 */
(function () {
  "use strict";
  const U = self.UMSREC;
  let enabled = true; // capture on/off (persisted in storage as "enabled")
  let minimized = false; // panel ছোট করা আছে কিনা (persisted in storage as "minimized")
  let captureNote = ""; // শেষ চেষ্টায় কেন কিছু পাওয়া যায়নি (স্ট্যাটাসে দেখানো হয়)
  let tol = 0;           // গ্রহণযোগ্য পার্থক্য (৳) — Batch UI-র "appTol"-ই এখানে ব্যবহার হয় (CLI-র মতো ০)

  // canon()/parseNum() are gone — reconcile.js owns column naming and money parsing now.

  function spid() {
    const m = location.search.match(/studentProgramId=(\d+)/);
    return m ? m[1] : "unknown";
  }
  function pageType() {
    if (/HistoyOfPaymentCourseWise/i.test(location.pathname)) return "course";
    if (/HistoryOfPayment/i.test(location.pathname)) return "program";
    return null;
  }
  /* Program Wise has no id to grab, so it is found by its column names. Matching only the first
     <tr> was too brittle: a filter row, a grouped header, or a DataTables split header all push
     the real labels out of row one and the table was silently never found. Score the header
     region instead — thead if present, else the first few rows — and take the best table. */
  // the word list and the scoring live in reconcile.js, so the batch runner scores identically
  function headerText(t) {
    const head = t.querySelector("thead");
    const rows = head ? [...head.querySelectorAll("tr")] : [...t.querySelectorAll("tr")].slice(0, 3);
    // textContent (not innerText) so it also works on fetched/parsed (unrendered) documents
    return rows.map(function (r) { return r.textContent; }).join(" ").toLowerCase();
  }
  function findTable(type, doc) {
    doc = doc || document;
    if (type === "course") {
      const byId = doc.querySelector("#courseWisePaymentTable");
      if (byId) return byId;
    }
    let best = null, bestScore = 0;
    [...doc.querySelectorAll("table")].forEach(function (t) {
      const score = U.headScore(headerText(t));
      if (score > bestScore) { bestScore = score; best = t; }
    });
    return best || undefined;
  }

  // Table reading lives in reconcile.js (the CLI's parse.js) — kind = "pw" | "cw".
  function scrape(table, type) { return U.parseTable(table, type === "course" ? "cw" : "pw"); }

  // ---- storage ----
  // After the extension is reloaded, an old content script keeps running on the already-open
  // page; its chrome.* calls then throw "Extension context invalidated". Guard against that.
  function ctxAlive() { try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; } }
  function needRefreshHint() {
    const out = document.getElementById("umsrec-out");
    if (out) out.innerHTML = '<div class="verdict vno">⟳ Extension reload হয়েছে — এই পেজটা refresh (F5) করো।</div>';
  }
  function skey(type) { return type + "_" + spid(); }

  /* How many students' captures are kept. They are a cache of two pages that nothing ever
     removed: one pair per student visited, for as long as the extension is installed. A pair is a
     few KB and the quota is 10 MB, so a few thousand students fills it — and then every write
     fails and the panel stops working with nothing said. Forty is far more than the handful
     anyone has open at once, and a dropped capture is one page visit from coming back. */
  const KEEP = 40;

  /* Note this student as the most recently seen, and drop whatever falls off the end. The list is
     kept as one small key rather than by reading the whole store back on every capture. */
  function remember(id, done) {
    done = done || function () {};
    if (!ctxAlive()) { done(); return; }
    try {
      chrome.storage.local.get(["caps"], function (o) {
        const had = Array.isArray(o.caps) ? o.caps : null;
        let list = (had || []).filter(function (x) { return x !== id; });
        list.unshift(id);
        const drop = list.slice(KEEP);
        list = list.slice(0, KEEP);
        const finish = function () { try { chrome.storage.local.set({ caps: list }, done); } catch (e) { done(); } };
        /* First run after this version: everything written before there was a list is
           unaccounted for, and on a browser that has been reconciling for months that is the
           whole problem. Sweep it once. */
        if (!had) { sweep(list, finish); return; }
        if (!drop.length) { finish(); return; }
        const keys = [];
        drop.forEach(function (x) { keys.push("program_" + x, "course_" + x); });
        try { chrome.storage.local.remove(keys, finish); } catch (e) { finish(); }
      });
    } catch (e) { done(); }
  }

  /* Remove every capture except the students named. Only captures — settings, the manual-match
     list and the Batch page's own keys are left alone, which is why this matches on the prefix
     rather than clearing the store. */
  function sweep(keepIds, done) {
    try {
      chrome.storage.local.get(null, function (all) {
        const keep = {};
        (keepIds || []).forEach(function (x) { keep["program_" + x] = 1; keep["course_" + x] = 1; });
        const gone = Object.keys(all || {}).filter(function (k) {
          return /^(?:program|course)_/.test(k) && !keep[k];
        });
        if (!gone.length) { done(); return; }
        try { chrome.storage.local.remove(gone, done); } catch (e) { done(); }
      });
    } catch (e) { done(); }
  }

  /* A full store is the one failure here that can be fixed from inside: the captures are the only
     thing in it that can be thrown away. Say so, make room, and write again. */
  let retried = false;
  function full(type, data) {
    const out = document.getElementById("umsrec-out");
    if (out) out.innerHTML = '<div class="verdict vno">⚠ ব্রাউজারের জায়গা ভরে গিয়েছিল — পুরনো ক্যাপচার মুছে আবার নেওয়া হচ্ছে…</div>';
    if (retried) return;                 // once. twice would be a loop, not a recovery
    retried = true;
    sweep([spid()], function () { save(type, data); });
  }

  function save(type, data) {
    if (!ctxAlive()) return;
    try {
      chrome.storage.local.set({ [skey(type)]: { data: data, at: new Date().toLocaleString(), url: location.href } },
        function () {
          /* A quota failure arrives HERE, not as a throw — the try/catch below cannot see it, and
             for as long as nobody read this the write simply did nothing and the panel went quiet. */
          if (chrome.runtime.lastError) { full(type, data); return; }
          retried = false;
          remember(spid());
        });
    } catch (e) {}
  }
  function loadBoth(cb) {
    if (!ctxAlive()) { needRefreshHint(); cb(null, null); return; }
    try {
      chrome.storage.local.get([skey("program"), skey("course")], function (o) {
        cb(o[skey("program")] || null, o[skey("course")] || null);
      });
    } catch (e) { needRefreshHint(); cb(null, null); }
  }

  // ---- UI ----
  const css = `
  /* the panel body scrolls, and UMS's own page is light — without this the browser draws that
     scrollbar to match the page behind rather than the dark panel it is in */
  #umsrec{color-scheme:dark;position:fixed;right:16px;bottom:16px;z-index:2147483647;width:300px;max-width:92vw;
    font:13px/1.45 system-ui,"Segoe UI",Roboto,"Noto Sans Bengali",sans-serif;color:#eef1fb;background:#161a2b;
    border:1px solid #2a3050;border-radius:14px;box-shadow:0 16px 44px rgba(0,0,0,.5);overflow:hidden}
  #umsrec .hd{display:flex;align-items:center;gap:8px;padding:12px 14px;
    /* not #7c6cff: white on it measures 3.86:1, and the name and the icons sit on this */
    background:linear-gradient(135deg,#6d5cf0,#5b4ff0);color:#fff}
  #umsrec .hd b{font-size:14px;font-weight:700;flex:1;cursor:pointer;letter-spacing:.2px}
  #umsrec .hd .ic{cursor:pointer;opacity:.9;font-size:15px;padding:0 2px}
  #umsrec .hd .ic:hover{opacity:1}
  #umsrec .bd{padding:14px;max-height:70vh;overflow-y:auto;overflow-x:hidden}
  #umsrec .st{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #2a3050}
  #umsrec .ok{color:#37d18b}#umsrec .no{color:#ff6b7d}#umsrec .warn{color:#ffb454}#umsrec .mut{color:#8b91b4}
  #umsrec button{cursor:pointer;border:none;border-radius:10px;padding:9px 12px;font-weight:600;font-size:13px;
    transition:filter .12s,background .12s,border-color .12s}
  /* …and the same again here: this is the button the whole panel is for */
  #umsrec .primary{background:#6d5cf0;color:#fff;box-shadow:0 3px 12px rgba(124,108,255,.4)}
  #umsrec .primary:hover{filter:brightness(1.08)}
  #umsrec .ghost{background:#10131f;border:1px solid #2a3050;color:#eef1fb}
  #umsrec .ghost:hover{border-color:#7c6cff;background:#1a2036}
  #umsrec .verdict{padding:8px 10px;border-radius:8px;font-weight:700;text-align:center;margin:8px 0}
  #umsrec .vok{background:rgba(55,209,139,.16);color:#37d18b}
  #umsrec .vwarn{background:rgba(255,180,84,.16);color:#ffb454}
  #umsrec .vno{background:rgba(255,107,125,.16);color:#ff6b7d}
  /* Colours stated, not inherited. This panel lives inside the UMS document, so the UMS
     stylesheet reaches it — and a rule as ordinary as "th{background:#eef1f8}" paints these
     headings light while the text stays #eef1fb, which measured 1.00:1: the report table, which
     is the whole answer, vanishing on a page nobody here controls. */
  #umsrec table{border-collapse:collapse;width:100%;font-size:12px;margin-top:6px;
    background:transparent;color:#eef1fb}
  #umsrec th,#umsrec td{border:1px solid #2a3050;padding:4px 6px;text-align:right;
    white-space:nowrap;overflow-wrap:normal;word-break:normal;vertical-align:top;
    background:transparent;color:#eef1fb;font-family:inherit;font-size:12px;line-height:1.45}
  #umsrec th{font-weight:700;color:#b8bfda}
  #umsrec th:first-child,#umsrec td:first-child{text-align:left;white-space:normal}
  #umsrec .mrn{font-weight:700}
  #umsrec details{border:1px solid #2a3050;border-radius:8px;padding:6px 8px;background:rgba(255,255,255,.02)}
  #umsrec details[open]{background:rgba(255,255,255,.04)}
  #umsrec summary{font-size:12px;list-style:none}
  #umsrec summary::-webkit-details-marker{display:none}
  #umsrec summary::before{content:"▸ ";color:#8b91b4}
  #umsrec details[open] summary::before{content:"▾ "}
  #umsrec details table{margin-top:4px}
  #umsrec .row-actions{display:flex;gap:8px;margin-top:8px}
  /* Two rows, not three. The first is what the panel is for and the switch that says whether it
     is listening at all — the two things anyone opens it to do; Copy and Clear follow underneath.
     Single Reconcile takes whatever room is left, so the row reads as one action with a state
     beside it rather than two choices of equal weight. */
  #umsrec .row-actions.main{margin-top:12px}
  #umsrec .row-actions.main .primary{flex:1;min-width:0}
  #umsrec .row-actions.main .pw{flex:none;padding:9px 11px;font-size:12px}
  /* the two occasional buttons: equal shares of one line, and small enough to read as secondary */
  #umsrec .row-actions.small button{flex:1;padding:7px 6px;font-size:12px;min-width:0}
  /* running or stopped, in the space a dot takes. The minimised bubble has said it this way all
     along; the title said it in four words. */
  #umsrec .hd .dot{flex:none;width:9px;height:9px;border-radius:50%;background:#37d18b;
    box-shadow:0 0 0 3px rgba(255,255,255,.16)}
  #umsrec.off .hd .dot{background:#ff6b7d}
  #umsrec.min{display:none}
  /* minimized launcher bubble */
  /* minimized: one small pill — the name reopens the panel, ⛶ opens Batch Reconcile */
  #umsrec-mini{position:fixed;right:16px;bottom:16px;z-index:2147483647;display:none;
    align-items:center;gap:2px;padding:4px;border-radius:20px;
    background:#161a2b;border:1px solid #2a3050;box-shadow:0 8px 24px rgba(0,0,0,.45);
    font:600 14px/1 system-ui,"Segoe UI",Roboto,"Noto Sans Bengali",sans-serif}
  #umsrec-mini.on{display:flex}
  #umsrec-bub{position:relative;display:flex;align-items:center;justify-content:center;
    width:30px;height:30px;cursor:pointer;color:#eef1fb;border-radius:50%}
  #umsrec-bub:hover{background:rgba(255,255,255,.08)}
  #umsrec-bub .dot{position:absolute;right:1px;top:1px;width:8px;height:8px;border-radius:50%;
    background:#37d18b;border:2px solid #161a2b}
  #umsrec-mini.off #umsrec-bub .dot{background:#ff6b7d}
  #umsrec-batch{display:flex;align-items:center;justify-content:center;width:30px;height:30px;
    cursor:pointer;color:#8b91b4;border-radius:50%;font-size:14px;line-height:1}
  #umsrec-batch:hover{background:#7c6cff;color:#fff}
  @media (prefers-color-scheme:light){#umsrec{color-scheme:light;background:#fff;color:#141830;border-color:#e2e6f2}
    #umsrec th,#umsrec td{border-color:#e2e6f2}#umsrec .st{border-color:#e2e6f2}}
  `;

  function applyEnabled(val) {
    enabled = val;
    const b = document.getElementById("umsrec-power");
    if (b) { b.textContent = val ? "■ Stop" : "▶ Start"; b.style.color = val ? "#ff6b7d" : "#37d18b"; }
    /* The panel and the bubble now say it the same way — a dot. The title stays a title. */
    const el = document.getElementById("umsrec");
    if (el) el.classList.toggle("off", !val);
    const dot = document.getElementById("umsrec-dot");
    if (dot) dot.title = val ? "চলছে — পেজ খুললেই নিজে থেকে পড়ছে" : "⏸ থামানো";
    const mini = document.getElementById("umsrec-mini"), bub = document.getElementById("umsrec-bub");
    if (mini) mini.classList.toggle("off", !val);       // ডটের রঙ এখান থেকেই ঠিক হয়
    if (bub) bub.title = (val ? "চলছে" : "⏸ থামানো") + " · বড় করতে ক্লিক করো";
  }
  // minimize state — refresh করলেও যেন মনে থাকে
  function applyMin(val) {
    minimized = !!val;
    const el = document.getElementById("umsrec"), mini = document.getElementById("umsrec-mini");
    if (el) el.classList.toggle("min", minimized);
    if (mini) mini.classList.toggle("on", minimized);
  }
  function setMin(val) {
    applyMin(val);
    if (!ctxAlive()) return;
    try { chrome.storage.local.set({ minimized: !!val }); } catch (e) {}
  }
  function setEnabled(val) {
    if (!ctxAlive()) { needRefreshHint(); return; }
    try {
      chrome.storage.local.set({ enabled: val }, function () {
        applyEnabled(val);
        if (val) captureNow();
      });
    } catch (e) { needRefreshHint(); }
  }
  function captureNow() {
    const type = pageType();
    if (!type) return;
    const table = findTable(type);
    const data = table ? scrape(table, type) : null;
    if (data && data.ok && data.rows.length) { captureNote = ""; save(type, data); refreshStatus(); return true; }
    captureNote = table ? "টেবিল ফাঁকা" : "টেবিল পাওয়া যায়নি";
    refreshStatus();
    return false;
  }

  /* The table is often drawn after this script runs, so one attempt at load is not enough.
     Watch the page and keep trying until it appears (or ~20s passes). */
  /* How long to wait for the table to appear. It used to be twenty attempts, and the observer
     spent one on every mutation of the page — a spinner, a jQuery plugin, this very panel being
     inserted. A busy page burned all twenty in the first second, before the table had arrived,
     and then gave up for good: "not captured", permanently, with a reload the only cure and
     nothing on screen to suggest it.

     So the budget is time, which is what was actually being waited for. Mutations only say "look
     again" and cost nothing — throttled, because looking means scanning every table on the page. */
  const WAIT_MS = 60000;
  const LOOK_MS = 150;
  function captureWhenReady() {
    if (captureNow()) return;
    const until = Date.now() + WAIT_MS;
    let obs = null, iv = null, pending = false;
    const stop = function () {
      if (obs) obs.disconnect();
      obs = null;
      if (iv) clearInterval(iv);
      iv = null;
    };
    const attempt = function () {
      if (captureNow()) { stop(); return; }
      if (Date.now() > until) stop();
    };
    /* Leading edge: the first mutation after a quiet moment is looked at straight away, so a table
       that has just been drawn is captured at once. Only a burst is deferred — and a burst is
       exactly the case this throttle exists for, because looking means scanning every table on
       the page. */
    let last = 0;
    const soon = function () {
      if (!obs) return;
      const now = Date.now();
      if (now - last >= LOOK_MS) { last = now; attempt(); return; }
      if (pending) return;
      pending = true;
      setTimeout(function () { pending = false; last = Date.now(); attempt(); }, LOOK_MS - (now - last));
    };
    try {
      obs = new MutationObserver(soon);
      obs.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
    iv = setInterval(attempt, 1000);
  }

  function buildPanel() {
    if (document.getElementById("umsrec")) return;
    const style = document.createElement("style"); style.textContent = css; document.head.appendChild(style);
    const el = document.createElement("div"); el.id = "umsrec";
    el.innerHTML =
      /* The dot carries the running state; it used to be spelled out in the title, which is the
         longest way to say a thing that has one bit in it. Batch Reconcile sits with the other two
         icons because it opens another page — somewhere to go, not something to do here. */
      '<div class="hd"><span class="dot" id="umsrec-dot"></span>' +
      '<b id="umsrec-tt">UMS Reconciler</b>' +
      '<span class="ic" id="umsrec-dash" title="Batch Reconcile — অনেক ছাত্র একসাথে">⛶</span>' +
      '<span class="ic" id="umsrec-pop" title="আলাদা উইন্ডোতে খোলো">⧉</span>' +
      '<span class="ic" id="umsrec-min" title="ছোট করো">▾</span></div>' +
      '<div class="bd">' +
      '<div class="st"><span>Program Wise</span><span id="umsrec-p" class="mut">—</span></div>' +
      '<div class="st"><span>Course Wise</span><span id="umsrec-c" class="mut">—</span></div>' +
      /* the one thing the panel is for, and beside it the switch for whether it is listening */
      '<div class="row-actions main">' +
      '<button class="primary" id="umsrec-verify">Single Reconcile</button>' +
      '<button class="ghost pw" id="umsrec-power" title="পেজ খুললেই নিজে থেকে পড়া — বন্ধ/চালু">■ Stop</button></div>' +
      /* the occasional ones, small, on one line — the labels shrink, the titles keep the meaning */
      '<div class="row-actions small">' +
      '<button class="ghost" id="umsrec-copy" title="দুই পাতার প্রতিটা ঘর tab-separated হয়ে clipboard-এ — Excel বা মেসেজে পেস্ট করা যায়">⧉ Copy</button>' +
      '<button class="ghost" id="umsrec-clear" title="এই ছাত্রের জমা করা দুই পাতা মুছে দাও">✕ Clear</button></div>' +
      '<div id="umsrec-out"></div>' +
      '</div>';
    document.body.appendChild(el);

    /* ছোট করা অবস্থায় এই দুটোই থাকে — উপরে Batch Reconcile, নিচে বুদবুদ (ক্লিক করলে বড় হয়) */
    const mini = document.createElement("div");
    mini.id = "umsrec-mini";
    mini.innerHTML =
      '<div id="umsrec-bub"><span class="dot"></span><span>৳</span></div>' +
      '<div id="umsrec-batch" title="Batch Reconcile খোলো">⛶</div>';
    document.body.appendChild(mini);
    mini.querySelector("#umsrec-bub").addEventListener("click", function () { setMin(false); });
    mini.querySelector("#umsrec-batch").addEventListener("click", function (e) {
      e.stopPropagation();          // বুদবুদে ক্লিক গণ্য হবে না, প্যানেল বড় হবে না
      window.open(chrome.runtime.getURL("app.html"), "_blank");
    });

    el.querySelector("#umsrec-tt").addEventListener("click", function () { setMin(true); });
    el.querySelector("#umsrec-min").addEventListener("click", function () { setMin(true); });
    el.querySelector("#umsrec-pop").addEventListener("click", function () {
      const url = chrome.runtime.getURL("panel.html") + "?spid=" + encodeURIComponent(spid());
      window.open(url, "umsrec_" + spid(), "width=470,height=700");
    });
    el.querySelector("#umsrec-power").addEventListener("click", function () { setEnabled(!enabled); });
    el.querySelector("#umsrec-dash").addEventListener("click", function () { window.open(chrome.runtime.getURL("app.html"), "_blank"); });
    el.querySelector("#umsrec-verify").addEventListener("click", runVerify);
    /* Hand the captured cells over verbatim. A disputed receipt is settled by the numbers on the
       two pages, and copying eleven columns out of UMS by hand is where that goes wrong — the
       extension already holds them parsed. Both pages must have been visited first, same as
       Single Reconcile; the button says so rather than copying half an answer. */
    el.querySelector("#umsrec-copy").addEventListener("click", function () {
      const btn = this, was = btn.textContent;
      const flash = function (msg) { btn.textContent = msg; setTimeout(function () { btn.textContent = was; }, 1600); };
      loadBoth(function (pw, cw) {
        if (!pw && !cw) { flash("Nothing captured yet"); return; }
        const txt = U.rawText(pw && pw.data, cw && cw.data,
          { spid: spid(), reg: (location.search.match(/stdRollOrRegistrationNo=([^&]+)/) || [])[1] || "" });
        const done = function () { flash("✓ Copied" + (pw && cw ? "" : " (one page only)")); };
        try { navigator.clipboard.writeText(txt).then(done, function () { legacy(txt, done, flash); }); }
        catch (e) { legacy(txt, done, flash); }
      });
    });
    // clipboard API can be refused on an http page or without focus — the old way still works
    function legacy(txt, done, flash) {
      const ta = document.createElement("textarea");
      ta.value = txt; ta.style.position = "fixed"; ta.style.left = "-9999px";
      document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy") ? done() : flash("Copy failed"); }
      catch (e) { flash("Copy failed"); }
      ta.remove();
    }

    el.querySelector("#umsrec-clear").addEventListener("click", function () {
      if (!ctxAlive()) { needRefreshHint(); return; }
      try {
        chrome.storage.local.remove([skey("program"), skey("course")], function () {
          el.querySelector("#umsrec-out").innerHTML = "";
          refreshStatus();
        });
      } catch (e) { needRefreshHint(); }
    });
    refreshStatus();
  }

  function refreshStatus() {
    loadBoth(function (pw, cw) {
      const ps = document.getElementById("umsrec-p"), cs = document.getElementById("umsrec-c");
      if (!ps) return;
      const type = pageType();
      // on the page itself, say *why* nothing was captured instead of a bare "not captured"
      const miss = function (mine) { return mine && captureNote ? captureNote : "not captured"; };
      if (pw) { ps.className = "ok"; ps.textContent = "✓ " + pw.data.rows.length + " rows"; }
      else { ps.className = "mut"; ps.textContent = miss(type === "program"); }
      if (cw) { cs.className = "ok"; cs.textContent = "✓ " + cw.data.rows.length + " rows"; }
      else { cs.className = "mut"; cs.textContent = miss(type === "course"); }
    });
  }

  function runVerify() {
    loadBoth(function (pw, cw) {
      const out = document.getElementById("umsrec-out");
      if (!pw || !cw) {
        out.innerHTML = '<div class="verdict vno">দুইটা পেজেই একবার করে ভিজিট করো (Program Wise + Course Wise), তারপর Verify।</div>';
        return;
      }
      // same tolerance the Batch runner uses, so one student never passes there and fails here
      out.innerHTML = U.renderReport(U.compare(pw.data, cw.data, { tolerance: tol }), pw.data, cw.data);
    });
  }

  // keep status/state live across tabs
  try {
    chrome.storage.onChanged.addListener(function (changes) {
      try {
        if (changes.enabled) applyEnabled(changes.enabled.newValue !== false);
        if (changes.minimized) applyMin(changes.minimized.newValue === true);
        if (changes.appTol && changes.appTol.newValue != null) tol = changes.appTol.newValue;
        refreshStatus();
      } catch (e) {}
    });
  } catch (e) {}

  const onDataPage = !!pageType();
  const onSearchPage = /\/Student\/Payment\/PaymentHistory(?:$|[/?])/i.test(location.pathname);
  if (onDataPage || onSearchPage) {
    buildPanel();
    chrome.storage.local.get(["enabled", "minimized", "appTol", "tolMigrated"], function (o) {
      applyMin(o.minimized === true); // default: বড় করা
      applyEnabled(o.enabled !== false); // default: running
      // baseUrl/conc belong to the Batch page only — reading them here once threw a strict-mode
      // ReferenceError that killed this whole callback, so nothing was ever captured.
      // 1 was the old default and it hides exactly the ৳1 row-wise differences — drop it once here
      // too, not just in the Batch page, or the panel keeps running at the old tolerance.
      if (o.appTol != null) {
        if (o.appTol === 1 && !o.tolMigrated) {
          tol = 0;
          try { chrome.storage.local.set({ appTol: 0, tolMigrated: true }); } catch (e) {}
        } else tol = o.appTol;
      }
      if (onDataPage && enabled) captureWhenReady();
      else refreshStatus();
    });
  }
})();
