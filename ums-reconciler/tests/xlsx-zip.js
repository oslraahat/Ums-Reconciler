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

const APP = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

let fail = 0;
const check = (name, ok, extra) => {
  if (!ok) fail++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (extra !== undefined ? "   " + extra : ""));
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
const line = (re) => { const m = re.exec(APP); if (!m) throw new Error("not found: " + re); return m[0]; };

/* the shipping writer, lifted whole */
const W = new Function("CompressionStream", "Response", "TextEncoder",
  line(/const CRC = \(function \(\) \{.*\n/) +
  ["crc32", "cat", "deflateRaw", "zipPack", "zipStore"].map(src).join("\n") +
  "\nreturn { zipPack: zipPack, zipStore: zipStore, crc32: crc32 };"
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

W.zipPack(parts).then(function (bytes) {
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

  finish();
}).catch(function (e) { check("the writer ran", false, e && e.stack || e); finish(); });

function finish() {
  console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
  process.exit(fail ? 1 : 0);
}
