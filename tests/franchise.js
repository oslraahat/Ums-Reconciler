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
const check = (name, ok, extra) => { if (!ok) fail++; console.log((ok ? "PASS  " : "FAIL  ") + name + (!ok && extra !== undefined ? "   " + extra : "")); };

// ---- mount ----
const panel = self.APP.frUi.mount("fr", "frBox");
const html = els.frBox.innerHTML;

check("the panel mounts and returns its handle", !!panel);
check("no label fell back to a raw key", html.indexOf("!!MISSING:") < 0,
  (html.match(/!!MISSING:[a-z_]+/g) || []).join(", "));
["frBase", "frOrg", "frProg", "frSess", "frBranch", "frFrom", "frTo", "frRun", "frExport", "frNote", "frOut"]
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

console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
process.exit(fail ? 1 : 0);
