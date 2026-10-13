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

  /* ── pacing: the ONE place that defines what Fast and Slow mean ──
     These used to be split across two files (this one chose concurrency + linger, background.js
     re-derived the settle from mode+speed), so the two could drift apart. Everything now comes from
     here and the settle is sent to the background rather than guessed there.
       conc   — pages loaded at once. Headless uses hidden background tabs that all live in one
                existing window, so parallelism costs no extra window or taskbar entry.
       settle — pause after the page reports loaded, before probing it. Small: the navigation wait is
                exact now (background waits for THIS page's load, not a stale "complete").
       linger — deliberate extra pause per page, purely so a human can follow along in Browser mode.
       dwell  — minimum time each button test is held on screen. The probe's waits are event-driven, so
                without a floor a fill+click finishes in ~20-50ms and Browser Slow would be a blur.
                0 everywhere except Browser Slow, which is the mode that exists to be watched.
     Tuning speed is a one-line change here. */
  var PACE = {
    browser:  { fast: { conc: 1, settle: 80,  linger: 0,    dwell: 0 },
                slow: { conc: 1, settle: 500, linger: 2000, dwell: 600 } },   // slow = watchable on purpose
    headless: { fast: { conc: 3, settle: 80,  linger: 0,    dwell: 0 },
                slow: { conc: 1, settle: 150, linger: 300,  dwell: 0 } }      // hidden: nothing to watch
  };
  function pace() {
    var m = PACE[fnMode === "headless" ? "headless" : "browser"];
    return m[fnSpeed === "slow" ? "slow" : "fast"];
  }
  // widest this mode ever runs — slots are sized for it so the pool can widen again if the user
  // switches back to Fast part-way through a run
  function paceMaxConc() {
    var m = PACE[fnMode === "headless" ? "headless" : "browser"];
    return Math.max(m.fast.conc, m.slow.conc);
  }
  var fnRun = null;              // { stop } while a crawl is going
  var fnAborted = false;         // latched by Stop — every loop/pool/visit bails on it even if fnRun is cleared
  var fnWantActions = false;     // the user's own choice, kept apart from what the box can show: HTTP
                                 // cannot click anything, so there the box reads unchecked regardless
  var fnPort = null;             // live only during a run; its disconnect tells the background to clean up
  var fnGen = 0;                 // bumped per run — an older loop that was parked in an await sees its
                                 // generation go stale and bails instead of resuming into the new run
  // Pass the run's own gen so a stale loop can never be "un-stopped" by a fresh run clearing fnAborted.
  function fnStopped(gen) {
    if (gen !== undefined && gen !== fnGen) return true;   // not the current run → treat as stopped
    return fnAborted || !!(fnRun && fnRun.stop);
  }
  var fnMode = "http";           // http | browser | headless

  var fnSpeed = "fast";   // fast | slow — Browser-mode pacing
  function fnSetMode(m) {
    fnMode = (m === "browser" || m === "headless") ? m : "http";
    [["fnHttp", "http"], ["fnBrowser", "browser"], ["fnHeadless", "headless"]].forEach(function (p) {
      var b = $(p[0]); if (b) b.classList.toggle("on", fnMode === p[1]);
    });
    if ($("fnSpeedSeg")) $("fnSpeedSeg").style.display = (fnMode === "browser" || fnMode === "headless") ? "" : "none";   // Fast/Slow applies to the real-load modes
    /* Button testing needs a live DOM. HTTP mode only fetches the HTML — no tab, no JavaScript, so
       there is literally nothing to click and the checkbox was being ignored in silence. Disable it
       there (keeping its ticked state for when the user switches back) and say why on hover. */
    var ab = $("fnActions"), al = ab && ab.closest ? ab.closest(".fnact") : null;
    if (ab) {
      // show it unchecked in HTTP — a ticked box there would promise a test that cannot happen — and
      // restore the user's actual choice on the way back to Browser/Headless
      ab.checked = (fnMode === "http") ? false : fnWantActions;
      ab.disabled = (fnMode === "http");
    }
    if (al) {
      al.classList.toggle("off", fnMode === "http");
      al.setAttribute("data-title", fnMode === "http" ? "fn_actions_http" : "fn_actions_t");
      al.title = t(al.getAttribute("data-title"));
    }
    // the value boxes only feed the button test, so they go dim with it rather than looking live
    var vs = $("fnVals");
    if (vs) {
      vs.classList.toggle("off", fnMode === "http");
      vs.querySelectorAll("input").forEach(function (i) { i.disabled = (fnMode === "http"); });
    }
    try { chrome.storage.local.set({ fnMode: fnMode }); } catch (e) {}
  }
  function fnSetSpeed(s) {
    fnSpeed = (s === "slow") ? "slow" : "fast";
    if ($("fnFast")) $("fnFast").classList.toggle("on", fnSpeed === "fast");
    if ($("fnSlow")) $("fnSlow").classList.toggle("on", fnSpeed === "slow");
    try { chrome.storage.local.set({ fnSpeed: fnSpeed }); } catch (e) {}
    // Switching mid-run is honoured: settle/dwell/linger are re-read per page anyway, and this wakes
    // the pool so a widening (Slow -> Fast) starts its extra workers now rather than after the next page.
    try { if (fnRun && fnRun._wake) fnRun._wake(); } catch (e) {}
  }

  /* ---- what counts as a checkable page link ---- */
  // state-changing or non-HTML hrefs are never opened, even though they are GETs — the crawl only
  // OPENS pages, so anything that could save/delete/send or hand back a file is skipped for safety
  var SKIP_HREF = /(log\s*-?\s*(out|off)|sign\s*-?\s*out|\/account\/log|\/logout|\/logoff|delete|remove|destroy|\bdrop\b|approve|activate|deactivate|\bvoid\b|\benable\b|\bdisable\b|\breset\b|generate|\bsend\b|export|download|\/print|\.(pdf|xlsx?|csv|zip|docx?|pptx?|png|jpe?g|gif)(\?|$))/i;
  var ORIGIN = function (u) { try { return new URL(u).origin; } catch (e) { return ""; } };

  /* Matching those words anywhere in the path skipped real pages, because in UMS the word usually
     names the CONTROLLER, not the action that runs: /Administration/GenerateExamCache/Index is a
     page called Index, and /Exam/ExamMcqQuestionSetPrint/PrintReport is a report ABOUT printing.
     A sweep of ums-3/ums-4 dropped 38 links this way, and 20 of them are URLs the Selenium suite
     itself opens as pages. So the word has to sit in the ACTION — the last path segment, which is
     what ASP.NET actually invokes — and an action whose name ends in a view word is a page whatever
     else the path says. Ambiguous ones are still not opened; they are reported as skipped instead,
     because a GET of e.g. /BulkUserLogout/BulkLogout really would log everyone out. */
  var VIEW_ACTION = /(index|manage|report|logs?|list|dashboard|details|summary|statistics|analyz(e|er)|permission|history|settings?)$/i;
  function fnSkipHref(path) {
    var clean = String(path || "").split("#")[0];
    var noQuery = clean.split("?")[0];
    // a file download is decided by the whole path, not the action name
    if (/\.(pdf|xlsx?|csv|zip|docx?|pptx?|png|jpe?g|gif)(\?|$)/i.test(clean)) return true;
    var parts = noQuery.split("/").filter(Boolean);
    // MVC puts the id last — /Exam/Thing/Delete/42 — so a trailing id must not hide the action
    // behind it, or the one case this guard exists for walks straight through.
    while (parts.length > 1 && /^(\d+|[0-9a-f-]{8,})$/i.test(parts[parts.length - 1])) parts.pop();
    var seg = parts.pop() || "";
    if (!seg) return false;
    if (VIEW_ACTION.test(seg)) return false;
    return SKIP_HREF.test("/" + seg);
  }
  // Links this run refused to open, so the panel can show them instead of quietly covering 734 of
  // 772 links and leaving the rest invisible.
  var fnSkipped = [];

  /* The top-level UMS menu a path belongs to, and the order the user wants them checked in:
     Student → Administration → Exam → Teacher → CRM → Team → Inventory. CRM lives UNDER /Student
     (…/CrmConversation/…), so it is matched first; Team is /Hr, Inventory is /UInventory. */
  var MENU_ORDER = ["Student", "Administration", "Exam", "Teacher", "CRM", "Team", "Inventory", "Other"];
  function fnTopMenu(path) {
    var p = String(path || "").toLowerCase();
    // Bucket by the area a page actually LIVES in, i.e. its first path segment. The loose CRM test
    // used to run FIRST, so any URL merely containing "crm" - /Student/Report/CrmWiseStudent - was
    // filed under CRM. That was a cosmetic grouping wart until areas began deciding what gets opened
    // at all; after that it silently skipped real Student pages. It now runs last, so a CRM page
    // outside a /crm prefix is still caught, but only once no real area prefix has claimed it.
    if (/^\/administration/.test(p)) return "Administration";
    if (/^\/exam/.test(p)) return "Exam";
    if (/^\/teacher/.test(p)) return "Teacher";
    if (/^\/hr(\/|$)/.test(p)) return "Team";
    if (/^\/(u)?inventor/.test(p)) return "Inventory";
    if (/^\/student/.test(p)) return "Student";
    if (/crm/.test(p)) return "CRM";
    return "Other";
  }
  function fnMenuRank(path) { var i = MENU_ORDER.indexOf(fnTopMenu(path)); return i < 0 ? MENU_ORDER.length : i; }

  /* ---- the Area picker ---- */
  // Which top-level menus this run covers. Empty means every one of them — that is also what the
  // box ships as, so a user who never opens the picker keeps the old whole-site behaviour.
  var fnAreas = [];
  function fnAreaWanted(path) { return !fnAreas.length || fnAreas.indexOf(fnTopMenu(path)) >= 0; }
  // Read the ticks into fnAreas, repaint the summary, and keep "All areas" honest: it is on exactly
  // when nothing else is, because those two say the same thing and must not both look chosen.
  function fnAreaSync(save) {
    var boxes = document.querySelectorAll(".fnareabox");
    var picked = [];
    for (var i = 0; i < boxes.length; i++) if (boxes[i].checked) picked.push(boxes[i].value);
    fnAreas = picked;
    var all = $("fnAreaAll");
    if (all) all.checked = !picked.length;
    var sum = $("fnAreaSum");
    if (sum) {
      sum.textContent = !picked.length ? t("fn_area_all")
        : (picked.length === 1 ? t("fn_area_" + picked[0].toLowerCase())
                               : String(picked.length) + t("fn_area_n"));
    }
    if (save) { try { chrome.storage.local.set({ fnAreas: fnAreas }); } catch (e) {} }
  }
  function fnAreaRestore(list) {
    var want = {}; (list || []).forEach(function (a) { want[a] = 1; });
    var boxes = document.querySelectorAll(".fnareabox");
    for (var i = 0; i < boxes.length; i++) boxes[i].checked = !!want[boxes[i].value];
    fnAreaSync(false);
  }

  /* Pull EVERY link out of the page — menus, sub-menus and any other navigational <a href>. Server-
     rendered UMS keeps every sidebar/submenu <a> in the markup (collapsed ones are only hidden by
     CSS), and sub-menus can sit outside the main nav container, so the whole document is scanned
     rather than one sidebar box — that is why some sub-menus were missed before. Same-origin,
     navigational links only; logout/delete/export/file links are dropped (see SKIP_HREF). The menu
     group is the nearest enclosing list's own label, so the report can still be grouped. */
  // Turn a bare/uninformative link label into something a person can read in the report. Many UMS
  // links use the figure itself as their text (e.g. an achievement count "2 (2%)"), which tells the
  // reader nothing about WHICH page it is — so when the label has no real word we build a name from
  // the URL path (the action, de-camel-cased) and keep the original figure + a branch/session hint.
  function fnDecamel(s) {
    return String(s || "").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\-]+/g, " ").replace(/\s+/g, " ").trim();
  }
  function fnPathName(path) {
    var p = String(path || "").split("#")[0].split("?")[0].replace(/\/+$/, "");
    var segs = p.split("/").filter(Boolean);
    var last = segs.length ? segs[segs.length - 1] : p;
    if (/^(index|list|home|default|report)$/i.test(last) && segs.length >= 2) last = segs[segs.length - 2];
    try { last = decodeURIComponent(last); } catch (e) {}
    return fnDecamel(last) || p;
  }
  function fnQueryHint(path) {
    var q = String(path || "").split("?")[1]; if (!q) return "";
    var m = {};
    q.split("&").forEach(function (kv) { var i = kv.indexOf("="); if (i > 0) { try { m[kv.slice(0, i).toLowerCase()] = decodeURIComponent(kv.slice(i + 1)); } catch (e) {} } });
    var h = [];
    if (m.branchid) h.push("branch " + m.branchid);
    if (m.sessionid) h.push("session " + m.sessionid);
    if (!h.length && m.id) h.push("#" + m.id);
    return h.join(", ");
  }
  function fnLabelGood(s) { return !!s && /[A-Za-zঀ-৿]{3,}/.test(s); }   // has a real word (latin or bangla)
  function fnNiceName(label, path) {
    label = (label || "").trim();
    if (fnLabelGood(label)) return label;
    var base = fnPathName(path);
    var extra = [];
    if (label) extra.push(label);              // keep the raw figure, e.g. "2 (2%)"
    var hint = fnQueryHint(path); if (hint) extra.push(hint);
    return extra.length ? base + " — " + extra.join(" · ") : base;
  }
  // Why a link was refused, in the words the reader needs: what it looked like, so they can judge
  // whether it is actually a page the sweep should have covered.
  function fnNoteSkip(path, label) {
    if (fnSkipped.some(function (s) { return s.path === path; })) return;
    var why = /\.(pdf|xlsx?|csv|zip|docx?|pptx?|png|jpe?g|gif)(\?|$)/i.test(path) ? "file"
      : /log\s*-?\s*(out|off)|sign\s*-?\s*out/i.test(path) ? "logout" : "action";
    fnSkipped.push({ path: path, label: label || "", why: why, menu: fnTopMenu(path) });
  }

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
      var key0 = url.split("#")[0];
      if (fnSkipHref(path)) {                            // logout / delete / files — and say so
        if (!seen[key0]) { seen[key0] = 1; fnNoteSkip(path, (a.textContent || "").replace(/\s+/g, " ").trim()); }
        continue;
      }
      var key = key0;
      if (seen[key]) continue; seen[key] = 1;
      var label = (a.textContent || "").replace(/\s+/g, " ").trim();
      out.push({ menu: fnGroupOf(a), label: fnNiceName(label, path), url: key, path: path });
    }
    // Also follow GET-form "Add / Create" buttons (e.g. Branch's Add → /…/Branch/Create), which are
    // not <a href> so the anchor scan misses them. Only GET forms — a POST form would submit data.
    var forms = scope.querySelectorAll("form");
    for (var fi = 0; fi < forms.length && out.length < MAX_LINKS; fi++) {
      var f = forms[fi];
      if (((f.getAttribute("method") || "get").toLowerCase()) !== "get") continue;
      var act = f.getAttribute("action") || "";
      if (!act) continue;
      var furl; try { furl = new URL(act, baseUrl).href; } catch (e) { continue; }
      if (ORIGIN(furl) !== origin) continue;
      var fpath = furl.slice(origin.length);
      if (fpath === "" || fpath === "/" || fnSkipHref(fpath)) continue;
      var fkey = furl.split("#")[0];
      if (seen[fkey]) continue; seen[fkey] = 1;
      var sb = f.querySelector('[type="submit"], button');
      var flabel = ((sb && (sb.value || sb.textContent)) || "").replace(/\s+/g, " ").trim();
      out.push({ menu: fnGroupOf(f), label: fnNiceName(flabel, fpath), url: fkey, path: fpath });
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
  // what a status code actually means here, so "HTTP 404" is not the whole story
  var HTTP_WHY = {
    400: "সার্ভার রিকোয়েস্টটা বুঝতে পারেনি",
    401: "লগইন ছাড়া ঢোকা যাবে না",
    403: "ঢোকার অনুমতি নেই",
    404: "এই ঠিকানায় সার্ভারে কিছু নেই",
    405: "এই ঠিকানা GET-এ খোলা যায় না",
    408: "সার্ভার সময়মতো সাড়া দেয়নি",
    500: "সার্ভারের কোড ক্র্যাশ করেছে",
    502: "সামনের সার্ভার পেছনেরটার সাড়া পায়নি",
    503: "সার্ভিস বন্ধ বা অতিরিক্ত ব্যস্ত",
    504: "পেছনের সার্ভার সময়মতো সাড়া দেয়নি"
  };
  /* The long form, shown on hover. It must ADD to the row, never repeat it — the row already states
     what happened, so these say only why it happens and what to do about it. */
  var HTTP_HELP = {
    401: "সেশন ফুরিয়েছে অথবা এই অ্যাকাউন্টের অধিকার নেই। ব্রাউজারে আবার লগইন করে দেখো।",
    403: "লগইন আছে, বাধাটা রোলের। অন্য রোলে পরীক্ষা করে দেখো।",
    404: "সম্ভাব্য কারণ দুটি — (১) মেনুর লিংকটি পুরোনো, পেজটি সরানো বা নাম বদলানো হয়েছে; (২) এটি খোলার মতো পেজই নয়, বাটন থেকে POST/AJAX-এ ডাকা একটি অ্যাকশন, যা সরাসরি খুললে 404 দেয়।",
    405: "ঠিকানাটি আছে, শুধু POST নেয় — অর্থাৎ বাটনের অ্যাকশন। এমন হলে সাধারণত সমস্যা নয়।",
    500: "সত্যিকারের বাগ — ডেভেলপারকে জানাও।",
    503: "রিস্টার্ট বা অতিরিক্ত চাপে সাময়িক। কিছুক্ষণ পরে আবার চালিয়ে দেখো।"
  };
  /* An ASP.NET / IIS error page carries the real cause in its body — the exception type and message,
     the source file and line, which IIS module refused it. Reporting only "HTTP 500" throws all of
     that away, so dig the pinpoint reason out and put it in the row. */
  function fnErrDetail(html) {
    var h = String(html || ""), out = [], m;
    var strip = function (s) {
      return String(s || "").replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/gi, " ").replace(/&quot;/gi, '"').replace(/&#39;/g, "'")
        .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&amp;/gi, "&")
        .replace(/\s+/g, " ").trim();
    };
    // "Exception Details: System.NullReferenceException: Object reference not set to an instance..."
    if ((m = /Exception Details:\s*(?:<\/b>)?\s*([^<\n]{3,300})/i.exec(h))) out.push(strip(m[1]));
    // ASP.NET's one-line summary, e.g. <h2><i>Object reference not set…</i></h2>
    if (!out.length && (m = /<h2>\s*<i>([\s\S]{3,300}?)<\/i>\s*<\/h2>/i.exec(h))) out.push(strip(m[1]));
    // IIS: "HTTP Error 404.0 - Not Found"
    if (!out.length && (m = /HTTP Error\s+[\d.]+\s*-\s*([^<\n]{2,120})/i.exec(h))) out.push(strip(m[0]));
    // where it blew up: Foo.cs:42
    if ((m = /Source File:\s*(?:<\/b>)?\s*([^<\n]{3,200}?)\s*(?:<b>)?[^<]{0,20}Line:\s*(?:<\/b>)?\s*(\d+)/i.exec(h))) {
      out.push(strip(m[1]).split(/[\\/]/).pop() + ":" + m[2]);
    }
    // IIS detailed-error table: which module rejected it
    if ((m = /<th>\s*Module\s*<\/th>\s*<td>([^<]{1,80})<\/td>/i.exec(h))) out.push("Module " + strip(m[1]));
    // last resort: the error page's own title
    if (!out.length && (m = /<title>([^<]{3,160})<\/title>/i.exec(h))) {
      var ti = strip(m[1]);
      if (ti && !/^(error|untitled)$/i.test(ti)) out.push(ti);
    }
    return out.join(" · ").slice(0, 220);
  }
  function fnClassify(res, baseUrl) {
    var status = res.status || 0;
    var html = res.html || "";
    var finalUrl = res.finalUrl || "";
    if (res.error) return { pass: false, reason: "লোড হয়নি — " + res.error, kind: "net" };
    if (status >= 400) {
      // the error page body usually names the real cause — don't throw it away
      var why = HTTP_WHY[status] ? " — " + HTTP_WHY[status] : "";
      var det = fnErrDetail(html);
      var help = HTTP_HELP[status] || "";
      // Say so when the server sent no error page at all: that is why there is nothing more to show,
      // rather than the check having failed to look.
      if (!det) help += (help ? " " : "") + "(কোনো error পেজ আসেনি, তাই বাড়তি বিস্তারিত নেই।)";
      return { pass: false, reason: "HTTP " + status + why + (det ? " — " + det : ""), help: help, kind: "http" };
    }
    // a redirect that lands on the login page = the session is gone / no access
    if ((res.redirected && LOGIN_URL.test(finalUrl)) || (LOGIN_URL.test(finalUrl) && ORIGIN(finalUrl) === ORIGIN(baseUrl) && finalUrl !== baseUrl)) {
      return { pass: false, reason: "লগইন পেজে রিডাইরেক্ট — সেশন/অ্যাক্সেস নেই", kind: "login" };
    }
    if (ERR_MARK.test(html)) {
      // prefer the exception/source-line detail; fall back to the marker that matched
      var det2 = fnErrDetail(html);
      var m = ERR_MARK.exec(html);
      return { pass: false, reason: det2 ? "পেজে error: " + det2 : ("পেজে error/exception: “" + (m ? m[0] : "error").slice(0, 60) + "”"), kind: "page" };
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
    // errDetail is the exception type/message + source line lifted off the .NET error page
    if (probe.serverErr) {
      var d = probe.errDetail || probe.errText || "";
      return { pass: false, reason: "সার্ভার exception" + (d ? ": " + String(d).slice(0, 220) : ""), kind: "page" };
    }
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
  var fnConnSeq = 0, fnConnTimer = null, fnConnState = "";
  function fnSetConn(state) {
    fnConnState = state || "";
    var el = $("fnConn"); if (!el) return;
    el.className = "fnconn" + (fnConnState ? " " + fnConnState : "");
    el.textContent = fnConnState === "ok" ? t("fn_logged") : fnConnState === "no" ? t("fn_notlogged") : fnConnState === "chk" ? t("fn_conn_chk") : "";
  }
  // re-render everything this module writes from JS (data-i18n only covers the static markup)
  function fnRelang() { fnSetConn(fnConnState); fnSetMode(fnMode); fnAreaSync(false); fnRenderSummary(); fnRenderList(); }
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

  /* ── failures marked "As Pass" ──
     Some failures are known and fine (a menu that is genuinely retired, a page only one role can
     open). Marking one keeps it out of the Fail count without pretending the check passed: the row
     still shows WHY it failed, just as knowingly allowed. Marks are stored per server, so a re-run of the same
     UMS keeps them and a different UMS starts clean. */
  var fnMarks = {}, fnMarksOrigin = "";
  function fnMarksLoad(cb) {
    var o = ""; try { o = ORIGIN(fnBase()); } catch (e) {}
    fnMarksOrigin = o;
    try {
      chrome.storage.local.get("fnMarks", function (d) {
        var all = (d && d.fnMarks) || {};
        fnMarks = (o && all[o]) || {};
        if (cb) cb();
      });
    } catch (e) { fnMarks = {}; if (cb) cb(); }
  }
  function fnMarksSave() {
    if (!fnMarksOrigin) return;
    try {
      chrome.storage.local.get("fnMarks", function (d) {
        var all = (d && d.fnMarks) || {};
        all[fnMarksOrigin] = fnMarks;
        try { chrome.storage.local.set({ fnMarks: all }); } catch (e) {}
      });
    } catch (e) {}
  }
  function fnOk(r) { return !!(r && (r.pass || fnMarks[r.path])); }      // effective verdict
  function fnMarked(r) { return !!(r && !r.pass && fnMarks[r.path]); }   // failed, but marked As Pass
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
    var pass = results.filter(fnOk).length;          // As Pass rows count as OK here
    var marked = results.filter(fnMarked).length;    // ...but are still shown separately
    var fail = results.length - pass;
    // nothing to export until there is a result — better than a button that looks live and silently
    // does nothing when clicked
    var ex = $("fnExport"); if (ex) ex.disabled = !results.length;
    var s = $("fnSummary"); if (!s) return;
    if (!(results.length || fnRun)) { s.innerHTML = ""; return; }
    // Build the pills ONCE, then update text/active-class IN PLACE. Rebuilding innerHTML every result
    // (many per second) kept destroying the element under the user's click, so filtering "didn't
    // select" during a run. Keeping the elements stable means a click always lands.
    var tp = s.querySelector(".fntime"), pp = s.querySelector('[data-fnf="pass"]'),
        fp = s.querySelector('[data-fnf="fail"]'), ap = s.querySelector('[data-fnf="all"]');
    if (!pp) {
      s.innerHTML =
        '<span class="fnpill fntime" style="background:rgba(245,179,1,.16);color:#e0a81e"></span> '
        + '<span class="fnpill ok fnf" data-fnf="pass" title="শুধু Pass দেখাও"></span> '
        + '<span class="fnpill bad fnf" data-fnf="fail" title="শুধু Fail দেখাও"></span> '
        + '<span class="fnpill fnf" data-fnf="marked" style="background:rgba(245,179,1,.16);color:#e0a81e"></span> '
        + '<span class="fnpill fnf" data-fnf="skipped" style="background:rgba(91,140,255,.16);color:#7ba2ff"></span> '
        + '<span class="fnpill fnf" data-fnf="all" title="সব দেখাও" style="background:rgba(127,127,127,.14);color:var(--mut)"></span>';
      tp = s.querySelector(".fntime"); pp = s.querySelector('[data-fnf="pass"]');
      fp = s.querySelector('[data-fnf="fail"]'); ap = s.querySelector('[data-fnf="all"]');
    }
    var mp = s.querySelector('[data-fnf="marked"]');
    if (mp) {
      mp.style.display = marked ? "" : "none";
      mp.textContent = "⚑ " + marked + " " + t("fn_accepted");
      mp.title = t("fn_accepted_t");
      mp.classList.toggle("fnon", fnFilter === "marked");
    }
    // Skipped links are part of the answer, not an omission: without this the panel says "734 pages"
    // and never mentions the 38 it would not open.
    var sp = s.querySelector('[data-fnf="skipped"]');
    if (sp) {
      sp.style.display = fnSkipped.length ? "" : "none";
      sp.textContent = "⤼ " + fnSkipped.length + " " + t("fn_skipped");
      sp.title = t("fn_skipped_t");
      sp.classList.toggle("fnon", fnFilter === "skipped");
    }
    if (tp) tp.style.display = fnT0 ? "" : "none";
    if (tp) tp.textContent = "⏱ " + fnElapsed();
    pp.textContent = "✓ " + pass + " Pass"; pp.classList.toggle("fnon", fnFilter === "pass");
    fp.textContent = "✗ " + fail + " Fail"; fp.classList.toggle("fnon", fnFilter === "fail");
    ap.textContent = "/ " + results.length; ap.classList.toggle("fnon", fnFilter === "all");
  }
  function fnRenderList() {
    var box = $("fnList"); if (!box) return;
    if (!results.length) { box.innerHTML = ""; return; }

    // The skipped list is its own view: these were never opened, so they have no Pass/Fail to sort
    // among the rest. Shown so a page that only LOOKS like an action can be spotted and checked by
    // hand — about half of what UMS drops here turned out to be real pages.
    if (fnFilter === "skipped") {
      if (!fnSkipped.length) { box.innerHTML = '<div class="mut" style="padding:10px">' + t("fn_skip_none") + '</div>'; return; }
      var sg = {};
      fnSkipped.forEach(function (s) { (sg[s.menu] = sg[s.menu] || []).push(s); });
      var shtml = '<div class="mut" style="padding:8px 2px 10px;font-size:12.5px">' + esc(t("fn_skip_intro")) + '</div>';
      Object.keys(sg).forEach(function (g) {
        shtml += '<div class="fngrp"><div class="fnghead">' + esc(g) + ' <span class="mut">(' + sg[g].length + ')</span></div>';
        sg[g].forEach(function (s) {
          // same row vocabulary as a result row, so the two lists read alike: mark, link, path, why
          shtml += '<div class="fnrow">' +
            '<span class="fnst mut">⤼</span>' +
            '<a class="fnlk" href="' + esc(fnBase().replace(/\/$/, "") + s.path) + '" target="_blank" rel="noopener">' +
            esc(s.label || s.path) + '</a>' +
            '<span class="fnpath mut">' + esc(s.path) + '</span>' +
            '<span class="fnwhy">' + esc(t("fn_skip_" + s.why)) + '</span></div>';
        });
        shtml += "</div>";
      });
      box.innerHTML = shtml;
      return;
    }

    // group by menu, fails first inside each group; honour the Pass/Fail filter
    var shown = results.filter(function (r) {
      if (fnFilter === "pass") return fnOk(r);
      if (fnFilter === "fail") return !fnOk(r);
      if (fnFilter === "marked") return fnMarked(r);
      return true;
    });
    if (!shown.length) { box.innerHTML = '<div class="mut" style="padding:10px">' + (fnFilter === "fail" ? "কোনো Fail নেই 🎉" : "কিছু দেখানোর নেই") + '</div>'; return; }
    var groups = {};
    shown.forEach(function (r) { (groups[r.menu] = groups[r.menu] || []).push(r); });
    var html = "";
    Object.keys(groups).forEach(function (g) {
      var rows = groups[g].slice().sort(function (a, b) { return (fnOk(a) ? 1 : 0) - (fnOk(b) ? 1 : 0); });
      var gf = rows.filter(function (r) { return !fnOk(r); }).length;
      html += '<div class="fngrp"><div class="fnghead">' + esc(g) + ' <span class="mut">(' + rows.length + ')</span>' +
        (gf ? ' <span class="fnpill bad">✗ ' + gf + '</span>' : ' <span class="fnpill ok">✓</span>') + '</div>';
      rows.forEach(function (r) {
        var acts = "";
        if (r.actions && r.actions.length) {
          acts = '<div class="fnacts">' + r.actions.map(function (a) {
            // A validation answer passes — the button fired — but it is not the same as "ok": the
            // value the probe made up was rejected, which the reader may want to follow up. So it
            // gets its own mark instead of hiding among the ticks.
            var cls = a.validation ? "v" : (a.pass ? "p" : "f");
            return '<div class="fnactrow ' + cls + '"><span class="fnst">' + (a.validation ? "!" : (a.pass ? "✓" : "✗")) +
              '</span><span class="fnactlbl">' + esc(a.label) + '</span><span class="fnactwhy">— ' + esc(a.reason) + '</span>' +
              (a.shot ? '<a class="fnshot" href="' + a.shot + '" target="_blank" title="স্ক্রিনশট — খুলতে ক্লিক করো">📷 Screenshot ↗</a>' : "") +
              '</div>';
          }).join("") + '</div>';
        }
        // A failed row carries a toggle on the right so a known-OK failure can be accepted. A marked
        // row still shows its reason — it is "As Pass", not actually passing.
        var mk = fnMarked(r), cls = r.pass ? "p" : (mk ? "m" : "f");
        var btn = r.pass ? "" :
          '<button class="fnmark' + (mk ? " on" : "") + '" data-mp="' + esc(r.path) + '" title="' +
          esc(t(mk ? "fn_unmark_t" : "fn_mark_t")) + '">' +
          esc(t(mk ? "fn_unmark" : "fn_mark")) + '</button>';
        html += '<div class="fnrow ' + cls + '">' +
          '<span class="fnst">' + (r.pass ? "✓" : (mk ? "⚑" : "✗")) + '</span>' +
          '<a class="fnlk" href="' + esc(r.url) + '" target="_blank" rel="noopener">' + esc(r.label) + '</a>' +
          '<span class="fnpath mut">' + esc(r.path) + '</span>' +
          (r.shot ? '<a class="fnshot" href="' + r.shot + '" target="_blank" title="স্ক্রিনশট — খুলতে ক্লিক করো">📷 Screenshot ↗</a>' : "") +
          btn +
          (r.pass ? "" : '<span class="fnwhy' + (r.help ? " hashelp" : "") + '"' +
            (r.help ? ' title="' + esc(r.help) + '"' : "") + '>' + esc(r.reason) + '</span>') +
          (r.warn ? '<span class="fnwarn">⚠ ' + esc(r.warn) + '</span>' : "") +
          acts +
          '</div>';
      });
      html += '</div>';
    });
    box.innerHTML = html;
  }

  // n may be a number or a function, so a caller whose width can change mid-run (Fast/Slow switching
  // the Headless concurrency) is re-asked each time instead of being frozen at the first value.
  function pool(items, n, worker, onEach, gen) {
    var width = (typeof n === "function") ? n : function () { return n; };
    return new Promise(function (resolve) {
      var i = 0, active = 0, done = 0;
      function next() {
        if (fnStopped(gen)) { resolve(); return; }   // stop immediately — don't wait for in-flight visits to drain
        if (fnRun) fnRun._wake = next;   // so a mid-run speed change can widen the pool immediately
        if (fnRun && fnRun.paused) { fnRun._resume = next; return; }   // park until Resume fires next()
        while (active < width() && i < items.length) {
          var idx = i++; active++;
          worker(items[idx], idx).then(function (r) { onEach(r, idx); }).catch(function () {}).then(function () {
            active--; done++;
            if (done === items.length || (fnStopped(gen) && active === 0)) resolve(); else next();
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

  // Same guards as fnVisit: Stop must not leave the loop parked here. The background can sit in
  // waitTabComplete for 25s on a tab that fnShotClose already removed, so bound it and bail on Stop.
  function fnShot(url, gen) {
    return new Promise(function (resolve) {
      var done = false;
      var fin = function (r) { if (done) return; done = true; clearTimeout(to); clearInterval(stopChk); resolve(r); };
      var to = setTimeout(function () { fin(null); }, 40000);
      var stopChk = setInterval(function () { if (fnStopped(gen)) fin(null); }, 200);
      try {
        chrome.runtime.sendMessage({ type: "fnShot", url: url }, function (resp) {
          if (done) { void chrome.runtime.lastError; return; }
          if (chrome.runtime.lastError) { fin(null); return; }
          fin(resp || null);
        });
      } catch (e) { fin(null); }
    });
  }
  function fnVisit(url, mode, base, actions, vals, slot, P, gen) {
    return new Promise(function (resolve) {
      var done = false;
      // a page that blocks (a native dialog, an endless script) must NOT hang the whole crawl — if the
      // background does not answer in time, give up on this one and move on.
      // must exceed the background worst case (waitTabComplete 25s + probe 12s + action probe race),
      // or the slot would be freed and reused while the background is still driving that window
      var fin = function (r) { if (done) return; done = true; clearTimeout(to); if (stopChk) clearInterval(stopChk); resolve(r); };
      var to = setTimeout(function () { fin({ ok: false, error: "timeout — পেজ সাড়া দেয়নি (120s)" }); }, 120000);
      // Stop must feel instant: give up on this visit within 200ms of Stop instead of waiting for the
      // background (fnStop closes the visit tab/window, so the in-flight visit ends on its own).
      var stopChk = setInterval(function () { if (fnStopped(gen)) fin({ ok: false, error: "stopped" }); }, 200);
      try {
        chrome.runtime.sendMessage({ type: "fnVisit", url: url, mode: mode, base: base, actions: actions, vals: vals, slot: slot || 0, pace: { settle: P.settle, dwell: P.dwell } }, function (resp) {
          if (done) { void chrome.runtime.lastError; return; }
          var le = chrome.runtime.lastError;
          fin(le ? { ok: false, error: le.message || "no response (এক্সটেনশন পুরো Reload করো)" } : (resp || { ok: false, error: "empty response" }));
        });
      } catch (e) { fin({ ok: false, error: String(e && e.message || e) }); }
    });
  }

  // Event-driven, not a poll: a backgrounded panel (Browser mode steals focus) throttles setTimeout,
  // which could leave a poll-based wait stuck after Resume. Instead we park the loop on a resolver
  // that the Resume/Stop click fires directly.
  function waitIfPaused(gen) {
    if (!fnRun || !fnRun.paused || fnStopped(gen)) return Promise.resolve();
    return new Promise(function (resolve) { fnRun._resume = resolve; });
  }
  function fnReleasePause() { if (fnRun && fnRun._resume) { var r = fnRun._resume; fnRun._resume = null; r(); } }
  async function fnStart() {
    if (fnRun) return;
    fnAborted = false;
    fnMarksLoad();   // As Pass marks for THIS server, so a re-run keeps them
    var gen = ++fnGen;   // this run's identity — every check below is scoped to it
    fnRun = { stop: false, paused: false };
    // Hold a port open for the run. If this panel is closed mid-run the port disconnects and the
    // background closes the visit tab/window — otherwise it would be orphaned in the user's window.
    try { fnPort = chrome.runtime.connect({ name: "fnrun" }); } catch (e) { fnPort = null; }
    results = []; fnFilter = "all"; fnSkipped = [];   // skips belong to this run, not the last one
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
        $("fnNote").textContent = t("fn_login"); fnDone(gen); return;
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
        if (tm === "Student" || tm === "Other") return;
        // A section the user did not tick is never opened at all — that is where the time goes, so
        // a narrowed run is genuinely shorter rather than crawling everything and filtering after.
        if (!fnAreaWanted(l.path)) return;
        if (!roots[tm] || l.path.length < roots[tm].length) roots[tm] = l.path;
      });
      var rootList = Object.keys(roots);
      for (var ri = 0; ri < rootList.length; ri++) {
        if (fnStopped(gen)) break;
        await waitIfPaused(gen); if (fnStopped(gen)) break;
        fnProgress(ri, rootList.length, t("fn_sections"));
        try {
          var secUrl = new URL(roots[rootList[ri]], base).href;
          var sec = await fetchHtml(secUrl);
          fnParseNav(sec.html, base).forEach(function (l) { if (!seenUrls[l.url]) { seenUrls[l.url] = 1; links.push(l); } });
        } catch (e) {}
      }
    } catch (e) {
      $("fnNote").textContent = t("fn_fail") + " — " + String(e && e.message || e); fnDone(gen); return;
    }
    if (!links.length) { $("fnNote").textContent = t("fn_nomenu"); fnDone(gen); return; }
    // Keep only the ticked areas. The sections above were already skipped, but the home page hands
    // back Student's whole sidebar and the top-nav links whatever is ticked, so they are dropped here.
    if (fnAreas.length) {
      links = links.filter(function (l) { return fnAreaWanted(l.path); });
      if (!links.length) { $("fnNote").textContent = t("fn_area_none"); fnDone(gen); return; }
    }
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
      }, gen);
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
      /* Pacing is read fresh for EVERY page, never captured once, so clicking Fast/Slow mid-run really
         takes effect (from the next page onward) instead of just repainting the button. Slots are
         allocated for the widest speed this mode can use, since the pool width can now grow as well as
         shrink while the run is going. */
      var freeSlots = []; for (var si = 0; si < paceMaxConc(); si++) freeSlots.push(si);
      fnProgress(0, total, t("fn_visiting"));
      await pool(links, function () { return pace().conc; }, function (link) {
        var slot = freeSlots.length ? freeSlots.pop() : 0;
        return fnVisit(link.url, fnMode, base, doActions, vals, slot, pace(), gen).then(async function (v) {
          freeSlots.push(slot);
          var c = (v && v.ok) ? fnClassifyProbe(v.probe) : { pass: false, reason: "লোড হয়নি" + (v && v.error ? " — " + v.error : ""), kind: "net" };
          /* A 404 told as "Frame with ID 0 is showing error page" is Chrome explaining its own API to
             the wrong audience: that string is what executeScript says when the tab is on an error
             page, and it names neither the status nor the address. HTTP mode words the same page as
             "HTTP 404 — nothing at this address", so ask it and use its answer. */
          if (!c.pass && c.kind === "net" && /error page|cannot access|no tab with id|frame with id/i.test(c.reason || "")) {
            try {
              var http = await fnCheckUrl(link);
              if (http && http.kind === "http") { c = { pass: http.pass, reason: http.reason, help: http.help, kind: http.kind }; }
            } catch (e) {}
          }
          var row = Object.assign({}, link, c);
          if (v && v.ok && v.probe && v.probe.actions) row.actions = v.probe.actions;
          if (v && v.ok && v.probe && v.probe.warnText) row.warn = v.probe.warnText;   // noted, never fails the row
          // Slow's deliberate pause, so a human can follow along (Browser) or the server gets a breather
          // (Headless). Fast sets linger to 0, so this costs nothing there.
          var linger = pace().linger;
          if (linger && !fnStopped(gen)) return new Promise(function (r) { setTimeout(function () { r(row); }, linger); });
          return row;
        }, function (e) { freeSlots.push(slot); return Object.assign({}, link, { pass: false, reason: "লোড হয়নি — " + String(e && e.message || e), kind: "net" }); });
      }, function (row) {
        results.push(row); done++; fnProgress(done, total, t("fn_visiting"));
        fnRenderSummary(); fnRenderList();
      }, gen);
      try { chrome.runtime.sendMessage({ type: "fnVisitClose" }, function () { void chrome.runtime.lastError; }); } catch (e) {}
    }
    if (fnStopped(gen)) { fnDone(gen); return; }

    // 2) a screenshot for each failure — HTTP/Browser only, captured in one reused off-screen window
    // with captureVisibleTab (no chrome.debugger, so no "being debugged" banner). HEADLESS is skipped:
    // it runs in a hidden background tab, which cannot be captured without the debugger.
    if (fnMode !== "headless") {
      // screenshot any page that failed OR has a failing button/action (the error is often the action)
      var actFail = function (r) { return r.actions && r.actions.some(function (a) { return !a.pass; }); };
      var fails = results.filter(function (r) { return !r.pass || actFail(r); });
      for (var k = 0; k < fails.length; k++) {
        if (fnStopped(gen)) break;
        await waitIfPaused(gen); if (fnStopped(gen)) break;
        fnProgress(k, fails.length, t("fn_shooting"));
        var s = await fnShot(fails[k].url, gen);
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
    fnDone(gen);
  }

  function fnStop() {
    fnAborted = true;   // latched: every loop/pool/visit sees this at once, even if fnRun gets cleared
    if (fnRun) { fnRun.stop = true; fnRun.paused = false; fnReleasePause(); }
    // close the check windows right away — don't wait for an in-flight visit (up to 60s) to return
    try { chrome.runtime.sendMessage({ type: "fnVisitClose" }, function () { void chrome.runtime.lastError; }); } catch (e) {}
    try { chrome.runtime.sendMessage({ type: "fnShotClose" }, function () { void chrome.runtime.lastError; }); } catch (e) {}
    // Show "Check Now" again instantly, but keep it disabled until the loop has actually unwound —
    // otherwise a click in that gap hits fnStart's `if (fnRun) return` and is silently swallowed.
    fnResetUI(false);
    // safety net: if the loop is slow to unwind (parked in an in-flight await), force this run idle so
    // Check Now works again. Scoped to THIS generation, so it can never finalize a later run.
    var g = fnGen;
    setTimeout(function () { if (fnGen === g && fnRun) fnDone(g); }, 1200);
  }
  function fnPause() {
    if (!fnRun) return;
    fnRun.paused = !fnRun.paused;
    var b = $("fnPause"); if (b) b.textContent = fnRun.paused ? t("fn_resume") : t("fn_pause");
    if (!fnRun.paused) fnReleasePause();   // Resume → release the parked loop immediately
  }
  // idle=false means "Stop was pressed but the loop is still unwinding": show Check Now so the state
  // reads as stopped, but keep it disabled until fnDone actually clears the run.
  function fnResetUI(idle) {
    if (fnTimer) { clearInterval(fnTimer); fnTimer = null; }
    if ($("fnStart")) { $("fnStart").style.display = ""; $("fnStop").style.display = "none"; $("fnStart").disabled = (idle === false); }
    if ($("fnPause")) { $("fnPause").style.display = "none"; $("fnPause").textContent = t("fn_pause"); }
  }
  // gen-scoped: a stale loop (one whose run was already superseded) must not clear a newer run's state.
  function fnDone(gen) {
    if (gen !== undefined && gen !== fnGen) return;
    fnEnd = Date.now();
    fnResetUI(true);
    fnRun = null;
    try { if (fnPort) fnPort.disconnect(); } catch (e) {}
    fnPort = null;
    fnRenderSummary();
  }

  async function fnExport() {
    if (!results.length || !A.buildBook) return;
    // XLSX with a clickable HYPERLINK to each page (the Link column); Fail rows red, Pass green
    var header = ["Menu", "Action", "Path", "Status", "Reason", "Button", "Link"];
    var mat = [], colors = [];
    results.forEach(function (r) {
      // a failure marked As Pass exports as "As Pass" (amber) and KEEPS its original reason, so the
      // spreadsheet never hides what actually happened
      var mk = fnMarked(r);
      mat.push([r.menu, r.label, r.path, r.pass ? "Pass" : (mk ? "As Pass" : "Fail"),
        r.reason + (r.warn ? " | ⚠ " + r.warn : ""), "", r.url]);
      colors.push(r.pass ? "g" : (mk ? "y" : "r"));
      (r.actions || []).forEach(function (a) {
        mat.push([r.menu, r.label, r.path, a.pass ? "Pass" : "Fail", a.reason, a.label, r.url]);
        colors.push(a.pass ? "g" : "r");
      });
    });
    try {
      var bytes = await A.buildBook([{ name: "Function Check", header: header, mat: mat, colors: colors, links: [6] }]);
      var a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
      a.download = "Function Check - " + new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-") + ".xlsx";
      document.body.appendChild(a); a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    } catch (e) { if ($("fnNote")) $("fnNote").textContent = "Export সমস্যা — " + String(e && e.message || e); }
  }

  function fnWire() {
    if ($("fnStart")) $("fnStart").addEventListener("click", fnStart);
    if ($("fnStop")) $("fnStop").addEventListener("click", fnStop);
    if ($("fnPause")) $("fnPause").addEventListener("click", fnPause);
    if ($("fnExport")) { $("fnExport").addEventListener("click", fnExport); $("fnExport").disabled = !results.length; }
    if ($("fnSummary")) $("fnSummary").addEventListener("click", function (e) {
      var p = e.target && e.target.closest && e.target.closest("[data-fnf]");
      if (!p) return;
      fnFilter = p.getAttribute("data-fnf") || "all";
      fnRenderSummary(); fnRenderList();
    });
    // accept / un-accept a failure (delegated, so it keeps working as the list re-renders mid-run)
    if ($("fnList")) $("fnList").addEventListener("click", function (e) {
      var b = e.target && e.target.closest && e.target.closest(".fnmark");
      if (!b) return;
      var path = b.getAttribute("data-mp") || "";
      if (!path) return;
      if (fnMarks[path]) delete fnMarks[path]; else fnMarks[path] = 1;
      fnMarksSave();
      fnRenderSummary(); fnRenderList();
    });
    if ($("fnHttp")) $("fnHttp").addEventListener("click", function () { fnSetMode("http"); });
    if ($("fnBrowser")) $("fnBrowser").addEventListener("click", function () { fnSetMode("browser"); });
    if ($("fnHeadless")) $("fnHeadless").addEventListener("click", function () { fnSetMode("headless"); });
    if ($("fnFast")) $("fnFast").addEventListener("click", function () { fnSetSpeed("fast"); });
    if ($("fnSlow")) $("fnSlow").addEventListener("click", function () { fnSetSpeed("slow"); });
    if ($("fnActions")) $("fnActions").addEventListener("change", function () {
      fnWantActions = this.checked;   // only reachable while enabled, so this is always a real choice
      try { chrome.storage.local.set({ fnActions: fnWantActions }); } catch (e) {}
    });
    // Area picker. Delegated, so the per-area boxes and "All areas" share one handler: ticking All
    // clears the rest (they mean the same thing), and ticking any area clears All.
    if ($("fnAreaMenu")) $("fnAreaMenu").addEventListener("change", function (e) {
      var el = e.target;
      if (!el || el.type !== "checkbox") return;
      if (el.id === "fnAreaAll") {
        var boxes = document.querySelectorAll(".fnareabox");
        for (var i = 0; i < boxes.length; i++) boxes[i].checked = false;
        el.checked = true;            // clicking All off would leave nothing saying what runs
      }
      fnAreaSync(true);
    });
    // The menu is a <details>; without this it stays open behind the rest of the panel once opened.
    document.addEventListener("click", function (e) {
      var dd = $("fnAreaDd");
      if (dd && dd.open && !dd.contains(e.target)) dd.open = false;
    });
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
    // remember the last-used Base URL and restore it on load
    if ($("fnBase")) {
      var onBase = function () { try { chrome.storage.local.set({ fnBaseUrl: $("fnBase").value }); } catch (e) {} fnConnDebounced(); };
      // input = typing; change/blur catch a paste or an autocomplete pick that skips the input event
      ["input", "change", "blur"].forEach(function (ev) { $("fnBase").addEventListener(ev, onBase); });
    }
    try {
      chrome.storage.local.get(["fnMode", "fnSpeed", "fnActions", "fnAreas", "fnBaseUrl", "fnRolls", "fnRegs", "fnMobiles"].concat(Object.keys(VKEYS)), function (o) {
        fnWantActions = !!(o && o.fnActions);   // set BEFORE fnSetMode, which decides what the box shows
        fnAreaRestore(o && o.fnAreas);
        fnSetMode(o && o.fnMode);
        fnSetSpeed(o && o.fnSpeed);
        if (o && o.fnBaseUrl && $("fnBase")) $("fnBase").value = o.fnBaseUrl;
        Object.keys(VKEYS).forEach(function (id) { if (o && o[id] != null && $(id)) $(id).value = o[id]; });
        Object.keys(DL).forEach(function (id) { fillDl(DL[id].dl, (o && o[DL[id].key]) || []); });
        fnCheckConn();   // check login with the restored address
      });
    } catch (e) { fnAreaSync(false); fnSetMode("http"); fnCheckConn(); }
  }

  A.fn = { wire: fnWire, start: fnStart, stop: fnStop, setMode: fnSetMode, relang: fnRelang,
    // true while a sweep is in progress — reload / Update must warn before throwing it away
    busy: function () { return !!fnRun; },
    // pure helpers exposed for tests
    parseNav: fnParseNav, classify: fnClassify, classifyProbe: fnClassifyProbe,
    topMenu: fnTopMenu, areaWanted: fnAreaWanted, skipHref: fnSkipHref,
    skipped: function () { return fnSkipped.slice(); } };
})();
