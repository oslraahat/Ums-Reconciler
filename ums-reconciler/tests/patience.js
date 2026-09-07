/* A slow server may delay the result. It may never decide it.
 *
 * The runner used to try three times, quickly, and then write "load error" or "পাতা খুললই না" into
 * the student's row — where it reads as a finding about the money, though nothing had been read at
 * all. These are the behaviours that stop that coming back, exercised for real rather than matched
 * against the source: a flaky server, a hung socket, a 503, a 429 with Retry-After, and a page that
 * only answers on the third round of the sweep.
 *
 *   node tests/patience.js
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

/* lift a function out of app.js by name, brace-matched */
function src(name) {
  let at = APP.indexOf("function " + name + "(");
  if (at < 0) throw new Error("no such function: " + name);
  // keep the "async " — without it the lifted body is a plain function full of await
  if (APP.slice(at - 6, at) === "async ") at -= 6;
  let depth = 0;
  for (let j = APP.indexOf("{", at); j < APP.length; j++) {
    if (APP[j] === "{") depth++;
    else if (APP[j] === "}") { depth--; if (!depth) return APP.slice(at, j + 1); }
  }
  throw new Error("unbalanced " + name);
}
const constOf = (n) => +(new RegExp("const " + n + " = (\\d+);").exec(APP) || [])[1];

const NET_TRIES = constOf("NET_TRIES");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- the real back-off ---------- */
{
  const backoff = new Function("sleep", src("backoff") + "\nreturn backoff;")(
    (ms) => Promise.resolve(ms));   // hand the delay back instead of waiting it out

  const runs = [];
  for (let k = 0; k < 200; k++) runs.push([0, 1, 2, 3, 4].map((a) => backoff(a)));
  const at = (a) => Promise.all(runs.map((r) => r[a]));

  Promise.all([at(0), at(1), at(2), at(3), at(4)]).then((cols) => {
    const lo = cols.map((c) => Math.min.apply(null, c));
    const hi = cols.map((c) => Math.max.apply(null, c));
    check("the pause grows with every attempt",
      lo[0] < lo[1] && lo[1] < lo[2] && lo[2] < lo[3], lo.join(" → "));
    /* jitter is not decoration: at 25 parallel workers a fixed pause brings everyone who hit the
       same hiccup back at the same instant, to hit it together again */
    check("…and is jittered, not a fixed multiple", hi[0] > lo[0], lo[0] + "…" + hi[0]);
    check("…but is capped, so a run cannot stall for minutes", hi[4] <= 20000 * 1.25 + 1, hi[4]);

    return Promise.all([backoff(0, "7"), backoff(0, "9999"), backoff(0, "not a number")]);
  }).then((ra) => {
    /* a server that says how long to wait is believed — ignoring it is how a 429 turns into six
       more 429s */
    check("Retry-After is honoured over the computed pause", ra[0] >= 7000 * 0.75 - 1, ra[0]);
    check("…but not without a ceiling", ra[1] <= 30000 * 1.25 + 1, ra[1]);
    check("…and a nonsense value falls back to the normal pause", ra[2] < 2000, ra[2]);
    return netTests();
  }).then(finish).catch((e) => { console.log("THREW  " + (e && e.stack || e)); process.exit(1); });
}

/* ---------- fetchHtml against a server that misbehaves ---------- */
function makeFetch(script) {
  /* script: one entry per call — {ok:body} | {status:n, retryAfter} | "hang" | "throw" */
  const calls = [];
  const fn = function (url, opts) {
    const step = script[Math.min(calls.length, script.length - 1)];
    calls.push({ url: url, step: step });
    const sig = opts && opts.signal;
    if (step === "hang") {
      return new Promise(function (_, rej) {
        if (sig) sig.addEventListener("abort", function () {
          const e = new Error("aborted"); e.name = "AbortError"; rej(e);
        });
      });
    }
    if (step === "throw") return Promise.reject(new TypeError("Failed to fetch"));
    return Promise.resolve({
      status: step.status || 200, ok: (step.status || 200) < 400, redirected: !!step.redirected,
      headers: { get: function (h) { return h === "retry-after" ? (step.retryAfter || null) : null; } },
      text: function () { return Promise.resolve(step.body || "<table></table>"); }
    });
  };
  fn.calls = calls;
  return fn;
}

function lift(fetchStub, run, timeoutMs) {
  const pressed = [];
  const fetchHtml = new Function(
    "fetch", "run", "NET_TRIES", "backoff", "netPressure", "reqTimeout", "sleep",
    src("fetchHtml") + "\nreturn fetchHtml;"
  )(fetchStub, run, NET_TRIES, () => Promise.resolve(), (b) => pressed.push(!!b),
    () => (timeoutMs === undefined ? 50 : timeoutMs), sleep);
  fetchHtml.pressed = pressed;
  return fetchHtml;
}

async function netTests() {
  /* a server that refuses twice and then works */
  {
    const f = makeFetch([{ status: 503 }, { status: 503 }, { body: "<table>ok</table>" }]);
    const r = await lift(f, { ac: null, stop: false })("u");
    check("two refusals then a reply → the reply comes back", r.html === "<table>ok</table>", r.html);
    check("…having actually asked three times", f.calls.length === 3, f.calls.length);
  }

  /* a socket that goes quiet — the whole point of the per-request timeout */
  {
    const f = makeFetch(["hang", { body: "<table>late</table>" }]);
    const r = await lift(f, { ac: null, stop: false })("u");
    check("a hung request is abandoned and asked again", r.html === "<table>late</table>", r.html);
    check("…so one dead socket cannot hold a worker", f.calls.length === 2, f.calls.length);
  }

  /* a network that drops connections */
  {
    const f = makeFetch(["throw", "throw", "throw", { body: "<table>back</table>" }]);
    const r = await lift(f, { ac: null, stop: false })("u");
    check("dropped connections are retried too", r.html === "<table>back</table>", r.html);
  }

  /* 429 — and the pressure gauge that makes the whole run ease off */
  {
    const f = makeFetch([{ status: 429, retryAfter: "1" }, { body: "<table>ok</table>" }]);
    const fh = lift(f, { ac: null, stop: false });
    await fh("u");
    check("a 429 counts against the run's pressure, a 200 counts back",
      fh.pressed[0] === true && fh.pressed[fh.pressed.length - 1] === false, fh.pressed.join(","));
  }

  /* it must not retry for ever — but it must try hard */
  {
    const f = makeFetch(["throw"]);
    let threw = null;
    try { await lift(f, { ac: null, stop: false })("u"); } catch (e) { threw = e; }
    check("a server that never answers eventually throws", !!threw, String(threw));
    check("…only after NET_TRIES attempts", f.calls.length === NET_TRIES, f.calls.length + "/" + NET_TRIES);
    check("…and NET_TRIES is a generous number", NET_TRIES >= 4, NET_TRIES);
  }

  /* a last-attempt 5xx hands the response over rather than throwing — a redirect is still
     readable, and a 503 body is at least a fact about the page */
  {
    const f = makeFetch([{ status: 503, body: "<html>busy</html>" }]);
    const r = await lift(f, { ac: null, stop: false })("u");
    check("the final 5xx is returned, not thrown away", r.status === 503 && r.html === "<html>busy</html>",
      r.status + " " + r.html);
  }

  /* Stop is the user's decision — never retried, never mistaken for slowness */
  {
    const run = { ac: null, stop: false };
    const f = makeFetch(["hang"]);
    const fh = lift(f, run, 10000);
    const p = fh("u");
    setTimeout(function () { run.stop = true; }, 20);
    // nothing aborts the stub here, so make the request fail the way an abort would
    const f2 = makeFetch(["throw"]);
    const run2 = { ac: null, stop: true };
    let e2 = null;
    try { await lift(f2, run2)("u"); } catch (e) { e2 = e; }
    check("Stop throws AbortError at once", e2 && e2.name === "AbortError", e2 && e2.name);
    check("…without a single retry", f2.calls.length === 1, f2.calls.length);
    p.catch(function () {});   // the hung one is left; the assertion above is the point
  }

  return sweepTests();
}

/* ---------- what counts as an answer ---------- */
async function sweepTests() {
  const unanswered = new Function(src("unanswered") + "\nreturn unanswered;")();

  check("a load error is not an answer", unanswered({ kind: "error", msg: "x" }) === true);
  check("no Program Wise table is not an answer", unanswered({ kind: "done", notFound: true }) === true);
  check("a page that would not open is not an answer",
    unanswered({ kind: "done", cwRedirect: true }) === true);
  check("a page without its table is not an answer",
    unanswered({ kind: "done", cwNoTable: true }) === true);
  /* the one that matters: the server DID reply, and said there is nothing. That is a fact about
     the student, and re-asking hundreds of them every round would be the run's whole cost. */
  check("a No Data table IS an answer",
    unanswered({ kind: "done", cwEmpty: true, cwRedirect: false, cwNoTable: false }) === false);
  check("a normal result is an answer", unanswered({ kind: "done" }) === false);
  check("two servers: an unread page is not an answer",
    unanswered({ kind: "done", srv: true, result: { errors: [{ kind: "srvside" }] } }) === true);
  check("two servers: a real difference IS an answer",
    unanswered({ kind: "done", srv: true, result: { errors: [{ kind: "srvcell" }] } }) === false);

  /* ---------- the sweep ---------- */
  const prog = { textContent: "" };
  const mkSweep = (processItem, run, students) => new Function(
    "run", "students", "$", "t", "mmss", "sleep", "breathe", "processItem",
    "recountAll", "paintTiles", "rerenderList", "applyFilterAll", "conc", "SWEEP_ROUNDS", "pressure",
    src("sweepUnanswered") + "\nreturn sweepUnanswered;"
  )(run, students, () => prog, (k) => k, () => "0:00", () => Promise.resolve(),
    () => Promise.resolve(), processItem, () => {}, () => {}, () => {}, () => {},
    4, constOf("SWEEP_ROUNDS"), 0);   // pressure 0 — the server is answering fine, so a barren
                                     // round really does mean no answer is coming

  /* a student the server only answers about on the third round must end with the real result */
  {
    let asked = 0;
    const slot = { item: { spid: "1" }, res: { st: "error", unanswered: true, tried: 3, detail: "load error" } };
    const students = [{ reg: "R1", results: [slot] }];
    const run = { stop: false };
    const processItem = async function (stu, item, prior) {
      asked++;
      return asked < 3
        ? { st: "error", unanswered: true, tried: (prior.tried || 0) + 1, detail: "load error" }
        : { st: "no", unanswered: false, tried: (prior.tried || 0) + 1, detail: "real finding" };
    };
    await mkSweep(processItem, run, students)(Date.now());
    check("a student that only answers on the third round gets its real result",
      slot.res.st === "no" && slot.res.unanswered === false, slot.res.st);
    check("…and was asked until it did", asked === 3, asked);
    check("…with the attempt count carried across rounds", slot.res.tried === 6, slot.res.tried);
  }

  /* a server that answers nothing must still terminate — but only after trying */
  {
    let asked = 0;
    const slot = { item: { spid: "1" }, res: { st: "error", unanswered: true, tried: 1, detail: "x" } };
    const run = { stop: false };
    const processItem = async function (stu, item, prior) {
      asked++; return { st: "error", unanswered: true, tried: (prior.tried || 0) + 1, detail: "x" };
    };
    await mkSweep(processItem, run, [{ reg: "R1", results: [slot] }])(Date.now());
    check("a server that never answers still ends the sweep", asked >= 2 && asked <= constOf("SWEEP_ROUNDS"), asked);
    check("…leaving the row marked as unanswered, not as a finding", slot.res.unanswered === true);
  }

  /* nothing outstanding — the sweep must cost nothing at all */
  {
    let asked = 0;
    const slot = { item: {}, res: { st: "ok", unanswered: false } };
    await mkSweep(async () => { asked++; return slot.res; }, { stop: false },
      [{ reg: "R1", results: [slot] }])(Date.now());
    check("a clean run is not swept", asked === 0, asked);
  }

  /* Stop must end it immediately, mid-sweep */
  {
    let asked = 0;
    const run = { stop: false };
    const slots = [];
    for (let i = 0; i < 20; i++) slots.push({ item: {}, res: { st: "error", unanswered: true, tried: 1 } });
    const processItem = async function (s, i, prior) {
      asked++; if (asked === 3) run.stop = true;
      return { st: "error", unanswered: true, tried: 1 };
    };
    await mkSweep(processItem, run, [{ reg: "R1", results: slots }])(Date.now());
    check("Stop ends the sweep where it stands", asked < 20, asked + " of 20");
  }

  /* a re-ask that throws must not lose what was already there */
  {
    const slot = { item: {}, res: { st: "cw", unanswered: true, tried: 2, detail: "kept" } };
    await mkSweep(async () => { throw new Error("boom"); }, { stop: false },
      [{ reg: "R1", results: [slot] }])(Date.now());
    check("a re-ask that blows up keeps the previous result", slot.res.detail === "kept", slot.res.detail);
  }
}

function finish() {
  console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
  process.exit(fail ? 1 : 0);
}
