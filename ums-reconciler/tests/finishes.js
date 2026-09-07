/* A run must always be able to finish.
 *
 * The run narrows itself when the server refuses: workers numbered beyond the current width park
 * in slot() until `live` rises again. `live` rises only in pace(), only while pressure is 0, and
 * pressure only moves when a fetch answers.
 *
 * Put those three together at the end of a run and they deadlock. The last student is taken by
 * one of the two workers still running; the other twenty-three are parked; no fetches remain to
 * bring the pressure down that is keeping them parked. Promise.all never resolves — so the sweep
 * never runs, the checkpoint's last flush never happens, and the page sits on "⏳ 100,000/100,000"
 * for ever. Stop still works, which makes it a run that quietly never finished rather than a
 * crash, and that is the worse of the two.
 *
 * Even without the deadlock, a run that had narrowed paid up to a minute and a half of workers
 * spinning at the end, waiting for a width that nothing was left to use.
 *
 * So: waiting for room is only ever worth doing while there is work that room is for.
 *
 *   node tests/finishes.js
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

/* lift a function by name; `after` picks the one inside startRun rather than the sweep's */
function src(name, after) {
  let at = APP.indexOf("function " + name + "(", after ? APP.indexOf(after) : 0);
  if (at < 0) throw new Error("no such function: " + name);
  if (APP.slice(at - 6, at) === "async ") at -= 6;
  let depth = 0;
  for (let j = APP.indexOf("{", at); j < APP.length; j++) {
    if (APP[j] === "{") depth++;
    else if (APP[j] === "}") { depth--; if (!depth) return APP.slice(at, j + 1); }
  }
  throw new Error("unbalanced " + name);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* slot() is the whole of it: given a run, a width, a queue and a clock, does it ever return?
   pace() is handed in as the real one so that a change to how the width recovers is felt here. */
function gate(o) {
  const box = { live: o.live, liveAt: 0, pressure: o.pressure, next: o.next, students: { length: o.total } };
  const pace = new Function("box", "conc",
    "const Date = { now: function () { return box.now || 0; } };" +
    "let pressure, live, liveAt;" + src("pace") +
    "return function () { pressure = box.pressure; live = box.live; liveAt = box.liveAt;" +
    "  pace(); box.live = live; box.liveAt = liveAt; };")(box, o.conc);
  return new Function("run", "live", "next", "students", "pace", "sleep", "box",
    src("slot", "async function startRun(") +
    "\nreturn function (n) { return slot(n); };")(
    o.run, box.live, box.next, box.students, pace, sleep, box);
}

/* The lifted slot() closes over `live` and `next` by value once, which is exactly what the real
   one does NOT do — so drive it the way the run does instead: rebuild per call with live state. */
function waits(o) {
  return new Function("run", "pace", "sleep", "state",
    "let live, next, students;" +
    src("slot", "async function startRun(").replace("async function slot(n)", "async function slotBody(n)") +
    "\nreturn async function (n) {" +
    "  const t0 = Date.now();" +
    "  live = state.live; next = state.next; students = state.students;" +
    "  const p = slotBody(n);" +
    /* keep the closed-over copies fresh the way module scope would */
    "  const iv = setInterval(function () { live = state.live; next = state.next; }, 10);" +
    "  const to = new Promise(function (r) { setTimeout(function () { r('timeout'); }, 1500); });" +
    "  const r = await Promise.race([p.then(function () { return 'returned'; }), to]);" +
    "  clearInterval(iv);" +
    "  return { how: r, ms: Date.now() - t0 };" +
    "};")(o.run, o.pace, sleep, o.state)(o.n);
}

(async function () {
  const never = () => {};   /* a pressure gauge that cannot fall: no fetches are left to lower it */

  /* ---- the deadlock ---- */
  {
    /* the queue is empty (every student taken) and the run has narrowed to two */
    const state = { live: 2, next: 40, students: { length: 40 } };
    const r = await waits({ run: { stop: false }, pace: never, state: state, n: 7 });
    check("a parked worker gives up once there is no work left", r.how === "returned",
      r.how + " after " + r.ms + "ms");
  }

  /* ---- and still waits when there IS work ---- */
  {
    const state = { live: 2, next: 5, students: { length: 40 } };
    const r = await waits({ run: { stop: false }, pace: never, state: state, n: 7 });
    check("…but keeps waiting while students are still queued", r.how === "timeout",
      r.how + " after " + r.ms + "ms");
  }

  /* ---- room opening up lets it through ---- */
  {
    const state = { live: 2, next: 5, students: { length: 40 } };
    setTimeout(function () { state.live = 25; }, 300);
    const r = await waits({ run: { stop: false }, pace: never, state: state, n: 7 });
    check("…and goes as soon as the run widens again", r.how === "returned" && r.ms >= 250,
      r.how + " after " + r.ms + "ms");
  }

  /* ---- Stop is always heard ---- */
  {
    const state = { live: 2, next: 5, students: { length: 40 } };
    const run = { stop: false };
    setTimeout(function () { run.stop = true; }, 250);
    const r = await waits({ run: run, pace: never, state: state, n: 7 });
    check("…and Stop gets it out either way", r.how === "returned", r.how + " after " + r.ms + "ms");
  }

  /* ---- the gauge does not outlive its run ---- */
  {
    check("a new run starts from a clean pressure gauge",
      /live = workers; liveAt = Date\.now\(\); pressure = 0;/.test(APP),
      "startRun");
  }

  /* ---- and the offer does not outlive the checkpoint it points at ---- */
  {
    const body = src("startRun");
    const bar = body.indexOf("ckBar(null);");
    const start = body.indexOf("await ckStart();");
    check("starting a run takes the resume offer down", bar > 0, "startRun");
    check("…before the checkpoint it was offering is wiped", bar >= 0 && bar < start,
      "ckBar at " + bar + ", ckStart at " + start);
    check("…whichever way the run was started",
      !/if \(resumed\) ckBar\(null\)/.test(APP), "it is still conditional on resumed");
  }

  console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
  process.exit(fail ? 1 : 0);
})();
