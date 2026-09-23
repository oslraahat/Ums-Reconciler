/* Re-running one bucket must survive a failure. If a single item throws, the old code let
 * Promise.all reject, so `run` was never cleared — every button stayed disabled until the page
 * was reloaded, which looked like "the re-run does nothing".
 *
 *   node tests/rerun-robust.js
 */
"use strict";
const fs = require("fs");
const path = require("path");

let fail = 0;
const check = (name, ok, extra) => { if (!ok) fail++; console.log((ok ? "PASS  " : "FAIL  ") + name + (extra ? "   " + extra : "")); };

/* the same shape as rerunStatus(), with processItem() blowing up on one item */
function makeRun(guarded) {
  const jobs = [{ res: { st: "error" } }, { res: { st: "error" } }, { res: { st: "error" } }];
  let run = null, done = 0;

  const processItem = async (j) => {
    if (j === jobs[1]) throw new Error("network died");
    return { st: "ok" };
  };

  return {
    jobs,
    get busy() { return !!run; },
    get done() { return done; },
    async go() {
      run = { stop: false, paused: false };
      let next = 0;
      const worker = async () => {
        while (!run.stop) {
          const i = next++; if (i >= jobs.length) return;
          let res;
          if (guarded) {
            try { res = await processItem(jobs[i]); }
            catch (e) { res = { st: "error", detail: String(e.message) }; }
          } else {
            res = await processItem(jobs[i]);      // unguarded — this rejects the whole run
          }
          jobs[i].res = res; done++;
        }
      };
      if (guarded) {
        try { await Promise.all([worker(), worker()]); } finally { run = null; }
      } else {
        await Promise.all([worker(), worker()]);
        run = null;
      }
    }
  };
}

(async () => {
  const broken = makeRun(false);
  try { await broken.go(); } catch (e) { /* the old behaviour: it throws out */ }
  check("bug reproduced — run stays busy after a failure", broken.busy === true, "busy=" + broken.busy);

  const fixed = makeRun(true);
  await fixed.go();
  check("guarded — run always clears", fixed.busy === false, "busy=" + fixed.busy);
  check("guarded — every item still processed", fixed.done === 3, "done=" + fixed.done);
  check("the failing item is recorded, not lost",
    fixed.jobs[1].res.st === "error" && /network died/.test(fixed.jobs[1].res.detail || ""),
    JSON.stringify(fixed.jobs[1].res));

  /* and the real file must carry both guards */
  const src = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  const fn = src.slice(src.indexOf("async function rerunStatus"), src.indexOf("async function startRun"));
  check("app.js: per-item try/catch", /try \{ res = await processItem/.test(fn));
  check("app.js: finally clears `run`", /\} finally \{[\s\S]*?run = null;/.test(fn));
  check("app.js: pause works during a re-run", /run\.paused/.test(fn));

  console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
  process.exit(fail ? 1 : 0);
})();
