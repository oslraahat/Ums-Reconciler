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
  const hasOpts = function (sel) { const s = $(sel); return s && s.options.length > 1; };
  try {
    setSel("#StudentClass", "Admission"); await noBlock();
    if (!await waitFor(function () { return hasOpts("#Program"); }, 40000)) throw new Error("Program এলো না");
    setSel("#Program", String(p.program)); await noBlock();
    if (!await waitFor(function () { return hasOpts("#Session"); }, 30000)) throw new Error("Session এলো না");
    setSel("#Session", String(p.session)); await noBlock();
    await waitFor(function () { return document.querySelector(".course-name-check"); }, 25000);   // let the session cascade finish
    setSel("#Gender", String(p.gender)); setSel("#Religion", String(p.religion));
    if ($("#LastInstituteName")) $("#LastInstituteName").value = p.instName || "";
    if ($("#LastInstituteId")) $("#LastInstituteId").value = p.instId || "";
    setSel("#VersionOfStudy", String(p.version)); await noBlock();
    if (!await waitFor(function () { return hasOpts("#Branch"); }, 25000)) {
      const dv = function (s) { const e = $(s); return e ? (e.value || "?") + "/" + ((e.options || []).length) + "o" : "none"; };
      throw new Error("Branch এলো না [ver " + dv("#VersionOfStudy") + " · gen " + dv("#Gender") + " · sess " + dv("#Session") + " · branch " + dv("#Branch") + " · courses " + document.querySelectorAll(".course-name-check").length + "]");
    }
    setSel("#Branch", String(p.branch)); await noBlock();
    await waitFor(function () { return hasOpts("#Campus"); }, 15000); setSel("#Campus", String(p.campus)); await noBlock();
    if (hasOpts("#AttachedPhysicalBranch") && p.physBranch) setSel("#AttachedPhysicalBranch", String(p.physBranch));
    await waitFor(function () { return document.querySelector(".course-name-check"); }, 15000);
    const ids = (p.courseIds || []).map(String);
    for (const cid of ids) {
      const cb = document.querySelector(".course-name-check.course-" + cid) || Array.prototype.find.call(document.querySelectorAll(".course-name-check"), function (c) { const m = (c.className || "").match(/course-(\d+)/); return m && m[1] === cid; });
      if (cb && !cb.checked) cb.click();
      await noBlock();
      /* tick the course's subjects like HTTP mode does: the compulsory ones (the form checks them
         when the course is ticked) plus enough more to meet the course minimum — one per subject
         group, never past the maximum. Without valid subjects the fee stays 0 and Next won't move
         to the Payment step. (data-officeminsub / data-maximumsubject live on the course checkbox.) */
      await waitFor(function () { return document.querySelector(".course-" + cid + "-subjects"); }, 6000);
      const subs = Array.prototype.slice.call(document.querySelectorAll(".course-" + cid + "-subjects"));
      if (subs.length) {
        const minSub = parseInt((cb && cb.getAttribute("data-officeminsub")) || "0", 10) || 0;
        const maxSub = parseInt((cb && cb.getAttribute("data-maximumsubject")) || "0", 10) || subs.length;
        const groupUsed = {};
        subs.forEach(function (s) { if (s.checked) { const g = s.getAttribute("data-group-no"); if (g && g !== "0") groupUsed[g] = 1; } });
        let taken = subs.filter(function (s) { return s.checked; }).length;
        subs.forEach(function (s) {
          if (taken >= minSub || taken >= maxSub || s.checked) return;
          const g = s.getAttribute("data-group-no"); if (g && g !== "0") { if (groupUsed[g]) return; groupUsed[g] = 1; }
          s.click(); taken++;
        });
        await noBlock();
      }
      for (const cls of [".batch-day-course-" + cid, ".batch-time-course-" + cid, ".batch-course-" + cid]) {
        const ok = await waitFor(function () { const s = $(cls); return s && Array.prototype.some.call(s.options, function (o) { return o.value.trim(); }); }, 9000);
        if (ok) { const s = $(cls); const opt = Array.prototype.find.call(s.options, function (o) { return o.value.trim(); }); s.value = opt.value; s.dispatchEvent(new Event("change", { bubbles: true })); await noBlock(); }
      }
    }
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
    const next = $("#newAdmissionNextBtn") || $("#nextBtn"); if (!next) throw new Error("Next বাটন নেই"); next.click();
    await noBlock();
    if (!await waitFor(function () { const el = $("#receivedAmount"); return el && el.offsetParent; }, 20000)) {
      /* say WHY Next didn't advance: the validation messages, or failing that the fields the form
         flagged invalid (jQuery validate marks them .input-validation-error) */
      const msgs = Array.prototype.map.call(document.querySelectorAll("#boardInfoErrorMessage,.field-validation-error,.validation-summary-errors,.text-danger,.alert-danger"), function (n) { return (n.textContent || "").replace(/\s+/g, " ").trim(); }).filter(Boolean);
      const bad = Array.prototype.map.call(document.querySelectorAll(".input-validation-error"), function (n) { return n.id || n.name || (n.className || "").split(" ")[0]; }).filter(Boolean);
      let why = msgs.join(" · ").slice(0, 160);
      if (!why && bad.length) why = "খালি/ভুল ফিল্ড: " + bad.slice(0, 8).join(", ");
      throw new Error("Payment ধাপে গেল না" + (why ? " — " + why : " (ফর্ম কোনো কারণ দেখায়নি)"));
    }
    if ($("#receivedAmount") && p.received != null && p.received !== "") { $("#receivedAmount").value = p.received; $("#receivedAmount").dispatchEvent(new Event("input", { bubbles: true })); $("#receivedAmount").dispatchEvent(new Event("change", { bubbles: true })); }
    /* Next Receiving Date is required when there's a due — the form validation blocks Submit without it */
    const nd = new Date(); nd.setDate(nd.getDate() + 2);
    const ndStr = nd.getFullYear() + "-" + String(nd.getMonth() + 1).padStart(2, "0") + "-" + String(nd.getDate()).padStart(2, "0");
    if ($("#nextRecDate")) { $("#nextRecDate").value = ndStr; $("#nextRecDate").dispatchEvent(new Event("change", { bubbles: true })); }
    /* pick a payment method if none is chosen (Cash is the usual default) */
    const pm = $("#PaymentMethods");
    if (pm && !pm.value) { const opt = Array.prototype.find.call(pm.options, function (o) { return o.value.trim(); }); if (opt) { pm.value = opt.value; pm.dispatchEvent(new Event("change", { bubbles: true })); } }
    const submit = $("#newAdmissionPaymentSubmitBtn") || $("#admissionPaymentSubmitBtn"); if (!submit) throw new Error("Submit বাটন নেই"); submit.click();
    /* wait (event-driven) for either a client validation message or the redirect to the receipt —
       resolves the instant an error shows, so no fixed post-submit delay */
    await waitFor(function () { return /GenerateMoneyReciept/i.test(location.href) || !!document.querySelector("#receivedAmountError,#nextRecDateError,.text-danger,.alert-danger,.field-validation-error"); }, 4000);
    const verr = document.querySelector("#receivedAmountError,#nextRecDateError,.text-danger,.alert-danger,.field-validation-error");
    if (verr && verr.textContent && verr.textContent.trim() && !/GenerateMoneyReciept/i.test(location.href)) return { ok: false, message: verr.textContent.replace(/\s+/g, " ").trim().slice(0, 140) };
    return { ok: true };
  } catch (e) { return { ok: false, message: String((e && e.message) || e) }; }
}

function bgSleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
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
    /* Headless — a minimized window kept off-screen. Chrome has no true off-screen/invisible tab, so
       "hidden" means minimized: it lives in the taskbar, not on the desktop, and never steals focus.
       The event-driven driver (MutationObserver, not setTimeout) is not throttled when minimized, so
       it still runs at full speed. Each slot keeps its window for the whole run (opens at most once). */
    const win = await chrome.windows.create({ url: url, focused: false, state: "minimized" });
    const tabId = win && win.tabs && win.tabs[0] && win.tabs[0].id;
    try { await chrome.windows.update(win.id, { state: "minimized", focused: false }); } catch (e) {}
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
    await waitTabComplete(tabId, 30000);
    await bgSleep(250);   // let any client-side redirect settle before injecting
    const info = await getTab(tabId);
    if (!info) { delete admSlots[p.slot || 0]; return { ok: false, message: "ট্যাব বন্ধ হয়ে গেছে" }; }
    if (/Account\/Login/i.test(info.url || "")) return { ok: false, message: "🔒 লগইন নেই — আগে এই সার্ভারে ব্রাউজারে লগইন করুন: " + (p.base || "(UMS Address খালি)") + " — তারপর আবার চেষ্টা করুন" };
    const cur0 = await getTab(tabId);
    if (cur0 && RECEIPT_RE.test(cur0.url || "")) { const id = receiptId(cur0.url); if (id) return { ok: true, payId: id, url: cur0.url }; }
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
    if (id) return { ok: true, payId: id, url: rcptUrl };
    return { ok: false, message: "Submit হলো কিন্তু রসিদে পৌঁছাল না (validation আটকে থাকতে পারে)" };
  } catch (e) { return { ok: false, message: String((e && e.message) || e) }; }
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg && msg.type === "admBrowser") { admBrowserRun(msg.params || {}).then(sendResponse); return true; }
  if (msg && msg.type === "admBrowserClose") { admCloseRun(msg.slot).then(function () { sendResponse({ ok: true }); }); return true; }
});
