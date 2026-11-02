/* Franchise check — nothing is stranded in one language.
 *
 *   node tests/franchise-lang.js
 *
 * Render everything the two menus put in front of a person, in both languages, and flag anything
   that comes out identical where it should not — that is what "bn/en thik nai" looks like. */
const fs = require("fs");
const path = require("path");
const ROOT = path.join(__dirname, "..");

const app = fs.readFileSync(ROOT + "/app.js", "utf8");
const at = app.indexOf("DICT = {");
const open = app.indexOf("{", at);
let d = 0, end = open;
for (let i = open; i < app.length; i++) {
  if (app[i] === "{") d++;
  else if (app[i] === "}") { d--; if (!d) { end = i; break; } }
}
const DICT = eval("(" + app.slice(open, end + 1) + ")");

// every key the two menus reach for
const src = ["menus/fr/fr-core.js", "menus/fr/fr-ui.js", "menus/fr/fr.js", "menus/fe/fe.js"]
  .map(f => fs.readFileSync(path.join(ROOT, f), "utf8")).join("\n");
const used = [...new Set([
  ...[...src.matchAll(/\bt\("([a-z0-9_]+)"\)/g)].map(m => m[1]),
  ...[...src.matchAll(/\bT\("([a-z0-9_]+)"\)/g)].map(m => m[1]),
  ...[...src.matchAll(/fill\("([a-z0-9_]+)"/g)].map(m => m[1]),
  ...[...src.matchAll(/"(fv_[a-z0-9_]+)"/g)].map(m => m[1])
])].sort();

let fail = 0;
const missing = used.filter(k => !DICT[k]);
if (missing.length) { fail++; console.log("MISSING FROM DICT: " + missing.join(", ")); }

// a label that is the same in both languages is only right when it names a UMS term
/* fv_lv_course and fv_lv_student name the report's two levels. UMS spells them "Course Wise" and
   "Student Wise" in its own left menu and the QA cases quote them that way 652 times, so the words
   are the report's, not ours, and translating them would stop them matching the screen. */
const sameOk = new Set(["fv_c_tt", "fv_c_pct", "fv_c_svc", "fv_export", "fv_r_who", "fv_r_what",
  "fv_r_tt", "fv_lv_course", "fv_lv_student"]);
const suspicious = used.filter(k => DICT[k] && DICT[k].bn === DICT[k].en && !sameOk.has(k));
console.log("keys the menus use: " + used.length);
console.log("identical in bn and en, and not a UMS term: " + suspicious.length +
  (suspicious.length ? "  → " + suspicious.join(", ") : ""));
if (suspicious.length) fail++;

/* The slip that started this: a column name typed straight into the header array instead of a
   dictionary key. Nothing else notices — the key simply stops being used — so the array itself
   is checked: every entry must be a key, never a word. Located by string, not by regex, because
   the entries are quoted and a pattern here would only be another thing to get wrong.

   The keys are READ from fr-ui.js rather than listed again here. They were listed, and adding the
   Student column to the export left the list a column short: the test failed on its own staleness
   while the product was right, which teaches whoever sees it to edit the test until it goes quiet. */
{
  const ui = fs.readFileSync(path.join(ROOT, "menus", "fr", "fr-ui.js"), "utf8");
  const start = ui.indexOf("var header = [");
  const stop = start < 0 ? -1 : ui.indexOf("]", start);
  if (start < 0 || stop < 0) {
    fail++;
    console.log("\nthe export header is no longer an array of keys");
  } else {
    const inside = ui.slice(start + "var header = [".length, stop);
    const entries = inside.split(",").map(x => x.trim().replace(/^"|"$/g, "")).filter(Boolean);
    const literals = entries.filter(e => e.indexOf("fv_") !== 0);
    const unknown = entries.filter(e => e.indexOf("fv_") === 0 && !DICT[e]);
    if (literals.length) { fail++; console.log("\nhardcoded column name(s): " + literals.join(", ")); }
    if (unknown.length) { fail++; console.log("\ncolumn key(s) with no string behind them: " + unknown.join(", ")); }
    if (!literals.length && !unknown.length) {
      console.log("\nexport header: " + entries.length + " dictionary keys, no hardcoded words");
      // and the columns a person actually sees, in both languages, from those same keys
      for (const lang of ["bn", "en"]) {
        console.log("Excel columns (" + lang + "):\n  " +
          entries.map(k => DICT[k][lang]).join(" | "));
      }
    }
  }
}

console.log(fail ? "\n" + fail + " problem(s)" : "\nসব ঠিক আছে");
process.exit(fail ? 1 : 0);
