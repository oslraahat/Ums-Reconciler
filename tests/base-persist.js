/* The address you were last using must survive a reload.
 *
 * baseUrl is loaded from storage on start, but editing the field only ever updated the in-memory
 * variable — nothing wrote it back unless you also pressed Save. So a reload came back to the last
 * SAVED address (or the ums-5 default), not the one you were actually on. The fix persists the
 * address on edit, debounced, so the round trip closes on its own.
 *
 *   node tests/base-persist.js
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

/* ---- the write side: editing the field persists it ---- */
check("editing the address persists it without the Save button",
  /\$\("base"\)\.addEventListener\("input", function \(\) \{ baseUrl = this\.value\.trim\(\)[^}]*persistBase\(\); \}\)/.test(APP),
  "base input listener");
check("…the second address too, on the same debounced writer",
  /\$\("base2"\)\.addEventListener\("input", function \(\) \{ baseUrl2 = this\.value\.trim\(\)[^}]*persistBase\(\); \}\)/.test(APP),
  "base2 input listener");
check("…and what it writes is baseUrl (and baseUrl2)",
  /chrome\.storage\.local\.set\(\{ baseUrl: baseUrl, baseUrl2: baseUrl2 \}\)/.test(APP), "persistBase");

/* the write is debounced, so a fast typist does not hammer storage on every keystroke */
{
  const m = /const persistBase = function \(\) \{[\s\S]*?setTimeout\(function \(\) \{[\s\S]*?\}, (\d+)\);/.exec(APP);
  check("…debounced rather than fired on every keystroke", !!m && +m[1] > 0, m ? m[1] + "ms" : "no debounce");
}

/* ---- the read side: start restores it ---- */
check("start restores the saved address", /if \(o\.baseUrl\) baseUrl = o\.baseUrl;/.test(APP), "load path");
check("…and the field is repainted from it", /\$\("base"\)\.value = baseUrl;/.test(APP), "wire()");
/* baseUrl is one of the keys actually requested from storage on load */
check("…and baseUrl is among the keys read on start",
  /chrome\.storage\.local\.get\(\[[^\]]*"baseUrl"[^\]]*\]/.test(APP), "storage.get key list");

console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
process.exit(fail ? 1 : 0);
