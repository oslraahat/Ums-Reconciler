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
  const waitFor = async function (fn, ms) { const t0 = Date.now(); while (Date.now() - t0 < (ms || 15000)) { try { if (fn()) return true; } catch (e) {} await sleep(150); } return false; };
  const noBlock = function () { return waitFor(function () { return !document.querySelector(".blockOverlay,.blockUI"); }, 20000); };
  const setSel = function (sel, val) { const el = $(sel); if (!el) return false; el.value = val; el.dispatchEvent(new Event("change", { bubbles: true })); return true; };
  const hasOpts = function (sel) { const s = $(sel); return s && s.options.length > 1; };
  try {
    setSel("#StudentClass", "Admission"); await sleep(400); await noBlock();
    if (!await waitFor(function () { return hasOpts("#Program"); }, 40000)) throw new Error("Program এলো না");
    setSel("#Program", String(p.program)); await sleep(400); await noBlock();
    if (!await waitFor(function () { return hasOpts("#Session"); }, 30000)) throw new Error("Session এলো না");
    setSel("#Session", String(p.session));
    setSel("#Gender", String(p.gender)); setSel("#Religion", String(p.religion));
    if ($("#LastInstituteName")) $("#LastInstituteName").value = p.instName || "";
    if ($("#LastInstituteId")) $("#LastInstituteId").value = p.instId || "";
    setSel("#VersionOfStudy", String(p.version)); await sleep(600); await noBlock();
    if (!await waitFor(function () { return hasOpts("#Branch"); }, 40000)) throw new Error("Branch এলো না");
    setSel("#Branch", String(p.branch)); await sleep(300); await noBlock();
    await waitFor(function () { return hasOpts("#Campus"); }, 15000); setSel("#Campus", String(p.campus)); await sleep(300); await noBlock();
    if (hasOpts("#AttachedPhysicalBranch") && p.physBranch) setSel("#AttachedPhysicalBranch", String(p.physBranch));
    await waitFor(function () { return document.querySelector(".course-name-check"); }, 15000);
    const ids = (p.courseIds || []).map(String);
    for (const cid of ids) {
      const cb = document.querySelector(".course-name-check.course-" + cid) || Array.prototype.find.call(document.querySelectorAll(".course-name-check"), function (c) { const m = (c.className || "").match(/course-(\d+)/); return m && m[1] === cid; });
      if (cb && !cb.checked) cb.click();
      await sleep(500); await noBlock();
      for (const cls of [".batch-day-course-" + cid, ".batch-time-course-" + cid, ".batch-course-" + cid]) {
        const ok = await waitFor(function () { const s = $(cls); return s && Array.prototype.some.call(s.options, function (o) { return o.value.trim(); }); }, 9000);
        if (ok) { const s = $(cls); const opt = Array.prototype.find.call(s.options, function (o) { return o.value.trim(); }); s.value = opt.value; s.dispatchEvent(new Event("change", { bubbles: true })); await sleep(600); }
      }
    }
    if ($("#Name")) $("#Name").value = p.name;
    if ($("#MobNumber")) $("#MobNumber").value = p.mobile;
    document.querySelectorAll('[id^="examYear"]').forEach(function (el, i) { if (!el.value) el.value = i === 0 ? "2024" : "2023"; });
    document.querySelectorAll('[id^="boardRoll"]').forEach(function (el) { if (!el.value) el.value = String(Math.floor(Math.random() * 1e6)).padStart(6, "0"); });
    document.querySelectorAll('[id^="registrationNumber"]').forEach(function (el) { if (!el.value) el.value = String(Math.floor(Math.random() * 1e7)).padStart(7, "0"); });
    const groups = {};
    document.querySelectorAll("input[type=radio]").forEach(function (r) { if (!r.offsetParent) return; (groups[r.name] = groups[r.name] || []).push(r); });
    Object.keys(groups).forEach(function (k) { const rs = groups[k]; if (!rs.some(function (r) { return r.checked; })) { rs[0].checked = true; rs[0].dispatchEvent(new Event("change", { bubbles: true })); } });
    const next = $("#newAdmissionNextBtn") || $("#nextBtn"); if (!next) throw new Error("Next বাটন নেই"); next.click();
    await sleep(1500); await noBlock();
    if (!await waitFor(function () { const el = $("#receivedAmount"); return el && el.offsetParent; }, 20000)) {
      const err = (document.querySelector("#boardInfoErrorMessage,.text-danger,.alert-danger") || {}).textContent || "";
      throw new Error("Payment ধাপে গেল না" + (err ? " — " + err.replace(/\s+/g, " ").trim().slice(0, 120) : ""));
    }
    if ($("#receivedAmount") && p.received != null && p.received !== "") $("#receivedAmount").value = p.received;
    const submit = $("#newAdmissionPaymentSubmitBtn") || $("#admissionPaymentSubmitBtn"); if (!submit) throw new Error("Submit বাটন নেই"); submit.click();
    return { ok: true };
  } catch (e) { return { ok: false, message: String((e && e.message) || e) }; }
}

function bgSleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function getTab(id) { return new Promise(function (r) { chrome.tabs.get(id, function (t) { r(chrome.runtime.lastError ? null : t); }); }); }
const RECEIPT_RE = /GenerateMoneyReciept|GenerateCoursewiseMoneyReciept/i;
function receiptId(url) { const m = url && url.match(/[?&](?:id|studentPaymentIdList)=(\d+)/); return m ? m[1] : ""; }

async function admBrowserRun(p) {
  let tab = null;
  try {
    tab = await chrome.tabs.create({ url: p.base + "/Student/Admission/NewStudentAdmission", active: p.show !== false });
    await waitTabComplete(tab.id, 30000);
    await bgSleep(800);   // let any client-side redirect settle before injecting
    let info = await getTab(tab.id);
    if (!info) return { ok: false, message: "ট্যাব বন্ধ হয়ে গেছে" };
    if (/Account\/Login/i.test(info.url || "")) return { ok: false, message: "ওই সার্ভারে লগইন নেই — আগে ব্রাউজারে লগইন করো" };
    /* inject the driver; a transient reload can remove the frame, so retry once (safe — the form is
       not submitted until the very end, and if it already reached the receipt we treat it as done) */
    let r = null, lastErr = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const cur = await getTab(tab.id);
      if (cur && RECEIPT_RE.test(cur.url || "")) { const id = receiptId(cur.url); if (id) return { ok: true, payId: id, url: cur.url }; }
      try {
        const res = await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: admDriver, args: [p] });
        r = res && res[0] && res[0].result; break;
      } catch (e) { lastErr = String((e && e.message) || e); await bgSleep(900); if (!await getTab(tab.id)) break; }
    }
    if (!r) {
      const cur = await getTab(tab.id); const id = cur && receiptId(cur.url || "");
      if (id) return { ok: true, payId: id, url: cur.url };
      return { ok: false, message: lastErr || "ফর্ম injection ব্যর্থ" };
    }
    if (!r.ok) return { ok: false, message: r.message || "ফর্ম পূরণ ব্যর্থ" };
    const url = await waitTabUrl(tab.id, RECEIPT_RE, 25000);
    const id = receiptId(url);
    if (id) return { ok: true, payId: id, url: url };
    return { ok: false, message: "Submit হলো কিন্তু রসিদে পৌঁছাল না (validation আটকে থাকতে পারে)" };
  } catch (e) { return { ok: false, message: String((e && e.message) || e) }; }
  finally { if (tab && p.close !== false) { try { await chrome.tabs.remove(tab.id); } catch (e) {} } }
}

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (msg && msg.type === "admBrowser") { admBrowserRun(msg.params || {}).then(sendResponse); return true; }
});
