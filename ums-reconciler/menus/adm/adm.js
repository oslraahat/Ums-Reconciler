/* New Admission (adm*) menu — split out of app.js (behaviour-preserving reorg).
 * Loads before app.js; resolves the shared core helpers lazily through self.APP at call time. */
(function () {
  "use strict";
  var A = self.APP || (self.APP = {});
  function $(id) { return A.$(id); }
  function t(k) { return A.t(k); }
  function sleep(ms) { return A.sleep(ms); }
  function fetchHtml() { return A.fetchHtml.apply(null, arguments); }

  /* ── New Admission load test — session-based, no helper, no credentials ───────────
     Like Payment History, this runs on the browser's own UMS login. It drives the real
     NewStudentAdmission flow with fetch() against the same endpoints the page's own JS calls
     (/Scripts/Student/NewAdmission.js): GetProgramByClass → GetSessionByProgram →
     GetBranchByProgramSession → GetCampus… → GetBatch(Day/Time) cascade → CalculateCourseFee →
     StudentRegistration → DuePayment. These AJAX POSTs need only the session cookie (no antiforgery
     token). The name is auto; the mobile and the counts come from the user. It measures how fast N
     admissions complete. ⚠ creates REAL records — a test/demo server only. */
  let admBusyFlag = false, admStopFlag = false, admPauseFlag = false, admConnSeq = 0, admConnTimer = null, admConnState = null, admToken = "";
  const ADM_PATH = "/Student/Admission/NewStudentAdmission";
  /* while a run is going the Start button stays enabled and becomes Pause/Resume (Stop ends it);
     a separate "⏳ Running…" status badge shows the run state */
  function admStatusPaint() {
    const st = $("admStatus"); if (!st) return;
    st.style.display = admBusyFlag ? "" : "none";
    st.className = admPauseFlag ? "warn" : "ok";
    st.textContent = admBusyFlag ? t(admPauseFlag ? "adm_paused" : "adm_running") : "";
  }
  function admBusy(on) {
    admBusyFlag = on; if (!on) admPauseFlag = false;
    const b = $("admRun"); if (b) { b.disabled = false; b.textContent = on ? t(admPauseFlag ? "adm_resume" : "adm_pause") : t("adm_run"); }
    if ($("admStop")) $("admStop").disabled = !on;
    admStatusPaint();
  }
  function admTogglePause() {
    admPauseFlag = !admPauseFlag;
    const b = $("admRun"); if (b) b.textContent = t(admPauseFlag ? "adm_resume" : "adm_pause");
    admStatusPaint();
  }
  /* the loops call this between admissions so Pause holds and Stop breaks out */
  async function admWaitIfPaused() { while (admPauseFlag && !admStopFlag) await sleep(200); }
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
  /* say WHICH server needs the login, so the fix is obvious — and so a login on the wrong server
     (right person, wrong UMS Address) shows up as a mismatch instead of a blank "not logged in" */
  function admLoginMsg() {
    const b = admBaseUrl();
    return "🔒 লগইন নেই — আগে এই সার্ভারে ব্রাউজারে লগইন করুন: " + (b || "(UMS Address খালি)") + " — তারপর আবার চেষ্টা করুন";
  }
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
  let admRefBase = "";   // the base the session rule is already installed for — skip re-installing it
  async function admInstallRefererRule() {
    try {
      if (!(chrome.declarativeNetRequest && chrome.declarativeNetRequest.updateSessionRules)) return false;
      const base = admBaseUrl();
      if (base && base === admRefBase) return true;   // already set for this base — nothing to do
      const host = base.replace(/^https?:\/\//i, "").replace(/\/.*$/, "");
      const regDomain = host.split(".").slice(-2).join(".");   // e.g. ums-4.osl.team → osl.team
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [8801],
        addRules: [{
          id: 8801, priority: 1,
          action: { type: "modifyHeaders", requestHeaders: [
            { header: "referer", operation: "set", value: base + ADM_PATH },
            { header: "origin", operation: "set", value: base }
          ] },
          /* The crucial scope: exclude any request INITIATED BY a UMS page itself. The user's own
             dropdown AJAX is initiated by an osl.team page, so excludedInitiatorDomains keeps the
             rewrite off it entirely (that broad rewrite was quietly breaking dropdowns across the
             UMS while the extension was active). OUR requests are initiated by the extension page
             (chrome-extension://…), not osl.team, so they are NOT excluded and still get the
             Referer/Origin they need. */
          condition: { requestDomains: [host], resourceTypes: ["xmlhttprequest"], excludedInitiatorDomains: [regDomain] }
        }]
      });
      admRefBase = base;
      return true;
    } catch (e) { admOutLine("⚠ Referer rule: " + ((e && e.message) || e)); return false; }
  }
  /* Take the rule back down the moment our own work is done. It rewrites the Referer/Origin of EVERY
     xmlhttprequest to this UMS host — which includes the user's own tabs on the same server — so a
     rule left standing quietly breaks normal UMS browsing until the extension is disabled. It's only
     needed for the brief bursts of HTTP-mode POSTs (Fetch Data, HTTP admission); Browser/Headless
     don't use it at all (the real page's own JS sends the right Referer). */
  async function admRemoveRefererRule() {
    admRefBase = "";
    try {
      if (chrome.declarativeNetRequest && chrome.declarativeNetRequest.updateSessionRules)
        await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [8801] });
    } catch (e) {}
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
    if (/Account\/Login/i.test(r.url || "") || /name=["']?Password["']?/i.test(txt.slice(0, 4000))) throw new Error(admLoginMsg());
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
    if (/Account\/Login/i.test(r.url || "")) throw new Error(admLoginMsg());
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
          if (!(hi >= lo) || hi - lo > 0xFFFF) continue;   // guard: a huge/garbage range would freeze the tab (untrusted PDF)
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
    admLoadBtn(true);
    try {
      /* install the referer rule and fetch the page at the same time — the page GET (a document
         request) doesn't depend on the rule (that's for the later AJAX POSTs), so there's no reason
         to wait for one before starting the other */
      const [, page] = await Promise.all([admInstallRefererRule(), admGetDoc(ADM_PATH)]);
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
    finally { admLoadBtn(false); admRemoveRefererRule(); }   // don't leave the header rewrite standing over normal UMS browsing
  }
  /* the Fetch Data button's busy/idle look: spin the ⟳ icon and swap the label while it works,
     without wiping the icon span (the label lives in its own [data-i18n] span beside the icon) */
  function admLoadBtn(loading) {
    const b = $("admLoad"); if (!b) return;
    b.disabled = loading;
    b.classList.toggle("loading", loading);
    const txt = b.querySelector("[data-i18n]"); if (txt) txt.textContent = t(loading ? "adm_loading" : "adm_load");
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
      row.innerHTML = '<label><input type="checkbox" class="admc-cb" data-cid="' + String(c.id).replace(/"/g, "&quot;") + '"><span>' + (c.name || c.id).replace(/</g, "&lt;") + '</span></label>' +
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
    } catch (e) { cb.checked = false; delete admBatchOf[c.id]; admShowBatch(cb, null); admOutLine("  ⚠ " + (c.name || c.id) + ": batch নেই — Branch বা Campus আবার সিলেক্ট করুন"); }
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
      received: ($("admAmount").value || "").trim(), show: admRunModeVal !== "headless" };
    const count = admCount();
    const pool = Math.max(1, Math.min(admPool(), count));   // "একসাথে": run this many at once, each in its own tab/window (slot)
    admOutLine("→ " + count + " admission · " + t(admRunModeVal === "headless" ? "adm_headless_l" : "adm_browser_l") + (pool > 1 ? " · " + pool + " " + t("adm_pool_n") : ""));
    const t0 = Date.now(); let ok = 0, fail = 0, next = 0;
    /* one admission, run in the given slot's tab/window; logs its own result line */
    async function admOne(n, slot) {
      try {
        const params = Object.assign({}, base, { name: admName(), slot: slot });
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
        const parts = ["✓ #" + n + "/" + count];
        if (regNo) parts.push(t("adm_r_reg") + " " + regNo);
        if (roll) parts.push(t("adm_r_roll") + " " + roll);
        if (branch) parts.push(branch);
        if (mrNo) parts.push(t("adm_r_mr") + " #" + mrNo);
        if (r.payId) parts.push(t("adm_r_id") + " " + r.payId);
        const money = function (v) { return "৳" + Number(v).toLocaleString("en-US"); };
        const paid = (r.paid != null) ? r.paid : (base.received !== "" ? parseInt(base.received, 10) : null);   // fallback to the amount we asked to pay
        if (paid != null && !isNaN(paid)) parts.push(t("adm_r_paid") + " " + money(paid));
        if (r.due != null && r.due > 0) parts.push(t("adm_r_due") + " " + money(r.due));
        admOutLine("  " + parts.join(" · "));
        if (r.timing) admOutLine("  ⏱ " + r.timing);   // per-step ms, to see where Headless spends time
      } catch (e) { fail++; admOutLine("  ✗ #" + n + "/" + count + " — " + ((e && e.message) || e)); }
    }
    /* a fixed number of workers (= pool), each pulling the next admission until they run out; each
       worker owns one slot, so a slot's tab/window is reused and never used by two at the same time */
    async function admWorker(slot) {
      while (!admStopFlag) {
        await admWaitIfPaused(); if (admStopFlag) break;
        const i = next++; if (i >= count) break;
        await admOne(i + 1, slot);
      }
    }
    const workers = []; for (let s = 0; s < pool; s++) workers.push(admWorker(s));
    await Promise.all(workers);
    try { await new Promise(function (res) { chrome.runtime.sendMessage({ type: "admBrowserClose" }, function () { res(); }); }); } catch (e) {}   // close every slot's tab/window
    admOutLine("── " + ok + " ok · " + fail + " failed of " + (ok + fail) + " · " + ((Date.now() - t0) / 1000).toFixed(1) + "s" + (admStopFlag ? " (stopped)" : ""));
  }
  /* flag a field red until it is next focused/typed in, so a validation miss is visible on the field */
  function admBadField(id) {
    const el = $(id); if (!el) return;
    el.classList.add("field-bad"); el.focus();
    const clear = function () { el.classList.remove("field-bad"); el.removeEventListener("input", clear); el.removeEventListener("focus", clear); };
    el.addEventListener("input", clear); el.addEventListener("focus", clear);
  }
  async function admRun() {
    if (admBusyFlag) { admTogglePause(); return; }   // Start button doubles as Pause/Resume while running
    if (!admLoaded) { admOutLine(t("adm_need_load")); return; }
    const mobile = ($("admMobile").value || "").trim();
    if (!mobile) { admOutLine(t("adm_need_mobile")); admBadField("admMobile"); return; }
    if (!admTickedCourseIds().length) {
      admOutLine(t("adm_need_course"));
      const box = $("admCourseBox");
      if (box) { box.classList.add("field-bad"); box.scrollIntoView({ block: "nearest" }); const clr = function () { box.classList.remove("field-bad"); box.removeEventListener("change", clr); }; box.addEventListener("change", clr); }
      return;
    }
    if (admBrowserMode) { admStopFlag = false; admBusy(true); const out = $("admOut"); if (out) { out.style.display = ""; out.textContent = ""; } await admInstallRefererRule(); try { await admRunBrowser(mobile); } catch (e) { admOutLine("⚠ " + ((e && e.message) || e)); } admBusy(false); admRemoveRefererRule(); return; }
    if (!Object.keys(admBatchOf).length) { admOutLine(t("adm_need_course")); return; }
    admStopFlag = false; admBusy(true);
    const out = $("admOut"); if (out) { out.style.display = ""; out.textContent = ""; }
    try {
      await admInstallRefererRule();   // needed for the admission POSTs; taken down again below
      const inst = await admResolveInstitute();
      const discount = parseInt("0" + ((($("admDiscount") && $("admDiscount").value) || "").replace(/,/g, "").trim()), 10) || 0;
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
      const amount = ($("admAmount").value || "").replace(/,/g, "").trim();
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
      admOutLine("→ " + count + " admission · " + (admMode === "parallel" ? pool + " " + t("adm_par") : t("adm_seq")) + " · net ৳" + netAfter + " · paying ৳" + received);
      const t0 = Date.now(); let next = 0, ok = 0, fail = 0;
      async function worker() {
        while (!admStopFlag) {
          await admWaitIfPaused(); if (admStopFlag) break;
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
            const parts = ["✓ #" + n + "/" + count];
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
    admRemoveRefererRule();   // stop rewriting headers over the user's normal UMS browsing
  }
  let admMode = "sequential";
  let admBrowserMode = false, admRunModeVal = "http";   // http | browser | headless
  function admSetRunMode(m) {
    admRunModeVal = (m === "browser" || m === "headless") ? m : "http";
    admBrowserMode = admRunModeVal !== "http";
    if ($("admHttp")) $("admHttp").classList.toggle("on", admRunModeVal === "http");
    if ($("admBrowserBtn")) $("admBrowserBtn").classList.toggle("on", admRunModeVal === "browser");
    if ($("admHeadless")) $("admHeadless").classList.toggle("on", admRunModeVal === "headless");
  }
  function admSetMode(m) {
    admMode = m === "parallel" ? "parallel" : "sequential";
    const par = admMode === "parallel";
    if ($("admPar")) $("admPar").classList.toggle("on", par);
    if ($("admSeq")) $("admSeq").classList.toggle("on", !par);
    if ($("admPoolWrap")) $("admPoolWrap").style.display = par ? "inline-flex" : "none";
  }
  /* one Stop is enough: further clicks while it's already stopping would just spam the log. In
     Browser/Headless the admissions already in flight (up to the pool count) can't be aborted
     mid-form safely, so they finish first — say so, and disable the button so it isn't hammered. */
  function admStop() {
    if (admStopFlag) return;
    admStopFlag = true;
    if ($("admStop")) $("admStop").disabled = true;
    admOutLine(admBrowserMode ? "⏹ থামানো হচ্ছে… (চলমানগুলো শেষ হয়ে থামবে)" : "⏹ থামানো হচ্ছে…");
  }
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

  A.adm = {
    run: admRun, stop: admStop, setMode: admSetMode, setRunMode: admSetRunMode,
    loadForm: admLoadForm, onProgram: admOnProgram, onSession: admOnSession, onBranch: admOnBranch,
    instSearch: admInstSearch, apprSearch: admApprSearch, connDebounced: admConnDebounced,
    onShow: admOnShow, setConn: admSetConn, getConn: function () { return admConnState; }
  };

  /* Self-heal: the moment this page loads, tear down any leftover referer rule (id 8801) from an
     earlier build or an interrupted run. This runs on every open/refresh of the tool page and needs
     no extension reload, so a rule that was quietly rewriting the user's UMS AJAX can't survive
     simply reopening the tool. New Admission re-adds a correctly-scoped one only while it posts. */
  try {
    if (chrome.declarativeNetRequest && chrome.declarativeNetRequest.updateSessionRules)
      chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [8801] });
  } catch (e) {}
})();
