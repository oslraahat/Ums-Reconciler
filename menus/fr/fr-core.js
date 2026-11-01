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
          student: "StudentWiseDataTable", summary: "SummaryReportDataTable",
          page: "Student/FranchisorCalculation/CourseWise" },
    fe: { base: "Student/FranchiseeCalculation/", course: "CourseWiseCalculationData",
          student: "StudentWiseCalculationData", summary: "SummaryReportData",
          page: "Student/FranchiseeCalculation/CourseWiseCalculation" }
  };
  var TRANSFER = [
    { v: 30, t: "Non-Transfer" },
    { v: 10, t: "Franchisee → All" },
    { v: 20, t: "Franchisor → Franchisee" }
  ];

  function root(base) { return String(base || "").replace(/\/+$/, "") + "/"; }

  /* These endpoints answer 302 unless the Referer is their OWN page, and a page cannot set Referer
     on fetch. New Admission already solved this with a declarativeNetRequest session rule; the same
     shape is reused here under a different id. excludedInitiatorDomains is the crucial part: without
     it the rewrite would also hit the AJAX the user's own UMS tabs make, which quietly broke
     dropdowns across the UMS last time it was too broad. Our calls are initiated by the extension
     page, so they still get the header. Always disarmed again by the caller. */
  var RULE_ID = 8802;
  async function armReferer(base, side) {
    var b = root(base), host;
    try { host = new URL(b).hostname; } catch (e) { return false; }
    var reg = host.split(".").slice(-2).join(".");
    try {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [RULE_ID],
        addRules: [{
          id: RULE_ID, priority: 1,
          action: { type: "modifyHeaders", requestHeaders: [
            { header: "referer", operation: "set", value: b + SIDE[side].page },
            { header: "origin", operation: "set", value: b.slice(0, -1) }
          ] },
          condition: { requestDomains: [host], resourceTypes: ["xmlhttprequest"], excludedInitiatorDomains: [reg] }
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
  function normalise(side, j) {
    if (side === "fr") {
      return ((j && j.data) || []).map(function (r) {
        return {
          CourseId: r.CourseId, CourseName: r.CourseName, SessionName: r.SessionName,
          TotalCollection: r.TotalCollection, FranchisorPercent: r.FranchisorPercent,
          BaseCut: r.ReceivableAgainstBasePercent,
          TotalReceivable: r.FranchisorTotalReceivable,
          FranchisorService: (r.FranchisorBranch || {}).ValueOfService || 0,
          collections: [r.SelectedBranch].concat(r.OtherFranchiseeBranches || [], [r.FranchisorBranch])
            .filter(Boolean).map(function (b) { return Number(b.NetCollection) || 0; }),
          services: [r.SelectedBranch].concat(r.OtherFranchiseeBranches || [], [r.FranchisorBranch])
            .filter(Boolean).map(function (b) { return Number(b.ValueOfService) || 0; })
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
    return normalise(side, j);
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
      if (!near(netSum, total)) bad.push("Total Collection " + r2(total) + " ≠ শাখাগুলোর Net-এর যোগফল " + r2(netSum));
      if (!near(total * pct / 100, baseCut)) bad.push("Base% পাওনা " + r2(baseCut) + " ≠ Total × " + pct + "% = " + r2(total * pct / 100));
      if (side === "fr" && row.TotalReceivable != null) {
        var want = baseCut + (Number(row.FranchisorService) || 0);
        if (!near(want, row.TotalReceivable))
          bad.push("Total Receivable " + r2(row.TotalReceivable) + " ≠ Base% + Franchisor-এর Value of Service " + r2(want));
      }

      out.push({
        course: row.CourseName || ("#" + row.CourseId), session: row.SessionName || "",
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
  A.frCore = {
    SIDE: SIDE, TRANSFER: TRANSFER,
    api: api, programs: programs, sessions: sessions, branches: branches,
    courseWise: courseWise, checkRows: checkRows, r2: r2,
    armReferer: armReferer, disarmReferer: disarmReferer
  };
})();
