/* The spreadsheet / xlsx / zip engine, split out of app.js.
   Pure and stateless: nothing here reaches for the DOM, t(), DICT, srvMode, or any app state, so
   it reads and writes workbooks the same whoever calls it. app.js keeps thin references
   (const foo = self.XLSX.foo) to the handful it still calls directly, and the menus reach readXlsx
   through self.APP, unchanged. Mirrors the menu-wise split (menus/adm, menus/crm use self.APP). */
(function () {
  "use strict";

  /* ---------------- reading an .xlsx ---------------- */
  async function inflateRaw(u8) { const ds = new DecompressionStream("deflate-raw"); const s = new Response(u8).body.pipeThrough(ds); return new Uint8Array(await new Response(s).arrayBuffer()); }
  async function unzip(u8) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let eocd = -1; for (let i = u8.length - 22; i >= 0; i--) { if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; } }
    if (eocd < 0) throw new Error("ZIP নয়");
    const cd = dv.getUint16(eocd + 10, true); let off = dv.getUint32(eocd + 16, true); const td = new TextDecoder("utf-8"); const files = {};
    for (let n = 0; n < cd; n++) {
      if (dv.getUint32(off, true) !== 0x02014b50) break;
      const method = dv.getUint16(off + 10, true), cs = dv.getUint32(off + 20, true), nl = dv.getUint16(off + 28, true), el = dv.getUint16(off + 30, true), cl = dv.getUint16(off + 32, true), lho = dv.getUint32(off + 42, true);
      const fn = td.decode(u8.subarray(off + 46, off + 46 + nl));
      // workbook.xml + its rels come along for the tab name — see sheetNameOf()
      if (/^xl\/(sharedStrings\.xml|workbook\.xml|_rels\/workbook\.xml\.rels|worksheets\/.*\.xml)$/i.test(fn)) { const lnl = dv.getUint16(lho + 26, true), lel = dv.getUint16(lho + 28, true), ds = lho + 30 + lnl + lel; const comp = u8.subarray(ds, ds + cs); files[fn] = method === 0 ? comp.slice() : (method === 8 ? await inflateRaw(comp) : null); }
      off += 46 + nl + el + cl;
    }
    return files;
  }
  function colIdx(ref) { const m = String(ref).match(/^([A-Z]+)/i); if (!m) return -1; const s = m[1].toUpperCase(); let n = 0; for (let i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64); return n - 1; }
  /* Which tab did we just read? workbook.xml carries the names a person sees, but the order of
     <sheet> elements is not the order of the sheetN.xml files — the link between them is the
     relationship id, so it is looked up through the rels rather than by position. Best-effort: an
     unreadable workbook costs the name, never the import. */
  const RELS_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  /* Every tab, in the order Excel shows them along the bottom. workbook.xml carries the names a
     person sees, but the order of its <sheet> elements is NOT the order of the sheetN.xml files —
     the link between them is the relationship id, so it is followed through the rels rather than
     read off the position. Picking by filename is how "the first tab" came to mean sheet1.xml,
     which is frequently the second or third tab and sometimes a Summary nobody meant to import.
     Best effort: an unreadable workbook part costs the names, never the import. */
  function sheetsOf(files, dec) {
    const out = [];
    try {
      const wbx = files["xl/workbook.xml"];
      if (!wbx) return out;
      const rels = {}, rlx = files["xl/_rels/workbook.xml.rels"];
      if (rlx) {
        const rd = new DOMParser().parseFromString(dec.decode(rlx), "application/xml");
        [].slice.call(rd.getElementsByTagName("Relationship")).forEach(function (n) {
          rels[n.getAttribute("Id")] = String(n.getAttribute("Target") || "").replace(/^\/?(xl\/)?/, "");
        });
      }
      const wd = new DOMParser().parseFromString(dec.decode(wbx), "application/xml");
      [].slice.call(wd.getElementsByTagName("sheet")).forEach(function (nd) {
        const rid = nd.getAttributeNS(RELS_NS, "id") || nd.getAttribute("r:id");
        const tgt = (rid && rels[rid]) ? "xl/" + rels[rid] : "";
        /* only tabs whose worksheet actually came out of the zip — a chart sheet has a <sheet>
           entry and no rows, and offering it would be offering an empty import */
        if (tgt && files[tgt]) out.push({ name: nd.getAttribute("name") || tgt, target: tgt });
      });
    } catch (e) {}
    return out;
  }
  function shared(xml) { const out = []; if (!xml) return out; const d = new DOMParser().parseFromString(xml, "application/xml"); const si = d.getElementsByTagName("si"); for (let i = 0; i < si.length; i++) { const ts = si[i].getElementsByTagName("t"); let s = ""; for (let j = 0; j < ts.length; j++) s += ts[j].textContent; out.push(s); } return out; }
  function sheet(xml, sh) { const d = new DOMParser().parseFromString(xml, "application/xml"); const re = d.getElementsByTagName("row"); const rows = []; for (let i = 0; i < re.length; i++) { const cs = re[i].getElementsByTagName("c"); const arr = []; for (let j = 0; j < cs.length; j++) { const c = cs[j]; let idx = c.getAttribute("r") ? colIdx(c.getAttribute("r")) : j; if (idx < 0) idx = j; const t = c.getAttribute("t"); let v = ""; if (t === "s") { const vv = c.getElementsByTagName("v")[0]; if (vv) v = sh[parseInt(vv.textContent, 10)] || ""; } else if (t === "inlineStr") { const is = c.getElementsByTagName("t")[0]; if (is) v = is.textContent; } else { const vv = c.getElementsByTagName("v")[0]; if (vv) v = vv.textContent; } arr[idx] = v; } for (let k = 0; k < arr.length; k++) if (arr[k] === undefined) arr[k] = ""; rows.push(arr); } return rows.filter(function (r) { return r.some(function (c) { return String(c).trim() !== ""; }); }); }
  /** want: the target of the tab to read; omitted means the workbook's FIRST tab. */
  async function readXlsx(buf, want) {
    const f = await unzip(new Uint8Array(buf));
    const dec = new TextDecoder("utf-8");
    const sh = shared(f["xl/sharedStrings.xml"] ? dec.decode(f["xl/sharedStrings.xml"]) : "");
    const tabs = sheetsOf(f, dec);
    /* The workbook's order first, so "the first tab" means what it means in Excel. The filename
       guess is only a last resort, for a workbook whose own index will not parse. */
    let key = (want && f[want]) ? want : ((tabs[0] && tabs[0].target) || "");
    if (!key) {
      key = Object.keys(f).find(function (x) { return /^xl\/worksheets\/sheet1\.xml$/i.test(x); }) ||
        Object.keys(f).find(function (x) { return /^xl\/worksheets\/.*\.xml$/i.test(x); });
    }
    if (!key) throw new Error("worksheet নেই");
    const hit = tabs.filter(function (x) { return x.target === key; })[0];
    return { rows: sheet(dec.decode(f[key]), sh), sheet: hit ? hit.name : "", sheets: tabs, target: key };
  }

  /* ---------------- writing an .xlsx ---------------- */
  const CRC = (function () { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
  /* Carried across chunks, so a worksheet that is never assembled can still be checksummed. */
  function crc32Run(c, u8) { for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return c; }
  function crc32(u8) { return (crc32Run(0xFFFFFFFF, u8) ^ 0xFFFFFFFF) >>> 0; }
  function cat(a) { let n = 0; a.forEach(function (x) { n += x.length; }); const o = new Uint8Array(n); let p = 0; a.forEach(function (x) { o.set(x, p); p += x.length; }); return o; }
  function xesc(s) { return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
  function cl(n) { let s = ""; n++; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
  /* the fill a row's colour maps to, and the same fill wearing the link font */
  const FILL_STYLE = { g: 1, r: 2, y: 4 };
  const LINK_STYLE = { g: 6, r: 7, y: 8 };

  /** One row, as XML. Both writers below call this, so the streaming one and the whole-string one
      cannot drift into producing different workbooks.
      linkCols: column indexes holding a URL. They are written as HYPERLINK() and read "Open ↗". */
  /* Cells carry no r="A2".
     Every one of those is a different string sprinkled between every pair of compressible cells,
     and that is what stops deflate finding matches: dropping it takes the report from 3.97 MB to
     1.94 at 100,000 students, and a third off the time. The attribute is optional — a reader takes
     the cells in order — and every row below writes every column with no gaps, so order says
     exactly what the address said. The row keeps its own r=, which anchors it absolutely.
     Excel was asked rather than trusted: it opens the file, both tabs, every value in its right
     column, the Bengali intact and the HYPERLINK formula live, and repairs nothing.

     s="0" is the default style, and xml:space only matters to text with a space at either end. */
  function rowXml(row, rn, cc, isLink, isHeader) {
    const s = isHeader ? 3 : (FILL_STYLE[cc] || 0);
    let x = '<row r="' + rn + '">';
    row.forEach(function (cell, ci) {
      if (!isHeader && isLink[ci] && cell) {
        /* A formula, not a hyperlink relationship: Excel caps those at 65,530 per sheet and a
           100,000-row report in two-server mode would want 200,000, at which point Excel
           "repairs" the file by dropping them all. A double quote inside a formula string is
           written twice; a URL built with encodeURIComponent has none, but a hand-edited base
           address could. */
        const url = String(cell).replace(/"/g, '""');
        x += '<c s="' + (LINK_STYLE[cc] || 5) + '" t="str">' +
          "<f>HYPERLINK(&quot;" + xesc(url) + "&quot;,&quot;Open ↗&quot;)</f><v>Open ↗</v></c>";
        return;
      }
      const v = String(cell == null ? "" : cell);
      x += "<c" + (s ? ' s="' + s + '"' : "") + ' t="inlineStr"><is><t' +
        (/^\s|\s$/.test(v) ? ' xml:space="preserve"' : "") + ">" + xesc(v) + "</t></is></c>";
    });
    return x + "</row>";
  }

  /* The worksheet in pieces, front to back.
     Nothing needs the whole thing to exist at once — it is written once, straight into a deflate
     stream — and a JavaScript string cannot exceed about 512 MB, which 560,000 students cross.
     Measured: at 500,000 the XML is 479 MB and the workbook takes seven seconds; at 560,000 the
     old writer threw "Invalid string length" and produced no file at all, at the end of a run
     that had taken hours. */
  function* sheetChunks(header, rows, colors, linkCols, per, selected) {
    const isLink = {}; (linkCols || []).forEach(function (i) { isLink[i] = 1; });
    // Remarks and Details need room; the rest are short. A link column shows six characters now,
    // not a hundred-and-twenty-character query string, so it can be narrow.
    const W = header.length >= 7 ? [14, 12, 12, 11, 11, 62, 90] : [14, 12, 12, 11, 62, 90];
    let cols = '<cols>'; W.forEach(function (w, i) { cols += '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>'; }); cols += '</cols>';
    /* sheetViews comes before cols — the schema fixes the order, and a worksheet with them the
       other way round is a repaired (emptied) workbook rather than an error message. */
    const view = selected ? '<sheetViews><sheetView tabSelected="1" workbookViewId="0"/></sheetViews>' : "";
    yield '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      view + cols + '<sheetData>' + rowXml(header, 1, null, isLink, true);
    const step = per || 4000;
    for (let i = 0; i < rows.length; i += step) {
      let buf = "";
      for (let j = i; j < rows.length && j < i + step; j++) buf += rowXml(rows[j], j + 2, colors[j], isLink, false);
      yield buf;
    }
    // AutoFilter so Status (and other columns) are filterable in Excel
    yield "</sheetData><autoFilter ref=\"A1:" + cl(header.length - 1) + (rows.length + 1) + "\"/></worksheet>";
  }

  /* The same worksheet as one string — small reports, and the tests that read it back. */
  function sheetXml(header, rows, colors, linkCols) {
    let s = "";
    for (const c of sheetChunks(header, rows, colors, linkCols)) s += c;
    return s;
  }
  /* Built from the sheets rather than written out for one, so the workbook can carry a tab per
     kind of answer. All three have to agree about how many worksheets there are and what they are
     called: Excel repairs — that is, empties — a workbook whose parts disagree. */
  function ctXml(n) {
    let s = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>';
    for (let i = 1; i <= n; i++) {
      s += '<Override PartName="/xl/worksheets/sheet' + i + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
    }
    return s + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>';
  }
  /* A tab name Excel will accept: no : \\ / ? * [ ], no more than 31 characters, and not empty. */
  function tabName(s, i) {
    const n = String(s == null ? "" : s).replace(/[:\\\/?*\[\]]/g, " ").slice(0, 31).trim();
    return n || ("Sheet" + i);
  }
  function wbXml(names) {
    /* Which tab opens, said out loud. Sheet order and the active sheet are different things, and
       with neither declared every reader decides for itself — a report saved to put the problems
       in front of someone would then open on whichever tab that reader preferred. */
    let s = '<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<bookViews><workbookView activeTab="0"/></bookViews><sheets>';
    names.forEach(function (n, i) {
      s += '<sheet name="' + xesc(tabName(n, i + 1)) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>';
    });
    return s + "</sheets></workbook>";
  }
  function wbrXml(n) {
    let s = '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
    for (let i = 1; i <= n; i++) {
      s += '<Relationship Id="rId' + i + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + i + '.xml"/>';
    }
    /* the styles part takes the id after the last sheet, so it moves when a tab is added */
    return s + '<Relationship Id="rId' + (n + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>';
  }
  /* deflate-raw is what a .zip entry wants. Without it the workbook is its XML verbatim — 79 MB
     for 100,000 rows, against 3.2 MB compressed, which is the difference between a file that can be
     mailed and one that cannot. Where the browser has no CompressionStream, or an entry comes out
     bigger compressed than it went in (a 200-byte .rels does), that entry is stored instead. */
  async function deflateRaw(u8) {
    if (typeof CompressionStream === "undefined") return null;
    try {
      const s = new Response(u8).body.pipeThrough(new CompressionStream("deflate-raw"));
      return new Uint8Array(await new Response(s).arrayBuffer());
    } catch (e) { return null; }
  }
  /* The same, for something too big to hold: chunks go in as they are made and only the compressed
     output is kept. Returns the pieces, the CRC and the uncompressed length — everything the zip's
     local header needs, which is why the header is written after the data rather than before. */
  async function deflateChunks(gen) {
    if (typeof CompressionStream === "undefined") return null;
    const enc = new TextEncoder();
    try {
      const cs = new CompressionStream("deflate-raw");
      const w = cs.writable.getWriter(), rd = cs.readable.getReader();
      const out = [];
      /* read while writing: the stream only takes more once what it has produced is drained */
      const pump = (async function () {
        for (;;) { const r = await rd.read(); if (r.done) break; out.push(r.value); }
      })();
      let crc = 0xFFFFFFFF, size = 0;
      for (const piece of gen) {
        const b = enc.encode(piece);
        crc = crc32Run(crc, b); size += b.length;
        await w.write(b);
      }
      await w.close();
      await pump;
      return { parts: out, crc: (crc ^ 0xFFFFFFFF) >>> 0, size: size };
    } catch (e) { return null; }
  }
  async function zipPack(files) {
    const enc = new TextEncoder();
    const u16 = function (n) { return new Uint8Array([n & 255, (n >> 8) & 255]); };
    const u32 = function (n) { n >>>= 0; return new Uint8Array([n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255]); };
    const chunks = [], central = []; let off = 0;
    for (let i = 0; i < files.length; i++) {
      const f = files[i], name = enc.encode(f.name);
      let crc, raw, parts, method = 8;
      if (f.chunks) {
        /* An entry too big to hold: the pieces go straight into the deflate stream and only the
           compressed output is kept. The header below needs the CRC and the uncompressed size,
           which is why they are accumulated on the way past rather than measured afterwards.

           f.chunks MAKES the pieces; it is not the pieces. A generator can be read once, and this
           reads them twice when the first attempt fails — measured against a stream that died on
           its second chunk: 12,001 rows in, 0 out, and no error anywhere. */
        const z = await deflateChunks(f.chunks());
        if (z) { parts = z.parts; crc = z.crc; raw = z.size; }
        else {
          /* No CompressionStream, or the stream failed. Store it — as BYTES, joined once, never
             as one string: a Uint8Array has no half-gigabyte ceiling, and that ceiling is the
             whole reason this path exists. */
          const bs = []; let n = 0;
          for (const piece of f.chunks()) { const b = enc.encode(piece); bs.push(b); n += b.length; }
          const whole = cat(bs);
          parts = [whole]; crc = crc32(whole); raw = n; method = 0;
        }
      } else {
        crc = crc32(f.data); raw = f.data.length;
        const body = await deflateRaw(f.data);
        if (!body || body.length >= raw) { parts = [f.data]; method = 0; }
        else parts = [body];
      }
      let csize = 0; parts.forEach(function (p) { csize += p.length; });
      /* a tiny entry can come out bigger compressed than it went in — store those */
      if (method === 8 && !f.chunks && csize >= raw) { parts = [f.data]; csize = raw; method = 0; }
      const lh = cat([u32(0x04034b50), u16(20), u16(0), u16(method), u16(0), u16(0),
        u32(crc), u32(csize), u32(raw), u16(name.length), u16(0), name]);
      chunks.push(lh);
      parts.forEach(function (p) { chunks.push(p); });
      central.push({ name: name, crc: crc, csize: csize, size: raw, off: off, method: method });
      off += lh.length + csize;
    }
    const cds = off, cdc = [];
    central.forEach(function (c) {
      cdc.push(cat([u32(0x02014b50), u16(20), u16(20), u16(0), u16(c.method), u16(0), u16(0),
        u32(c.crc), u32(c.csize), u32(c.size), u16(c.name.length), u16(0), u16(0), u16(0), u16(0),
        u32(0), u32(c.off), c.name]));
    });
    const cdb = cat(cdc); chunks.push(cdb);
    chunks.push(cat([u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length),
      u32(cdb.length), u32(cds), u16(0)]));
    return cat(chunks);
  }
  /* kept for the reader's sake: zipPack writes what this wrote, plus compression */
  function zipStore(files) {
    const enc = new TextEncoder(); const u16 = function (n) { return new Uint8Array([n & 255, (n >> 8) & 255]); }; const u32 = function (n) { n >>>= 0; return new Uint8Array([n & 255, (n >> 8) & 255, (n >> 16) & 255, (n >> 24) & 255]); };
    const chunks = [], central = []; let off = 0;
    files.forEach(function (f) { const name = enc.encode(f.name), data = f.data, crc = crc32(data); const lh = cat([u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0), u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0), name]); chunks.push(lh); chunks.push(data); central.push({ name: name, crc: crc, size: data.length, off: off }); off += lh.length + data.length; });
    const cds = off; const cdc = [];
    central.forEach(function (c) { cdc.push(cat([u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0), u32(c.crc), u32(c.size), u32(c.size), u16(c.name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(c.off), c.name])); });
    const cdb = cat(cdc); chunks.push(cdb);
    chunks.push(cat([u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length), u32(cdb.length), u32(cds), u16(0)]));
    return cat(chunks);
  }

  self.XLSX = {
    inflateRaw: inflateRaw, unzip: unzip, colIdx: colIdx, sheetsOf: sheetsOf,
    shared: shared, sheet: sheet, readXlsx: readXlsx,
    crc32Run: crc32Run, crc32: crc32, cat: cat, xesc: xesc, cl: cl,
    rowXml: rowXml, sheetChunks: sheetChunks, sheetXml: sheetXml,
    ctXml: ctXml, tabName: tabName, wbXml: wbXml, wbrXml: wbrXml,
    deflateRaw: deflateRaw, deflateChunks: deflateChunks, zipPack: zipPack, zipStore: zipStore
  };
})();
