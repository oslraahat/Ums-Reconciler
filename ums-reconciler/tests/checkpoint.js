/* A run has to survive the tab being closed.
 *
 * At 100,000 students a run is four hundred thousand page loads and a couple of hours, and until
 * now all of it lived in the page's memory. A closed tab, a Chrome update, a machine that rebooted
 * overnight — every answer gone, with nothing to do but start again at the first student. Parsing
 * costs 115 seconds over such a run; losing the run costs the afternoon.
 *
 * There is no way to check this honestly without a browser: the checkpoint is IndexedDB, the thing
 * being protected is the run loop, and the whole question is whether state written by one page
 * load can be picked up by the next one. So this serves the real app.html over HTTP (IndexedDB is
 * refused on file://) and drives the real controls with Chrome.
 *
 * The second page is an iframe of the same page: same origin, so the same IndexedDB; a fresh
 * document, so a fresh app.js that has never seen the first. Two browser launches against one
 * profile would be closer to what a person does, and it was what this did — but the first browser
 * holds the profile lock after being killed, and killing it can take the last IndexedDB write with
 * it, which is the write the second load exists to find. Those failures moved with the weather and
 * said nothing about the tool.
 *
 * The servers are stubbed, not the app: fetch answers with UMS-shaped pages, and everything from
 * the paste box to the tiles is the shipped code.
 *
 *   node tests/checkpoint.js
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
let fail = 0;
const check = (name, ok, extra) => {
  if (!ok) fail++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (!ok && extra !== undefined ? "   " + extra : ""));
};

const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium"].filter((p) => fs.existsSync(p))[0];
if (!CHROME) { console.log("SKIP  Chrome not found — the checkpoint needs a real IndexedDB"); process.exit(0); }

const TOTAL = 40;      // students in the fixture sheet
const STOP_AT = 12;    // …and where the first page load is interrupted

/* ---------------- the page: real app.html, stubbed servers, a driver appended ---------------- */
const APP = fs.readFileSync(path.join(ROOT, "app.html"), "utf8");

const STUBS = `<script>
/* Only what app.js reaches for on load. Storage is in-memory: each launch starts with the same
   settings, so nothing but the checkpoint can carry state between them. */
window.chrome = { runtime: { id: "t", getManifest: function () { return { version: "0" }; } },
  storage: { local: {
    get: function (k, cb) { cb({ baseUrl: "https://ums-5.osl.team", srvMode: false, appConc: 4, appTol: 0, tolMigrated: true, theme: "dark", lang: "en" }); },
    set: function () {}, remove: function () {} }, onChanged: { addListener: function () {} } } };

/* UMS-shaped pages. Every student answers, so any student left unanswered at the end is the
   checkpoint's doing and not the fixture's. */
var HEAD = ["Sl.","MRN","Date","Course","Income","Receivable","Gross Received","Net Received","Current Due"];
function rows(reg, n) {
  var h = "";
  for (var i = 0; i < n; i++) {
    h += "<tr><td>" + (i + 1) + "</td><td>MRN" + reg + i + "</td><td>01/01/2025</td><td>Course " + i +
      "</td><td>5,000</td><td>5,000</td><td>5,000</td><td>5,000</td><td>-</td></tr>";
  }
  return h;
}
function tbl(id, reg, n) {
  return '<table id="' + id + '"><thead><tr>' + HEAD.map(function (c) { return "<th>" + c + "</th>"; }).join("") +
    "</tr></thead><tbody>" + rows(reg, n) + "</tbody></table>";
}
window.__hits = 0;
window.fetch = function (url) {
  window.__hits++;
  var reg = (String(url).match(/stdRollOrRegistrationNo=(\\d+)/) || [])[1] || "0";
  var course = /CourseWise/i.test(String(url));
  /* Split, so this string does not itself contain the tag the driver is injected before — it did,
     and the driver was spliced into the middle of this very line. */
  var body = "<html><bo" + "dy><div>" + tbl(course ? "courseWisePaymentTable" : "pw", reg, 2) + "</div></bo" + "dy></html>";
  return new Promise(function (res) {
    setTimeout(function () {
      res({ ok: true, status: 200, redirected: false,
        text: function () { return Promise.resolve(body); },
        headers: { get: function () { return null; } } });
    }, 150);
  });
};
</script>`;

/* The driver only ever touches the controls a person touches. */
const DRIVE = (phase) => `<script>
var out = [], t0 = Date.now();
function say(k, v) { out.push(k + "=" + v); }
/* The page decides when it is finished and says so, over XHR — window.fetch is stubbed a few
   lines above to answer as a UMS server, and sendBeacon was silently dropped in headless. */
function post(url, body) {
  try { var x = new XMLHttpRequest(); x.open("POST", url, true); x.send(body); } catch (e) {}
}
function done() { if (sent) return; sent = true; post("/done", out.join("\\n")); }
function until(what, fn, ms) {
  return new Promise(function (res, rej) {
    var end = Date.now() + (ms || 20000);
    (function tick() {
      var v; try { v = fn(); } catch (e) { v = false; }
      if (v) return res(v);
      if (Date.now() > end) return rej(new Error("gave up waiting for " + what +
        " · prog=" + ((document.getElementById("prog") || {}).textContent || "")));
      setTimeout(tick, 30);
    })();
  });
}
/* The line says "12/40" while a run is going and, once the two are equal, a single grouped "40" —
   one number twice was six characters of nothing on a line that had outgrown its badge. Read
   either, or a finished run reads as zero done. */
function doneCount() {
  var s = (document.getElementById("prog").textContent || "").replace(/,/g, "");
  var m = /(\\d+)\\/(\\d+)/.exec(s);
  if (m) return +m[1];
  m = /\\u2705[^\\u00b7]*\\u00b7\\s*(\\d+)/.exec(s);      // ✅ Done · 40 · …
  return m ? +m[1] : 0;
}
function readDb() {
  return new Promise(function (res) {
    var rq = indexedDB.open("umsrec", 2);
    rq.onerror = function () { res(null); };
    rq.onsuccess = function () {
      var db = rq.result, tx = db.transaction("ck", "readonly"), st = tx.objectStore("ck");
      var keys = st.getAllKeys(), vals = st.getAll();
      tx.oncomplete = function () { db.close(); res({ keys: keys.result || [], vals: vals.result || [] }); };
    };
  });
}
function saved(db) {
  /* how many answers the checkpoint actually holds — counted from the chunks, never from meta */
  var n = 0;
  (db ? db.keys : []).forEach(function (k, i) {
    if (!/\\|c\\d+$/.test(String(k))) return;
    (db.vals[i] || []).forEach(function (row) { n += (row.r || []).length; });
  });
  return n;
}

/* A page that never gets going and a page that gets stuck look identical from outside, so it
   says hello first. If the runner sees the ping and no result, the driver is the problem; if it
   sees neither, the browser never ran the script at all. */
post("/ping", "up");
/* A page that hangs and a page that never started look the same from outside. Report whatever has
   been collected before the runner gives up, so a stuck step names itself. */
var sent = false;
setTimeout(function () { say("watchdog", "fired"); done(); }, 90000);
window.addEventListener("error", function (e) { post("/ping", "page error: " + (e && e.message)); });

(async function () {
  try {
${phase}
  } catch (e) { say("error", (e && e.message) || e); }
  /* An iframe hands its lines to the page that opened it; the top document does the reporting. */
  if (window.parent !== window) {
    try { window.parent.postMessage({ umsrec: "phase-b", out: out.join("\\n") }, "*"); } catch (e) {}
    return;
  }
  done();
})();
</script>`;

/* Phase A — import a sheet, start, stop part-way, and see what was kept. */
const PHASE_A = `
    await until("the page to wire up", function () { return document.getElementById("paste"); });
    var lines = [];
    for (var i = 0; i < ${TOTAL}; i++) lines.push((100000 + i) + "," + (900000 + i));
    document.getElementById("paste").value = lines.join("\\n");
    document.getElementById("pasteBtn").click();
    await until("Start to become pressable", function () { return !document.getElementById("run").disabled; });
    say("bar_before", document.getElementById("ckBar").style.display === "none" ? "hidden" : "shown");
    document.getElementById("run").click();
    await until("the run to reach the stopping point", function () { return doneCount() >= ${STOP_AT}; }, 30000);
    document.getElementById("stop").click();
    await until("the run to stop", function () { return document.getElementById("stop").disabled; }, 30000);
    /* ckOffer() reads the database before it can put the bar up, so the bar is a moment behind
       the button. Waiting for it is the test being honest about what "offers it back" means. */
    await until("the resume bar", function () { return document.getElementById("ckBar").style.display !== "none"; }, 15000).catch(function () {});
    var d1 = doneCount();
    say("stopped_at", d1);
    say("hits", window.__hits);
    var db = await readDb();
    say("db_saved", saved(db));
    say("db_has_sheet", db && db.keys.some(function (k) { return /\\|ent$/.test(String(k)); }) ? "yes" : "no");
    say("db_has_last", db && db.keys.indexOf("last") >= 0 ? "yes" : "no");
    say("bar_after_stop", document.getElementById("ckBar").style.display === "none" ? "hidden" : "shown");
    say("bar_text", (document.getElementById("ckTxt").textContent || "").replace(/\\s+/g, " ").trim());

    /* Now the second page: same origin, same database, a document that has never seen this one.
       Its driver reports back through postMessage and its lines are folded in here with a b_
       prefix, so one POST carries both halves. */
    var second = await new Promise(function (res) {
      var done = false;
      window.addEventListener("message", function (e) {
        if (done || !e.data || e.data.umsrec !== "phase-b") return;
        done = true; res(String(e.data.out || ""));
      });
      var f = document.createElement("iframe");
      f.style.cssText = "position:fixed;left:0;top:0;width:1200px;height:900px;border:0";
      f.src = "/b.html";
      document.body.appendChild(f);
      setTimeout(function () { if (!done) { done = true; res("error=the second page never reported"); } }, 90000);
    });
    second.split("\\n").forEach(function (ln) { if (ln) out.push("b_" + ln); });
`;

/* Phase B — a page that has never seen phase A. The sheet was never imported here. */
const PHASE_B = `
    await until("the page to wire up", function () { return document.getElementById("ckBar"); });
    /* Before waiting on the bar, say what is actually in the database. A checkpoint that did not
       survive the restart and a checkpoint the page failed to offer look identical from the bar. */
    var start = await readDb();
    say("db_on_load", start ? start.keys.length + " keys, saved " + saved(start) : "unreadable");
    await until("the resume bar", function () { return document.getElementById("ckBar").style.display !== "none"; }, 15000);
    say("bar_on_load", "shown");
    say("bar_text", (document.getElementById("ckTxt").textContent || "").replace(/\\s+/g, " ").trim());
    say("count_before", (document.getElementById("cnt").textContent || "").trim());
    var before = window.__hits;
    document.getElementById("ckGo").click();
    await until("the resumed run to finish", function () { return /\\u2705/.test(document.getElementById("prog").textContent || ""); }, 60000);
    say("prog", (document.getElementById("prog").textContent || "").replace(/\\s+/g, " ").trim());
    say("total_done", doneCount());
    /* Which bucket the fixture lands in is the fixture's business; that every student lands in
       exactly one, and that they add up, is the checkpoint's. A student resumed twice would show
       up as a sum of 41 with nothing else out of place. */
    var tiles = ["t-ok", "t-no", "t-cw", "t-zero", "t-nf"].map(function (id) {
      return id + ":" + (document.getElementById(id).textContent || "0");
    });
    say("tiles", tiles.join(" "));
    say("tile_sum", tiles.reduce(function (n, x) { return n + (parseInt(x.split(":")[1], 10) || 0); }, 0));
    say("hits_after_resume", window.__hits - before);
    say("bar_at_end", document.getElementById("ckBar").style.display === "none" ? "hidden" : "shown");
    var db = await readDb();
    say("db_after_finish", db ? db.keys.length : -1);
`;

/* ---------------- serve it, run Chrome twice against one profile ---------------- */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "umsck-"));
/* lastIndexOf, not replace: the first </body> in the file may well belong to a string inside a
   stub rather than to the page, and splicing the driver into a string literal is a syntax error
   the browser reports on a line number that points at the stub. */
const page = (drive) => {
  const s = APP.replace('<script src="reconcile.js"></script>', STUBS + '<script src="reconcile.js"></script>');
  const at = s.lastIndexOf("</body>");
  if (at < 0) throw new Error("app.html has no </body> to inject the driver before");
  return s.slice(0, at) + drive + s.slice(at);
};
fs.writeFileSync(path.join(TMP, "a.html"), page(DRIVE(PHASE_A)));
fs.writeFileSync(path.join(TMP, "b.html"), page(DRIVE(PHASE_B)));
fs.mkdirSync(path.join(TMP, "menus", "adm"), { recursive: true }); fs.mkdirSync(path.join(TMP, "menus", "crm"), { recursive: true });
fs.mkdirSync(path.join(TMP, "lib"), { recursive: true });   // the xlsx/zip engine app.html now loads before the menus
["reconcile.js", "lib/xlsx.js", "lib/import.js", "app.js", "menus/adm/adm.js", "menus/crm/crm.js"].forEach((f) => fs.copyFileSync(path.join(ROOT, f), path.join(TMP, f)));

let waiting = null;   // the runner’s hand out, waiting for whichever page load is in flight
const pings = [];     // …and what the page said before it got there, for when it never does
const srv = http.createServer((req, res) => {
  if (req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      res.writeHead(204); res.end();
      if (req.url === "/ping") { pings.push(body); return; }
      const w = waiting; waiting = null;
      if (w) w(body);
    });
    return;
  }
  const f = path.join(TMP, decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "") || "a.html");
  fs.readFile(f, (e, b) => {
    if (e) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "Content-Type": /\.js$/.test(f) ? "text/javascript" : "text/html; charset=utf-8" });
    res.end(b);
  });
});

/* One page load: open it, wait for the page to say it is done, then close the browser. The
   profile is shared between loads on purpose — that shared IndexedDB is the thing under test. */
function load(file) {
  return new Promise((res) => {
    const ch = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-sandbox",
      "--disable-dev-shm-usage", "--user-data-dir=" + path.join(TMP, "prof"),
      "http://127.0.0.1:" + srv.address().port + "/" + file], { stdio: "ignore" });
    let timer = null, gone = false;
    ch.on("exit", () => { gone = true; });
    const finish = (body) => {
      if (timer) { clearTimeout(timer); timer = null; }
      /* Not immediately: the page has just told us it is done, but IndexedDB commits on its own
         schedule and killing the browser in the same breath can take the last transaction with
         it — which is the one the next load is here to find. */
      setTimeout(() => { try { ch.kill(); } catch (e) {} }, 1200);
      /* The two loads share one user-data-dir on purpose — that shared IndexedDB is the whole
         point — so the second launch cannot start while the first still holds the profile lock,
         and a browser that has been asked to die is not yet dead. Wait for it, up to three
         seconds, then carry on regardless. */
      const hand = () => {
        if (body == null) return res(null);
        const o = {};
        String(body).split("\n").forEach((ln) => { const i = ln.indexOf("="); if (i > 0) o[ln.slice(0, i)] = ln.slice(i + 1); });
        res(o);
      };
      const settle = (n) => { if (gone || n <= 0) return hand(); setTimeout(() => settle(n - 1), 100); };
      settle(45);
    };
    waiting = finish;
    timer = setTimeout(() => { waiting = null; finish(null); }, 120000);
  });
}

srv.listen(0, "127.0.0.1", async () => {
  const a = await load("a.html");
  if (!a) { console.log("FAIL  the first page load produced nothing" + (pings.length ? " (the page said: " + pings.join(" ; ") + ")" : " — and never even loaded the driver")); srv.close(); process.exit(1); }
  if (a.error) {
    console.log("FAIL  first load: " + a.error);
    if (pings.length) console.log("      the page also said: " + pings.join(" ; "));
    srv.close(); process.exit(1);
  }

  console.log("\n--- a run, interrupted ---");
  check("nothing is offered before there is anything to offer", a.bar_before === "hidden", a.bar_before);
  const stopped = +a.stopped_at;
  check("Stop stopped it part-way", stopped >= STOP_AT && stopped < TOTAL, a.stopped_at + "/" + TOTAL);
  /* The whole point: what was answered before the tab closed is on disk, not only on screen. */
  check("the answers so far are on disk", +a.db_saved > 0 && +a.db_saved <= stopped,
    a.db_saved + " saved of " + stopped + " done");
  check("…and the sheet went with them", a.db_has_sheet === "yes", a.db_has_sheet);
  check("…and there is a run to find", a.db_has_last === "yes", a.db_has_last);
  check("Stop offers it straight back", a.bar_after_stop === "shown", a.bar_after_stop);
  check("…saying how far it got", /\d/.test(a.bar_text || ""), a.bar_text);

  /* The second page's lines came back inside the first POST, each prefixed b_ */
  const b = {};
  Object.keys(a).forEach(function (k) { if (k.indexOf("b_") === 0) b[k.slice(2)] = a[k]; });
  if (!Object.keys(b).length) {
    console.log("FAIL  the second page never reported" +
      (pings.length ? " (the page said: " + pings.join(" ; ") + ")" : ""));
    srv.close(); process.exit(1);
  }
  if (b.error) {
    console.log("FAIL  second page: " + b.error +
      (b.db_on_load ? "  —  the database held: " + b.db_on_load : ""));
    srv.close(); process.exit(1);
  }

  console.log("\n--- a new page, which never saw the first ---");
  check("the offer is there on opening the page", b.bar_on_load === "shown", b.bar_on_load);
  check("…before any sheet has been imported", /^0\b|^০/.test(b.count_before || "x"), b.count_before);
  check("carrying on finishes the run", +b.total_done === TOTAL, b.total_done + "/" + TOTAL);
  /* The saved half must not be asked for a second time — that is the entire saving. */
  const perStudent = +a.hits / Math.max(1, stopped);
  const expected = (TOTAL - +a.db_saved) * perStudent;
  check("the students already answered are not asked again",
    +b.hits_after_resume < expected * 1.35 + 8,
    b.hits_after_resume + " requests for " + (TOTAL - +a.db_saved) + " students left (≈" + Math.round(expected) + " expected)");
  /* Not "how many matched" — the fixture decides that. Every student in exactly one bucket, and
     the buckets adding to the sheet, is what a resumed run can get wrong: replay one chunk twice
     and this is 41, drop one and it is 39, and the progress line says 40 either way. */
  check("every student is accounted for exactly once", +b.tile_sum === TOTAL,
    b.tile_sum + " across the tiles, of " + TOTAL + "  [" + b.tiles + "]");
  check("a finished run stops offering itself", b.bar_at_end === "hidden", b.bar_at_end);
  check("…and takes its checkpoint with it", +b.db_after_finish === 0, b.db_after_finish + " keys left");

  srv.close();
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
  console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
  process.exit(fail ? 1 : 0);
});
