/* The run narrows itself when the server is refusing, and widens again when it stops.
 *
 * "একসাথে কয়টি অনুরোধ" is a ceiling — permission to run that many pages at once, not an
 * instruction to keep doing so into a server that is saying no. The only brake used to be
 * breathe(): every worker asleep for up to three seconds and then all twenty-five firing at once,
 * which bunches the traffic back up at the exact moment the server least wants it.
 *
 * What is checked here is the shape of the response, not the constants — those have been tuned
 * more than once. Down must be faster than up; the floor must never be zero; the ceiling must
 * always be the user's number; and a server that never refuses must never be slowed at all,
 * because that last one is the promise the setting makes.
 *
 *   node tests/pace.js
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

/* lift a function out of app.js by name, brace-matched (same as tests/patience.js) */
function src(name, after) {
  /* `after` matters for worker(): sweepUnanswered has one too, and it appears first in the file.
     Lifting the wrong one would leave this test passing against code it never read. */
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

/* pace() reads pressure/live/liveAt/conc and writes live/liveAt, so the harness owns them and can
   drive the clock: real waiting would make this test minutes long and flaky with it. */
function gauge(conc) {
  const box = { pressure: 0, live: conc, liveAt: 0, now: 100000 };
  const fn = new Function("box", "conc",
    "const Date = { now: function () { return box.now; } };" +
    "let pressure, live, liveAt;" +
    src("pace") +
    "return function () { pressure = box.pressure; live = box.live; liveAt = box.liveAt;" +
    "  pace(); box.live = live; box.liveAt = liveAt; };")(box, conc);
  box.tick = function (ms) { box.now += ms; fn(); };
  return box;
}

/* ---------- a server that is answering ---------- */
{
  const g = gauge(25);
  for (let i = 0; i < 200; i++) g.tick(1000);
  check("a server that never refuses is never slowed down", g.live === 25, "live=" + g.live);
}

/* ---------- a server that starts refusing ---------- */
{
  const g = gauge(25);
  g.pressure = 8;                       // refusals arriving
  const marks = [];
  for (let i = 0; i < 12; i++) { g.tick(5000); marks.push(g.live); }
  check("refusals narrow the run", g.live < 25, "live=" + g.live);
  check("…quickly — halved inside half a minute", marks[5] <= 12, marks.slice(0, 6).join(" → "));
  check("…but never to a standstill", g.live >= 2, "live=" + g.live);
  /* the whole point: it comes back on its own, without anyone watching the run */
  g.pressure = 0;
  const low = g.live;
  for (let i = 0; i < 100; i++) g.tick(1000);
  check("and it climbs back once the server is answering again", g.live === 25,
    low + " → " + g.live);
}

/* ---------- down fast, up slow ---------- */
{
  const down = gauge(25); down.pressure = 8;
  let steps = 0;
  while (down.live > 8 && steps < 100) { down.tick(5000); steps++; }
  const downMs = steps * 5000;

  const up = gauge(25); up.live = 8; up.pressure = 0;
  steps = 0;
  while (up.live < 25 && steps < 500) { up.tick(1000); steps++; }
  const upMs = steps * 1000;
  check("it lets go of the throttle more slowly than it grabs it", upMs > downMs * 2,
    "down " + (downMs / 1000) + "s vs up " + (upMs / 1000) + "s");
}

/* ---------- a wobble is not a collapse ---------- */
{
  const g = gauge(25);
  g.pressure = 6; g.tick(5000); g.tick(5000);     // ten seconds of trouble
  const dip = g.live;
  g.pressure = 0;
  for (let i = 0; i < 60; i++) g.tick(1000);      // a minute of calm
  check("a brief wobble costs a dip, not the run", dip < 25 && g.live === 25,
    "dipped to " + dip + ", back to " + g.live);
}

/* ---------- and the ceiling is the ceiling ---------- */
{
  const g = gauge(4);
  g.pressure = 0;
  for (let i = 0; i < 200; i++) g.tick(1000);
  check("it never runs wider than the number the user set", g.live === 4, "live=" + g.live);
  const one = gauge(1); one.pressure = 12;
  for (let i = 0; i < 50; i++) one.tick(5000);
  check("…nor narrower than one when one is all there is", one.live >= 1, "live=" + one.live);
}

/* ---------- the wiring around it ---------- */
{
  /* A worker must park before it takes a student. Parking after would leave a student claimed and
     nobody working on it, and the run would end with a gap nothing accounts for. */
  const w = src("worker", "async function startRun(");
  check("a worker waits for its slot before claiming a student",
    w.indexOf("await slot(n)") >= 0 && w.indexOf("await slot(n)") < w.indexOf("next++"), "worker()");
  check("the run starts at the number the user set",
    /live = workers; liveAt = Date\.now\(\);/.test(APP), "startRun");
  /* If the run narrows and says nothing, the tool just looks slow and the reason is invisible. */
  check("a narrowed run says so on the progress line",
    /live < conc \? " · 🐢 " \+ t\("p_eased"\)/.test(APP), "prog()");
  check("…in both languages", /p_eased: \{ bn: "[^"]+", en: "[^"]+" \}/.test(APP), "DICT");
  /* breathe() is the other brake; two full-strength brakes for one problem is one too many */
  const br = src("breathe");
  const cap = +(/Math\.min\(pressure \* \d+, (\d+)\)/.exec(br) || [])[1];
  check("the blanket sleep was eased once the width could move", cap <= 1500, "cap=" + cap + "ms");
}

console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
process.exit(fail ? 1 : 0);
