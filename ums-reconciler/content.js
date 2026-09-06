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
  function save(type, data) {
    if (!ctxAlive()) return;
    try { chrome.storage.local.set({ [skey(type)]: { data: data, at: new Date().toLocaleString(), url: location.href } }); } catch (e) {}
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
  #umsrec{position:fixed;right:16px;bottom:16px;z-index:2147483647;width:360px;max-width:92vw;
    font:13px/1.45 system-ui,"Segoe UI",Roboto,sans-serif;color:#eef1fb;background:#161a2b;
    border:1px solid #2a3050;border-radius:14px;box-shadow:0 16px 44px rgba(0,0,0,.5);overflow:hidden}
  #umsrec .hd{display:flex;align-items:center;gap:8px;padding:12px 14px;
    background:linear-gradient(135deg,#7c6cff,#5b4ff0);color:#fff}
  #umsrec .hd b{font-size:14px;font-weight:700;flex:1;cursor:pointer;letter-spacing:.2px}
  #umsrec .hd .ic{cursor:pointer;opacity:.9;font-size:15px;padding:0 2px}
  #umsrec .hd .ic:hover{opacity:1}
  #umsrec .bd{padding:14px;max-height:70vh;overflow-y:auto;overflow-x:hidden}
  #umsrec .st{display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #2a3050}
  #umsrec .ok{color:#37d18b}#umsrec .no{color:#ff6b7d}#umsrec .warn{color:#ffb454}#umsrec .mut{color:#8b91b4}
  #umsrec button{cursor:pointer;border:none;border-radius:10px;padding:9px 12px;font-weight:600;font-size:13px;
    transition:filter .12s,background .12s,border-color .12s}
  #umsrec .primary{background:#7c6cff;color:#fff;box-shadow:0 3px 12px rgba(124,108,255,.4)}
  #umsrec .primary:hover{filter:brightness(1.08)}
  #umsrec .ghost{background:#10131f;border:1px solid #2a3050;color:#eef1fb}
  #umsrec .ghost:hover{border-color:#7c6cff;background:#1a2036}
  #umsrec .verdict{padding:8px 10px;border-radius:8px;font-weight:700;text-align:center;margin:8px 0}
  #umsrec .vok{background:rgba(55,209,139,.16);color:#37d18b}
  #umsrec .vwarn{background:rgba(255,180,84,.16);color:#ffb454}
  #umsrec .vno{background:rgba(255,107,125,.16);color:#ff6b7d}
  #umsrec table{border-collapse:collapse;width:100%;font-size:12px;margin-top:6px}
  #umsrec th,#umsrec td{border:1px solid #2a3050;padding:4px 6px;text-align:right;
    white-space:nowrap;overflow-wrap:normal;word-break:normal;vertical-align:top}
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
  @media (prefers-color-scheme:light){#umsrec{background:#fff;color:#141830;border-color:#e2e6f2}
    #umsrec th,#umsrec td{border-color:#e2e6f2}#umsrec .st{border-color:#e2e6f2}}
  `;

  function applyEnabled(val) {
    enabled = val;
    const b = document.getElementById("umsrec-power");
    if (b) { b.textContent = val ? "■ Stop" : "▶ Start"; b.style.color = val ? "#ff6b7d" : "#37d18b"; }
    const tt = document.getElementById("umsrec-tt");
    if (tt) tt.textContent = val ? "UMS Payment Reconciler" : "UMS Payment Reconciler ⏸ (stopped)";
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
  function captureWhenReady() {
    if (captureNow()) return;
    let tries = 0, obs = null;
    const stop = function () { if (obs) obs.disconnect(); obs = null; };
    const attempt = function () {
      if (captureNow()) { stop(); return; }
      if (++tries >= 20) { stop(); }
    };
    try {
      obs = new MutationObserver(function () { attempt(); });
      obs.observe(document.documentElement, { childList: true, subtree: true });
    } catch (e) {}
    const iv = setInterval(function () {
      if (!obs) { clearInterval(iv); return; }
      attempt();
      if (!obs) clearInterval(iv);
    }, 1000);
  }

  function buildPanel() {
    if (document.getElementById("umsrec")) return;
    const style = document.createElement("style"); style.textContent = css; document.head.appendChild(style);
    const el = document.createElement("div"); el.id = "umsrec";
    el.innerHTML =
      '<div class="hd"><b id="umsrec-tt">UMS Payment Reconciler</b>' +
      '<span class="ic" id="umsrec-pop" title="আলাদা উইন্ডোতে খোলো">⧉</span>' +
      '<span class="ic" id="umsrec-min" title="ছোট/বড় করো">▾</span></div>' +
      '<div class="bd">' +
      '<div class="st"><span>Program Wise</span><span id="umsrec-p" class="mut">—</span></div>' +
      '<div class="st"><span>Course Wise</span><span id="umsrec-c" class="mut">—</span></div>' +
      '<div class="row-actions" style="margin-top:12px">' +
      '<button class="primary" id="umsrec-verify" style="flex:1">Single Reconcile</button>' +
      '<button class="ghost" id="umsrec-dash" style="flex:1">⛶ Batch Reconcile</button></div>' +
      '<div class="row-actions">' +
      '<button class="ghost" id="umsrec-power" style="flex:1">■ Stop</button>' +
      '<button class="ghost" id="umsrec-clear" style="flex:1">Clear captured</button></div>' +
      '<div class="row-actions">' +
      '<button class="ghost" id="umsrec-copy" style="flex:1" title="Program Wise + Course Wise — every cell, tab-separated, on the clipboard. Paste into Excel or a message.">⧉ Copy Both Tables</button></div>' +
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
