/* Nothing is stranded in one language — the whole interface, not one menu.
 *
 *   node tests/lang.js
 *
 * "For Franchisor menu te title name en e bangla show korce" sent me through every title on that
 * page before I could say the menu was clean. The checks that would have answered it in one run
 * are these, and they cover the whole app rather than the menu that happened to be reported.
 *
 * Four ways a Bengali string reaches an English interface:
 *
 *   1. en holds Bengali — somebody filled the slot with the wrong half of the pair.
 *   2. en is missing or empty — t() is `e[lang] || e.bn`, so an absent en silently falls back to
 *      Bengali rather than showing a gap. Nothing on screen says anything is wrong.
 *   3. a data-i18n / data-ph / data-title key is not in the dictionary — t() returns the key, and
 *      applyLang() paints it, so whatever was typed into the HTML stays, in whatever language.
 *   4. the words were typed into the markup or into JS instead of the dictionary — applyLang()
 *      cannot reach them, so they keep the language they were written in. A tooltip is the easiest
 *      one to miss: an icon-only control says nothing else, and nothing looks wrong until hovered.
 */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");
const BN = /[\u0980-\u09FF]/;

const app = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const at = app.indexOf("DICT = {");
const open = app.indexOf("{", at);
let depth = 0, end = open;
for (let i = open; i < app.length; i++) {
  if (app[i] === "{") depth++;
  else if (app[i] === "}") { depth--; if (!depth) { end = i; break; } }
}
const DICT = eval("(" + app.slice(open, end + 1) + ")");
const keys = Object.keys(DICT);

let fail = 0;
const bad = function (what, list) {
  console.log((list.length ? "FAIL  " : "ok    ") + what + ": " + list.length);
  list.slice(0, 20).forEach(function (l) { console.log("        " + l); });
  if (list.length) fail++;
};

console.log("dictionary entries: " + keys.length + "\n");

// 1 — Bengali sitting in an en slot
bad("en slots holding Bengali",
  keys.filter(k => DICT[k] && typeof DICT[k].en === "string" && BN.test(DICT[k].en))
    .map(k => k + " en = " + JSON.stringify(DICT[k].en)));

// 2 — the silent fallback: no en at all means Bengali under English, with nothing to show for it
bad("entries whose en is missing or empty",
  keys.filter(k => !DICT[k] || typeof DICT[k] !== "object" || !DICT[k].en).map(k => k));
bad("entries whose bn is missing or empty",
  keys.filter(k => !DICT[k] || typeof DICT[k] !== "object" || !DICT[k].bn).map(k => k));

// 3 — a key the markup asks for and the dictionary does not have
const html = fs.readFileSync(path.join(ROOT, "app.html"), "utf8");
const asked = [];
for (const attr of ["data-i18n", "data-ph", "data-title"]) {
  const re = new RegExp(attr + '="([a-z0-9_]+)"', "g");
  let m;
  while ((m = re.exec(html))) asked.push([attr, m[1]]);
}
bad("keys app.html asks for and the dictionary lacks",
  asked.filter(a => !DICT[a[1]]).map(a => a[0] + '="' + a[1] + '"'));

/* 4 — words typed into the markup or into JS rather than into the dictionary. Tooltips are checked
   by themselves because a tooltip is the whole of what an icon-only control says, and the one
   nobody sees without hovering: three filter pills, two screenshot links and five app.html controls
   shipped with Bengali titles that no language switch could touch.

   Judged per element, not per line: a Bengali title literal is correct when the same element also
   carries data-title, because applyLang() repaints it and the literal is only what shows in the
   instant before. Without data-title there is nothing to repaint it from.

   The error-message strings in adm/cc/fn are the same fault at a larger scale; they are counted and
   printed, not failed — that is its own job, and failing on them here would only mean this run gets
   skipped. */
const mods = [];
for (const dir of fs.readdirSync(path.join(ROOT, "menus"), { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  for (const f of fs.readdirSync(path.join(ROOT, "menus", dir.name))) {
    if (f.endsWith(".js")) mods.push("menus/" + dir.name + "/" + f);
  }
}
const titles = [], prose = [];
for (const f of mods.concat(["app.js", "app.html"])) {
  const isHtml = /\.html$/.test(f);
  const lines = fs.readFileSync(path.join(ROOT, f), "utf8").split(/\r?\n/);
  lines.forEach(function (line, i) {
    const where = f + ":" + (i + 1);
    let m;
    if (isHtml) {
      const ere = /<([a-z][a-z0-9]*)((?:[^>"]|"[^"]*")*)>/gi;
      while ((m = ere.exec(line))) {
        const attrs = m[2], tm = attrs.match(/\stitle="([^"]*)"/);
        if (tm && BN.test(tm[1]) && !/\sdata-title="/.test(attrs)) {
          titles.push(where + "  <" + m[1] + "> title=" + JSON.stringify(tm[1].slice(0, 50)));
        }
      }
    } else {
      /* In JS the attribute is concatenated, so the Bengali is a literal inside the markup string.
         A title built from t() reads `title="' + esc(t("k")) + '"` and has no Bengali in it. */
      const jre = /title="[^"]*[\u0980-\u09FF]/g;
      while ((m = jre.exec(line))) titles.push(where + "  title= built in JS: " + JSON.stringify(line.trim().slice(0, 60)));
    }
    const sre = /"([^"\\]{2,}?)"|'([^'\\]{2,}?)'/g;
    while ((m = sre.exec(line))) {
      const v = m[1] || m[2];
      if (BN.test(v)) prose.push(where + "  " + JSON.stringify(v.slice(0, 60)));
    }
  });
}
bad("Bengali tooltips with nothing to repaint them", titles);
console.log("note  Bengali strings typed outside the dictionary: " + prose.length +
  " (mostly adm/cc/fn messages — tracked, not failed here)");

/* The two franchise menus are what the report was about, so their strings are named rather than
   left to the totals above: a key either menu reaches for must exist, and must not be Bengali in
   its en slot. */
const frSrc = ["menus/fr/fr-core.js", "menus/fr/fr-ui.js", "menus/fr/fr.js", "menus/fe/fe.js"]
  .map(f => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n");
const frKeys = [...new Set([
  ...[...frSrc.matchAll(/\b[tT]\("([a-z0-9_]+)"\)/g)].map(m => m[1]),
  ...[...frSrc.matchAll(/fill\("([a-z0-9_]+)"/g)].map(m => m[1]),
  ...[...frSrc.matchAll(/"(fv_[a-z0-9_]+)"/g)].map(m => m[1]),
  "nav_fr", "nav_fe", "fr_h", "fe_h", "fr_sub", "fe_sub"
])].sort();
console.log("\nstrings the two franchise menus can show: " + frKeys.length);
bad("of those, missing from the dictionary", frKeys.filter(k => !DICT[k]));
bad("of those, holding Bengali under en", frKeys.filter(k => DICT[k] && BN.test(DICT[k].en)));

/* 5 — the language has to survive a refresh, and that is a question about ordering.
 *
 * "page refresh korle bn hoye jay." The stored language was read and applied correctly; the open
 * section was simply restored nine lines earlier, while `lang` still held the module default. A
 * menu that builds its panel from JS therefore built it in Bengali, and for the two franchise menus
 * the repair never came: onShow() starts a dropdown loader, the loader took the one busy flag, and
 * relang() read that flag as "a check is running" and refused to repaint.
 *
 * Both halves are checked here, because either one alone brings the symptom back. */
{
  const iLang = app.indexOf("applyLang(o.lang");
  const iPage = app.indexOf("showPage((o.page");
  const ordered = iLang > 0 && iPage > 0 && iPage > iLang;
  console.log((ordered ? "ok    " : "FAIL  ") +
    "boot restores the open section after the language" +
    (ordered ? "" : "  (showPage at " + iPage + ", applyLang at " + iLang + ")"));
  if (!ordered) fail++;

  const ui = fs.readFileSync(path.join(ROOT, "menus", "fr", "fr-ui.js"), "utf8");
  const split = /isRunning: function \(\) \{ return running; \}/.test(ui) &&
    /isLoading: function \(\) \{ return busy; \}/.test(ui);
  console.log((split ? "ok    " : "FAIL  ") +
    "the franchise panel tells a running check apart from a dropdown loader");
  if (!split) fail++;

  // and a remount must not fire a second loader over the one already open
  const guarded = ["menus/fr/fr.js", "menus/fe/fe.js"].filter(function (f) {
    return /isLoading\s*&&\s*panel\.isLoading\(\)\)\) panel\.loadProgs\(\)/.test(
      fs.readFileSync(path.join(ROOT, f), "utf8"));
  });
  console.log((guarded.length === 2 ? "ok    " : "FAIL  ") +
    "both wrappers skip loadProgs() while a loader is open: " + guarded.length + "/2");
  if (guarded.length !== 2) fail++;

  /* The saved address has to be back BEFORE the dropdowns are asked for, or they are loaded from
     the seeded one and are then wrong — the same ordering fault as the language, one layer down.
     loadProgs() must therefore sit inside restoreBase().then(), not beside it. */
  const sequenced = ["menus/fr/fr.js", "menus/fe/fe.js"].filter(function (f) {
    const src = fs.readFileSync(path.join(ROOT, f), "utf8");
    const at = src.indexOf("panel.restoreBase().then(function () {");
    return at >= 0 && src.indexOf("panel.loadProgs()", at) > at;
  });
  console.log((sequenced.length === 2 ? "ok    " : "FAIL  ") +
    "both wrappers wait for the saved address before loading the dropdowns: " + sequenced.length + "/2");
  if (sequenced.length !== 2) fail++;
}

console.log("\n" + (fail ? "FAILED (" + fail + ")" : "PASS"));
process.exit(fail ? 1 : 0);
