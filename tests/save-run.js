/* A finished run saves itself.
 *
 * A run can take hours, and at the end of one nobody wants to remember to press three buttons — or
 * to find out next week that they didn't and the tab has since been closed. Switched on, everything
 * the run produced goes into a folder of its own, named for when it finished.
 *
 * The parts that can go quietly wrong: an archive that silently keeps only what the on-screen
 * filter allowed, a folder name two runs can collide on, asking for a permission at a moment when
 * there is no click to carry it, and saving after the buttons come back so the tab can be closed
 * in between.
 *
 *   node tests/save-run.js
 */
"use strict";
const fs = require("fs");
const path = require("path");

const APP = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const HTML = fs.readFileSync(path.join(__dirname, "..", "app.html"), "utf8");
const MANIFEST = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));

let fail = 0;
const check = (name, ok, extra) => {
  if (!ok) fail++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (!ok && extra !== undefined ? "   " + extra : ""));
};
function src(name) {
  let at = APP.indexOf("function " + name + "(");
  if (at < 0) throw new Error("no such function: " + name);
  if (APP.slice(at - 6, at) === "async ") at -= 6;
  let depth = 0;
  for (let j = APP.indexOf("{", at); j < APP.length; j++) {
    if (APP[j] === "{") depth++;
    else if (APP[j] === "}") { depth--; if (!depth) return APP.slice(at, j + 1); }
  }
  throw new Error("unbalanced " + name);
}
const line = (re) => (re.exec(APP) || [""])[0];

/* ---------- the folder ---------- */
{
  const runFolder = new Function(src("runFolder") + "\nreturn runFolder;")();
  const n = runFolder();
  /* Windows forbids : \ / * ? " < > | in a name, and a colon is what a time normally has in it */
  check("the folder name is legal on any filesystem", !/[:\\/*?"<>|]/.test(n), n);
  check("…sorts chronologically as text", /^UMS \d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}$/.test(n), n);
  /* two runs of a small sheet inside one minute is ordinary; without seconds the second one lands
     in the first one's folder and overwrites four files */
  check("…and is unique to the second", /\d{2}-\d{2}-\d{2}$/.test(n), n);
}

/* ---------- what goes in it ---------- */
{
  const api = new Function("students", "srvMode", "baseUrl", "baseUrl2", "filter", "notOk",
    line(/const STLBL_SRV = \{[\s\S]*?\};/) + "\n" +
    line(/const STLBL = \{[^\n]*\};/) + "\n" +
    src("statusColor") + "\n" + src("matchFilter") + "\n" + src("pwUrl") + "\n" +
    src("payBase") + "\n" + src("flatRows") + "\n" +
    "return { flatRows: flatRows };");

  const students = [
    { reg: "A", results: [{ item: {}, res: { st: "ok", spid: "1", detail: "সব মিলেছে", raw: "" } }] },
    { reg: "B", results: [{ item: {}, res: { st: "no", spid: "2", detail: "Due ভুল", raw: "## Program Wise\n" } }] },
    { reg: "C", results: [{ item: {}, res: { st: "cw", spid: "3", detail: "CW ফাঁকা", raw: "## Program Wise\n" } }] }
  ];
  const withFilter = (f) => api(students, false, "https://ums-5.osl.team", "", f,
    (st) => st !== "ok" && st !== "zero");

  check("the buttons honour the filter", withFilter("no").flatRows().length === 1,
    String(withFilter("no").flatRows().length));
  /* An automatic archive that quietly held only whatever chip happened to be selected would be
     worse than no archive: you would not know it was partial until you needed the rest. */
  check("…but the automatic save takes everything", withFilter("no").flatRows(true).length === 3,
    String(withFilter("no").flatRows(true).length));
  check("…whatever the filter says", withFilter("ok").flatRows(true).length === 3);
}

/* ---------- the files ---------- */
{
  /* Two files, holding the whole run: all Error and all Success, split the way the Total Problem
     tile splits the screen, so the half that needs a person opens on its own without filtering a
     sheet of ninety thousand rows. Each is named for the input file + sheet, the outcome and the
     date-time. The page is not written here — it is the expensive half (tens of megabytes over a
     hundred thousand rows at the end of a run); ⬇ HTML Report makes one in a second when wanted. */
  const rf = src("runFiles");
  check("the run saves two files — Error and Success, separately",
    (rf.match(/name: base \+ "/g) || []).length === 2 &&
    / - Error - " \+ ts \+ "\.xlsx"/.test(rf) && / - Success - " \+ ts \+ "\.xlsx"/.test(rf), "runFiles");
  check("…each a single-tab workbook built by buildBook/xlsxTab",
    /buildBook\(\[xlsxTab\(word \+/.test(rf), "runFiles");
  /* the auto-saved files drop the long Details column (noDetails); the ⬇ Excel button keeps it */
  check("…without the Details column (noDetails), while the button keeps it",
    /xlsxTab\(word \+ " \(" \+ rs\.length \+ "\)", rs, true\)/.test(rf) &&
    /return buildBook\(\[xlsxTab\(t\("tab_all"\), rows\)\]\);/.test(APP) &&
    /function xlsxTab\(name, rows, noDetails\)/.test(APP), "runFiles / xlsxTab");
  check("…the page is not built at the end of a run", !/buildHtml\(/.test(rf), "runFiles");
  /* but it must still be reachable — the button is now the only way to get one */
  check("…while the ⬇ HTML button still makes one",
    /\$\("html"\)\.addEventListener\("click"/.test(APP) && /buildHtml\(/.test(APP), "app.js");
  /* flatRows(true) is what ignores the chip on screen — the ⬇ buttons call flatRows() */
  check("…holding the whole run, whatever the filter says",
    /const rows = flatRows\(true\);/.test(rf), "runFiles");
  check("…and nothing at all when the run found nothing",
    /if \(!rows\.length\) return \[\];/.test(rf), "runFiles");

  /* The split is the same one the Total Problem tile makes: notOk(result) → the Error file. */
  check("the two files are split by notOk(result)",
    /const bad = rows\.filter\(function \(r\) \{ return notOk\(r\.result\); \}\);/.test(rf) &&
    /const ok = rows\.filter\(function \(r\) \{ return !notOk\(r\.result\); \}\);/.test(rf), "runFiles");
  /* the filename carries what fed the run: input file (no extension) + sheet, via outBase() */
  check("the file name is built from the input file and sheet",
    /function outBase\(\)/.test(APP) && /base = outBase\(\), ts = stamp\(\)/.test(rf) &&
    /return base \|\| "UMS Reconcile";/.test(APP), "outBase / runFiles");
  check("…with filesystem-illegal characters stripped",
    /function sanitizeName\(s\) \{[^}]*\[\\\\\/:\*\?"<>\|\]/.test(APP), "sanitizeName");
  /* the ⬇ download button still writes one tab of whatever the filter selected */
  check("…while the button's workbook stays one tab",
    /return buildBook\(\[xlsxTab\(t\("tab_all"\), rows\)\]\);/.test(APP), "buildXlsx");
  /* the ⬇ button is untouched: there the filter has already said what the file is about */
  check("…while the download button still writes whatever the filter selected",
    /function exportHtml\(\) \{[^]*?buildHtml\(rows\)/.test(APP), "exportHtml");
  /* The page is the big one — a hundred thousand rows take about seventeen seconds to become
     usable, timed — and it carries them anyway, because the chips at its top put either half on
     screen in a click and someone reading a saved run wants both halves there. */
  check("…and the saved page is not trimmed behind anyone's back",
    !/buildHtml\(hot/.test(APP) && !/html_trimmed/.test(APP), "app.js");
}

/* ---------- where it writes ---------- */
{
  /* An extension's own directory is mounted read-only and no extension can write to an arbitrary
     path, so the folder has to be handed over by the user. */
  check("a folder can be chosen", /window\.showDirectoryPicker/.test(APP), "app.js");
  /* Handles are not JSON, so chrome.storage cannot hold one — without IndexedDB the folder would
     have to be picked again every time the page is opened. */
  check("…and remembered across sessions", /indexedDB\.open\("umsrec", \d+\)/.test(APP) &&
    /st\.put\(h, "dir"\)/.test(APP), "app.js");
  /* The database gained a second store for the run checkpoint, which meant a version bump, which
     means an upgrade path. Creating the stores unconditionally would throw on an existing "kv" —
     and dropping and recreating it would silently take the saved folder with it, so that a user
     who had chosen a folder months ago would find it gone with nothing to say why. */
  check("…and the folder survives the database being upgraded",
    /if \(!db\.objectStoreNames\.contains\("kv"\)\) db\.createObjectStore\("kv"\);/.test(APP) &&
    !/deleteObjectStore/.test(APP), "app.js");
  /* requestPermission needs a user gesture. At the end of a long run there is none, so it is asked
     for at the click that switches the saving on, and only CHECKED when the run ends. */
  check("permission is requested at the click, not at the end of the run",
    /if \(saveOnFinish && !dirHandle\) pickDir\(\);/.test(APP) &&
    /h\.requestPermission\(\{ mode: "readwrite" \}\)/.test(APP), "app.js");
  check("…and only queried when the run ends",
    /await h\.queryPermission\(\{ mode: "readwrite" \}\)/.test(src("dirUsable")) &&
    !/requestPermission/.test(src("dirUsable")), "app.js");
  /* a folder that was moved, deleted, or never authorised must not cost the run its results */
  check("a lapsed folder falls back to Downloads, it does not lose the run",
    /return saveViaDownloads\(folder, files\);/.test(src("saveRun")), "app.js");
  check("…which needs the downloads permission",
    (MANIFEST.permissions || []).indexOf("downloads") >= 0, (MANIFEST.permissions || []).join(","));
  /* Downloads cannot be given an absolute path, so this can never be "the tool's folder" — it is
     the fallback, and the wording must not promise otherwise */
  check("…into a folder of its own there too",
    /filename: "UMS Reconciler\/" \+ folder \+ "\/" \+ f\.name/.test(APP), "app.js");
}

/* ---------- when ---------- */
{
  const body = src("startRun");
  const savedAt = body.indexOf("saved = await saveRun();");
  check("the run saves before the buttons come back",
    savedAt > 0 && savedAt < body.indexOf('$("run").disabled = !entries.length;'),
    savedAt < 0 ? "never saves" : "saves after the buttons are re-enabled");
  check("…after the unanswered have been swept, so the archive is the final answer",
    body.indexOf("await sweepUnanswered(t0);") < savedAt, "app.js");
  /* The destination — the chosen folder, or Downloads, which is what the fallback looks like from
     outside. That distinction is the whole reason this line says anything at all; the timestamped
     subfolder under it is the longest part of the path and the least surprising, so it went to the
     tooltip when the line outgrew its badge. */
  check("…and says where it went", /" · 💾 " \+ where/.test(APP) &&
    /const where = saved \? String\(saved\)\.split\(" \/ "\)\[0\]/.test(APP), "app.js");
  check("…with the whole path a hover away", /\$\("prog"\)\.title = \(saved \? saved \+ "\\n" : ""\)/.test(APP),
    "app.js");
  /* silence here would read as "it saved" */
  check("…or that it could not", /t\("save_failed"\)/.test(APP), "app.js");
  check("…and never blocks the run finishing", /try \{ saved = await saveRun\(\); \} catch \(e\) \{ saved = ""; \}/.test(APP), "app.js");
}

/* ---------- the control ---------- */
{
  ["saveSw", "pickDir", "saveWhere"].forEach(function (id) {
    check("app.html has #" + id, new RegExp('id="' + id + '"').test(HTML));
  });
  check("the choice is remembered", /chrome\.storage\.local\.set\(\{ saveOnFinish: saveOnFinish \}\)/.test(APP) &&
    /"saveOnFinish", "saveDirName"/.test(APP), "app.js");
  /* picking a folder while the saving is off would be asking for a permission nothing will use */
  check("…and the folder button waits until saving is on",
    /btn\.disabled = !saveOnFinish;/.test(APP), "app.js");
  /* The switch must show the stored setting even if the folder handle never loads. It was painted
     only when the IndexedDB read settled, so an unavailable store left it reading OFF while saving
     was on — and the run then wrote files the page said it would not. */
  check("the switch is painted from the setting, not from the folder handle",
    /applySrvMode\(\);[\s\S]{0,700}?paintSaveRow\(\);/.test(APP), "app.js");
  /* Its words are written by JS, not by a data-i18n node, so applyLang() has to repaint it —
     paintSaveRow() runs during wire(), before the stored language is applied, and the line stayed
     Bengali under an English interface. */
  check("the save line follows the language switch",
    /paintRerun\(\); paintConn\(\); paintSaveRow\(\);/.test(APP), "app.js");
  const en = /save_hint: \{ bn: "[^"]*",\s*\n?\s*en: "([^"]*)" \}/.exec(APP);
  check("the hint has clean English", !!en && !/[ঀ-৿]/.test(en[1]), en ? en[1] : "not found");
  /* Three clauses and no more. It was four sentences of small grey type under a toggle, carrying
     the reasons behind each fact as well as the facts, and it read as a wall — the reasons live in
     the README now, where a reason gets read. What has to survive here is what someone standing at
     the switch needs: what is saved, that the page is a button rather than part of it, and where
     it lands when no folder was chosen. */
  check("…and stays short enough to be read", !!en && en[1].length < 200,
    en ? en[1].length + " characters" : "");
  check("…saying what is saved", !!en && /Success/.test(en[1]) && /Error/.test(en[1]), en ? en[1] : "");
  check("…that the page is a button", !!en && /HTML Report/.test(en[1]), en ? en[1] : "");
  check("…and where it goes without a folder", !!en && /Downloads/.test(en[1]), en ? en[1] : "");
  /* the reason it cannot simply write beside itself still has to be written down somewhere */
  const README = fs.readFileSync(path.join(__dirname, "..", "README.md"), "utf8");
  check("…while the README keeps the reason",
    /নিজের ফোল্ডারে লিখতে পারে না/.test(README), "README.md");
}

console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
process.exit(fail ? 1 : 0);
