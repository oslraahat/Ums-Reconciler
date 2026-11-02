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
  /* fill(sel, list) in the panel below fills a DROPDOWN. This fills slots in a sentence, which is a
     different job with the same obvious name, so it gets a name that cannot be mistaken for it. */
  var msg = function (k, vals) {
    return String(t(k)).replace(/{(w+)}/g, function (m, slot) {
      return vals && vals[slot] != null ? String(vals[slot]) : m;
    });
  };
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
  /* Stop is one button for whichever of the two is in flight; both loops test it between requests. */
  var stopFlag = false;

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
        /* The buttons sit at the right-hand end of the filter row, not on a row of their own. They
           are ONE flex item, so they stay together and never split across a wrap — which is what
           went wrong when each button was its own item in this row: Run came to rest after whichever
           filter landed last and Export shot to the right edge of whatever row it fell into. */
      '<div class="fvact">' +
        '<button class="btn" id="' + p + 'Run" style="height:var(--ctl-h)">' + esc(t("fv_run")) + '</button>' +
        /* Six passes over an empty filter report nothing six times, which is what "No rows for this
           filter" × 6 means and does not say where the data IS. Scan answers that instead of asking
           the person to guess their way through every session and branch by hand. */
        '<button class="btn" id="' + p + 'Scan" style="height:var(--ctl-h)">' + esc(t("fv_scan")) + '</button>' +
        '<button class="btn" id="' + p + 'Stop" style="height:var(--ctl-h);display:none">' + esc(t("fv_stop")) + '</button>' +
        '<button class="btn" id="' + p + 'Export" style="height:var(--ctl-h)" disabled>' + esc(t("fv_export")) + '</button>' +
        '</div>' +        // the button group
      '</div>' +          // the filter row that holds it
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
      stopFlag = false;
      var btn = $(p + "Run");
      btn.disabled = true;
      $(p + "Scan").disabled = true;
      $(p + "Stop").style.display = "";
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
        for (var L = 0; L < LEVELS.length && !stopFlag; L++) {
          var lv = LEVELS[L];
          if (!(await C.armReferer(base(), side, lv.k))) { note(t("fv_noref")); return; }
          for (var i = 0; i < C.TRANSFER.length && !stopFlag; i++) {
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
        note(stopFlag ? t("fv_stopped") : t("fv_done"));
        $(p + "Export").disabled = !results.length;
      } catch (e) {
        note(e.message === "login" ? t("fv_login") : t("fv_err") + " — " + e.message);
      } finally {
        await C.disarmReferer();
        btn.disabled = false;
        $(p + "Scan").disabled = false;
        $(p + "Stop").style.display = "none";
        busy = false;
        running = false;
      }
    }

    /* Where is there anything to check?
     *
     * Running the six passes over a filter with no data reports nothing six times. The filters that
     * DO have rows are findable, because the report itself will say so: walk every session × branch
     * the dropdowns offer, ask for each transfer type at the course level, and keep the ones that
     * come back with rows. Read-only, and it reuses the report endpoint already in hand — no new
     * surface, nothing created.
     *
     * Stoppable, because sessions × branches × 3 is a few hundred requests on a wide program, and
     * the answer is usually in the first few. */
    function optsOf(sel) {
      var e = $(p + sel), out = [];
      if (!e) return out;
      for (var i = 0; i < e.options.length; i++) {
        if (e.options[i].value) out.push({ v: e.options[i].value, t: e.options[i].text });
      }
      return out;
    }
    async function scan() {
      if (busy) return;
      if (!base()) { note(t("fv_needbase")); return; }
      var sessions = optsOf("Sess"), branches = optsOf("Branch");
      if (!sessions.length || !branches.length) { note(t("fv_scan_need")); return; }
      busy = true;
      running = true;
      stopFlag = false;
      $(p + "Run").disabled = true;
      $(p + "Scan").disabled = true;
      $(p + "Stop").style.display = "";
      $(p + "Out").innerHTML = "";
      var hits = [], done = 0, total = sessions.length * branches.length * C.TRANSFER.length;
      try {
        if (!(await C.armReferer(base(), side, "course"))) { note(t("fv_noref")); return; }
        var f = {
          orgId: $(p + "Org").value, progId: $(p + "Prog").value,
          dateFrom: $(p + "From").value, dateTo: $(p + "To").value, showZero: true
        };
        for (var s = 0; s < sessions.length && !stopFlag; s++) {
          for (var b = 0; b < branches.length && !stopFlag; b++) {
            for (var i = 0; i < C.TRANSFER.length && !stopFlag; i++) {
              var tr = C.TRANSFER[i];
              note(msg("fv_scan_at", { done: done, total: total, found: hits.length }));
              var rows = [];
              /* One dead combination must not end the scan — a session a branch never ran, or a
                 branch the report refuses for this program, is exactly what we are looking for the
                 absence of. Record nothing and carry on. */
              try {
                rows = await C.courseWise(base(), side, Object.assign({
                  sessionId: sessions[s].v, branchId: branches[b].v, transferType: tr.v
                }, f));
              } catch (e) {
                if (e.message === "login") throw e;
              }
              done++;
              if (rows.length) {
                hits.push({ sess: sessions[s], branch: branches[b], tr: tr, n: rows.length });
                renderScan(hits);
              }
            }
          }
        }
        note(stopFlag ? t("fv_stopped") : msg("fv_scan_done", { found: hits.length, total: total }));
        if (!hits.length) renderScan(hits);
      } catch (e) {
        note(e.message === "login" ? t("fv_login") : t("fv_err") + " — " + e.message);
      } finally {
        await C.disarmReferer();
        $(p + "Run").disabled = false;
        $(p + "Scan").disabled = false;
        $(p + "Stop").style.display = "none";
        busy = false;
        running = false;
      }
    }
    function renderScan(hits) {
      if (!hits.length) {
        $(p + "Out").innerHTML = '<div class="mut" style="padding:8px 12px">' + esc(t("fv_scan_none")) + '</div>';
        return;
      }
      /* Grouped by transfer type, because testing "transfer type onusare" is what the list is for:
         under each type, the session and branch to set the filters to. */
      var h = "";
      C.TRANSFER.forEach(function (tr) {
        var mine = hits.filter(function (x) { return x.tr.v === tr.v; });
        if (!mine.length) return;
        h += '<div class="fngrp"><div class="fnghead">' + esc(tr.t) +
          ' <span class="mut">(' + mine.length + ')</span></div>';
        mine.forEach(function (x) {
          h += '<div class="fnrow p"><span class="fnst">✓</span>' +
               '<span class="fvname">' + esc(x.sess.t + " · " + x.branch.t) + '</span>' +
               '<span class="fnwarn">' + esc(msg("fv_scan_hit", { n: x.n })) + '</span></div>';
        });
        h += '</div>';
      });
      // and name the types with nothing anywhere, since that is the gap data creation has to fill
      var empty = C.TRANSFER.filter(function (tr) {
        return !hits.some(function (x) { return x.tr.v === tr.v; });
      });
      if (empty.length) {
        h += '<div class="fngrp"><div class="fnghead">' + esc(t("fv_scan_gap")) + '</div>' +
          empty.map(function (tr) {
            return '<div class="fnrow f"><span class="fnst">✗</span>' +
                   '<span class="fvname">' + esc(tr.t) + '</span>' +
                   '<span class="fnwhy">' + esc(t("fv_scan_gapwhy")) + '</span></div>';
          }).join("") + '</div>';
      }
      $(p + "Out").innerHTML = h;
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
        /* With nothing in the report there is nothing to balance, and saying "Balances · value moved
           between 0 rows" is a pass claimed over no evidence — which is worse than silence, because
           it reads as "checked, fine". The "no rows" line above has already said everything true
           about an empty filter. */
        if (r.apportions && r.rows.length) {
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
    $(p + "Scan").addEventListener("click", scan);
    /* Stop only raises the flag. The loop that owns the request decides where it is safe to stop,
       and the finally that disarms the shared Referer rule still runs. */
    $(p + "Stop").addEventListener("click", function () { stopFlag = true; note(t("fv_stopping")); });
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
