/* The in-page panel's cache must have a lid, and a full store must not be silent.
 *
 * Every visit to a payment page writes program_<spid> / course_<spid> into chrome.storage.local,
 * and nothing ever removed one. They are a cache of two pages — a few KB per student — against a
 * 10 MB quota, so a few thousand students fills it. Someone checking students daily gets there in
 * months.
 *
 * The failure was the bad part, not the growth. set() reports a quota failure through
 * chrome.runtime.lastError, which nobody read, and the try/catch around it cannot see an
 * asynchronous error at all — so the write did nothing, the panel kept saying "not captured", and
 * visiting the pages again changed nothing. There was no way to tell that from the tool being
 * broken.
 *
 * This runs the real save/remember/sweep against a fake chrome.storage that can be told it is
 * full, and counts what is actually left in it.
 *
 *   node tests/capture-cache.js
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
const KEEP = +(/const KEEP = (\d+);/.exec(SRC) || [])[1];

/* a chrome.storage.local that behaves like the real one, including how it reports being full */
function store(opts) {
  opts = opts || {};
  const db = {};
  const api = {
    full: false,
    lastError: null,
    db: db,
    get: function (keys, cb) {
      const out = {};
      if (keys === null) Object.keys(db).forEach(function (k) { out[k] = db[k]; });
      else [].concat(keys).forEach(function (k) { if (k in db) out[k] = db[k]; });
      setTimeout(function () { cb(out); }, 0);
    },
    set: function (obj, cb) {
      const wasFull = api.full;
      if (!wasFull) Object.keys(obj).forEach(function (k) { db[k] = obj[k]; });
      setTimeout(function () {
        api.lastError = wasFull ? { message: "QUOTA_BYTES quota exceeded" } : null;
        if (cb) cb();
        api.lastError = null;
      }, 0);
    },
    remove: function (keys, cb) {
      [].concat(keys).forEach(function (k) { delete db[k]; });
      /* removing frees space — which is the whole reason the retry is worth making */
      if (opts.freeOnRemove) api.full = false;
      setTimeout(function () { if (cb) cb(); }, 0);
    }
  };
  return api;
}

/* build the three functions with the module scope they expect */
function panel(st, id) {
  const chrome = { runtime: { get id() { return "x"; }, get lastError() { return st.lastError; } },
    storage: { local: st } };
  const doc = { getElementById: function () { return { innerHTML: "" }; } };
  /* skey() too: save() calls it, and without it the ReferenceError lands in save's own catch and
     the harness sees a function that quietly does nothing — which is the very bug being tested. */
  return new Function("chrome", "document", "spid", "ctxAlive", "location", "KEEP", "skey",
    lift("sweep") + "\n" + lift("remember") + "\nlet retried = false;\n" + lift("full") + "\n" + lift("save") +
    "\nreturn { save: save, remember: remember, sweep: sweep };")(
    chrome, doc, function () { return id.v; }, function () { return true; },
    { href: "https://ums-5.osl.team/x" }, KEEP,
    function (type) { return type + "_" + id.v; });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms || 30));
const caps = (st) => Object.keys(st.db).filter((k) => /^(?:program|course)_/.test(k));

(async function () {
  check("the lid is a real number", KEEP > 0 && KEEP < 1000, "KEEP=" + KEEP);

  /* ---------- it stops growing ---------- */
  {
    const st = store();
    const id = { v: "0" };
    for (let i = 0; i < KEEP + 25; i++) {
      id.v = String(1000 + i);
      const p = panel(st, id);
      p.save("program", { rows: [] });
      await wait(6);
      p.save("course", { rows: [] });
      await wait(6);
    }
    await wait(60);
    check("visiting far more students than the lid does not keep them all",
      caps(st).length <= KEEP * 2, caps(st).length + " capture keys for " + (KEEP + 25) + " students");
    /* the most recent student must always still be there — that is the one being looked at */
    check("…and the student in front of you is one of the ones kept",
      ("program_" + id.v) in st.db && ("course_" + id.v) in st.db, Object.keys(st.db).join(" "));
    check("…while the first one visited is long gone", !("program_1000" in st.db), "program_1000");
  }

  /* ---------- what was already there before any of this existed ---------- */
  {
    const st = store();
    for (let i = 0; i < 900; i++) { st.db["program_" + i] = { data: 1 }; st.db["course_" + i] = { data: 1 }; }
    st.db.enabled = true; st.db.appTol = 0; st.db.manualOk = { a: 1 };
    const id = { v: "5000" };
    panel(st, id).save("program", { rows: [] });
    await wait(80);
    check("a store that filled up before the lid existed is swept once",
      caps(st).length <= KEEP * 2, caps(st).length + " capture keys left of 1800");
    /* the sweep must know the difference between the cache and everything else in the store */
    check("…and the sweep leaves the settings alone",
      st.db.enabled === true && st.db.appTol === 0 && st.db.manualOk, Object.keys(st.db).join(" "));
    check("…and keeps what was just captured", ("program_5000" in st.db), "program_5000");
  }

  /* ---------- a full store ---------- */
  {
    const st = store({ freeOnRemove: true });
    for (let i = 0; i < 200; i++) { st.db["program_" + i] = { data: 1 }; }
    st.db.caps = ["0"];              // a list exists, so this is not the first-run sweep
    st.full = true;
    const id = { v: "7000" };
    panel(st, id).save("program", { rows: [] });
    await wait(120);
    check("a full store is not the end of it — room is made and the write retried",
      ("program_7000" in st.db), Object.keys(st.db).filter(function (k) { return /7000/.test(k); }).join(",") || "not written");
  }

  /* ---------- and the failure is no longer invisible ---------- */
  {
    check("the quota failure is read where it actually arrives",
      /if \(chrome\.runtime\.lastError\) \{ full\(/.test(SRC), "content.js");
    check("…and the panel says so rather than going quiet",
      /full\(type, data\) \{[\s\S]*?umsrec-out[\s\S]*?verdict vno/.test(SRC), "content.js");
    /* one retry, not a loop: a store that is full for another reason must not spin */
    check("…and it tries once, not for ever", /if \(retried\) return;/.test(SRC), "content.js");
  }

  console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
  process.exit(fail ? 1 : 0);
})();
