/* Which file, and which tab, did these rows come from?
 *
 * Nothing on screen said. Two tabs of one workbook look identical in the preview, and so does last
 * week's copy of the same file — so a run against the wrong sheet was invisible until the numbers
 * came out strange, if ever. The import note now leads with the source.
 *
 * The tabs are the awkward part: the order of <sheet> elements in workbook.xml is NOT the order of
 * the sheetN.xml files, so both the name and the ORDER have to be followed through the relationship
 * id. That mapping is what this checks — with a small XML shim, since node has no DOMParser (the
 * XML parsing itself is the browser's job; the mapping is ours).
 *
 * It matters twice over now: readXlsx() used to take whichever worksheet was called sheet1.xml,
 * which is regularly not the first tab, so a workbook whose Summary sat in sheet4.xml imported the
 * wrong sheet without a word. The fixture below has always described that; now it fails on it.
 *
 *   node tests/import-src.js
 */
"use strict";
const fs = require("fs");
const path = require("path");

const APP = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

let fail = 0;
const check = (name, ok, extra) => { if (!ok) fail++; console.log((ok ? "PASS  " : "FAIL  ") + name + (!ok && extra ? "   " + extra : "")); };

/* ---- the smallest XML DOM sheetsOf() actually touches ---- */
const RELS_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
function el(tag, attrs) {
  return {
    tagName: tag,
    getAttribute: (n) => (n in attrs ? attrs[n] : null),
    getAttributeNS: (ns, n) => (ns === RELS_NS && ("r:" + n) in attrs ? attrs["r:" + n] : null)
  };
}
function DOMParserShim() {}
DOMParserShim.prototype.parseFromString = function (str) {
  const nodes = [];
  String(str).replace(/<([A-Za-z][\w:.-]*)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*\/?>/g, function (_, tag, rest) {
    const attrs = {};
    rest.replace(/([\w:.-]+)\s*=\s*"([^"]*)"/g, function (__, k, v) { attrs[k] = v; return ""; });
    nodes.push(el(tag, attrs));
    return "";
  });
  return { getElementsByTagName: (n) => nodes.filter((x) => x.tagName === n) };
};

/* ---- lift sheetsOf() straight out of app.js so this cannot drift from what ships ---- */
const at = APP.search(/\n  function sheetsOf\s*\(/);
if (at < 0) { console.log("FAIL  sheetsOf not found in app.js"); process.exit(1); }
let i = APP.indexOf("{", at), depth = 0, end = -1;
for (let j = i; j < APP.length; j++) {
  if (APP[j] === "{") depth++;
  else if (APP[j] === "}") { depth--; if (!depth) { end = j + 1; break; } }
}
const sheetsOf = new Function("DOMParser", "RELS_NS",
  APP.slice(at, end) + "; return sheetsOf;")(DOMParserShim, RELS_NS);
/* what the old sheetNameOf() did, out of the list — the picker needs the whole list, the note
   still needs just the one name */
const nameOf = (f, key, dec) => {
  const hit = sheetsOf(f, dec).filter((x) => x.target.toLowerCase() === String(key).toLowerCase())[0];
  return hit ? hit.name : "";
};

const enc = (s) => new TextEncoder().encode(s);
const dec = new TextDecoder("utf-8");

const SHEETS = {
  "xl/worksheets/sheet1.xml": new TextEncoder().encode("<worksheet/>"),
  "xl/worksheets/sheet4.xml": new TextEncoder().encode("<worksheet/>")
};
const WB = '<?xml version="1.0"?><workbook><sheets>' +
  '<sheet name="Summary" sheetId="1" r:id="rId7"/>' +
  '<sheet name="ছাত্র তালিকা" sheetId="2" r:id="rId3"/>' +
  "</sheets></workbook>";
const RELS = '<?xml version="1.0"?><Relationships>' +
  '<Relationship Id="rId7" Target="worksheets/sheet4.xml"/>' +
  '<Relationship Id="rId3" Target="worksheets/sheet1.xml"/>' +
  "</Relationships>";

/* ---- the name follows the relationship, not the position ---- */
{
  const f = Object.assign({ "xl/workbook.xml": enc(WB), "xl/_rels/workbook.xml.rels": enc(RELS) }, SHEETS);
  check("the tab is found through its r:id, not its order",
    nameOf(f, "xl/worksheets/sheet1.xml", dec) === "ছাত্র তালিকা",
    nameOf(f, "xl/worksheets/sheet1.xml", dec));
  check("…and the other file maps to the other tab",
    nameOf(f, "xl/worksheets/sheet4.xml", dec) === "Summary",
    nameOf(f, "xl/worksheets/sheet4.xml", dec));

  /* the order a person sees along the bottom of Excel, which is the order of the <sheet> elements
     and has nothing to do with the filenames */
  const tabs = sheetsOf(f, dec);
  check("every tab is offered", tabs.length === 2, tabs.length + ": " + tabs.map((x) => x.name).join(", "));
  check("…in the workbook's order, not the files'",
    tabs[0].name === "Summary" && tabs[1].name === "ছাত্র তালিকা",
    tabs.map((x) => x.name).join(" | "));
  /* THE bug: the first tab here lives in sheet4.xml, so taking sheet1.xml by name took the second
     tab. Every workbook whose tabs were reordered or added out of sequence imported the wrong one. */
  check("…so the first tab is sheet4.xml, not sheet1.xml",
    tabs[0].target === "xl/worksheets/sheet4.xml", tabs[0].target);

  /* a <sheet> whose worksheet is not in the zip (a chart sheet) has no rows to import */
  const noFile = { "xl/workbook.xml": enc(WB), "xl/_rels/workbook.xml.rels": enc(RELS),
    "xl/worksheets/sheet1.xml": enc("<worksheet/>") };
  check("a tab with no worksheet in the file is not offered",
    sheetsOf(noFile, dec).length === 1, JSON.stringify(sheetsOf(noFile, dec).map((x) => x.name)));
}

/* ---- writers that spell the target with a leading path ---- */
{
  const f = {
    "xl/workbook.xml": enc('<?xml version="1.0"?><workbook><sheets><sheet name="Data" r:id="rId1"/></sheets></workbook>'),
    "xl/_rels/workbook.xml.rels": enc('<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="/xl/worksheets/sheet1.xml"/></Relationships>')
  };
  f["xl/worksheets/sheet1.xml"] = enc("<worksheet/>");
  check("an absolute Target still matches", nameOf(f, "xl/worksheets/sheet1.xml", dec) === "Data",
    nameOf(f, "xl/worksheets/sheet1.xml", dec));
}

/* ---- a missing or broken workbook costs the name, never the import ---- */
{
  check("no workbook.xml → no tabs, no throw", sheetsOf({}, dec).length === 0);
  /* without the rels there is no link from a name to a file, so nothing can be offered — and
     readXlsx falls back to its filename guess, which is what it always did */
  const noRels = Object.assign({ "xl/workbook.xml": enc(WB) }, SHEETS);
  check("no rels → no tabs, no throw", sheetsOf(noRels, dec).length === 0);
  const junk = { "xl/workbook.xml": enc("<<<not xml at all") };
  check("junk → still no throw", sheetsOf(junk, dec).length === 0);
}

/* ---- the wiring around it ---- */
{
  check("unzip() keeps workbook.xml and its rels",
    /workbook\\\.xml\|_rels\\\/workbook\\\.xml\\\.rels/.test(APP), "app.js");
  check("readXlsx() hands the tab name and the tab list back with the rows",
    /return \{ rows: sheet\(dec\.decode\(f\[key\]\), sh\), sheet: hit \? hit\.name : "", sheets: tabs, target: key \};/.test(APP), "app.js");
  /* the workbook's own first tab, not whatever is called sheet1.xml */
  check("…defaulting to the workbook's first tab",
    /let key = \(want && f\[want\]\) \? want : \(\(tabs\[0\] && tabs\[0\]\.target\) \|\| ""\);/.test(APP), "app.js");
  check("…and only guessing by filename when the workbook will not parse",
    APP.indexOf("if (!key) {") < APP.indexOf("sheet1\\.xml$/i.test(x)"), "app.js");

  /* the picker itself */
  check("a workbook with tabs offers them", /function paintSheetPicker\(\)/.test(APP), "app.js");
  /* It decides which rows these are, so it belongs beside the heading and the count — under the
     paste box it sat below the very rows it chooses. */
  {
    const HTML = fs.readFileSync(path.join(__dirname, "..", "app.html"), "utf8");
    const hdr = HTML.slice(HTML.indexOf('data-i18n="verify_h"'));
    check("…in the card header, not under the paste box",
      hdr.indexOf('id="sheetRow"') >= 0 && hdr.indexOf('id="sheetRow"') < hdr.indexOf("</div>\n"),
      "app.html");
    check("…pushed into the space on the right",
      /\.ch \.sheetrow\{margin-left:auto/.test(HTML), "app.html");
  }
  check("…but one tab is not a choice", /if \(xlsxTabs\.length < 2\) \{ row\.style\.display = "none"/.test(APP), "app.js");
  check("…and choosing one re-imports from that tab",
    /addEventListener\("change", function \(\) \{ if \(xlsxFile\) loadXlsx\(xlsxFile, this\.value\); \}\)/.test(APP), "app.js");
  /* a .csv, a Google Sheet and a pasted block have no tabs — a picker left over from the last
     workbook would offer tabs that have nothing to do with the rows on screen */
  check("…and anything without tabs clears it",
    (APP.match(/clearSheetPicker\(\);/g) || []).length >= 4,
    (APP.match(/clearSheetPicker\(\);/g) || []).length + " call sites");
  /* the File is kept, not the unzipped parts: a workbook with a 100,000-row tab would otherwise
     sit inflated in memory for as long as the page is open, for tabs nobody asked for */
  check("…by re-reading the file, not by holding every sheet in memory",
    /let xlsxFile = null, xlsxTabs = \[\], xlsxTarget = "";/.test(APP) &&
    /r\.readAsArrayBuffer\(file\);/.test(APP), "app.js");
  /* a sheet name goes into an <option value> and a Reg into data-reg — esc() has to close them */
  check("…and a tab named with a quote cannot break out of the option",
    /\.replace\(\/"\/g, "&quot;"\)/.test(APP), "app.js");
  check("a file import names the file", /setSource\("📄 " \+ file\.name, x\.sheet\)/.test(APP), "app.js");
  check("…a CSV too, which has no tab", /setSource\("📄 " \+ file\.name, ""\)/.test(APP), "app.js");
  /* structural rather than literal: the catch block has grown a line (the tab list is cleared
     too), and pinning its exact spelling made a correct change read as a regression */
  {
    const at = APP.indexOf("}).catch(function (e) {", APP.indexOf("function loadXlsx"));
    const blk = APP.slice(at, APP.indexOf("});", at));
    check("…and a failed read still says which file failed",
      /setSource\("📄 " \+ file\.name, ""\)/.test(blk) &&
      /\$\("impNote"\)\.textContent = importSrc \+ " — " \+ t\("imp_excel_fail"\)/.test(blk),
      "app.js");
    /* a workbook that would not open must not leave its tab list behind for the next import */
    check("…and forgets the tabs it could not read", /clearSheetPicker\(\);/.test(blk), "app.js");
  }

  check("a Google Sheet reads its name off Content-Disposition",
    /r\.headers\.get\("content-disposition"\)/.test(APP), "app.js");
  check("…splitting '<Spreadsheet> - <Tab>'", /nm\.lastIndexOf\(" - "\)/.test(APP), "app.js");
  check("…and falling back to the gid when the header is not there",
    /setSource\("↧ " \+ \(nm \|\| t\("src_link"\)\), nm \? "" : "gid " \+ gid\)/.test(APP), "app.js");

  check("a paste says so as well", /setSource\(t\("src_paste"\), ""\)/.test(APP), "app.js");
  /* both of them: the line on screen and the plain source that travels in the checkpoint. Leaving
     srcBase behind would put the old file's name into the next run's checkpoint. */
  check("Clear forgets the source", /importSrc = srcBase = "";/.test(APP), "app.js");
  check("the note leads with it",
    /importSrc \? '<span class="isrc">' \+ esc\(importSrc\) \+ "<\/span><br>" : ""/.test(APP), "app.js");
}

/* ---- the wording, in both languages ---- */
{
  ["src_sheet", "src_link", "src_paste"].forEach(function (k) {
    const m = APP.match(new RegExp(k + ': \\{ bn: "([^"]*)", en: "([^"]*)" \\}'));
    check(k + " exists in both languages", !!m, k);
    if (m) check(k + " — the English carries no Bangla", !/[ঀ-৿]/.test(m[2]), m[2]);
  });
  const HTML = fs.readFileSync(path.join(__dirname, "..", "app.html"), "utf8");
  check("the source line has a style of its own", /\.isrc\{/.test(HTML), "app.html");
  check("…and long names wrap instead of stretching the card", /overflow-wrap:anywhere/.test(HTML.slice(HTML.indexOf(".isrc{"), HTML.indexOf(".isrc{") + 220)), "app.html");
}

/* ---- and a run that was picked up rather than begun ----
   A resumed run reads its rows out of the checkpoint, so there is no file to name — and it used to
   say only "an unfinished run", which is the whole invisibility this file exists to prevent,
   returning for the run that has been going longest. The source travels with the checkpoint. */
{
  /* One turn of the cycle, driven by the real statements: what ckResume() assigns when a
     checkpoint comes back, and which of those ckMeta() then hands to the next checkpoint. The two
     have to be read together — a source that is displayed correctly and stored wrongly looks
     right once and wrong for ever after. */
  const ckMetaSrc = (/  function ckMeta\(done\) \{[\s\S]*?\n  \}/.exec(APP) || [""])[0];
  const resume = (/srcBase = got\.meta\.src[^\n]*\n[^\n]*importSrc = [^;]+;|importSrc = got\.meta\.src[^;]+;/
    .exec(APP) || [""])[0];
  const field = (/src: (\w+) \};/.exec(ckMetaSrc) || [])[1];
  check("ckMeta() is where the checkpoint's facts are written", !!ckMetaSrc, "app.js");
  check("…and it carries a source", !!field, "ckMeta");
  check("ckResume() rebuilds the note from it", !!resume, JSON.stringify(resume.slice(0, 50)));

  const round = new Function("got", "t", "was",
    "let importSrc = was, srcBase = was;\n" + resume +
    "\nreturn { shown: importSrc, stored: " + field + " };");
  const T_ = (k) => (k === "ck_src" ? "আগের অসম্পূর্ণ রান" : k);
  const turn = (stored) => round({ meta: { src: stored } }, T_, stored || "");

  check("a resumed run names the file beside the fact that it was resumed",
    turn("students.xlsx  ·  শিট: Reg").shown === "students.xlsx  ·  শিট: Reg  ·  আগের অসম্পূর্ণ রান",
    turn("students.xlsx  ·  শিট: Reg").shown);
  check("…while an older checkpoint, which carries no source, still says something true",
    turn(undefined).shown === "আগের অসম্পূর্ণ রান" && turn("").shown === "আগের অসম্পূর্ণ রান",
    JSON.stringify(turn(undefined).shown) + " / " + JSON.stringify(turn("").shown));

  /* A run can be picked up more than once — stopped at lunch, again at five, again the next
     morning — and what went into the checkpoint was the LINE, not the source. So the second
     resume stored "…xlsx · an unfinished run" and the third read back
     "…xlsx · an unfinished run · an unfinished run", once more every time it was picked up. */
  {
    let stored = "2026 -- Raahat.xlsx  ·  শিট: 2026";
    const seen = [];
    for (let i = 0; i < 3; i++) {
      const r = turn(stored);
      seen.push(r.shown);
      stored = r.stored;
    }
    check("picking a run up three times does not stack the words",
      seen.every((l) => (l.match(/অসম্পূর্ণ/g) || []).length === 1), seen[2]);
    check("…and the file is still named, every time",
      seen.every((l) => l.indexOf("2026 -- Raahat.xlsx") === 0), seen[2]);
  }
}

console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
process.exit(fail ? 1 : 0);
