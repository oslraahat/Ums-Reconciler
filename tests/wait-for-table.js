/* The panel must wait for the table by the clock, not by counting the page's mutations.
 *
 * captureWhenReady() had a budget of twenty attempts, and the MutationObserver spent one on EVERY
 * mutation — a spinner, a jQuery plugin, this very panel being inserted into the page. A busy page
 * burned all twenty inside the first second, before the table had arrived, and then disconnected
 * the observer and cleared the interval: the capture gave up for good. The panel then said "not
 * captured" for ever, a reload was the only cure, and nothing on screen suggested one.
 *
 * The page's own churn is not the thing being waited for. Time is.
 *
 * (tests/capture.js already covers a table that appears once; this is about a table that appears
 * late, on a page that will not hold still.)
 *
 *   node tests/wait-for-table.js
 */
"use strict";
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");

let fail = 0;
const check = (name, ok, extra) => {
  if (!ok) fail++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (!ok && extra !== undefined ? "   " + extra : ""));
};

function lift(name) {
  let at = SRC.indexOf("function " + name + "(");
  if (at < 0) throw new Error("no such function: " + name);
  let d = 0;
  for (let j = SRC.indexOf("{", at); j < SRC.length; j++) {
    if (SRC[j] === "{") d++;
    else if (SRC[j] === "}") { d--; if (!d) return SRC.slice(at, j + 1); }
  }
  throw new Error("unbalanced " + name);
}
const WAIT_MS = +(/const WAIT_MS = (\d+);/.exec(SRC) || [])[1];
const LOOK_MS = +(/const LOOK_MS = (\d+);/.exec(SRC) || [])[1];

/* a page that mutates on demand, and a table that arrives when told */
function page(o) {
  const st = { looks: 0, captured: false, mutations: 0, observing: false, timers: 0 };
  let fire = null;
  const MutationObserver = function (cb) {
    this.observe = function () { st.observing = true; fire = cb; };
    this.disconnect = function () { st.observing = false; fire = null; };
  };
  const intervals = [];
  const api = new Function("captureNow", "MutationObserver", "document", "setInterval",
    "clearInterval", "setTimeout", "WAIT_MS", "LOOK_MS",
    lift("captureWhenReady") + "\nreturn captureWhenReady;")(
    function () { st.looks++; return st.captured; },
    MutationObserver,
    { documentElement: {} },
    function (fn, ms) { intervals.push(fn); return intervals.length; },
    function (i) { intervals[i - 1] = null; },
    function (fn, ms) { st.timers++; setTimeout(fn, ms); },
    WAIT_MS, LOOK_MS);
  st.start = api;
  st.churn = function (n) { for (let i = 0; i < n; i++) { st.mutations++; if (fire) fire(); } };
  st.tick = function () { intervals.forEach(function (f) { if (f) f(); }); };
  return st;
}

check("the wait is measured in milliseconds", WAIT_MS >= 10000, "WAIT_MS=" + WAIT_MS);

/* ---------- the bug ---------- */
{
  const p = page();
  p.start();
  /* a page that will not hold still: three hundred mutations before the table exists */
  p.churn(300);
  check("a churning page does not use up the wait", p.observing === true,
    "gave up after " + p.mutations + " mutations and " + p.looks + " looks");
  /* …and the table finally arrives */
  p.captured = true;
  p.tick();
  check("…so the table is still captured when it finally appears", p.looks > 0 && !p.observing,
    "observing=" + p.observing);
}

/* ---------- looking is throttled, because looking is not free ---------- */
{
  const p = page();
  p.start();
  const before = p.looks;
  p.churn(200);
  check("a burst of mutations is not a burst of table scans",
    p.looks - before < 20, (p.looks - before) + " scans for 200 mutations");
  check("…but the first one is looked at straight away", p.looks - before >= 1,
    (p.looks - before) + " scans");
}

/* ---------- and it does stop, eventually ---------- */
{
  const p = page();
  const realNow = Date.now;
  p.start();
  let t = realNow();
  Date.now = function () { return t; };
  try {
    t += WAIT_MS + 1000;
    p.tick();
    check("it gives up once the wait is really over", p.observing === false,
      "still observing after " + Math.round(WAIT_MS / 1000) + "s");
  } finally { Date.now = realNow; }
}

/* ---------- the shape of it ---------- */
{
  const fn = lift("captureWhenReady");
  check("nothing counts mutations any more", !/tries/.test(fn), "captureWhenReady");
  check("the interval is cleared when it stops, not left running",
    /if \(iv\) clearInterval\(iv\);/.test(fn), "captureWhenReady");
}

console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
process.exit(fail ? 1 : 0);
