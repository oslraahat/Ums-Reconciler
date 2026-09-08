/* The three reports, and the bytes they no longer spend.
 *
 * Measured at 100,000 students in two-server mode, before and after:
 *
 *   report.xlsx    4.07 MB → 1.96 MB      the cells stopped carrying their own addresses
 *   report.html   30.20 MB → 26.48 MB     the cells stopped carrying classes for where they are
 *   text dump      3.40 MB →  2.75 MB     the rules stopped being 78 characters wide
 *
 * The workbook is the interesting one. Every r="A2" is a different string, sprinkled between every
 * pair of compressible cells, and that is what stops deflate finding matches — dropping it is
 * worth half the file and a third of the time. It is also the one with a risk: r is optional in
 * the schema, but a workbook Excel dislikes is repaired rather than refused, and a repaired
 * workbook opens empty. Excel itself was asked, through COM, and reads every value in its right
 * column; what this file can check without Excel is that the shape it read is still the shape
 * being written.
 *
 * Not done, and worth writing down: the page carries its sentences in full, and almost all of them
 * are the same sentence. Shipping the words once and building the rows on open makes it 3.8 MB
 * instead of 26.3 — and 13.4 seconds to become usable instead of 5.4, because the browser's parser
 * builds rows faster than any loop can. Smaller and slower is not an improvement.
 *
 *   node tests/lean-files.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const APP = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

let fail = 0;
const check = (name, ok, extra) => {
  if (!ok) fail++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (!ok && extra !== undefined ? "   " + extra : ""));
};
function lift(name) {
  const at = APP.search(new RegExp("\\n  (?:(?:async )?function\\*? " + name + "\\s*\\(|const " + name + "\\s*=)"));
  if (at < 0) throw new Error("missing " + name);
  const eol = APP.indexOf("\n", at + 1), brace = APP.indexOf("{", at);
  if (brace < 0 || brace > eol) return APP.slice(at, eol + 1);
  let i = brace, d = 0;
  for (let j = i; j < APP.length; j++) {
    if (APP[j] === "{") d++;
    else if (APP[j] === "}") { d--; if (!d) { i = j; break; } }
  }
  let end = i + 1;
  while (end < APP.length && /[)(;\s]/.test(APP[end]) && APP[end] !== "\n") end++;
  return APP.slice(at, end);
}

const HEAD = ["Status", "Student Reg", "Program Id", "Expected Link", "Actual Link", "Remarks", "Details"];
const D_OK = "দুই সার্ভারে হুবহু এক — Program Wise ৪ · Course Wise ১১ সারি মিলেছে";

/* ---------- the worksheet ---------- */
{
  const W = new Function("srvMode",
    ["xesc", "cl", "FILL_STYLE", "LINK_STYLE", "rowXml", "sheetChunks", "sheetXml"].map(lift).join("\n") +
    "\nreturn { sheetXml: sheetXml, rowXml: rowXml };")(true);

  const rows = [], colors = [];
  for (let i = 0; i < 200; i++) {
    rows.push(["দুই সার্ভারে এক", String(1000000 + i), String(9000000 + i),
      "https://ums-5.osl.team/x?id=" + i, "https://ums-41.osl.team/x?id=" + i, D_OK, ""]);
    colors.push(i % 20 === 0 ? "r" : "g");
  }
  const xml = W.sheetXml(HEAD, rows, colors, [3, 4]);

  /* the saving, and the reason for it */
  check("no cell carries its own address", !/<c r="/.test(xml),
    (xml.match(/<c r="[A-Z]+\d+"/) || ["none"])[0]);
  /* …while the row keeps its own, which is what anchors the sheet absolutely */
  check("…while every row still carries its number",
    (xml.match(/<row r="\d+">/g) || []).length === rows.length + 1,
    (xml.match(/<row r="\d+">/g) || []).length + " of " + (rows.length + 1));
  check("the cells are still written in order, with none skipped",
    (xml.match(/<row r="2">[\s\S]*?<\/row>/)[0].match(/<c[ >]/g) || []).length === HEAD.length,
    (xml.match(/<row r="2">[\s\S]*?<\/row>/)[0].match(/<c[ >]/g) || []).length + " cells of " + HEAD.length);

  check("the default style is not spelled out", !/ s="0"/.test(xml), 's="0" found');
  /* a coloured row and the header still say which style they want */
  check("…but a coloured row still says which fill it wants", / s="2"/.test(xml), "s=2");
  check("…and the header says its own", / s="3"/.test(xml), "s=3");
  /* xml:space matters only to text with a space at either end */
  check("xml:space is written only where a space would be lost",
    !/xml:space/.test(xml), (xml.match(/.{0,30}xml:space.{0,20}/) || ["none"])[0]);
  {
    const pad = W.sheetXml(["A"], [[" leading and trailing "]], ["g"], []);
    check("…and is written when it would be", /xml:space="preserve"/.test(pad), pad.slice(-160));
  }

  /* the links are still formulas, still openable */
  check("the link cells are still HYPERLINK formulas",
    (xml.match(/<f>HYPERLINK\(/g) || []).length === rows.length * 2,
    (xml.match(/<f>HYPERLINK\(/g) || []).length + " of " + rows.length * 2);

  /* and what all of that is for */
  const before = xml.replace(/<c( s="\d+")? t="inlineStr"><is><t>/g, function (m, s) {
    return '<c r="A1"' + (s || ' s="0"') + ' t="inlineStr"><is><t xml:space="preserve">';
  });
  const now = zlib.deflateRawSync(Buffer.from(xml, "utf8")).length;
  const was = zlib.deflateRawSync(Buffer.from(before, "utf8")).length;
  check("…and the sheet deflates smaller for it", now < was,
    (was / 1024).toFixed(0) + " KB → " + (now / 1024).toFixed(0) + " KB");
}

/* ---------- the page ---------- */
{
  /* not indexOf("const html = ") for the end — resolvePrograms has one of those a thousand lines
     earlier, so the slice comes out backwards and empty, and every check inside it passes on air */
  const from = APP.indexOf("const LK = srvMode");
  const to = APP.indexOf("const html = '<!doctype", from);
  if (from < 0 || to < 0) throw new Error("could not find the page's row writer");
  const body = APP.slice(from, to);
  /* which column a cell is in is what those classes were saying */
  check("the page's cells carry no class", !/<td class=/.test(body),
    (body.match(/<td class="[^"]*"/) || ["none"])[0]);
  check("…and the status attribute is one character",
    /'<tr d="' \+ r\.result \+ '">'/.test(body), body.slice(0, 120));
  /* the stylesheet has to read the same attribute the rows are written with */
  check("the stylesheet reads the attribute the rows carry",
    /tr\[d=ok\]/.test(APP) && !/tr\[data-st=/.test(APP), "buildHtml css");
  check("…and so does the filter the page ships with",
    /tr\.getAttribute\("d"\)/.test(APP), "the report's own script");
  /* the columns the CSS now addresses by position have to be the link columns */
  check("the link colour is applied to the columns the links are in",
    /#tb td:nth-child\(4\) a,#tb td:nth-child\(5\) a/.test(APP), "buildHtml css");
}

/* ---------- the text dump ---------- */
{
  const R = new Function("ver", "baseUrl", lift("buildRaw") + "\nreturn buildRaw;")(
    () => "0", "https://ums-5.osl.team");
  const rows = [];
  for (let i = 0; i < 50; i++) {
    rows.push({ status: "ডেটা আলাদা", reg: String(1900000 + i), spid: String(1600000 + i),
      program: "", remarks: "টাকার অঙ্ক আলাদা", raw: "MRN\tCRN\tDate\n2220262250\t-\t19/12/2022\n" });
  }
  const txt = R(rows);
  /* a fifth of the file was two seventy-eight-character rules per student */
  check("no rule is 78 characters wide", !/[-=]{40}/.test(txt),
    (txt.match(/[-=]{40,}/) || ["none"])[0]);
  check("…and the students are still separated", /\n\n/.test(txt) && /-{10,}/.test(txt),
    JSON.stringify(txt.slice(0, 120)));
  /* what the file is actually for */
  check("every student's cells are still there",
    (txt.match(/2220262250/g) || []).length === rows.length,
    (txt.match(/2220262250/g) || []).length + " of " + rows.length);
  check("…each under its own heading",
    (txt.match(/reg 19000\d\d/g) || []).length === rows.length,
    (txt.match(/reg 19000\d\d/g) || []).length + " of " + rows.length);
}

console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
process.exit(fail ? 1 : 0);
