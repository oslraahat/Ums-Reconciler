/* Clickable Function Check (fn*) — a read-only UI health crawl of a UMS site.
 *
 * Given a base URL it reads the home page, pulls every menu / sub-menu LINK out of the sidebar, and
 * opens each one rapidly (concurrent GETs) to see whether the page is healthy. It never clicks an
 * in-page action — no form is submitted, nothing is saved or deleted — so it is safe against the
 * live/test UMS. A link that logs out, deletes, exports or downloads is skipped for the same reason.
 *
 * A page FAILS when any of these is true:
 *   • the request errors / does not load — HTTP 4xx/5xx, a redirect to the login page, or a timeout
 *   • the page itself carries a UMS / .NET error or exception (yellow screen, validation summary…)
 *   • the page comes back blank / with no real content
 * Every failure is shown with a screenshot (captured by loading just that page in a side window) and
 * the reason. Passes are listed too, grouped by menu, so the report reads action-by-action.
 *
 * Loads before app.js; resolves shared core helpers lazily through self.APP at call time. */
(function () {
  "use strict";
  var A = self.APP || (self.APP = {});
  function $(id) { return A.$(id); }
  function t(k) { return A.t(k); }
  function fetchHtml() { return A.fetchHtml.apply(null, arguments); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }

  var MAX_LINKS = 600;           // a hard cap so a mis-parsed page can never spawn thousands of fetches
  var CONC = 8;                  // parallel page checks (HTTP mode)
  var FN_HEADLESS_CONC = 3;      // parallel off-screen windows in Headless mode (Browser stays 1)
  var fnRun = null;              // { stop } while a crawl is going
  var fnMode = "http";           // http | browser | headless

  function fnSetMode(m) {
    fnMode = (m === "browser" || m === "headless") ? m : "http";
    [["fnHttp", "http"], ["fnBrowser", "browser"], ["fnHeadless", "headless"]].forEach(function (p) {
      var b = $(p[0]); if (b) b.classList.toggle("on", fnMode === p[1]);
    });
    try { chrome.storage.local.set({ fnMode: fnMode }); } catch (e) {}
  }

  /* ---- what counts as a checkable page link ---- */
  // state-changing or non-HTML hrefs are never opened, even though they are GETs — the crawl only
  // OPENS pages, so anything that could save/delete/send or hand back a file is skipped for safety
  var SKIP_HREF = /(log\s*-?\s*(out|off)|sign\s*-?\s*out|\/account\/log|\/logout|\/logoff|delete|remove|destroy|\bdrop\b|approve|activate|deactivate|\bvoid\b|\benable\b|\bdisable\b|\breset\b|generate|\bsend\b|export|download|\/print|\.(pdf|xlsx?|csv|zip|docx?|pptx?|png|jpe?g|gif)(\?|$))/i;
  var ORIGIN = function (u) { try { return new URL(u).origin; } catch (e) { return ""; } };

  /* The top-level UMS menu a path belongs to, and the order the user wants them checked in:
     Student → Administration → Exam → Teacher → CRM → Team → Inventory. CRM lives UNDER /Student
     (…/CrmConversation/…), so it is matched first; Team is /Hr, Inventory is /UInventory. */
  var MENU_ORDER = ["Student", "Administration", "Exam", "Teacher", "CRM", "Team", "Inventory", "Other"];
  function fnTopMenu(path) {
    var p = String(path || "").toLowerCase();
    if (/crm/.test(p)) return "CRM";
    if (/^\/administration/.test(p)) return "Administration";
    if (/^\/exam/.test(p)) return "Exam";
    if (/^\/teacher/.test(p)) return "Teacher";
    if (/^\/hr(\/|$)/.test(p)) return "Team";
    if (/^\/(u)?inventor/.test(p)) return "Inventory";
    if (/^\/student/.test(p)) return "Student";
    return "Other";
  }
  function fnMenuRank(path) { var i = MENU_ORDER.indexOf(fnTopMenu(path)); return i < 0 ? MENU_ORDER.length : i; }

  /* Pull EVERY link out of the page — menus, sub-menus and any other navigational <a href>. Server-
     rendered UMS keeps every sidebar/submenu <a> in the markup (collapsed ones are only hidden by
     CSS), and sub-menus can sit outside the main nav container, so the whole document is scanned
     rather than one sidebar box — that is why some sub-menus were missed before. Same-origin,
     navigational links only; logout/delete/export/file links are dropped (see SKIP_HREF). The menu
     group is the nearest enclosing list's own label, so the report can still be grouped. */
  function fnParseNav(html, baseUrl) {
    var origin = ORIGIN(baseUrl);
    var doc;
    try { doc = new DOMParser().parseFromString(html, "text/html"); } catch (e) { return []; }
    var scope = doc.body || doc;
    if (!scope) return [];
    var seen = {}, out = [];
    var anchors = scope.querySelectorAll("a[href]");
    for (var i = 0; i < anchors.length && out.length < MAX_LINKS; i++) {
      var a = anchors[i];
      var raw = a.getAttribute("href") || "";
      if (!raw || raw.charAt(0) === "#" || /^(javascript:|mailto:|tel:|data:)/i.test(raw)) continue;
      var url;
      try { url = new URL(raw, baseUrl).href; } catch (e) { continue; }
      if (ORIGIN(url) !== origin) continue;              // same site only
      var path = url.slice(origin.length);
      if (path === "" || path === "/") continue;         // the home page itself
      if (SKIP_HREF.test(path)) continue;                // logout / delete / export / files
      var key = url.split("#")[0];
      if (seen[key]) continue; seen[key] = 1;
      var label = (a.textContent || "").replace(/\s+/g, " ").trim();
      out.push({ menu: fnGroupOf(a), label: label || path, url: key, path: path });
    }
    return out;
  }
  // the nearest ancestor list's heading / toggle text — best-effort grouping, falls back to "Menu"
  function fnGroupOf(a) {
    var li = a.closest ? a.closest("li") : null;
    var hops = 0;
    while (li && hops < 6) {
      var parentLi = li.parentElement ? (li.parentElement.closest ? li.parentElement.closest("li") : null) : null;
      if (parentLi) {
        var head = parentLi.querySelector("a,span,button,label");
        var txt = head ? (head.textContent || "").replace(/\s+/g, " ").trim() : "";
        if (txt && txt.length <= 40) return txt;
      }
      li = parentLi; hops++;
    }
    // a sidebar heading above the link
    var h = a.closest ? a.closest("ul,nav,.sidebar") : null;
    var hd = h ? h.previousElementSibling : null;
    if (hd && /^(h[1-6]|div|span|a)$/i.test(hd.tagName)) {
      var ht = (hd.textContent || "").replace(/\s+/g, " ").trim();
      if (ht && ht.length <= 40) return ht;
    }
    return "Menu";
  }

  /* Decide pass/fail from a fetched page. Only strong, unambiguous error signatures count, so a page
     that merely has the word "error" in a label is not condemned. */
  /* ONLY hard server-error signatures that appear on a real .NET/IIS error page. Generic phrases
     like "Something went wrong" / "An error occurred" / an empty .validation-summary-errors div sit
     HIDDEN in the markup of almost every healthy UMS page (toast templates, SweetAlert strings, JS),
     so matching them in raw HTML condemns working pages. A VISIBLE error is caught instead by the
     rendered-DOM probe during the screenshot pass. */
  var ERR_MARK = /(server error in\s|exception details:|stack trace:|unhandled exception|runtime error|the resource cannot be found|http error 5\d\d|500 - internal server|503 - service unavailable|could not load (type|file)|parser error)/i;
  var LOGIN_URL = /\/(account\/)?(log\s*-?\s*(in|on)|login|signin)\b/i;
  function fnClassify(res, baseUrl) {
    var status = res.status || 0;
    var html = res.html || "";
    var finalUrl = res.finalUrl || "";
    if (res.error) return { pass: false, reason: "লোড হয়নি — " + res.error, kind: "net" };
    if (status >= 400) return { pass: false, reason: "HTTP " + status, kind: "http" };
    // a redirect that lands on the login page = the session is gone / no access
    if ((res.redirected && LOGIN_URL.test(finalUrl)) || (LOGIN_URL.test(finalUrl) && ORIGIN(finalUrl) === ORIGIN(baseUrl) && finalUrl !== baseUrl)) {
      return { pass: false, reason: "লগইন পেজে রিডাইরেক্ট — সেশন/অ্যাক্সেস নেই", kind: "login" };
    }
    if (ERR_MARK.test(html)) {
      var m = ERR_MARK.exec(html);
      return { pass: false, reason: "পেজে error/exception: “" + (m ? m[0] : "error").slice(0, 60) + "”", kind: "page" };
    }
    // blank / no real content: strip tags and script/style, see what text is left
    var text = html.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&[a-z#0-9]+;/gi, " ").replace(/\s+/g, " ").trim();
    var hasStructure = /<(table|form|canvas|svg|input|select|h[1-3])\b/i.test(html);
    if (text.length < 40 && !hasStructure) return { pass: false, reason: "খালি/ভাঙা পেজ (কোনো কনটেন্ট নেই)", kind: "blank" };
    return { pass: true, reason: "ঠিক আছে", kind: "ok" };
  }

  /* Browser / Headless verdict — from what actually rendered (the page's JS ran). Catches a visible
     error toast, a .NET error, a login redirect, a blank page, and uncaught JS console errors. */
  function fnClassifyProbe(probe) {
    if (!probe || probe.error) return { pass: false, reason: "লোড হয়নি — " + ((probe && probe.error) || "page error"), kind: "net" };
    if (probe.isLogin) return { pass: false, reason: "লগইন পেজ — সেশন/অ্যাক্সেস নেই", kind: "login" };
    if (probe.serverErr) return { pass: false, reason: "পেজে server error/exception" + (probe.errText ? ": " + String(probe.errText).slice(0, 60) : ""), kind: "page" };
    if (probe.errText) return { pass: false, reason: "দৃশ্যমান error: " + String(probe.errText).slice(0, 70), kind: "page" };
    if (probe.consoleErr) return { pass: false, reason: "JS console error: " + String(probe.consoleErr), kind: "js" };
    if ((probe.bodyLen || 0) < 40 && !probe.hasStructure) return { pass: false, reason: "খালি/ভাঙা পেজ (কোনো কনটেন্ট নেই)", kind: "blank" };
    return { pass: true, reason: "ঠিক আছে", kind: "ok" };
  }

  /* ---- the crawl ---- */
  function fnBase() {
    var v = ($("fnBase") && $("fnBase").value || "").trim();
    if (!v) v = (A.getBaseUrl && A.getBaseUrl()) || "https://ums-4.osl.team";
    if (!/^https?:\/\//i.test(v)) v = "https://" + v;
    return v.replace(/\/+$/, "") + "/";
  }

  // login status next to the Base URL: open the base and see if it serves a page or bounces to login
  var fnConnSeq = 0, fnConnTimer = null;
  function fnSetConn(state) {
    var el = $("fnConn"); if (!el) return;
    el.className = "fnconn" + (state ? " " + state : "");
    el.textContent = state === "ok" ? t("fn_logged") : state === "no" ? t("fn_notlogged") : state === "chk" ? t("fn_conn_chk") : "";
  }
  function fnCheckConn() {
    var base = fnBase(), mine = ++fnConnSeq;
    fnSetConn("chk");
    // one direct request with its own timeout — fetchHtml retries with backoff and would leave the
    // status stuck on "checking" for a long time when the server is slow/unreachable.
    var ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
    var to = setTimeout(function () { if (ctrl) try { ctrl.abort(); } catch (e) {} }, 10000);
    fetch(base, { credentials: "include", signal: ctrl ? ctrl.signal : undefined }).then(function (r) {
      clearTimeout(to); if (mine !== fnConnSeq) return;
      // the final URL after following redirects is the reliable tell: bounced to login → not logged in
      if (!r.ok || LOGIN_URL.test(r.url || "")) { fnSetConn("no"); return; }
      return r.text().then(function (h) {
        if (mine !== fnConnSeq) return;
        fnSetConn(/name=["']?password|type=["']?password|\/account\/log/i.test((h || "").slice(0, 4000)) ? "no" : "ok");
      });
    }).catch(function () { clearTimeout(to); if (mine === fnConnSeq) fnSetConn("no"); });
  }
  function fnConnDebounced() { if (fnConnTimer) clearTimeout(fnConnTimer); fnConnTimer = setTimeout(fnCheckConn, 600); }

  var results = [];   // [{menu,label,url,path,pass,reason,kind,shot}]
  var fnFilter = "all";   // all | pass | fail — clicking the summary pills filters the list
  var fnT0 = 0, fnTimer = null;
  function fnElapsed() {
    var s = Math.round(((fnRun ? Date.now() : fnEnd) - fnT0) / 1000); if (s < 0) s = 0;
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    return h > 0 ? p(h) + ":" + p(m) + ":" + p(sec) : p(m) + ":" + p(sec);   // mm:ss, or hh:mm:ss past 60m
  }
  var fnEnd = 0;
  function fnProgress(done, total, phase) {
    var bar = $("fnBar"), note = $("fnNote");
    if (bar) bar.style.width = total ? Math.round(done / total * 100) + "%" : "0%";
    if (note) note.textContent = (phase || "") + (total ? "  " + done + " / " + total : "");
  }
  function fnRenderSummary() {
    var pass = results.filter(function (r) { return r.pass; }).length;
    var fail = results.length - pass;
    var s = $("fnSummary"); if (!s) return;
    var time = (fnT0 ? '<span class="fnpill" style="background:rgba(245,179,1,.16);color:#e0a81e">⏱ ' + fnElapsed() + '</span> ' : "");
    var on = function (f) { return fnFilter === f ? " fnon" : ""; };
    s.innerHTML = results.length
      ? time
        + '<span class="fnpill ok fnf' + on("pass") + '" data-fnf="pass" title="শুধু Pass দেখাও">✓ ' + pass + ' Pass</span> '
        + '<span class="fnpill bad fnf' + on("fail") + '" data-fnf="fail" title="শুধু Fail দেখাও">✗ ' + fail + ' Fail</span> '
        + '<span class="fnpill fnf' + on("all") + '" data-fnf="all" title="সব দেখাও" style="background:rgba(127,127,127,.14);color:var(--mut)">/ ' + results.length + '</span>'
      : (fnRun ? time : "");
  }
  function fnRenderList() {
    var box = $("fnList"); if (!box) return;
    if (!results.length) { box.innerHTML = ""; return; }
    // group by menu, fails first inside each group; honour the Pass/Fail filter
    var shown = results.filter(function (r) { return fnFilter === "all" || (fnFilter === "pass" ? r.pass : !r.pass); });
    if (!shown.length) { box.innerHTML = '<div class="mut" style="padding:10px">' + (fnFilter === "fail" ? "কোনো Fail নেই 🎉" : "কিছু দেখানোর নেই") + '</div>'; return; }
    var groups = {};
    shown.forEach(function (r) { (groups[r.menu] = groups[r.menu] || []).push(r); });
    var html = "";
    Object.keys(groups).forEach(function (g) {
      var rows = groups[g].slice().sort(function (a, b) { return (a.pass ? 1 : 0) - (b.pass ? 1 : 0); });
      var gf = rows.filter(function (r) { return !r.pass; }).length;
      html += '<div class="fngrp"><div class="fnghead">' + esc(g) + ' <span class="mut">(' + rows.length + ')</span>' +
        (gf ? ' <span class="fnpill bad">✗ ' + gf + '</span>' : ' <span class="fnpill ok">✓</span>') + '</div>';
      rows.forEach(function (r) {
        var acts = "";
        if (r.actions && r.actions.length) {
          acts = '<div class="fnacts">' + r.actions.map(function (a) {
            return '<div class="fnactrow ' + (a.pass ? "p" : "f") + '"><span class="fnst">' + (a.pass ? "✓" : "✗") +
              '</span><span class="fnactlbl">' + esc(a.label) + '</span><span class="fnactwhy">— ' + esc(a.reason) + '</span>' +
              (a.shot ? '<a class="fnshot" href="' + a.shot + '" target="_blank" title="স্ক্রিনশট"><img src="' + a.shot + '" alt="screenshot"></a>' : "") +
              '</div>';
          }).join("") + '</div>';
        }
        html += '<div class="fnrow ' + (r.pass ? "p" : "f") + '">' +
          '<span class="fnst">' + (r.pass ? "✓" : "✗") + '</span>' +
          '<a class="fnlk" href="' + esc(r.url) + '" target="_blank" rel="noopener">' + esc(r.label) + '</a>' +
          '<span class="fnpath mut">' + esc(r.path) + '</span>' +
          (r.shot ? '<a class="fnshot" href="' + r.shot + '" target="_blank" title="স্ক্রিনশট"><img src="' + r.shot + '" alt="screenshot"></a>' : "") +
          (r.pass ? "" : '<span class="fnwhy">' + esc(r.reason) + '</span>') +
          acts +
          '</div>';
      });
      html += '</div>';
    });
    box.innerHTML = html;
  }

  function pool(items, n, worker, onEach) {
    return new Promise(function (resolve) {
      var i = 0, active = 0, done = 0;
      function next() {
        if (fnRun && fnRun.stop) { if (active === 0) resolve(); return; }
        if (fnRun && fnRun.paused) { fnRun._resume = next; return; }   // park until Resume fires next()
        while (active < n && i < items.length) {
          var idx = i++; active++;
          worker(items[idx], idx).then(function (r) { onEach(r, idx); }).catch(function () {}).then(function () {
            active--; done++;
            if (done === items.length || (fnRun && fnRun.stop && active === 0)) resolve(); else next();
          });
        }
      }
      if (!items.length) resolve(); else next();
    });
  }

  async function fnCheckUrl(item) {
    try {
      var r = await fetchHtml(item.url);
      // fetchHtml does not expose the redirected-to URL, so finalUrl stays the requested URL; a login
      // redirect is instead detected from the returned HTML just below.
      var res = { status: r.status, html: r.html, redirected: r.redirected, finalUrl: item.url };
      // fetchHtml does not expose the final URL; a login redirect still shows up as an HTML login form
      if (r.redirected && LOGIN_URL.test(r.html.slice(0, 4000))) res.finalUrl = fnBase() + "Account/Login";
      var c = fnClassify(res, fnBase());
      return Object.assign({}, item, c);
    } catch (e) {
      return Object.assign({}, item, { pass: false, reason: "লোড হয়নি — " + String(e && e.message || e), kind: "net" });
    }
  }

  function fnShot(url) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage({ type: "fnShot", url: url }, function (resp) {
          if (chrome.runtime.lastError) { resolve(null); return; }
          resolve(resp || null);
        });
      } catch (e) { resolve(null); }
    });
  }
  function fnVisit(url, mode, base, actions, vals, slot) {
    return new Promise(function (resolve) {
      var done = false;
      // a page that blocks (a native dialog, an endless script) must NOT hang the whole crawl — if the
      // background does not answer in time, give up on this one and move on.
      // must exceed the background worst case (waitTabComplete 25s + probe 12s + action probe race),
      // or the slot would be freed and reused while the background is still driving that window
      var to = setTimeout(function () { if (!done) { done = true; resolve({ ok: false, error: "timeout — পেজ সাড়া দেয়নি (120s)" }); } }, 120000);
      try {
        chrome.runtime.sendMessage({ type: "fnVisit", url: url, mode: mode, base: base, actions: actions, vals: vals, slot: slot || 0 }, function (resp) {
          if (done) { void chrome.runtime.lastError; return; } done = true; clearTimeout(to);
          var le = chrome.runtime.lastError;
          if (le) { resolve({ ok: false, error: le.message || "no response (এক্সটেনশন পুরো Reload করো)" }); return; }
          resolve(resp || { ok: false, error: "empty response" });
        });
      } catch (e) { if (!done) { done = true; clearTimeout(to); resolve({ ok: false, error: String(e && e.message || e) }); } }
    });
  }

  // Event-driven, not a poll: a backgrounded panel (Browser mode steals focus) throttles setTimeout,
  // which could leave a poll-based wait stuck after Resume. Instead we park the loop on a resolver
  // that the Resume/Stop click fires directly.
  function waitIfPaused() {
    if (!fnRun || !fnRun.paused || fnRun.stop) return Promise.resolve();
    return new Promise(function (resolve) { fnRun._resume = resolve; });
  }
  function fnReleasePause() { if (fnRun && fnRun._resume) { var r = fnRun._resume; fnRun._resume = null; r(); } }
  async function fnStart() {
    if (fnRun) return;
    fnRun = { stop: false, paused: false };
    results = []; fnFilter = "all";
    fnT0 = Date.now(); fnEnd = 0;
    if (fnTimer) clearInterval(fnTimer);
    fnTimer = setInterval(fnRenderSummary, 1000);   // live elapsed clock
    $("fnStart").style.display = "none"; $("fnStop").style.display = "";
    if ($("fnPause")) { $("fnPause").style.display = ""; $("fnPause").textContent = t("fn_pause"); }
    $("fnSummary").innerHTML = ""; $("fnList").innerHTML = "";
    fnRenderSummary();
    var base = fnBase();
    fnProgress(0, 0, t("fn_reading"));
    var links;
    try {
      var home = await fetchHtml(base);
      if (home.redirected && LOGIN_URL.test(home.html.slice(0, 4000))) {
        $("fnNote").textContent = t("fn_login"); fnDone(); return;
      }
      links = fnParseNav(home.html, base);
      // The home page carries only the CURRENT section's sidebar (Student) plus the top-nav links to
      // the other sections — each other section (Exam, Teacher, Team, Inventory, CRM, Administration)
      // loads its OWN sidebar only when you open it. So open each section's landing page once and merge
      // its sub-menus in, or the whole crawl would miss hundreds of pages outside Student.
      var seenUrls = {}; links.forEach(function (l) { seenUrls[l.url] = 1; });
      var roots = {};   // top menu -> its shortest landing path found in the home nav
      links.forEach(function (l) {
        var tm = fnTopMenu(l.path);
        if (tm !== "Student" && tm !== "Other" && (!roots[tm] || l.path.length < roots[tm].length)) roots[tm] = l.path;
      });
      var rootList = Object.keys(roots);
      for (var ri = 0; ri < rootList.length; ri++) {
        if (fnRun && fnRun.stop) break;
        await waitIfPaused(); if (fnRun && fnRun.stop) break;
        fnProgress(ri, rootList.length, t("fn_sections"));
        try {
          var secUrl = new URL(roots[rootList[ri]], base).href;
          var sec = await fetchHtml(secUrl);
          fnParseNav(sec.html, base).forEach(function (l) { if (!seenUrls[l.url]) { seenUrls[l.url] = 1; links.push(l); } });
        } catch (e) {}
      }
    } catch (e) {
      $("fnNote").textContent = t("fn_fail") + " — " + String(e && e.message || e); fnDone(); return;
    }
    if (!links.length) { $("fnNote").textContent = t("fn_nomenu"); fnDone(); return; }
    // check in the menu serial the user wants: Student → Administration → Exam → Teacher → CRM →
    // Team → Inventory (stable, so sub-menu order within each menu is kept as the page listed them)
    links.sort(function (a, b) { return fnMenuRank(a.path) - fnMenuRank(b.path); });

    // 1) pass/fail over every page
    var total = links.length, done = 0;
    if (fnMode === "http") {
      // rapid: concurrent GETs, classify from the HTML
      fnProgress(0, total, t("fn_checking"));
      await pool(links, CONC, fnCheckUrl, function (r) {
        results.push(r); done++; fnProgress(done, total, t("fn_checking"));
        fnRenderSummary(); fnRenderList();
      });
    } else {
      // Browser / Headless: load each page for real (JS runs), classify from the rendered DOM +
      // console errors. Sequential — one tab/window reused.
      var doActions = !!($("fnActions") && $("fnActions").checked);
      var vals = {
        roll: ($("fnRoll") && $("fnRoll").value || "").trim(),
        reg: ($("fnReg") && $("fnReg").value || "").trim(),
        mobile: ($("fnMobile") && $("fnMobile").value || "").trim(),
        tpin: ($("fnTpin") && $("fnTpin").value || "").trim(),
        pin: ($("fnPin") && $("fnPin").value || "").trim()
      };
      // Headless runs several off-screen windows in parallel for speed; Browser stays 1-at-a-time
      // (it is the visible front tab). Each concurrent worker borrows a free window slot.
      var concV = (fnMode === "headless") ? FN_HEADLESS_CONC : 1;
      var freeSlots = []; for (var si = 0; si < concV; si++) freeSlots.push(si);
      fnProgress(0, total, t("fn_visiting"));
      await pool(links, concV, function (link) {
        var slot = freeSlots.length ? freeSlots.pop() : 0;
        return fnVisit(link.url, fnMode, base, doActions, vals, slot).then(function (v) {
          freeSlots.push(slot);
          var c = (v && v.ok) ? fnClassifyProbe(v.probe) : { pass: false, reason: "লোড হয়নি" + (v && v.error ? " — " + v.error : ""), kind: "net" };
          var row = Object.assign({}, link, c);
          if (v && v.ok && v.probe && v.probe.actions) row.actions = v.probe.actions;
          return row;
        }, function (e) { freeSlots.push(slot); return Object.assign({}, link, { pass: false, reason: "লোড হয়নি — " + String(e && e.message || e), kind: "net" }); });
      }, function (row) {
        results.push(row); done++; fnProgress(done, total, t("fn_visiting"));
        fnRenderSummary(); fnRenderList();
      });
      try { chrome.runtime.sendMessage({ type: "fnVisitClose" }, function () { void chrome.runtime.lastError; }); } catch (e) {}
    }
    if (fnRun && fnRun.stop) { fnDone(); return; }

    // 2) a screenshot for each failure (in every mode). The capture window is parked off-screen; in
    // Headless it may flash briefly since capturing needs a non-minimized window.
    {
      // screenshot any page that failed OR has a failing button/action (the error is often the action)
      var actFail = function (r) { return r.actions && r.actions.some(function (a) { return !a.pass; }); };
      var fails = results.filter(function (r) { return !r.pass || actFail(r); });
      for (var k = 0; k < fails.length; k++) {
        if (fnRun && fnRun.stop) break;
        await waitIfPaused(); if (fnRun && fnRun.stop) break;
        fnProgress(k, fails.length, t("fn_shooting"));
        var s = await fnShot(fails[k].url);
        if (s && s.shot) {
          if (!fails[k].pass) {
            fails[k].shot = s.shot;
            if (s.probe && s.probe.errText && fails[k].kind !== "page") fails[k].reason += " · " + String(s.probe.errText).slice(0, 60);
          } else {
            // page itself is fine — the error is an action; hang the shot on the first failing action
            var fa = (fails[k].actions || []).filter(function (a) { return !a.pass; })[0];
            if (fa) fa.shot = s.shot;
          }
          fnRenderList();
        }
      }
      try { chrome.runtime.sendMessage({ type: "fnShotClose" }, function () { void chrome.runtime.lastError; }); } catch (e) {}
    }
    fnProgress(results.length, results.length, t("fn_done"));
    fnDone();
  }

  function fnStop() {
    if (fnRun) { fnRun.stop = true; fnRun.paused = false; fnReleasePause(); }
    // close the check windows right away — don't wait for an in-flight visit (up to 60s) to return
    try { chrome.runtime.sendMessage({ type: "fnVisitClose" }, function () { void chrome.runtime.lastError; }); } catch (e) {}
    try { chrome.runtime.sendMessage({ type: "fnShotClose" }, function () { void chrome.runtime.lastError; }); } catch (e) {}
  }
  function fnPause() {
    if (!fnRun) return;
    fnRun.paused = !fnRun.paused;
    var b = $("fnPause"); if (b) b.textContent = fnRun.paused ? t("fn_resume") : t("fn_pause");
    if (!fnRun.paused) fnReleasePause();   // Resume → release the parked loop immediately
  }
  function fnDone() {
    fnEnd = Date.now();
    if (fnTimer) { clearInterval(fnTimer); fnTimer = null; }
    fnRun = null;
    if ($("fnStart")) { $("fnStart").style.display = ""; $("fnStop").style.display = "none"; }
    if ($("fnPause")) { $("fnPause").style.display = "none"; $("fnPause").textContent = t("fn_pause"); }
    fnRenderSummary();
  }

  function fnExport() {
    if (!results.length) return;
    var rows = [["Menu", "Action", "Path", "URL", "Status", "Reason", "Button"]];
    results.forEach(function (r) {
      rows.push([r.menu, r.label, r.path, r.url, r.pass ? "Pass" : "Fail", r.reason, ""]);
      (r.actions || []).forEach(function (a) { rows.push([r.menu, r.label, r.path, r.url, a.pass ? "Pass" : "Fail", a.reason, a.label]); });
    });
    var csv = rows.map(function (row) { return row.map(function (c) { return '"' + String(c == null ? "" : c).replace(/"/g, '""') + '"'; }).join(","); }).join("\r\n");
    var blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "Function Check - " + new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-") + ".csv";
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function fnWire() {
    if ($("fnStart")) $("fnStart").addEventListener("click", fnStart);
    if ($("fnStop")) $("fnStop").addEventListener("click", fnStop);
    if ($("fnPause")) $("fnPause").addEventListener("click", fnPause);
    if ($("fnExport")) $("fnExport").addEventListener("click", fnExport);
    if ($("fnSummary")) $("fnSummary").addEventListener("click", function (e) {
      var p = e.target && e.target.closest && e.target.closest("[data-fnf]");
      if (!p) return;
      fnFilter = p.getAttribute("data-fnf") || "all";
      fnRenderSummary(); fnRenderList();
    });
    if ($("fnHttp")) $("fnHttp").addEventListener("click", function () { fnSetMode("http"); });
    if ($("fnBrowser")) $("fnBrowser").addEventListener("click", function () { fnSetMode("browser"); });
    if ($("fnHeadless")) $("fnHeadless").addEventListener("click", function () { fnSetMode("headless"); });
    if ($("fnActions")) $("fnActions").addEventListener("change", function () { try { chrome.storage.local.set({ fnActions: this.checked }); } catch (e) {} });
    var VKEYS = { fnRoll: "fnRoll", fnReg: "fnReg", fnMobile: "fnMobile", fnTpin: "fnTpin", fnPin: "fnPin" };
    // Roll/Reg/Mobile keep a native <datalist> of numbers used before — selecting one RELIABLY sets
    // the field, unlike the browser's flaky tel-autofill (same trick as New Admission's mobile box).
    var DL = { fnRoll: { dl: "fnRollDl", key: "fnRolls" }, fnReg: { dl: "fnRegDl", key: "fnRegs" }, fnMobile: { dl: "fnMobileDl", key: "fnMobiles" } };
    function fillDl(dlId, list) { var dl = $(dlId); if (!dl) return; dl.innerHTML = (list || []).map(function (v) { return '<option value="' + String(v).replace(/"/g, "&quot;") + '">'; }).join(""); }
    function remember(id) {
      var cfg = DL[id]; if (!cfg) return;
      var v = ($(id) && $(id).value || "").trim(); if (!v) return;
      try { chrome.storage.local.get(cfg.key, function (o) {
        var list = (o && o[cfg.key]) || [];
        list = list.filter(function (x) { return x !== v; }); list.unshift(v); if (list.length > 12) list = list.slice(0, 12);
        var s = {}; s[cfg.key] = list; try { chrome.storage.local.set(s); } catch (e) {} fillDl(cfg.dl, list);
      }); } catch (e) {}
    }
    Object.keys(VKEYS).forEach(function (id) {
      var e = $(id); if (!e) return;
      // input covers typing; change/blur catch a browser autofill/datalist pick that doesn't fire input
      var save = function () { var o = {}; o[id] = e.value; try { chrome.storage.local.set(o); } catch (err) {} };
      ["input", "change", "blur"].forEach(function (ev) { e.addEventListener(ev, save); });
      e.addEventListener("blur", function () { remember(id); });
    });
    if ($("fnBase") && !$("fnBase").value) $("fnBase").value = (A.getBaseUrl && A.getBaseUrl()) || "https://ums-4.osl.team";
    if ($("fnBase")) $("fnBase").addEventListener("input", fnConnDebounced);
    fnCheckConn();   // show the login status right away
    try {
      chrome.storage.local.get(["fnMode", "fnActions", "fnRolls", "fnRegs", "fnMobiles"].concat(Object.keys(VKEYS)), function (o) {
        fnSetMode(o && o.fnMode);
        if ($("fnActions")) $("fnActions").checked = !!(o && o.fnActions);
        Object.keys(VKEYS).forEach(function (id) { if (o && o[id] != null && $(id)) $(id).value = o[id]; });
        Object.keys(DL).forEach(function (id) { fillDl(DL[id].dl, (o && o[DL[id].key]) || []); });
      });
    } catch (e) { fnSetMode("http"); }
  }

  A.fn = { wire: fnWire, start: fnStart, stop: fnStop, setMode: fnSetMode,
    // pure helpers exposed for tests
    parseNav: fnParseNav, classify: fnClassify, classifyProbe: fnClassifyProbe };
})();
