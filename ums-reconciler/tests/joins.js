/* The joins between the files.
 *
 * Every other test here checks behaviour. This one checks the seams — the things that break
 * silently when one file is edited and another is not, and that no amount of reading one file at a
 * time will show you:
 *
 *   an id the code reaches for that the markup no longer has  (a button that does nothing)
 *   a t("key") with no string behind it                       (the key itself, printed at a user)
 *   a string with a {placeholder} nobody fills                (literal "{n}" on screen)
 *   a string in one language and not the other                (undefined, in the other one)
 *   a file the manifest promises that is not on disk          (an extension that will not load)
 *   a U.x the pages use that reconcile.js does not export     (a throw, mid-run)
 *
 * None of these show up until the moment they matter, and every one of them is a one-line edit
 * away at any time.
 *
 *   node tests/joins.js
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");

let fail = 0;
const check = (name, list) => {
  const arr = Array.isArray(list) ? list : [];
  if (arr.length) fail++;
  console.log((arr.length ? "FAIL  " : "PASS  ") + name + (arr.length ? "   " + arr.length : ""));
  arr.slice(0, 12).forEach((x) => console.log("        " + x));
  if (arr.length > 12) console.log("        …and " + (arr.length - 12) + " more");
};
const uniq = (a) => Array.from(new Set(a));
const all = (s, re) => {
  const out = []; let m;
  const r = new RegExp(re.source, re.flags.indexOf("g") < 0 ? re.flags + "g" : re.flags);
  while ((m = r.exec(s))) out.push(m[1]);
  return uniq(out);
};

const APP = read("app.js"), HTML = read("app.html"), CONTENT = read("content.js");
const PANEL = read("panel.js"), PANELH = read("panel.html"), BG = read("background.js");
const REC = read("reconcile.js"), MANIFEST = read("manifest.json");

/* ---------- everything parses ---------- */
{
  const broke = [];
  [["app.js", APP], ["content.js", CONTENT], ["panel.js", PANEL], ["background.js", BG],
    ["reconcile.js", REC]].forEach(function (p) {
    try { new Function(p[1]); } catch (e) { broke.push(p[0] + ": " + e.message); }
  });
  try { JSON.parse(MANIFEST); } catch (e) { broke.push("manifest.json: " + e.message); }
  check("every file parses, and the manifest is valid JSON", broke);
}

/* ---------- the manifest ---------- */
{
  const m = JSON.parse(MANIFEST);
  const want = [];
  if (m.background && m.background.service_worker) want.push(m.background.service_worker);
  (m.content_scripts || []).forEach(function (c) {
    (c.js || []).concat(c.css || []).forEach(function (f) { want.push(f); });
  });
  (m.web_accessible_resources || []).forEach(function (w) {
    (w.resources || []).forEach(function (f) { if (f.indexOf("*") < 0) want.push(f); });
  });
  Object.keys(m.icons || {}).forEach(function (k) { want.push(m.icons[k]); });
  if (m.action && m.action.default_popup) want.push(m.action.default_popup);
  const di = (m.action && m.action.default_icon) || {};
  Object.keys(di).forEach(function (k) { want.push(di[k]); });
  check("every file the manifest names is on disk",
    uniq(want).filter(function (f) { return !fs.existsSync(path.join(ROOT, f)); }));

  const loaded = all(HTML, /<script src="([^"]+)"/).concat(all(PANELH, /<script src="([^"]+)"/));
  check("every <script src> in a page is on disk",
    uniq(loaded).filter(function (f) { return !fs.existsSync(path.join(ROOT, f)); }));

  /* the dashboard is opened by URL from the background and from the panel */
  const opened = uniq(all(BG, /getURL\("([^"]+)"\)/).concat(all(CONTENT, /getURL\("([^"]+)"\)/)));
  check("every page opened by getURL() exists and is web-accessible",
    opened.filter(function (f) {
      const bare = f.split("?")[0].split("#")[0];
      if (!fs.existsSync(path.join(ROOT, bare))) return true;
      return !(m.web_accessible_resources || []).some(function (w) {
        return (w.resources || []).some(function (r) {
          return r === bare || (r.indexOf("*") >= 0 && new RegExp("^" + r.replace(/\*/g, ".*") + "$").test(bare));
        });
      });
    }));
}

/* ---------- the ids ---------- */
{
  const htmlIds = all(HTML, /\bid="([\w-]+)"/);
  const counts = {};
  (HTML.match(/\bid="[\w-]+"/g) || []).forEach(function (x) { counts[x] = (counts[x] || 0) + 1; });
  check("no id is used twice in app.html",
    Object.keys(counts).filter(function (k) { return counts[k] > 1; })
      .map(function (k) { return k + " ×" + counts[k]; }));

  const made = all(APP, /id="([\w-]+)"/).concat(all(APP, /\.id = "([\w-]+)"/));
  const wanted = all(APP, /\$\("([\w-]+)"\)/).concat(all(APP, /getElementById\("([\w-]+)"\)/));
  check("app.js only reaches for ids app.html has",
    uniq(wanted).filter(function (i) { return htmlIds.indexOf(i) < 0 && made.indexOf(i) < 0; }));

  const pIds = all(PANELH, /\bid="([\w-]+)"/);
  const pWanted = all(PANEL, /getElementById\("([\w-]+)"\)/).concat(all(PANEL, /\$\("([\w-]+)"\)/));
  check("panel.js only reaches for ids panel.html has",
    uniq(pWanted).filter(function (i) { return pIds.indexOf(i) < 0; }));

  /* content.js builds its own panel inside somebody else's page, so only its own namespace is its
     to answer for — #courseWisePaymentTable belongs to UMS and is supposed to be absent until a
     payment page is open */
  const cMade = all(CONTENT, /id="([\w-]+)"/).concat(all(CONTENT, /\.id = "([\w-]+)"/));
  const cWanted = all(CONTENT, /getElementById\("(umsrec-[\w-]+)"\)/)
    .concat(all(CONTENT, /querySelector\("#(umsrec-[\w-]+)"\)/));
  check("content.js only reaches for ids it builds",
    uniq(cWanted).filter(function (i) { return cMade.indexOf(i) < 0; }));
}

/* ---------- the strings ---------- */
{
  const dictBlock = (/const DICT = \{[\s\S]*?\n  \};/.exec(APP) || [""])[0];
  const DICT = new Function("return " + dictBlock.replace(/^const DICT = /, "").replace(/;$/, ""))();
  const keys = Object.keys(DICT);
  check("the dictionary was found at all", keys.length > 50 ? [] : ["only " + keys.length + " keys"]);

  /* Two questions, and they want opposite kinds of evidence.
     "Is this key missing?" must not accuse: only names written as a key are counted, and a prefix
     handed to t() is not one.
     "Is this string unused?" must not miss: keys are reached by prefix, through arrays of names,
     and through ternaries that nest inside calls a regex will not balance, so every quoted word in
     the source counts as a mention. Blunt, and on the right side of both mistakes. */
  const literal = all(APP, /\bt\("([\w.]+)"\)/);
  const i18n = all(HTML, /data-i18n="([\w.]+)"/);
  const ph = all(HTML, /data-ph="([\w.]+)"/);
  const titles = all(HTML, /data-title="([\w.]+)"/);
  const named = uniq(literal.concat(i18n, ph, titles));
  const prefixes = all(APP, /t\("([\w.]+_)" \+/);
  const mentioned = uniq(all(APP, /"([\w.]+)"/).concat(named));

  check("every t() / data-i18n key has a string behind it",
    named.filter(function (k) { return keys.indexOf(k) < 0; }));

  /* t() resolves the s_ twins by mode, so an s_ key needs the base key it stands in for */
  check("every s_ twin has a base key",
    keys.filter(function (k) { return k.indexOf("s_") === 0; })
      .filter(function (k) { return keys.indexOf(k.slice(2)) < 0; }));

  /* a missing half renders as the word "undefined" at whoever switched language */
  check("every string exists in both languages",
    keys.filter(function (k) {
      return !DICT[k] || typeof DICT[k].bn !== "string" || typeof DICT[k].en !== "string";
    }));

  /* a {placeholder} nobody fills is printed literally */
  const unfilled = [];
  keys.forEach(function (k) {
    const marks = uniq((String(DICT[k].bn) + String(DICT[k].en)).match(/\{(\w+)\}/g) || []);
    marks.forEach(function (mk) {
      if (APP.indexOf('"' + mk + '"') < 0) unfilled.push(k + " " + mk);
    });
  });
  check("every {placeholder} is filled somewhere", unfilled);

  const reached = function (k) {
    return mentioned.indexOf(k) >= 0 || prefixes.some(function (p) { return k.indexOf(p) === 0; });
  };
  check("no string is left behind unused",
    keys.filter(function (k) {
      return !reached(k) && (k.indexOf("s_") === 0 ? !reached(k.slice(2)) : true);
    }));

  /* the English half of a user-facing string should be English */
  check("no Bangla left in an English string",
    keys.filter(function (k) { return /[ঀ-৿]/.test(DICT[k].en); }));
}

/* ---------- reconcile.js, which both pages stand on ---------- */
{
  const tail = REC.slice(REC.lastIndexOf("return {"));
  const used = uniq(all(APP, /\bU\.(\w+)/)
    .concat(all(CONTENT, /\bU\.(\w+)/), all(PANEL, /\bU\.(\w+)/)));
  check("every U.x the pages use is exported by reconcile.js",
    used.filter(function (n) { return tail.indexOf(n + ":") < 0; }));
  check("…and something is exported at all", tail.length > 40 ? [] : ["no export block found"]);
}

/* ---------- loose ends ---------- */
{
  const notes = [];
  [["app.js", APP], ["content.js", CONTENT], ["reconcile.js", REC], ["panel.js", PANEL],
    ["background.js", BG]].forEach(function (p) {
    (p[1].match(/\b(TODO|FIXME|XXX)\b[^\n]*/g) || []).forEach(function (m) {
      notes.push(p[0] + ": " + m.trim());
    });
    if (/\bdebugger\b/.test(p[1])) notes.push(p[0] + ": a debugger statement");
  });
  check("nothing left marked TODO/FIXME, no debugger", notes);

  /* the version on screen comes from the manifest — a literal drifts the moment one is bumped */
  check("no version number is hard-coded outside the manifest",
    all(APP, /"(1\d\.\d+\.\d+)"/).concat(all(CONTENT, /"(1\d\.\d+\.\d+)"/)));
}

console.log(fail ? "\n" + fail + " FAILED" : "\nall good");
process.exit(fail ? 1 : 0);
