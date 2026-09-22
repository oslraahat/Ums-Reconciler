/* CRM (crm*) menu — split out of app.js (behaviour-preserving reorg).
 * Loads before app.js; resolves shared core helpers lazily through self.APP at call time. */
(function () {
  "use strict";
  var A = self.APP || (self.APP = {});
  function $(id) { return A.$(id); }
  function t(k) { return A.t(k); }
  function sleep(ms) { return A.sleep(ms); }
  function parseCSV() { return A.parseCSV.apply(null, arguments); }
  function readXlsx() { return A.readXlsx.apply(null, arguments); }
  function fetchHtml() { return A.fetchHtml.apply(null, arguments); }
  /* CRM has one sub-page ("dash"); showCrm keeps this local copy, app.js keeps its own for showPage. */
  var crmTab = "dash";

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
    const num = A.getLang() === "bn" ? pairs.length.toLocaleString("bn-BD") : String(pairs.length);
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
    const cb = $("crmBase"); if (cb && !cb.value && A.getBaseUrl()) { cb.value = A.getBaseUrl(); }
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

  A.crm = {
    render: crmRender, setConn: crmSetConn, connDebounced: crmConnDebounced, nextLabel: crmNextLabel,
    importFile: crmImportFile, importSheet: crmImportSheet, download: crmDownload, clear: crmClear,
    run: crmRun, stop: crmStop, setMode: crmSetMode, copy: crmCopy, show: showCrm,
    getConn: function () { return crmConnState; }, getMode: function () { return crmMode; }
  };
})();
