/* The saved workbook carries two tabs: what needs a person, and what came out clean.
 *
 * One sheet of ninety thousand rows with a Status column is a sheet somebody has to filter before
 * it says anything. The split the tool already makes on screen — the Total Problem tile — is worth
 * making in the file too, so the tab that matters opens directly.
 *
 * The danger is entirely in the three parts that name the sheets. Content types, the workbook and
 * its relationships each list the worksheets, and Excel does not refuse a workbook whose parts
 * disagree — it "repairs" it, which means opening it empty. So this does not check that a writer
 * ran: it takes the file apart with an independent reader and checks the three lists against each
 * other and against what is actually in the zip.
 *
 *   node tests/two-tabs.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

/* The zip/worksheet writer moved to lib/xlsx.js (app.js keeps thin references), so the source the
   src()/line() helpers read is xlsx.js concatenated BEFORE app.js — name-based extraction then
   finds the real `function foo` there before app.js's thin `const foo = self.XLSX.foo`. buildBook/
   buildXlsx/buildBookSplit/xlsxTab stay in app.js and are still found there. */
const APP = fs.readFileSync(path.join(__dirname, "..", "lib", "xlsx.js"), "utf8") + "\n" +
  fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

let fail = 0;
const check = (name, ok, extra) => {
  if (!ok) fail++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (extra !== undefined ? "   " + extra : ""));
};
function src(name) {
  let at = APP.indexOf("function " + name + "(");
  const star = APP.indexOf("function* " + name + "(");
  if (star >= 0 && (at < 0 || star < at)) at = star;
  if (at < 0) throw new Error("no such function: " + name);
  if (APP.slice(at - 6, at) === "async ") at -= 6;
  let d = 0;
  for (let j = APP.indexOf("{", at); j < APP.length; j++) {
    if (APP[j] === "{") d++;
    else if (APP[j] === "}") { d--; if (!d) return APP.slice(at, j + 1); }
  }
  throw new Error("unbalanced " + name);
}
const line = (re) => { const m = re.exec(APP); if (!m) throw new Error("not found: " + re); return m[0]; };

/* the shipping writer */
const W = new Function("CompressionStream", "Response", "TextEncoder", "srvMode", "notOk", "t",
  line(/const CRC = \(function \(\) \{.*\n/) +
  ["xesc", "cl", "crc32Run", "crc32", "cat", "deflateRaw", "deflateChunks", "zipPack",
    "rowXml", "sheetChunks", "ctXml", "tabName", "wbXml", "wbrXml",
    "xlsxTab", "buildBook", "buildXlsx", "buildBookSplit"].map(src).join("\n") +
  line(/const FILL_STYLE = .*\n/) + line(/const LINK_STYLE = .*\n/) +
  line(/const XLSX_MAX_ROWS = .*\n/) + line(/const RELS = .*\n/) + line(/const STY = .*\n/) +
  "\nreturn { buildBook: buildBook, buildXlsx: buildXlsx, buildBookSplit: buildBookSplit," +
  " tabName: tabName, xlsxTab: xlsxTab };"
)(CompressionStream, Response, TextEncoder, true,
  (st) => st !== "ok", (k) => ({ tab_all: "Result", tab_problem: "Problems", tab_ok: "Matched",
    xlsx_toobig: "too big: {n} of {m}" })[k] || k);

/* an independent reader */
function readZip(b) {
  let eocd = -1;
  for (let i = b.length - 22; i >= 0; i--) if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("no end-of-central-directory record");
  const n = b.readUInt16LE(eocd + 10);
  let off = b.readUInt32LE(eocd + 16);
  const out = {};
  for (let k = 0; k < n; k++) {
    if (b.readUInt32LE(off) !== 0x02014b50) throw new Error("bad central header at entry " + k);
    const method = b.readUInt16LE(off + 10);
    const cs = b.readUInt32LE(off + 20), us = b.readUInt32LE(off + 24);
    const nl = b.readUInt16LE(off + 28), el = b.readUInt16LE(off + 30), cl = b.readUInt16LE(off + 32);
    const lho = b.readUInt32LE(off + 42);
    const name = b.slice(off + 46, off + 46 + nl).toString("utf8");
    if (b.readUInt32LE(lho) !== 0x04034b50) throw new Error("bad local header for " + name);
    const start = lho + 30 + b.readUInt16LE(lho + 26) + b.readUInt16LE(lho + 28);
    const raw = b.slice(start, start + cs);
    const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
    /* bytes against bytes: `us` is the UTF-8 length, and a JavaScript string of Bengali is shorter
       than its own encoding — comparing the two reports every sheet with Bengali in it as corrupt */
    if (data.length !== us) throw new Error("size disagrees for " + name +
      " (" + data.length + " vs " + us + ")");
    out[name] = data.toString("utf8");
    off += 46 + nl + el + cl;
  }
  return out;
}

/* a finished run: some clean, some not, one marked by hand */
function runRows(nOk, nBad) {
  const out = [];
  for (let i = 0; i < nBad; i++) {
    out.push({ status: "Different", reg: String(1900000 + i), spid: String(1600000 + i), program: "",
      link: "https://ums-5.osl.team/x?id=" + i, link2: "https://ums-41.osl.team/x?id=" + i,
      remarks: "টাকার অঙ্ক আলাদা", details: "MRN 2220262250 — Expected 4,636, Actual 0",
      result: "no", raw: "cells", color: "r" });
  }
  for (let i = 0; i < nOk; i++) {
    out.push({ status: "Identical", reg: String(2000000 + i), spid: String(1700000 + i), program: "",
      link: "https://ums-5.osl.team/y?id=" + i, link2: "https://ums-41.osl.team/y?id=" + i,
      remarks: "দুই সার্ভারে হুবহু এক", details: "", result: "ok", raw: "", color: "g" });
  }
  return out;
}

(async function () {
  /* ---------- the saved workbook ---------- */
  const rows = runRows(120, 30);
  let files;
  try { files = readZip(Buffer.from(await W.buildBookSplit(rows))); }
  catch (e) { check("the two-tab workbook is a readable zip", false, e.message); return finish(); }

  check("the two-tab workbook is a readable zip", true, Object.keys(files).length + " parts");
  check("there are two worksheets in it",
    !!files["xl/worksheets/sheet1.xml"] && !!files["xl/worksheets/sheet2.xml"] &&
    !files["xl/worksheets/sheet3.xml"], Object.keys(files).filter((k) => /worksheets/.test(k)).join(", "));

  /* the three lists that name the sheets, checked against each other — Excel does not refuse a
     workbook whose parts disagree, it opens it empty */
  const wb = files["xl/workbook.xml"], rels = files["xl/_rels/workbook.xml.rels"], ct = files["[Content_Types].xml"];
  const named = (wb.match(/<sheet [^>]*name="([^"]*)"/g) || []).map((s) => /name="([^"]*)"/.exec(s)[1]);
  check("the workbook names both tabs", named.length === 2, named.join(" | "));
  check("…and every sheet has a relationship pointing at a part that exists",
    named.every(function (n, i) {
      const m = new RegExp('Id="rId' + (i + 1) + '"[^>]*Target="(worksheets/sheet\\d+\\.xml)"').exec(rels);
      return m && files["xl/" + m[1]];
    }), rels.slice(0, 200));
  check("…and the styles part did not lose its id to a new sheet",
    /Id="rId3"[^>]*Target="styles\.xml"/.test(rels) && !!files["xl/styles.xml"], "rId3");
  check("…and content types declares exactly the sheets that are there",
    (ct.match(/worksheets\/sheet\d+\.xml/g) || []).length === 2, ct.match(/worksheets\/sheet\d+\.xml/g));

  /* ---------- the split is the one the tiles make ---------- */
  const s1 = files["xl/worksheets/sheet1.xml"], s2 = files["xl/worksheets/sheet2.xml"];
  const rowsIn = (s) => (s.match(/<row /g) || []).length - 1;      // less the header
  check("the problems tab holds every student that needs one", rowsIn(s1) === 30, rowsIn(s1) + " rows");
  check("…and the clean tab holds the rest", rowsIn(s2) === 120, rowsIn(s2) + " rows");
  check("…so between them they hold the whole run", rowsIn(s1) + rowsIn(s2) === rows.length,
    rowsIn(s1) + " + " + rowsIn(s2) + " of " + rows.length);
  /* named[] holds the names themselves, not the name="…" attributes they came out of */
  check("the problems tab is first — it is the one being opened for",
    /^Problems/.test(named[0]), named.join(" | "));
  check("…and each tab says how many are on it", /\(30\)/.test(named[0]) && /\(120\)/.test(named[1]),
    named.join(" | "));
  /* Being first and being the tab that OPENS are two different things. With neither declared every
     reader decides for itself, and a report saved to put the problems in front of someone would
     open on whichever tab that reader preferred. Both halves have to say the same thing. */
  check("…and the workbook says that tab is the one to open",
    /<workbookView[^>]*activeTab="0"/.test(wb),
    (/<bookViews>[\s\S]*?<\/bookViews>/.exec(wb) || ["absent"])[0]);
  check("…and that sheet agrees it is the selected one",
    /<sheetViews><sheetView tabSelected="1"/.test(s1) && !/tabSelected="1"/.test(s2),
    "sheet1 " + (/tabSelected/.test(s1) ? "selected" : "not") +
    ", sheet2 " + (/tabSelected/.test(s2) ? "selected" : "not"));
  /* the schema fixes the order: sheetViews before cols, or the workbook is repaired — emptied */
  check("…with sheetViews before cols, as the schema requires",
    s1.indexOf("<sheetViews>") > 0 && s1.indexOf("<sheetViews>") < s1.indexOf("<cols>"),
    "sheetViews at " + s1.indexOf("<sheetViews>") + ", cols at " + s1.indexOf("<cols>"));
  check("no clean student strayed onto the problems tab", !/2000000/.test(s1), "sheet1");
  check("…and no problem strayed onto the clean one", !/1900000/.test(s2), "sheet2");

  /* ---------- an empty half is still a tab ---------- */
  {
    const only = readZip(Buffer.from(await W.buildBookSplit(runRows(5, 0))));
    check("a run with nothing wrong still writes both tabs",
      !!only["xl/worksheets/sheet1.xml"] && !!only["xl/worksheets/sheet2.xml"],
      Object.keys(only).filter((k) => /worksheets/.test(k)).join(", "));
    check("…with the problems tab empty rather than missing",
      (only["xl/worksheets/sheet1.xml"].match(/<row /g) || []).length === 1, "header only");
  }

  /* ---------- the ⬇ button is still one tab ---------- */
  {
    const one = readZip(Buffer.from(await W.buildXlsx(rows)));
    check("the download button still writes one tab", !one["xl/worksheets/sheet2.xml"],
      Object.keys(one).filter((k) => /worksheets/.test(k)).join(", "));
    check("…holding everything the filter selected",
      (one["xl/worksheets/sheet1.xml"].match(/<row /g) || []).length - 1 === rows.length,
      (one["xl/worksheets/sheet1.xml"].match(/<row /g) || []).length - 1 + " rows");
  }

  /* ---------- a tab name Excel will accept ---------- */
  {
    check("a tab name is trimmed to what Excel allows",
      W.tabName("a:b\\c/d?e*f[g]h", 1) === "a b c d e f g h", JSON.stringify(W.tabName("a:b\\c/d?e*f[g]h", 1)));
    check("…and never longer than 31 characters",
      W.tabName("x".repeat(60), 1).length === 31, W.tabName("x".repeat(60), 1).length);
    check("…and never empty", W.tabName("", 3) === "Sheet3" && W.tabName("///", 2) === "Sheet2",
      W.tabName("", 3) + " / " + W.tabName("///", 2));
  }

  finish();
})().catch(function (e) { check("the writer ran", false, (e && e.stack) || e); finish(); });

function finish() {
  console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
  process.exit(fail ? 1 : 0);
}
