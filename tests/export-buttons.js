/* The three ⬇ buttons, pressed.
 *
 * Everything about the files themselves is covered — the workbook's zip, its two tabs, the page's
 * markup, the text dump, how large each comes out, and what happens when a builder throws. What
 * was never covered is the last few inches: a person clicks the button, and something with the
 * right name and some bytes in it leaves the page. Between the builders and that click sit
 * flatRows(), the filter, fileTag(), stamp() and dl() — and a mistake in any of them produces a
 * button that looks fine and hands over nothing.
 *
 * So this runs the real page against stub servers, does a real run, and clicks all three. The
 * blobs are caught at URL.createObjectURL and the anchor at .click(), which is as far as a
 * download can go in a headless browser and one inch further than the code under test.
 *
 * The filter is exercised too, because the buttons honour it and the automatic save does not —
 * two behaviours one line apart, and the one on the buttons is the one a person sees.
 *
 *   node tests/export-buttons.js
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
if (!CHROME) { console.log("SKIP  Chrome not found — a button has to be clicked to be tested"); process.exit(0); }

const TOTAL = 30;
const APP = fs.readFileSync(path.join(ROOT, "app.html"), "utf8");

const STUBS = `<script>
window.chrome = { runtime: { id: "t", getManifest: function () { return { version: "0" }; } },
  storage: { local: {
    get: function (k, cb) { cb({ baseUrl: "https://ums-5.osl.team", srvMode: false, appConc: 6,
      appTol: 0, tolMigrated: true, theme: "dark", lang: "en" }); },
    set: function () {}, remove: function () {} }, onChanged: { addListener: function () {} } },
  downloads: { download: function (o, cb) { if (cb) cb(1); } } };

/* every third student is a mismatch, so a filter has something to select */
var HEAD = ["Sl.","MRN","Date","Course","Income","Receivable","Gross Received","Net Received","Current Due"];
function tbl(id, reg, paid) {
  var h = '<table id="' + id + '"><thead><tr>' + HEAD.map(function (c) { return "<th>" + c + "</th>"; }).join("") +
    "</tr></thead><tbody>";
  for (var i = 0; i < 3; i++) {
    h += "<tr><td>" + (i + 1) + "</td><td>MRN" + reg + i + "</td><td>01/01/2025</td><td>Course " + i +
      "</td><td>5,000</td><td>5,000</td><td>" + paid + "</td><td>" + paid + "</td><td>-</td></tr>";
  }
  return h + "</tbody></table>";
}
window.fetch = function (url) {
  var u = String(url);
  var reg = (u.match(/stdRollOrRegistrationNo=(\\d+)/) || [])[1] || "0";
  var course = /CourseWise/i.test(u);
  /* the Course Wise side pays less on every third student — a real difference, not a missing page */
  var odd = (+reg) % 3 === 0;
  var paid = (course && odd) ? "4,000" : "5,000";
  var body = "<html><bo" + "dy><div>" + tbl(course ? "courseWisePaymentTable" : "pw", reg, paid) + "</div></bo" + "dy></html>";
  return new Promise(function (res) {
    setTimeout(function () {
      res({ ok: true, status: 200, redirected: false,
        text: function () { return Promise.resolve(body); },
        headers: { get: function () { return null; } } });
    }, 20);
  });
};

/* catch the download where it is born, and stop the anchor before the browser sees it */
window.__files = [];
const realCreate = URL.createObjectURL.bind(URL);
URL.createObjectURL = function (blob) {
  window.__pending = { size: blob.size, type: blob.type };
  return realCreate(blob);
};
const realClick = HTMLAnchorElement.prototype.click;
HTMLAnchorElement.prototype.click = function () {
  if (this.download && window.__pending) {
    window.__files.push({ name: this.download, size: window.__pending.size, type: window.__pending.type });
    window.__pending = null;
    return;                     // …and go no further: a real click would ask to save it
  }
  return realClick.apply(this, arguments);
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

post("/ping", "up");
setTimeout(function () { say("watchdog", "fired"); done(); }, 120000);
window.addEventListener("error", function (e) { post("/ping", "page error: " + (e && e.message)); });
window.addEventListener("unhandledrejection", function (e) {
  post("/ping", "unhandled rejection: " + ((e.reason && e.reason.message) || e.reason));
});

async function press(id) {
  var before = window.__files.length;
  document.getElementById(id).click();
  await until("the " + id + " file", function () { return window.__files.length > before; }, 60000)
    .catch(function () {});
  return window.__files[window.__files.length - 1] || null;
}

(async function () {
  try {
    await until("the page", function () { return document.getElementById("paste"); });
    var lines = [];
    for (var i = 0; i < ${TOTAL}; i++) lines.push((100000 + i) + "," + (900000 + i));
    document.getElementById("paste").value = lines.join("\\n");
    document.getElementById("pasteBtn").click();
    await until("Start", function () { return !document.getElementById("run").disabled; });

    /* the buttons are dead until there is something to export */
    say("before", ["html", "xlsx", "raw"].map(function (i) {
      return i + ":" + (document.getElementById(i).disabled ? "off" : "on"); }).join(" "));

    document.getElementById("run").click();
    await until("the run", function () {
      return document.getElementById("stop").disabled && /\\u2705/.test(prog()); }, 90000);
    say("prog", prog());
    say("after", ["html", "xlsx", "raw"].map(function (i) {
      return i + ":" + (document.getElementById(i).disabled ? "off" : "on"); }).join(" "));
    say("tiles", ["t-ok","t-no","t-cw","t-zero","t-nf","t-stu"].map(function(i){return i+":"+document.getElementById(i).textContent}).join(" "));
    say("mismatch_tile", document.getElementById("t-no").textContent);

    /* ---- all of it ---- */
    var h = await press("html"), x = await press("xlsx"), r = await press("raw");
    say("html", h ? h.name + " | " + h.size + " | " + h.type : "nothing");
    say("xlsx", x ? x.name + " | " + x.size + " | " + x.type : "nothing");
    say("raw", r ? r.name + " | " + r.size + " | " + r.type : "nothing");

    /* ---- and again with a filter on, which the buttons are supposed to honour ---- */
    async function pick(f) {
      document.querySelector('.fb[data-f="' + f + '"]').click();
      await until("the " + f + " filter", function () {
        return document.querySelector('.fb[data-f="' + f + '"]').classList.contains("active"); }, 10000);
      say("shown_" + f, document.querySelectorAll("#list .stu:not(.hide)").length);
    }
    /* a bucket the run filled: the export is the whole of it */
    await pick("no");
    var h2 = await press("html"), x2 = await press("xlsx");
    say("html_no", h2 ? h2.name + " | " + h2.size : "nothing");
    say("xlsx_no", x2 ? x2.name + " | " + x2.size : "nothing");
    /* a bucket the run left empty: there is nothing to export, and nothing must come out */
    await pick("ok");
    var n0 = window.__files.length;
    document.getElementById("html").click();
    document.getElementById("xlsx").click();
    document.getElementById("raw").click();
    await new Promise(function (r) { setTimeout(r, 1200); });
    say("empty_filter_files", window.__files.length - n0);
  } catch (e) { say("error", (e && e.message) || e); }
  done();
})();
<\/script>`;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "umsxb-"));
const s = APP.replace('<script src="reconcile.js"></script>', STUBS + '<script src="reconcile.js"></script>');
const at = s.lastIndexOf("</body>");
fs.writeFileSync(path.join(TMP, "a.html"), s.slice(0, at) + DRIVE + s.slice(at));
fs.mkdirSync(path.join(TMP, "menus", "adm"), { recursive: true }); fs.mkdirSync(path.join(TMP, "menus", "crm"), { recursive: true });
fs.mkdirSync(path.join(TMP, "lib"), { recursive: true });   // the xlsx/zip engine app.html now loads before the menus
["reconcile.js", "lib/xlsx.js", "lib/import.js", "lib/update.js", "app.js", "menus/adm/adm.js", "menus/crm/crm.js"].forEach((f) => fs.copyFileSync(path.join(ROOT, f), path.join(TMP, f)));

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

const part = (v, i) => String(v || "").split(" | ")[i] || "";

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
    if (o.error) {
      console.log("FAIL  " + o.error);
      if (pings.length) console.log("      the page also said: " + pings.join(" ; "));
      srv.close(); process.exit(1);
    }

    console.log("\n--- before there is anything to export ---");
    check("all three buttons are off until a run has produced something",
      o.before === "html:off xlsx:off raw:off", o.before);

    console.log("\n--- a finished run ---");
    check("the run finished", /✅/.test(o.prog || ""), o.prog);
    check("…and produced rows to export", +o.mismatch_tile > 0, o.tiles);
    check("all three buttons come on", o.after === "html:on xlsx:on raw:on", o.after);

    console.log("\n--- and pressed ---");
    [["html", "html", "text/html"], ["xlsx", "xlsx", "spreadsheet"], ["raw", "txt", "text/plain"]]
      .forEach(function (f) {
        const v = o[f[0]];
        check("⬇ " + f[0] + " hands over a file", v !== "nothing" && !!v, String(v));
        check("…named for what it is", new RegExp("^ums-verify-.*\\." + f[1] + "$").test(part(v, 0)), part(v, 0));
        check("…with bytes in it", +part(v, 1) > 200, part(v, 1) + " bytes");
        check("…of the right kind", part(v, 2).indexOf(f[2]) >= 0, part(v, 2));
      });

    console.log("\n--- with a filter on, which the buttons honour ---");

    /* The filter reaches the export or it does not, and the way to see it without depending on
       what the fixture happens to produce is to filter to a bucket the run left EMPTY. Then the
       only right answer is no file at all — flatRows() comes back empty and the button returns
       before it builds anything. A button that hands over the whole run there is a button
       ignoring the chip above it, and the filename would still have said "matched". */
    check("a bucket the run filled exports what is in it",
      +part(o.html_no, 1) > 200 && +part(o.xlsx_no, 1) > 200,
      part(o.html_no, 1) + " / " + part(o.xlsx_no, 1) + " bytes, " + o.shown_no + " on screen");
    check("…and the filename says which filter it was",
      /mismatch/.test(part(o.html_no, 0)), part(o.html_no, 0));
    check("the run left the other bucket empty", o.shown_ok === "0", o.shown_ok + " on screen");
    check("…so all three buttons hand over nothing at all",
      o.empty_filter_files === "0", o.empty_filter_files + " file(s)");

    if (pings.filter((p) => p !== "up").length) {
      console.log("\nFAIL  the page reported an error: " + pings.filter((p) => p !== "up").join(" ; "));
      fail++;
    }

    console.log(fail ? "\n" + fail + " FAILED" : "\nall good");
    srv.close();
    setTimeout(() => process.exit(fail ? 1 : 0), 400);
  };
});
