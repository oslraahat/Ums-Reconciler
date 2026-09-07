/* UMS Payment Reconciler — verification logic.
 *
 * This file is the CLI tool's logic, moved into the browser as-is:
 *   Desktop/UMS-Payment-Verify/lib/parse.js     → money, norm, spread, PW_COLS/CW_COLS, parseTable
 *   Desktop/UMS-Payment-Verify/lib/compare.js   → compare() and every rule it applies
 *   Desktop/UMS-Payment-Verify/lib/category.js  → classify() / group()
 *
 * Only the table reader differs: the CLI regex-parses an HTML string, the extension already has a
 * live DOM table, so parseTable() walks the DOM and returns the identical shape
 * ({ ok, header, cols, rows, totalRow, noData }). Nothing else is re-derived or "improved" here —
 * when this file and the CLI disagree, the CLI is right and this file is the bug.
 *
 * Everything is exposed on self.UMSREC.
 */
(function (g) {
  "use strict";

  /* =========================== parse.js =========================== */

  const norm = function (s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, ""); };

  function money(v) {
    if (v == null) return 0;
    let s = String(v).replace(/[,\s৳]/g, "").trim();
    if (s === "" || s === "-" || s === "--" || /^n\/?a$/i.test(s)) return 0;
    const neg = /^\(.*\)$/.test(s);
    const n = parseFloat(s.replace(/[()]/g, ""));
    if (!isFinite(n)) return 0;
    return neg ? -n : n;
  }

  const PW_COLS = {
    date: ["date"], mrn: ["mrn"], crn: ["crn"],
    income: ["income"],
    consideration: ["considerationamount", "consideration"],
    previousDue: ["previousdue"],
    deducted: ["deductedamount", "deducted"],
    receivable: ["receivable", "receivableamount"],
    prevStd: ["prevstddiscount", "prestddiscount", "previousstudentdiscount"],
    booking: ["bookingdiscount"],
    special: ["specialdiscount"],
    received: ["received", "receivedamount"],
    cashBack: ["cashback", "cashbackamount"],
    currentDue: ["currentdue", "currentdueamount"],
    method: ["paymentmethod"], remarks: ["remarks"], user: ["user"],
    note: ["specialnote"]
  };

  const CW_COLS = {
    date: ["date"], roll: ["roll"], nick: ["nickname"], mobile: ["mobilenumber"],
    programSession: ["programsession"], course: ["course"],
    branch: ["branch"], campus: ["campus"], regNo: ["registrationno"],
    mrn: ["mrn"], crn: ["crn"],
    income: ["income"],
    deducted: ["deductedamount", "deducted"],
    consideration: ["considerationamount", "consideration"],
    previousDue: ["previousdue"],
    receivable: ["receivable", "receivableamount"],
    prevStd: ["prestddiscount", "prevstddiscount", "previousstudentdiscount"],
    booking: ["bookingdiscount"],
    special: ["specialdiscount"],
    grossReceived: ["grossreceived", "received", "receivedamount"],
    dueAdjustment: ["dueadjustmentamount", "dueadjustment"],
    cashBack: ["cashbackamount", "cashback"],
    netReceived: ["netreceived"],
    currentDue: ["currentdue", "currentdueamount"],
    method: ["paymentmethod"], remarks: ["remarks"], user: ["user"],
    note: ["specialnote"]
  };

  /* Course Wise has an id to grab; Program Wise has none, so its table is found by its column
     names. Both readers — the in-page panel walking a live DOM (content.js findTable) and the
     batch runner scanning fetched HTML (app.js sliceTable) — score the header region against this
     list and take the best table. Kept here so the two cannot drift: they used to disagree, and
     the batch runner was the weaker of the two, reporting "Program পাওয়া যায়নি" for pages the
     panel read without trouble. MRN + Current Due are the two that make it a payment table at all. */
  const PW_HEAD_WORDS = ["mrn", "crn", "current due", "received", "receivable", "previous due",
    "income", "consideration"];
  function headScore(headText) {
    const h = String(headText || "").toLowerCase();
    if (h.indexOf("mrn") < 0 || h.indexOf("current due") < 0) return 0;
    return PW_HEAD_WORDS.filter(function (w) { return h.indexOf(w) >= 0; }).length;
  }

  function resolveCols(header, spec) {
    const idx = {}, H = header.map(norm);
    Object.keys(spec).forEach(function (key) {
      const names = spec[key];
      for (let i = 0; i < names.length; i++) {
        const at = H.indexOf(names[i]);
        if (at !== -1) { idx[key] = at; break; }
      }
    });
    return idx;
  }

  // Lay a row's cells out across the columns they cover, so a colspan'd label
  // (the "Total Summary" row) doesn't shift everything after it.
  function spread(cells, width) {
    const out = new Array(width).fill("");
    let i = 0;
    for (let c = 0; c < cells.length; c++) {
      if (i < width) out[i] = cells[c].text;
      i += cells[c].colSpan || 1;
    }
    return out;
  }

  function cellsOf(tr) {
    return [].slice.call(tr.querySelectorAll("th,td")).map(function (td) {
      return {
        text: (td.textContent || "").replace(/\s+/g, " ").trim(),
        colSpan: parseInt(td.getAttribute("colspan") || "1", 10) || 1
      };
    });
  }

  /** kind = 'pw' | 'cw' — DOM twin of the CLI's parseTable() */
  function parseTable(table, kind) {
    if (!table) return { ok: false };
    const trs = [].slice.call(table.querySelectorAll("tr"));
    if (!trs.length) return { ok: false };
    const rows = trs.map(cellsOf).filter(function (c) { return c.length; });
    if (!rows.length) return { ok: false };

    /* Usually the header is row one, and on the fetched HTML the CLI reads it always is. In the
       live page it is not always: a search/filter row can sit above it. Take whichever of the
       first few rows names the most known columns — row one still wins on ordinary tables. */
    const SPEC = kind === "pw" ? PW_COLS : CW_COLS;
    let hi = 0, cols = resolveCols(rows[0].map(function (c) { return c.text; }), SPEC);
    let best = Object.keys(cols).length;
    for (let i = 1; i < Math.min(rows.length, 3); i++) {
      const c = resolveCols(rows[i].map(function (x) { return x.text; }), SPEC);
      if (Object.keys(c).length > best) { best = Object.keys(c).length; cols = c; hi = i; }
    }
    const header = rows[hi].map(function (c) { return c.text; });
    const width = header.length;
    const data = []; let totalRow = null, noData = false;

    for (let i = hi + 1; i < rows.length; i++) {
      const cells = rows[i];
      const first = cells[0] ? cells[0].text : "";
      if (/total\s*summary/i.test(first)) { totalRow = spread(cells, width); continue; }
      if (/^no\s*data$/i.test(first)) { noData = true; continue; }
      if (cells.length < 4) continue;
      const vals = spread(cells, width);
      const rec = {};
      Object.keys(cols).forEach(function (k) { rec[k] = vals[cols[k]] == null ? "" : vals[cols[k]]; });
      /* Every cell as the page printed it, aligned to header[]. The named fields above cover the
         columns the rules care about; the server-to-server diff has to answer for the ones they do
         not (Payment Method, Remarks, User, Special Note, Branch …), and those have no home in
         PW_COLS/CW_COLS. Non-enumerable, so the shape of a row is unchanged for everything that
         walks its keys. */
      try { Object.defineProperty(rec, "__raw", { value: vals, enumerable: false }); }
      catch (e) { rec.__raw = vals; }
      data.push(rec);
    }
    return { ok: true, header: header, cols: cols, rows: data, totalRow: totalRow, noData: noData };
  }

  /* ========================== compare.js ========================== */

  /* spec §1.3 + §2 — the nine values that mean the same on both ledgers */
  const COMPARE = [
    ["Income", "income", "income"],
    ["Consideration Amount", "consideration", "consideration"],
    ["Previous Due", "previousDue", "previousDue"],
    ["Receivable", "receivable", "receivable"],
    ["Prev. Std. Discount", "prevStd", "prevStd"],
    ["Booking Discount", "booking", "booking"],
    ["Special Discount", "special", "special"],
    ["Current Due", "currentDue", "currentDue"]
    /* Received is matched separately — on a cancellation one course's money moves to another,
       so raw Received ↔ Gross Received will not line up; Cash Back has to come out first. */
  ];

  const SUM_KEYS = ["income", "consideration", "previousDue", "receivable", "prevStd", "booking",
    "special", "grossReceived", "dueAdjustment", "cashBack", "netReceived", "currentDue", "deducted"];

  function fmt(n) {
    if (typeof n !== "number" || !isFinite(n)) return String(n == null ? "-" : n);
    const r = Math.round(n * 100) / 100;
    return r === 0 ? "0" : r.toLocaleString("en-US");
  }

  /* Splitting one amount over N course lines rounds each line, so a taka or two of drift is the
     arithmetic itself, not a fault. Anything past this is real. */
  const ROUND_BAND = 2;

  const isCancel = function (r) { const c = String((r && r.crn) || "").trim(); return !!c && c !== "-"; };

  function rowKey(r) {
    const mrn = String((r && r.mrn) || "").trim(), crn = String((r && r.crn) || "").trim();
    if (mrn && mrn !== "-") return "MRN " + mrn;
    if (crn && crn !== "-") return "CRN " + crn;
    return "তারিখ " + ((r && r.date) || "?");
  }

  /* spec §5.5 — Course Wise receipt-worthiness filter */
  function receiptWorthy(r) {
    const rec = money(r.received);
    const disc = money(r.special) + money(r.prevStd);
    const pay = money(r.receivable);
    return rec > 0 || isCancel(r) || (pay > 0 && disc > 0 && pay >= disc);
  }

  function compare(pw, cw, opts) {
    opts = opts || {};
    const tol = opts.tolerance || 0;
    const near = function (a, b) { return Math.abs(a - b) <= tol + 1e-6; };
    const errors = [], warnings = [], notes = [], groups = [];
    const worthyRows = pw.rows.filter(receiptWorthy);

    /* Course Wise একদম ফাঁকা — দুই রকম হতে পারে, দুটো এক জিনিস নয়:
         ক) Program Wise-এ টাকার সারি আছে  → migration হয়নি, আসল সমস্যা
         খ) Program Wise-এ সারি আছে কিন্তু সব ০ → Zero Payment, স্বাভাবিক */
    if (cw.noData || !cw.rows.length) {
      const money0 = pw.rows.every(function (r) {
        return !money(r.income) && !money(r.received) && !money(r.receivable) &&
          !money(r.consideration) && !money(r.currentDue) && !isCancel(r);
      });
      const zeroPayment = !worthyRows.length && money0;
      notes.push({
        key: "—",
        detail: zeroPayment
          ? "Program Wise-এর সব সারিতেই টাকা ০ — Course Wise ফাঁকা থাকাই স্বাভাবিক"
          : worthyRows.length
          ? "Program Wise-এ " + worthyRows.length + " টি রসিদযোগ্য সারি আছে কিন্তু Course Wise সম্পূর্ণ ফাঁকা — migration হয়নি"
          : "সব সারিই spec §5.5 ফিল্টারে বাদ পড়ার কথা — Course Wise ফাঁকা স্বাভাবিক"
      });
      /* Course Wise being absent stops the two pages being compared — it does not stop Program
         Wise being read. Its own arithmetic (§3.3, §3.5), its due chain, its row order and its
         discounts all stand on their own, and returning here left every such student unchecked:
         868 of 1,086 measured, the largest group in the run. So check what can be checked. */
      prevDueIdentity(pw.rows, "Program Wise", errors);
      dueIdentity(pw.rows, "Program Wise", function (r) { return money(r.received) - money(r.cashBack); }, errors, near, null);
      dueChain(pw.rows, "Program Wise", function () { return "Program"; }, errors, near);
      rowSanity(pw.rows, "Program Wise", "received", errors, tol, null);
      sortOrder(pw.rows, "Program Wise", errors);

      return { errors: errors, warnings: warnings, notes: notes, groups: groups,
        pwCount: pw.rows.length, cwCount: 0, emptyCourseWise: !zeroPayment, zeroPayment: zeroPayment,
        worthyCount: worthyRows.length };
    }

    const cwG = new Map();
    cw.rows.forEach(function (r) {
      const k = rowKey(r);
      if (!cwG.has(k)) cwG.set(k, { key: k, rows: [], sum: {} });
      const grp = cwG.get(k);
      grp.rows.push(r);
      SUM_KEYS.forEach(function (kk) { grp.sum[kk] = (grp.sum[kk] || 0) + money(r[kk]); });
    });
    const pwM = new Map();
    pw.rows.forEach(function (r) { pwM.set(rowKey(r), r); });

    /* A receipt whose every column is blank or zero carries no money. Program Wise holds one row
       per receipt (the courses added up) and Course Wise holds one row per course, so the two
       sides are only obliged to agree about amounts — and there is no amount here to disagree
       about. Reporting such a row as missing from the other ledger says "টাকা হারিয়েছে" when
       nothing was ever there, so it is left alone. Any non-zero column and the rule applies. */
    const MONEY_KEYS = SUM_KEYS.concat(["received", "grossReceived", "deducted", "dueAdjustment"]);
    const noMoney = function (rows) {
      return rows.every(function (r) {
        return MONEY_KEYS.every(function (k) { return !money(r[k]); });
      });
    };

    /* --- present on one side only --- */
    pwM.forEach(function (r, k) {
      if (cwG.has(k)) return;
      if (!receiptWorthy(r)) {
        notes.push({ key: k, detail: "Received ০ · Cancellation নয় · SP/Prev.Std ০ → spec §5.5 অনুযায়ী Course Wise-এ আসার কথা নয়" });
        return;
      }
      if (noMoney([r])) {
        notes.push({ key: k, detail: "সব ঘর ০ — Course Wise-এ নেই, তবে টাকার হিসাবে কিছু বদলায় না" });
        return;
      }
      // the size of the hole: whichever of the receipt-level figures actually carries money
      const lost = money(r.received) || money(r.cashBack) || money(r.consideration) || money(r.receivable);
      errors.push({ key: k, field: "Transaction", ref: "§5.5 · Course Wise-এ রসিদ আসার শর্ত", pw: "রসিদযোগ্য সারি আছে", cw: "নেই", diff: "—",
        date: r.date, amount: lost,
        note: "spec §5.5 অনুযায়ী Course Wise-এ থাকার কথা ছিল" });
    });
    cwG.forEach(function (grp, k) {
      if (pwM.has(k)) return;
      if (noMoney(grp.rows)) {
        notes.push({ key: k, detail: "সব ঘর ০ — Program Wise-এ নেই, তবে টাকার হিসাবে কিছু বদলায় না" });
        return;
      }
      const lostC = (grp.sum.netReceived || 0) || (grp.sum.consideration || 0) || (grp.sum.receivable || 0);
      errors.push({ key: k, field: "Transaction", ref: "§1.3 · দুই view-এ একই মান আসার কথা", pw: "নেই", cw: grp.rows.length + " টি সারি", diff: "—",
        date: (grp.rows[0] || {}).date, amount: lostC,
        note: "Course Wise-এ আছে, Program Wise-এ নেই" });
    });

    /* --- field by field --- */
    pwM.forEach(function (pr, k) {
      const grp = cwG.get(k);
      if (!grp) return;
      const fields = []; let bad = false;

      COMPARE.forEach(function (spec) {
        const lbl = spec[0], pk = spec[1], ck = spec[2];
        const a = money(pr[pk]), b = grp.sum[ck] || 0, okv = near(a, b);
        if (!okv) {
          bad = true;
          errors.push({ key: k, field: lbl, ref: "§1.3 · দুই view-এ একই মান আসার কথা", date: pr.date, pw: fmt(a), cw: fmt(b), diff: fmt(b - a),
            note: grp.rows.length + " টি কোর্সের যোগফল" });
        }
        fields.push({ label: lbl, pw: a, cw: b, ok: okv });
      });

      /* Received: PW = header amount, CW = Σ of the course lines. On an ordinary Money Receipt the
         two must agree. On a Cancellation the money moves between courses — written on the lines
         only, nothing new enters the header — so a difference there is expected. */
      const pRcv = money(pr.received), cRcv = grp.sum.grossReceived || 0;
      if (!near(pRcv, cRcv)) {
        if (isCancel(pr)) {
          notes.push({ key: k, detail: "Received: Program Wise " + fmt(pRcv) + " ↔ Course Wise Gross " + fmt(cRcv) +
            " — Cancellation-এ Course-এর মাঝে টাকা সরেছে, header-এ নতুন আদায় নেই" });
        } else {
          bad = true;
          errors.push({ key: k, field: "Received", ref: "§2 · বাতিল ছাড়া header = লাইনের যোগফল", date: pr.date, pw: fmt(pRcv), cw: fmt(cRcv), diff: fmt(cRcv - pRcv),
            note: grp.rows.length + " টি কোর্সের যোগফল" });
        }
      }
      fields.push({ label: "Received", pw: pRcv, cw: cRcv, ok: near(pRcv, cRcv) });

      /* Cash Back — spec §2. Program Wise reports the cash that actually went back to the student;
         Course Wise bundles the Due Adjustment into the same column, because there the write-off
         and the refund both leave the course's balance. So the gap is not merely "Course Wise may
         be larger" — it is exactly the Due Adjustment:

             Course Wise Cash Back − Due Adjustment = Program Wise Cash Back

         reg 1436567 CRN 9643297107: 17,000 − 7,000 = 10,000. Of the 17,000 taken back, 7,000 was
         still owed and only cleared the debt; 10,000 was money the student had paid and came back
         as cash. Measured over 1,085 students: of 1,545 receipts on both pages, 12 have differing
         Cash Back and all 12 satisfy this exactly — so the old "Course Wise ≥ Program Wise" test
         was letting any larger number through unchecked. */
      const pcb = money(pr.cashBack), ccb = grp.sum.cashBack || 0;
      if (!near(pcb, ccb)) {
        const adj = grp.sum.dueAdjustment || 0;
        /* Money lifted off one course and put straight onto another of the SAME receipt never
           reaches the student, so it cannot show up in Program Wise's Cash Back — that column is
           the cash that actually left. How much moved is not a guess: it is whatever the course
           lines received that the header never took in.

           reg 2365277 CRN 9643232014 — "Biology porbena": the Biology course is cancelled, its
           7,000 comes back as 1,815 Due Adjustment (clearing the Biology due) + 5,185 Cash Back,
           and that 5,185 reappears as Gross Received on the Engineering line of the same receipt,
           settling its 5,185 due. Every taka is accounted for and nothing left the building, so
           Program Wise correctly reports 0 — yet this was filed as "একই রসিদে দুই পাতায় দুই রকম
           টাকা", the most serious category in the report.

           The Received check a few lines above already forgives exactly this movement on a
           cancellation ("Cancellation-এ Course-এর মাঝে টাকা সরেছে"). Cash Back is the other half
           of the same movement and was not forgiven. */
        const moved = isCancel(pr) ? Math.max(0, (grp.sum.grossReceived || 0) - money(pr.received)) : 0;
        /* Whether the Due Adjustment is bundled into the Course Wise Cash Back column is not
           written on the row either — UMS does both (see the cancellation identity below). Where
           two readings are equally legitimate, matching either one is a pass. */
        const cands = [ccb - adj - moved, ccb - moved];
        const gap = cands[0] - pcb;
        if (!cands.some(function (x) { return Math.abs(x - pcb) <= ROUND_BAND + 1e-6; })) {
          bad = true;
          errors.push({ key: k, field: "Cash Back", ref: "§2 · Program Wise Cash Back = Course Wise Cash Back − Due Adjustment − Course-এর মাঝে সরানো টাকা",
            date: pr.date, pw: fmt(pcb), cw: fmt(ccb), diff: fmt(gap),
            note: "Course Wise " + fmt(ccb) + " − Due Adjustment " + fmt(adj) +
              (moved ? " − Course-এর মাঝে সরেছে " + fmt(moved) : "") + " = " + fmt(cands[0]) +
              " (বা " + fmt(cands[1]) + "), কিন্তু Program Wise-এ " + fmt(pcb) });
        } else {
          notes.push({ key: k, detail: "Cash Back: Program Wise " + fmt(pcb) + " ↔ Course Wise " + fmt(ccb) +
            " — পার্থক্যটা Due Adjustment " + fmt(adj) +
            (moved ? " ও Course-এর মাঝে সরানো " + fmt(moved) : "") + " (spec §2)" });
        }
      }
      fields.push({ label: "Cash Back", pw: pcb, cw: ccb, ok: near(pcb, ccb), soft: true });

      // Deducted — spec §2 (PW has a Cancellation gate)
      const pd = money(pr.deducted), cd = grp.sum.deducted || 0;
      if (!near(pd, cd)) {
        if (isCancel(pr)) {
          bad = true;
          errors.push({ key: k, field: "Deducted Amount", ref: "§2 · বাতিলে দুই দিকে সমান", date: pr.date, pw: fmt(pd), cw: fmt(cd), diff: fmt(cd - pd),
            note: "Cancellation রসিদে দুই দিকেই সমান হওয়ার কথা" });
        } else {
          notes.push({ key: k, detail: "Deducted: Program Wise " + fmt(pd) + " ↔ Course Wise " + fmt(cd) + " — Program Wise-এ Cancellation gate (spec §2)" });
        }
      }
      fields.push({ label: "Deducted Amount", pw: pd, cw: cd, ok: near(pd, cd), soft: true });

      /* A refund receipt (gross 0, cash back X) is the normal shape of a cancellation — the money
         came in on an earlier receipt. Measured over 40 students it fired 39 times and was benign
         every single time, so it is NOT reported here. The program-total check below is what
         catches money actually leaving the program, and that one has signal. */

      /* Splitting by ratio may round each course line up or down, but the parts must still add up
         to the whole — 100 split across courses can never come back as 101. So the per-line
         ±ROUND_BAND forgiveness stops at the line: the receipt's own total is checked exactly. */
      // same rule as the per-row identity: a Consideration already contains the adjustment
      const sumAdj = grp.rows.reduce(function (s, ln) {
        return s + (isCancel(ln) ? money(ln.dueAdjustment) : 0);
      }, 0);
      const bareSum = (grp.sum.receivable || 0) - (grp.sum.consideration || 0) -
        ((grp.sum.prevStd || 0) + (grp.sum.booking || 0) + (grp.sum.special || 0)) -
        (grp.sum.netReceived || 0);
      /* Same two conventions as the per-row identity above, and the same clamp — a cancellation
         may reverse more than was owed, and UMS stores 0 rather than a negative due. */
      const clampS = function (x) { return isCancel(pr) ? Math.max(0, x) : x; };
      const expSums = sumAdj ? [clampS(bareSum - sumAdj), clampS(bareSum)] : [clampS(bareSum)];
      const gotSum = grp.sum.currentDue || 0;
      const expSum = expSums[0];
      const sumGap = gotSum - expSum;
      if (!expSums.some(function (x) { return Math.abs(gotSum - x) <= tol + 1e-6; })) {
        bad = true;
        errors.push({
          key: k, field: "Course-ভাগের যোগফল মিলছে না", ref: "ভাগ করলেও যোগফল মূল টাকার সমান থাকতে হবে",
          date: pr.date, kind: "identity", delta: sumGap, course: "", cancel: isCancel(pr),
          pw: "—", cw: fmt(grp.sum.currentDue || 0), diff: fmt(sumGap),
          note: grp.rows.length + " টি Course মিলিয়ে Current Due হওয়ার কথা " + fmt(expSum) +
            ", আছে " + fmt(grp.sum.currentDue || 0) + " (Δ" + fmt(sumGap) + ")"
        });
      }

      /* One receipt should carry each course once. A cancellation that inserts the course twice is
         the root of the contradictory due readings that follow — name it here rather than letting
         it surface as two opposite "Previous Due ভুল" lines. */
      const perCourse = {};
      grp.rows.forEach(function (ln) {
        const cn = String(ln.course || "").trim();
        if (!cn || cn === "-") return;
        perCourse[cn] = (perCourse[cn] || 0) + 1;
      });
      Object.keys(perCourse).forEach(function (cn) {
        if (perCourse[cn] < 2) return;
        bad = true;
        errors.push({
          key: k, field: "একই Course-এ একাধিক সারি", ref: "§5.4 · এক রসিদে এক Course একবার",
          date: pr.date, kind: "duprow", delta: 0, course: cn, cancel: isCancel(pr),
          pw: "—", cw: perCourse[cn] + " টি সারি", diff: "—",
          note: cn.slice(0, 30) + " — এই রসিদে " + perCourse[cn] + " বার এসেছে, একবার আসার কথা"
        });
      });

      groups.push({ key: k, date: pr.date, courses: grp.rows.length, fields: fields, bad: bad, lines: grp.rows });

      identities(k, pr, grp, errors, near, pr.date);
    });

    /* --- inside one ledger (this is where Course Wise's real bugs surface) --- */
    dueIdentity(pw.rows, "Program Wise", function (r) { return money(r.received) - money(r.cashBack); }, errors, near, null);
    dueIdentity(cw.rows, "Course Wise", function (r) { return money(r.netReceived); }, errors, near, function (r) { return r.course; });
    /* receipts one ledger has and the other never got — a hole in the middle of a due chain */
    const missingFromCw = new Set(), missingFromPw = new Set();
    pwM.forEach(function (r, k) { if (!cwG.has(k)) missingFromCw.add(k); });
    cwG.forEach(function (grp, k) { if (!pwM.has(k)) missingFromPw.add(k); });
    dueChain(pw.rows, "Program Wise", function () { return "Program"; }, errors, near, missingFromPw, cw.rows);
    dueChain(cw.rows, "Course Wise", function (r) { return (r.course || "").trim(); }, errors, near, missingFromCw, pw.rows);
    rowSanity(pw.rows, "Program Wise", "received", errors, tol, null);
    rowSanity(cw.rows, "Course Wise", "grossReceived", errors, tol, function (r) { return r.course; });
    sortOrder(pw.rows, "Program Wise", errors);
    sortOrder(cw.rows, "Course Wise", errors);

    /* A refund can only give back money that came in — but not necessarily on the same receipt.
       A pure cancellation returns what an EARLIER receipt collected, so this only holds across the
       whole program; checking it per receipt flags every ordinary refund as a fault.

       Not all of Cash Back is cash leaving, either: the part matched by a Due Adjustment is
       written off against what was owed and never goes out. Counting it flagged 11 programs that
       are entirely correct; net of it, all 1,082 measured programs come back clean. */
    const allGross = cw.rows.reduce(function (s, x) { return s + money(x.grossReceived); }, 0);
    const allAdj = cw.rows.reduce(function (s, x) { return s + money(x.dueAdjustment); }, 0);
    const allCash = cw.rows.reduce(function (s, x) { return s + money(x.cashBack); }, 0) - allAdj;
    /* The per-row `Cash Back = Consideration − Previous Due` rule finds the same over-refunds and
       names the receipt, the course, the date and the exact excess. When it has already spoken,
       this program-wide total says the same thing again with less detail — so it only reports
       what no single row explains. Measured: the 12 row-level findings cover all 11 totals. */
    const rowRefundFault = errors.some(function (e) {
      return e.kind === "cancelshape" && /Cash Back/.test(e.field);
    });
    if (allCash > allGross + tol + 1e-6 && !rowRefundFault) {
      errors.push({ key: "মোট", field: "Cash Back > আদায়", ref: "§5.2 · যা ওঠেনি তার বেশি ফেরত যায় না", pw: "—", cw: fmt(allCash),
        diff: fmt(allCash - allGross), kind: "cashback", delta: allCash - allGross, cancel: false,
        note: "পুরো Program-এ আদায় " + fmt(allGross) + ", কিন্তু নগদ ফেরত " + fmt(allCash) +
          (allAdj ? " (Cash Back " + fmt(allCash + allAdj) + " − Due Adjustment " + fmt(allAdj) + ")" : "") +
          " — " + fmt(allCash - allGross) + " বেশি ফেরত" });
    }

    // Footer / Total Summary is deliberately NOT checked (user rule): Program Wise recomputes parts
    // of it and Course Wise leaves columns blank, so it proves nothing the rows do not already say.
    // What matters is inside the table — each row's own arithmetic, the order they run in, and the
    // Program Wise row against the sum of that receipt's course lines.
    structure(cw, errors);

    markPrimary(cw.rows, errors);

    /* for naming the failure shape — how many courses, how many of them cancelled */
    const courseOf = function (r) { return String(r.course || "").trim(); };
    const allCourses = new Set(cw.rows.map(courseOf).filter(function (c) { return c && c !== "-"; }));
    const cancelledCourses = new Set(cw.rows.filter(isCancel).map(courseOf).filter(function (c) { return c && c !== "-"; }));
    const stats = {
      courses: allCourses.size,
      cancelled: cancelledCourses.size,
      cancelReceipts: new Set(cw.rows.filter(isCancel).map(function (r) { return String(r.crn).trim(); })).size
    };

    return { errors: errors, warnings: warnings, notes: notes, groups: groups, stats: stats,
      pwCount: pw.rows.length, cwCount: cw.rows.length, worthyCount: worthyRows.length };
  }

  /* Current Due = Receivable − Consideration − (PrevStd + Booking + Special) − Net Received */
  function dueIdentity(rows, side, netOf, errors, near, courseOf) {
    rows.forEach(function (r) {
      /* On a cancellation the Due Adjustment is what wipes that course's own balance, so it belongs
         in the expected due. Leaving it out made every cancellation look wrong by exactly the Due
         Adjustment amount — which is why this used to be a warning. Once it is counted, only
         rounding may remain; anything past ±ROUND_BAND is a real fault. */
      /* Program Wise has no Due Adjustment column at all (see PW_COLS), so on a cancellation there
         is nothing there to account for the reversal — the row simply cannot be checked from that
         side. Course Wise does carry the column, so it still is. */
      if (isCancel(r) && side === "Program Wise") return;
      /* Whether the Due Adjustment still has to come off depends on a convention the row does not
         state — the same one that splits the Cash Back rule in two:

           bundled   the Cash Back column already carries the write-off, so Net Received is short by
                     it and the adjustment must be subtracted again to land on the stored due.
                     reg 1436567 CRN 9643297107: 7,000 − 17,000 + 17,000 − 7,000 = 0 ✓
           separate  the Cash Back column holds only the cash that left, and the Consideration
                     already contains the write-off — subtracting it again removes the same money
                     twice. reg 2035886 CRN 9643217712: Consideration 5,000 = Due Adjustment 3,889
                     (clearing the Maths due) + Cash Back 1,111 (moved onto the Medical course).
                     Due 17,500 → 12,500, and 17,500 − 5,000 = 12,500 exactly; counting the 3,889
                     again gave 8,611 and called a correct receipt "বকেয়ার অঙ্ক মিলছে না".

         Both are real and both balance, so either satisfies this. A due that fits neither is still
         a fault — reg 2035886 with 5,000 stored would fail both readings. */
      const adj = isCancel(r) ? money(r.dueAdjustment) : 0;
      const bare = money(r.receivable) - money(r.consideration) -
        (money(r.prevStd) + money(r.booking) + money(r.special)) - netOf(r);
      const raw = bare - adj;
      /* A cancellation can reverse more than was owed, and then this arithmetic comes out below
         zero — but UMS never writes a negative Current Due, it writes 0. The cancellation identity
         further down already clamps for exactly this reason ("Both sides clamp at 0: UMS writes 0,
         never a negative"); this one did not, so a receipt whose money balances perfectly was
         reported as broken by the whole overshoot.

         reg 1618736 / CRN 9643244358: 19,000 reversed against a 9,000 due — 9,000 clears the debt
         (Due Adjustment) and 10,000 goes back as cash, 9,000 + 10,000 = 19,000, nothing lost. The
         expectation came out −9,000 against a stored 0 and the student was called a mismatch. */
      const clamp = function (x) { return isCancel(r) ? Math.max(0, x) : x; };
      const exps = adj ? [clamp(raw), clamp(bare)] : [clamp(raw)];
      const cur = money(r.currentDue);
      if (exps.some(function (x) { return Math.abs(cur - x) <= ROUND_BAND + 1e-6; })) return;
      const exp = exps[0];
      const gap = cur - exp;
      const c = courseOf ? (courseOf(r) || "").slice(0, 30) : "";
      errors.push({
        key: rowKey(r), field: side + ": Current Due-র হিসাব", ref: "§3.5 · Current Due = stored DueAmount", date: r.date,
        kind: "identity", delta: gap, course: c, cancel: isCancel(r),
        pw: side === "Program Wise" ? fmt(money(r.currentDue)) : "—",
        cw: side === "Course Wise" ? fmt(money(r.currentDue)) : "—",
        diff: fmt(gap),
        note: (c ? c + " — " : "") + "Receivable " + fmt(money(r.receivable)) + " − Consideration " +
          fmt(money(r.consideration)) + " − Discount − Net Received" + (adj ? " − Due Adj. " + fmt(adj) : "") +
          " = " + fmt(exp) + ", কিন্তু Current Due " + fmt(money(r.currentDue))
      });
    });
  }

  /* things that can never be true within a single row */
  function rowSanity(rows, side, receivedKey, errors, tol, courseOf) {
    rows.forEach(function (r) {
      const c = courseOf ? (courseOf(r) || "").slice(0, 30) : "";
      const at = c ? c + " — " : "";
      const rcvbl = money(r.receivable);
      const disc = money(r.special) + money(r.prevStd) + money(r.booking);

      /* Deducted Amount belongs to a Cancellation (CRN) row and nowhere else — per UMS the
         deduction is taken out first and what the row prints as Consideration Amount is already
         the remainder. On an ordinary receipt the column has nothing to describe, so a figure
         sitting there means the row is not the kind of row it claims to be.

         The cross-page comparison (§2, in compare()) only speaks when the two ledgers DISAGREE
         about the number. Both pages carrying the same wrong figure is exactly the case it cannot
         see, and it is the likelier one — this reads each row on its own terms. Deliberately
         mirrors the Due Adjustment rule in identities(), which says the same thing about the
         other cancellation-only column. */
      if (!isCancel(r) && Math.abs(money(r.deducted)) > ROUND_BAND + 1e-6) {
        errors.push({ key: rowKey(r), field: side + ": বাতিল ছাড়া রসিদে Deducted",
          ref: "§2 · Deducted শুধু বাতিলের (CRN) রসিদে", date: r.date, kind: "identity",
          delta: money(r.deducted), course: c, cancel: false,
          pw: side === "Program Wise" ? fmt(money(r.deducted)) : "—",
          cw: side === "Course Wise" ? fmt(money(r.deducted)) : "—", diff: fmt(money(r.deducted)),
          note: at + "CRN নেই, তবু Deducted " + fmt(money(r.deducted)) +
            " — বাতিলের রসিদ ছাড়া এই ঘরটা ০ থাকার কথা" });
      }

      /* On a Cancellation row the Consideration is what is being taken back and the Previous Due
         (which on these rows equals the Receivable) is what was owed:

             Cash Back − Due Adjustment = Consideration − Previous Due
             Current Due = Previous Due − Consideration − Due Adjustment   (0 if negative)

         Due Adjustment is the part of the money that never leaves — it is written off against
         what was owed instead of being handed back. Leaving it out reads the whole Cash Back as
         cash going out the door, which flags a correct receipt: reg 2146018 CRN 9643214968 takes
         back 5,000, refunds 5,000, of which 1,137 clears the Biology due and 3,863 reappears as
         Gross Received on the Engineering course of the same receipt. Nothing is lost.

         Measured over 1,082 students / 289 such rows: with Due Adjustment counted both identities
         hold 289/289. Without it the Cash Back one fails 12 times — every one a false alarm. */
      if (isCancel(r) && money(r.consideration) > 0) {
        const cons = money(r.consideration);
        const base = money(r.previousDue) || rcvbl;
        const adj = money(r.dueAdjustment);
        /* `exp` may be one figure or several. UMS is not consistent about ONE thing here: whether
           the Due Adjustment is bundled into the Cash Back column or kept out of it. Both forms
           turn up, both are correct, and the row does not say which convention it followed — so
           where two readings are equally legitimate, matching either one is a pass. The first is
           the one named in the message when neither matches. */
        const want = function (field, exp, got2, why, how) {
          const list = [].concat(exp);
          if (list.some(function (x) { return Math.abs(got2 - x) <= ROUND_BAND + 1e-6; })) return;
          errors.push({ key: rowKey(r), field: side + ": বাতিলে " + field, ref: why, date: r.date,
            kind: "cancelshape", delta: got2 - list[0], course: c, cancel: true,
            pw: side === "Program Wise" ? fmt(got2) : "—",
            cw: side === "Course Wise" ? fmt(got2) : "—", diff: fmt(got2 - list[0]),
            note: at + how + " → " + field + " " + list.map(fmt).join(" বা ") +
              " হওয়ার কথা, আছে " + fmt(got2) });
        };
        /* The Due Adjustment correction is only applied where it was measured — every one of the
           289 real rows takes back more than was owed. Below that line nothing is refunded at all,
           so the expectation is a plain 0 rather than a shape guessed from data that does not
           exist. Both sides clamp at 0: UMS writes 0, never a negative. */
        /* Two readings, both seen on correct receipts:
             bundled   Cash Back = Consideration − Previous Due + Due Adjustment
                       (the write-off is written into the Cash Back column as well — the 12 rows
                        the §2 rule was measured on, e.g. reg 1436567 CRN 9643297107)
             separate  Cash Back = Consideration − Previous Due
                       (the column holds only the cash that actually left, the write-off staying in
                        Due Adjustment — reg 1618736 CRN 9643244358: 19,000 − 9,000 = 10,000, and
                        9,000 + 10,000 = 19,000, so nothing is missing)
           Nothing on the row says which convention UMS used, so demanding the bundled one called
           the separate ones broken. Either satisfies the money; neither loses a taka. */
        want("Cash Back", cons > base ? [cons - base + adj, cons - base] : [0], money(r.cashBack),
          "বাতিলে Cash Back = Consideration − Previous Due (+ Due Adjustment, বান্ডল করা থাকলে)",
          "Consideration " + fmt(cons) + " − Previous Due " + fmt(base) + " (+ Due Adjustment " + fmt(adj) + ")");
        want("Current Due", Math.max(0, base - cons - adj), money(r.currentDue),
          "বাতিলে Current Due = Previous Due − Consideration − Due Adjustment",
          "Previous Due " + fmt(base) + " − Consideration " + fmt(cons) + " − Due Adjustment " + fmt(adj));
      }

      /* Once the discount passes Receivable the Current Due should go negative; in practice 0 is
         written and the excess lands on some other receipt's due. This is the cause, not the effect. */
      /* disc > 0 matters: an over-payment leaves Receivable negative (reg 1785439 CRN 9643208657
         carries −2,000), and 0 > −2,000 is true, so a row with no discount at all was reported as
         over-discounted. There is nothing to compare when nothing was discounted. */
      if (disc > 0 && disc > rcvbl + tol + 1e-6) {
        errors.push({
          key: rowKey(r), field: side + ": Receivable-এর বেশি ছাড়", ref: "§3.7 · ছাড় Receivable ছাড়াতে পারে না", date: r.date,
          kind: "overdiscount", delta: disc - rcvbl, course: c, cancel: isCancel(r),
          pw: side === "Program Wise" ? fmt(disc) : "—",
          cw: side === "Course Wise" ? fmt(disc) : "—",
          diff: fmt(disc - rcvbl),
          note: at + "ছাড় " + fmt(disc) + " (Sp " + fmt(money(r.special)) + " + Prev.Std " + fmt(money(r.prevStd)) +
            (money(r.booking) ? " + Booking " + fmt(money(r.booking)) : "") + ") > Receivable " + fmt(rcvbl) +
            " — " + fmt(disc - rcvbl) + " বেশি"
        });
      }

      /* Receivable and Current Due identical while nothing was collected and nothing discounted.
         That is only a fault if the Receivable came from nowhere: no Income raised it and no
         Previous Due carried it in. A row with no Income but a Previous Due behind it is an
         ordinary carry-forward — the money is simply still owed, and §3.3 already checks that
         Receivable − Income equals it. Flagging those made correct rows read as broken. */
      const moved = money(r.income) + money(r[receivedKey]) + disc + money(r.consideration) +
        money(r.dueAdjustment) + money(r.cashBack);
      const fromNowhere = Math.abs(money(r.previousDue)) <= tol;
      if (fromNowhere && rcvbl > tol && Math.abs(rcvbl - money(r.currentDue)) <= tol && Math.abs(moved) <= tol) {
        errors.push({ key: rowKey(r), field: side + ": রসিদে কোনো লেনদেন নেই",
          ref: "Receivable এল কোথা থেকে — Income নেই, Previous Due-ও নেই", date: r.date, kind: "idle", delta: 0,
          course: c, cancel: isCancel(r), pw: "—", cw: "—", diff: "—",
          note: at + "Receivable " + fmt(rcvbl) + " = Current Due " + fmt(money(r.currentDue)) +
            ", অথচ Income ০ · Previous Due ০ · আদায় ০ · ছাড় ০" });
      }
    });
  }

  /* Rows must run one way from top to bottom — either oldest→newest or newest→oldest, whichever the
     page uses. A row that sits out of sequence breaks the due chain that is read off that order, so
     it is a real fault, not a cosmetic one. Equal dates are fine. */
  /* Which way this table runs, decided by counting every step rather than by the first pair of
     differing dates to turn up. That first pair used to settle it, so one row out of place at the
     top set the direction for the whole table and every row below it was then reported as broken —
     three findings for one misplaced row, and never the row that moved.

     A tie (or a single date) is "cannot say", and the caller decides what to do about that. */
  function sortedWay(d, fallback) {
    let up = 0, down = 0, last = null;
    for (let i = 0; i < d.length; i++) {
      if (d[i] == null) continue;
      if (last !== null) {
        if (d[i] > last) up++;
        else if (d[i] < last) down++;
      }
      last = d[i];
    }
    if (up === down) return fallback;
    return up > down;
  }

  function sortOrder(rows, side, errors) {
    const d = rows.map(function (r) { return toDate(r.date); });
    /* On a tie the ledger's own convention settles it — Program Wise runs oldest→newest and
       Course Wise newest→oldest. Three rows with one step each way is a genuine tie and also a
       genuinely out-of-order table, so answering "cannot say" there would drop a real finding;
       the convention is what the table was supposed to be doing in the first place.
       A table of one date, or of none, produces no steps either way and so no findings. */
    const asc = sortedWay(d, side !== "Course Wise");
    const way = asc ? "পুরনো→নতুন" : "নতুন→পুরনো";
    for (let i = 1; i < d.length; i++) {
      if (d[i] == null || d[i - 1] == null) continue;
      const broken = asc ? d[i] < d[i - 1] : d[i] > d[i - 1];
      if (!broken) continue;
      errors.push({
        key: rowKey(rows[i]), field: side + ": সারির ক্রম", ref: "সারি তারিখ অনুযায়ী সাজানো থাকার কথা", date: rows[i].date,
        kind: "order", delta: 0, cancel: isCancel(rows[i]),
        pw: side === "Program Wise" ? String(rows[i].date || "?") : "—",
        cw: side === "Course Wise" ? String(rows[i].date || "?") : "—",
        diff: "—",
        note: (i + 1) + " নম্বর সারির তারিখ " + (rows[i].date || "?") + ", আগের সারি " +
          (rows[i - 1].date || "?") + " — টেবিলের ক্রম (" + way + ") ভেঙেছে"
      });
    }
  }

  /* Course Wise টেবিলে যে সারিটা সবচেয়ে নিচে (সবচেয়ে পুরনো) সেখানকার ভুলটাই মূল।
     ছবিতে ঐ একটাতেই দাগ পড়ে, remarks-ও ঐটার কথাই বলে — একসাথে সব দেখালে বোঝা যায় না। */
  function markPrimary(cwRows, errors) {
    if (!errors.length) return;
    const at = function (e) {
      return cwRows.findIndex(function (r) {
        return rowKey(r) === e.key &&
          (!e.course || String(r.course || "").trim().startsWith(String(e.course).trim().slice(0, 25)));
      });
    };
    let best = -1, pick = null;
    errors.forEach(function (e) { const i = at(e); if (i > best) { best = i; pick = e; } });
    (pick || errors[0]).primary = true;
  }

  /* dd/MM/yyyy → timestamp */
  function toDate(s) {
    const m = String(s || "").match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    return m ? new Date(+m[3], +m[2] - 1, +m[1]).getTime() : null;
  }

  /* The ledgers sort opposite ways (Program Wise old→new, Course Wise new→old).
     Read the direction off the dates and always hand back old→new. */
  function chronological(rows, defaultAsc) {
    /* The same counting, and it matters more here: this is not reporting anything, it is putting
       the rows in the order the due chain is read in. Backwards, and every link opens on the wrong
       figure — a student comes back covered in "Previous Due ভুল" lines that are all consequences
       of one misread sort. */
    const asc = sortedWay(rows.map(function (r) { return toDate(r.date); }), defaultAsc);
    return asc ? rows.slice() : rows.slice().reverse();
  }

  /* Due continuity — a course's next receipt must open with the previous receipt's Current Due. */
  /* `absent` (optional): receipt keys this ledger never got, though the other one has them. The
     due chain is read off consecutive receipts, so a receipt missing from the middle leaves a
     hole — the link before it closes at one figure and the link after it opens at another, and
     the gap is exactly what the missing receipt did. Reporting that as a broken Previous Due
     blames the wrong row: reg 1960915 loses cancellation CRN 9643203886, which consumed a 6,000
     due, so Course Wise reads "6,000 হওয়ার কথা, আছে 0" on a row that is perfectly correct. The
     missing receipt is already reported on its own, so the hole it leaves is not reported twice. */
  function dueChain(rows, side, groupOf, errors, near, absent, other) {
    /* Does a receipt this ledger never received sit between these two links? Walk the OTHER
       ledger's receipts in date order and see whether an absent one falls in the gap. */
    const otherSeq = [];
    if (absent && absent.size && other) {
      chronological(other, true).forEach(function (r) {
        const k = rowKey(r);
        if (otherSeq[otherSeq.length - 1] !== k) otherSeq.push(k);
      });
    }
    const gapExplained = function (fromK, toK) {
      if (!otherSeq.length) return false;
      let a = otherSeq.indexOf(fromK), b = otherSeq.indexOf(toK);
      if (a < 0 || b < 0) return false;
      if (a > b) { const t = a; a = b; b = t; }
      for (let j = a + 1; j < b; j++) if (absent.has(otherSeq[j])) return true;
      return false;
    };

    const chains = new Map();
    chronological(rows, side === "Program Wise").forEach(function (r) {
      const gk = (groupOf(r) || "").trim();
      if (!gk || gk === "-") return;
      if (!chains.has(gk)) chains.set(gk, []);
      chains.get(gk).push(r);
    });
    chains.forEach(function (rowsOfCourse, course) {
      /* Step receipt by receipt, not row by row. A cancellation can insert the same course twice
         inside ONE receipt; walking those two as if they were consecutive receipts reports the same
         fault twice, once in each direction. Per receipt: the due it opens with is the first row's
         Previous Due, the due it leaves behind is the last row's Current Due. */
      const list = [];
      rowsOfCourse.forEach(function (r) {
        const k = rowKey(r);
        const last = list[list.length - 1];
        if (last && last.__k === k) { last.currentDue = r.currentDue; return; }
        list.push({ __k: k, date: r.date, mrn: r.mrn, crn: r.crn,
          previousDue: r.previousDue, currentDue: r.currentDue });
      });
      for (let i = 1; i < list.length; i++) {
        const prev = list[i - 1], cur = list[i];
        const expected = money(prev.currentDue), actual = money(cur.previousDue);
        if (near(expected, actual)) continue;
        if (gapExplained(prev.__k, cur.__k)) continue;
        errors.push({
          key: rowKey(cur), field: side + ": Due-র ধারাবাহিকতা", ref: "ধারাবাহিকতা · আগের Current Due = পরের Previous Due", date: cur.date,
          kind: "chain", delta: actual - expected, course: course, cancel: isCancel(cur),
          pw: side === "Program Wise" ? fmt(actual) : "—",
          cw: side === "Course Wise" ? fmt(actual) : "—",
          diff: fmt(actual - expected),
          note: (side === "Course Wise" ? course + " — " : "") + "আগের রসিদে (" + rowKey(prev) +
            ") Current Due ছিল " + fmt(expected) + ", তাই এই রসিদে Previous Due " + fmt(expected) +
            " হওয়ার কথা; দেখাচ্ছে " + fmt(actual)
        });
      }
    });
  }

  /* spec §3.3 — Receivable = Income + Previous Due: what is owed on this receipt is what the
     receipt itself raised plus what was already outstanding.

     Deducted Amount does not belong in it. Per UMS (user) the column exists ONLY on a Cancellation
     (CRN) row, and there the deduction is taken first — the Consideration Amount printed on the row
     is already the remainder. So on an ordinary receipt the column is 0 and cannot shift anything,
     and on a cancellation Income is 0 (§3.7) while Receivable equals the Previous Due, which
     satisfies the identity from the other direction. The same reasoning keeps it out of §3.5. */
  function prevDueOff(r) {
    const exp = money(r.receivable) - money(r.income);
    const gap = money(r.previousDue) - exp;
    return Math.abs(gap) > ROUND_BAND + 1e-6 ? { exp: exp, gap: gap } : null;
  }

  /* §3.3 where there is no Course Wise row to pair against. identities() only ever runs on receipts
     that reached BOTH pages, so on the Course-Wise-empty path — the largest bucket of a run, 868 of
     1,086 measured — this one rule was never applied, even though the comment there claims §3.3
     stands on its own. Everything else that branch runs (§3.5, the due chain, row sanity, row
     order) needs no partner row either; neither does this. */
  function prevDueIdentity(rows, side, errors) {
    rows.forEach(function (r) {
      const b = prevDueOff(r);
      if (!b) return;
      errors.push({ key: rowKey(r), field: side + ": Previous Due-র হিসাব",
        ref: "§3.3 · Previous Due = Receivable − Income", date: r.date, kind: "identity",
        delta: b.gap, course: "", cancel: isCancel(r), pw: side === "Program Wise" ? fmt(money(r.previousDue)) : "—",
        cw: side === "Course Wise" ? fmt(money(r.previousDue)) : "—", diff: fmt(b.gap),
        note: "Receivable " + fmt(money(r.receivable)) + " − Income " + fmt(money(r.income)) +
          " = " + fmt(b.exp) + ", কিন্তু Previous Due " + fmt(money(r.previousDue)) });
    });
  }

  /* spec §3 — internal arithmetic identities */
  /* spec §3 identities. These used to be warnings; per the user there is no warning bucket any
     more — a row that contradicts its own arithmetic beyond rounding is a mismatch. */
  function identities(k, pr, grp, errors, near, date) {
    const off = function (a, b) { return Math.abs(a - b) > ROUND_BAND + 1e-6; };
    const push = function (field, ref, course, delta, detail) {
      errors.push({ key: k, field: field, ref: ref, date: date, kind: "identity",
        delta: delta, course: course, cancel: isCancel(pr), pw: "—", cw: "—", diff: fmt(delta), note: detail });
    };

    /* one formula, one place — prevDueOff() also serves the Course-Wise-empty path */
    const bPw = prevDueOff(pr);
    if (bPw) {
      const idPw = bPw.exp;
      push("Program Wise: Previous Due-র হিসাব", "§3.3 · Previous Due = Receivable − Income", "",
        money(pr.previousDue) - idPw,
        "Receivable " + fmt(money(pr.receivable)) + " − Income " + fmt(money(pr.income)) +
        " = " + fmt(idPw) + ", কিন্তু Previous Due " + fmt(money(pr.previousDue)));
    }
    grp.rows.forEach(function (r) {
      const c = (r.course || "").slice(0, 30);
      const bCw = prevDueOff(r);
      if (bCw) {
        const idCw = bCw.exp;
        push("Course Wise: Previous Due-র হিসাব", "§3.3 · Previous Due = Receivable − Income", c,
          money(r.previousDue) - idCw,
          c + ": Receivable − Income = " + fmt(idCw) + ", কিন্তু Previous Due " + fmt(money(r.previousDue)));
      }
      const net = money(r.grossReceived) - money(r.cashBack);
      if (off(net, money(r.netReceived))) {
        push("Course Wise: Net Received-এর হিসাব", "§3.4 · Net Received = Gross − Cash Back", c,
          money(r.netReceived) - net,
          c + ": Gross " + fmt(money(r.grossReceived)) + " − Cash Back " + fmt(money(r.cashBack)) +
          " = " + fmt(net) + ", কিন্তু Net Received " + fmt(money(r.netReceived)));
      }
      /* Due Adjustment belongs to Cancellation receipts only (§2). How much it should be is not
         guessed here — the row's own Current Due identity already subtracts it and catches any
         wrong amount. Trying to predict it from Consideration contradicted that check: on a real
         cancelled row Consideration is 0, so a correct write-off was reported as misplaced. What
         is left is the one thing the identity cannot say: an adjustment on a row that is not a
         cancellation at all. */
      if (!isCancel(r) && off(0, money(r.dueAdjustment))) {
        push("Due Adjustment ভুল জায়গায়", "§2 · Due Adjustment শুধু বাতিলের রসিদে", c,
          money(r.dueAdjustment),
          c + ": বাতিলের রসিদ নয় (CRN নেই), তবু Due Adjustment " + fmt(money(r.dueAdjustment)));
      }
      if (isCancel(r)) {
        [["Income", "income"], ["Prev. Std. Discount", "prevStd"], ["Special Discount", "special"]].forEach(function (z) {
          if (off(money(r[z[1]]), 0)) {
            push("বাতিলের সারিতে " + z[0], "§3.7 · বাতিলে Income/PrevStd/Special শূন্য", c,
              money(r[z[1]]),
              c + ": Cancellation-এ " + z[0] + " ০ হওয়ার কথা, দেখাচ্ছে " + fmt(money(r[z[1]])));
          }
        });
      }
    });
  }

  /* structural inconsistency */
  function structure(cw, errors) {
    const uniq = function (key) {
      const set = new Set();
      cw.rows.forEach(function (r) { const v = (r[key] || "").trim(); if (v && v !== "-") set.add(v); });
      return [...set];
    };
    // Branch / Campus are deliberately NOT checked (user rule): one program's courses can legitimately
    // run at different branches or campuses. Roll / Registration No. / Program Session still must not
    // vary — those identify the student, not the venue.
    [["roll", "Roll"], ["regNo", "Registration No."], ["programSession", "Program Session"]].forEach(function (pair) {
      const u = uniq(pair[0]);
      if (u.length > 1) {
        errors.push({ key: "কাঠামো", field: "একাধিক " + pair[1], ref: "§6 · এক Program-এ এক মান",
          kind: "struct", delta: 0, course: "", cancel: false, pw: "—", cw: u.length + " টি", diff: "—",
          note: u.length + " টি ভিন্ন মান — " + u.slice(0, 4).join("  |  ") });
      }
    });
    const noCourse = cw.rows.filter(function (r) { return !(r.course || "").trim() || (r.course || "").trim() === "-"; });
    if (noCourse.length) {
      errors.push({ key: "কাঠামো", field: "Course কলাম ফাঁকা", ref: "§5.5 · StudentCourseId null",
        kind: "struct", delta: 0, course: "", cancel: false, pw: "—", cw: noCourse.length + " টি সারি", diff: "—",
        note: noCourse.length + " টি সারিতে Course ফাঁকা" });
    }
  }

  /* ========================== category.js ========================== */

  const CATS = [
    /* "দুই ledger সরাসরি মিলছে না" told the reader nothing: it never said which page, what kind of
       gap, or what to do. It also covered two very different faults — a receipt that never reached
       one page at all (the common one, 805 of 1,085 measured students) and a receipt on both pages
       showing different money. Those are now separate, and each says which page and what happened. */
    /* selfEvident: the one-line summary already names the page, the receipts and the amount, so
       repeating a general explanation under it just says the same thing a third time. */
    { code: "missing", label: "রসিদটা এক পাতায় নেই", selfEvident: true,
      why: "একই রসিদ Program Wise-এ আছে, Course Wise-এ নেই (বা উল্টো) — টাকার হিসাব এক পাতায় অসম্পূর্ণ" },
    { code: "ledger", label: "একই রসিদে দুই পাতায় দুই রকম টাকা",
      why: "রসিদটা দুই পাতাতেই আছে, কিন্তু Program Wise আর Course Wise ভিন্ন অঙ্ক দেখাচ্ছে — সবচেয়ে গুরুতর" },
    { code: "overdiscount", label: "Receivable-এর চেয়ে বেশি ছাড়",
      why: "Special ও Prev. Std. ছাড় মিলে Receivable ছাড়িয়ে গেছে — বাড়তিটা অন্য রসিদের বকেয়ায় গিয়ে পড়ে" },
    { code: "cashback", label: "আদায়ের চেয়ে বেশি Cash Back",
      why: "রসিদে যত টাকা উঠেছে তার চেয়ে বেশি ফেরত দেখাচ্ছে" },
    { code: "duprow", label: "এক রসিদে একই Course দুবার",
      why: "বাতিলের সময় একই Course-এর দুটো সারি বসেছে — কোনটা ধরে বকেয়া হিসাব হবে বোঝা যায় না" },
    { code: "struct", label: "ছাত্রের তথ্যে গোলমাল",
      why: "এক Program-এ একাধিক Roll / Registration No. / Session বসেছে, বা Course-এর ঘর ফাঁকা" },
    { code: "idle", label: "রসিদে কোনো লেনদেন নেই",
      why: "Receivable আর Current Due এক, অথচ আদায়ও নেই ছাড়ও নেই — টাকাটা এল কোথা থেকে" },
    { code: "order", label: "সারির ক্রম ভাঙা",
      why: "তারিখ অনুযায়ী উপর থেকে নিচে সাজানো নেই — বকেয়ার ধারাবাহিকতা এই ক্রম ধরেই পড়া হয়" },
    { code: "lost", label: "বকেয়ার অঙ্ক মিলছে না",
      why: "Receivable − ছাড় − আদায় করলে যা হওয়ার কথা Current Due তা নয়, আর যোগফলেও মেলে না" },
    { code: "cancel", label: "বাতিলের পর বকেয়া ভুল",
      why: "Course বাতিলের রসিদে আগের বকেয়াটা না বসে অন্য অঙ্ক বসেছে" },
    { code: "chain", label: "এক রসিদ থেকে পরের রসিদে বকেয়া মিলছে না",
      why: "আগের রসিদ যত বকেয়া রেখে গেছে, পরের রসিদ তত দিয়ে শুরু করেনি" },
    { code: "moved", label: "টাকা এক Course থেকে আরেক Course-এ সরেছে",
      why: "একটায় যত বেশি, আরেকটায় ঠিক তত কম — মোট টাকা ঠিকই আছে, Course-ভাগটা ভুল" },
    { code: "rounding", label: "১-২ টাকার রাউন্ডিং",
      why: "Course-এর মাঝে অনুপাতে ভাগ করতে গিয়ে পয়সা কাটাকাটি — টাকার ক্ষতি নেই" },
    { code: "other", label: "অন্যান্য", why: "উপরের কোনো ধরনে পড়েনি — বিস্তারিত তালিকা দেখো" }
  ];
  const CAT_LABEL = {}, CAT_WHY = {}, CAT_ORDER = {}, CAT_SELF = {};
  CATS.forEach(function (c, i) { CAT_LABEL[c.code] = c.label; CAT_WHY[c.code] = c.why; CAT_ORDER[c.code] = i; CAT_SELF[c.code] = !!c.selfEvident; });

  const bn = function (n) {
    return String(n).replace(/[0-9]/g, function (d) { return "০১২৩৪৫৬৭৮৯"[+d]; });
  };

  function shape(p) {
    const s = p.stats || {};
    const c = s.courses || 0, x = s.cancelled || 0;
    if (!c) return "Course জানা যায়নি";
    return bn(c) + "টি Course · " + (x ? bn(x) + "টি বাতিল" : "বাতিল নেই");
  }

  function classify(p) {
    const errs = (p && p.errors) || [];
    if (!errs.length) return null;

    const d = [];
    errs.forEach(function (e) { if (typeof e.delta === "number" && isFinite(e.delta)) d.push(e.delta); });
    let maxAbs = 0, sum = 0;
    d.forEach(function (x) { sum += x; if (Math.abs(x) > maxAbs) maxAbs = Math.abs(x); });

    let chain = 0, ident = 0, plain = 0, gone = 0, over = 0, cashb = 0, ord = 0, dup = 0, str = 0, idle = 0, cancelled = false;
    errs.forEach(function (e) {
      if (e.kind === "chain") chain++;
      else if (e.kind === "identity") ident++;
      else if (e.kind === "overdiscount") over++;
      else if (e.kind === "cashback") cashb++;
      else if (e.kind === "order") ord++;
      else if (e.kind === "duprow") dup++;
      else if (e.kind === "struct") str++;
      else if (e.kind === "idle") idle++;
      // a receipt one page never received is a different fault from the two pages disagreeing
      else if (e.field === "Transaction") gone++;
      else plain++;
      if (e.cancel) cancelled = true;
    });
    const st = p.stats || {};
    const anyCancel = cancelled || (st.cancelled || 0) > 0;
    const balanced = d.length > 1 && Math.abs(sum) <= 2;

    let code;
    if (plain) code = "ledger";
    /* only when that is the WHOLE story — a student who also has a wrong amount should be filed
       under the wrong amount, which is the thing someone has to go and fix. */
    else if (gone === errs.length) code = "missing";
    /* A discount or Cash Back problem is the root cause — the broken Current Due arithmetic and the
       broken due chain are its consequences, so these are tested before them. */
    else if (dup) code = "duprow";
    else if (over) code = "overdiscount";
    else if (cashb) code = "cashback";
    // must precede the rounding test: an order error carries delta 0, which would look like rounding
    else if (ord) code = "order";
    else if (str) code = "struct";
    else if (idle) code = "idle";
    else if (maxAbs <= 2) code = "rounding";
    else if (chain && anyCancel) code = "cancel";
    else if (balanced) code = "moved";
    else if (chain) code = "chain";
    else if (ident) code = "lost";
    else code = "other";

    return {
      code: code, label: CAT_LABEL[code], why: CAT_WHY[code], order: CAT_ORDER[code],
      selfEvident: CAT_SELF[code],
      shape: shape(p), key: code + "|" + shape(p),
      errorCount: errs.length, maxDiff: maxAbs, netDiff: Math.round(sum)
    };
  }

  function group(programs) {
    const map = new Map();
    programs.forEach(function (p) {
      const c = p.category || classify(p);
      if (!c) return;
      if (!map.has(c.code)) map.set(c.code, { code: c.code, label: c.label, why: c.why, order: c.order, items: [], byShape: new Map() });
      const grp = map.get(c.code);
      grp.items.push(p);
      if (!grp.byShape.has(c.shape)) grp.byShape.set(c.shape, []);
      grp.byShape.get(c.shape).push(p);
    });
    const out = [...map.values()];
    out.forEach(function (o) {
      o.shapes = [...o.byShape.entries()].map(function (e) { return { shape: e[0], items: e[1] }; })
        .sort(function (a, b) { return b.items.length - a.items.length || a.shape.localeCompare(b.shape); });
      delete o.byShape;
    });
    return out.sort(function (a, b) { return a.order - b.order || b.items.length - a.items.length; });
  }

  /* ===================== panel rendering (report.js-shaped) ===================== */

  function esc(s) {
    return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* One short sentence per finding, for the batch list and the exports.
     The long `note` explains the arithmetic; this says what is wrong and by how much. */
  /* One line a person can act on: what kind of fault, where it started, how much else follows.
     The full list stays in the report and the export — this is the headline. */
  /* Course Wise ফাঁকা মানে শুধু দুই পাতা মেলানো গেল না — Program Wise নিজে তবু যাচাই হয়েছে (§3.5,
     due chain, row sanity, সারির ক্রম; compare()-এর CW-ফাঁকা শাখা দেখো)। ওই ফলগুলো বের করা হতো
     ঠিকই, কিন্তু নিচের দুটো early-return সেগুলো ফেলে দিত — তাই রানের সবচেয়ে বড় দলটা "Course Wise
     ফাঁকা" ছাড়া আর কিছুই বলত না, যদিও ভেতরে গরমিল ধরা পড়ে বসে আছে। */
  function pwFindings(r) {
    const errs = (r && r.errors) || [];
    if (!errs.length) return "";
    const head = errs.filter(function (e) { return e.primary; })[0] || errs[0];
    return " · Program Wise-এ " + bn(errs.length) + " টি নিজস্ব গরমিল — মূল: " +
      shortError(head).replace(/\s*\{[^}]*\}\s*$/, "");
  }

  function summary(r) {
    if (!r) return "";
    if (r.zeroPayment) return "কোনো Payment হয়নি — Course Wise ফাঁকা থাকাই স্বাভাবিক" + pwFindings(r);
    if (r.emptyCourseWise) return "Course Wise ফাঁকা — Program Wise-এ " + (r.worthyCount || 0) + " টি রসিদ আছে" + pwFindings(r);
    const errs = r.errors || [], warns = r.warnings || [];
    if (!errs.length) {
      if (!warns.length) return "সব মিলেছে";
      // no errors: spell the warnings out. A bare count ("১ টি সতর্কতা") says nothing.
      const lines = shortWarnings(warns);
      return "টাকা মিলেছে · " + lines.slice(0, 2).join(" · ") +
        (lines.length > 2 ? " · আরও " + (lines.length - 2) + " টি" : "");
    }
    const cat = r.category || classify(r);

    /* Missing receipts said the same thing three times — the category name, the finding and the
       explanation were all "it is on one page and not the other", and none of them said how much
       money was involved. One line instead: which page lacks it, which receipts, and the amount. */
    const gone = errs.filter(function (e) { return e.field === "Transaction"; });
    if (gone.length === errs.length) {
      const side = gone[0].cw === "নেই" ? "Course Wise" : "Program Wise";
      const sameSide = gone.every(function (e) {
        return (e.cw === "নেই" ? "Course Wise" : "Program Wise") === side;
      });
      const keys = gone.map(function (e) { return e.key; });
      const amount = gone.reduce(function (s, e) { return s + Math.abs(money(e.amount)); }, 0);
      if (sameSide) {
        return side + "-এ " + (gone.length > 1 ? bn(gone.length) + " টি রসিদ নেই" : "রসিদটা নেই") +
          " — " + keys.slice(0, 3).join(" · ") +
          (keys.length > 3 ? " · আরও " + bn(keys.length - 3) + " টি" : "") +
          (amount ? " · " + fmt(amount) + " টাকার" : "");
      }
    }

    const head = errs.filter(function (e) { return e.primary; })[0] || errs[0];
    const rest = errs.length - 1;
    // the spec reference belongs in the detail list, not in a one-line headline
    const bare = shortError(head).replace(/\s*\{[^}]*\}\s*$/, "");
    return (cat ? cat.label + " — " : "") + "মূল: " + bare +
      (rest > 0 ? " · এর ফলে আরও " + rest + " টি" : "") +
      (warns.length ? " · " + warns.length + " টি সতর্কতা" : "");
  }

  /* Which ledger the finding sits in — without it "Due ভুল" could mean either page. */
  /* Which page to open to see the fault. "PW"/"CW" said nothing to anyone who had not written
     them, so the page is named the way it is named on UMS. */
  function sideOf(e) {
    const f = String(e.field || "");
    /* An Expected ↔ Actual finding is about ONE page on TWO servers, the mirror image of everything
       else here (two pages on one server). Say which, or "Program Wise" alone would read as the
       same-server comparison. */
    if (e.srv) return "Expected ↔ Actual · " + (e.side || "");
    if (/^Program Wise/.test(f)) return "Program Wise";
    if (/^Course Wise/.test(f)) return "Course Wise";
    if (e.key === "FOOTER" || e.key === "মোট") return "দুই পাতার মোট";
    return "Program ↔ Course";   // a straight column comparison between the two ledgers
  }

  /* The ledger is already announced by the tag, so "Course Wise: বাতিলে Cash Back" would say it
     twice in one line. Strip the prefix and let the tag carry it. */
  function fieldOf(e) {
    return String(e.field || "").replace(/^(Program|Course) Wise:\s*/, "");
  }

  function shortError(e) {
    // where: ledger · course · receipt · date   —   enough to find the exact row on the page
    /* The course is skipped when the receipt key already carries it. On the two-server Course Wise
       comparison it always does — a receipt holds several courses, so the key has to name one to
       tell them apart — and the line came out reading
       "UDVASH Varsity Math · MRN 2220262250 · UDVASH Varsity Math". */
    const inKey = e.course && String(e.key).indexOf(String(e.course).trim()) >= 0;
    const at = "[" + sideOf(e) + "] " + (e.course && !inKey ? String(e.course).slice(0, 22) + " · " : "") +
      e.key + (e.date ? " · " + e.date : "");
    const ref = e.ref ? "  {" + e.ref + "}" : "";
    const shown = money(e.pw !== undefined && e.pw !== "—" ? e.pw : e.cw);
    const d = typeof e.delta === "number" ? e.delta : 0;
    const sign = d > 0 ? "+" : "";
    switch (e.kind) {
      /* Expected ↔ Actual. "হওয়ার কথা / আছে" is the wrong phrasing here — nothing is being derived,
         two stored values simply disagree — so both are named for what they are. */
      case "srvcell":
        return fieldOf(e) + " আলাদা · " + at + " — Expected " + e.pw + ", Actual " + e.cw +
          " (" + sign + fmt(d) + ")" + ref;
      case "srvtext":
        return fieldOf(e) + " আলাদা · " + at + " — Expected " + e.pw + ", Actual " + e.cw + ref;
      case "srvlost":
        return "Actual-এ নেই · " + at + (money(e.amount) ? " — " + fmt(Math.abs(money(e.amount))) + " টাকার" : "") + ref;
      case "srvextra":
        return "Actual-এ বাড়তি · " + at + (money(e.amount) ? " — " + fmt(Math.abs(money(e.amount))) + " টাকার" : "") + ref;
      case "srvempty":
        return (e.cw === "নেই" ? "Actual-এ নেই" : "Actual-এ বাড়তি") + " · " + at +
          " — সারিটায় কোনো টাকা নেই, হিসাবে কিছু বদলায়নি" + ref;
      case "srvcol":
      case "srvside":
        return fieldOf(e) + " · " + at + " — " + (e.note || "") + ref;
      case "identity":
        return "Due ভুল · " + at + " — হওয়ার কথা " + fmt(shown - d) + ", আছে " + fmt(shown) + " (" + sign + fmt(d) + ")" + ref;
      case "chain":
        return "Previous Due ভুল · " + at + " — হওয়ার কথা " + fmt(shown - d) + ", আছে " + fmt(shown) + " (" + sign + fmt(d) + ")" + ref;
      case "overdiscount":
        return "ছাড় বেশি · " + at + " — Receivable " + fmt(shown - d) + ", ছাড় " + fmt(shown) + " (" + fmt(d) + " বেশি)" + ref;
      case "cashback":
        return "Cash Back বেশি · " + at + " — আদায় " + fmt(money(e.cw) - d) + ", ফেরত " + fmt(money(e.cw)) + ref;
      case "struct":
      case "cancelshape":
      case "idle":
        return fieldOf(e) + " · " + at + " — " + (e.note || "") + ref;
      case "duprow":
        return "একই Course দুবার · " + at + " — " + (e.cw || "") + " (একবার আসার কথা)" + ref;
      case "order":
        return "সারির ক্রম ভাঙা · " + at + " — " + (e.note || "") + ref;
      default:
        /* the amount matters most and used to appear only in the on-screen one-liner, so the
           exported Remarks column said a receipt was missing without saying how much */
        if (e.field === "Transaction") {
          return at + " — " + (e.cw === "নেই" ? "শুধু Program Wise-এ আছে" : "শুধু Course Wise-এ আছে") +
            (money(e.amount) ? " · " + fmt(Math.abs(money(e.amount))) + " টাকার" : "") + ref;
        }
        if (String(e.key) === "FOOTER") return "Footer মিলছে না · " + fieldOf(e) + " — " + (e.note || e.cw || "") + ref;
        return fieldOf(e) + " মিলছে না · " + at + " — Program Wise " + e.pw + " ≠ Course Wise " + e.cw + ref;
    }
  }

  /* Warnings repeat a lot (the same note once per ledger and once per course). Fold identical
     kinds into one line with a count so a real one is not buried under its own echoes. */
  function shortWarnings(warnings) {
    const seen = [], byKind = {};
    (warnings || []).forEach(function (w) {
      const f = String(w.field || "");
      const kind = f.replace(/^(Program|Course) Wise: /, "");
      const side = /^Program Wise/.test(f) ? "Program Wise" : (/^Course Wise/.test(f) ? "Course Wise" : "");
      if (!byKind[kind]) { byKind[kind] = { kind: kind, n: 0, pw: 0, cw: 0, first: w }; seen.push(byKind[kind]); }
      const s = byKind[kind]; s.n++;
      if (side === "Program Wise") s.pw++; else if (side === "Course Wise") s.cw++;
    });
    return seen.map(function (s) {
      if (s.n === 1) return "[" + (s.pw ? "Program Wise" : s.cw ? "Course Wise" : "—") + "] " + s.kind + (s.first.detail ? " — " + s.first.detail : "");
      const where = (s.pw ? "Program Wise " + s.pw : "") + (s.pw && s.cw ? " · " : "") + (s.cw ? "Course Wise " + s.cw : "");
      return s.kind + " ×" + s.n + (where ? " (" + where + ")" : "");
    });
  }

  /* Every column of one receipt, PW beside CW — not just the ones that differ. */
  function columnTable(grp, lines) {
    // Program Wise carries one row per receipt; Course Wise splits the same receipt over its
    // courses. So the check is: PW value == Σ of that receipt's course lines, column by column.
    let h = '<table><thead><tr><th>Column</th><th>Program<br><span class="mut">এক সারি</span></th>' +
      '<th>Course<br><span class="mut">' + grp.courses + " টির যোগফল</span></th><th>Δ</th></tr></thead><tbody>";
    grp.fields.forEach(function (f) {
      const d = (f.cw || 0) - (f.pw || 0);
      const mark = f.ok ? '<span class="ok">✓</span>'
        : (f.soft ? '<span class="warn">≈ ' + fmt(d) + "</span>" : '<span class="no">✗ ' + fmt(d) + "</span>");
      h += '<tr><td>' + esc(f.label) + "</td><td>" + fmt(f.pw) + "</td><td>" + fmt(f.cw) + "</td><td>" + mark + "</td></tr>";
    });
    h += "</tbody></table>";
    // and the course lines that make up that Course column, so the sum can be seen adding up
    if (lines && lines.length > 1) {
      h += '<table style="margin-top:2px"><thead><tr><th>Course</th><th>Receivable</th><th>ছাড়</th>' +
        "<th>Net Received</th><th>Current Due</th></tr></thead><tbody>";
      lines.forEach(function (ln) {
        h += '<tr><td style="text-align:left">' + esc(String(ln.course || "").slice(0, 24)) + "</td><td>" +
          fmt(money(ln.receivable)) + "</td><td>" +
          fmt(money(ln.prevStd) + money(ln.booking) + money(ln.special)) + "</td><td>" +
          fmt(money(ln.netReceived)) + "</td><td>" + fmt(money(ln.currentDue)) + "</td></tr>";
      });
      h += "</tbody></table>";
    }
    return h;
  }

  /* One ledger's rows in the order the page prints them, each with its own arithmetic worked out.
     Program Wise runs oldest→newest from the top; Course Wise runs newest→oldest. */
  function rowMathTable(rows, side, netOf, courseOf) {
    if (!rows || !rows.length) return "";
    const way = side === "Program Wise" ? "উপরে সবচেয়ে পুরনো (১ম) → নিচে নতুন" : "উপরে সবচেয়ে নতুন (শেষ) → নিচে পুরনো";
    let h = '<div class="mut" style="margin-top:10px">' + side + " — সারির নিজস্ব হিসাব <span style=\"opacity:.75\">(" + way + ")</span></div>";
    h += '<table><thead><tr><th>#</th><th>তারিখ / রসিদ</th><th>হিসাব</th><th>Current Due</th><th></th></tr></thead><tbody>';
    rows.forEach(function (r, i) {
      const rcvbl = money(r.receivable), cons = money(r.consideration);
      const disc = money(r.prevStd) + money(r.booking) + money(r.special);
      const net = netOf(r);
      const exp = rcvbl - cons - disc - net;
      const cur = money(r.currentDue);
      const okv = Math.abs(exp - cur) <= 1e-6;
      const who = (courseOf ? esc(String(courseOf(r) || "").slice(0, 22)) + "<br>" : "") +
        '<span class="mut">' + esc(r.date || "") + " · " + esc(rowKey(r)) + "</span>";
      h += '<tr><td>' + (i + 1) + "</td><td style=\"text-align:left\">" + who + "</td>" +
        '<td class="mut">' + fmt(rcvbl) + (cons ? " − " + fmt(cons) : "") + (disc ? " − " + fmt(disc) : "") +
        (net ? " − " + fmt(net) : "") + " = <b>" + fmt(exp) + "</b></td>" +
        "<td>" + fmt(cur) + "</td>" +
        "<td>" + (okv ? '<span class="ok">✓</span>' : '<span class="no">✗ Δ' + fmt(cur - exp) + "</span>") + "</td></tr>";
    });
    return h + "</tbody></table>";
  }

  function renderReport(r, pw, cw) {
    let html = "";
    const cat = (r.errors && r.errors.length) ? (r.category || classify(r)) : null;

    if (r.emptyCourseWise) {
      html += '<div class="verdict ' + (r.worthyCount ? "vno" : "vwarn") + '">' +
        (r.worthyCount
          ? "⚠ Program Wise-এ " + r.worthyCount + " টি রসিদযোগ্য সারি আছে, কিন্তু Course Wise ফাঁকা"
          : "Course Wise ফাঁকা — §5.5 অনুযায়ী স্বাভাবিক") + "</div>";
    } else if (!r.errors.length) {
      html += '<div class="verdict ' + (r.warnings.length ? "vwarn" : "vok") + '">✓ মিলেছে' +
        (r.warnings.length ? " · " + r.warnings.length + " টি সতর্কতা" : "") + "</div>";
    } else {
      html += '<div class="verdict vno">⚠ ' + r.errors.length + " টি অমিল · " + esc(cat.label) + "</div>";
      html += '<div class="mut" style="margin:-2px 0 8px">' +
        (cat.selfEvident ? "" : esc(cat.why) + " · ") + esc(cat.shape) + "</div>";
    }

    if (r.errors && r.errors.length) {
      html += '<div class="vno" style="padding:6px 10px;border-radius:8px;margin:6px 0">' +
        r.errors.map(function (e) {
          const val = (e.pw !== undefined && e.cw !== undefined) ? " : Program Wise <b>" + esc(e.pw) + "</b> ↔ Course Wise <b>" + esc(e.cw) + "</b>" : "";
          return "• <b>" + esc(e.key) + "</b> · " + esc(e.field) + val +
            (e.note ? '<br>&nbsp;&nbsp;<span class="mut">' + esc(e.note) + "</span>" : "");
        }).join("<br>") + "</div>";
    }
    if (r.warnings && r.warnings.length) {
      html += '<div class="vwarn" style="padding:6px 10px;border-radius:8px;margin:6px 0">⚠ সতর্কতা:<br>' +
        r.warnings.map(function (w) { return "• <b>" + esc(w.field) + "</b> — " + esc(w.detail); }).join("<br>") + "</div>";
    }

    /* Receipt by receipt, every column side by side. A receipt with a real difference opens by
       itself; the clean ones stay folded so the panel does not become a wall of numbers. */
    if (r.groups && r.groups.length) {
      html += '<div class="mut" style="margin-top:10px">রসিদ ধরে কলাম মিলানো — ' + r.groups.length + " টি রসিদ:</div>";
      r.groups.forEach(function (grp) {
        const badFields = grp.fields.filter(function (f) { return !f.ok; });
        const tag = grp.bad
          ? '<span class="no">✗ ' + badFields.filter(function (f) { return !f.soft; }).length + " টি কলামে অমিল</span>"
          : (badFields.length ? '<span class="warn">≈ §2 — স্বাভাবিক পার্থক্য</span>' : '<span class="ok">✓ সব কলাম মিলেছে</span>');
        html += "<details" + (grp.bad ? " open" : "") + ' style="margin:4px 0">' +
          '<summary style="cursor:pointer"><b>' + esc(grp.key) + '</b> <span class="mut">· ' +
          esc(grp.date || "") + " · " + grp.courses + " টি course</span> — " + tag + "</summary>" +
          columnTable(grp, grp.lines) + "</details>";
      });
    }

    if (pw && pw.rows) html += rowMathTable(pw.rows, "Program Wise", function (x) { return money(x.received) - money(x.cashBack); }, null);
    if (cw && cw.rows) html += rowMathTable(cw.rows, "Course Wise", function (x) { return money(x.netReceived); }, function (x) { return x.course; });

    if (r.notes && r.notes.length) {
      html += '<div class="mut" style="margin-top:10px">টীকা (ভুল নয়):<br>' +
        r.notes.map(function (n) { return "• " + esc(n.key) + " — " + esc(n.detail); }).join("<br>") + "</div>";
    }
    html += '<div class="mut" style="margin-top:8px">Program Wise ' + (r.pwCount || 0) + " সারি · Course Wise " + (r.cwCount || 0) + " সারি</div>";
    return html;
  }

  /* Every captured cell as tab-separated text, ready to paste somewhere else.
     When a receipt is disputed — "this one is not really a mismatch" — the argument is settled by
     the actual numbers on the two pages, and until now those had to be copied out of UMS by hand,
     cell by cell. The extension already holds them parsed; this hands them over verbatim.
     Nothing is computed here and nothing is sent anywhere: it goes to the clipboard, and where it
     goes next is the reader's choice. */
  const RAW_PW = ["date", "mrn", "crn", "income", "consideration", "previousDue", "deducted",
    "receivable", "prevStd", "booking", "special", "received", "cashBack", "currentDue"];
  const RAW_CW = ["date", "course", "mrn", "crn", "income", "consideration", "previousDue",
    "deducted", "receivable", "prevStd", "booking", "special", "grossReceived", "dueAdjustment",
    "cashBack", "netReceived", "currentDue"];

  function rawText(pw, cw, meta) {
    /* Tab-separated, so a tab (or a newline) inside a course name would shift every column after
       it and quietly move the numbers under the wrong headings — the one thing this must not do.
       Collapse runs of whitespace, exactly as parseTable() already does when reading a cell. */
    const clean = function (v) { return String(v == null ? "" : v).replace(/\s+/g, " ").trim(); };
    const block = function (title, data, keys) {
      const rows = (data && data.rows) || [];
      let s = "## " + title + " — " + rows.length + " rows\n";
      if (!rows.length) return s + (data && data.noData ? "(No Data)\n" : "(not captured)\n");
      s += keys.join("\t") + "\n";
      rows.forEach(function (r) { s += keys.map(function (k) { return clean(r[k]); }).join("\t") + "\n"; });
      return s;
    };
    meta = meta || {};
    return "UMS Reconciler raw rows" +
      (meta.spid ? " · studentProgramId " + meta.spid : "") +
      (meta.reg ? " · reg " + meta.reg : "") + "\n\n" +
      block("Program Wise", pw, RAW_PW) + "\n" + block("Course Wise", cw, RAW_CW);
  }

  /* ============= server ↔ server — Expected vs Actual (migration check) =============
   *
   * A different question from everything above. compare() asks whether ONE server's two views of a
   * student agree with each other; this asks whether TWO servers hold the same student at all.
   * No rule is re-derived here and no arithmetic is judged: a receipt is simply expected to arrive
   * on the other server carrying every cell it left with.
   *
   * Columns are matched by NAME, not by position — a server that reorders or inserts a column
   * would otherwise report every row as different. Numbers go through money(), because "1,000" and
   * "1000" are one amount and a thousand lines saying otherwise would bury the real finding;
   * everything else is compared as text, with "-" and "" both read as empty since the pages use
   * them interchangeably.
   */

  /* header labels → stable keys. Unnamed columns (SL, an action button) stay out of the comparison
     entirely: there is no name to match them on and they carry nothing. */
  function headerKeys(header) {
    const seen = {}, out = [];
    (header || []).forEach(function (h) {
      const base = norm(h);
      if (!base) { out.push(null); return; }
      seen[base] = (seen[base] || 0) + 1;
      out.push(seen[base] > 1 ? base + "#" + seen[base] : base);
    });
    return out;
  }

  /* Columns that describe the TABLE rather than the payment, and so cannot be compared as data.
     A row's serial number is its position in the list: one extra row near the top of one server
     renumbers every row below it, and each of those was reported as "two servers, two amounts" —
     the most serious category there is — for receipts where nothing about the money differs.
     reg 1956107 MRN 2220262250: Sl. 4 against Sl. 5, on a row that matches to the taka.
     The difference in position is real, but it is the missing or extra row that caused it, and
     that row is already reported on its own. An Action column is buttons, not figures. */
  const NOT_DATA = { sl: 1, slno: 1, sln: 1, sino: 1, sino1: 1, serial: 1, serialno: 1, sn: 1,
    snno: 1, srl: 1, srno: 1, srlno: 1, no: 1, rowno: 1, rowno1: 1, action: 1, actions: 1 };
  const isNotData = function (k) { return !!NOT_DATA[String(k).replace(/#\d+$/, "")]; };

  /* Columns that describe the STUDENT or the venue rather than the payment. UMS repeats the same
     value on every row of the table, so one edit on one server came back as one finding per row,
     each the same sentence — reg 1956423 carries "Adiba Alam" against "Adiba" on four course rows.
     Said once instead, with how many rows carry it.

     They are also never treated as amounts, however numeric they look. A Registration No. is
     digits, and going down the money path filed a changed roll number under "একই ঘরে দুই সার্ভারে
     দুই অঙ্ক — সবচেয়ে গুরুতর", the category that means money has gone missing. */
  const PROFILE_COLS = { registrationno: 1, regno: 1, roll: 1, rollno: 1, nickname: 1, name: 1,
    studentname: 1, mobilenumber: 1, mobile: 1, phone: 1, programsession: 1, session: 1,
    program: 1, branch: 1, campus: 1 };
  const isProfile = function (k) { return !!PROFILE_COLS[String(k).replace(/#\d+$/, "")]; };
  /* one value for the whole table, or null if it varies (the single-server structure() check is
     what reports a profile column that varies — here it just means there is nothing to collapse) */
  const oneValue = function (rows, col) {
    if (!rows.length) return null;
    const v = rows[0].cells[col] == null ? "" : rows[0].cells[col];
    for (let i = 1; i < rows.length; i++) if ((rows[i].cells[col] || "") !== v) return null;
    return { v: v };
  };

  const cellText = function (v) {
    const s = String(v == null ? "" : v).replace(/\s+/g, " ").trim();
    return (s === "-" || s === "--") ? "" : s;
  };
  const looksNum = function (s) { return s === "" || /^\(?-?[\d,]*\.?[\d,]+\)?$/.test(s); };

  /* one table → its rows as { column key: cell }, plus the labels to print them under */
  function byName(tbl) {
    const keys = headerKeys(tbl && tbl.header);
    const label = {};
    keys.forEach(function (k, i) {
      if (k && label[k] === undefined) label[k] = String(((tbl && tbl.header) || [])[i] || "").trim() || k;
    });
    const rows = ((tbl && tbl.rows) || []).map(function (r) {
      const m = {}, raw = r.__raw || [];
      keys.forEach(function (k, i) { if (k) m[k] = cellText(raw[i]); });
      return { rec: r, cells: m };
    });
    return { rows: rows, label: label, keys: keys.filter(Boolean) };
  }

  /* MRN/CRN names the receipt; on Course Wise the course splits it further. A receipt that really
     does carry the same course twice (the §5.4 fault) would collapse two rows onto one key, so
     repeats are numbered — the two sides still line up and neither loses a row. */
  function srvKey(rec, which, seen) {
    let k = rowKey(rec);
    if (which === "cw") {
      const c = String(rec.course || "").trim();
      k += " · " + (c && c !== "-" ? c : "—");
    }
    seen[k] = (seen[k] || 0) + 1;
    return seen[k] > 1 ? k + " #" + seen[k] : k;
  }

  /* Every column that can hold an amount — the same list the single-server engine checks before
     it decides a receipt is worth arguing about. srvWorth() below answers "how much is this row
     worth"; this answers the different question "is there any money on it at all", which is what
     separates a row that took money with it from one that took nothing. */
  /* Every column that can hold an amount, in the order that answers "what is this row worth" —
     what actually came in first, then what was taken back, then what was owed, then the parts.

     It used to be two lists: a long one for "is there money on this row" and a short one for "how
     much". A cancellation falls between them — its money is in Cash Back and Due Adjustment, in
     neither of the short list's six columns — so reg 1633497 CRN 9643297957 was reported as money
     that did not survive the migration and could not say how much, on a row carrying 1,815 written
     off and 5,185 handed back. One list, and the two questions have one answer. */
  const SRV_MONEY = ["netReceived", "grossReceived", "received", "consideration", "cashBack",
    "receivable", "currentDue", "income", "previousDue", "dueAdjustment", "deducted",
    "prevStd", "booking", "special"];

  /* what the row is worth — so "a receipt is missing" can also say how much money went with it */
  function srvWorth(r) {
    for (let i = 0; i < SRV_MONEY.length; i++) {
      const v = money(r[SRV_MONEY[i]]);
      if (v) return v;
    }
    return 0;
  }
  /* the same question, asked the other way round — never a second list to fall out of step */
  function rowHasMoney(r) { return srvWorth(r) !== 0; }

  function diffTable(e, a, side, which, errors, notes, tol) {
    const near = function (x, y) { return Math.abs(x - y) <= tol + 1e-6; };
    const eOk = !!(e && e.ok), aOk = !!(a && a.ok);
    if (!eOk && !aOk) {
      notes.push({ key: side, detail: side + ": দুই সার্ভারের কোনোটাতেই টেবিল পাওয়া যায়নি" });
      return;
    }
    /* One side unread is not "the data differs" — nothing was compared at all, and calling that a
       mismatch sends someone hunting for a difference that was never measured. */
    if (!eOk || !aOk) {
      errors.push({ key: side, field: side + ": এক পাশের টেবিল পড়া যায়নি", ref: "মেলাতে দুই পাশেই টেবিল লাগে",
        srv: true, side: side, kind: "srvside", delta: 0, course: "", cancel: false,
        pw: eOk ? (e.rows.length + " সারি") : "পড়া যায়নি",
        cw: aOk ? (a.rows.length + " সারি") : "পড়া যায়নি", diff: "—",
        note: side + ": " + (eOk ? "Actual" : "Expected") + " সার্ভারে টেবিলটা পাওয়া যায়নি — মেলানো হয়নি" });
      return;
    }
    const E = byName(e), A = byName(a);

    /* A column one server has and the other does not is said once, here — not once per receipt.
       A dropped column would otherwise raise a finding on every single row and bury everything
       else the student has. */
    const eSet = {}, aSet = {};
    E.keys.forEach(function (k) { eSet[k] = 1; });
    A.keys.forEach(function (k) { aSet[k] = 1; });
    const onlyE = E.keys.filter(function (k) { return !aSet[k]; });
    const onlyA = A.keys.filter(function (k) { return !eSet[k]; });
    if (onlyE.length || onlyA.length) {
      errors.push({ key: side, field: side + ": কলাম আলাদা", ref: "দুই সার্ভারে একই কলাম থাকার কথা",
        srv: true, side: side, kind: "srvcol", delta: 0, course: "", cancel: false,
        pw: E.keys.length + " টি কলাম", cw: A.keys.length + " টি কলাম", diff: "—",
        note: side + ": " +
          (onlyE.length ? "Expected-এ আছে, Actual-এ নেই — " + onlyE.map(function (k) { return E.label[k]; }).join(", ") : "") +
          (onlyE.length && onlyA.length ? " · " : "") +
          (onlyA.length ? "Actual-এ আছে, Expected-এ নেই — " + onlyA.map(function (k) { return A.label[k]; }).join(", ") : "") });
    }
    const shared = E.keys.filter(function (k) { return aSet[k]; });
    /* Split them: the payment columns are compared cell by cell, the table's own bookkeeping is
       counted and mentioned once. */
    const dataCols = shared.filter(function (k) { return !isNotData(k); });
    const posCols = shared.filter(isNotData);
    let posDiff = 0;

    /* A student's own details, said once. Only where the value really is the same on every row —
       with a single row there is nothing to collapse, and naming the receipt is more use. */
    const collapsed = {};
    if (E.rows.length + A.rows.length > 2) {
      dataCols.forEach(function (col) {
        if (!isProfile(col)) return;
        const e1 = oneValue(E.rows, col), a1 = oneValue(A.rows, col);
        if (!e1 || !a1 || e1.v === a1.v) return;
        collapsed[col] = true;
        errors.push({ key: "ছাত্রের তথ্য", field: side + ": " + E.label[col],
          ref: "দুই সার্ভারে ছাত্রের তথ্য এক থাকার কথা",
          srv: true, side: side, kind: "srvtext", delta: 0, course: "", cancel: false,
          pw: e1.v || "(ফাঁকা)", cw: a1.v || "(ফাঁকা)", diff: "—",
          note: E.label[col] + ": Expected " + (e1.v ? "«" + e1.v + "»" : "(ফাঁকা)") +
            ", Actual " + (a1.v ? "«" + a1.v + "»" : "(ফাঁকা)") +
            " — ছাত্রের তথ্য, " + E.rows.length + " টি সারিতেই একই, তাই একবারই বলা হলো" });
      });
    }

    const eSeen = {}, aSeen = {}, eMap = new Map(), aMap = new Map();
    E.rows.forEach(function (r) { eMap.set(srvKey(r.rec, which, eSeen), r); });
    A.rows.forEach(function (r) { aMap.set(srvKey(r.rec, which, aSeen), r); });

    /* Rows that never made it across, and rows that appeared out of nowhere. Not the same fault —
       one is money gone missing, the other a receipt counted twice — so they are named separately
       rather than as one "row count differs". */
    /* A row with no money on it anywhere is still a row that did not cross, and still worth
       saying — two servers should hold the same rows, not merely the same totals. But it is not
       money going missing, so it does not wear that name or that rank. */
    const gone = function (r, k, lost) {
      const w = srvWorth(r.rec), dead = !rowHasMoney(r.rec);
      const what = lost ? "Actual-এ নেই" : "Actual-এ বাড়তি";
      errors.push({
        key: k, srv: true, side: side, delta: 0,
        field: side + ": " + (lost ? "সারিটা Actual-এ নেই" : "Actual-এ বাড়তি সারি") + (dead ? " (টাকা নেই)" : ""),
        ref: dead ? "দুই সার্ভারে একই সারি থাকার কথা"
          : (lost ? "Expected-এর প্রতিটা সারি Actual-এ থাকার কথা" : "Expected-এ নেই এমন সারি Actual-এ থাকার কথা নয়"),
        kind: dead ? "srvempty" : (lost ? "srvlost" : "srvextra"),
        course: which === "cw" ? String(r.rec.course || "").slice(0, 30) : "",
        cancel: isCancel(r.rec), date: r.rec.date, amount: w,
        pw: lost ? "আছে" : "নেই", cw: lost ? "নেই" : "আছে", diff: "—",
        note: side + ": " + (lost ? "Expected-এ সারিটা আছে, Actual-এ নেই" : "Actual-এ সারিটা আছে, Expected-এ নেই") +
          (dead ? " — তবে সারিটার কোনো ঘরেই টাকা নেই, তাই টাকার হিসাবে কিছুই বদলায়নি"
                : (w ? " — " + fmt(Math.abs(w)) + " টাকার" : ""))
      });
      return what;
    };
    eMap.forEach(function (r, k) { if (!aMap.has(k)) gone(r, k, true); });
    aMap.forEach(function (r, k) { if (!eMap.has(k)) gone(r, k, false); });

    /* Cell by cell, for every column both servers carry. */
    eMap.forEach(function (er, k) {
      const ar = aMap.get(k);
      if (!ar) return;
      /* the serial number, said once at the end instead of once per row */
      if (posCols.some(function (c) { return (er.cells[c] || "") !== (ar.cells[c] || ""); })) posDiff++;
      dataCols.forEach(function (col) {
        if (collapsed[col]) return;          // already said once, for the whole table
        const ev = er.cells[col] == null ? "" : er.cells[col];
        const av = ar.cells[col] == null ? "" : ar.cells[col];
        if (ev === av) return;
        const at = which === "cw" ? String(er.rec.course || "").slice(0, 30) : "";
        /* a profile column is never an amount, however numeric it looks */
        if (!isProfile(col) && looksNum(ev) && looksNum(av)) {
          const en = money(ev), an = money(av);
          if (near(en, an)) return;   // "1,000" ↔ "1000" ↔ "-" ↔ "" is not a difference
          errors.push({ key: k, field: side + ": " + E.label[col], ref: "দুই সার্ভারে একই ঘরে একই অঙ্ক থাকার কথা",
            srv: true, side: side, kind: "srvcell", delta: an - en, course: at,
            cancel: isCancel(er.rec), date: er.rec.date,
            pw: fmt(en), cw: fmt(an), diff: fmt(an - en),
            note: E.label[col] + ": Expected " + fmt(en) + ", Actual " + fmt(an) + " (Δ" + fmt(an - en) + ")" });
        } else {
          errors.push({ key: k, field: side + ": " + E.label[col], ref: "দুই সার্ভারে একই ঘরে একই লেখা থাকার কথা",
            srv: true, side: side, kind: "srvtext", delta: 0, course: at,
            cancel: isCancel(er.rec), date: er.rec.date,
            pw: ev || "(ফাঁকা)", cw: av || "(ফাঁকা)", diff: "—",
            note: E.label[col] + ": Expected " + (ev ? "«" + ev + "»" : "(ফাঁকা)") +
              ", Actual " + (av ? "«" + av + "»" : "(ফাঁকা)") });
        }
      });
    });

    /* Said once, as a note, because it is not a fault: the numbering moved, which is what happens
       when a row is added or removed above these — and that row has its own finding. */
    if (posDiff) {
      notes.push({ key: side, detail: side + ": " + posDiff +
        " টি সারির ক্রমিক নম্বর (" + posCols.map(function (k) { return E.label[k]; }).join(", ") +
        ") দুই সার্ভারে আলাদা — টাকার হিসাবে কিছু বদলায় না, উপরে সারি কম/বেশি হলে নিচের সব নম্বর সরে যায়" });
    }
  }

  /** exp/act = { pw, cw } — each the parseTable() output of that server's page. */
  function compareServers(exp, act, opts) {
    opts = opts || {};
    const errors = [], notes = [];
    exp = exp || {}; act = act || {};
    diffTable(exp.pw, act.pw, "Program Wise", "pw", errors, notes, opts.tolerance || 0);
    diffTable(exp.cw, act.cw, "Course Wise", "cw", errors, notes, opts.tolerance || 0);
    const n = function (t) { return (t && t.rows) ? t.rows.length : 0; };
    /* The headline has to explain the verdict. It used to be errors[0] — whichever page was read
       first — so reg 1628880, filed under "a row did not cross", opened with a differing username
       from the other page and the two lines contradicted each other. It is the first finding of
       the kind that decided the category, using the same ranking classifyServers uses, so the
       label and the line it is followed by cannot part company again. */
    if (errors.length) {
      const seen = {};
      errors.forEach(function (e) { seen[e.kind] = 1; });
      const top = SRV_RANK.filter(function (c) { return seen[c]; })[0];
      (errors.filter(function (e) { return e.kind === top; })[0] || errors[0]).primary = true;
    }
    return { srv: true, errors: errors, warnings: [], notes: notes, groups: [],
      ePwCount: n(exp.pw), aPwCount: n(act.pw), eCwCount: n(exp.cw), aCwCount: n(act.cw) };
  }

  /* How serious each kind is, most first. classifyServers() files the student by it and
     compareServers() picks the headline by it — one list, so a verdict and the line under it are
     always about the same finding. */
  const SRV_RANK = ["srvside", "srvlost", "srvextra", "srvcol", "srvcell", "srvempty", "srvtext"];

  const SRV_CATS = [
    { code: "srvside", label: "এক পাশের পাতা পড়া যায়নি",
      why: "দুই সার্ভারের একটাতে টেবিলটাই পাওয়া যায়নি — কিছু মেলানো হয়নি, পার্থক্য আছে কিনা জানাই যায়নি" },
    { code: "srvlost", label: "Actual-এ সারি নেই — ডেটা হারিয়েছে",
      why: "Expected-এ যে সারি আছে Actual-এ সেটা নেই — মাইগ্রেশনে সারিটা যায়নি" },
    { code: "srvextra", label: "Actual-এ বাড়তি সারি",
      why: "Expected-এ নেই এমন সারি Actual-এ বসেছে — দুবার ঢুকেছে, বা আগের কিছু রয়ে গেছে" },
    { code: "srvcol", label: "দুই সার্ভারে কলাম আলাদা",
      why: "একটা সার্ভারে যে কলাম আছে অন্যটায় নেই — ঘর ধরে মেলানোর আগে এটাই ঠিক করতে হবে" },
    { code: "srvcell", label: "একই ঘরে দুই সার্ভারে দুই অঙ্ক",
      why: "সারিটা দুই সার্ভারেই আছে, কিন্তু টাকার অঙ্ক আলাদা — সবচেয়ে গুরুতর" },
    { code: "srvempty", label: "সারি নেই, তবে ওতে টাকাও নেই",
      why: "সারিটা এক সার্ভারে আছে অন্যটায় নেই — কিন্তু ওর কোনো ঘরেই টাকা নেই, তাই টাকার হিসাবে কিছু বদলায়নি" },
    { code: "srvtext", label: "একই ঘরে দুই সার্ভারে দুই লেখা",
      why: "টাকা এক, কিন্তু কোনো লেখার ঘর (Remarks · User · Payment Method · Course নাম) আলাদা" },
    { code: "srvok", label: "দুই সার্ভারে এক", why: "প্রতিটা সারির প্রতিটা ঘর মিলে গেছে" }
  ];
  const SRV_LABEL = {}, SRV_WHY = {}, SRV_ORDER = {};
  SRV_CATS.forEach(function (c, i) { SRV_LABEL[c.code] = c.label; SRV_WHY[c.code] = c.why; SRV_ORDER[c.code] = i; });

  /* One student, one verdict — the most serious thing found, in the order of the list above:
     a page never read outranks everything (nothing was measured), then money gone missing, then
     money that changed, and a differing Remarks column last. */
  function classifyServers(p) {
    const errs = (p && p.errors) || [];
    if (!errs.length) return null;
    const has = {};
    errs.forEach(function (e) { has[e.kind] = (has[e.kind] || 0) + 1; });
    /* srvempty sits below everything that involves money: a row that carried nothing is still a
       row that did not cross, but a student who also has a wrong amount is filed under the amount,
       which is the thing someone has to go and fix. */
    const code = SRV_RANK.filter(function (c) { return has[c]; })[0] || "srvcell";
    let maxAbs = 0, sum = 0;
    errs.forEach(function (e) {
      if (typeof e.delta !== "number" || !isFinite(e.delta)) return;
      sum += e.delta; if (Math.abs(e.delta) > maxAbs) maxAbs = Math.abs(e.delta);
    });
    const cells = (has.srvcell || 0) + (has.srvtext || 0);
    const lines = (has.srvlost || 0) + (has.srvextra || 0) + (has.srvempty || 0);
    const shp = bn(cells) + "টি ঘর · " + bn(lines) + "টি সারি";
    return { code: code, label: SRV_LABEL[code], why: SRV_WHY[code], order: SRV_ORDER[code],
      selfEvident: false, shape: shp, key: code + "|" + shp,
      errorCount: errs.length, maxDiff: maxAbs, netDiff: Math.round(sum) };
  }

  function summaryServers(r) {
    if (!r) return "";
    const errs = r.errors || [];
    if (!errs.length) {
      return "দুই সার্ভারে হুবহু এক — Program Wise " + (r.ePwCount || 0) +
        " · Course Wise " + (r.eCwCount || 0) + " সারি মিলেছে";
    }
    const cat = r.category || classifyServers(r);
    const head = errs.filter(function (e) { return e.primary; })[0] || errs[0];
    const rest = errs.length - 1;
    return cat.label + " — মূল: " + shortError(head).replace(/\s*\{[^}]*\}\s*$/, "") +
      (rest > 0 ? " · আরও " + bn(rest) + " টি" : "");
  }

  /* All four tables verbatim — Expected beside Actual, so a disputed verdict is settled on the
     numbers without opening two servers side by side and reading eleven columns off each. */
  function rawTextServers(exp, act, meta) {
    meta = meta || {};
    return "UMS Reconciler — Expected ↔ Actual raw rows" +
      (meta.spid ? " · studentProgramId " + meta.spid : "") +
      (meta.reg ? " · reg " + meta.reg : "") + "\n" +
      (meta.expUrl ? "Expected · " + meta.expUrl + "\n" : "") +
      (meta.actUrl ? "Actual   · " + meta.actUrl + "\n" : "") + "\n" +
      "########## EXPECTED ##########\n" + rawText((exp || {}).pw, (exp || {}).cw, {}) + "\n" +
      "########## ACTUAL ##########\n" + rawText((act || {}).pw, (act || {}).cw, {});
  }

  g.UMSREC = {
    rawText: rawText, RAW_PW: RAW_PW, RAW_CW: RAW_CW,
    money: money, norm: norm, spread: spread, resolveCols: resolveCols,
    PW_COLS: PW_COLS, CW_COLS: CW_COLS, parseTable: parseTable,
    PW_HEAD_WORDS: PW_HEAD_WORDS, headScore: headScore,
    compare: compare, receiptWorthy: receiptWorthy, rowKey: rowKey, isCancel: isCancel,
    fmt: fmt, COMPARE: COMPARE, shortError: shortError, shortWarnings: shortWarnings, summary: summary,
    pwFindings: pwFindings,
    CATS: CATS, classify: classify, group: group, shape: shape, bn: bn,
    compareServers: compareServers, classifyServers: classifyServers, summaryServers: summaryServers,
    rawTextServers: rawTextServers, SRV_CATS: SRV_CATS,
    renderReport: renderReport
  };
})(typeof self !== "undefined" ? self : this);
