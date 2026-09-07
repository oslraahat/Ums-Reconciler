/* The re-run buttons went dead after a run: flushUI() → paintTiles() → paintRerun() ran while
 * `run` was still set, disabling every ↻, and nothing repainted after `run = null`.
 * This reproduces that ordering with the same shape of code.
 *
 *   node tests/rerun.js
 */
"use strict";

let fail = 0;
const check = (name, ok, extra) => {
  if (!ok) fail++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (extra ? "   " + extra : ""));
};

function makeApp(paintAfterClear) {
  const buttons = { ok: { disabled: true }, cw: { disabled: true } };
  const counts = { ok: 5, cw: 868 };
  let run = null;

  const paintRerun = () => {
    Object.keys(buttons).forEach((k) => { buttons[k].disabled = !!run || counts[k] === 0; });
  };
  const flushUI = () => paintRerun();              // paintTiles() calls paintRerun()

  return {
    buttons,
    async startRun() {
      run = { stop: false };
      paintRerun();
      flushUI();                                    // the last repaint of the run
      run = null;
      if (paintAfterClear) paintRerun();            // the fix
    }
  };
}

(async () => {
  const broken = makeApp(false);
  await broken.startRun();
  check("bug reproduced — ↻ stays disabled after the run",
    broken.buttons.cw.disabled === true, "cw.disabled=" + broken.buttons.cw.disabled);

  const fixed = makeApp(true);
  await fixed.startRun();
  check("fixed — ↻ is clickable once the run ends",
    fixed.buttons.cw.disabled === false, "cw.disabled=" + fixed.buttons.cw.disabled);

  /* and the real file must carry that repaint */
  const fs = require("fs");
  const path = require("path");
  const src = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  /* Anything may happen between the two — offering the checkpoint back does — but paintRerun()
     has to come after run is cleared, and nothing may set run again in between, or the buttons
     are painted against a run that is still notionally in progress and stay disabled. */
  const tail = src.slice(src.lastIndexOf("run = null;"));
  check("app.js repaints after `run = null`",
    /^run = null;[^]{0,400}?paintRerun\(\);/.test(tail) && !/^run = null;[^]*?run = \{/.test(tail.slice(0, 400)),
    tail.slice(0, 160).replace(/\s+/g, " "));
  check("rerunStatus clears `run` before repainting the tiles",
    /run = null;\s*\n\s*recountAll\(\); paintTiles\(\);/.test(src));

  console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
  process.exit(fail ? 1 : 0);
})();
