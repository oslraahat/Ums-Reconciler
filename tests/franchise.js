/* Franchise check — the panel and its verdicts.
 *
 *   node tests/franchise.js
 *
 * Render the new panel in a fake DOM and assert it actually works:
   every label resolves through t(), the controls exist, and the result renderer produces
   the right verdicts. Catches the class of bug where a panel silently shows raw key names. */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");

// ---- a DOM small enough to be honest about what it stands in for ----
function makeEl(tag) {
  return {
    tagName: (tag || "div").toUpperCase(), children: [], dataset: {}, style: {}, value: "",
    _html: "", disabled: false, _listeners: {},
    set innerHTML(v) { this._html = String(v); }, get innerHTML() { return this._html; },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener(k, f) { (this._listeners[k] = this._listeners[k] || []).push(f); },
    querySelector() { return null; }, classList: { toggle() {}, add() {}, remove() {} }
  };
}
const els = {};
global.document = {
  getElementById: (id) => els[id] || (els[id] = makeEl("div")),
  createElement: makeEl, body: makeEl("body")
};

// ---- the real dictionary from app.js, so a missing key shows up as a missing key ----
const app = fs.readFileSync(ROOT + "/app.js", "utf8");
const dictStart = app.indexOf("const DICT = {") >= 0 ? app.indexOf("const DICT = {") : app.indexOf("DICT = {");
const open = app.indexOf("{", dictStart);
let depth = 0, end = open;
for (let i = open; i < app.length; i++) {
  if (app[i] === "{") depth++;
  else if (app[i] === "}") { depth--; if (!depth) { end = i; break; } }
}
const DICT = eval("(" + app.slice(open, end + 1) + ")");

const self = { APP: {} };
self.APP.t = (k) => (DICT[k] && DICT[k].bn !== undefined ? DICT[k].bn : "!!MISSING:" + k);
self.APP.buildBook = async () => new Uint8Array([1, 2, 3]);   // stands in for the real writer
global.self = self;

new Function("self", fs.readFileSync(ROOT + "/menus/fr/fr-core.js", "utf8"))(self);
new Function("self", fs.readFileSync(ROOT + "/menus/fr/fr-ui.js", "utf8"))(self);

let fail = 0;
/* Checks that have to wait for something — a debounce, a storage round trip — are parked here and
   awaited before the summary, so the exit code still accounts for them. */
const later = [];
const check = (name, ok, extra) => { if (!ok) fail++; console.log((ok ? "PASS  " : "FAIL  ") + name + (!ok && extra !== undefined ? "   " + extra : "")); };

// ---- mount ----
const panel = self.APP.frUi.mount("fr", "frBox");
const html = els.frBox.innerHTML;

check("the panel mounts and returns its handle", !!panel);
check("no label fell back to a raw key", html.indexOf("!!MISSING:") < 0,
  (html.match(/!!MISSING:[a-z_]+/g) || []).join(", "));
["frBase", "frOrg", "frProg", "frSess", "frBranch", "frFrom", "frTo",
 "frRun", "frScan", "frStop", "frExport", "frNote", "frOut"]
  .forEach(id => check("control " + id + " is in the markup", html.indexOf('id="' + id + '"') >= 0));
check("the two sides cannot collide on ids", self.APP.frUi.mount("fe", "feBox") !== null
  && els.feBox.innerHTML.indexOf('id="feBase"') >= 0);
check("Export starts disabled", html.indexOf("disabled") >= 0);
check("the organisation list is rendered", html.indexOf("UDVASH") >= 0);

// ---- the verdict logic, which is what the panel actually shows ----
const C = self.APP.frCore;
const row = (total, pct, base, cols, svcs) => ({
  CourseName: "X", SessionName: "2026", TotalCollection: total, FranchisorPercent: pct,
  BaseCut: base, TotalReceivable: base + (svcs ? svcs[svcs.length - 1] : 0),
  FranchisorService: svcs ? svcs[svcs.length - 1] : 0, collections: cols, services: svcs
});
let r = C.checkRows([row(100, 50, 50, [60, 40], [30, 20])], "fr", 10);
check("a clean row passes", r.rows[0].fails.length === 0 && r.reportDrift === 0, JSON.stringify(r.rows[0].fails));

r = C.checkRows([row(100, 50, 50, [60, 50], [30, 20])], "fr", 10);
check("a wrong Total Collection is caught", r.rows[0].fails.length === 1, JSON.stringify(r.rows[0].fails));

r = C.checkRows([row(100, 50, 40, [60, 40], [30, 30])], "fr", 10);
check("a wrong Base% cut is caught", r.rows[0].fails.some(f => f.indexOf("Base%") >= 0), JSON.stringify(r.rows[0].fails));

r = C.checkRows([row(100, 50, 50, [60, 40], [0, 0])], "fr", 30);
check("Non-Transfer does not demand a service split", r.reportDrift === 0 && r.apportions === false);

r = C.checkRows([row(100, 50, 50, [60, 40], [0, 0])], "fr", 10);
check("but a transfer type with no service IS flagged", r.reportDrift !== 0, "drift=" + r.reportDrift);

r = C.checkRows([row(100, 0, 0, [100], [60])], "fe", 10);
check("rule 3 is not applied to the Franchisee side", r.rows[0].fails.length === 0, JSON.stringify(r.rows[0].fails));

/* classes = 0. Running Student Wise live against ums-3 on 14.79, this was the entire finding: 802
   student rows, not one per-row rule broken, yet 3 of 9 branch/transfer combinations failed the
   report balance — each tracing to one row with no classes, whose remainder after the base cut has
   no owner. Per-row drift is normally movement between courses; with no classes there is nowhere
   for it to have moved, so this one is named rather than excused. */
{
  // pct has to agree with base, or rule 2 fires and the fixture tests the wrong thing
  const noClass = (total, base, counts) => ({
    CourseName: "X", SessionName: "2026", TotalCollection: total,
    FranchisorPercent: total ? (base / total) * 100 : 0,
    BaseCut: base, TotalReceivable: base, FranchisorService: 0,
    StudentName: "Rumon tta", RegistrationNo: "5574286", TotalService: counts.reduce((a, b) => a + b, 0),
    collections: [total], services: [0], serviceCounts: counts
  });
  let z = C.checkRows([noClass(400, 0, [0])], "fr", 10).rows[0];
  check("a row with no classes and money left over is named",
    z.fails.some(f => f.indexOf("400") >= 0), JSON.stringify(z.fails));

  z = C.checkRows([noClass(400, 0, [0])], "fr", 30).rows[0];
  check("but not under Non-Transfer, which apportions nothing",
    !z.fails.length, JSON.stringify(z.fails));

  z = C.checkRows([noClass(400, 400, [0])], "fr", 10).rows[0];
  check("nor when the base cut took everything, leaving nothing unowned",
    !z.fails.length, JSON.stringify(z.fails));

  z = C.checkRows([noClass(400, 0, [3])], "fr", 10).rows[0];
  check("nor when a class exists for the value to have moved to",
    !z.fails.some(f => f.indexOf("Class/Exam = 0") >= 0), JSON.stringify(z.fails));

  // and a student failure must send someone to the Student Wise page, naming the person
  const sctx = {
    base: "https://ums-3.osl.team/", side: "fr", level: "student",
    orgText: "UDVASH (1)", progText: "Engineering Admission Program (68)",
    sessText: "2023 (61)", branchText: "Rajshahi Kadirganj Udvash (89)",
    transferText: "Franchisee → All", dateFrom: "2023-01-01", dateTo: "2026-11-01", showZero: true
  };
  const srow = C.checkRows([noClass(400, 0, [0])], "fr", 10).rows[0];
  const ss = C.repro(sctx, srow, srow.fails.join(" · "));
  check("the student recipe opens the Student Wise page",
    ss[0].indexOf("FranchisorCalculation/StudentWise") > 0, ss[0]);
  check("it names the student and the registration number",
    ss.some(s => s.indexOf("Rumon tta") >= 0 && s.indexOf("5574286") >= 0), ss.join(" | "));
  check("the course recipe still opens the Course Wise page",
    C.repro(Object.assign({}, sctx, { level: "course" }), srow, "x")[0]
      .indexOf("FranchisorCalculation/CourseWise") > 0);
}

/* A failure has to carry the way back to itself, in whichever language the panel is in. A recipe
   that stayed Bangla under EN, or that printed a programme id instead of its name, would be no
   use to the person asked to reproduce the bug. */
{
  const row = C.checkRows([{
    CourseName: "Engineering Full Course", SessionName: "2023",
    TotalCollection: 24000, FranchisorPercent: 50, BaseCut: 12000,
    TotalReceivable: 19200, FranchisorService: 7200,
    collections: [10000, 15000], services: [4800, 7200]
  }], "fr", 10).rows[0];
  check("a wrong Total Collection is reported", row.fails.length === 1, JSON.stringify(row.fails));

  const ctx = {
    base: "https://ums-3.osl.team/", side: "fr",
    orgText: "UDVASH (1)", progText: "Engineering Admission Program (68)",
    sessText: "2023 (61)", branchText: "Rajshahi Kadirganj Udvash (89)",
    transferText: "Franchisee → All", dateFrom: "2023-01-01", dateTo: "2026-11-01", showZero: true
  };
  const steps = C.repro(ctx, row, row.fails.join(" · "));
  check("the recipe has every step", steps.length === 9, steps.length);
  check("it names the page to open", steps[0].indexOf("FranchisorCalculation/CourseWise") > 0);
  check("it spells the filters out, not their ids", steps[1].indexOf("Engineering Admission Program") > 0);
  check("it says which row", steps[6].indexOf("Engineering Full Course") > 0);
  check("it ends with what is wrong", steps[8].indexOf("24000") > 0 && steps[8].indexOf("25000") > 0, steps[8]);
  check("no step leaked an unfilled {slot}", !steps.some(s => /{w+}/.test(s)),
    steps.filter(s => /{w+}/.test(s)).join(" | "));
}

/* The address each panel is pointed at is its own, and it has to survive a refresh.
 *
 * "UMS address refresh or new update er pore ums-5 hoye jay." It was never saved: every mount seeded
 * it from the topbar's #base, and #base falls back to ums-5 whenever it is empty — so a field set to
 * ums-3 came back as ums-5 and the next Run asked the wrong server. Driven here rather than read,
 * because the thing to prove is that the value makes a round trip. */
{
  const store = {};
  const chromeWas = global.chrome;
  global.chrome = {
    storage: { local: {
      set: function (o) { Object.keys(o).forEach(function (k) { store[k] = o[k]; }); },
      get: function (keys, cb) {
        const out = {};
        keys.forEach(function (k) { if (store[k] !== undefined) out[k] = store[k]; });
        cb(out);
      }
    } }
  };

  els.frBox2 = { dataset: {}, innerHTML: "", querySelector: () => null };
  const p2 = self.APP.frUi.mount("fr2", "frBox2");
  check("a panel mounts for the persistence check", !!p2 && !!p2.restoreBase);

  const field = els["fr2Base"];
  check("its address field exists", !!field);
  if (field && p2) {
    // nothing saved yet: the seed is what shows, and it is only used while the field is empty
    p2.setBase("https://ums-5.osl.team");
    check("the first visit takes the seeded address", field.value === "https://ums-5.osl.team");
    p2.setBase("https://ums-9.osl.team");
    check("a seed does not overwrite an address already there", field.value === "https://ums-5.osl.team");

    /* The save is debounced 400ms, so the round trip has to be waited for. Checked for real rather
       than asserted true — a check that cannot fail is worse than no check, because it reads in the
       output exactly like one that passed. */
    later.push((async function () {
      field.value = "https://ums-3.osl.team";
      (((field._listeners || {}).input) || []).forEach(fn => fn.call(field));
      await new Promise(r => setTimeout(r, 500));
      check("the address the person typed is saved", store["fvfr2Base"] === "https://ums-3.osl.team",
        JSON.stringify(store));

      // and a fresh panel, as after a refresh, comes back to it rather than to the seed
      els.frBox3 = { dataset: {}, innerHTML: "", querySelector: () => null };
      const p3 = self.APP.frUi.mount("fr3", "frBox3");
      store["fvfr3Base"] = store["fvfr2Base"];   // the third panel's own key, same saved value
      p3.setBase("https://ums-5.osl.team");
      const back = await p3.restoreBase();
      check("after a refresh the saved address wins over the ums-5 seed",
        back === "https://ums-3.osl.team" && els["fr3Base"].value === "https://ums-3.osl.team",
        back);
      global.chrome = chromeWas;
    })());
  } else {
    global.chrome = chromeWas;
  }
}

/* An empty report must not claim a pass, and Scan must say where the data is.
 *
 * Six passes over a filter with no data reported "No rows for this filter" and then, under it,
 * "Report balance ✓ Balances · value moved between 0 course rows". A pass claimed over no evidence
 * is worse than silence, because it reads as "checked, fine". */
{
  const ui = fs.readFileSync(path.join(__dirname, "..", "menus", "fr", "fr-ui.js"), "utf8");
  check("the balance verdict needs rows to have been seen",
    /if \(r\.apportions && r\.rows\.length\)/.test(ui));

  check("Scan walks the sessions and branches the dropdowns offer",
    /optsOf\("Sess"\)/.test(ui) && /optsOf\("Branch"\)/.test(ui));
  check("Scan covers every transfer type", /C\.TRANSFER\.length && !stopFlag/.test(ui));
  check("Scan is read-only — it asks for the report and nothing else",
    /C\.courseWise\(base\(\), side, Object\.assign\(\{\s*\n?\s*sessionId/.test(ui));
  check("a dead session or branch does not end the scan",
    /catch \(e\) \{\s*\n\s*if \(e\.message === "login"\) throw e;/.test(ui));
  check("Scan names the transfer types with no data anywhere, which is the gap to create",
    /fv_scan_gap/.test(ui) && /!hits\.some/.test(ui));

  check("Stop reaches the check as well as the scan",
    /L < LEVELS\.length && !stopFlag/.test(ui) && /i < C\.TRANSFER\.length && !stopFlag/.test(ui));
  check("Stop only raises a flag, so the Referer rule is still disarmed",
    /stopFlag = true; note\(t\("fv_stopping"\)\)/.test(ui));
  check("stopping is reported as stopped, not as done",
    /note\(stopFlag \? t\("fv_stopped"\) : t\("fv_done"\)\)/.test(ui));
}

/* One Run has to cover both levels, and the Referer has to be re-armed for each.
 *
 * The engine has had studentWise since 14.79 and for two versions only a script ever called it: the
 * menu ran Course Wise alone, so the Student Wise cases could not be answered from the tool at all.
 * Nothing failed, because nothing asked. Checked on the source, since driving six live report
 * fetches is not something a test should do. */
{
  const ui = fs.readFileSync(path.join(__dirname, "..", "menus", "fr", "fr-ui.js"), "utf8");
  check("the Run covers the Course Wise level", /k: "course"[^}]*fetch: C\.courseWise/.test(ui));
  check("the Run covers the Student Wise level", /k: "student"[^}]*fetch: C\.studentWise/.test(ui));
  check("the level is re-armed on the Referer, not assumed",
    /armReferer\(base\(\), side, lv\.k\)/.test(ui));
  check("the level reaches the recipe, so it names the right page",
    /level: lv\.k/.test(ui));
  check("each result remembers which level it came from", /level: lv\.k, levelLabel/.test(ui));
  check("the export splits the two levels into their own sheets",
    /\["course", "student"\]\.forEach/.test(ui) && /g\.level === k/.test(ui));
}

/* The two buttons belong in a row of their own.
 *
 * "ei 2ti menu te btn position thik nai." Seven filters and both buttons shared one wrapping flex
 * row, with margin-left:auto on Export. At any width where the filters wrapped, Run came to rest
 * after whichever filter landed last and Export jumped to the right edge of whatever row it fell
 * into — sometimes the row above Run. Checked on the markup, since the fault is which row each
 * button is in, and a stand-in DOM renders no layout to measure. */
{
  const ui = fs.readFileSync(path.join(__dirname, "..", "menus", "fr", "fr-ui.js"), "utf8");
  const html = ui.slice(ui.indexOf("root.innerHTML ="), ui.indexOf("/* the dropdown's own wording"));
  const iFilters = html.indexOf('class="fvrow"');
  const iAct = html.indexOf('class="fvact"');
  const iRun = html.indexOf("'Run\"");
  const iExport = html.indexOf("'Export\"");
  check("the filters have a row", iFilters >= 0);
  check("the buttons are grouped", iAct > iFilters, "fvact at " + iAct);
  check("every button is inside the group, not loose among the filters",
    iAct >= 0 && iRun > iAct && iExport > iAct, "Run at " + iRun + ", Export at " + iExport);
  check("Run comes before Export", iRun < iExport);
  check("no button carries its own margin-left:auto any more",
    !/id="\x27 \+ p \+ \x27(Run|Scan|Stop|Export)"[^>]*margin-left:auto/.test(html));
  /* The group lives INSIDE the filter row — the buttons sit at its right-hand end rather than on a
     row of their own. Checked by bracket depth, because "inside" is the whole point: as one flex
     item the group cannot split across a wrap, which is what put Export above Run before. */
  {
    const after = html.slice(iAct);
    const closes = after.slice(0, after.indexOf("fvName") >= 0 ? after.indexOf("fvName") : after.length);
    check("the group is nested in the filter row, not a sibling of it",
      /'<\/div>' \+\s*\/\/ the button group[\s\S]{0,80}'<\/div>' \+\s*\/\/ the filter row/.test(html),
      closes.slice(0, 60));
  }

  const css = fs.readFileSync(path.join(__dirname, "..", "app.html"), "utf8");
  check("the group is styled", /\.fvact\s*\{[^}]*display:flex/.test(css));
  check("the filter row is styled", /\.fvrow\s*\{[^}]*flex-wrap:wrap/.test(css));
  check("the group is pushed right, as a group rather than one button",
    /\.fvact\s*\{[^}]*margin-left:auto/.test(css));
  check("the buttons cannot split across a wrap",
    /\.fvact\s*\{[^}]*flex-wrap:nowrap/.test(css));
  check("and at phone width the group stops being pushed right",
    /@media \(max-width:560px\)\{ \.fvact\{margin-left:0/.test(css));
}

Promise.all(later).then(function () {
  console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
  process.exit(fail ? 1 : 0);
}, function (e) {
  console.log("FAIL  a waiting check threw   " + (e && e.message ? e.message : e));
  process.exit(1);
});
