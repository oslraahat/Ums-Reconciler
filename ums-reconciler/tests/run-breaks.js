/* A run that throws must give the page back.
 *
 * startRun() disables Start and enables Stop as its first act, and the line that undid that sat at
 * the very end of the happy path. So anything that threw in between — a builder, a render, a
 * browser refusing memory to a hundred-thousand-row page — left Start disabled, Stop enabled,
 * `run` still set, and not one word on screen. A tool that had stopped, looking exactly like a
 * tool still working, until somebody reloaded the tab and the hours went with it.
 *
 * There is no way to check this by reading: the question is what the page looks like after a
 * throw, so something has to throw. The saving step is the one place a run reaches for code that
 * can fail for reasons outside itself, so that is where the fault is injected — a folder handle
 * that throws when written to, which is a folder that filled up or was unplugged.
 *
 *   node tests/run-breaks.js
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
if (!CHROME) { console.log("SKIP  Chrome not found — a run has to break to be watched"); process.exit(0); }

const TOTAL = 12;
const APP = fs.readFileSync(path.join(ROOT, "app.html"), "utf8");

const STUBS = `<script>
window.chrome = { runtime: { id: "t", getManifest: function () { return { version: "0" }; } },
  storage: { local: {
    get: function (k, cb) { cb({ baseUrl: "https://ums-5.osl.team", srvMode: false, appConc: 4,
      appTol: 0, tolMigrated: true, theme: "dark", lang: "en", saveOnFinish: true }); },
    set: function () {}, remove: function () {} }, onChanged: { addListener: function () {} } },
  downloads: { download: function (o, cb) { if (cb) cb(1); } } };

var HEAD = ["Sl.","MRN","Date","Course","Income","Receivable","Gross Received","Net Received","Current Due"];
function tbl(id, reg) {
  var h = '<table id="' + id + '"><thead><tr>' + HEAD.map(function (c) { return "<th>" + c + "</th>"; }).join("") +
    "</tr></thead><tbody>";
  for (var i = 0; i < 2; i++) {
    h += "<tr><td>" + (i + 1) + "</td><td>MRN" + reg + i + "</td><td>01/01/2025</td><td>Course " + i +
      "</td><td>5,000</td><td>5,000</td><td>5,000</td><td>5,000</td><td>-</td></tr>";
  }
  return h + "</tbody></table>";
}
window.fetch = function (url) {
  var reg = (String(url).match(/stdRollOrRegistrationNo=(\\d+)/) || [])[1] || "0";
  var course = /CourseWise/i.test(String(url));
  var body = "<html><bo" + "dy><div>" + tbl(course ? "courseWisePaymentTable" : "pw", reg) + "</div></bo" + "dy></html>";
  return new Promise(function (res) {
    setTimeout(function () {
      res({ ok: true, status: 200, redirected: false,
        text: function () { return Promise.resolve(body); },
        headers: { get: function () { return null; } } });
    }, 20);
  });
};

/* A folder that accepts being chosen and then fails when written to — a disk that filled up, or a
   drive pulled out between choosing and finishing. saveRun() catches its own writes, so the fault
   is put where nothing catches it: the handle throws on the way in. */
window.__breakSave = false;
window.showDirectoryPicker = function () {
  return Promise.resolve({
    kind: "directory", name: "Reports",
    queryPermission: function () { return Promise.resolve("granted"); },
    requestPermission: function () { return Promise.resolve("granted"); },
    getDirectoryHandle: function (sub) {
      if (window.__armAtSave) window.__breakNums = true;   // …lands in the finished line, nowhere else
      if (window.__breakSave) throw new TypeError("the folder went away");
      return Promise.resolve({
        kind: "directory", name: sub,
        getFileHandle: function () {
          return Promise.resolve({ createWritable: function () {
            return Promise.resolve({ write: function () { return Promise.resolve(); },
              close: function () { return Promise.resolve(); } });
          } });
        }
      });
    }
  });
};

/* Somewhere genuinely unguarded. The save has a catch of its own — proved below — so a fault
   there is handled by design and never reaches the run's own net. The progress line does not:
   it formats the rate with toLocaleString on every flush, inside the worker loop, with nothing
   between it and startRun(). A locale that throws is far-fetched; a render that throws is not,
   and this is the same shape. */
/* A headless browser has nobody to answer a dialog and stands there while the renderer waits —
   which is exactly what the run after the broken one looked like until this was here. Start asks
   about the checkpoint the broken run left behind; the answer is yes, start fresh. */
window.confirm = function () { return true; };

window.__breakNums = false;
var realToLocale = Number.prototype.toLocaleString;
Number.prototype.toLocaleString = function () {
  if (window.__breakNums) throw new RangeError("the page ran out of somewhere to put it");
  return realToLocale.apply(this, arguments);
};
</script>`;

const DRIVE = `<script>
var out = [], sent = false;
function say(k, v) { out.push(k + "=" + v); }
function post(u, b) { try { var x = new XMLHttpRequest(); x.open("POST", u, true); x.send(b); } catch (e) {} }
function done() { if (sent) return; sent = true; post("/done", out.join("\\n")); }
function until(what, fn, ms) {
  return new Promise(function (res, rej) {
    var end = Date.now() + (ms || 30000);
    (function tick() {
      var v; try { v = fn(); } catch (e) { v = false; }
      if (v) return res(v);
      if (Date.now() > end) return rej(new Error("gave up waiting for " + what + " · prog=" +
        ((document.getElementById("prog") || {}).textContent || "")));
      setTimeout(tick, 30);
    })();
  });
}
var prog = function () { return (document.getElementById("prog").textContent || "").replace(/\\s+/g, " ").trim(); };
function step(n) { post("/ping", "at " + n + " — " + prog()); }
var state = function () {
  return ["run", "stop", "pause"].map(function (i) {
    return i + ":" + (document.getElementById(i).disabled ? "off" : "on"); }).join(" ");
};

post("/ping", "up");
setTimeout(function () { say("watchdog", "fired"); done(); }, 60000);
window.addEventListener("error", function (e) { post("/ping", "page error: " + (e && e.message)); });
window.addEventListener("unhandledrejection", function (e) {
  say("unhandled", (e.reason && e.reason.message) || e.reason);
});

(async function () {
  try {
    await until("the page", function () { return document.getElementById("paste"); });
    var lines = [];
    for (var i = 0; i < ${TOTAL}; i++) lines.push((100000 + i) + "," + (900000 + i));
    document.getElementById("paste").value = lines.join("\\n");
    document.getElementById("pasteBtn").click();
    await until("Start", function () { return !document.getElementById("run").disabled; });

    /* choose the folder, so the run gets as far as trying to write */
    document.getElementById("pickDir").click();
    await until("the folder", function () {
      return /Reports/.test(document.getElementById("saveWhere").textContent || ""); });

    /* ---- a run that finishes normally, for the comparison ---- */
    document.getElementById("run").click();
    await until("the good run", function () {
      return document.getElementById("stop").disabled && /\\u2705/.test(prog()); }, 60000);
    step("good run done");
    say("good_state", state());
    say("good_prog", prog());

    /* ---- and one where the folder goes away mid-save ---- */
    window.__breakSave = true;
    await new Promise(function (r) { setTimeout(r, 1100); });
    document.getElementById("run").click();
    await until("the broken run to start", function () {
      return !document.getElementById("stop").disabled; }, 30000);
    await until("the page to come back", function () {
      return document.getElementById("stop").disabled; }, 60000);
    step("savefail done");
    say("savefail_state", state());
    say("savefail_prog", prog());

    /* ---- and now one that throws where nothing is catching ---- */
    window.__breakSave = false;
    await new Promise(function (r) { setTimeout(r, 1100); });
    window.__armAtSave = true;
    document.getElementById("run").click();
    await until("the third run to start", function () {
      return !document.getElementById("stop").disabled; }, 30000);
    step("third started");
    await until("the page to come back", function () {
      return document.getElementById("stop").disabled; }, 60000);
    window.__breakNums = false; window.__armAtSave = false;
    step("third came back");
    say("broke_state", state());
    say("broke_prog", prog());
    say("bar", document.getElementById("ckBar").style.display === "none" ? "hidden" : "shown");

    /* ---- and the page has to be usable afterwards: another run must go ---- */
    window.__breakSave = false;
    await new Promise(function (r) { setTimeout(r, 1100); });
    var canStart = !document.getElementById("run").disabled;
    say("can_start_again", canStart ? "yes" : "no");
    if (canStart) {
      document.getElementById("run").click();
      /* a checkpoint may be on offer, which Start asks about — answer it */
      await until("the third run", function () {
        return document.getElementById("stop").disabled && /\\u2705/.test(prog()); }, 60000)
        .catch(function () {});
      say("third_prog", prog());
      say("third_state", state());
    }
  } catch (e) { say("error", (e && e.message) || e); }
  done();
})();
<\/script>`;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "umsbk-"));
const s = APP.replace('<script src="reconcile.js"></script>', STUBS + '<script src="reconcile.js"></script>');
const at = s.lastIndexOf("</body>");
fs.writeFileSync(path.join(TMP, "a.html"), s.slice(0, at) + DRIVE + s.slice(at));
fs.mkdirSync(path.join(TMP, "menus", "adm"), { recursive: true }); fs.mkdirSync(path.join(TMP, "menus", "crm"), { recursive: true });
fs.mkdirSync(path.join(TMP, "lib"), { recursive: true });   // the xlsx/zip engine app.html now loads before the menus
["reconcile.js", "lib/xlsx.js", "lib/import.js", "app.js", "menus/adm/adm.js", "menus/crm/crm.js"].forEach((f) => fs.copyFileSync(path.join(ROOT, f), path.join(TMP, f)));

let waiting = null;
const pings = [];
const srv = http.createServer((q, r) => {
  if (q.method === "POST") {
    let b = ""; q.on("data", (c) => { b += c; });
    q.on("end", () => {
      r.writeHead(204); r.end();
      if (q.url === "/ping") { pings.push(b); return; }
      const w = waiting; waiting = null; if (w) w(b);
    });
    return;
  }
  const f = path.join(TMP, decodeURIComponent(q.url.split("?")[0]).replace(/^\/+/, "") || "a.html");
  fs.readFile(f, (e, b) => {
    if (e) { r.writeHead(404); r.end(); return; }
    r.writeHead(200, { "Content-Type": /\.js$/.test(f) ? "text/javascript" : "text/html; charset=utf-8" });
    r.end(b);
  });
});

srv.listen(0, "127.0.0.1", () => {
  const ch = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
    "--disable-dev-shm-usage", "--user-data-dir=" + path.join(TMP, "prof"),
    "http://127.0.0.1:" + srv.address().port + "/a.html"], { stdio: "ignore" });
  const timer = setTimeout(() => { const w = waiting; waiting = null; if (w) w(null); }, 180000);
  waiting = (body) => {
    clearTimeout(timer);
    setTimeout(() => { try { ch.kill(); } catch (e) {} }, 400);
    if (!body) {
      console.log("FAIL  the page produced nothing" + (pings.length ? " (it said: " + pings.join(" ; ") + ")" : ""));
      srv.close(); process.exit(1);
    }
    const o = {};
    String(body).split("\n").forEach((ln) => { const i = ln.indexOf("="); if (i > 0) o[ln.slice(0, i)] = ln.slice(i + 1); });
    if (o.error) { console.log("FAIL  " + o.error); }
    if (pings.length) console.log("trail: " + pings.join(" | "));

    console.log("\n--- a run that finishes ---");
    check("the page comes back", o.good_state === "run:on stop:off pause:off", o.good_state);
    check("…and says it is done", /✅/.test(o.good_prog || ""), o.good_prog);

    console.log("\n--- a folder that goes away mid-save, which IS caught ---");
    check("the run still finishes", /✅/.test(o.savefail_prog || ""), o.savefail_prog);
    check("…falling back to Downloads rather than losing the work",
      /Downloads/.test(o.savefail_prog || ""), o.savefail_prog);
    check("…with the page back in hand",
      o.savefail_state === "run:on stop:off pause:off", o.savefail_state);

    console.log("\n--- and one that throws where nothing catches ---");
    check("the page comes back all the same", o.broke_state === "run:on stop:off pause:off", o.broke_state);
    check("…and says something went wrong, rather than nothing at all",
      /⚠/.test(o.broke_prog || "") && !/✅/.test(o.broke_prog || ""), o.broke_prog);
    check("…naming the tool rather than the data",
      /went wrong inside the tool/.test(o.broke_prog || ""), o.broke_prog);
    /* Twelve students and a checkpoint that writes every three hundred: this run broke before one
       chunk was ever written, so there is nothing saved to come back to and the bar is right to
       stay down. What matters is that the checkpoint was not left claiming otherwise. */
    check("…and offers nothing, there being nothing saved yet", o.bar === "hidden", o.bar);

    console.log("\n--- and the page is usable afterwards ---");
    check("Start can be pressed again", o.can_start_again === "yes", o.can_start_again);
    check("…and the next run finishes", /✅/.test(o.third_prog || ""), o.third_prog);
    check("…leaving the buttons where they belong",
      o.third_state === "run:on stop:off pause:off", o.third_state);

    if (o.unhandled) { console.log("FAIL  an unhandled rejection escaped: " + o.unhandled); fail++; }

    console.log(fail ? "\n" + fail + " FAILED" : "\nall good");
    srv.close();
    setTimeout(() => process.exit(fail ? 1 : 0), 400);
  };
});
