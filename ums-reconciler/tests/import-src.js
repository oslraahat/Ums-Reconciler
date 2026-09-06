/* Which file, and which tab, did these rows come from?
 *
 * Nothing on screen said. Two tabs of one workbook look identical in the preview, and so does last
 * week's copy of the same file — so a run against the wrong sheet was invisible until the numbers
 * came out strange, if ever. The import note now leads with the source.
 *
 * The tab name is the awkward part: the order of <sheet> elements in workbook.xml is NOT the order
 * of the sheetN.xml files, so the name has to be looked up through the relationship id. That
 * lookup is what this checks — with a small XML shim, since node has no DOMParser (the XML parsing
 * itself is the browser's job; the mapping is ours).
 *
 *   node tests/import-src.js
 */
"use strict";
const fs = require("fs");
const path = require("path");

const APP = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

let fail = 0;
const check = (name, ok, extra) => { if (!ok) fail++; console.log((ok ? "PASS  " : "FAIL  ") + name + (!ok && extra ? "   " + extra : "")); };

/* ---- the smallest XML DOM sheetNameOf() actually touches ---- */
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

/* ---- lift sheetNameOf() straight out of app.js so this cannot drift from what ships ---- */
const at = APP.search(/\n  function sheetNameOf\s*\(/);
if (at < 0) { console.log("FAIL  sheetNameOf not found in app.js"); process.exit(1); }
let i = APP.indexOf("{", at), depth = 0, end = -1;
for (let j = i; j < APP.length; j++) {
  if (APP[j] === "{") depth++;
  else if (APP[j] === "}") { depth--; if (!depth) { end = j + 1; break; } }
}
const sheetNameOf = new Function("DOMParser", "RELS_NS",
  APP.slice(at, end) + "; return sheetNameOf;")(DOMParserShim, RELS_NS);

const enc = (s) => new TextEncoder().encode(s);
const dec = new TextDecoder("utf-8");

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
  const f = { "xl/workbook.xml": enc(WB), "xl/_rels/workbook.xml.rels": enc(RELS) };
  // readXlsx prefers sheet1.xml — which here is the SECOND tab, not the first
  check("the tab is found through its r:id, not its order",
    sheetNameOf(f, "xl/worksheets/sheet1.xml", dec) === "ছাত্র তালিকা",
    sheetNameOf(f, "xl/worksheets/sheet1.xml", dec));
  check("…and the other file maps to the other tab",
    sheetNameOf(f, "xl/worksheets/sheet4.xml", dec) === "Summary",
    sheetNameOf(f, "xl/worksheets/sheet4.xml", dec));
}

/* ---- writers that spell the target with a leading path ---- */
{
  const f = {
    "xl/workbook.xml": enc('<?xml version="1.0"?><workbook><sheets><sheet name="Data" r:id="rId1"/></sheets></workbook>'),
    "xl/_rels/workbook.xml.rels": enc('<?xml version="1.0"?><Relationships><Relationship Id="rId1" Target="/xl/worksheets/sheet1.xml"/></Relationships>')
  };
  check("an absolute Target still matches", sheetNameOf(f, "xl/worksheets/sheet1.xml", dec) === "Data",
    sheetNameOf(f, "xl/worksheets/sheet1.xml", dec));
}

/* ---- a missing or broken workbook costs the name, never the import ---- */
{
  check("no workbook.xml → no name, no throw", sheetNameOf({}, "xl/worksheets/sheet1.xml", dec) === "");
  const noRels = { "xl/workbook.xml": enc(WB) };
  check("no rels → falls back to the first tab", sheetNameOf(noRels, "xl/worksheets/sheet1.xml", dec) === "Summary",
    sheetNameOf(noRels, "xl/worksheets/sheet1.xml", dec));
  const junk = { "xl/workbook.xml": enc("<<<not xml at all") };
  check("junk → still no throw", sheetNameOf(junk, "xl/worksheets/sheet1.xml", dec) === "");
}

/* ---- the wiring around it ---- */
{
  check("unzip() keeps workbook.xml and its rels",
    /workbook\\\.xml\|_rels\\\/workbook\\\.xml\\\.rels/.test(APP), "app.js");
  check("readXlsx() hands the tab name back with the rows",
    /return \{ rows: sheet\(dec\.decode\(f\[key\]\), sh\), sheet: sheetNameOf\(f, key, dec\) \}/.test(APP), "app.js");
  check("a file import names the file", /setSource\("📄 " \+ file\.name, x\.sheet\)/.test(APP), "app.js");
  check("…a CSV too, which has no tab", /setSource\("📄 " \+ file\.name, ""\)/.test(APP), "app.js");
  check("…and a failed read still says which file failed",
    /catch\(function \(e\) \{ setSource\("📄 " \+ file\.name, ""\); \$\("impNote"\)/.test(APP.replace(/\s*\n\s*/g, "")) ||
    /setSource\("📄 " \+ file\.name, ""\); \$\("impNote"\)\.textContent = importSrc/.test(APP), "app.js");

  check("a Google Sheet reads its name off Content-Disposition",
    /r\.headers\.get\("content-disposition"\)/.test(APP), "app.js");
  check("…splitting '<Spreadsheet> - <Tab>'", /nm\.lastIndexOf\(" - "\)/.test(APP), "app.js");
  check("…and falling back to the gid when the header is not there",
    /setSource\("↧ " \+ \(nm \|\| t\("src_link"\)\), nm \? "" : "gid " \+ gid\)/.test(APP), "app.js");

  check("a paste says so as well", /setSource\(t\("src_paste"\), ""\)/.test(APP), "app.js");
  check("Clear forgets the source", /importSrc = "";/.test(APP), "app.js");
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

console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
process.exit(fail ? 1 : 0);
