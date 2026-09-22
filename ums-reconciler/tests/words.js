/* Every word the tool can say, in both languages.
 *
 * The dictionary is one object, a bn and an en per key, plus s_-prefixed twins that replace their
 * base while a run is comparing two servers. Four ways it goes wrong, all of them silent:
 *
 *   - the markup asks for a key the dictionary has not got, and t() hands back the KEY, so the
 *     label on screen reads "imp_default" instead of a sentence;
 *   - a half is missing, and t() falls back to bn, so an English interface quietly speaks Bengali;
 *   - a {placeholder} survives in one language and not the other, so one of them prints "{n}";
 *   - keys nothing asks for pile up — ten of them had, left behind by features that went, and each
 *     one reads like something the tool might one day say.
 *
 * Fonts are here too, because a stack that omits the Bengali family is the same kind of fault: it
 * costs nothing on a machine without that font and splits the panel in two on a machine with it.
 *
 *   node tests/words.js
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const APP = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const HTML = fs.readFileSync(path.join(ROOT, "app.html"), "utf8");
const CONTENT = fs.readFileSync(path.join(ROOT, "content.js"), "utf8");
const PANEL = fs.readFileSync(path.join(ROOT, "panel.html"), "utf8");
/* The New Admission and CRM menus moved to js/adm.js and js/crm.js; their t() calls and key
   references live there now, so the usage/leftover checks scan all three files together. DICT
   itself still lives in app.js and is parsed from APP alone. */
const SRC = APP + "\n"
  + fs.readFileSync(path.join(ROOT, "js", "adm.js"), "utf8") + "\n"
  + fs.readFileSync(path.join(ROOT, "js", "crm.js"), "utf8");

let fail = 0;
const check = (name, ok, extra) => {
  if (!ok) fail++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (!ok && extra !== undefined ? "   " + extra : ""));
};

const DICT = (function () {
  const at = APP.indexOf("const DICT = {");
  let d = 0;
  for (let i = APP.indexOf("{", at); i < APP.length; i++) {
    if (APP[i] === "{") d++;
    else if (APP[i] === "}") { d--; if (!d) return new Function(APP.slice(at, i + 1) + "\nreturn DICT;")(); }
  }
  throw new Error("no DICT");
})();
const keys = Object.keys(DICT);

/* ---------- both halves, every key ---------- */
{
  const bad = keys.filter(function (k) {
    const e = DICT[k];
    return !e || typeof e !== "object" || typeof e.bn !== "string" || typeof e.en !== "string";
  });
  check("every key says something in both languages", bad.length === 0, bad.join(", "));
  /* An empty string is how an entry gets used to blank an element out — it worked, and it is
     indistinguishable from a translation nobody finished. Blanking belongs in code. */
  const blank = keys.filter(function (k) { return DICT[k].bn === "" || DICT[k].en === ""; });
  check("…and none of them says nothing", blank.length === 0, blank.join(", "));
}

/* ---------- what the markup asks for ---------- */
{
  const asked = [];
  ["data-i18n", "data-ph", "data-title"].forEach(function (a) {
    (HTML.match(new RegExp(a + '="([^"]+)"', "g")) || []).forEach(function (m) {
      asked.push(m.slice(a.length + 2, -1));
    });
  });
  const missing = [...new Set(asked)].filter(function (k) { return !DICT[k]; });
  /* t() hands back the key itself when it has nothing, so this shows up on screen as the key */
  check("every label the markup asks for exists", missing.length === 0,
    missing.join(", ") + " — these would appear on screen verbatim");
  check("…and the markup does ask for a fair few", asked.length >= 40, asked.length + " found");
}

/* ---------- what the code asks for ---------- */
{
  const called = [...new Set((SRC.match(/\bt\("([a-zA-Z0-9_]+)"\)/g) || [])
    .map(function (m) { return m.slice(3, -2); }))];
  const missing = called.filter(function (k) { return !DICT[k]; });
  check("every label the code asks for exists", missing.length === 0, missing.join(", "));
  check("…and it asks for a fair few too", called.length >= 70, called.length + " found");

  /* Two keys are built at run time — t("pill_" + status) and the connection card's t(p[1]) — so
     anything they can produce has to be there even though no literal names it. */
  ["ok", "no", "cw", "zero", "nf", "error", "manual"].forEach(function (st) {
    if (!DICT["pill_" + st]) { fail++; console.log("FAIL  pill_" + st + " is missing — t(\"pill_\" + status) builds it"); }
  });
  check("…including the ones built from a status", true);
  check("…and the two connection headings", !!DICT.conn_exp && !!DICT.conn_act, "conn_exp / conn_act");
}

/* ---------- s_ twins ---------- */
{
  const twins = keys.filter(function (k) { return k.indexOf("s_") === 0; });
  const orphans = twins.filter(function (k) { return !DICT[k.slice(2)]; });
  /* t() resolves "s_" + key first, so an s_ key with no base can only be reached by asking for it
     by its full name — which reads as a twin whose base was deleted, and stops every audit here */
  check("every s_ twin replaces a key that exists", orphans.length === 0, orphans.join(", "));
  check("…and there are twins to check", twins.length >= 15, twins.length + " twins");
}

/* ---------- placeholders ---------- */
{
  /* A key with a half missing is already reported above; reading it here would throw, and a test
     that throws stops reporting everything after it. */
  const holes = function (v) { return (String(v == null ? "" : v).match(/\{\w+\}/g) || []).sort().join(","); };
  const bad = keys.filter(function (k) {
    if (typeof DICT[k].bn !== "string" || typeof DICT[k].en !== "string") return false;
    return holes(DICT[k].bn) !== holes(DICT[k].en);
  });
  check("a {placeholder} in one language is in the other", bad.length === 0,
    bad.map(function (k) { return k + " bn[" + holes(DICT[k].bn) + "] en[" + holes(DICT[k].en) + "]"; }).join(" · "));
}

/* ---------- nothing left over ---------- */
{
  const asked = new Set();
  ["data-i18n", "data-ph", "data-title"].forEach(function (a) {
    (HTML.match(new RegExp(a + '="([^"]+)"', "g")) || []).forEach(function (m) { asked.add(m.slice(a.length + 2, -1)); });
  });
  (SRC.match(/\bt\("([a-zA-Z0-9_]+)"\)/g) || []).forEach(function (m) { asked.add(m.slice(3, -2)); });
  /* the ones a literal cannot name: built from a status, chosen by a conditional, or an s_ twin */
  const reachable = function (k) {
    if (asked.has(k)) return true;
    if (k.indexOf("s_") === 0 && asked.has(k.slice(2))) return true;
    if (/^s?_?pill_/.test(k)) return true;
    if (k === "conn_exp" || k === "conn_act") return true;
    return new RegExp('"' + k + '"').test(SRC);      // named anywhere else in the source
  };
  const dead = keys.filter(function (k) { return !reachable(k); });
  check("nothing in the dictionary is unreachable", dead.length === 0, dead.join(", "));
}

/* ---------- the fonts that have to draw all this ---------- */
{
  const BN = '"Noto Sans Bengali"';
  /* Stop at the closing brace, not at a quote: a family name with a space is quoted, so [^'"]
     cuts the stack off at "Segoe UI" and never sees what comes after it. */
  const stacks = [
    ["the batch page", HTML, /font:14px\/1\.5 [^}]*/],
    ["the in-page panel", CONTENT, /#umsrec\{[^}]*font:13px\/1\.45 [^}]*/],
    ["the panel's minimised bubble", CONTENT, /font:600 14px\/1 [^}]*/],
    ["the pop-out window", PANEL, /font:13px\/1\.45 [^}]*/],
    ["the exported HTML report", APP, /font:14px\/1\.5 [^}]*/]
  ];
  const without = stacks.filter(function (s) {
    const m = s[2].exec(s[1]);
    return !m || m[0].indexOf(BN) < 0;
  });
  check("every font stack names a Bengali family", without.length === 0,
    without.map(function (s) { return s[0]; }).join(", "));
  check("…in all five places text is drawn", stacks.length === 5);
}

console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
process.exit(fail ? 1 : 0);
