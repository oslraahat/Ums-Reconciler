/* The checkpoints nobody came back for.
 *
 * Only one interrupted run is ever offered — the one "last" points at. But ckStart() only ever
 * wiped its OWN signature, so every other run that was stopped and then not resumed stayed in the
 * database for good: its whole imported sheet (kept beside the answers so a resume need not ask
 * for the file again) and every chunk of results it had written. At 100,000 rows that is tens of
 * megabytes per abandoned run, under a key nothing will ever look up.
 *
 * Nothing deletes them, so they only accumulate — on exactly the machines the tool is used on
 * most. That is the shape of "it is slow on some PCs": not the code, the leftovers.
 *
 * ckSweep() is checked against a store, not against its own source: which keys are gone and which
 * survived is the whole claim.
 *
 *   node tests/ck-sweep.js
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

function lift(name) {
  const at = APP.indexOf("\n  function " + name + "(");
  if (at < 0) throw new Error("no such function: " + name);
  let d = 0;
  for (let j = APP.indexOf("{", at); j < APP.length; j++) {
    if (APP[j] === "{") d++;
    else if (APP[j] === "}") { d--; if (!d) return APP.slice(at, j + 1); }
  }
  throw new Error("unbalanced " + name);
}

/* A store that behaves the way the "ck" object store does: getAllKeys returns a request whose
   .result the caller reads, delete just removes. idb() resolves with whatever the callback's
   request carries, which is how the real one hands getAllKeys back. */
function storeOf(keys) {
  const data = {};
  keys.forEach(function (k) { data[k] = 1; });
  const st = {
    getAllKeys: function () { return { result: Object.keys(data) }; },
    delete: function (k) { delete data[k]; }
  };
  return { st: st, data: data,
    idb: function (fn) { return Promise.resolve().then(function () { const r = fn(st); return r ? r.result : undefined; }); } };
}
function sweeper(store) {
  return new Function("idb", lift("ckSweep") + "\nreturn ckSweep;")(store.idb);
}

/* two abandoned runs, one live one, and the pointer */
const LIVE = "40-abc";
const KEYS = [
  "last",
  LIVE + "|ent", LIVE + "|meta", LIVE + "|c0", LIVE + "|c1",
  "100000-old1|ent", "100000-old1|meta", "100000-old1|c0", "100000-old1|c1", "100000-old1|c2",
  "512-old2|ent", "512-old2|meta", "512-old2|c0"
];

(async function () {
  {
    const s = storeOf(KEYS);
    const n = await sweeper(s)(LIVE);
    const left = Object.keys(s.data).sort();
    check("the two abandoned runs are deleted", n === 8, "deleted " + n);
    check("…and the run being kept is untouched",
      [LIVE + "|c0", LIVE + "|c1", LIVE + "|ent", LIVE + "|meta"].every((k) => k in s.data),
      left.join(" "));
    check("…and \"last\" survives, or the offer loses its pointer", "last" in s.data, left.join(" "));
    check("nothing else survives", left.length === 5, left.join(" "));
  }

  /* the page opens with no checkpoint at all: everything in there is orphaned */
  {
    const s = storeOf(KEYS);
    const n = await sweeper(s)("");
    check("with no run to keep, every checkpoint goes", n === KEYS.length - 1, "deleted " + n);
    check("…and only \"last\" is left", Object.keys(s.data).join(",") === "last",
      Object.keys(s.data).join(","));
  }

  /* a key that merely starts with the same characters is a different run */
  {
    const s = storeOf(["last", "40-abc|ent", "40-abcd|ent", "40-abcd|c0"]);
    await sweeper(s)("40-abc");
    check("a signature that is a prefix of another is not mistaken for it",
      !("40-abcd|ent" in s.data) && "40-abc|ent" in s.data, Object.keys(s.data).join(","));
  }

  /* an idle sweep must not write */
  {
    const s = storeOf(["last", LIVE + "|ent"]);
    let wrote = 0;
    const idb = function (fn) { wrote++; return s.idb(fn); };
    const sw = new Function("idb", lift("ckSweep") + "\nreturn ckSweep;")(idb);
    const n = await sw(LIVE);
    check("with nothing to clear, no second transaction is opened", n === 0 && wrote === 1,
      "deleted " + n + ", transactions " + wrote);
  }

  /* a database that refuses must not take the run down with it */
  {
    const sw = new Function("idb", lift("ckSweep") + "\nreturn ckSweep;")(
      function () { return Promise.reject(new Error("QuotaExceededError")); });
    let threw = false, got = null;
    try { got = await sw("x"); } catch (e) { threw = true; }
    check("a store that throws is survivable — the sweep is not worth a run", !threw && got === 0,
      threw ? "it threw" : String(got));
  }

  /* and it has to actually be called, in both places a run can begin or end up idle */
  const ckStart = lift("ckStart");
  check("ckStart() sweeps before it writes", /ckSweep\(ckKey\)/.test(ckStart), ckStart.slice(0, 120));
  const offer = (APP.match(/async function ckOffer\(\)[\s\S]*?\n  \}/) || [""])[0];
  check("ckOffer() sweeps when the page opens", /ckSweep\(sig\)/.test(offer));

  console.log(fail ? "\n" + fail + " FAILED" : "\nall good");
  process.exit(fail ? 1 : 0);
})();
