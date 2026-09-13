/* The CRM · Dashboard load-test configurator.
 *
 * The extension cannot run the load test — one browser is one session — so this card's whole job
 * is to prepare the run: count the users, build the exact command, and hand over a users.txt. The
 * things that would quietly be wrong: a count that does not match what the tool will actually read
 * (a header line, a blank, a password with a space), a command that does not reflect the fields, a
 * users.txt that is not the clean two-column file the tool expects, and the headed toggle not
 * reaching the command.
 *
 * The parser is checked against the real one it is meant to mirror — crm-loadtest/loadtest.js
 * readUsers — so the number on the badge is the number of logins that will happen.
 *
 *   node tests/crm-ui.js
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

/* ---------- the parser agrees with the tool's own ---------- */
{
  const APP = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
  const at = APP.indexOf("function crmParse(");
  let d = 0, body = "";
  for (let j = APP.indexOf("{", at); j < APP.length; j++) {
    if (APP[j] === "{") d++;
    else if (APP[j] === "}") { d--; if (!d) { body = APP.slice(at, j + 1); break; } }
  }
  const crmParse = new Function(body + "\nreturn crmParse;")();

  const lt = require(path.join(ROOT, "..", "crm-loadtest", "loadtest.js"));
  const tmp = path.join(os.tmpdir(), "crm-parse-" + Date.now() + ".txt");

  const sample = [
    "username,password",          // header, skipped by both
    "# a comment",                // skipped
    "",                           // blank
    "alice,pw-a",                 // comma
    "bob\tpw-b",                  // tab
    "carol a long pass phrase",   // last-space split
    "dave",                       // no password
    "  erin , spaced  "           // trimmed
  ].join("\n");
  fs.writeFileSync(tmp, sample);

  const mine = crmParse(sample);
  const theirs = lt.readUsers(tmp).map(function (u) { return { user: u.user, pass: u.pass }; });
  fs.unlinkSync(tmp);

  check("the badge parser and the tool's parser agree on the count",
    mine.length === theirs.length && mine.length === 5,
    "ui " + mine.length + " vs tool " + theirs.length);
  check("…and on every pair",
    JSON.stringify(mine) === JSON.stringify(theirs),
    JSON.stringify(mine) + "  vs  " + JSON.stringify(theirs));
  check("…the last-space split keeps a spaced password whole",
    mine[2] && mine[2].user === "carol" && mine[2].pass === "a long pass phrase",   // first-space split
    JSON.stringify(mine[2]));
}

const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium"].filter((p) => fs.existsSync(p))[0];
if (!CHROME) {
  console.log("SKIP  Chrome not found — the form itself needs a page");
  console.log(fail ? "\n" + fail + " FAILED" : "\nall good");
  process.exit(fail ? 1 : 0);
}

/* ---------- and the card, driven in a page ---------- */
const APP = fs.readFileSync(path.join(ROOT, "app.html"), "utf8");
const STUBS = `<script>
window.chrome = { runtime: { id: "t", getManifest: function () { return { version: "0" }; } },
  storage: { local: {
    get: function (k, cb) { cb({ theme: "dark", lang: "en", baseUrl: "https://ums-5.osl.team" }); },
    set: function () {}, remove: function () {} }, onChanged: { addListener: function () {} } } };
window.fetch = function () { return new Promise(function () {}); };
window.__copied = "";
try { Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
  writeText: function (t) { window.__copied = t; return Promise.resolve(); } } }); } catch (e) {}
/* catch the users.txt as it is handed over */
window.__dl = [];
var realCreate = URL.createObjectURL.bind(URL);
URL.createObjectURL = function (b) { window.__pendingBlob = b; return realCreate(b); };
var realText = Blob.prototype.text;
var realClick = HTMLAnchorElement.prototype.click;
HTMLAnchorElement.prototype.click = function () {
  if (this.download && window.__pendingBlob) {
    var b = window.__pendingBlob; window.__pendingBlob = null;
    var self = this;
    realText.call(b).then(function (txt) { window.__dl.push({ name: self.download, text: txt }); });
    return;
  }
  return realClick.apply(this, arguments);
};
</script>`;

const DRIVE = `<script>
var out = {};
function post(b) { try { var x = new XMLHttpRequest(); x.open("POST", "/done", true); x.send(b); } catch (e) {} }
function fire(el, ev) { el.dispatchEvent(new Event(ev, { bubbles: true })); }
addEventListener("load", function () {
  setTimeout(function () {
    document.getElementById("navCrm").click();
    var users = document.getElementById("crmUsers");
    var base = document.getElementById("crmBase");
    var count = document.getElementById("crmCount");
    var headed = document.getElementById("crmHeaded");

    out.basePrefill = base.value;                       // showCrm should have filled it from payment
    out.cmdEmpty = document.getElementById("crmCmd").textContent;
    out.dlDisabledEmpty = document.getElementById("crmDl").disabled;

    users.value = "username,password\\nalice,pw-a\\n# note\\n\\nbob,pw-b\\ncarol a long pass";
    fire(users, "input");
    base.value = "https://ums-41.osl.team"; fire(base, "input");
    count.value = "40"; fire(count, "input");

    out.badge = document.getElementById("crmPairs").textContent;
    out.dlDisabledFull = document.getElementById("crmDl").disabled;
    out.cmd = document.getElementById("crmCmd").textContent;

    headed.checked = true; fire(headed, "change");
    out.cmdHeaded = document.getElementById("crmCmd").textContent;

    document.getElementById("crmDl").click();
    setTimeout(function () {
      out.dl = window.__dl[0] || null;
      document.getElementById("crmCopy").click();
      setTimeout(function () { out.copied = window.__copied; post(JSON.stringify(out)); }, 60);
    }, 120);
  }, 250);
});
<\/script></body></html>`;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "crmui-"));
{
  const s = APP.replace('<script src="reconcile.js"></script>', STUBS + '<script src="reconcile.js"></script>');
  const at = s.lastIndexOf("</body>");
  fs.writeFileSync(path.join(TMP, "a.html"), s.slice(0, at) + DRIVE);
  ["reconcile.js", "app.js"].forEach((f) => fs.copyFileSync(path.join(ROOT, f), path.join(TMP, f)));
}
let waiting = null;
const srv = http.createServer((q, r) => {
  if (q.method === "POST") {
    let b = ""; q.on("data", (c) => { b += c; });
    q.on("end", () => { r.writeHead(204); r.end(); const w = waiting; waiting = null; if (w) w(b); });
    return;
  }
  const f = path.join(TMP, q.url.replace(/^\/+/, "").split("?")[0] || "a.html");
  fs.readFile(f, (e, b) => {
    if (e) { r.writeHead(404); r.end(); return; }
    r.writeHead(200, { "Content-Type": /\.js$/.test(f) ? "text/javascript" : "text/html; charset=utf-8" });
    r.end(b);
  });
});
srv.listen(0, "127.0.0.1", () => {
  const ch = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
    "--user-data-dir=" + path.join(TMP, "prof"),
    "http://127.0.0.1:" + srv.address().port + "/a.html"], { stdio: "ignore" });
  const timer = setTimeout(() => { const w = waiting; waiting = null; if (w) w(null); }, 60000);
  waiting = (body) => {
    clearTimeout(timer);
    try { ch.kill(); } catch (e) {}
    if (!body) { check("the page reported back", false, "nothing in 60s"); }
    else {
      const o = JSON.parse(body);
      console.log("");
      check("the base is prefilled from the Payment History side", o.basePrefill === "https://ums-5.osl.team", o.basePrefill);
      check("…the command shows its shape before anything is typed", /node loadtest\.js/.test(o.cmdEmpty), o.cmdEmpty);
      check("…and users.txt cannot be downloaded while empty", o.dlDisabledEmpty === true, String(o.dlDisabledEmpty));

      console.log("");
      check("the badge counts the real users, skipping header/blank/comment", /\b3\b/.test(o.badge), o.badge);
      check("…and download turns on", o.dlDisabledFull === false, String(o.dlDisabledFull));
      check("the command carries the base, users.txt and the count",
        o.cmd === "node loadtest.js --base https://ums-41.osl.team --users users.txt --count 40", o.cmd);
      check("…the count is a plain number, not localized into another script", /--count 40\b/.test(o.cmd), o.cmd);
      check("the headed toggle reaches the command", / --headed$/.test(o.cmdHeaded), o.cmdHeaded);

      console.log("");
      check("⬇ users.txt hands over a file named users.txt", o.dl && o.dl.name === "users.txt", o.dl && o.dl.name);
      check("…holding exactly the clean two-column lines",
        o.dl && o.dl.text === "alice,pw-a\nbob,pw-b\ncarol,a long pass\n", o.dl && JSON.stringify(o.dl.text));
      check("Copy puts the command on the clipboard", o.copied === o.cmdHeaded, o.copied);
    }
    console.log(fail ? "\n" + fail + " FAILED" : "\nall good");
    srv.close();
    setTimeout(() => process.exit(fail ? 1 : 0), 200);
  };
});
