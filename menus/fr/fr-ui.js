/* Shared UI for the two Franchise Calculation menus.
 *
 * Both menus ask the same questions of opposite sides of the same report, so one builder serves both
 * and each menu is a thin wrapper that names its side. Read-only: it asks UMS for reports and checks
 * the arithmetic. Nothing is created, changed or deleted. */
(function () {
  "use strict";
  var A = self.APP || (self.APP = {});
  var $ = function (id) { return document.getElementById(id); };
  var t = function (k) { return (A.t ? A.t(k) : k); };
  var esc = function (s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  };

  var ORGS = [[1, "UDVASH"], [2, "UNMESH"], [3, "OSL"], [11, "Shikkha Poribar"],
              [12, "UTTORON"], [13, "ONLINE CARE"], [14, "UTKORSHO"]];

  function ymd(d) {
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  /* One mounted panel per side. The side name prefixes every element id, so the two panels can live
     in the same document without colliding. */
  function mount(side, rootId) {
    var root = $(rootId);
    if (!root || root.dataset.built) return null;
    root.dataset.built = "1";
    var p = side;
    var C = A.frCore;
    var results = [];
    /* The Referer rule is ONE shared session rule, so only one flow may hold it at a time: a
       dropdown reload firing mid-run would disarm the rule under the running check and every
       remaining request would come back 302. */
    var busy = false;

    var today = new Date(), from = new Date();
    from.setMonth(from.getMonth() - 12);

    root.innerHTML =
      '<div style="display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end">' +
        '<label class="fvl">' + esc(t("fv_base")) + '<input id="' + p + 'Base" spellcheck="false" placeholder="https://ums-3.osl.team/"></label>' +
        '<label class="fvl">' + esc(t("fv_org")) + '<select id="' + p + 'Org">' +
          ORGS.map(function (o) { return '<option value="' + o[0] + '">' + esc(o[1]) + '</option>'; }).join("") +
        '</select></label>' +
        '<label class="fvl">' + esc(t("fv_prog")) + '<select id="' + p + 'Prog"></select></label>' +
        '<label class="fvl">' + esc(t("fv_sess")) + '<select id="' + p + 'Sess"></select></label>' +
        '<label class="fvl">' + esc(t("fv_branch")) + '<select id="' + p + 'Branch"></select></label>' +
        '<label class="fvl">' + esc(t("fv_from")) + '<input type="date" id="' + p + 'From" value="' + ymd(from) + '"></label>' +
        '<label class="fvl">' + esc(t("fv_to")) + '<input type="date" id="' + p + 'To" value="' + ymd(today) + '"></label>' +
        '<button class="btn" id="' + p + 'Run" style="height:var(--ctl-h)">' + esc(t("fv_run")) + '</button>' +
        '<button class="btn" id="' + p + 'Export" style="height:var(--ctl-h);margin-left:auto" disabled>' + esc(t("fv_export")) + '</button>' +
      '</div>' +
      '<div class="mut" id="' + p + 'Note" style="margin-top:10px;font-size:12.5px"></div>' +
      '<div id="' + p + 'Out" style="margin-top:10px"></div>';

    function note(s) { var n = $(p + "Note"); if (n) n.textContent = s; }
    function base() { return ($(p + "Base").value || "").trim(); }
    function fill(sel, list) {
      var e = $(p + sel);
      if (!e) return;
      e.innerHTML = (list || []).map(function (x) {
        return '<option value="' + esc(x.Value) + '">' + esc(x.Text) + '</option>';
      }).join("");
    }

    async function loadSess() {
      if (busy) return;
      busy = true;
      try {
        await C.armReferer(base(), side);
        fill("Sess", await C.sessions(base(), $(p + "Org").value, $(p + "Prog").value));
        fill("Branch", await C.branches(base(), side, $(p + "Org").value, $(p + "Prog").value));
        note("");
      } catch (e) {
        note(e.message === "login" ? t("fv_login") : t("fv_err") + " — " + e.message);
      } finally { await C.disarmReferer(); busy = false; }
    }

    async function loadProgs() {
      if (busy) return;
      if (!base()) { note(t("fv_needbase")); return; }
      busy = true;
      try {
        note(t("fv_loading"));
        await C.armReferer(base(), side);
        fill("Prog", await C.programs(base(), $(p + "Org").value));
        await C.disarmReferer();
        busy = false;
        await loadSess();
      } catch (e) {
        note(e.message === "login" ? t("fv_login") : t("fv_err") + " — " + e.message);
        await C.disarmReferer();
        busy = false;
      }
    }

    async function run() {
      if (busy) return;
      busy = true;
      var btn = $(p + "Run");
      btn.disabled = true;
      results = [];
      $(p + "Out").innerHTML = "";
      $(p + "Export").disabled = true;
      try {
        await C.armReferer(base(), side);
        var f = {
          orgId: $(p + "Org").value, progId: $(p + "Prog").value, sessionId: $(p + "Sess").value,
          branchId: $(p + "Branch").value, dateFrom: $(p + "From").value, dateTo: $(p + "To").value,
          showZero: true
        };
        for (var i = 0; i < C.TRANSFER.length; i++) {
          var tr = C.TRANSFER[i];
          note(t("fv_checking") + " — " + tr.t);
          var rows = await C.courseWise(base(), side, Object.assign({ transferType: tr.v }, f));
          results.push({ transfer: tr, res: C.checkRows(rows, side, tr.v) });
          render();
        }
        note(t("fv_done"));
        $(p + "Export").disabled = !results.length;
      } catch (e) {
        note(e.message === "login" ? t("fv_login") : t("fv_err") + " — " + e.message);
      } finally {
        await C.disarmReferer();
        btn.disabled = false;
        busy = false;
      }
    }

    function render() {
      var h = "";
      results.forEach(function (g) {
        var r = g.res;
        var broken = r.rows.filter(function (x) { return x.fails.length; });
        var moved = r.rows.filter(function (x) { return Math.abs(x.drift) > 0.01; });
        var ok = !broken.length && r.reportDrift === 0;
        h += '<div class="fngrp"><div class="fnghead">' + esc(g.transfer.t) +
          ' <span class="mut">(' + r.rows.length + ')</span>' +
          (ok ? ' <span class="fnpill ok">✓</span>'
              : ' <span class="fnpill bad">✗ ' + (broken.length || 1) + '</span>') + '</div>';
        if (!r.rows.length) {
          h += '<div class="mut" style="padding:8px 12px">' + esc(t("fv_norows")) + '</div>';
        }
        broken.forEach(function (x) {
          h += '<div class="fnrow f"><span class="fnst">✗</span>' +
               '<span class="fnlk">' + esc(x.course) + '</span>' +
               '<span class="fnwhy">' + esc(x.fails.join(" · ")) + '</span></div>';
        });
        if (r.apportions) {
          if (r.reportDrift !== 0) {
            h += '<div class="fnrow f"><span class="fnst">✗</span>' +
                 '<span class="fnlk">' + esc(t("fv_balance")) + '</span>' +
                 '<span class="fnwhy">' + esc(t("fv_balance_off")) + " " + r.reportDrift + '</span></div>';
          } else {
            h += '<div class="fnrow p"><span class="fnst">✓</span>' +
                 '<span class="fnlk">' + esc(t("fv_balance")) + '</span>' +
                 '<span class="fnwarn">' + esc(t("fv_moved").replace("{n}", moved.length)) + '</span></div>';
          }
        }
        h += '</div>';
      });
      $(p + "Out").innerHTML = h;
    }

    async function exportXlsx() {
      if (!results.length || !A.buildBook) return;
      var header = ["Transfer Type", "Course", "Session", "Total", "Base %", "Base Cut", "Service", "Movement", "Problem"];
      var mat = [], colors = [];
      results.forEach(function (g) {
        g.res.rows.forEach(function (x) {
          mat.push([g.transfer.t, x.course, x.session, x.total, x.pct, x.baseCut, x.svc, x.drift, x.fails.join(" · ")]);
          colors.push(x.fails.length ? "r" : (Math.abs(x.drift) > 0.01 ? "y" : "g"));
        });
      });
      try {
        var bytes = await A.buildBook([{
          name: side === "fr" ? "Franchisor" : "Franchisee",
          header: header, mat: mat, colors: colors
        }]);
        var a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([bytes], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }));
        a.download = (side === "fr" ? "Franchisor" : "Franchisee") + " Check - " +
          new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-") + ".xlsx";
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      } catch (e) { note(t("fv_err") + " — " + e.message); }
    }

    $(p + "Org").addEventListener("change", loadProgs);
    $(p + "Prog").addEventListener("change", loadSess);
    $(p + "Run").addEventListener("click", run);
    $(p + "Export").addEventListener("click", exportXlsx);
    $(p + "Base").addEventListener("change", loadProgs);

    return {
      loadProgs: loadProgs,
      setBase: function (v) { if (v && !$(p + "Base").value) $(p + "Base").value = v; }
    };
  }

  A.frUi = { mount: mount };
})();
