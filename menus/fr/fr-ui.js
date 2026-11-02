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

  /* The Referer rule is ONE shared session rule, so only one flow may hold it at a time — and that
     is true ACROSS the two panels, not just within one. Navigating Franchisor→Franchisee mid-run
     calls the other panel's loader, which would rewrite the Referer to the other page and then tear
     the rule out from under the running check. Hence module scope, shared by both mounts. */
  var busy = false;

  /* busy says the Referer rule is held — by a check OR by a dropdown loader. running says a CHECK
     is in flight, which is the only thing a language switch must not interrupt.
     They were one flag, and that stranded the panel's language: onShow() fires loadProgs(), which
     takes busy immediately, and a page restored on load reached applyLang() while that fetch was
     still open. relang() asked isRunning(), got busy, and refused — so a panel mounted in the
     default language before the stored one was read kept Bengali for good. "page refresh korle bn
     hoye jay." A loader is safe to remount over: the element ids do not change, so the fetch that
     is already open fills the dropdowns of whichever panel is mounted when it lands. */
  var running = false;

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


    var today = new Date(), from = new Date();
    from.setMonth(from.getMonth() - 12);

    root.innerHTML =
      '<div class="fvrow">' +
        '<label class="fvl">' + esc(t("fv_base")) + '<input id="' + p + 'Base" spellcheck="false" placeholder="https://ums-3.osl.team/"></label>' +
        '<label class="fvl">' + esc(t("fv_org")) + '<select id="' + p + 'Org">' +
          ORGS.map(function (o) { return '<option value="' + o[0] + '">' + esc(o[1]) + '</option>'; }).join("") +
        '</select></label>' +
        '<label class="fvl">' + esc(t("fv_prog")) + '<select id="' + p + 'Prog"></select></label>' +
        '<label class="fvl">' + esc(t("fv_sess")) + '<select id="' + p + 'Sess"></select></label>' +
        '<label class="fvl">' + esc(t("fv_branch")) + '<select id="' + p + 'Branch"></select></label>' +
        '<label class="fvl">' + esc(t("fv_from")) + '<input type="date" id="' + p + 'From" value="' + ymd(from) + '"></label>' +
        '<label class="fvl">' + esc(t("fv_to")) + '<input type="date" id="' + p + 'To" value="' + ymd(today) + '"></label>' +
      '</div>' +
      '<div class="fvact">' +
        '<button class="btn" id="' + p + 'Run" style="height:var(--ctl-h)">' + esc(t("fv_run")) + '</button>' +
        '<button class="btn" id="' + p + 'Export" style="height:var(--ctl-h)" disabled>' + esc(t("fv_export")) + '</button>' +
      '</div>' +
      '<div class="mut" id="' + p + 'Note" style="margin-top:10px;font-size:12.5px"></div>' +
      '<div id="' + p + 'Out" style="margin-top:10px"></div>';

    /* the dropdown's own wording — a recipe saying "Program = 68" would help nobody */
    function selText(sel) {
      var e = $(p + sel);
      if (!e || e.selectedIndex < 0) return "";
      var o = e.options[e.selectedIndex];
      return (o ? o.text : "") + (e.value ? " (" + e.value + ")" : "");
    }
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
        if (!(await C.armReferer(base(), side))) { note(t("fv_noref")); return; }
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
        if (!(await C.armReferer(base(), side))) { note(t("fv_noref")); return; }
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
      if (!base()) { note(t("fv_needbase")); return; }
      busy = true;
      running = true;
      var btn = $(p + "Run");
      btn.disabled = true;
      results = [];
      $(p + "Out").innerHTML = "";
      $(p + "Export").disabled = true;
      try {
        var f = {
          orgId: $(p + "Org").value, progId: $(p + "Prog").value, sessionId: $(p + "Sess").value,
          branchId: $(p + "Branch").value, dateFrom: $(p + "From").value, dateTo: $(p + "To").value,
          showZero: true
        };
        var ctx = {
          base: base(), side: side,
          orgText: selText("Org"), progText: selText("Prog"),
          sessText: selText("Sess"), branchText: selText("Branch"),
          dateFrom: f.dateFrom, dateTo: f.dateTo, showZero: f.showZero
        };
        /* Both levels of the report, three transfer types each — six passes in one Run. The engine
           has had studentWise since 14.79 and only a script ever called it; the menu ran Course Wise
           alone, so the Student Wise cases could not be answered from here at all.

           The Referer is re-armed per level, not once for the whole Run: each level's controller
           checks the Referer against ITS OWN page, so a student request sent under the Course Wise
           Referer is refused. */
        var LEVELS = [
          { k: "course", label: t("fv_lv_course"), fetch: C.courseWise },
          { k: "student", label: t("fv_lv_student"), fetch: C.studentWise }
        ];
        for (var L = 0; L < LEVELS.length; L++) {
          var lv = LEVELS[L];
          if (!(await C.armReferer(base(), side, lv.k))) { note(t("fv_noref")); return; }
          for (var i = 0; i < C.TRANSFER.length; i++) {
            var tr = C.TRANSFER[i];
            note(t("fv_checking") + " — " + lv.label + " · " + tr.t);
            var rows = await lv.fetch(base(), side, Object.assign({ transferType: tr.v }, f));
            var res = C.checkRows(rows, side, tr.v);
            var rctx = Object.assign({ transferText: tr.t, level: lv.k }, ctx);
            res.rows.forEach(function (x) {
              if (x.fails.length) x.repro = C.repro(rctx, x, x.fails.join("  ·  "));
            });
            if (res.apportions && Math.abs(res.reportDrift) > 0.01) {
              res.balanceRepro = C.repro(rctx, null, t("fv_balance_off") + " " + res.reportDrift);
            }
            results.push({ level: lv.k, levelLabel: lv.label, transfer: tr, res: res });
            render();
          }
          await C.disarmReferer();
        }
        note(t("fv_done"));
        $(p + "Export").disabled = !results.length;
      } catch (e) {
        note(e.message === "login" ? t("fv_login") : t("fv_err") + " — " + e.message);
      } finally {
        await C.disarmReferer();
        btn.disabled = false;
        busy = false;
        running = false;
      }
    }

    /* the recipe, numbered so it can be followed by hand or pasted into a bug report */
    function steps(list) {
      if (!list || !list.length) return "";
      return '<div class="fvsteps"><div class="fvsteph">' + esc(t("fv_repro_h")) + '</div><ol>' +
        list.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join("") + '</ol></div>';
    }
    function render() {
      var h = "";
      results.forEach(function (g) {
        var r = g.res;
        var broken = r.rows.filter(function (x) { return x.fails.length; });
        var moved = r.rows.filter(function (x) { return Math.abs(x.drift) > 0.01; });
        var ok = !broken.length && Math.abs(r.reportDrift) <= 0.01;
        h += '<div class="fngrp"><div class="fnghead">' + esc(g.levelLabel + " · " + g.transfer.t) +
          ' <span class="mut">(' + r.rows.length + ')</span>' +
          (ok ? ' <span class="fnpill ok">✓</span>'
              : ' <span class="fnpill bad">✗ ' + (broken.length ? broken.length : t("fv_balance")) + '</span>') + '</div>';
        if (!r.rows.length) {
          h += '<div class="mut" style="padding:8px 12px">' + esc(t("fv_norows")) + '</div>';
        }
        broken.forEach(function (x) {
          // a student row is a person first: the course alone does not say which of 800 rows it is
          h += '<div class="fnrow f"><span class="fnst">✗</span>' +
               '<span class="fvname">' + esc(x.who ? x.who + " · " + x.course : x.course) + '</span>' +
               '<span class="fnwhy">' + esc(x.fails.join(" · ")) + '</span>' +
               steps(x.repro) + '</div>';
        });
        if (r.apportions) {
          if (Math.abs(r.reportDrift) > 0.01) {
            h += '<div class="fnrow f"><span class="fnst">✗</span>' +
                 '<span class="fvname">' + esc(t("fv_balance")) + '</span>' +
                 '<span class="fnwhy">' + esc(t("fv_balance_off")) + " " + r.reportDrift + '</span>' +
                 steps(r.balanceRepro) + '</div>';
          } else {
            h += '<div class="fnrow p"><span class="fnst">✓</span>' +
                 '<span class="fvname">' + esc(t("fv_balance")) + '</span>' +
                 '<span class="fnwarn">' + esc(t("fv_moved").replace("{n}", moved.length)) + '</span></div>';
          }
        }
        h += '</div>';
      });
      $(p + "Out").innerHTML = h;
    }

    async function exportXlsx() {
      if (!results.length || !A.buildBook) return;
      // the sheet's own column names, so an export made in Bangla reads in Bangla
      var header = ["fv_c_tt", "fv_c_who", "fv_c_course", "fv_c_sess", "fv_c_total", "fv_c_pct",
                    "fv_c_base", "fv_c_svc", "fv_c_move", "fv_c_prob", "fv_repro_h"].map(t);
      /* A sheet per level rather than one sheet with a Level column: the two levels are different
         counts of different things — a course row and one of 800 student rows do not sort or total
         together, and reading them in one grid was the first thing that went wrong on paper. */
      var who = side === "fr" ? "Franchisor" : "Franchisee";
      var tabs = [];
      ["course", "student"].forEach(function (k) {
        var mat = [], colors = [];
        results.filter(function (g) { return g.level === k; }).forEach(function (g) {
          g.res.rows.forEach(function (x) {
            mat.push([g.transfer.t, x.who || "", x.course, x.session, x.total, x.pct, x.baseCut,
              x.svc, x.drift, x.fails.join(" · "),
              (x.repro || []).map(function (s, n) { return (n + 1) + ". " + s; }).join("\n")]);
            colors.push(x.fails.length ? "r" : (Math.abs(x.drift) > 0.01 ? "y" : "g"));
          });
        });
        if (mat.length) {
          tabs.push({ name: who + " " + (k === "course" ? "Course" : "Student"),
            header: header, mat: mat, colors: colors });
        }
      });
      if (!tabs.length) return;
      try {
        var bytes = await A.buildBook(tabs);
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
      isRunning: function () { return running; },
      isLoading: function () { return busy; },
      loadProgs: loadProgs,
      setBase: function (v) { if (v && !$(p + "Base").value) $(p + "Base").value = v; }
    };
  }

  A.frUi = { mount: mount };
})();
