/* Franchise Calculation — shared engine for the "For Franchisor" and "For Franchisee" menus.
 *
 * These two reports are arithmetic: the FRS states the relationships between the columns, so they can
 * be checked rather than eyeballed. This module talks to the same endpoints the UMS pages themselves
 * use and then re-derives every figure, reporting any row where UMS and the FRS disagree.
 *
 * Read-only. It only asks for reports; nothing here writes, and no page is opened.
 * Loads before app.js; shared core helpers are reached lazily through self.APP. */
(function () {
  "use strict";
  var A = self.APP || (self.APP = {});

  /* The two sides answer the same questions from opposite ends: the Franchisor asks what it is owed,
     the Franchisee what it owes. Same filters, same row shape, different controller. */
  var SIDE = {
    fr: { base: "Student/FranchisorCalculation/", course: "CourseWiseDataTable",
          student: "StudentWiseDataTable",
          page: "Student/FranchisorCalculation/CourseWise",
          studentPage: "Student/FranchisorCalculation/StudentWise" },
    fe: { base: "Student/FranchiseeCalculation/", course: "CourseWiseCalculationData",
          student: "StudentWiseCalculationData",
          page: "Student/FranchiseeCalculation/CourseWiseCalculation",
          studentPage: "Student/FranchiseeCalculation/StudentWiseCalculation" }
  };
  /* These stay in English in both languages on purpose: they are the UMS dropdown's own wording,
     and the recipe tells the reader to pick one of them there. A translated name would not be
     findable in the dropdown it refers to. */
  var TRANSFER = [
    { v: 30, t: "Non-Transfer" },
    { v: 10, t: "Franchisee → All" },
    { v: 20, t: "Franchisor → Franchisee" }
  ];

  /* Every sentence this module produces goes through the dictionary: a hardcoded Bangla string
     would simply stay Bangla when the panel is switched to English. {name} marks a slot. */
  function T(k) { return (A.t ? A.t(k) : k); }
  function fill(key, vals) {
    return String(T(key)).replace(/\{(\w+)\}/g, function (m, n) {
      return vals[n] === undefined ? m : String(vals[n]);
    });
  }
  function root(base) { return String(base || "").replace(/\/+$/, "") + "/"; }

  /* These endpoints answer 302 unless the Referer is their OWN page, and a page cannot set Referer
     on fetch. New Admission already solved this with a declarativeNetRequest session rule; the same
     shape is reused here under a different id. excludedInitiatorDomains is the crucial part: without
     it the rewrite would also hit the AJAX the user's own UMS tabs make, which quietly broke
     dropdowns across the UMS last time it was too broad. Our calls are initiated by the extension
     page, so they still get the header. Always disarmed again by the caller. */
  var RULE_ID = 8802;
  /* Scoped to the handful of paths this feature calls, and nothing else. The header rewrite used to
     cover every xmlhttprequest to the host for as long as a run lasted — minutes — so anything else
     the extension was doing against the same UMS at the time (a Payment History run left going, CRM,
     Function Check) had its Referer and Origin rewritten to the Franchisor page underneath it.
     excludedInitiatorDomains keeps the rewrite off the user's own UMS tabs but cannot protect the
     extension's own other traffic, because that really is initiated by the extension page. Path
     scoping can. A distinct priority also keeps it from tying with New Admission's rule 8801, which
     stands for the rest of the session once that feature has run. */
  var RULE_PATHS = "/Student/Franchis(or|ee)Calculation/|/Administration/CommonAjax/Load(Program|Session|Course)";
  async function armReferer(base, side, level) {
    var b = root(base), u;
    try { u = new URL(b); } catch (e) { return false; }
    var host = u.hostname;
    var reg = host.split(".").slice(-2).join(".");
    try {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [RULE_ID],
        addRules: [{
          id: RULE_ID, priority: 2,
          action: { type: "modifyHeaders", requestHeaders: [
            { header: "referer", operation: "set", value: b + (level === "student" ? SIDE[side].studentPage : SIDE[side].page) },
            { header: "origin", operation: "set", value: u.origin }
          ] },
          condition: {
            requestDomains: [host], resourceTypes: ["xmlhttprequest"],
            excludedInitiatorDomains: [reg], regexFilter: RULE_PATHS
          }
        }]
      });
      return true;
    } catch (e) { return false; }
  }
  async function disarmReferer() {
    try { await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [RULE_ID] }); } catch (e) {}
  }

  /* UMS answers a RequestVerificationToken header with 302 → PermissionDenied ("User appropiate
     login"), which looks exactly like an expired session and is not one. The session cookie alone is
     what authorises these calls, so the header must never be sent. See docs/franchise-api.md. */
  async function api(base, path, params, method) {
    var url = root(base) + path;
    var body = null;
    if (params) {
      var parts = [];
      Object.keys(params).forEach(function (k) {
        var v = params[k];
        if (Array.isArray(v)) v.forEach(function (x) { parts.push(encodeURIComponent(k) + "[]=" + encodeURIComponent(x)); });
        else parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(v == null ? "" : v));
      });
      body = parts.join("&");
    }
    var res = await fetch(url, {
      method: method || (body ? "POST" : "GET"),
      credentials: "include",
      headers: Object.assign({ "X-Requested-With": "XMLHttpRequest" },
        body ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      body: body || undefined
    });
    if (res.redirected && /\/Account\/Login/i.test(res.url)) throw new Error("login");
    var text = await res.text();
    /* 401 and 403 here mean one thing in practice: no session on THIS server. Reporting them as a
       bare status code sent the reader looking for a fault in the report instead of logging in. */
    if (res.status === 401 || res.status === 403) throw new Error("login");
    if (!res.ok) throw new Error("HTTP " + res.status);
    try { return JSON.parse(text); }
    catch (e) { throw new Error(/\/Account\/Login/i.test(text) ? "login" : "unreadable reply"); }
  }

  // ---- filter cascade -------------------------------------------------------
  function listOf(o) {
    if (Array.isArray(o)) return o;
    for (var k in o) if (Array.isArray(o[k])) return o[k];
    return [];
  }
  async function programs(base, orgId) {
    return listOf(await api(base, "Administration/CommonAjax/LoadProgram",
      { organizationIds: [orgId], isAuthorized: true }));
  }
  async function sessions(base, orgId, progId) {
    return listOf(await api(base, "Administration/CommonAjax/LoadSession",
      { organizationIds: [orgId], programIds: [progId], isAuthorized: true }));
  }
  async function branches(base, side, orgId, progId) {
    return listOf(await api(base, SIDE[side].base + "LoadFranchiseeBranch?organizationId="
      + encodeURIComponent(orgId) + "&programId=" + encodeURIComponent(progId || "")));
  }

  /* The two controllers answer in different shapes - the Franchisor side in DataTables form with a
     branch object per column, the Franchisee side with flat Own/Other/Franchisor fields and a
     negative Franchisor collection where money flows the other way. Normalise both to one row so the
     arithmetic below does not have to care which menu asked. */
  /* Student rows carry the same branch objects as course rows, plus the student's name and
     registration number, and a TotalService the report shows in its own column. Keeping one shape
     means the arithmetic below does not have to know which level it is looking at. */
  function normalise(side, j, level) {
    if (side === "fr") {
      return ((j && j.data) || []).map(function (r) {
        return {
          CourseId: r.CourseId, CourseName: r.CourseName, SessionName: r.SessionName,
          StudentName: r.StudentName, RegistrationNo: r.RegistrationNo,
          TotalService: r.TotalService,
          TotalCollection: r.TotalCollection, FranchisorPercent: r.FranchisorPercent,
          BaseCut: r.ReceivableAgainstBasePercent,
          TotalReceivable: r.FranchisorTotalReceivable,
          FranchisorService: (r.FranchisorBranch || {}).ValueOfService || 0,
          collections: [r.SelectedBranch].concat(r.OtherFranchiseeBranches || [], [r.FranchisorBranch])
            .filter(Boolean).map(function (b) { return Number(b.NetCollection) || 0; }),
          services: [r.SelectedBranch].concat(r.OtherFranchiseeBranches || [], [r.FranchisorBranch])
            .filter(Boolean).map(function (b) { return Number(b.ValueOfService) || 0; }),
          serviceCounts: [r.SelectedBranch].concat(r.OtherFranchiseeBranches || [], [r.FranchisorBranch])
            .filter(Boolean).map(function (b) { return Number(b.Services) || 0; })
        };
      });
    }
    return ((j && j.Rows) || []).map(function (r) {
      return {
        CourseId: r.CourseId, CourseName: r.CourseName, SessionName: r.SessionName,
        TotalCollection: r.TotalCollection, FranchisorPercent: r.FranchisorPercent,
        BaseCut: r.BaseAmount, TotalReceivable: r.FranchisorTotal,
        FranchisorService: Number(r.FranchisorService) || 0,
        collections: [Number(r.OwnCollection) || 0]
          .concat((r.OtherCollections || []).map(Number), [Number(r.FranchisorCollection) || 0]),
        services: [Number(r.OwnService) || 0]
          .concat((r.OtherServices || []).map(Number), [Number(r.FranchisorService) || 0])
      };
    });
  }
  async function courseWise(base, side, f) {
    var j = await api(base, SIDE[side].base + SIDE[side].course, {
      organizationId: f.orgId, programId: f.progId, sessionId: f.sessionId,
      franchiseeBranchId: f.branchId, courseIds: f.courseIds || "",
      transferType: f.transferType, dateFrom: f.dateFrom, dateTo: f.dateTo,
      showZeroPayment: !!f.showZero
    });
    if (j && j.error) throw new Error(String(j.error));
    return normalise(side, j, "course");
  }
  async function studentWise(base, side, f) {
    var j = await api(base, SIDE[side].base + SIDE[side].student, {
      organizationId: f.orgId, programId: f.progId, sessionId: f.sessionId,
      franchiseeBranchId: f.branchId, courseIds: f.courseIds || "",
      transferType: f.transferType, dateFrom: f.dateFrom, dateTo: f.dateTo,
      showZeroPayment: !!f.showZero
    });
    if (j && j.error) throw new Error(String(j.error));
    return normalise(side, j, "student");
  }

  // ---- the arithmetic the FRS promises --------------------------------------
  var r2 = function (n) { return Math.round((Number(n) || 0) * 100) / 100; };
  var near = function (a, b) { return Math.abs(r2(a) - r2(b)) <= 0.01; };
  /* Four relationships. Three hold for every course row. The fourth - that the branches' Value of
     Service accounts for everything left after the base cut - only holds once the WHOLE report is
     added up: a student taking two courses has their money split between the courses by ratio while
     their classes stay with one, so value legitimately moves between course rows. Checked live on
     ums-3: 47 of 116 rows differ per-course, always in exactly offsetting pairs, and every report
     balanced to the paisa. So per-row it is reported as movement, not as a fault. */
  /* Which rules apply where, learned by running them against ums-3 rather than by reading alone:

     1 Total Collection = the branches' net collections added up        - always
     2 Base% receivable = Total x Franchisor %                          - always
     3 Total Receivable = Base% + the Franchisor branch's service value - FRANCHISOR side only. The
       Franchisee report reuses the field name for a different quantity (what it owes), so asserting
       this there reported failures that were only a naming collision.
     4 the branches' service values account for everything after the base cut - only where the
       transfer types actually apportion by service. Non-Transfer does not: the FRS settles it as
       Net Collection x Base % with no service split, so every service value is 0 and the rule is
       meaningless there (it read as a 2.2-crore discrepancy before this was scoped).

     Even where 4 applies it holds for the REPORT, not for each course: a student taking two courses
     has their money split between the courses by ratio while their classes stay with one, so value
     moves between course rows. On ums-3, 47 of 116 rows differed per-course, always in exactly
     offsetting pairs, and every report still balanced to the paisa. Per row that is reported as
     movement; only the report total is a pass/fail. */
  function checkRows(rows, side, transferType) {
    var out = [], sumSvc = 0, sumRest = 0;
    var apportions = Number(transferType) !== 30;   // Non-Transfer has no service split
    rows.forEach(function (row) {
      var netSum = (row.collections || []).reduce(function (a, b) { return a + b; }, 0);
      var svc = (row.services || []).reduce(function (a, b) { return a + b; }, 0);
      var total = Number(row.TotalCollection) || 0;
      var pct = Number(row.FranchisorPercent) || 0;
      var baseCut = Number(row.BaseCut) || 0;
      sumSvc += svc; sumRest += (total - baseCut);

      var bad = [];
      /* The Student Wise report shows Total Class/Exam in its own column, and the cases assert it
         114 times — so it has to agree with the per-branch service counts beside it. */
      if (row.TotalService != null) {
        var svcCount = (row.serviceCounts || []).reduce(function (a, b) { return a + b; }, 0);
        if (!near(svcCount, row.TotalService))
          bad.push(fill("fv_f_svccount", { shown: r2(row.TotalService), sum: r2(svcCount) }));
      }
      /* Where the transfer types apportion by service, the money left after the base cut is divided
         by classes taken. A row with no classes at all divides by zero, and the FRS's guard puts 0
         in Value of Service — but it never says who owns the remainder. Run live against ums-3 on
         14.79 this was the whole story: 802 student rows, not one per-row rule broken, yet 3 of 9
         branch/transfer combinations failed the report balance, each tracing to exactly one row with
         classes = 0 — 400, 2,000 and 10,000 taka with no owner.

         Per-row drift is normally movement, not a fault: a student taking two courses has their money
         split between the courses by ratio while their classes stay with one. That defence needs a
         class somewhere to have moved the value TO. With zero classes on the row there is none, so
         the remainder is not moved, it is unaccounted for — and that is worth saying by name. */
      if (apportions && row.serviceCounts != null) {
        var classes = (row.serviceCounts || []).reduce(function (a, b) { return a + b; }, 0);
        var rest = total - baseCut;
        if (classes === 0 && Math.abs(rest) > 0.01)
          bad.push(fill("fv_f_noclass", { rest: r2(rest) }));
      }
      if (!near(netSum, total)) bad.push(fill("fv_f_total", { shown: r2(total), sum: r2(netSum) }));
      // a row with no Base % at all is a gap in the setup, not arithmetic that disagrees
      if (row.FranchisorPercent != null && !near(total * pct / 100, baseCut))
        bad.push(fill("fv_f_base", { shown: r2(baseCut), pct: pct, want: r2(total * pct / 100) }));
      if (side === "fr" && row.TotalReceivable != null) {
        var want = baseCut + (Number(row.FranchisorService) || 0);
        if (!near(want, row.TotalReceivable))
          bad.push(fill("fv_f_recv", { shown: r2(row.TotalReceivable), want: r2(want) }));
      }

      out.push({
        course: row.CourseName || ("#" + row.CourseId), session: row.SessionName || "",
        who: row.StudentName ? (row.StudentName + " · " + (row.RegistrationNo || "")) : "",
        total: r2(total), pct: pct, baseCut: r2(baseCut), svc: r2(svc),
        drift: apportions ? r2(svc - (total - baseCut)) : 0,
        fails: bad
      });
    });
    return {
      rows: out,
      apportions: apportions,
      reportDrift: apportions ? r2(sumSvc - sumRest) : 0
    };
  }
  /* The service worker usually survives closing and reopening the tool, so background.js clearing
     this rule at worker start is not enough on its own: a rule leaked by a panel closed mid-run
     would still be standing. Clear it as this module loads too — New Admission does the same for
     8801 — so it can never outlive the panel that armed it. */
  try { disarmReferer(); } catch (e) {}

  /* A fault is only useful if someone else can get back to it. Instead of a screenshot, every
     failure carries the path to itself: the page to open, the filter values spelled as they appear
     in the dropdowns (not as ids), the row to look at, what UMS put on screen, and what the FRS
     says it should have been. Follow the lines in order and the same figure appears. */
  function repro(ctx, row, problem) {
    /* The recipe has to name the page the figure is actually on. Both levels of the report live at
       their own address, and a Student Wise failure sent someone to the Course Wise page would not
       show the row named two lines below. */
    var page = ctx.level === "student" ? SIDE[ctx.side].studentPage : SIDE[ctx.side].page;
    var s = [
      fill("fv_r_open", { url: root(ctx.base) + page }),
      fill("fv_r_who", { org: ctx.orgText, prog: ctx.progText }),
      fill("fv_r_what", { sess: ctx.sessText, branch: ctx.branchText }),
      fill("fv_r_tt", { tt: ctx.transferText }),
      fill("fv_r_period", { from: ctx.dateFrom, to: ctx.dateTo, zero: T(ctx.showZero ? "fv_on" : "fv_off") }),
      T("fv_r_calc")
    ];
    if (row) {
      // on the student level the row is a person first; the course alone would not find it
      if (row.who) s.push(fill("fv_r_student", { who: row.who }));
      s.push(fill("fv_r_row", { row: row.course + (row.session ? " (Session " + row.session + ")" : "") }));
      s.push(fill("fv_r_screen", { total: row.total, pct: row.pct, base: row.baseCut, svc: row.svc }));
    } else {
      s.push(T("fv_r_sum"));
    }
    s.push(fill("fv_r_wrong", { problem: problem }));
    return s;
  }
  A.frCore = {
    SIDE: SIDE, TRANSFER: TRANSFER,
    api: api, programs: programs, sessions: sessions, branches: branches,
    courseWise: courseWise, studentWise: studentWise, checkRows: checkRows, r2: r2, repro: repro,
    armReferer: armReferer, disarmReferer: disarmReferer
  };
})();
