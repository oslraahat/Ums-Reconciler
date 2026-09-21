#!/usr/bin/env node
"use strict";
/* admission.js — one UMS new-student admission on an already-logged-in page, timed.
 *
 * This is the engine behind the extension's "New Admission" load test: "how fast can I complete 1
 * — or 1000 — admissions?". The flow is ported from the proven UMS-Admission-Dashboard project
 * (ums-admission-blast.js): fill the NewStudentAdmission form, cascade the Class → Program →
 * Session → Branch dropdowns, pick a course through its batch-day → batch-time → batch cascade,
 * open the payment section, pay the minimum, submit, and read back the Registration Number.
 *
 * The caller (the host, or a CLI) logs in once and hands a page in; admit() drives one admission
 * and returns { ok, reg, ms }. Nothing is typed by a human: the name is a random unique nickname,
 * every dropdown value is read off the page itself. Only the mobile number (and how many) comes
 * from the user.
 *
 * IMPORTANT: this creates a REAL admission record on the server it runs against — it is a load /
 * throughput test for a test or demo UMS, not something to point at production.
 */

const NAMES = [
  "Rahim", "Karim", "Faruk", "Hasan", "Hussain", "Mahmud", "Jahid", "Rakib", "Sabbir",
  "Tarek", "Imran", "Rubel", "Arif", "Shakil", "Rafiq", "Monir", "Sumon", "Milon",
  "Ratan", "Jewel", "Sohel", "Babul", "Limon", "Ruhul", "Mostak", "Habib", "Noman",
  "Iqbal", "Rashed", "Belal", "Aziz", "Anwar", "Jashim", "Masud", "Sajib", "Tanvir"
];
let _nameSeq = 0;
function uniqueName() {
  const p = function (a) { return a[Math.floor(Math.random() * a.length)]; };
  /* a short base36 tail keeps it unique even across a 1000-run blast */
  _nameSeq++;
  return p(NAMES) + p(NAMES) + (Date.now().toString(36) + _nameSeq).slice(-4);
}

const DEFAULTS = {
  program: "",                 // keyword; "" → Medical
  session: "2025",
  received: 15000,
  gender: "Male",
  religion: "Islam",
  instituteName: "AAG DIGHULIA ISLANIA DAKHIL MADRASHA [114451]",
  instituteId: "3574",
  approverName: "8801819496040 - (00001) - Sohag",
  approverId: "1",
  navTimeout: 60000
};

/* select a course by cascading its batch-day → batch-time → batch dropdowns; returns whether the
   course actually had real batches at this branch (false → not enrollable here) */
async function configureCourse(page, courseId) {
  const el = await page.$(".course-name-check.course-" + courseId);
  if (!el) return false;
  const wasChecked = await el.evaluate(function (e) { return e.checked; });
  if (!wasChecked) await el.click({ timeout: 3000 }).catch(function () {});
  await page.waitForTimeout(300);

  await page.waitForFunction(
    function (id) { const s = document.querySelector(".batch-day-course-" + id); return s && s.options.length >= 1; },
    courseId, { timeout: 8000 }
  ).catch(function () {});

  const hasBatchDay = await page.evaluate(function (id) {
    const sel = document.querySelector(".batch-day-course-" + id);
    return sel ? [].slice.call(sel.options).some(function (o) { return o.value.trim(); }) : false;
  }, courseId);
  if (!hasBatchDay) {
    if (!wasChecked) await page.evaluate(function (id) {
      const cb = document.querySelector(".course-name-check.course-" + id); if (cb && cb.checked) cb.click();
    }, courseId).catch(function () {});
    return false;
  }

  const pickFirst = async function (cls) {
    const sel = "." + cls + "-course-" + courseId;
    await page.waitForFunction(
      function (s) { const el = document.querySelector(s); return el && el.options.length >= 1; },
      sel, { timeout: 8000 }
    ).catch(function () {});
    await page.evaluate(function (s) {
      const el = document.querySelector(s);
      if (!el) return;
      const opt = [].slice.call(el.options).find(function (o) { return o.value.trim(); });
      if (opt) { el.value = opt.value; el.dispatchEvent(new Event("change", { bubbles: true })); }
    }, sel);
    await page.waitForTimeout(700);
  };
  await pickFirst("batch-day");
  await pickFirst("batch-time");
  /* the batch select itself is class "batch-course-<id>" (no middle word) */
  await page.evaluate(function (id) {
    const sel = document.querySelector(".batch-course-" + id);
    if (!sel) return;
    const opt = [].slice.call(sel.options).find(function (o) { return o.value.trim(); });
    if (opt) { sel.value = opt.value; sel.dispatchEvent(new Event("change", { bubbles: true })); }
  }, courseId);
  return true;
}

/* one admission on a logged-in page; log(msg) streams progress lines */
async function admit(page, base, opts, log) {
  opts = Object.assign({}, DEFAULTS, opts || {});
  log = log || function () {};
  const t0 = Date.now();
  const mobile = String(opts.mobile || "").trim();
  if (!mobile) return { ok: false, why: "no mobile number" };

  const waitNoBlock = function () {
    return page.waitForFunction(
      function () { return !document.querySelector(".blockOverlay,.blockUI"); }, { timeout: 15000 }
    ).catch(function () {});
  };

  await page.goto(base.replace(/\/+$/, "") + "/Student/Admission/NewStudentAdmission", { waitUntil: "load", timeout: opts.navTimeout });

  /* Class → Program → Session cascade */
  await page.selectOption("#StudentClass", "Admission");
  await page.evaluate(function () { document.querySelector("#StudentClass").dispatchEvent(new Event("change", { bubbles: true })); });
  await page.waitForTimeout(500); await waitNoBlock();
  await page.waitForFunction(function () { const s = document.querySelector("#Program"); return s && s.options.length > 2; }, { timeout: 60000 });

  const prog = await page.evaluate(function (kw) {
    const opts = [].slice.call(document.querySelectorAll("#Program option")).filter(function (o) { return o.value; });
    const lkw = (kw || "medical").toLowerCase();
    const hits = opts.filter(function (o) { return o.textContent.toLowerCase().indexOf(lkw) >= 0; });
    const m = hits.find(function (o) { const t = o.textContent.toLowerCase(); return t.indexOf("demo") < 0 && t.indexOf("migration") < 0; }) || hits[0] || opts[0];
    return m ? { id: m.value, name: m.textContent.trim() } : null;
  }, opts.program);
  if (!prog) return { ok: false, why: 'no program matching "' + (opts.program || "Medical") + '"' };
  await page.selectOption("#Program", prog.id);
  await page.evaluate(function () { document.querySelector("#Program").dispatchEvent(new Event("change", { bubbles: true })); });
  await page.waitForTimeout(500); await waitNoBlock();
  await page.waitForFunction(function () { const s = document.querySelector("#Session"); return s && s.options.length > 1; }, { timeout: 30000 });

  const sess = await page.evaluate(function (yr) {
    const opts = [].slice.call(document.querySelectorAll("#Session option")).filter(function (o) { return o.value; });
    const m = opts.find(function (o) { return o.textContent.indexOf(yr) >= 0 || o.value.indexOf(yr) >= 0; }) || opts[0];
    return m ? { id: m.value, name: m.textContent.trim() } : null;
  }, opts.session);
  if (!sess) return { ok: false, why: "no session matching " + opts.session };
  await page.selectOption("#Session", sess.id);
  await page.evaluate(function () { document.querySelector("#Session").dispatchEvent(new Event("change", { bubbles: true })); });
  await page.waitForTimeout(1000); await waitNoBlock();
  await page.waitForFunction(function () { return document.querySelectorAll(".course-name-check").length > 0; }, { timeout: 20000 }).catch(function () {});
  await page.waitForTimeout(500);
  log("  program: " + prog.name + " · session: " + sess.name);

  /* institute + gender/religion (gender must be set before VersionOfStudy — loadBranch guards on it) */
  await page.evaluate(function (a) {
    document.querySelector("#LastInstituteName").value = a.n;
    document.querySelector("#LastInstituteId").value = a.id;
  }, { n: opts.instituteName, id: opts.instituteId });
  await page.selectOption("#Gender", opts.gender).catch(function () {});
  await page.selectOption("#Religion", opts.religion).catch(function () {});

  /* VersionOfStudy → Branch → Campus → AttachedPhysicalBranch */
  try { await page.selectOption("#VersionOfStudy", "Bangla"); }
  catch (_) { await page.$eval("#VersionOfStudy", function (el) { if (el.options.length > 1) el.selectedIndex = 1; }).catch(function () {}); }
  await page.evaluate(function () { const el = document.querySelector("#VersionOfStudy"); if (el) el.dispatchEvent(new Event("change", { bubbles: true })); });
  await page.waitForTimeout(2000); await waitNoBlock();
  const branchLoaded = await page.evaluate(function () { const el = document.querySelector("#Branch"); return el && el.options.length > 1; });
  if (!branchLoaded) {
    await page.evaluate(function () { const el = document.querySelector("#VersionOfStudy"); if (el) el.dispatchEvent(new Event("change", { bubbles: true })); });
    await page.waitForTimeout(3000); await waitNoBlock();
  }
  try {
    await page.waitForFunction(function () { const el = document.querySelector("#Branch"); return el && el.options.length > 1; }, { timeout: 60000 });
    const bv = await page.evaluate(function () {
      const opts = [].slice.call(document.querySelectorAll("#Branch option")).filter(function (o) { return o.value; });
      return (opts.find(function (o) { return /Farmgate/i.test(o.textContent); }) || opts.find(function (o) { return /Rajshahi/i.test(o.textContent); }) || opts[0] || {}).value || null;
    });
    if (bv) { await page.selectOption("#Branch", bv); await waitNoBlock(); }
  } catch (_) { log("  ⚠ branch not available"); }
  try {
    await page.waitForFunction(function () { const el = document.querySelector("#Campus"); return el && el.options.length > 1; }, { timeout: 10000 });
    const cv = await page.evaluate(function () { return ([].slice.call(document.querySelectorAll("#Campus option")).filter(function (o) { return o.value; })[0] || {}).value || null; });
    if (cv) { await page.selectOption("#Campus", cv); await waitNoBlock(); }
  } catch (_) {}
  const hasApb = await page.$("#AttachedPhysicalBranch");
  if (hasApb) {
    try {
      await page.waitForFunction(function () { const el = document.querySelector("#AttachedPhysicalBranch"); return el && el.options.length > 1; }, { timeout: 8000 });
      const av = await page.evaluate(function () { return ([].slice.call(document.querySelectorAll("#AttachedPhysicalBranch option")).filter(function (o) { return o.value; })[0] || {}).value || null; });
      if (av) { await page.selectOption("#AttachedPhysicalBranch", av); await waitNoBlock(); }
    } catch (_) {}
  }

  await page.waitForFunction(function () { return document.querySelectorAll(".course-name-check").length > 0; }, { timeout: 10000 }).catch(function () {});
  await page.waitForTimeout(500);

  /* pick the first course (highest id) that has real batches */
  const allIds = await page.evaluate(function () {
    return [].slice.call(document.querySelectorAll(".course-name-check"))
      .map(function (cb) { const m = cb.className.match(/course-(\d+)/); return m ? parseInt(m[1], 10) : null; })
      .filter(Boolean).sort(function (a, b) { return b - a; }).map(String);
  });
  const configured = [];
  for (let i = 0; i < allIds.length; i++) {
    if (await configureCourse(page, allIds[i])) { configured.push(allIds[i]); break; }
  }
  if (!configured.length) return { ok: false, why: "no course with batches on this server" };

  const totalMin = await page.evaluate(function (ids) {
    return ids.reduce(function (s, id) {
      const cb = document.querySelector(".course-name-check.course-" + id);
      return s + (cb ? parseFloat(cb.dataset.publicminpayment || "0") || 0 : 0);
    }, 0);
  }, configured);

  /* name + mobile + required board-exam fields + any unselected radios */
  const name = uniqueName();
  await page.fill("#Name", name);
  await page.fill("#MobNumber", mobile);
  await page.evaluate(function () {
    const rand = function (n) { return Math.floor(Math.random() * Math.pow(10, n)).toString().padStart(n, "0"); };
    document.querySelectorAll('[id^="examYear"]').forEach(function (el, i) { if (el.required && !el.value) el.value = i === 0 ? "2024" : "2023"; });
    document.querySelectorAll('[id^="boardRoll"]').forEach(function (el) { if (el.required && !el.value) el.value = rand(6); });
    document.querySelectorAll('[id^="registrationNumber"]').forEach(function (el) { if (el.required && !el.value) el.value = rand(7); });
    const groups = {};
    document.querySelectorAll("input[type=radio]").forEach(function (r) { if (!r.offsetParent) return; (groups[r.name] = groups[r.name] || []).push(r); });
    Object.keys(groups).forEach(function (k) {
      const radios = groups[k];
      if (!radios.some(function (r) { return r.checked; })) { radios[0].checked = true; radios[0].dispatchEvent(new Event("change", { bubbles: true })); }
    });
  });

  /* Next → payment section */
  await page.click("#newAdmissionNextBtn");
  const payResult = await page.waitForFunction(function () {
    const pay = document.querySelector("#paymentContainer");
    if (pay && pay.style.display !== "none") return "ok";
    if (pay && pay.offsetParent !== null) return "ok";
    const modal = document.querySelector(".bootbox.modal, .modal.in, .sweet-alert");
    if (modal && modal.offsetParent !== null) return "modal:" + modal.textContent.replace(/\s+/g, " ").trim().slice(0, 200);
    const alert = document.querySelector(".alert-danger, .text-danger, .validation-summary-errors");
    if (alert && alert.offsetParent !== null && alert.textContent.trim()) return "alert:" + alert.textContent.replace(/\s+/g, " ").trim().slice(0, 200);
    return false;
  }, { timeout: 20000 });
  const payStatus = await payResult.jsonValue();
  if (typeof payStatus === "string" && (payStatus.indexOf("modal:") === 0 || payStatus.indexOf("alert:") === 0)) {
    return { ok: false, why: "form error: " + payStatus.slice(6) };
  }
  await waitNoBlock();

  /* next receiving date +2, referrer, note */
  await page.evaluate(function () {
    const d = new Date(); d.setDate(d.getDate() + 2);
    try { window.$(document.querySelector("#nextRecDate")).datetimepicker("update", d); } catch (_) {}
    const ref = document.querySelector("#RefererList");
    if (ref) { ref.value = "50"; ref.dispatchEvent(new Event("change", { bubbles: true })); }
    const note = document.querySelector("#referrerenceNote");
    if (note) note.value = "Top Student";
  });

  /* read net receivable, pay min(received, net) but at least the effective min */
  const net = await page.evaluate(function () {
    const sels = ["#netReceivable", "#NetReceivable", "#netReceivableAmount", "#NetReceivableAmount", '[id*="netReceivable"]'];
    for (let i = 0; i < sels.length; i++) { const el = document.querySelector(sels[i]); if (el) { const v = parseFloat(el.value || el.textContent || "0"); if (!isNaN(v) && v >= 0) return v; } }
    return -1;
  });
  let rcvd;
  if (net === 0) rcvd = 0;
  else if (net > 0) { const eff = Math.min(totalMin, net); rcvd = Math.min(opts.received < eff ? eff : opts.received, net); }
  else rcvd = (totalMin > 0 && opts.received < totalMin) ? totalMin : opts.received;

  await page.fill("#receivedAmount", String(rcvd));
  await page.evaluate(function () {
    const ra = document.querySelector("#receivedAmount");
    if (ra) ["keydown", "keypress", "keyup", "input", "change"].forEach(function (ev) { ra.dispatchEvent(new Event(ev, { bubbles: true })); });
  });

  /* submit + confirm dialog */
  const preUrl = page.url();
  await page.click("#newAdmissionPaymentSubmitBtn");
  try {
    await page.waitForSelector('button[data-bb-handler="confirm"], .bootbox button.btn-primary', { timeout: 2500 });
    await page.click('button[data-bb-handler="confirm"], .bootbox button.btn-primary');
  } catch (_) {}

  /* receipt → registration number */
  try { await page.waitForURL("**/*MoneyReciept*", { timeout: 20000 }); }
  catch (_) { await page.waitForFunction(function (u) { return window.location.href !== u; }, preUrl, { timeout: 20000 }).catch(function () {}); }
  try { await page.waitForLoadState("load", { timeout: 10000 }); } catch (_) {}

  const reg = await page.evaluate(async function () {
    const b64 = (document.querySelector("input.moneyReceiptData") || {}).value;
    if (b64 && typeof pdfjsLib !== "undefined") {
      try {
        const pdf = await pdfjsLib.getDocument({ data: atob(b64) }).promise;
        let text = "";
        for (let i = 1; i <= pdf.numPages; i++) { const pg = await pdf.getPage(i); const c = await pg.getTextContent(); text += c.items.map(function (it) { return it.str; }).join(" "); }
        const m = text.match(/Registration\s*Number\s*:?\s*(\d+)/i); if (m) return m[1];
      } catch (_) {}
    }
    const body = document.body.innerText;
    const pats = [/Registration\s*(?:Number|No\.?|ID)?\s*[:\-]?\s*(\d{6,})/i, /Reg\.?\s*(?:No\.?|Number|ID)?\s*[:\-]?\s*(\d{6,})/i, /Student\s*(?:ID|No\.?)\s*[:\-]?\s*(\d{6,})/i];
    for (let i = 0; i < pats.length; i++) { const m = body.match(pats[i]); if (m) return m[1]; }
    return new URLSearchParams(window.location.search).get("id");
  }).catch(function () { return null; });

  const ms = Date.now() - t0;
  if (reg) return { ok: true, reg: reg, name: name, paid: rcvd, ms: ms };
  return { ok: false, why: "no registration number — did not save", name: name, ms: ms };
}

module.exports = { admit: admit, configureCourse: configureCourse, uniqueName: uniqueName, DEFAULTS: DEFAULTS };

/* ---------------- CLI (manual fallback) ---------------- */
/* node admission.js --base <url> --email <e> --password <p> --mobile <m> [--count N] [--pool P]
 *                    [--program <kw>] [--received <amt>] [--headed]
 * Logs in once, runs `count` real admissions through `pool` parallel tabs, prints the rate. */
const path = require("path");
async function main() {
  const a = process.argv.slice(2);
  const get = function (f, d) { const i = a.indexOf(f); return i >= 0 && a[i + 1] ? a[i + 1] : d; };
  const base = String(get("--base", "")).replace(/\/+$/, "");
  const email = get("--email", ""), pass = get("--password", ""), mobile = get("--mobile", "");
  const count = Math.max(1, parseInt(get("--count", "1"), 10) || 1);
  const pool = Math.max(1, Math.min(count, parseInt(get("--pool", "1"), 10) || 1));
  const headed = a.indexOf("--headed") >= 0;
  const admOpts = { mobile: mobile, program: get("--program", ""), received: parseInt(get("--received", "15000"), 10) || 15000, session: get("--session", "2025") };
  if (!base || !email || !pass || !mobile) {
    console.error("Usage: node admission.js --base <url> --email <e> --password <p> --mobile <m> [--count N] [--pool P] [--program kw] [--headed]");
    process.exit(1);
  }
  const { chromium } = require(path.join(__dirname, "node_modules", "playwright-core"));
  const lt = require(path.join(__dirname, "loadtest.js"));
  const browser = await chromium.launch({ channel: "chrome", headless: !headed });
  const context = await browser.newContext();
  const opts = { dash: "/Student/Admission/NewStudentAdmission", login: "/Account/Login", userField: "", passField: "", wait: "load", navTimeout: 60000, __user: email, __pass: pass };
  const li = await lt.login(context, base, opts);
  if (!li.ok) { console.error("✗ login — " + (li.why || "failed")); await browser.close(); process.exit(1); }
  console.log("→ logged in · " + count + " admission(s), " + pool + " at once");
  const t0 = Date.now();
  let next = 0, ok = 0, fail = 0;
  const worker = async function (idx) {
    const page = idx === 0 ? li.page : await context.newPage();
    while (true) {
      const i = next++; if (i >= count) break;
      let r; try { r = await admit(page, base, admOpts, function () {}); } catch (e) { r = { ok: false, why: (e.message || String(e)).slice(0, 80) }; }
      if (r.ok) { ok++; console.log("  ✓ #" + (i + 1) + "/" + count + " · reg " + r.reg + " · " + (r.ms / 1000).toFixed(1) + "s"); }
      else { fail++; console.log("  ✗ #" + (i + 1) + "/" + count + " — " + (r.why || "failed")); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(pool, count) }, function (_, i) { return worker(i); }));
  const secs = (Date.now() - t0) / 1000;
  console.log("── " + ok + " ok · " + fail + " failed · " + secs.toFixed(1) + "s · ~" + (secs > 0 ? Math.round(ok / secs * 60) : 0) + "/min");
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
}
if (require.main === module) main();
