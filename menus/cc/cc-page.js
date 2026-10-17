/* Course Cancel (cc*) — the hands on the UMS page.
 *
 * background.js injects this (after cc-core.js) into the Cancel Course pages and then calls ONE
 * step by name. Nothing here runs on its own and nothing listens: a person using the page by hand
 * never meets it.
 *
 * Nothing is calculated here either. A course is unticked by clicking its box, the way a person
 * does it, and UMS's own page script works out Cancellation, Consideration, Cash Back and Current
 * Due exactly as it would for them. This file reads those results back and checks them.
 *
 *   check   form page   — the fast path: ask UMS's own lookup whether this Reg has this programme (reads only)
 *   search  search page — the old way: type the Reg, press its Submit (a lookup only), find the link
 *   follow  search page — the old way: press that programme's "Cancel Course" button
 *   fill    form page   — untick the courses, fill Approved By and the reason, read the amounts
 *   submit  form page   — press Submit on the form fill() left, report a refusal (success leaves the page)
 *   probe   form page   — which courses are still ticked; reads only
 * Only submit sends anything to UMS.
 */
(function () {
  "use strict";
  const C = self.UMSCANCEL;

  const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  const $ = function (s) { return document.querySelector(s); };
  const text = function (e) { return e ? String(e.innerText || e.textContent || "").replace(/\s+/g, " ").trim() : ""; };
  const shown = function (e) { return !!(e && (e.offsetWidth || e.offsetHeight || e.getClientRects().length)); };
  /* Poll, plus a MutationObserver so an answer is seen the moment it lands — a polled timer alone is
     clamped to once a second when this tab is in the background (Headless). */
  function until(fn, ms) {
    return new Promise(function (resolve) {
      let over = false, mo = null, iv = null, tm = null;
      const fin = function (v) { if (over) return; over = true; if (mo) mo.disconnect(); clearInterval(iv); clearTimeout(tm); resolve(v); };
      const tick = function () { try { const v = fn(); if (v) fin(v); } catch (e) {} };
      try { mo = new MutationObserver(tick); mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true }); } catch (e) {}
      iv = setInterval(tick, 200);
      tm = setTimeout(function () { fin(null); }, ms);
      tick();
    });
  }
  const fail = function (code, why, more) { return Object.assign({ ok: false, code: code, why: why }, more || {}); };

  // UMS prints its own refusals in this bar above the form — the same words a person would read
  function umsMessage() { return text($(".customMessage")); }
  function bootboxText() {
    const b = [].slice.call(document.querySelectorAll(".bootbox .bootbox-body")).filter(shown)[0];
    return text(b);
  }

  // ---------- search page ----------
  async function search(msg) {
    const box = $("#stdRollOrRegistrationNo"), btn = $("#Submit"), view = $("#studentProgramDetailsView");
    if (!box || !btn || !view) return fail("page", "Cancel Course পাতায় Reg-এর ঘর পাওয়া যায়নি");
    /* The tab is reused from one student to the next. Clear whatever an earlier search left, so the
       table read below can only be the answer to THIS Reg. */
    view.innerHTML = "";
    const bar = $(".customMessage"); if (bar) bar.innerHTML = "";
    box.value = String(msg.reg);
    box.dispatchEvent(new Event("input", { bubbles: true }));
    btn.click();   // this Submit only looks the student up (GenerateStudentProgramDetails) — it changes nothing
    const got = await until(function () {
      const m = umsMessage();
      if (m) return { msg: m };
      const grid = view.querySelector("#DataGrid");
      return grid ? { grid: grid } : null;
    }, 60000);
    if (!got) return fail("timeout", "UMS ৬০ সেকেন্ডেও ছাত্রের তথ্য দেয়নি");
    if (got.msg) return fail("noreg", "UMS: " + got.msg);
    return pickProgramme(got.grid, msg);
  }

  /* The programme this job is about, out of a search answer (table#DataGrid): the row whose "Cancel
     Course" link carries this StudentProgramId — and that link must be for this Reg. Shared by the
     search page (search) and the lookup made from the form (check), so both decide the same way. */
  function pickProgramme(grid, msg) {
    const progs = [].slice.call(grid.querySelectorAll('a[href*="studentProgramId="]')).map(function (a) {
      const u = new URL(a.getAttribute("href"), location.href);
      const tr = a.closest("tr");
      const td = tr ? [].slice.call(tr.cells).map(text) : [];
      return { spid: u.searchParams.get("studentProgramId"), reg: u.searchParams.get("stdRollOrRegistrationNo"),
        href: u.href, program: td[1] || "", session: td[2] || "", branch: td[3] || "" };
    });
    const hit = progs.filter(function (p) { return p.spid === String(msg.spid); })[0];
    if (!hit) {
      return fail("noprog", "এই Reg-এ StudentProgramId " + msg.spid + " নেই" + (progs.length
        ? " — আছে: " + progs.map(function (p) { return p.spid + " (" + p.program + " " + p.session + ")"; }).join(", ")
        : " — কোনো Program-এ Cancel Course নেই"));
    }
    if (hit.reg && hit.reg !== String(msg.reg)) return fail("page", "UMS অন্য Reg-এর তালিকা দেখাচ্ছে (" + hit.reg + ")");
    return { ok: true, href: hit.href, program: hit.program, session: hit.session, branch: hit.branch };
  }

  /* The old way's last click: press this programme's own "Cancel Course" button on the search page,
     as a person does, so the form opens from it (with the search page as referrer). Only the link
     search() picked — this StudentProgramId, this Reg — and only on this same UMS. The click is put
     off a tick so this answer is back before the page starts to go; background.js waits for the
     form to load. */
  function follow(msg) {
    const grid = $("#studentProgramDetailsView #DataGrid");
    if (!grid) return fail("page", "খোঁজার তালিকা নেই — আগে Reg খুঁজতে হবে");
    const a = [].slice.call(grid.querySelectorAll('a[href*="studentProgramId="]')).filter(function (x) {
      const u = new URL(x.getAttribute("href"), location.href);
      return u.searchParams.get("studentProgramId") === String(msg.spid) &&
        (!u.searchParams.get("stdRollOrRegistrationNo") || u.searchParams.get("stdRollOrRegistrationNo") === String(msg.reg));
    })[0];
    if (!a) return fail("noprog", "এই Reg-এ StudentProgramId " + msg.spid + "-এর Cancel Course বোতাম নেই");
    if (new URL(a.getAttribute("href"), location.href).host !== location.host) return fail("page", "Cancel Course বোতাম অন্য সার্ভারে নিয়ে যায়");
    setTimeout(function () { a.click(); }, 0);
    return { ok: true };
  }

  /* The fast path opens the form straight from its address, which leaves out the one screen that
     ties a StudentProgramId to a Reg — the form itself shows no Reg, so a wrong pair in the sheet
     would open SOMEONE ELSE's form. So, from the form, ask UMS exactly what its search page asks: the
     same POST its Submit sends (GenerateStudentProgramDetails, with the search page as referrer),
     read only. Nothing on the form is touched until the answer lists this programme for this Reg.
     "lookup" = no readable answer (background.js then clicks through the search page instead);
     "noreg" / "noprog" = UMS answered, and the answer is no. */
  async function check(msg) {
    if (!rightForm(msg.spid)) return fail("page", "form খোলেনি — StudentProgramId " + msg.spid);
    let res, txt;
    try {
      res = await fetch("/Student/CancelCourse/GenerateStudentProgramDetails", {
        method: "POST", credentials: "same-origin", referrer: "/Student/CancelCourse/CancelCourseOrSubject",
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest" },
        body: "stdRollOrRegistrationNo=" + encodeURIComponent(msg.reg)
      });
      txt = await res.text();
    } catch (e) { return fail("lookup", "UMS-এর খোঁজ চালানো গেল না (" + ((e && e.message) || e) + ")"); }
    if (C.isLogin(res.url)) return fail("login", "লগইন নেই");
    if (!res.ok) return fail("lookup", "UMS খোঁজ: HTTP " + res.status);
    const body = String(txt || "").trim();
    // a refusal comes back as JSON ({IsSuccess:false, Message}); the list comes back as HTML
    let j = null;
    try { j = JSON.parse(body); } catch (e) {}
    if (j && typeof j === "object") {
      if (j.IsSuccess === false) return fail("noreg", "UMS: " + (j.Message || "ছাত্র পাওয়া যায়নি"));
      return fail("lookup", "UMS খোঁজের উত্তর বোঝা যায়নি");
    }
    const grid = new DOMParser().parseFromString(body, "text/html").querySelector("#DataGrid");
    if (!grid) return fail("lookup", "UMS খোঁজের উত্তরে Program-এর তালিকা নেই");
    return pickProgramme(grid, msg);
  }

  // ---------- form page ----------
  function boxes() { return [].slice.call(document.querySelectorAll("input.course-name-check")); }
  function boxOf(id) { return boxes().filter(function (b) { return b.getAttribute("data-course-id") === String(id); })[0] || null; }
  function subjectsOf(id) {
    return [].slice.call(document.querySelectorAll("input.course-subject-check")).filter(function (s) {
      return s.getAttribute("data-course-id") === String(id);
    });
  }
  const nameOf = function (id) { const b = boxOf(id); return b ? (b.getAttribute("data-course-name") || "") : ""; };
  function num(id) {
    const e = document.getElementById(id);
    const s = e ? String(e.value).replace(/,/g, "").trim() : "";
    return s === "" ? NaN : Number(s);
  }
  function readForm() {
    const all = boxes();
    return {
      due: num("dueAmount"), cancellation: num("cancellationAmount"), deduction: num("DeductionAmount"),
      discount: num("totalDiscountAmount"),
      consideration: num("considerationAmount"), cashBack: num("cashBack"), currentDue: num("currentDue"),
      paid: num("totalPreviousPaidAmount"), nextDate: ($("#nextRecDate") || {}).value || "",
      allCancelled: all.length > 0 && all.every(function (b) { return !b.checked; }),
      // what the page's own Submit counts to decide "Nothing to cancel." (CancelCourse.js): unticked subjects
      untickedSubjects: document.querySelectorAll("input.course-subject-check:not(:checked)").length
    };
  }
  function rightForm(spid) {
    const e = document.getElementById("studentProgramId");
    return !!e && e.value === String(spid);
  }

  async function fill(msg) {
    if (!rightForm(msg.spid)) {
      const e = document.getElementById("studentProgramId");
      return fail("page", "ভুল form খুলেছে — StudentProgramId " + (e ? e.value : "নেই") + ", চাওয়া হয়েছিল " + msg.spid);
    }
    if (!$("#courseCancelPayment") || !$("#DiscountApprovedBy") || !$("#referrerenceNote")) return fail("page", "Cancel form-এর ঘর পাওয়া যায়নি — UMS পাতা বদলেছে?");
    const want = msg.courses.map(String);
    const all = boxes();
    const listed = all.map(function (b) {
      return b.getAttribute("data-course-id") + " " + (b.getAttribute("data-course-name") || "") + (b.checked ? "" : " (টিক নেই)");
    }).join(" · ");
    const missing = want.filter(function (id) { return !boxOf(id); });
    if (missing.length) return fail("nocourse", "Course " + missing.join(", ") + " এই Program-এ নেই — আছে: " + (listed || "কিছুই না"));
    /* A box already unticked on a freshly opened form is a course UMS no longer counts as taken —
       most likely cancelled already. Clicking it would TICK it, the opposite of the request. */
    const unticked = want.filter(function (id) { return !boxOf(id).checked; });
    if (unticked.length) return fail("already", "Course " + unticked.join(", ") + "-এ আগে থেকেই টিক নেই — সম্ভবত আগেই বাতিল হয়েছে");
    if (num("cancellationAmount") !== 0) return fail("dirty", "Form আগে থেকেই বদলানো (Cancellation Amount " + C.fmt(num("cancellationAmount")) + ") — নতুন করে খোলা form চাই");

    const before = {};
    all.forEach(function (b) { before[b.getAttribute("data-course-id")] = b.checked; });
    // the click is the whole calculation: UMS's handlers untick the subjects and fill in the amounts
    for (const id of want) { boxOf(id).click(); await sleep(60); }
    for (const id of want) {
      if (boxOf(id).checked || subjectsOf(id).some(function (s) { return s.checked; })) {
        return fail("click", "Course " + id + "-এর টিক পুরোপুরি ওঠেনি — কিছু পাঠানো হয়নি");
      }
    }
    const touched = all.filter(function (b) {
      const id = b.getAttribute("data-course-id");
      return want.indexOf(id) < 0 && b.checked !== before[id];
    });
    if (touched.length) return fail("click", "অন্য course-এর টিকও বদলে গেছে (" + touched.map(function (b) { return b.getAttribute("data-course-id"); }).join(", ") + ") — কিছু পাঠানো হয়নি");

    /* Approved By is an autocomplete: what is typed is only a search, and the form sends the hidden
       id behind the chosen name. Ask the same endpoint the box asks and take the exact PIN. */
    let list = [];
    try {
      const res = await fetch("/Student/Admission/GetDiscountApprovedBy", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8", "X-Requested-With": "XMLHttpRequest" },
        body: "query=" + encodeURIComponent(msg.pin)
      });
      const j = await res.json();
      if (j && j.IsSuccess && Array.isArray(j.returnList)) list = j.returnList;
    } catch (e) {}
    const who = C.pickApprover(list, msg.pin);
    if (!who) {
      return fail("approver", "Approved By-তে PIN " + msg.pin + " পাওয়া যায়নি" +
        (list.length ? " (এসেছে: " + list.map(function (x) { return x.Text; }).join(" · ") + ")" : ""));
    }
    // set the name and the id directly — an input event on this box clears the hidden id again
    const ac = $("#DiscountApprovedByAutoComplete");
    if (ac) { ac.value = who.Text; ac.classList.remove("highlight"); }
    $("#DiscountApprovedBy").value = who.Value;

    const note = $("#referrerenceNote");
    note.value = String(msg.reason);
    note.dispatchEvent(new Event("input", { bubbles: true }));

    let f = readForm();
    if (f.currentDue > 0 && msg.nextDate) {
      const nd = $("#nextRecDate");
      if (nd) { nd.value = String(msg.nextDate); nd.dispatchEvent(new Event("change", { bubbles: true })); }
      f = readForm();
    }
    const courses = want.map(function (id) { return { id: id, name: nameOf(id) }; });
    const bad = C.checkForm(f);
    if (bad) return fail(bad.code, bad.why, { amounts: f, courses: courses });
    // 💰 zero taka only: any amount on the form skips this student
    const money = msg.zeroOnly ? C.nonZero(f) : null;
    if (money) return fail(money.code, money.why, { amounts: f, courses: courses });
    return { ok: true, amounts: f, courses: courses, approver: who.Text, approverId: String(who.Value) };
  }

  /* Press Submit — but only on the form fill() left behind. Anything that moved in between (a box
     re-ticked, an amount changed, the approver cleared) means this is no longer the form that was
     checked, and nothing is sent.
     Success is not reported from here: UMS answers it by moving the tab to the money receipt, which
     ends this script, and background.js reads the new address. Only a refusal, or silence, comes
     back as a value. */
  async function submit(msg) {
    if (!rightForm(msg.spid)) return fail("page", "ভুল form — কিছু পাঠানো হয়নি", { sent: false });
    const f = readForm();
    const same = msg.courses.every(function (id) { const b = boxOf(id); return b && !b.checked; }) &&
      f.cancellation === msg.expect.cancellation && f.cashBack === msg.expect.cashBack &&
      f.currentDue === msg.expect.currentDue && f.consideration === msg.expect.consideration &&
      $("#DiscountApprovedBy").value === String(msg.approverId) && $("#referrerenceNote").value === String(msg.reason);
    if (!same || C.checkForm(f)) return fail("dirty", "যাচাইয়ের পর form বদলে গেছে — কিছু পাঠানো হয়নি", { sent: false });
    const money = msg.zeroOnly ? C.nonZero(f) : null;   // checked again right before the press
    if (money) return fail(money.code, money.why, { sent: false });

    /* Was anything actually sent? The page puts up its "Processing..." overlay (.blockUI) the moment
       the request leaves and takes it down when the answer is in — which can be quicker than any
       poll. Watching for it to be ADDED cannot miss it. */
    let sent = false;
    const mo = new MutationObserver(function (list) {
      list.forEach(function (m) {
        [].forEach.call(m.addedNodes, function (n) { if (n.classList && n.classList.contains("blockUI")) sent = true; });
      });
    });
    mo.observe(document.body, { childList: true, subtree: true });
    $("#courseCancelPayment").click();
    /* The page re-checks the form inside that click and, if anything fails, marks the field (or says
       "Nothing to cancel.") and sends nothing. That happens synchronously, so it shows here. */
    await sleep(300);
    if (!sent && !document.querySelector(".blockUI")) {
      mo.disconnect();
      const marked = [].slice.call(document.querySelectorAll(".highlight")).map(function (e) { return e.id; }).filter(Boolean);
      return fail("rejected", "UMS form নেয়নি" + (umsMessage() ? ": " + umsMessage() : "") +
        (marked.length ? " (" + marked.join(", ") + ")" : "") + " — কিছু পাঠানো হয়নি", { sent: false });
    }
    mo.disconnect();
    const out = await until(function () {
      const m = umsMessage();
      if (m) return fail("rejected", "UMS: " + m, { sent: true });
      // "Slow Internet Connection" — the request may or may not have reached the server
      const b = bootboxText();
      if (b) return fail("unsure", "UMS: " + b, { sent: true });
      return null;
    }, 180000);
    return out || fail("unsure", "৩ মিনিটেও UMS উত্তর দেয়নি", { sent: true });
  }

  // which of these courses are still ticked on a freshly opened form — read only
  function probe(msg) {
    if (!rightForm(msg.spid)) return fail("page", "ভুল form");
    const state = {};
    msg.courses.forEach(function (id) { const b = boxOf(id); state[id] = b ? (b.checked ? "ticked" : "unticked") : "missing"; });
    return { ok: true, state: state };
  }

  self.UMSCCPAGE = { check: check, search: search, follow: follow, fill: fill, submit: submit, probe: probe };
})();
