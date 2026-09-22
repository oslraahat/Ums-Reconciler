/* Choose a folder, run, then run again.
 *
 * Reported: after picking the save folder the first run lands where it should and a later one does
 * not. Everything about that is timing and permissions, so none of it can be read off the source —
 * saveRun() only QUERIES the folder permission, because asking for it needs a click and there is
 * no click at the end of a run. Whatever a lapsed permission does, it does silently: the catch in
 * saveRun() swallows the reason and falls through to Downloads.
 *
 * So this drives the real page with a real File System Access API standing in for the real one:
 * an in-memory directory that records every write and can be told to let its permission lapse the
 * way Chrome's does. Then it runs twice and looks at what is on disk after each.
 *
 * What lands there is one file: the workbook. The page used to be written beside it and is not any
 * more — it is the expensive half, and the workbook already holds every row in two tabs.
 *
 *   node tests/save-twice.js
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
if (!CHROME) { console.log("SKIP  Chrome not found — saving needs a real page"); process.exit(0); }

const TOTAL = 40;
const APP = fs.readFileSync(path.join(ROOT, "app.html"), "utf8");

/* ---------------- the stubs: a server, a folder, and a downloads shelf ---------------- */
const STUBS = `<script>
window.chrome = { runtime: { id: "t", getManifest: function () { return { version: "0" }; } },
  storage: { local: {
    get: function (k, cb) { cb({ baseUrl: "https://ums-5.osl.team", srvMode: false, appConc: 4,
      appTol: 0, tolMigrated: true, theme: "dark", lang: "en", saveOnFinish: true }); },
    set: function () {}, remove: function () {} }, onChanged: { addListener: function () {} } },
  downloads: { download: function (o, cb) { window.__dl.push(o.filename); if (cb) cb(1); } } };
window.__dl = [];
/* how long a page takes to come back — turned up when a run has to be caught mid-flight */
window.__lag = 40;

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
window.fetch = function (url) {
  var reg = (String(url).match(/stdRollOrRegistrationNo=(\\d+)/) || [])[1] || "0";
  var course = /CourseWise/i.test(String(url));
  var body = "<html><bo" + "dy><div>" + tbl(course ? "courseWisePaymentTable" : "pw", reg, 2) + "</div></bo" + "dy></html>";
  return new Promise(function (res) {
    setTimeout(function () {
      res({ ok: true, status: 200, redirected: false,
        text: function () { return Promise.resolve(body); },
        headers: { get: function () { return null; } } });
    }, window.__lag);
  });
};

/* A directory handle that behaves like the real one, including the part that matters: permission
   is a piece of state the browser may take away, and queryPermission then says "prompt" while
   requestPermission needs a user gesture to say "granted" again. */
window.__fsPerm = "granted";       // what queryPermission will answer
window.__fsGesture = false;        // whether requestPermission is allowed to succeed
window.__written = [];             // "folder/name.ext:bytes", in the order they were written
window.__requests = [];            // every requestPermission call, and what it answered
function dirHandle(name) {
  return {
    kind: "directory", name: name,
    queryPermission: function () { return Promise.resolve(window.__fsPerm); },
    requestPermission: function () {
      /* the real API resolves "prompt"/"denied" without a gesture and cannot show its dialog */
      var got = window.__fsGesture ? "granted" : window.__fsPerm;
      window.__requests.push(got);
      if (got === "granted") window.__fsPerm = "granted";
      return Promise.resolve(got);
    },
    getDirectoryHandle: function (sub) {
      if (window.__fsPerm !== "granted") return Promise.reject(new DOMException("not allowed", "NotAllowedError"));
      return Promise.resolve({
        kind: "directory", name: sub,
        getFileHandle: function (fname) {
          if (window.__fsPerm !== "granted") return Promise.reject(new DOMException("not allowed", "NotAllowedError"));
          return Promise.resolve({ createWritable: function () {
            var size = 0;
            return Promise.resolve({
              write: function (b) { size += (b && b.size) || 0; return Promise.resolve(); },
              close: function () { window.__written.push(sub + "/" + fname + ":" + size); return Promise.resolve(); }
            });
          } });
        }
      });
    }
  };
}
window.showDirectoryPicker = function () {
  window.__fsGesture = true;       // the picker only opens from a click
  return Promise.resolve(dirHandle("Reports"));
};
</script>`;

const DRIVE = `<script>
var out = [], sent = false;
function say(k, v) { out.push(k + "=" + v); }
function post(url, body) { try { var x = new XMLHttpRequest(); x.open("POST", url, true); x.send(body); } catch (e) {} }
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
function finished() { return /\\u2705/.test(prog()); }
/* A run that has not started yet and a run that has ended both show the LAST run's tick, so
   waiting for the tick alone matches the previous run and reads its files as this one's — which
   is how a second run appeared to pass while writing nothing at all. Wait for the run to be under
   way first: Stop is enabled for exactly as long as one is. */
async function runOnce(which) {
  document.getElementById("run").click();
  await until(which + " to start", function () { return !document.getElementById("stop").disabled; }, 30000);
  await until(which + " to finish", function () {
    return document.getElementById("stop").disabled && finished(); }, 60000);
}

post("/ping", "up");
setTimeout(function () { say("watchdog", "fired"); done(); }, 120000);
window.addEventListener("error", function (e) { post("/ping", "page error: " + (e && e.message)); });

(async function () {
  try {
    await until("the page to wire up", function () { return document.getElementById("paste"); });
    var lines = [];
    for (var i = 0; i < ${TOTAL}; i++) lines.push((100000 + i) + "," + (900000 + i));
    document.getElementById("paste").value = lines.join("\\n");
    document.getElementById("pasteBtn").click();
    await until("Start", function () { return !document.getElementById("run").disabled; });

    /* the folder is chosen the way a person chooses it */
    say("save_on", document.getElementById("saveSw").checked ? "yes" : "no");
    document.getElementById("pickDir").click();
    await until("the folder to be remembered", function () {
      return /Reports/.test(document.getElementById("saveWhere").textContent || ""); });
    say("where", (document.getElementById("saveWhere").textContent || "").trim());

    /* ---- first run ---- */
    await runOnce("the first run");
    say("prog1", prog());
    say("files1", window.__written.join(" | "));
    say("dl1", window.__dl.join(" | "));

    /* ---- second run, everything still granted ---- */
    window.__written = [];
    window.__dl = [];
    await new Promise(function (r) { setTimeout(r, 1100); });   // the folder name carries seconds
    await runOnce("the second run");
    say("prog2", prog());
    say("files2", window.__written.join(" | "));
    say("dl2", window.__dl.join(" | "));

    /* ---- third run, after the browser has taken the permission back ----
       This is what a reopened page is: the handle is still in IndexedDB, the grant is not. */
    window.__written = [];
    window.__dl = [];
    window.__requests = [];
    window.__fsPerm = "prompt";
    window.__fsGesture = false;      // …and no gesture is pending at the END of a run
    await new Promise(function (r) { setTimeout(r, 1100); });
    /* A click IS a gesture, and only for a moment: if the tool asks while pressing Start it can
       have the permission, and if it waits until the run ends it cannot. */
    window.__fsGesture = true;
    setTimeout(function () { window.__fsGesture = false; }, 1000);
    await runOnce("the third run");
    say("prog3", prog());
    say("files3", window.__written.join(" | "));
    say("dl3", window.__dl.join(" | "));
    say("asked3", window.__requests.join(","));
    say("perm3", window.__fsPerm);

    /* ---- and the run that is picked up rather than started ----
       This is the case the folder is most likely to have been lost in: a resumed run is one whose
       page was closed, and closing the page is what takes the write permission away. It does not
       go through Start at all — "▶ Carry on" is its own button — so everything Start does before
       a run has to be done here too, or the recovered run is the one that saves itself elsewhere. */
    window.__written = [];
    window.__dl = [];
    window.__requests = [];
    window.__lag = 300;                 // slow enough to be caught part-way
    await new Promise(function (r) { setTimeout(r, 1100); });
    document.getElementById("run").click();
    await until("a fourth run to start", function () { return !document.getElementById("stop").disabled; }, 30000);
    await until("it to get somewhere", function () {
      var m = /(\\d+)\\//.exec(prog()); return m && +m[1] >= 8; }, 30000);
    document.getElementById("stop").click();
    await until("it to stop", function () { return document.getElementById("stop").disabled; }, 30000);
    await until("the resume bar", function () {
      return document.getElementById("ckBar").style.display !== "none"; }, 15000);
    say("bar", "shown");
    say("stopped_at", prog());
    /* A stopped run saves what it has, so the files just written are ITS files. Clear them here,
       after the stop and before the resume, or the resumed run inherits a pass it did not earn. */
    window.__written = [];
    window.__dl = [];
    window.__requests = [];
    /* the page has been closed, as far as the folder is concerned */
    window.__fsPerm = "prompt";
    window.__fsGesture = true;                                    // Carry on is a click too
    setTimeout(function () { window.__fsGesture = false; }, 1000);
    window.__lag = 40;
    document.getElementById("ckGo").click();
    /* and the same trap as before: the stopped run's ✅ is still on screen, so waiting for a tick
       alone matches it and reads the stopped run as the resumed one */
    await until("the resumed run to start", function () {
      return !document.getElementById("stop").disabled; }, 30000);
    await until("the resumed run to finish", function () {
      return document.getElementById("stop").disabled && finished(); }, 60000);
    say("prog4", prog());
    say("files4", window.__written.join(" | "));
    say("dl4", window.__dl.join(" | "));
    say("asked4", window.__requests.join(","));
  } catch (e) { say("error", (e && e.message) || e); }
  done();
})();
</script>`;

/* ---------------- serve and run ---------------- */
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "umssv-"));
const s = APP.replace('<script src="reconcile.js"></script>', STUBS + '<script src="reconcile.js"></script>');
const at = s.lastIndexOf("</body>");
if (at < 0) throw new Error("app.html has no </body> to inject the driver before");
fs.writeFileSync(path.join(TMP, "a.html"), s.slice(0, at) + DRIVE + s.slice(at));
fs.mkdirSync(path.join(TMP, "menus", "adm"), { recursive: true }); fs.mkdirSync(path.join(TMP, "menus", "crm"), { recursive: true });
["reconcile.js", "app.js", "menus/adm/adm.js", "menus/crm/crm.js"].forEach((f) => fs.copyFileSync(path.join(ROOT, f), path.join(TMP, f)));

let waiting = null;
const pings = [];
const srv = http.createServer((req, res) => {
  if (req.method === "POST") {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      res.writeHead(204); res.end();
      if (req.url === "/ping") { pings.push(body); return; }
      const w = waiting; waiting = null; if (w) w(body);
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

const names = (v) => String(v || "").split(" | ").filter(Boolean)
  .map((x) => x.split(":")[0].split("/").pop()).sort().join(",");
const bytes = (v) => String(v || "").split(" | ").filter(Boolean)
  .map((x) => +x.split(":").pop()).filter((n) => n > 0).length;

srv.listen(0, "127.0.0.1", () => {
  const ch = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-sandbox",
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
    if (o.error) {
      console.log("FAIL  " + o.error);
      if (pings.length) console.log("      the page also said: " + pings.join(" ; "));
      srv.close(); process.exit(1);
    }

    console.log("\n--- the folder is chosen, then a run ---");
    check("saving is on and the folder is shown", /Reports/.test(o.where || ""), o.where);
    check("the first run writes the workbook into it", names(o.files1) === "report.xlsx",
      o.files1 || "(nothing)");
    check("…and it is not empty", bytes(o.files1) === 1, o.files1);
    check("…and nothing went to Downloads", !o.dl1, o.dl1);
    check("…and the page says where it went", /Reports/.test(o.prog1 || ""), o.prog1);

    console.log("\n--- and then the same page runs again ---");
    check("the second run writes it too", names(o.files2) === "report.xlsx",
      o.files2 || "(nothing)");
    check("…and it is not empty", bytes(o.files2) === 1, o.files2);
    check("…into a folder of its own, not the first run's",
      String(o.files2).split("/")[0] !== String(o.files1).split("/")[0],
      String(o.files1).split("/")[0] + " vs " + String(o.files2).split("/")[0]);
    check("…still not to Downloads", !o.dl2, o.dl2);
    check("…and still says the folder", /Reports/.test(o.prog2 || ""), o.prog2);

    console.log("\n--- and after the browser takes the permission back ---");
    check("Start asks for the folder permission, while there is still a click to carry it",
      /granted/.test(o.asked3 || ""), o.asked3 ? "asked, got " + o.asked3 : "never asked");
    check("…so the run still lands in the chosen folder",
      names(o.files3) === "report.xlsx", o.files3 || "(nothing — it went elsewhere)");
    check("…and not into Downloads", !o.dl3, o.dl3);
    check("…and the run is never lost either way",
      names(o.files3) === "report.xlsx" || /report\.xlsx/.test(o.dl3 || ""),
      "folder: " + (o.files3 || "-") + "   downloads: " + (o.dl3 || "-"));

    console.log("\n--- and a run picked up after a stop, not started ---");
    check("the interrupted run is offered back", o.bar === "shown", o.bar);
    check("…part-way through, not at the end",
      /\b8\/40\b/.test(o.stopped_at || ""), o.stopped_at);
    check("Carry on asks for the folder too — it is a run starting",
      /granted/.test(o.asked4 || ""), o.asked4 ? "asked, got " + o.asked4 : "never asked");
    check("…so the recovered run lands in the chosen folder",
      names(o.files4) === "report.xlsx", o.files4 || "(nothing — it went elsewhere)");
    check("…and not into Downloads", !o.dl4, o.dl4);
    /* a finished run says one grouped number, not "40/40" — the same figure twice was six
       characters of nothing on a line that had outgrown its badge */
    check("…and it finished the whole sheet",
      new RegExp("✅[^·]*·\\s*" + TOTAL + "\\b").test(o.prog4 || ""), o.prog4);

    console.log(fail ? "\n" + fail + " FAILED" : "\nall good");
    srv.close();
    setTimeout(() => process.exit(fail ? 1 : 0), 500);
  };
});
