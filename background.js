/* The toolbar icon opens the Batch page.
 *
 * There is no popup: the page is a full dashboard with a run that can go for hours, and a popup
 * closes the moment the window loses focus — which would kill a run mid-way every time someone
 * clicked elsewhere. So the click opens (or returns to) an ordinary tab.
 *
 * Returning to it matters more than opening it. A run lives in its tab and holds everything it has
 * found; a second copy would start empty and look exactly like the first one had been lost, while
 * the real one carried on invisibly in the background.
 */
"use strict";

const PAGE = "app.html";

/* Finding the tab without the "tabs" permission: chrome.tabs.query({url}) reads tab URLs and needs
   it, which would put "Read your browsing history" on the install prompt for a tool that never
   looks outside its own page. runtime.getContexts() only ever reports this extension's own pages,
   so it answers the same question and asks for nothing. */
async function existingTab(url) {
  if (!chrome.runtime.getContexts) return null;
  try {
    const found = await chrome.runtime.getContexts({ contextTypes: ["TAB"], documentUrls: [url] });
    const hit = (found || []).filter(function (c) { return c.tabId != null && c.tabId >= 0; })[0];
    return hit || null;
  } catch (e) { return null; }
}

chrome.action.onClicked.addListener(async function () {
  const url = chrome.runtime.getURL(PAGE);
  const open = await existingTab(url);
  if (open) {
    try {
      await chrome.tabs.update(open.tabId, { active: true });
      /* the tab may be in another window, and activating it there leaves it behind whatever is
         in front — bring that window forward too */
      if (open.windowId != null && open.windowId >= 0) {
        await chrome.windows.update(open.windowId, { focused: true });
      }
      return;
    } catch (e) { /* it was closed between the look and the click — fall through and open one */ }
  }
  await chrome.tabs.create({ url: url });
});

/* First install: open the page once, so the tool is in front of whoever just added it rather than
   behind a toolbar icon they have not been told about. An update says nothing — the run they may
   be in the middle of is not to be interrupted. */
chrome.runtime.onInstalled.addListener(function (details) {
  if (details.reason !== "install") return;
  chrome.tabs.create({ url: chrome.runtime.getURL(PAGE) });
});

/* Safety net: New Admission's HTTP mode installs a declarativeNetRequest session rule (id 8801) that
   rewrites the Referer/Origin of its own admission POSTs. If an old build left one standing, it could
   quietly interfere with normal UMS AJAX. Clear it whenever the service worker starts (install, update,
   browser start, or wake) so no stale rule ever lingers; New Admission re-adds a correctly-scoped one
   only for the brief moment it actually posts. */
(function clearStaleRefererRule() {
  try {
    if (chrome.declarativeNetRequest && chrome.declarativeNetRequest.updateSessionRules)
      chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [8801] });
  } catch (e) {}
})();
chrome.runtime.onStartup && chrome.runtime.onStartup.addListener(function () {
  try { chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [8801] }); } catch (e) {}
});

/* Reopen the tool after an in-tool update. chrome.runtime.reload() (called once an update is written)
   restarts the extension, which closes the tool's own tab — so the update flow sets a short-lived
   "reopen" flag just before reloading, and here, on the fresh service-worker start, we reopen app.html
   and clear the flag. The timestamp guards against reopening on an unrelated wake. */
(function reopenAfterUpdate() {
  try {
    chrome.storage.local.get("umsReopen", function (o) {
      var t = o && o.umsReopen;
      if (!(t && Date.now() - t < 30000)) return;
      try { chrome.storage.local.remove("umsReopen"); } catch (e) {}
      const url = chrome.runtime.getURL(PAGE);
      /* reuse a still-open tool tab if one survived the reload (focus it) instead of stacking a
         second one; otherwise open a fresh tab */
      existingTab(url).then(function (open) {
        if (open) {
          chrome.tabs.update(open.tabId, { active: true }, function () { if (chrome.runtime.lastError) chrome.tabs.create({ url: url }); });
          if (open.windowId != null && open.windowId >= 0) { try { chrome.windows.update(open.windowId, { focused: true }); } catch (e) {} }
        } else {
          chrome.tabs.create({ url: url });
        }
      }).catch(function () { try { chrome.tabs.create({ url: url }); } catch (e) {} });
    });
  } catch (e) {}
})();

/* Don't leave a Headless admission window parked off-screen. It's normally closed when the run ends
   (admCloseRun), but if the tool tab is closed mid-run — or the worker goes idle — the window can
   linger invisibly on the admission form. onSuspend fires only when the service worker is going idle,
   i.e. no run is actively messaging, so anything still open in admSlots at that point is an orphan:
   close it. (A run in progress keeps the worker alive, so this never closes an active window.) */
chrome.runtime.onSuspend && chrome.runtime.onSuspend.addListener(function () {
  try { admCloseRun(); } catch (e) {}
  // if the tool tab was closed mid-crawl its close messages never arrived — clean up here too, so the
  // off-screen/minimized check windows and the dynamically-registered fnprobe content script don't leak
  try { fnVisitClose(); } catch (e) {}
  try { fnShotClose(); } catch (e) {}
});

/* ───────────────────────── New Admission · Browser mode ─────────────────────────
   The HTTP mode (in app.js) posts the admission directly. Browser mode instead opens the real
   admission form in a tab and drives it visibly — the page's own JavaScript does the cascades, fee
   and validation. We only fill fields, tick the course, pick a batch and click Next → Submit, then
   read the payment id off the receipt URL the form redirects to. osl.team is already in
   host_permissions, so opening the tab and reading its URL need no "tabs" permission; injecting the
   driver needs "scripting". */

function waitTabComplete(tabId, ms) {
  return new Promise(function (resolve) {
    let done = false; const t = setTimeout(function () { if (!done) { done = true; chrome.tabs.onUpdated.removeListener(h); resolve(false); } }, ms);
    function h(id, info) { if (id === tabId && info.status === "complete" && !done) { done = true; clearTimeout(t); chrome.tabs.onUpdated.removeListener(h); resolve(true); } }
    chrome.tabs.onUpdated.addListener(h);
    chrome.tabs.get(tabId, function (tab) { if (tab && tab.status === "complete" && !done) { done = true; clearTimeout(t); chrome.tabs.onUpdated.removeListener(h); resolve(true); } });
  });
}
function waitTabUrl(tabId, re, ms) {
  return new Promise(function (resolve) {
    let done = false; const t = setTimeout(function () { if (!done) { done = true; chrome.tabs.onUpdated.removeListener(h); resolve(""); } }, ms);
    function fin(u) { if (!done) { done = true; clearTimeout(t); chrome.tabs.onUpdated.removeListener(h); resolve(u || ""); } }
    function h(id, info, tab) { if (id !== tabId) return; const u = (info && info.url) || (tab && tab.url) || ""; if (re.test(u)) fin(u); }
    chrome.tabs.onUpdated.addListener(h);
    chrome.tabs.get(tabId, function (tab) { if (tab && re.test(tab.url || "")) fin(tab.url); });
  });
}

/* runs INSIDE the admission page (MAIN world) — fills and submits the form, returns {ok,message} */
async function admDriver(p) {
  const $ = function (s) { return document.querySelector(s); };
  const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  /* event-driven wait: a MutationObserver fires the moment the DOM changes (a dropdown gets options,
     the block overlay is removed) — unlike setInterval it is NOT clamped when the tab is in the
     background, so Headless (a throttled background tab) runs almost as fast as the visible Browser.
     A slow interval covers non-DOM changes (e.g. a .value set) and the timeout is the ceiling. */
  const waitFor = function (fn, ms) {
    return new Promise(function (resolve) {
      let done = false; const ok = function () { try { return !!fn(); } catch (e) { return false; } };
      if (ok()) return resolve(true);
      const fin = function (v) { if (done) return; done = true; try { obs.disconnect(); } catch (e) {} clearInterval(iv); clearTimeout(to); resolve(v); };
      const obs = new MutationObserver(function () { if (ok()) fin(true); });
      try { obs.observe(document.documentElement, { childList: true, subtree: true, attributes: true }); } catch (e) {}
      const iv = setInterval(function () { if (ok()) fin(true); }, 250);
      const to = setTimeout(function () { fin(false); }, ms || 15000);
    });
  };
  const noBlock = function () { return waitFor(function () { return !document.querySelector(".blockOverlay,.blockUI"); }, 20000); };
  const setSel = function (sel, val) { const el = $(sel); if (!el) return false; el.value = val; el.dispatchEvent(new Event("change", { bubbles: true })); return true; };
  /* pick the option whose visible text matches — used for Student Class, whose option VALUE is a
     numeric id, not the word "Admission", so setting the value to "Admission" would select nothing */
  const setSelByText = function (sel, re) {
    const el = $(sel); if (!el) return false;
    const opt = Array.prototype.find.call(el.options, function (o) { return re.test(o.textContent || ""); });
    if (!opt || !opt.value) return false;
    el.value = opt.value; el.dispatchEvent(new Event("change", { bubbles: true })); return true;
  };
  const hasOpts = function (sel) { const s = $(sel); return s && s.options.length > 1; };
  /* per-step stopwatch so we can see WHERE Headless loses time to Browser */
  const _t0 = (self.performance || Date).now();
  const _T = []; const _m = function (l) { _T.push(l + Math.round(((self.performance || Date).now()) - _t0)); };
  try {
    await waitFor(function () { return hasOpts("#StudentClass"); }, 10000);
    if (!setSelByText("#StudentClass", /admission/i)) setSel("#StudentClass", "Admission");
    if (!($("#StudentClass") && $("#StudentClass").value)) throw new Error("Student Class সেট হলো না (option এলো না?)");
    await noBlock();
    if (!await waitFor(function () { return hasOpts("#Program"); }, 40000)) throw new Error("Program এলো না");
    _m("prog");
    setSel("#Program", String(p.program)); await noBlock();
    if (!await waitFor(function () { return hasOpts("#Session"); }, 30000)) throw new Error("Session এলো না");
    _m("sess");
    setSel("#Session", String(p.session)); await noBlock();
    await waitFor(function () { return document.querySelector(".course-name-check"); }, 25000);   // let the session cascade finish
    _m("crs");
    setSel("#Gender", String(p.gender)); setSel("#Religion", String(p.religion));
    if ($("#LastInstituteName")) $("#LastInstituteName").value = p.instName || "";
    if ($("#LastInstituteId")) $("#LastInstituteId").value = p.instId || "";
    setSel("#VersionOfStudy", String(p.version)); await noBlock();
    if (!await waitFor(function () { return hasOpts("#Branch"); }, 25000)) {
      const dv = function (s) { const e = $(s); return e ? (e.value || "?") + "/" + ((e.options || []).length) + "o" : "none"; };
      throw new Error("Branch এলো না [ver " + dv("#VersionOfStudy") + " · gen " + dv("#Gender") + " · sess " + dv("#Session") + " · branch " + dv("#Branch") + " · courses " + document.querySelectorAll(".course-name-check").length + "]");
    }
    _m("br");
    setSel("#Branch", String(p.branch)); await noBlock();
    await waitFor(function () { return hasOpts("#Campus"); }, 15000); setSel("#Campus", String(p.campus)); await noBlock();
    if (hasOpts("#AttachedPhysicalBranch") && p.physBranch) setSel("#AttachedPhysicalBranch", String(p.physBranch));
    await waitFor(function () { return document.querySelector(".course-name-check"); }, 15000);
    _m("camp");
    const ids = (p.courseIds || []).map(String);
    const subjDbg = [];
    /* Make the course's subject ticks match what validation wants. The form pre-checks MORE than the
       maximum (e.g. all 6 when only 4 are allowed) and then Next is refused ("Maximum subject … is 4,
       please remove at least 2"). Mirror HTTP's admPickSubjects: take the compulsory/checked ones
       FIRST but stop at the maximum — even a readonly subject beyond the cap gets dropped (readonly
       only blocks typing, not (un)ticking a checkbox; only a disabled one truly can't change) — then
       fill up to the minimum, one per subject group. Runs AFTER the batch is chosen, because picking
       a batch re-renders the course and re-checks every subject, undoing an earlier pass. */
    async function pickSubjects(cid, cb) {
      await waitFor(function () { return document.querySelector(".course-" + cid + "-subjects,[class*='course-" + cid + "-subjects']"); }, 6000);
      let subs = Array.prototype.slice.call(document.querySelectorAll(".course-" + cid + "-subjects"));
      if (!subs.length) subs = Array.prototype.slice.call(document.querySelectorAll("[class*='course-" + cid + "-subjects']"));
      if (!subs.length) { subjDbg.push(cid + ":subs0"); return; }
      const grp = function (s) { const g = s.getAttribute("data-group-no"); return g && g !== "0" ? g : null; };
      const setChk = function (s, on) {   // click to (un)tick; if that didn't take, force it and fire change
        if (s.disabled) return; if (s.checked === on) return;
        s.click();
        if (s.checked !== on) { s.checked = on; s.dispatchEvent(new Event("change", { bubbles: true })); }
      };
      const minSub = parseInt((cb && cb.getAttribute("data-officeminsub")) || "0", 10) || 0;
      const maxSub = parseInt((cb && cb.getAttribute("data-maximumsubject")) || "0", 10) || subs.length;
      const nowChecked = subs.filter(function (s) { return s.checked; }).length;
      const target = Math.max(minSub, Math.min(maxSub, nowChecked || maxSub));   // aim at what the form picked, clamped to [min,max]
      const want = new Set(), groupUsed = {};
      const tryTake = function (s) {
        if (want.size >= target || want.has(s)) return;
        const g = grp(s); if (g) { if (groupUsed[g]) return; groupUsed[g] = 1; }
        want.add(s);
      };
      subs.forEach(function (s) { if (s.checked) tryTake(s); });     // keep the form's own picks first, but capped at target
      subs.forEach(function (s) { if (want.size < target) tryTake(s); });   // fill up to the minimum with the rest
      subs.forEach(function (s) { setChk(s, want.has(s)); });        // apply: uncheck every extra, even a readonly one
      await noBlock();
      subjDbg.push(cid + ":chk" + subs.filter(function (s) { return s.checked; }).length + "/" + subs.length + " min" + minSub + " max" + maxSub);
    }
    for (const cid of ids) {
      const cb = document.querySelector(".course-name-check.course-" + cid) || Array.prototype.find.call(document.querySelectorAll(".course-name-check"), function (c) { const m = (c.className || "").match(/course-(\d+)/); return m && m[1] === cid; });
      if (cb && !cb.checked) cb.click();
      await noBlock();
      for (const cls of [".batch-day-course-" + cid, ".batch-time-course-" + cid, ".batch-course-" + cid]) {
        const ok = await waitFor(function () { const s = $(cls); return s && Array.prototype.some.call(s.options, function (o) { return o.value.trim(); }); }, 9000);
        if (ok) { const s = $(cls); const opt = Array.prototype.find.call(s.options, function (o) { return o.value.trim(); }); s.value = opt.value; s.dispatchEvent(new Event("change", { bubbles: true })); await noBlock(); }
      }
      await pickSubjects(cid, cb);   // after the batch, so its re-render doesn't re-check everything
    }
    _m("loop");
    if ($("#Name")) $("#Name").value = p.name;
    if ($("#MobNumber")) $("#MobNumber").value = p.mobile;
    /* the value setter the form's validation listens to */
    const setVal = function (el, val) { el.value = val; el.dispatchEvent(new Event("input", { bubbles: true })); el.dispatchEvent(new Event("change", { bubbles: true })); };
    /* board rows: fill Board / Exam Group / Result and any other still-empty dropdown the form needs
       (leaving one blank silently blocks Next → the Payment step never appears). Skip the selects we
       already drive — the main cascade and the per-course batch selects. */
    const managed = { StudentClass: 1, Program: 1, Session: 1, Gender: 1, Religion: 1, VersionOfStudy: 1, Branch: 1, Campus: 1, AttachedPhysicalBranch: 1, PaymentMethods: 1 };
    document.querySelectorAll("select").forEach(function (s) {
      if (!s.offsetParent || managed[s.id] || /batch-/.test(s.className)) return;
      if (s.value && s.value.trim()) return;
      const opt = Array.prototype.find.call(s.options, function (o) { return o.value.trim(); });
      if (opt) { s.value = opt.value; s.dispatchEvent(new Event("change", { bubbles: true })); }
    });
    document.querySelectorAll('[id^="examYear"]').forEach(function (el, i) { if (!el.value) setVal(el, i === 0 ? "2024" : "2023"); });
    document.querySelectorAll('[id^="boardRoll"]').forEach(function (el) { if (!el.value) setVal(el, String(Math.floor(Math.random() * 1e6)).padStart(6, "0")); });
    document.querySelectorAll('[id^="registrationNumber"]').forEach(function (el) { if (!el.value) setVal(el, String(Math.floor(Math.random() * 1e7)).padStart(7, "0")); });
    const groups = {};
    document.querySelectorAll("input[type=radio]").forEach(function (r) { if (!r.offsetParent) return; (groups[r.name] = groups[r.name] || []).push(r); });
    Object.keys(groups).forEach(function (k) { const rs = groups[k]; if (!rs.some(function (r) { return r.checked; })) { rs[0].checked = true; rs[0].dispatchEvent(new Event("change", { bubbles: true })); } });
    _m("next");
    const next = $("#newAdmissionNextBtn") || $("#nextBtn"); if (!next) throw new Error("Next বাটন নেই"); next.click();
    await noBlock();
    if (!await waitFor(function () { const el = $("#receivedAmount"); return el && el.offsetParent; }, 20000)) {
      /* say WHY Next didn't advance: the validation messages, or failing that the fields the form
         flagged invalid (jQuery validate marks them .input-validation-error) */
      const msgs = Array.prototype.map.call(document.querySelectorAll("#boardInfoErrorMessage,.field-validation-error,.validation-summary-errors,.text-danger,.alert-danger,.toast-message,.toast-error,.toast,.swal2-html-container,.swal2-title,[id*='ubjectError'],[id*='ourseError']"), function (n) { return (n.textContent || "").replace(/\s+/g, " ").trim(); }).filter(Boolean);
      const bad = Array.prototype.map.call(document.querySelectorAll(".input-validation-error"), function (n) { return n.id || n.name || (n.className || "").split(" ")[0]; }).filter(Boolean);
      let why = Array.from(new Set(msgs)).join(" · ").slice(0, 180);
      if (!why && bad.length) why = "খালি/ভুল ফিল্ড: " + bad.slice(0, 8).join(", ");
      const dbg = subjDbg.length ? " [subj " + subjDbg.join(", ") + "]" : "";
      throw new Error("Payment ধাপে গেল না" + (why ? " — " + why : " (ফর্ম কোনো কারণ দেখায়নি)") + dbg);
    }
    if ($("#receivedAmount") && p.received != null && p.received !== "") { $("#receivedAmount").value = p.received; $("#receivedAmount").dispatchEvent(new Event("input", { bubbles: true })); $("#receivedAmount").dispatchEvent(new Event("change", { bubbles: true })); }
    /* Next Receiving Date is required when there's a due — the form validation blocks Submit without it */
    const nd = new Date(); nd.setDate(nd.getDate() + 2);
    const ndStr = nd.getFullYear() + "-" + String(nd.getMonth() + 1).padStart(2, "0") + "-" + String(nd.getDate()).padStart(2, "0");
    if ($("#nextRecDate")) { $("#nextRecDate").value = ndStr; $("#nextRecDate").dispatchEvent(new Event("change", { bubbles: true })); }
    /* pick a payment method if none is chosen (Cash is the usual default) */
    const pm = $("#PaymentMethods");
    if (pm && !pm.value) { const opt = Array.prototype.find.call(pm.options, function (o) { return o.value.trim(); }); if (opt) { pm.value = opt.value; pm.dispatchEvent(new Event("change", { bubbles: true })); } }
    /* read the money off the Payment step so the run can show Paid / Due like HTTP mode does —
       "paid" is what the form accepted in #receivedAmount, "due" its remaining-amount field */
    const numOf = function (el) { if (!el) return null; const raw = (el.value != null && el.value !== "" ? el.value : el.textContent) || ""; const n = parseFloat(String(raw).replace(/,/g, "").replace(/[^0-9.]/g, "")); return isFinite(n) ? n : null; };
    const firstNum = function (sels) { for (const s of sels) { const n = numOf($(s)); if (n != null) return n; } return null; };
    /* fallback for forms whose fields aren't among the ids above: find the number whose id/name or
       nearest label text matches the hint (due/total/…) */
    const byHint = function (rx) {
      const els = document.querySelectorAll("input,span,td,strong,b,div,label");
      for (let i = 0; i < els.length; i++) {
        const el = els[i]; if (!el.offsetParent) continue;
        const key = ((el.id || "") + " " + (el.name || "") + " " + (el.getAttribute && (el.getAttribute("data-bind") || el.getAttribute("aria-label") || "") || "")).toLowerCase();
        if (rx.test(key)) { const n = numOf(el); if (n != null) return n; }
      }
      return null;
    };
    const paidVal = numOf($("#receivedAmount"));
    let totalVal = firstNum(["#netPayable", "#NetPayable", "#netReceivable", "#NetReceivable", "#totalPayable", "#TotalPayable", "#totalAmount", "#TotalAmount", "#payableAmount", "#PayableAmount", "#grandTotal", "#GrandTotal"]);
    if (totalVal == null) totalVal = byHint(/(net|total|payable|receivable|grand)/);
    let dueVal = firstNum(["#dueAmount", "#DueAmount", "#due", "#Due", "#remainingAmount", "#RemainingAmount", "#duePayment", "#DuePayment"]);
    if (dueVal == null) dueVal = byHint(/(due|remaining|balance)/);
    if (dueVal == null && totalVal != null && paidVal != null) dueVal = Math.max(0, totalVal - paidVal);
    _m("pay");
    const submit = $("#newAdmissionPaymentSubmitBtn") || $("#admissionPaymentSubmitBtn"); if (!submit) throw new Error("Submit বাটন নেই"); submit.click();
    /* wait (event-driven) for either a client validation message or the redirect to the receipt —
       resolves the instant an error shows, so no fixed post-submit delay */
    await waitFor(function () { return /GenerateMoneyReciept/i.test(location.href) || !!document.querySelector("#receivedAmountError,#nextRecDateError,.text-danger,.alert-danger,.field-validation-error"); }, 4000);
    const verr = document.querySelector("#receivedAmountError,#nextRecDateError,.text-danger,.alert-danger,.field-validation-error");
    if (verr && verr.textContent && verr.textContent.trim() && !/GenerateMoneyReciept/i.test(location.href)) return { ok: false, message: verr.textContent.replace(/\s+/g, " ").trim().slice(0, 140) };
    _m("done");
    return { ok: true, paid: paidVal, due: dueVal, total: totalVal, timing: _T.join(" ") };
  } catch (e) { return { ok: false, message: String((e && e.message) || e) }; }
}

function bgSleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
// resolve a promise, but reject if it has not settled in `ms` — so a hung executeScript (e.g. the
// page thread blocked by a dialog) is given up on instead of hanging the whole visit for 60s.
function fnRace(p, ms) { var tm; var g = new Promise(function (_, rej) { tm = setTimeout(function () { rej(new Error("probe timeout")); }, ms); }); return Promise.race([p, g]).finally(function () { clearTimeout(tm); }); }
function getTab(id) { return new Promise(function (r) { chrome.tabs.get(id, function (t) { r(chrome.runtime.lastError ? null : t); }); }); }
const RECEIPT_RE = /GenerateMoneyReciept|GenerateCoursewiseMoneyReciept/i;
function receiptId(url) { const m = url && url.match(/[?&](?:id|studentPaymentIdList)=(\d+)/); return m ? m[1] : ""; }

/* one tab/window per concurrency slot is reused for a whole run (opened once, navigated per
   admission, closed at the end) — so Browser/Headless don't open a new tab for every student, and
   several admissions can run at once (the pool / "একসাথে" count), each isolated in its own slot */
const admSlots = {};   // slot -> { tabId, winId }
async function admEnsureTab(p, url) {
  const slot = p.slot || 0;
  const cur = admSlots[slot];
  if (cur && cur.tabId != null && await getTab(cur.tabId)) { await chrome.tabs.update(cur.tabId, { url: url }); return cur.tabId; }
  if (p.show === false) {
    /* Headless — a window pushed far OFF-SCREEN rather than minimized. A minimized (or background)
       window has visibilityState "hidden", so Chrome clamps its timers to ~1s and the admission
       form's own setTimeout-driven cascades crawl (≈ the 4–5s Headless lost to Browser). An
       off-screen window that is NOT minimized still counts as "visible", so it runs at full speed —
       while staying off the desktop. It never takes focus. Each slot keeps its window for the whole
       run (opens at most once). Note: state can't be combined with bounds, so we pass no state. */
    let win;
    try { win = await chrome.windows.create({ url: url, focused: false, left: 30000, top: 30000, width: 700, height: 560 }); }
    catch (e) { win = await chrome.windows.create({ url: url, focused: false, state: "minimized" }); }   // fallback if bounds are rejected
    const tabId = win && win.tabs && win.tabs[0] && win.tabs[0].id;
    try { await chrome.windows.update(win.id, { left: 30000, top: 30000, focused: false }); } catch (e) {}   // keep it parked off-screen
    admSlots[slot] = { tabId: tabId, winId: win.id };
    return tabId;
  }
  /* Browser — a normal tab in the current window, in front */
  const tb = await chrome.tabs.create({ url: url, active: true });
  admSlots[slot] = { tabId: tb.id, winId: null };
  return tb.id;
}
async function admCloseRun(slot) {
  const keys = slot == null ? Object.keys(admSlots) : [String(slot)];
  for (const k of keys) {
    const s = admSlots[k]; if (!s) continue;
    try { if (s.winId != null) await chrome.windows.remove(s.winId); else if (s.tabId != null) await chrome.tabs.remove(s.tabId); } catch (e) {}
    delete admSlots[k];
  }
}

async function admBrowserRun(p) {
  const url = p.base + "/Student/Admission/NewStudentAdmission";
  try {
    const tabId = await admEnsureTab(p, url);
    if (tabId == null) return { ok: false, message: "ট্যাব খুলল না" };
    /* Wait until the tab is actually ON the admission form. A REUSED slot may still be showing the
       PREVIOUS student's receipt for a moment after tabs.update(url), and waitTabComplete can resolve
       on that stale page — reading the receipt then would report the previous student's id as THIS
       one's success (wrong Reg/Roll, and this student never admitted). So wait for the form (or a
       login redirect) URL first, and drop the old "already on a receipt → done" short-circuit. */
    await waitTabUrl(tabId, /NewStudentAdmission|Account\/Login/i, 30000);
    await waitTabComplete(tabId, 30000);
    await bgSleep(250);   // let any client-side redirect settle before injecting
    const info = await getTab(tabId);
    if (!info) { delete admSlots[p.slot || 0]; return { ok: false, message: "ট্যাব বন্ধ হয়ে গেছে" }; }
    if (/Account\/Login/i.test(info.url || "")) return { ok: false, message: "🔒 লগইন নেই — আগে এই সার্ভারে ব্রাউজারে লগইন করুন: " + (p.base || "(UMS Address খালি)") + " — তারপর আবার চেষ্টা করুন" };
    /* ONE injection only — no retry: the driver clicks the real Submit near the end, and a lost result
       usually means it already submitted and the tab navigated. Re-running would create a DUPLICATE real
       admission. On any loss, wait to see if the receipt appeared (submit went through) before failing. */
    let r = null;
    try {
      const res = await chrome.scripting.executeScript({ target: { tabId: tabId }, world: "MAIN", func: admDriver, args: [p] });
      r = res && res[0] && res[0].result;
    } catch (e) {
      const rc = await waitTabUrl(tabId, RECEIPT_RE, 8000); const id = receiptId(rc);
      if (id) return { ok: true, payId: id, url: rc };
      return { ok: false, message: "injection: " + (String((e && e.message) || e) || "ব্যর্থ") };
    }
    if (r == null) {
      const rc = await waitTabUrl(tabId, RECEIPT_RE, 8000); const id = receiptId(rc);
      if (id) return { ok: true, payId: id, url: rc };
      return { ok: false, message: "driver ফল হারাল (ডুপ্লিকেট এড়াতে re-run করিনি — ট্যাব দেখে নাও)" };
    }
    if (!r.ok) return { ok: false, message: r.message || "ফর্ম পূরণ ব্যর্থ" };
    const rcptUrl = await waitTabUrl(tabId, RECEIPT_RE, 25000);
    const id = receiptId(rcptUrl);
    if (id) return { ok: true, payId: id, url: rcptUrl, paid: r.paid, due: r.due, total: r.total, timing: r.timing };
    return { ok: false, message: "Submit হলো কিন্তু রসিদে পৌঁছাল না (validation আটকে থাকতে পারে)" };
  } catch (e) { return { ok: false, message: String((e && e.message) || e) }; }
}

/* ───────────────────────── Function Check · screenshot ─────────────────────────
   For a page that failed the rapid HTTP check, load it in ONE reused side window parked OFF-SCREEN
   (never focused, never on the visible desktop) and grab a JPEG with chrome.tabs.captureVisibleTab,
   plus a quick DOM probe for a visible error message. No chrome.debugger is used, so Chrome never
   shows its "being debugged" banner. If capture refuses, the shot comes back null and the check simply
   shows the failure without a picture. Read-only: it only opens the page, never clicks anything. */
let fnShot = { tabId: null, winId: null };
async function fnEnsureTab(url) {
  if (fnShot.tabId != null && await getTab(fnShot.tabId)) { await chrome.tabs.update(fnShot.tabId, { url: url }); return fnShot.tabId; }
  // Park the shot window OFF-SCREEN (never focused), NOT minimized: captureVisibleTab needs a window
  // that is not minimized, and off-screen keeps it off the visible desktop while still being capturable.
  let win;
  try { win = await chrome.windows.create({ url: url, focused: false, left: 30000, top: 30000, width: 1200, height: 820 }); }
  catch (e) { win = await chrome.windows.create({ url: url, focused: false, width: 1200, height: 820 }); }
  try { await chrome.windows.update(win.id, { left: 30000, top: 30000, focused: false }); } catch (e) {}
  fnShot.tabId = win && win.tabs && win.tabs[0] && win.tabs[0].id;
  fnShot.winId = win.id;
  return fnShot.tabId;
}
function fnProbePage() {
  // runs in the page: report a VISIBLE error message and whether the page is essentially empty.
  // Visibility matters — a hidden toast/template ("Something went wrong") carries text but is not a
  // real error, so only an element the user would actually see counts.
  try {
    var sel = ".validation-summary-errors, .text-danger, .alert-danger, .field-validation-error, #boardInfoErrorMessage, .exception, .yellow-screen";
    var errText = "";
    var cands = document.querySelectorAll(sel);
    for (var i = 0; i < cands.length; i++) {
      var el = cands[i];
      if (!el.offsetParent && el.offsetWidth === 0 && el.offsetHeight === 0) continue;   // hidden
      var tx = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (tx) { errText = tx; break; }
    }
    if (!errText) {
      var b = (document.body && document.body.innerText || "");
      if (/Server Error in|Exception Details:|Stack Trace:|Runtime Error/i.test(b)) errText = b.replace(/\s+/g, " ").trim().slice(0, 120);
    }
    var len = (document.body && (document.body.innerText || "").replace(/\s+/g, " ").trim().length) || 0;
    return { errText: errText, bodyLen: len, title: document.title || "" };
  } catch (err) { return { errText: "", bodyLen: 0, title: "" }; }
}
async function fnShotRun(url) {
  try {
    var tabId = await fnEnsureTab(url);
    if (tabId == null) return { ok: false };
    await waitTabComplete(tabId, 25000);
    await bgSleep(500);   // let the page paint
    var probe = null;
    try {
      var res = await chrome.scripting.executeScript({ target: { tabId: tabId }, func: fnProbePage });
      probe = res && res[0] && res[0].result;
    } catch (e) {}
    // Capture the off-screen (not minimized) shot window with captureVisibleTab — no chrome.debugger,
    // so NO "being debugged" banner ever appears. The window is off-screen but not minimized, which is
    // exactly what captureVisibleTab needs.
    var shot = null;
    {
      try { shot = await chrome.tabs.captureVisibleTab(fnShot.winId, { format: "jpeg", quality: 55 }); }
      catch (e) { shot = null; }
    }
    return { ok: true, shot: shot, probe: probe };
  } catch (e) { return { ok: false, error: String(e && e.message || e) }; }
}
async function fnShotClose() {
  try { if (fnShot.winId != null) await chrome.windows.remove(fnShot.winId); } catch (e) {}
  fnShot = { tabId: null, winId: null };
}

/* ── Function Check · deep visit (Browser / Headless) ──
   Load each page for real so its JavaScript runs, then read the rendered DOM + any uncaught console
   errors. Browser = a visible front tab; Headless = a hidden BACKGROUND tab in an existing window (no
   new window, so no taskbar entry). Still read-only: it only opens the page. */
let fnVisitSlots = {};   // slot -> { tabId, winId, mode }; one reused tab/window per concurrency slot
let fnVisitTabs = {};    // every Headless BACKGROUND tab we opened (tabId -> 1), so Stop can close even
                         // one an in-flight worker created just after the slots were cleared
let fnVisitWins = {};    // same, for the fallback-window path (winId -> 1) when no host window exists
let fnStopTimer = null;
let fnProbeReg = "";   // origin the console collector is registered for ("" = not registered)
let fnRegPromise = null, fnRegTarget = "";   // shared in-flight registration; kept defensively now that
                                             // the sweep is single-slot, since registering is still async
async function fnRegisterProbe(base) {
  var origin; try { origin = new URL(base).origin; } catch (e) { return; }
  if (fnProbeReg === origin) return;
  // Registration is async, so two overlapping calls would each register "fnprobe" before fnProbeReg is
  // set and their register/unregister calls would race (Duplicate script ID / one undoing another).
  // Share a single in-flight registration per origin instead.
  if (fnRegPromise && fnRegTarget === origin) return fnRegPromise;
  fnRegTarget = origin;
  fnRegPromise = (async function () {
    // A dynamic registration survives service-worker restarts while fnProbeReg resets to "", so ALWAYS
    // clear "fnprobe" by id first — gating on the in-memory flag would leave a stale registration.
    await fnUnregisterProbe();
    try {
      await chrome.scripting.registerContentScripts([{
        id: "fnprobe", matches: [origin + "/*"], js: ["menus/fn/fnprobe.js"],
        runAt: "document_start", world: "MAIN", persistAcrossSessions: false
      }]);
      fnProbeReg = origin;
    } catch (e) { fnProbeReg = ""; }   // old Chrome without world:MAIN → console errors just won't be collected
  })();
  try { await fnRegPromise; } finally { fnRegPromise = null; }
}
async function fnUnregisterProbe() {
  try { await chrome.scripting.unregisterContentScripts({ ids: ["fnprobe"] }); } catch (e) {}
  fnProbeReg = "";
}
/* Wait for the navigation we are ABOUT to start. chrome.tabs.update resolves before the new page
   commits, and for a moment the tab still reports the PREVIOUS page as "complete" — so waiting on
   status alone can hand the probe the page we just navigated away from. Attaching the listener before
   navigating and requiring a loading -> complete transition pins it to the right page. */
function navWatch(tabId, ms) {
  var done = false, t = null, go = null;
  function fin() { if (done) return; done = true; clearTimeout(t); chrome.tabs.onUpdated.removeListener(h); go(); }
  function h(id, info) {
    if (id !== tabId || done) return;
    // Loading started: this IS our navigation, so now allow it the full load budget.
    if (info.status === "loading") { clearTimeout(t); t = setTimeout(fin, ms); h.started = true; }
    else if (info.status === "complete" && h.started) fin();
  }
  chrome.tabs.onUpdated.addListener(h);
  // Short leash until loading actually begins — if the navigation never starts (e.g. the tab is already
  // on that exact URL), give up quickly instead of stalling the whole visit on the load budget.
  return new Promise(function (resolve) { go = resolve; t = setTimeout(fin, 1500); });
}
async function fnEnsureVisit(url, mode, slot) {
  slot = slot || 0;
  var cur = fnVisitSlots[slot];
  if (cur && cur.tabId != null && cur.mode === mode && await getTab(cur.tabId)) {
    var nav = navWatch(cur.tabId, 25000);   // armed BEFORE the navigation starts
    await chrome.tabs.update(cur.tabId, { url: url });
    await nav;
    return cur.tabId;
  }
  if (cur) { try { if (cur.winId != null && cur.mode !== "browser") { delete fnVisitWins[cur.winId]; await chrome.windows.remove(cur.winId); } else if (cur.tabId != null) { delete fnVisitTabs[cur.tabId]; await chrome.tabs.remove(cur.tabId); } } catch (e) {} }
  if (mode === "browser") {
    const tb = await chrome.tabs.create({ url: url, active: true });
    fnVisitSlots[slot] = { tabId: tb.id, winId: tb.windowId, mode: mode };
  } else {
    // Headless = a hidden BACKGROUND tab inside an EXISTING normal window. No new window means NO new
    // taskbar entry and no focus steal — the tab just sits in the background (not the active tab) and
    // is reused for every page. (A background tab is still throttled by Chrome; that is unavoidable for
    // anything not in the foreground.) Only if there is no normal window to host it do we fall back to
    // a minimized window.
    let host = null;
    try {
      let wins = await chrome.windows.getAll({ windowTypes: ["normal"] });
      // Skip incognito: scripting.executeScript and the fnprobe registration do not reach an incognito
      // tab unless the extension is allowed there, so a visit tab in one would score real pages as failed.
      let ok = (wins || []).filter(function (w) { return w && w.type === "normal" && !w.incognito; });
      for (let i = 0; i < ok.length; i++) { if (ok[i].state !== "minimized") { host = ok[i]; break; } }
      if (!host && ok.length) host = ok[0];
    } catch (e) {}
    let tb = null;
    // The host window can be closed between getAll and create; fall through to the window fallback
    // instead of letting the rejection surface as a bogus "page failed" row.
    if (host) { try { tb = await chrome.tabs.create({ windowId: host.id, url: url, active: false }); } catch (e) { tb = null; } }
    if (tb) {
      fnVisitSlots[slot] = { tabId: tb.id, winId: null, mode: mode };
      if (tb.id != null) fnVisitTabs[tb.id] = 1;
    } else {
      let win;
      try { win = await chrome.windows.create({ url: url, state: "minimized" }); }
      catch (e) { win = await chrome.windows.create({ url: url, focused: false }); }
      try { await chrome.windows.update(win.id, { state: "minimized" }); } catch (e) {}
      fnVisitSlots[slot] = { tabId: win && win.tabs && win.tabs[0] && win.tabs[0].id, winId: win.id, mode: mode };
      if (win && win.id != null) fnVisitWins[win.id] = 1;
    }
  }
  return fnVisitSlots[slot].tabId;
}
async function fnProbeDeep(opts) {
  // runs in the loaded page (MAIN world): classify from what actually rendered, and — when opts.actions
  // — auto-fill the form and click each button to see whether the action works. opts.allowWrite gates
  // state-changing buttons (Save/Submit/Delete…) so they fire only on the osl.team test server.
  opts = opts || {};
  function vis(el) { return !!(el && (el.offsetParent || el.offsetWidth || el.offsetHeight)); }
  function fire(el, type) { try { el.dispatchEvent(new Event(type, { bubbles: true })); } catch (e) {} }
  function pageErr() {
    var cands = document.querySelectorAll(".validation-summary-errors, .alert-danger, .exception, .yellow-screen, .swal2-html-container, .toast-error");
    for (var i = 0; i < cands.length; i++) { var el = cands[i]; if (!vis(el)) continue; var tx = (el.textContent || "").replace(/\s+/g, " ").trim(); if (tx) return tx; }
    return "";
  }
  try {
    var errText = pageErr();
    var rawText = (document.body && document.body.innerText) || "";   // keep the line breaks for the detail below
    var bodyText = rawText.replace(/\s+/g, " ").trim();
    var serverErr = /Server Error in|Exception Details:|Stack Trace:|Runtime Error|could not load type|Parser Error/i.test(bodyText);
    // Pull the pinpoint cause off a .NET error page: the exception type+message and the source line.
    var errDetail = "";
    if (serverErr) {
      var bits = [], md;
      if ((md = /Exception Details:\s*([^\n]{3,300})/i.exec(rawText))) bits.push(md[1].trim());
      else if ((md = /Description:\s*([^\n]{3,300})/i.exec(rawText))) bits.push(md[1].trim());
      if ((md = /Source File:\s*([^\n]{3,200}?)\s*Line:\s*(\d+)/i.exec(rawText))) bits.push(md[1].trim().split(/[\\/]/).pop() + ":" + md[2]);
      errDetail = bits.join(" · ").slice(0, 220);
    }
    var isLogin = /\/(account\/)?(log\s*-?\s*(in|on)|login|signin)\b/i.test(location.href);
    var hasStructure = !!document.querySelector("table,form,canvas,svg,input,select,h1,h2,h3");
    var consoleErr = "";
    try { if (window.__fnErr && window.__fnErr.length) consoleErr = window.__fnErr.slice(0, 3).join(" | ").slice(0, 320); } catch (e) {}
    // cosmetic-only problems (a picture that did not load): reported on the row, but never a failure
    var warnText = "";
    try { if (window.__fnWarn && window.__fnWarn.length) warnText = window.__fnWarn.slice(0, 3).join(" | ").slice(0, 320); } catch (e) {}
    return { errText: errText, errDetail: errDetail, serverErr: serverErr, isLogin: isLogin, bodyLen: bodyText.length, hasStructure: hasStructure, consoleErr: consoleErr, warnText: warnText, title: document.title || "" };
  } catch (err) { return { error: String((err && err.message) || err) }; }
}

/* Second, SEPARATE injection (so a button that still navigates can't take the page verdict down with
   it): auto-fill the form, then click every visible enabled button and record a per-button verdict.
   Navigation is held back best-effort (form submits / beforeunload are cancelled) so the page context
   survives and EVERY button gets tested — and, as a bonus, a held-back submit means even a write
   button does not actually commit to the server. opts.allowWrite still gates which buttons are clicked
   at all. Returns the actions array (or whatever was collected before an unavoidable navigation). */
async function fnActionProbe(opts) {
  opts = opts || {};
  function vis(el) { return !!(el && (el.offsetParent || el.offsetWidth || el.offsetHeight)); }
  function fire(el, type) { try { el.dispatchEvent(new Event(type, { bubbles: true })); } catch (e) {} }
  /* Validation and breakage are not the same news. A form that answers "Roll No. should be 7 digits"
     has WORKED: the button fired, the value this probe invented was rejected, and the page is fine.
     Failing the button for that buries the real failures — with write buttons on, nearly every Submit
     would "fail" on made-up values. So the kind travels with the text, and only a real error fails. */
  /* The container cannot tell the two apart: UMS puts "Roll No. should be 7/11 digit number" in the
     very same div.alert-danger it uses for a real failure. So the WORDING decides. A complaint about
     the value we invented means the button fired and the page is fine; anything else still fails.
     Fail-closed on purpose — a message is only downgraded when it clearly reads as validation, and
     never when it carries an exception marker. */
  /* Widened after a real headless run with the buttons on: "select atleast one criteria" and "No
     TeamMember Found To Operate This Operation" were both counted as broken buttons. Neither is —
     the first asks for input, the second says this account's data does not suit the operation. So
     "please" is no longer required before select/enter/choose, UMS's own spelling "atleast" is
     allowed, and "no … found" counts as the app answering rather than failing. */
  var SAYS_VALIDATION = /(is |are )?required|should be|must be|can ?not be|cannot be|invalid|already exist|(please )?(select|enter|provide|choose)\b|digit|character|minimum|maximum|at ?least|no [a-z ]{0,30}(found|available)|not found to|আবশ্যক|দিতে হবে|সঠিক নয়|নির্বাচন কর|পূরণ কর|পাওয়া যায়নি/i;
  var SAYS_BREAKAGE = /exception|stack trace|object reference|server error|runtime error|nullreference|sqlexception|timeout|could not load|parser error|500/i;
  function pageErr() {
    var c = document.querySelectorAll(".validation-summary-errors, .field-validation-error, .alert-danger, .exception, .swal2-html-container, .toast-error");
    for (var i = 0; i < c.length; i++) {
      var el = c[i]; if (!vis(el)) continue;
      var tx = (el.textContent || "").replace(/\s+/g, " ").trim();
      if (!tx) continue;
      var isVal = SAYS_VALIDATION.test(tx) && !SAYS_BREAKAGE.test(tx);
      return { text: tx, validation: isVal };
    }
    return null;
  }
  var actions = [];
  try {
    // hold navigation back so the context survives and nothing is actually committed
    try {
      document.addEventListener("submit", function (e) { try { e.preventDefault(); e.stopImmediatePropagation(); } catch (_) {} }, true);
      window.addEventListener("beforeunload", function (e) { try { e.preventDefault(); e.returnValue = ""; } catch (_) {} });
      // Hold navigation so clicking a button can't destroy the frame (which would lose the whole probe
      // — "Frame with ID 0 was removed"). Cancel anchor clicks, and neuter the programmatic routes.
      document.addEventListener("click", function (e) { try { var a = e.target && e.target.closest && e.target.closest("a[href]"); if (a) { var h = a.getAttribute("href") || ""; if (h && h.charAt(0) !== "#" && !/^javascript:/i.test(h)) e.preventDefault(); } } catch (_) {} }, true);
      try { HTMLFormElement.prototype.submit = function () {}; } catch (_) {}
      try { window.open = function () { return null; }; } catch (_) {}
      // a button that opens a native alert/confirm/prompt would BLOCK the page thread and hang the
      // whole crawl — neutralise them so a click returns immediately (confirm auto-"OK", no prompt text)
      window.alert = function () {}; window.confirm = function () { return true; }; window.prompt = function () { return ""; };
    } catch (e) {}
    var V = opts.vals || {};
    /* In Headless the page sits in a HIDDEN tab, where Chrome clamps setTimeout to >=1s (and to once a
       MINUTE after a few minutes hidden). Sleeping a fixed time there is what made the sweep crawl: a
       120ms settle became a full second, and a 3-poll 700ms button wait became ~3s. So wait for the
       page to actually DO something instead. MutationObserver is not clamped — it fires the moment the
       DOM changes — so the usual case costs only the real response time, and the setTimeout is just a
       cap that is reached only when the click genuinely changed nothing. */
    /* opts.dwell is a FLOOR, not a delay: the waits below resolve the moment the page reacts, which in
       Browser Slow — the mode whose whole point is being watched — would flash past in ~20-50ms. So in
       that mode each step is held on screen for at least this long. It is 0 everywhere else, so Fast
       and Headless pay nothing. The tab is visible whenever dwell > 0, so setTimeout is accurate here. */
    var DWELL = +(opts.dwell || 0);
    function hold(startedAt) {
      var left = DWELL - (Date.now() - startedAt);
      if (!(left > 0)) return Promise.resolve();
      return new Promise(function (r) { setTimeout(r, left); });
    }
    function waitFor(done, capMs, onMutate) {
      var t0 = Date.now();
      return new Promise(function (resolve) {
        var settled = false, mo = null, t = null;
        function fin() {
          if (settled) return;
          settled = true;
          try { if (mo) mo.disconnect(); } catch (e) {}
          if (t) clearTimeout(t);
          resolve();
        }
        try { if (done()) { resolve(); return; } } catch (e) {}
        try {
          mo = new MutationObserver(function () {
            if (onMutate) { try { onMutate(); } catch (e) {} }
            var d = false; try { d = done(); } catch (e) {}
            if (d) fin();
          });
          mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
        } catch (e) { mo = null; }
        t = setTimeout(fin, capMs);
      }).then(function () { return hold(t0); });   // keep it on screen long enough to be followed
    }
    // Resolve on the FIRST DOM change (or at the cap). Used where there is no single condition to test
    // — after filling fields, "the page reacted" is all we need, and the 3-pass fill loop re-fills
    // anything that populated late.
    function waitChange(capMs) {
      var seen = false;
      return waitFor(function () { return seen; }, capMs, function () { seen = true; });
    }
    function fillSelects() {
      var did = 0;
      document.querySelectorAll("select").forEach(function (s) {
        if (!vis(s) || s.disabled || (s.value && s.value.trim())) return;
        var opt = Array.prototype.find.call(s.options, function (o) { return o.value && o.value.trim(); });
        if (opt) { s.value = opt.value; fire(s, "input"); fire(s, "change"); did++; }
      });
      return did;
    }
    function fillInputs() {
      document.querySelectorAll("input,textarea").forEach(function (i) {
        if (!vis(i) || i.disabled || i.readOnly) return;
        var ty = (i.type || "text").toLowerCase();
        if (ty === "hidden" || ty === "file" || ty === "submit" || ty === "button" || ty === "image" || ty === "checkbox") return;
        if (ty === "password") return;   // NEVER fill a password — a submit/AJAX would change real credentials
        if (ty === "radio") { var g = document.querySelectorAll('input[type=radio][name="' + (i.name || "") + '"]'); if (!Array.prototype.some.call(g, function (r) { return r.checked; })) { i.checked = true; fire(i, "change"); } return; }
        if (i.value && i.value.trim()) return;
        var fmtDate = function (dt, slash) { var y = dt.getFullYear(), mo = String(dt.getMonth() + 1).padStart(2, "0"), da = String(dt.getDate()).padStart(2, "0"); return slash ? da + "/" + mo + "/" + y : y + "-" + mo + "-" + da; };
        var today = new Date(), d45 = new Date(); d45.setDate(d45.getDate() - 45);
        var ds = fmtDate(today, false);
        // Roll/Reg/Mobile/TPIN/PIN must get DIGITS, never "test" (UMS uses type=text for these).
        var k = ((i.name || "") + " " + (i.id || "") + " " + (i.placeholder || "") + " " + (i.getAttribute("inputmode") || "") + " " + (i.getAttribute("pattern") || "") + " " + (i.className || "")).toLowerCase();
        var wantNum = /numeric|digit|[0-9\]\}]\*|\[0-9/.test(k) || i.getAttribute("inputmode") === "numeric";
        // A "From / Start" date opens a report range — set it 45 days back so the range is not empty
        // (To/End and plain dates stay today). UMS text datepickers use dd/mm/yyyy; type=date uses ISO.
        var isFromDate = /from|start|begin|\bsince\b|হইতে|থেকে|শুরু/.test(k);
        // match real date fields (fromDate/toDate/startDate/dateFrom/"date"/datepicker/dd-mm-yyyy)
        // without being fooled by candidate / update / validate (which merely contain "date")
        var isDateField = /datepicker|তারিখ|date[_ -]?(from|to|range|picker)|(from|to|start|end)[_ -]?date|(^|[^a-z])date([^a-z]|$)|dd[\/.\-]mm|yyyy/.test(k);
        if (ty === "date") i.value = fmtDate(isFromDate ? d45 : today, false);
        else if (isDateField) i.value = fmtDate(isFromDate ? d45 : today, true);
        else if (ty === "email") i.value = "test@test.com";
        else if (/mobile|phone|contact|\bcell\b|whatsapp|guardian.?no|\bsms\b/.test(k)) i.value = V.mobile || "01700000000";
        else if (/roll/.test(k)) i.value = V.roll || "123456";
        else if (/reg(istration)?|regno|reg[_-]?no|\brn\b/.test(k)) i.value = V.reg || "1234567";
        else if (/tpin|t[_-]?pin/.test(k)) i.value = V.tpin || "1234";
        else if (/\bpin\b|otp|\bcode\b|verification/.test(k)) i.value = V.pin || V.tpin || "1234";
        else if (/mrn|crn|receipt|voucher|trx|transaction|cheque|amount|\bfee\b|taka|bkash|nagad|nid|birth.?cert|account/.test(k)) i.value = "100000";
        else if (ty === "number" || ty === "tel" || wantNum) i.value = i.min || "1";
        else i.value = "test";
        fire(i, "input"); fire(i, "change");
      });
    }
    function dataRows() {   // visible table rows that actually hold data (a <td>)
      var n = 0;
      document.querySelectorAll("table tr").forEach(function (tr) { if (vis(tr) && tr.querySelector("td")) n++; });
      return n;
    }
    function valCount() {   // visible, non-empty validation messages on screen
      var n = 0;
      document.querySelectorAll(".field-validation-error, .validation-summary-errors li, .invalid-feedback, .text-danger, [id$='Error'], [id$='error']").forEach(function (el) {
        if (vis(el) && (el.textContent || "").replace(/\s+/g, " ").trim()) n++;
      });
      return n;
    }

    // ---- EMPTY-field submit check (before filling) ----
    // Click the form's primary Submit with everything still blank, to confirm its validation fires.
    // Navigation is already held back, so an empty submit on a well-formed form just shows its
    // required-field messages / reveals a new control — it does not reach the server.
    try {
      var sub = document.querySelector('input[type=submit], button[type=submit]');
      if (!sub) { var bb = document.querySelectorAll("button, input[type=button], [role=button]"); for (var si = 0; si < bb.length; si++) { if (vis(bb[si]) && /submit|search|go|next|ok|save/i.test((bb[si].value || bb[si].textContent || ""))) { sub = bb[si]; break; } } }
      if (sub && vis(sub) && !sub.disabled && !document.querySelector("input[type=password]")) {
        var visCount = function (sel) { var n = 0; document.querySelectorAll(sel).forEach(function (el) { if (vis(el)) n++; }); return n; };
        var vb = valCount(), url0 = location.href;
        var btnB = visCount("button, input[type=submit], input[type=button], [role=button]"), inpB = visCount("input, select, textarea"), rowB = dataRows();
        try { if (window.__fnErr) window.__fnErr.length = 0; } catch (e) {}
        sub.click();
        await waitChange(700);   // validation / new form appearing is a DOM change — no fixed sleep
        if (location.href === url0) {
          var va = valCount();
          var jsErr = ""; try { if (window.__fnErr && window.__fnErr.length) jsErr = window.__fnErr.slice(0, 2).join(" | "); } catch (e) {}
          // a brand-new control / form / table appearing is the page responding correctly, even with
          // no validation message (e.g. New Admission opens its form on an empty Submit).
          var grew = visCount("button, input[type=submit], input[type=button], [role=button]") > btnB || visCount("input, select, textarea") > inpB || dataRows() > rowB;
          if (jsErr) actions.push({ label: "(খালি submit)", pass: false, reason: "JS error: " + jsErr.slice(0, 70) });
          else if (va > vb) actions.push({ label: "(খালি submit)", pass: true, reason: "✓ validation এলো — " + va + " টি বার্তা" });
          else if (grew) actions.push({ label: "(খালি submit)", pass: true, reason: "✓ খালি Submit-এ এগোলো — নতুন ফর্ম/কনটেন্ট এলো" });
          else actions.push({ label: "(খালি submit)", pass: true, reason: "খালি Submit — validation নেই, কিছু বদলায়নি" });
        }
      }
    } catch (e) {}

    // several passes so cascading dropdowns (one selection loads the next via AJAX) ALL get set
    try {
      // 3 passes so dependent dropdowns that populate after a change event get filled on the next pass
      for (var pass = 0; pass < 3; pass++) { var changed = fillSelects(); fillInputs(); await waitChange(changed ? 350 : 120); }
    } catch (e) {}

    // Changing a password would lock the real user out, so on any page carrying a password box the
    // write buttons are left untouched — even on the osl.team test server.
    var hasPassword = !!document.querySelector("input[type=password]");
    var WRITE = /\b(save|submit|create|add|update|edit|delete|remove|destroy|confirm|send|issue|approve|reject|block|reset|import|sync|generate|pay|void|settle|distribute|transfer|assign|post|enable|disable|process|finalize|publish|freeze|promote|migrate|merge|lock|unlock)\b|সংরক্ষণ|জমা|হালনাগাদ|মুছ|পাঠা/i;
    var VIEW = /\b(view|search|find|show|report|load|filter|list|get|display|preview|check|go|ok)\b|খুঁজ|দেখ|অনুসন্ধান/i;
    // Re-scan before EACH click, not once up front: clicking a button (e.g. an empty-field Submit)
    // can reveal NEW buttons, and those must be tested too. `tested` holds the elements already done.
    var SEL = "button, input[type=submit], input[type=button], [role=button], a.btn";
    var tested = [];
    function nextBtn() {
      var list = document.querySelectorAll(SEL);
      for (var j = 0; j < list.length; j++) { var el = list[j]; if (vis(el) && !el.disabled && tested.indexOf(el) < 0) return el; }
      return null;
    }
    var count = 0, navAway = false;
    while (count < 16 && !navAway) {
      var b = nextBtn(); if (!b) break;
      tested.push(b); count++;
      var label = ((b.value || b.textContent || b.title || "").replace(/\s+/g, " ").trim() || "button").slice(0, 40);
      // several buttons can share a label (e.g. many "Select All") — tag each with context so it is
      // clear WHICH one: its id/name, else the nearest column/section heading, else a running number.
      var ctx = (b.id || b.name || "").trim();
      if (!ctx) {
        try {
          var host = b.closest && b.closest("td, th, fieldset, .card, .panel, .box, .form-group, .tab-pane, section");
          var h = host && host.querySelector && host.querySelector("legend, .card-header, .card-title, .panel-heading, th, h1, h2, h3, h4, label");
          if (h && h !== b) ctx = (h.textContent || "").replace(/\s+/g, " ").trim().slice(0, 24);
        } catch (e) {}
      }
      if (!ctx) ctx = "#" + count;
      if (ctx && label.toLowerCase().indexOf(ctx.toLowerCase()) < 0) label = label + " · " + ctx;
      var isWrite = WRITE.test(label) || /submit/i.test(b.type || "");
      if (isWrite && (hasPassword || /password|change.?pass|credential/i.test(label))) { actions.push({ label: label, pass: true, reason: "skipped — password/credential (নিরাপত্তা)" }); continue; }
      // a plain navigational link (<a class=btn href=/page>) only changes location — which we hold
      // back — so it never loads a table in place; don't judge it by the view/table rule.
      var hrefAttr = (b.tagName === "A" && b.getAttribute("href")) || "";
      var isNavLink = !!hrefAttr && hrefAttr.charAt(0) !== "#" && !/^javascript:/i.test(hrefAttr);
      var isView = VIEW.test(label) && !isWrite && !isNavLink;
      var before = location.href, rowsBefore = dataRows();
      try { if (window.__fnErr) window.__fnErr.length = 0; } catch (e) {}
      try { b.click(); } catch (e) { actions.push({ label: label, pass: false, reason: "click error: " + ((e && e.message) || e) }); continue; }
      // Wait for the result: the click either navigates or renders something (a view/search loads its
      // table over AJAX). Resolve the moment that shows up rather than polling on a clock — the cap is
      // only reached when the click genuinely did nothing.
      await waitFor(function () {
        return location.href !== before || (isView && dataRows() > rowsBefore);
      }, isView ? 2000 : 700);
      if (location.href !== before) { actions.push({ label: label, pass: true, reason: "action triggered (পেজ বদলেছে)" }); navAway = true; continue; }
      var er = pageErr();
      var ce = ""; try { if (window.__fnErr && window.__fnErr.length) ce = window.__fnErr.slice(0, 2).join(" | "); } catch (e) {}
      // the form answered about the value, so the button fired and the page is fine — said plainly
      // rather than counted as a failure
      if (er && er.validation) {
        actions.push({ label: label, pass: true, validation: true,
          reason: "ভ্যালিডেশন: " + er.text.slice(0, 70) });
        continue;
      }
      if (er) { actions.push({ label: label, pass: false, reason: "error: " + er.text.slice(0, 70) }); continue; }
      if (ce) { actions.push({ label: label, pass: false, reason: "JS error: " + ce.slice(0, 70) }); continue; }
      if (isNavLink) { actions.push({ label: label, pass: true, reason: "লিংক বাটন — নেভিগেশন আটকানো হয়েছে (error নেই)" }); continue; }
      if (isView) {
        var rowsAfter = dataRows(), hasTable = !!document.querySelector("table");
        if (rowsAfter > 0) actions.push({ label: label, pass: true, reason: "✓ টেবিল এলো — " + rowsAfter + " row" });
        else if (hasTable) actions.push({ label: label, pass: true, reason: "টেবিল আছে, কিন্তু কোনো data row নেই (০ row)" });
        else actions.push({ label: label, pass: false, reason: "⚠ View চাপার পরও কোনো data table এলো না" });
      } else actions.push({ label: label, pass: true, reason: "ok" });
    }
  } catch (e) { actions.push({ label: "(action probe)", pass: false, reason: String((e && e.message) || e) }); }
  return actions;
}
async function fnVisitRun(url, mode, base, actions, vals, slot, pace) {
  try {
    // A visit means a run is live, so cancel any teardown sweep still pending from a previous Stop —
    // otherwise it would fire mid-run and close this run's brand-new visit tab.
    if (fnStopTimer) { clearTimeout(fnStopTimer); fnStopTimer = null; }
    await fnRegisterProbe(base);
    var tabId = await fnEnsureVisit(url, mode, slot || 0);
    if (tabId == null) return { ok: false, error: "tab/window তৈরি হয়নি" };
    await waitTabComplete(tabId, 25000);
    // The panel owns the pacing (see PACE in menus/fn/fn.js) and sends it with each visit, so "what
    // Fast and Slow mean" lives in exactly one place.
    pace = pace || {};
    await bgSleep(typeof pace.settle === "number" ? pace.settle : 180);
    // write-gate: state-changing buttons fire only on the osl.team test server
    var allowWrite = false;
    try { allowWrite = /(^|\.)osl\.team$/i.test(new URL(base).hostname); } catch (e) {}
    var opts = { actions: !!actions, allowWrite: allowWrite, vals: vals || {}, dwell: +(pace.dwell || 0) };
    var probe = null;
    var useMain = true;
    try {
      // MAIN world lets the probe read the console-error collector; fall back to the default world
      // (DOM check still works, just no window.__fnErr) on a Chrome that rejects world:MAIN here.
      var res;
      try { res = await fnRace(chrome.scripting.executeScript({ target: { tabId: tabId }, world: "MAIN", func: fnProbeDeep, args: [opts] }), 12000); }
      catch (e1) { useMain = false; res = await fnRace(chrome.scripting.executeScript({ target: { tabId: tabId }, func: fnProbeDeep, args: [opts] }), 12000); }
      probe = res && res[0] && res[0].result;
      if (!probe) probe = { error: "probe ফলাফল পাওয়া যায়নি" };
    } catch (e) { probe = { error: String((e && e.message) || e) }; }
    // second, separate injection: fill the form and click the buttons (page verdict already captured
    // above, so a button that navigates can't erase it). Skipped on a login/error/blank page.
    // FAIL-CLOSED: filling fires change events and clicking fires handlers, either of which can write
    // via AJAX (the submit/beforeunload hold-back does NOT stop AJAX). So the whole fill+click only
    // runs on the osl.team TEST server (allowWrite). On any other host it is skipped entirely — no
    // field is touched, no button is clicked — so production data can never be mutated.
    if (opts.actions && probe && !probe.error && !probe.isLogin && !probe.serverErr) {
      if (!opts.allowWrite) {
        probe.actions = [{ label: "(button test)", pass: true, reason: "skipped — বাটন-টেস্ট শুধু *.osl.team টেস্ট সার্ভারে চলে (নিরাপত্তা)" }];
      } else try {
        var ar;
        var tgt = { target: { tabId: tabId }, func: fnActionProbe, args: [opts] };
        if (useMain) tgt.world = "MAIN";
        ar = await fnRace(chrome.scripting.executeScript(tgt), 55000);   // generous cap for the full fill+click pass
        probe.actions = (ar && ar[0] && ar[0].result) || [];
      } catch (e) {
        // A button navigated the page before we could hold it back → the injected frame is gone. That
        // means a button DID fire (not an error), we just couldn't test the rest — report it softly.
        var m = String((e && e.message) || e);
        if (/frame .*remov|no frame|frame with id|context invalid|navigat/i.test(m)) probe.actions = [{ label: "(buttons)", pass: true, reason: "একটি বাটন পেজ নেভিগেট করেছে — বাকি বাটন টেস্ট করা গেল না" }];
        else probe.actions = [{ label: "(buttons)", pass: false, reason: "inject সমস্যা — " + m }];
      }
    }
    // Headless takes NO screenshot: it runs in a background tab, and captureVisibleTab can only grab
    // the ACTIVE tab of a non-minimized window. Capturing a hidden tab would need chrome.debugger,
    // which pops a "being debugged" banner on the user's window — so Headless stays silent instead.
    // Use HTTP or Browser mode when failure screenshots are wanted.
    return { ok: true, probe: probe };
  } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
}
let fnTearingDown = false;   // set while we close our own tabs, so onRemoved doesn't re-run the cleanup
async function fnCloseAllVisits() {
  fnTearingDown = true;
  try {
  for (var k in fnVisitSlots) {
    var s = fnVisitSlots[k]; if (!s) continue;
    try { if (s.winId != null && s.mode !== "browser") await chrome.windows.remove(s.winId); else if (s.tabId != null) await chrome.tabs.remove(s.tabId); } catch (e) {}
  }
  fnVisitSlots = {};
  // close every headless window AND background tab we ever opened — catches one a slot no longer
  // points at (e.g. a straggler an in-flight worker created just after the slots were cleared)
  for (var w in fnVisitWins) { try { await chrome.windows.remove(parseInt(w, 10)); } catch (e) {} }
  fnVisitWins = {};
  for (var tt in fnVisitTabs) { try { await chrome.tabs.remove(parseInt(tt, 10)); } catch (e) {} }
  fnVisitTabs = {};
  } finally { fnTearingDown = false; }
}
async function fnVisitClose() {
  await fnCloseAllVisits();
  // On Stop, a worker whose fnVisit message was already in flight can create its tab/window a moment
  // AFTER this close ran — so sweep once more shortly to catch that straggler. A new run cancels this
  // timer at the top of fnVisitRun, so it can never close a fresh run's tab.
  if (fnStopTimer) clearTimeout(fnStopTimer);
  fnStopTimer = setTimeout(function () { fnStopTimer = null; fnCloseAllVisits(); }, 900);
  await fnUnregisterProbe();
}

/* ───────────────────────── Course Cancel (menus/cc) ─────────────────────────
   One student programme per call, through the same three screens a person uses: the search page
   (/Student/CancelCourse/CancelCourseOrSubject — type the Reg, open the programme's "Cancel Course"
   link), the form (untick the course, Approved By, reason) and — unless it is a dry run — its
   Submit. The steps themselves run INSIDE the page (menus/cc/cc-page.js, with the rules from
   cc-core.js); this side only moves the tab and reads where it lands.
   Like New Admission: one tab reused for the whole run, Submit injected ONCE and never re-run (a
   lost result usually means it went through and the tab moved on), and success is the receipt page.
   Writes are allowed on osl.team (test/staging) and orgbd.net only — the same line cc-core.js
   canWrite draws in the page; umsbd.net and anything else stay read-only. */
const CC_FILES = ["menus/cc/cc-core.js", "menus/cc/cc-page.js"];
const CC_SEARCH_RE = /\/Student\/CancelCourse\/CancelCourseOrSubject/i;
const CC_FORM_RE = /\/Student\/CancelCourse\/CancelCourse\?/i;
let ccTab = { tabId: null, winId: null };
function ccCanWrite(base) { try { const u = new URL(base); return u.protocol === "https:" && /(^|\.)(osl\.team|orgbd\.net)$/i.test(u.hostname); } catch (e) { return false; } }
function ccLoginMsg(base) { return "🔒 লগইন নেই — আগে এই সার্ভারে ব্রাউজারে লগইন করুন: " + (base || "(UMS Address খালি)") + " — তারপর আবার চেষ্টা করুন"; }
async function ccEnsureTab(p) {
  if (ccTab.tabId != null && await getTab(ccTab.tabId)) return ccTab.tabId;
  if (p.show === false) {
    // Headless — parked off-screen but not minimized, so the page's timers are not throttled (see admEnsureTab)
    let win;
    try { win = await chrome.windows.create({ url: "about:blank", focused: false, left: 30000, top: 30000, width: 1000, height: 760 }); }
    catch (e) { win = await chrome.windows.create({ url: "about:blank", focused: false, state: "minimized" }); }
    try { await chrome.windows.update(win.id, { left: 30000, top: 30000, focused: false }); } catch (e) {}
    ccTab = { tabId: win && win.tabs && win.tabs[0] && win.tabs[0].id, winId: win.id };
  } else {
    const tb = await chrome.tabs.create({ url: "about:blank", active: true });
    ccTab = { tabId: tb.id, winId: null };
  }
  return ccTab.tabId;
}
/* Navigate and wait for THIS navigation to finish loading: a "complete" counts only after a
   "loading" seen once the navigation was asked for, so the page that was already there — the last
   student's search page, a receipt, the form after an unsure Submit — can never answer for the new
   one, even when the address is the same.
   It goes by load status, not by address, on purpose. Without the "tabs" permission Chrome shows an
   extension no address for a page outside its host list, about:blank included: the first cut parked
   the tab on about:blank between students and then waited for an address it could never see, so
   every student after a successful cancel lost the full 10 s timeout (17 Oct 2026, "ekta cancel korar
   por … blank window ashe").
   kick() starts the navigation — an address, or a click on the page (the old way's "Cancel Course"
   button) — and resolves false if it decided not to; it is called only once the listener is up.
   → "complete" | "timeout" | "gone" (tab closed) | "refused" (kick said no) */
function ccLoadBy(tabId, kick, ms) {
  return new Promise(function (resolve) {
    let started = false, over = false, timer = null;
    const h = function (id, info) {
      if (id !== tabId) return;
      if (info.status === "loading") started = true;
      else if (info.status === "complete" && started) fin("complete");
    };
    const fin = function (v) { if (over) return; over = true; clearTimeout(timer); chrome.tabs.onUpdated.removeListener(h); resolve(v); };
    chrome.tabs.onUpdated.addListener(h);           // listening BEFORE the navigation is asked for
    timer = setTimeout(function () { fin("timeout"); }, ms);
    Promise.resolve().then(kick).then(function (r) { if (r === false) fin("refused"); }, function () { fin("gone"); });
  });
}
function ccLoad(tabId, url, ms) {
  return ccLoadBy(tabId, function () {
    return new Promise(function (res, rej) {
      chrome.tabs.update(tabId, { url: url }, function () { if (chrome.runtime.lastError) rej(chrome.runtime.lastError); else res(true); });
    });
  }, ms);
}
/* Move the tab and make sure it landed on a page of that kind (or say where it went instead). */
async function ccGo(tabId, url, re, base) {
  if (!(await getTab(tabId))) return { ok: false, code: "tab", why: "UMS ট্যাব বন্ধ হয়ে গেছে" };
  return ccLanded(tabId, await ccLoad(tabId, url, 45000), re, base);
}
async function ccLanded(tabId, how, re, base) {
  const info = how === "gone" ? null : await getTab(tabId);
  if (!info) return { ok: false, code: "tab", why: "UMS ট্যাব বন্ধ হয়ে গেছে" };
  if (/Account\/Login/i.test(info.url || "")) return { ok: false, code: "login", why: ccLoginMsg(base) };
  if (how === "timeout") return { ok: false, code: "timeout", why: "UMS পাতা ৪৫ সেকেন্ডে খোলেনি" };
  if (!re.test(info.url || "")) return { ok: false, code: "page", why: "UMS অন্য পাতায় নিয়ে গেছে: " + (info.url || "(ঠিকানা দেখা যায়নি)") };
  await bgSleep(200);   // let the page's own ready-handlers bind before a step is injected
  return { ok: true };
}
// one read-only step (search / fill / probe); a step that hangs is given up on after `ms`
async function ccStep(tabId, step, msg, ms) {
  await chrome.scripting.executeScript({ target: { tabId: tabId }, files: CC_FILES });
  const res = await fnRace(chrome.scripting.executeScript({ target: { tabId: tabId },
    func: function (s, m) { return self.UMSCCPAGE[s](m); }, args: [step, msg] }), ms);
  return (res && res[0] && res[0].result) || { ok: false, code: "page", why: "পাতা কোনো উত্তর দেয়নি" };
}
/* After an unsure Submit: open the form again and look — read only — so the row says which way it
   went instead of leaving a guess. The row stays "unsure" either way; a person confirms it. */
async function ccRecheck(tabId, href, p) {
  try {
    const g = await ccGo(tabId, href, CC_FORM_RE, p.base);
    if (!g.ok) return "";
    const q = await ccStep(tabId, "probe", { spid: p.spid, courses: p.courses }, 20000);
    if (!q.ok) return "";
    const st = p.courses.map(function (id) { return q.state[id]; });
    if (st.every(function (x) { return x === "ticked"; })) return " · আবার খুলে দেখা গেল course এখনো আছে — বাতিল হয়নি বলে মনে হচ্ছে";
    if (st.every(function (x) { return x !== "ticked"; })) return " · আবার খুলে দেখা গেল course আর টিক দেওয়া নেই — বাতিল হয়েছে বলে মনে হচ্ছে, Payment History-তে CRN দেখো";
    return " · কিছু course আছে, কিছু নেই — হাতে দেখো";
  } catch (e) { return ""; }
}
/* p: { base, reg, spid, courses[], pin, reason, nextDate, dry, show } →
   { status: "done" | "dry" | "skip" | "unsure", why, code, fatal, program, amounts, names, approver, url } */
async function ccBrowserRun(p) {
  if (!ccCanWrite(p.base)) return { status: "skip", code: "host", fatal: true, why: "Course Cancel শুধু *.osl.team আর orgbd.net-এ চলে" };
  const info = {};
  try {
    const tabId = await ccEnsureTab(p);
    if (tabId == null) return { status: "skip", code: "tab", fatal: true, why: "ট্যাব খুলল না" };

    /* Fast path: straight to the form — the very address UMS's own "Cancel Course" link points at —
       and, from that form, UMS's own lookup confirms this Reg has this StudentProgramId (cc-page.js
       check). One page load fewer per student than clicking through the search page (asked for on
       17 Oct 2026: "url bania … ro fast hoto"). Until that answer is in, the form is not touched. */
    let href = p.base + "/Student/CancelCourse/CancelCourse?studentProgramId=" + encodeURIComponent(p.spid) +
      "&stdRollOrRegistrationNo=" + encodeURIComponent(p.reg);
    let confirmed = false;
    // p.route "search" = the old way only (the menu's 🔎 switch): no direct address at all
    if (p.route !== "search") {
      const g = await ccGo(tabId, href, CC_FORM_RE, p.base);
      if (!g.ok && (g.code === "login" || g.code === "tab")) return { status: "skip", code: g.code, fatal: true, why: g.why };
      if (g.ok) {
        let c;
        try { c = await ccStep(tabId, "check", { reg: p.reg, spid: p.spid }, 60000); }
        catch (e) { c = { ok: false, code: "lookup", why: String((e && e.message) || e) }; }
        if (c.code === "login") return { status: "skip", code: "login", fatal: true, why: ccLoginMsg(p.base) };
        if (c.ok) { confirmed = true; info.program = [c.program, c.session].filter(Boolean).join(" "); }
        // UMS answered, and the answer is no: this Reg has no such programme to cancel
        else if (c.code !== "lookup" && c.code !== "page") return { status: "skip", code: c.code, why: c.why };
      }
    }

    /* The old way, as a person clicks through: the Cancel Course search page → type the Reg → its
       Submit → this programme's "Cancel Course" button → the form. Chosen with the 🔎 switch, and
       also the fallback when the fast path got no answer (the form did not open, or the lookup came
       back as something unreadable). */
    if (!confirmed) {
      let s = null;
      for (let a = 0; a < 3; a++) {      // a lookup changes nothing, so it may be repeated
        const gs = await ccGo(tabId, p.base + "/Student/CancelCourse/CancelCourseOrSubject", CC_SEARCH_RE, p.base);
        if (!gs.ok) {
          if (gs.code === "login" || gs.code === "tab") return { status: "skip", code: gs.code, fatal: true, why: gs.why };
          s = gs; continue;
        }
        try { s = await ccStep(tabId, "search", { reg: p.reg, spid: p.spid }, 90000); }
        catch (e) { s = { ok: false, code: "timeout", why: String((e && e.message) || e) }; }
        if (s.ok || (s.code !== "timeout" && s.code !== "page")) break;
      }
      if (!s.ok) return { status: "skip", code: s.code, why: s.why };
      info.program = [s.program, s.session].filter(Boolean).join(" ");
      // only ever follow the programme's link on the same UMS the run was pointed at
      if (new URL(s.href).host !== new URL(p.base).host) return Object.assign({ status: "skip", code: "page", why: "লিংক অন্য সার্ভারে: " + s.href }, info);
      href = s.href;
      // press the programme's own "Cancel Course" button (cc-page.js follow), and wait for the form it opens
      let refused = null;
      const how = await ccLoadBy(tabId, async function () {
        try {
          await chrome.scripting.executeScript({ target: { tabId: tabId }, files: CC_FILES });
          const res = await chrome.scripting.executeScript({ target: { tabId: tabId },
            func: function (m) { return self.UMSCCPAGE.follow(m); }, args: [{ reg: p.reg, spid: p.spid }] });
          const r = res && res[0] && res[0].result;
          if (r && !r.ok) { refused = r; return false; }
          return true;
        } catch (e) { return true; }      // the click already took the page away — the load decides
      }, 45000);
      if (refused) return Object.assign({ status: "skip", code: refused.code, why: refused.why }, info);
      const g2 = await ccLanded(tabId, how, CC_FORM_RE, p.base);
      if (!g2.ok) return Object.assign({ status: "skip", code: g2.code, fatal: g2.code === "login" || g2.code === "tab", why: g2.why }, info);
    }
    let f;
    try { f = await ccStep(tabId, "fill", { spid: p.spid, courses: p.courses, pin: p.pin, reason: p.reason, nextDate: p.nextDate, zeroOnly: p.zeroOnly === true }, 60000); }
    catch (e) { f = { ok: false, code: "timeout", why: String((e && e.message) || e) }; }
    info.amounts = f.amounts || null;
    info.names = (f.courses || []).map(function (c) { return c.name; });
    if (!f.ok) return Object.assign({ status: "skip", code: f.code, why: f.why }, info);
    if (p.dry) return Object.assign({ status: "dry", approver: f.approver }, info);

    // the one step that writes to UMS — injected once, never retried
    let r = null;
    try {
      await chrome.scripting.executeScript({ target: { tabId: tabId }, files: CC_FILES });
      const res = await chrome.scripting.executeScript({ target: { tabId: tabId },
        func: function (m) { return self.UMSCCPAGE.submit(m); },
        args: [{ spid: p.spid, courses: p.courses, reason: p.reason, approverId: f.approverId, expect: f.amounts, zeroOnly: p.zeroOnly === true }] });
      r = res && res[0] && res[0].result;
    } catch (e) { r = null; }          // the receipt page replaced the form mid-call — the address decides
    if (r && !r.ok && r.code !== "unsure") return Object.assign({ status: "skip", code: r.code, sent: r.sent, why: r.why }, info);
    const rc = await waitTabUrl(tabId, RECEIPT_RE, r ? 5000 : 25000);
    if (rc) return Object.assign({ status: "done", url: rc }, info);
    const why = (r && r.why) || "Submit-এর পর রসিদের পাতা আসেনি";
    return Object.assign({ status: "unsure", why: why + await ccRecheck(tabId, href, p) }, info);
  } catch (e) { return Object.assign({ status: "skip", code: "error", why: String((e && e.message) || e) }, info); }
}
async function ccClose() {
  const c = ccTab; ccTab = { tabId: null, winId: null };
  try { if (c.winId != null) await chrome.windows.remove(c.winId); else if (c.tabId != null) await chrome.tabs.remove(c.tabId); } catch (e) {}
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  // These commands drive real browsing (open tabs, fill forms, click buttons), so only our OWN
  // extension pages may issue them. menus/*.js and app.html are web-accessible on the UMS hosts, so
  // without this a content script on one of those pages could hand us an arbitrary base/url.
  if (!sender || sender.id !== chrome.runtime.id) return;
  if (!sender.url || sender.url.indexOf(chrome.runtime.getURL("")) !== 0) return;   // extension page only
  if (msg && msg.type === "admBrowser") { admBrowserRun(msg.params || {}).then(sendResponse); return true; }
  if (msg && msg.type === "admBrowserClose") { admCloseRun(msg.slot).then(function () { sendResponse({ ok: true }); }); return true; }
  if (msg && msg.type === "ccBrowser") { ccBrowserRun(msg.params || {}).then(sendResponse); return true; }
  if (msg && msg.type === "ccBrowserClose") { ccClose().then(function () { sendResponse({ ok: true }); }); return true; }
  if (msg && msg.type === "fnShot") { fnShotRun(msg.url).then(sendResponse); return true; }
  if (msg && msg.type === "fnShotClose") { fnShotClose().then(function () { sendResponse({ ok: true }); }); return true; }
  if (msg && msg.type === "fnVisit") { fnVisitRun(msg.url, msg.mode, msg.base, msg.actions, msg.vals, msg.slot, msg.pace).then(sendResponse); return true; }
  if (msg && msg.type === "fnVisitClose") { fnVisitClose().then(function () { sendResponse({ ok: true }); }); return true; }
});
/* If the user closes a Function-Check window by hand (or the panel goes away mid-crawl and its close
   message never arrives), drop our state and unregister the console collector so nothing leaks. */
/* The panel holds a port open for the duration of a run. If the panel tab/window goes away mid-run its
   fnVisitClose never arrives, and because the Headless visit tab lives inside the USER's own window it
   would just sit there orphaned. onSuspend is not a reliable place to clean that up (it is not
   guaranteed, and async work after the first await is routinely cut), but onDisconnect is. */
if (chrome.runtime.onConnect) {
  chrome.runtime.onConnect.addListener(function (port) {
    if (!port || port.name !== "fnrun") return;
    if (!port.sender || port.sender.id !== chrome.runtime.id) { try { port.disconnect(); } catch (e) {} return; }
    port.onDisconnect.addListener(function () { void chrome.runtime.lastError; fnVisitClose(); fnShotClose(); });
  });
}
if (chrome.windows && chrome.windows.onRemoved) {
  chrome.windows.onRemoved.addListener(function (winId) {
    for (var k in fnVisitSlots) { if (fnVisitSlots[k] && fnVisitSlots[k].winId === winId) { delete fnVisitSlots[k]; } }
    delete fnVisitWins[winId];
    if (!Object.keys(fnVisitSlots).length) fnUnregisterProbe();
    if (fnShot && fnShot.winId === winId) { fnShot = { tabId: null, winId: null }; }
  });
}
if (chrome.tabs && chrome.tabs.onRemoved) {
  chrome.tabs.onRemoved.addListener(function (tabId) {
    // This fires for EVERY tab the user closes anywhere in Chrome, so bail out immediately unless the
    // tab was one of ours — otherwise each ordinary tab close would wake the worker to unregister the
    // probe for no reason.
    var ours = !!fnVisitTabs[tabId];
    for (var k in fnVisitSlots) {
      if (fnVisitSlots[k] && fnVisitSlots[k].winId == null && fnVisitSlots[k].tabId === tabId) { ours = true; delete fnVisitSlots[k]; }
    }
    if (!ours) return;
    delete fnVisitTabs[tabId];
    if (fnTearingDown) return;   // fnVisitClose does its own unregister once, at the end
    if (!Object.keys(fnVisitSlots).length) fnUnregisterProbe();
  });
}
