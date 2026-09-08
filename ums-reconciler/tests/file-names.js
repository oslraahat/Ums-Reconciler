/* An exported file has to say what is in it.
 *
 * Every download was called ums-verify-<date>-<hour><minute>.<ext>, whatever chip was selected
 * when it was taken. Export the mismatches, then Zero Pay, then everything, inside the same
 * minute, and all three files have the same name; a minute apart and they differ by two digits
 * that say nothing about which is which. A week later there is no telling them apart without
 * opening them — which is exactly when somebody needs to.
 *
 *   node tests/file-names.js
 */
"use strict";
const fs = require("fs");
const path = require("path");

const APP = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

let fail = 0;
const check = (name, ok, extra) => {
  if (!ok) fail++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (!ok && extra !== undefined ? "   " + extra : ""));
};
function src(name) {
  let at = APP.indexOf("function " + name + "(");
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

/* the namer, with the two things it reads handed in */
function namer(filter, srvMode) {
  return new Function("filter", "srvMode",
    line(/const FILE_TAG = \{[\s\S]*?\};\n/) + line(/const FILE_TAG_SRV = \{[\s\S]*?\};\n/) +
    src("fileTag") + "\nreturn fileTag;")(filter, srvMode);
}
/* …and the whole name, with a fixed clock */
function nameOf(filter, srvMode, n, ext) {
  const el = { href: "", download: "", click() {}, remove() {} };
  const fn = new Function("filter", "srvMode", "stamp", "URL", "document", "setTimeout",
    line(/const FILE_TAG = \{[\s\S]*?\};\n/) + line(/const FILE_TAG_SRV = \{[\s\S]*?\};\n/) +
    src("fileTag") + src("dl") +
    "\nreturn function (n, ext) { dl({}, ext, fileTag(n)); };")(
    filter, srvMode, () => "20260908-1432",
    { createObjectURL: () => "blob:x", revokeObjectURL() {} },
    { createElement: () => el, body: { appendChild() {} } }, () => {});
  fn(n, ext);
  return el.download;
}

/* ---------- the name carries the filter and the count ---------- */
{
  check("a mismatch export is named for the mismatches",
    nameOf("no", false, 241, "xlsx") === "ums-verify-mismatch-241-20260908-1432.xlsx",
    nameOf("no", false, 241, "xlsx"));
  check("…and an unfiltered one says so too",
    /^ums-verify-all-8735-/.test(nameOf("all", false, 8735, "html")),
    nameOf("all", false, 8735, "html"));
  check("the extension is still the extension",
    nameOf("prob", false, 12, "txt").endsWith(".txt"), nameOf("prob", false, 12, "txt"));
}

/* ---------- two exports taken a second apart are told apart ---------- */
{
  const a = nameOf("no", false, 241, "xlsx");
  const b = nameOf("zero", false, 7, "xlsx");
  const c = nameOf("all", false, 8735, "xlsx");
  check("three filters give three different names, same minute",
    a !== b && b !== c && a !== c, [a, b, c].join("  "));
}

/* ---------- the two modes name the same chip differently, as they do on screen ---------- */
{
  const one = namer("cw", false), two = namer("cw", true);
  check("CW Empty and “missing on Actual” are not called the same thing",
    one(3) !== two(3), one(3) + " vs " + two(3));
  check("…and each says what that mode means",
    /cw-empty/.test(one(3)) && /missing-on-actual/.test(two(3)), one(3) + " / " + two(3));
  check("two-server “identical” is not called “matched”",
    namer("ok", true)(9) === "identical-9", namer("ok", true)(9));
}

/* ---------- every chip has a word, and the words are filename-safe ---------- */
{
  const chips = ["all", "ok", "no", "cw", "zero", "nf", "prob"];
  [false, true].forEach(function (srv) {
    const f = chips.map(function (c) { return namer(c, srv)(1); });
    check("every chip has a name of its own" + (srv ? " (two servers)" : ""),
      new Set(f).size === chips.length, f.join(" "));
    check("…and none of them can upset a filesystem" + (srv ? " (two servers)" : ""),
      f.every(function (x) { return /^[a-z0-9-]+$/.test(x); }), f.join(" "));
  });
  /* the interface's own labels are Bengali; a filename that changes with the language is one
     nobody can search for a week later */
  check("the words are English, whatever the interface is set to",
    !/[ঀ-৿]/.test(line(/const FILE_TAG = \{[\s\S]*?\};\n/) +
      line(/const FILE_TAG_SRV = \{[\s\S]*?\};\n/)), "FILE_TAG");
}

/* ---------- and every exporter passes it ---------- */
{
  ["exportHtml", "exportRaw", "exportXlsx"].forEach(function (n) {
    /* not [^)]* between dl( and fileTag — the Blob and its type object are full of parentheses,
       so that stops at the first one and reports every caller as missing it */
    check(n + " names the file it writes", /, fileTag\(rows\.length\)\)/.test(src(n)),
      src(n).replace(/\s+/g, " ").slice(0, 100));
  });
  /* the raw file holds fewer rows than the filter selected — it must count its own */
  check("…and the raw export counts its own rows, not the filter's",
    /const rows = flatRows\(\)\.filter\(function \(r\) \{ return r\.raw; \}\);[\s\S]*?fileTag\(rows\.length\)/
      .test(src("exportRaw")), "exportRaw");
}

console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
process.exit(fail ? 1 : 0);
