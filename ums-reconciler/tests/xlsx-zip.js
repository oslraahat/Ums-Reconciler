/* The Excel report is a real zip, and now a compressed one.
 *
 * Written with zip STORE, a 100,000-row report came out at 79 MB — the size of its own XML, which
 * is a file nobody can mail and Excel opens slowly. Deflated it is 3.2 MB for about a third of a
 * second's work, and XML of repeated tags is exactly what deflate is best at.
 *
 * The risk is entirely in the headers: compression adds a method field and a separate compressed
 * size to both the local and the central record, and a reader that disagrees with any of them
 * shows a corrupt-file dialog rather than a spreadsheet. So this does not check that the writer
 * ran — it takes the file apart again with an independent reader and verifies every CRC.
 *
 *   node tests/xlsx-zip.js
 */
"use strict";
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

/* The zip/worksheet writer moved to lib/xlsx.js (app.js keeps thin references), so the source the
   src()/line() helpers read is xlsx.js concatenated BEFORE app.js — name-based extraction then
   finds the real `function foo` there before app.js's thin `const foo = self.XLSX.foo`. */
const APP = fs.readFileSync(path.join(__dirname, "..", "lib", "xlsx.js"), "utf8") + "\n" +
  fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

let fail = 0;
const check = (name, ok, extra) => {
  if (!ok) fail++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (extra !== undefined ? "   " + extra : ""));
};
function src(name) {
  /* `function*` too: the worksheet writer is a generator, and indexOf("function name(") walks
     straight past it and then reports a function that is plainly in the file as missing. */
  let at = APP.indexOf("function " + name + "(");
  const star = APP.indexOf("function* " + name + "(");
  if (star >= 0 && (at < 0 || star < at)) at = star;
  if (at < 0) throw new Error("no such function: " + name);
  if (APP.slice(at - 6, at) === "async ") at -= 6;
  let depth = 0;
  for (let j = APP.indexOf("{", at); j < APP.length; j++) {
    if (APP[j] === "{") depth++;
    else if (APP[j] === "}") { depth--; if (!depth) return APP.slice(at, j + 1); }
  }
  throw new Error("unbalanced " + name);
}
const line = (re) => { const m = re.exec(APP); if (!m) throw new Error("not found: " + re); return m[0]; };

/* the shipping writer, lifted whole */
const W = new Function("CompressionStream", "Response", "TextEncoder",
  line(/const CRC = \(function \(\) \{.*\n/) +
  /* crc32Run and deflateChunks came in with the streamed worksheet: an entry that is never
     assembled still has to be checksummed and sized as its pieces go past. */
  ["xesc", "cl", "crc32Run", "crc32", "cat", "deflateRaw", "deflateChunks",
    "zipPack", "zipStore", "rowXml", "sheetChunks", "sheetXml"].map(src).join("\n") +
  line(/const FILL_STYLE = .*\n/) + line(/const LINK_STYLE = .*\n/) +
  line(/const XLSX_MAX_ROWS = .*\n/) +
  "\nreturn { zipPack: zipPack, zipStore: zipStore, crc32: crc32, sheetXml: sheetXml," +
  " sheetChunks: sheetChunks, XLSX_MAX_ROWS: XLSX_MAX_ROWS };"
)(CompressionStream, Response, TextEncoder);

/* an independent reader: central directory, local headers, inflate, CRC */
function readZip(b) {
  let eocd = -1;
  for (let i = b.length - 22; i >= 0; i--) if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("no end-of-central-directory record");
  const n = b.readUInt16LE(eocd + 10);
  let off = b.readUInt32LE(eocd + 16);
  const out = [];
  for (let k = 0; k < n; k++) {
    if (b.readUInt32LE(off) !== 0x02014b50) throw new Error("bad central header at entry " + k);
    const method = b.readUInt16LE(off + 10), crc = b.readUInt32LE(off + 16);
    const cs = b.readUInt32LE(off + 20), us = b.readUInt32LE(off + 24);
    const nl = b.readUInt16LE(off + 28), el = b.readUInt16LE(off + 30), cl = b.readUInt16LE(off + 32);
    const lho = b.readUInt32LE(off + 42);
    const name = b.slice(off + 46, off + 46 + nl).toString("utf8");
    if (b.readUInt32LE(lho) !== 0x04034b50) throw new Error("bad local header for " + name);
    /* the two records have to agree, or a reader trusting the other one reads garbage */
    if (b.readUInt16LE(lho + 8) !== method) throw new Error("method disagrees for " + name);
    if (b.readUInt32LE(lho + 18) !== cs) throw new Error("compressed size disagrees for " + name);
    if (b.readUInt32LE(lho + 22) !== us) throw new Error("size disagrees for " + name);
    const start = lho + 30 + b.readUInt16LE(lho + 26) + b.readUInt16LE(lho + 28);
    const raw = b.slice(start, start + cs);
    out.push({ name, method, cs, us, crc, data: method === 8 ? zlib.inflateRawSync(raw) : raw });
    off += 46 + nl + el + cl;
  }
  return out;
}

const enc = new TextEncoder();
/* a sheet with the shape a real report has: many rows, repeated tags, Bengali in the cells */
let xml = '<?xml version="1.0"?><worksheet><sheetData>';
for (let i = 0; i < 4000; i++) {
  xml += '<row r="' + (i + 1) + '"><c t="inlineStr"><is><t>' + (1400000 + i) + '</t></is></c>' +
    '<c t="inlineStr"><is><t>Due ভুল · [Course Wise] Engineering Full Cours · CRN 9643214615</t></is></c></row>';
}
xml += "</sheetData></worksheet>";

const parts = [
  { name: "[Content_Types].xml", data: enc.encode('<?xml version="1.0"?><Types/>') },
  { name: "_rels/.rels", data: enc.encode('<?xml version="1.0"?><Relationships/>') },
  { name: "xl/worksheets/sheet1.xml", data: enc.encode(xml) }
];

W.zipPack(parts).then(async function (bytes) {
  const buf = Buffer.from(bytes);
  let files;
  try { files = readZip(buf); }
  catch (e) { check("the workbook is a readable zip", false, e.message); return finish(); }

  check("the workbook is a readable zip", true, files.length + " entries, " + (buf.length / 1024).toFixed(0) + " KB");
  check("every part is present and named",
    files.map((f) => f.name).join(",") === parts.map((p) => p.name).join(","),
    files.map((f) => f.name).join(", "));
  check("every entry inflates to its declared size", files.every((f) => f.data.length === f.us),
    files.map((f) => f.data.length + "/" + f.us).join(" "));
  /* the CRC is what a reader validates against — a wrong one is a corrupt-file dialog, not a warning */
  check("…and matches the CRC written for it", files.every((f) => W.crc32(f.data) === f.crc),
    files.filter((f) => W.crc32(f.data) !== f.crc).map((f) => f.name).join(", ") || "all match");
  check("…byte for byte what went in",
    files.every((f, i) => Buffer.from(parts[i].data).equals(f.data)));

  const sheet = files[2];
  check("the sheet is deflated, not stored", sheet.method === 8, "method " + sheet.method);
  check("…and much smaller for it", sheet.cs < sheet.us / 5,
    (sheet.us / 1024).toFixed(0) + " KB → " + (sheet.cs / 1024).toFixed(0) + " KB (" +
    Math.round(100 - sheet.cs / sheet.us * 100) + "% smaller)");
  /* a 30-byte part comes out bigger compressed; storing it is the right answer, not a larger file */
  check("a part that would grow is stored instead",
    files.filter((f) => f.method === 0).every((f) => f.cs === f.us),
    files.filter((f) => f.method === 0).map((f) => f.name).join(", ") || "(none needed it)");

  /* and where the browser has no CompressionStream at all, the old writer still produces a zip */
  const stored = Buffer.from(W.zipStore(parts));
  let s2;
  try { s2 = readZip(stored); } catch (e) { check("the uncompressed fallback still reads", false, e.message); return finish(); }
  check("the uncompressed fallback still reads",
    s2.every((f) => f.method === 0 && W.crc32(f.data) === f.crc), s2.length + " entries");
  check("…and is the bigger file it always was", stored.length > buf.length * 3,
    (stored.length / 1024).toFixed(0) + " KB stored vs " + (buf.length / 1024).toFixed(0) + " KB deflated");

  /* ---- the worksheet written in pieces ---- */
  {
    const HEAD = ["Status", "Reg", "PID", "Link", "Remarks", "Details"];
    const rows = [], colors = [];
    for (let i = 0; i < 2500; i++) {
      const bad = i % 7 === 0;
      rows.push([bad ? "Mismatch" : "Matched", String(1000000 + i), String(9000000 + i),
        "https://ums-5.osl.team/x?id=" + i + '&q="quoted"',
        bad ? "টাকার অঙ্ক আলাদা" : "", "সারি " + i + " — <&> ↗"]);
      colors.push(bad ? "r" : "g");
    }
    /* the same sheet, both ways */
    const whole = W.sheetXml(HEAD, rows, colors, [3]);
    const pieces = [];
    for (const c of W.sheetChunks(HEAD, rows, colors, [3])) pieces.push(c);
    check("the pieces really are pieces", pieces.length >= 3, pieces.length + " chunks for 2,500 rows");
    check("…and they join into exactly what the one-string writer wrote",
      pieces.join("") === whole, "joined " + pieces.join("").length + " vs " + whole.length);

    const enc = new TextEncoder();
    const a = await W.zipPack([{ name: "xl/worksheets/sheet1.xml", data: enc.encode(whole) }]);
    /* chunks MAKES the pieces; it is not the pieces. zipPack may need them twice — once for the
       deflate stream and again to store the entry if that stream fails — and a generator handed
       over directly is spent after the first read. */
    const mk = function () { return W.sheetChunks(HEAD, rows, colors, [3]); };
    const b = await W.zipPack([{ name: "xl/worksheets/sheet1.xml", chunks: mk }]);
    let fa = null, fb = null;
    try { fa = readZip(Buffer.from(a)); fb = readZip(Buffer.from(b)); }
    catch (e) { check("the streamed workbook reads back", false, e.message); }
    if (fa && fb) {
      check("the streamed workbook reads back", fb.length === 1 && fb[0].name === "xl/worksheets/sheet1.xml",
        fb.map(function (f) { return f.name; }).join(","));
      check("…with the same CRC as the one written whole", fa[0].crc === fb[0].crc,
        fa[0].crc + " vs " + fb[0].crc);
      check("…and the same size", fa[0].us === fb[0].us, fa[0].us + " vs " + fb[0].us);
      check("…and the same bytes", Buffer.compare(fa[0].data, fb[0].data) === 0,
        "inflated " + fb[0].data.length + " bytes");
      check("…still deflated, not stored", fb[0].method === 8, "method " + fb[0].method);
    }
    /* and the workbook says so before Excel has to: a sheet with more rows than Excel holds is
       "repaired" — emptied — rather than refused, which is worse than being told */
    check("Excel's row ceiling is written down", W.XLSX_MAX_ROWS === 1048576, W.XLSX_MAX_ROWS);

    /* ---- and the pieces can be asked for twice ----
       zipPack reads them once for the deflate stream and again to store the entry if that stream
       fails. A CompressionStream that dies part-way is the case: with a generator handed over
       directly the second read got what the first had not eaten, which was nothing. */
    {
      function Dying() {
        let wrote = 0;
        this.writable = new WritableStream({ write() { if (++wrote > 1) throw new Error("stream died"); } });
        this.readable = new ReadableStream({ start(c) { c.close(); } });
      }
      const V = new Function("CompressionStream", "Response", "TextEncoder",
        line(/const CRC = \(function \(\) \{.*\n/) +
        ["xesc", "cl", "crc32Run", "crc32", "cat", "deflateRaw", "deflateChunks", "zipPack",
          "rowXml", "sheetChunks"].map(src).join("\n") +
        line(/const FILL_STYLE = .*\n/) + line(/const LINK_STYLE = .*\n/) +
        "\nreturn { zipPack: zipPack, sheetChunks: sheetChunks };"
      )(Dying, Response, TextEncoder);

      const H = ["Status", "Reg", "PID"], rs = [], cs2 = [];
      for (let i = 0; i < 9000; i++) { rs.push(["Matched", String(1000000 + i), String(9000000 + i)]); cs2.push("g"); }
      const z = Buffer.from(await V.zipPack([
        { name: "sheet.xml", chunks: function () { return V.sheetChunks(H, rs, cs2, []); } }
      ]));
      let got = null;
      try { got = readZip(z)[0]; } catch (e) { check("a failed deflate still writes the whole sheet", false, e.message); }
      if (got) {
        const text = got.data.toString("utf8");
        check("a failed deflate still writes the whole sheet",
          (text.match(/<row /g) || []).length === rs.length + 1,
          (text.match(/<row /g) || []).length + " rows of " + (rs.length + 1));
        check("…as well-formed XML", /<\/worksheet>\s*$/.test(text), text.slice(-40));
        check("…stored, since the stream could not compress it", got.method === 0, "method " + got.method);
      }
    }
  }

  finish();
}).catch(function (e) { check("the writer ran", false, e && e.stack || e); finish(); });

function finish() {
  console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
  process.exit(fail ? 1 : 0);
}
