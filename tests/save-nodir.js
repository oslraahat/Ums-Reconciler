/* Start, with saving switched on and nowhere to save.
 *
 * The switch and the folder are two controls, and only one of them is required to turn the other
 * on. So "ফল সেভ করো" could be on with no folder behind it, and the run went ahead and put hours
 * of work in Downloads — correct, documented, and discovered afterwards, on the finished line,
 * beside a run nobody wants to repeat.
 *
 * Start is a click, which is the one thing a directory picker needs, so the question is asked
 * there: the picker opens, and if it is dismissed the run says where the files will go and waits
 * for an answer. Four ways through, and the two that must NOT interrupt matter as much as the two
 * that must — a person who never wanted a folder should never see any of this.
 *
 *   node tests/save-nodir.js
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

/* The real readyToSave(), over a stub pickDir(). pickDir() assigns to the module's own dirHandle,
   so a stub that "succeeds" has to do the same — which means giving the lifted function a mutable
   binding to close over rather than a parameter it cannot write back to. */
function askReal(opts) {
  const log = { picked: 0, asked: 0 };
  const body =
    "let dirHandle = " + (opts.dirHandle ? '"handle"' : "null") + ";\n" +
    "async function pickDir() { log.picked++; if (PICKS) dirHandle = \"chosen\"; }\n" +
    src("readyToSave") +
    "\nreturn readyToSave().then(function (v) { return { ok: v, dir: dirHandle }; });";
  return new Function("saveOnFinish", "PICKS", "confirm", "t", "log", body)(
    opts.saveOnFinish, !!opts.picks,
    function (msg) { log.asked++; log.msg = msg; return !!opts.answer; },
    function (k) { return k; }, log).then(function (r) { return { r: r, log: log }; });
}

(async function () {
  /* ---- the two that must not interrupt ---- */
  {
    const { r, log } = await askReal({ saveOnFinish: false });
    check("saving switched off: nothing is asked and the run starts",
      r.ok === true && log.picked === 0 && log.asked === 0,
      "picker " + log.picked + ", question " + log.asked);
  }
  {
    const { r, log } = await askReal({ saveOnFinish: true, dirHandle: true });
    check("a folder already chosen: nothing is asked either",
      r.ok === true && log.picked === 0 && log.asked === 0,
      "picker " + log.picked + ", question " + log.asked);
  }

  /* ---- switched on with nowhere to put it ---- */
  {
    const { r, log } = await askReal({ saveOnFinish: true, picks: true });
    check("no folder: the picker opens, on the click that was there anyway", log.picked === 1,
      String(log.picked));
    check("…and choosing one starts the run without a further question",
      r.ok === true && r.dir === "chosen" && log.asked === 0,
      r.dir + ", question " + log.asked);
  }
  {
    const { r, log } = await askReal({ saveOnFinish: true, picks: false, answer: true });
    check("dismissing the picker asks where it should go instead", log.asked === 1, String(log.asked));
    check("…and saying yes runs, with Downloads named in the question",
      r.ok === true && log.msg === "save_nodir_ask", log.msg);
  }
  {
    const { r, log } = await askReal({ saveOnFinish: true, picks: false, answer: false });
    check("…and saying no stops the run before a page is fetched", r.ok === false, String(r.ok));
  }
  /* a browser with no confirm at all must not be a browser that cannot start a run */
  {
    const body = "let dirHandle = null;\nasync function pickDir() {}\n" +
      "function confirm() { throw new Error('no dialogs here'); }\n" +
      src("readyToSave") + "\nreturn readyToSave();";
    const ok = await new Function("saveOnFinish", "t", body)(true, function (k) { return k; });
    check("a page with no confirm() still starts", ok === true, String(ok));
  }

  /* ---- and where it sits in the button ---- */
  const sp = src("startPressed");
  check("Start asks before it does anything else",
    /^\s*if \(!\(await readyToSave\(\)\)\)/m.test(sp.split("\n").slice(0, 8).join("\n")), sp.slice(0, 260));
  /* the picker and the permission prompt both need the click, so neither may wait behind an await
     that could let it lapse */
  check("…before the folder permission is claimed",
    sp.indexOf("readyToSave()") < sp.indexOf("claimDir()"), "startPressed");
  check("…and before the checkpoint question",
    sp.indexOf("readyToSave()") < sp.indexOf("ck_ask"), "startPressed");
  /* a Start that answers a press with nothing at all is indistinguishable from a broken one */
  check("…and says why it did not start",
    /t\("save_nodir_stopped"\)/.test(sp), "startPressed");
  check("both strings exist in both languages",
    /save_nodir_ask: \{ bn: "[^"]+",\s*\n?\s*en: "[^"]+" \}/.test(APP) &&
    /save_nodir_stopped: \{ bn: "[^"]+",\s*\n?\s*en: "[^"]+" \}/.test(APP), "DICT");
  check("…and the question names where the files would land",
    /save_nodir_ask: \{ bn: "[^"]*Downloads[^"]*"/.test(APP), "DICT");

  console.log(fail ? "\n" + fail + " FAILED" : "\nall good");
  process.exit(fail ? 1 : 0);
})();
