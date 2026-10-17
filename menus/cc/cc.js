/* Course Cancel (cc*) menu — cancels courses in UMS for many students from a sheet.
 * Loads before app.js; resolves the shared core helpers lazily through self.APP at call time.
 *
 * The sheet gives Reg · StudentProgramId · CourseId. Each student programme is one job, run by
 * background.js in a real UMS tab (menus/cc/cc-page.js does the clicking), one at a time:
 * search the Reg → open that programme's Cancel Course form → untick the course → Approved By and
 * reason → Submit. A dry run — ON whenever the page opens — does all of it except Submit and shows
 * the amounts UMS worked out, so they can be read before anything is written.
 *
 * ⚠ Writes real cancellations, which cannot be undone from here. Allowed on *.osl.team (test/staging)
 * and orgbd.net, where the cancellations were asked for; umsbd.net and anything else stay read-only
 * (cc-core.js canWrite, and background.js ccCanWrite again on its side). */
(function () {
  "use strict";
  var A = self.APP || (self.APP = {});
  function $(id) { return A.$(id); }
  function t(k) { return A.t(k); }
  function sleep(ms) { return A.sleep(ms); }
  const C = function () { return self.UMSCANCEL; };
  function esc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  // a {placeholder}'s value, handed to replace() as a function so "$&" in typed text stays literal
  const lit = function (v) { return function () { return String(v); }; };

  const CC_DEF = { base: "https://ums-2.osl.team", pin: "260", reason: "Wrong Admission" };
  let ccParsed = [], ccJobs = [], ccRes = [], ccSrc = "", ccNoteState = null;
  let ccRunState = null;          // { stop, dry } while a run is going
  let ccShowMode = true;          // true = a visible tab, false = Headless (off-screen window)
  /* How the form is reached: "direct" = its own address, the pair confirmed by UMS's lookup (fast);
     "search" = the old way — the Cancel Course page, type the Reg, press its "Cancel Course" button.
     Remembered, like Browser/Headless: it changes the speed, not what is sent. */
  let ccRoute = "direct";
  let ccConnSeq = 0, ccConnTimer = null, ccConnState = null, ccConnWhy = "";

  function ccBase() { return (($("ccBase") && $("ccBase").value) || "").trim().replace(/\/+$/, ""); }

  // ---------- connection ----------
  function ccSetConn(state, why) {
    ccConnState = state || null; ccConnWhy = why || "";
    const el = $("ccConn"); if (!el) return;
    el.className = "crmconn" + (state ? " " + state : "");
    el.textContent = state === "busy" ? t("checking") : state === "ok" ? t("cc_conn_ok")
      : state === "no" ? (why || t("cc_conn_no")) : t("conn_unchecked");
  }
  /* Logged in, and allowed to open Cancel Course? A redirect to the login page answers the first;
     the search box being on the page answers the second. */
  async function ccCheckLogin() {
    const base = ccBase();
    if (!C().canWrite(base)) return { ok: false, why: t("cc_need_host") };
    try {
      const r = await fetch(base + "/Student/CancelCourse/CancelCourseOrSubject", { credentials: "include", cache: "no-store" });
      if (C().isLogin(r.url)) return { ok: false, why: t("cc_login_no").replace("{base}", lit(base)) };
      const html = await r.text();
      if (!/stdRollOrRegistrationNo/.test(html)) return { ok: false, why: t("cc_noperm") };
      return { ok: true };
    } catch (e) { return { ok: false, why: t("crm_reach_no") }; }
  }
  async function ccTestConn() {
    const mine = ++ccConnSeq;
    if (!ccBase()) { ccSetConn(null); return { ok: false }; }
    ccSetConn("busy");
    const r = await ccCheckLogin();
    if (mine === ccConnSeq) ccSetConn(r.ok ? "ok" : "no", r.why);
    return r;
  }
  function ccConnDebounced() { if (ccConnTimer) clearTimeout(ccConnTimer); ccConnTimer = setTimeout(ccTestConn, 700); }

  // ---------- input ----------
  function ccSetInput(rows, src) {
    ccSrc = src || "";
    const p = C().parseInput(rows);
    ccParsed = p.rows || [];
    const g = C().groupJobs(ccParsed);
    ccJobs = g.jobs;
    /* A sheet that carries its own Approved By / Cancellation Reason columns is the instruction:
       those values go into the two fields, and what the fields hold at Start is what is sent (the
       confirm box shows it). One run sends one approver and one reason, so a sheet that mixes
       several is refused here rather than half-honoured. */
    const pins = p.pins || [], reasons = p.reasons || [];
    let mixed = null;
    if (pins.length > 1) mixed = { what: "Approved By", vals: pins };
    else if (reasons.length > 1) mixed = { what: "Cancellation Reason", vals: reasons };
    if (mixed) ccJobs = [];
    else {
      if (pins.length === 1 && $("ccPin")) $("ccPin").value = pins[0];
      if (reasons.length === 1 && $("ccReason")) $("ccReason").value = reasons[0];
    }
    ccNoteState = { empty: !!p.empty, lost: p.lost || null, rows: ccParsed.length, jobs: ccJobs.length, dupes: g.dupes,
      courses: ccJobs.reduce(function (s, j) { return s + j.courses.length; }, 0),
      bad: ccParsed.filter(function (r) { return r.err; }).length, mixed: mixed,
      sheetPin: !mixed && pins.length === 1 ? pins[0] : "", sheetReason: !mixed && reasons.length === 1 ? reasons[0] : "" };
    ccRes = []; ccFilter = "";
    ccPaintNote(); ccPaintPreview(); ccPaintResults(); ccSync();
  }
  // drawn from state, so a language switch redraws it in the new language
  function ccPaintNote() {
    const el = $("ccNote"); if (!el) return;
    const s = ccNoteState;
    if (!s) { el.style.display = "none"; el.innerHTML = ""; return; }
    let h;
    if (s.empty) h = '<span class="no">✕ ' + esc(t("cc_empty")) + "</span>";
    else if (s.lost) h = '<span class="no">✕ ' + esc(t("cc_lost").replace("{cols}", lit(s.lost.join(", ")))) + "</span>";
    else if (s.mixed) h = '<span class="no">✕ ' + esc(t("cc_mixed").replace("{what}", lit(s.mixed.what)).replace("{vals}", lit(s.mixed.vals.join(" · ")))) + "</span>";
    else {
      h = "✓ " + esc(t("cc_rows").replace("{a}", s.rows).replace("{b}", s.jobs).replace("{c}", s.courses));
      if (s.rows - s.bad > s.jobs) h += " · " + esc(t("cc_grouped"));
      if (s.dupes) h += " · " + esc(t("cc_dupes").replace("{n}", s.dupes));
      if (s.bad) h += ' · <span class="warn">' + esc(t("cc_bad").replace("{n}", s.bad)) + "</span>";
      if (s.sheetPin) h += "<br>" + esc(t("cc_sheet_pin").replace("{pin}", lit(s.sheetPin)));
      if (s.sheetReason) h += (s.sheetPin ? " · " : "<br>") + esc(t("cc_sheet_reason").replace("{reason}", lit(s.sheetReason)));
    }
    el.innerHTML = (ccSrc ? '<span class="isrc">' + esc(ccSrc) + "</span><br>" : "") + h;
    el.style.display = "";
  }
  function ccPaintPreview() {
    const box = $("ccPreview"); if (!box) return;
    if (!ccParsed.length) { box.innerHTML = ""; box.style.display = "none"; return; }
    box.style.display = "";
    const MAX = 500;
    let h = '<table class="ptbl cctbl"><thead><tr><th>' + esc(t("cc_col_line")) + "</th><th>Reg</th><th>StudentProgramId</th><th>CourseId</th><th></th></tr></thead><tbody>";
    ccParsed.slice(0, MAX).forEach(function (r) {
      h += "<tr" + (r.err ? ' class="ccbad"' : "") + "><td>" + r.line + "</td><td>" + esc(r.reg) + "</td><td>" + esc(r.spid) +
        "</td><td>" + esc(r.courses.join(", ")) + "</td><td>" + (r.err ? '<span class="no">✕ ' + esc(t("cc_e_" + r.err)) + "</span>" : "") + "</td></tr>";
    });
    h += "</tbody></table>";
    if (ccParsed.length > MAX) h += '<div class="hint" style="text-align:center;margin:6px 0">' + esc(t("cc_more").replace("{a}", MAX).replace("{b}", ccParsed.length)) + "</div>";
    box.innerHTML = h;
  }
  async function ccOnFile(file) {
    try {
      if (/\.xlsx$/i.test(file.name)) {
        const x = await A.readXlsx(await file.arrayBuffer());
        ccSetInput(x.rows, "📄 " + file.name + (x.sheet ? "  ·  " + x.sheet : ""));
      } else {
        ccSetInput(A.imp.parseCSV(await file.text()), "📄 " + file.name);
      }
    } catch (e) {
      ccNoteState = null; ccSrc = "";
      const el = $("ccNote"); if (el) { el.style.display = ""; el.textContent = "📄 " + file.name + " — " + t("cc_excel_fail") + " (" + ((e && e.message) || e) + ")"; }
    }
  }
  function ccClear() {
    if (ccRunState) return;
    if ($("ccPaste")) $("ccPaste").value = "";
    if ($("ccFile")) $("ccFile").value = "";
    ccParsed = []; ccJobs = []; ccRes = []; ccSrc = ""; ccNoteState = null; ccFilter = "";
    ccPaintNote(); ccPaintPreview(); ccPaintResults(); ccSync();
  }

  // ---------- run ----------
  function ccStatus(txt, cls) { const el = $("ccStatus"); if (el) { el.textContent = txt || ""; el.className = "hint" + (cls ? " " + cls : ""); } }
  function ccSend(params) {
    return new Promise(function (resolve) {
      chrome.runtime.sendMessage({ type: "ccBrowser", params: params }, function (r) {
        resolve(r || { status: "skip", code: "error", why: chrome.runtime.lastError ? chrome.runtime.lastError.message : "সাড়া নেই" });
      });
    });
  }
  async function ccRun() {
    if (ccRunState || !ccJobs.length) { if (!ccJobs.length) ccStatus(t("cc_need_rows"), "no"); return; }
    const base = ccBase(), pin = ($("ccPin").value || "").trim(), reason = ($("ccReason").value || "").trim();
    const nextDate = ($("ccDate").value || "").trim(), dry = $("ccDry").checked;
    const zeroOnly = !$("ccZero") || $("ccZero").checked;   // missing switch = the safe side
    if (!C().canWrite(base)) { ccStatus(t("cc_need_host"), "no"); return; }
    if (!/^\d+$/.test(pin)) { ccStatus(t("cc_need_pin"), "no"); return; }
    if (!reason) { ccStatus(t("cc_need_reason"), "no"); return; }
    if (!dry) {
      const n = ccJobs.reduce(function (s, j) { return s + j.courses.length; }, 0);
      if (!confirm(t("cc_confirm").replace("{base}", lit(base)).replace("{n}", ccJobs.length).replace("{c}", n).replace("{pin}", lit(pin)).replace("{reason}", lit(reason)) +
        (zeroOnly ? "\n\n" + t("cc_zero_confirm") : ""))) return;
    }
    ccStatus(t("cc_checking_login"));
    const login = await ccTestConn();
    if (!login.ok) { ccStatus(login.why || t("cc_conn_no"), "no"); return; }

    ccRunState = { stop: false, dry: dry };
    ccRes = ccJobs.map(function (j, i) {
      return { n: i + 1, reg: j.reg, spid: j.spid, courses: j.courses.slice(), status: "wait", why: "", names: [], amounts: null, program: "", url: "" };
    });
    ccFilter = "";   // a new run starts unfiltered
    ccPaintResults(); ccSync();
    ccStatus(t(dry ? "cc_running_dry" : "cc_running_live"));
    let halted = "";
    try {
      for (const r of ccRes) {
        if (ccRunState.stop) break;
        r.status = "run"; ccPaintRow(r); ccPaintTiles();
        const out = await ccSend({ base: base, reg: r.reg, spid: r.spid, courses: r.courses, pin: pin, reason: reason,
          nextDate: nextDate, dry: dry, zeroOnly: zeroOnly, show: ccShowMode, route: ccRoute });
        r.status = out.status || "skip";
        r.program = out.program || "";
        r.amounts = out.amounts || null;
        r.names = out.names || [];
        r.url = out.url || "";
        r.receipt = out.url ? (C().receiptOf(out.url) || "") : "";
        r.why = out.status === "dry" ? t("cc_dry_ok").replace("{who}", lit(out.approver || "")) : (out.why || "");
        ccPaintRow(r); ccPaintTiles();
        if (out.fatal) { halted = out.why || ""; break; }
        await sleep(300);
      }
    } finally {
      const stopped = ccRunState.stop;
      /* close the UMS tab — never leave a filled-in form behind that someone could submit by hand */
      try { await new Promise(function (res) { chrome.runtime.sendMessage({ type: "ccBrowserClose" }, function () { void chrome.runtime.lastError; res(); }); }); } catch (e) {}
      ccRunState = null; ccSync(); ccPaintTiles();
      const left = ccRes.filter(function (r) { return r.status === "wait"; }).length;
      if (halted) ccStatus(t("cc_halted").replace("{why}", lit(halted)) + (left ? " · " + t("cc_left").replace("{n}", left) : ""), "no");
      else if (stopped) ccStatus(t("cc_stopped").replace("{n}", left), "warn");
      else ccStatus(t("cc_done"), "ok");
    }
  }
  function ccStop() {
    if (!ccRunState) return;
    ccRunState.stop = true;
    if ($("ccStop")) $("ccStop").disabled = true;
    ccStatus(t("cc_stopping"), "warn");   // a Submit already pressed is never cut off
  }

  // ---------- results ----------
  const PILL = { wait: "mut", run: "info", done: "ok", dry: "info", skip: "warn", unsure: "no" };
  /* The five tiles are filters too, the way Payment History's are: a click shows only that kind, a
     second click shows everything again. A row still running counts as "left", as on the tiles. The
     CSV follows the filter — "only the skipped ones" is the list worth running again. */
  let ccFilter = "";
  const ccBucket = function (r) { return (r.status === "done" || r.status === "dry" || r.status === "skip" || r.status === "unsure") ? r.status : "wait"; };
  const ccShown = function (r) { return !ccFilter || ccBucket(r) === ccFilter; };
  function ccApplyFilter() {
    ccRes.forEach(function (r) { const tr = $("ccr" + r.n); if (tr) tr.style.display = ccShown(r) ? "" : "none"; });
    [].forEach.call(document.querySelectorAll("#pgCc .cctile[data-f]"), function (el) { el.classList.toggle("on", el.getAttribute("data-f") === ccFilter); });
  }
  function ccSetFilter(f) { ccFilter = (f && f !== ccFilter) ? f : ""; ccApplyFilter(); ccPaintTiles(); }
  function amt(r, k) { return r.amounts && isFinite(r.amounts[k]) ? C().fmt(r.amounts[k]) : ""; }
  function ccRowHtml(r) {
    const course = r.courses.map(function (id, i) {
      return "<b>" + esc(id) + "</b>" + (r.names[i] ? ' <span class="mut">' + esc(r.names[i]) + "</span>" : "");
    }).join("<br>");
    const link = r.url ? ' <a href="' + esc(r.url) + '" target="_blank" rel="noopener">' + esc(t("cc_receipt")) + (r.receipt ? " " + esc(r.receipt) : "") + "</a>" : "";
    return "<td>" + r.n + "</td><td><b>" + esc(r.reg) + '</b><br><span class="mut">' + esc(r.spid) + "</span>" +
      (r.program ? '<br><span class="mut">' + esc(r.program) + "</span>" : "") + "</td><td>" + course + "</td>" +
      '<td class="num">' + amt(r, "cancellation") + '</td><td class="num">' + amt(r, "consideration") +
      '</td><td class="num">' + amt(r, "cashBack") + '</td><td class="num">' + amt(r, "currentDue") + "</td>" +
      '<td><span class="pill ' + (PILL[r.status] || "mut") + '">' + esc(t("cc_p_" + r.status)) + "</span>" + link +
      (r.why ? '<div class="ccwhy">' + esc(r.why) + "</div>" : "") + "</td>";
  }
  function ccPaintResults() {
    const box = $("ccRes"); if (!box) return;
    if (!ccRes.length) { box.innerHTML = '<div class="hint" style="text-align:center;padding:14px">' + esc(t("cc_none_yet")) + "</div>"; ccPaintTiles(); return; }
    box.innerHTML = '<table class="ptbl cctbl"><thead><tr><th>#</th><th>Reg · SPID</th><th>Course</th><th class="num">Cancellation</th>' +
      '<th class="num">Consideration</th><th class="num">Cash Back</th><th class="num">Current Due</th><th>' + esc(t("cc_col_res")) + "</th></tr></thead><tbody>" +
      ccRes.map(function (r) { return '<tr id="ccr' + r.n + '"' + (ccShown(r) ? "" : ' style="display:none"') + ">" + ccRowHtml(r) + "</tr>"; }).join("") + "</tbody></table>";
    ccApplyFilter(); ccPaintTiles();
  }
  function ccPaintRow(r) {
    const tr = $("ccr" + r.n); if (!tr) return;
    tr.innerHTML = ccRowHtml(r);
    tr.style.display = ccShown(r) ? "" : "none";   // a row whose verdict just changed may leave or join the filter
    if (r.status === "run" && ccShown(r)) tr.scrollIntoView({ block: "nearest" });
  }
  function ccPaintTiles() {
    const c = { done: 0, dry: 0, skip: 0, unsure: 0, wait: 0 };
    ccRes.forEach(function (r) { if (c[r.status] != null) c[r.status]++; else c.wait++; });
    Object.keys(c).forEach(function (k) { const el = $("cc-t-" + k); if (el) el.textContent = c[k]; });
    const fin = ccRes.length - c.wait;
    const pr = $("ccProg"); if (pr) pr.textContent = ccRes.length ? fin + " / " + ccRes.length : "";
    if ($("ccCsv")) $("ccCsv").disabled = !ccRes.some(ccShown) || !!ccRunState;
  }
  function csvCell(v) { v = String(v == null ? "" : v); return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
  function ccCsv() {
    const LBL = { wait: "Not run", run: "Not run", done: "Cancelled", dry: "Dry run OK", skip: "Skipped", unsure: "Unsure" };
    const lines = [["Status", "Reg", "StudentProgramId", "CourseId", "Course", "Program", "Cancellation", "Consideration",
      "Cash Back", "Current Due", "Receipt", "Receipt Link", "Note"].join(",")];
    ccRes.filter(ccShown).forEach(function (r) {
      const a = r.amounts || {};
      lines.push([LBL[r.status] || r.status, r.reg, r.spid, r.courses.join(" "), r.names.join(" | "), r.program,
        a.cancellation, a.consideration, a.cashBack, a.currentDue, r.receipt || "", r.url, r.why].map(csvCell).join(","));
    });
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const d = new Date(), p = function (n) { return String(n).padStart(2, "0"); };
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    // a filtered export says so in its name, so it is never mistaken for the whole run
    const FILE = { done: "cancelled", dry: "dry-run-ok", skip: "skipped", unsure: "unsure", wait: "not-run" };
    a.download = "course-cancel " + d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + "-" + p(d.getMinutes()) +
      (ccFilter ? " " + FILE[ccFilter] : "") + ".csv";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
  }

  // ---------- controls ----------
  function ccSync() {
    const busy = !!ccRunState;
    ["ccBase", "ccPaste", "ccCheck", "ccFile", "ccClear", "ccPin", "ccReason", "ccDate", "ccDry", "ccZero", "ccShow", "ccHeadless", "ccDirect", "ccSearch"].forEach(function (id) {
      if ($(id)) $(id).disabled = busy;
    });
    const imp = document.querySelector('label[for="ccFile"]'); if (imp) imp.classList.toggle("ccoff", busy);
    const dry = !$("ccDry") || $("ccDry").checked;
    const run = $("ccRun");
    if (run) {
      run.disabled = busy || !ccJobs.length;
      run.setAttribute("data-i18n", dry ? "cc_run_dry" : "cc_run_live");   // applyLang keeps whichever it is
      run.textContent = t(dry ? "cc_run_dry" : "cc_run_live");
      run.classList.toggle("ccdanger", !dry);
    }
    if ($("ccStop")) $("ccStop").disabled = !busy;
    if ($("ccDrySw")) $("ccDrySw").classList.toggle("on", dry);
    if ($("ccZeroSw")) $("ccZeroSw").classList.toggle("on", !$("ccZero") || $("ccZero").checked);
    if ($("ccLive")) $("ccLive").style.display = dry ? "none" : "";
    if ($("ccShow")) $("ccShow").classList.toggle("on", ccShowMode);
    if ($("ccHeadless")) $("ccHeadless").classList.toggle("on", !ccShowMode);
    if ($("ccDirect")) $("ccDirect").classList.toggle("on", ccRoute !== "search");
    if ($("ccSearch")) $("ccSearch").classList.toggle("on", ccRoute === "search");
  }
  function ccSetShow(v) { if (ccRunState) return; ccShowMode = !!v; ccSave(); ccSync(); }
  function ccSetRoute(v) { if (ccRunState) return; ccRoute = v === "search" ? "search" : "direct"; ccSave(); ccSync(); }
  function ccSave() {
    try { chrome.storage.local.set({ ccBase: ccBase(), ccPin: ($("ccPin").value || "").trim(), ccReason: $("ccReason").value || "", ccShow: ccShowMode, ccRoute: ccRoute }); } catch (e) {}
  }
  /* the language changed under the page — redraw what is built from t() rather than from markup */
  function ccRelang() { ccSetConn(ccConnState, ccConnWhy); ccPaintNote(); ccPaintPreview(); ccPaintResults(); ccSync(); }

  let ccWired = false;
  function ccWire() {
    if (ccWired) return; ccWired = true;
    if ($("ccBase")) {
      $("ccBase").addEventListener("input", ccConnDebounced);
      $("ccBase").addEventListener("change", ccSave);
    }
    if ($("ccCheck")) $("ccCheck").addEventListener("click", function () { ccSetInput(C().splitPaste($("ccPaste").value), "📋 " + t("cc_pasted")); });
    if ($("ccFile")) $("ccFile").addEventListener("change", function () { if (this.files && this.files[0]) ccOnFile(this.files[0]); });
    if ($("ccClear")) $("ccClear").addEventListener("click", ccClear);
    if ($("ccPin")) $("ccPin").addEventListener("change", ccSave);
    if ($("ccReason")) $("ccReason").addEventListener("change", ccSave);
    if ($("ccDry")) $("ccDry").addEventListener("change", ccSync);
    if ($("ccZero")) $("ccZero").addEventListener("change", ccSync);
    if ($("ccShow")) $("ccShow").addEventListener("click", function () { ccSetShow(true); });
    if ($("ccHeadless")) $("ccHeadless").addEventListener("click", function () { ccSetShow(false); });
    if ($("ccDirect")) $("ccDirect").addEventListener("click", function () { ccSetRoute("direct"); });
    if ($("ccSearch")) $("ccSearch").addEventListener("click", function () { ccSetRoute("search"); });
    if ($("ccRun")) $("ccRun").addEventListener("click", ccRun);
    if ($("ccStop")) $("ccStop").addEventListener("click", ccStop);
    if ($("ccCsv")) $("ccCsv").addEventListener("click", ccCsv);
    [].forEach.call(document.querySelectorAll("#pgCc .cctile[data-f]"), function (el) {
      el.addEventListener("click", function () { ccSetFilter(el.getAttribute("data-f")); });
    });
    window.addEventListener("beforeunload", function (e) { if (ccRunState) { e.preventDefault(); e.returnValue = ""; } });
  }
  let ccLoaded = false;
  function ccOnShow() {
    ccWire();
    if (ccLoaded) { ccTestConn(); return; }
    ccLoaded = true;
    try {
      chrome.storage.local.get(["ccBase", "ccPin", "ccReason", "ccShow", "ccRoute"], function (o) {
        o = o || {};
        if ($("ccBase")) $("ccBase").value = o.ccBase || CC_DEF.base;
        if ($("ccPin")) $("ccPin").value = o.ccPin || CC_DEF.pin;
        if ($("ccReason")) $("ccReason").value = o.ccReason || CC_DEF.reason;
        ccShowMode = o.ccShow !== false;
        ccRoute = o.ccRoute === "search" ? "search" : "direct";
        // the dry run and the zero-taka guard are NOT remembered: every visit starts with both on
        if ($("ccDry")) $("ccDry").checked = true;
        if ($("ccZero")) $("ccZero").checked = true;
        ccPaintResults(); ccSync(); ccTestConn();
      });
    } catch (e) {}
  }

  A.cc = { onShow: ccOnShow, relang: ccRelang, isRunning: function () { return !!ccRunState; } };
})();
