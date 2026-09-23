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
  const APP = fs.readFileSync(path.join(ROOT, "menus", "crm", "crm.js"), "utf8");   // crmIsHeader/crmParse moved out of app.js
  function lift(name) {
    const at = APP.indexOf("function " + name + "(");
    let d = 0;
    for (let j = APP.indexOf("{", at); j < APP.length; j++) {
      if (APP[j] === "{") d++;
      else if (APP[j] === "}") { d--; if (!d) return APP.slice(at, j + 1); }
    }
    return "";
  }
  /* crmParse leans on crmIsHeader, so both come across */
  const crmParse = new Function(lift("crmIsHeader") + "\n" + lift("crmParse") + "\nreturn crmParse;")();

  const lt = require(path.join(ROOT, "..", "crm-loadtest", "loadtest.js"));
  const tmp = path.join(os.tmpdir(), "crm-parse-" + Date.now() + ".txt");

  const sample = [
    "UserName,Password",          // Excel's column-name row, in real capitalisation — dropped by both
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
  check("…the Excel column-name row is dropped, not taken as a login",
    mine[0] && mine[0].user === "alice", JSON.stringify(mine[0]));
  check("…even 'User Name' / 'Pwd' style headers are recognised",
    crmParse("User Name,Pwd\nalice,pw-a").length === 1, JSON.stringify(crmParse("User Name,Pwd\nalice,pw-a")));
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
    out.countDefault = count.value;                     // "how many at once" starts at 1

    users.value = "username,password\\nalice,pw-a\\n# note\\n\\nbob,pw-b\\ncarol a long pass";
    fire(users, "input");
    base.value = "https://ums-41.osl.team"; fire(base, "input");
    count.value = "40"; fire(count, "input");

    out.badge = document.getElementById("crmPairs").textContent;
    out.dlDisabledFull = document.getElementById("crmDl").disabled;
    out.cmd = document.getElementById("crmCmd").textContent;

    headed.checked = true; fire(headed, "change");
    out.cmdHeaded = document.getElementById("crmCmd").textContent;

    /* close-after-visit: off by default (browser stays open → --keep-open); ticking it drops the flag */
    var close = document.getElementById("crmClose");
    out.cmdKeepOpen = out.cmdHeaded;
    close.checked = true; fire(close, "change");
    out.cmdClosed = document.getElementById("crmCmd").textContent;
    close.checked = false; fire(close, "change");

    /* maximize: adds --maximize (only sits between --headed and --keep-open) */
    var mx = document.getElementById("crmMax");
    mx.checked = true; fire(mx, "change");
    out.cmdMax = document.getElementById("crmCmd").textContent;
    mx.checked = false; fire(mx, "change");

    /* the mode control: sequential is --count 1 and hides the count; back to parallel restores it */
    document.getElementById("crmSeq").click();
    out.cmdSeq = document.getElementById("crmCmd").textContent;
    out.seqOn = document.getElementById("crmSeq").classList.contains("on");
    out.countHidden = getComputedStyle(document.getElementById("crmCountWrap")).display;
    document.getElementById("crmPar").click();
    out.cmdPar = document.getElementById("crmCmd").textContent;
    out.countShown = getComputedStyle(document.getElementById("crmCountWrap")).display;

    document.getElementById("crmDl").click();
    setTimeout(function () {
      out.dl = window.__dl[0] || null;
      document.getElementById("crmCopy").click();
      setTimeout(function () {
        out.copied = window.__copied;
        document.getElementById("crmClear").click();          // ✕ Clear empties the user box
        out.afterClearUsers = document.getElementById("crmUsers").value;
        out.afterClearBadge = document.getElementById("crmPairs").textContent;
        out.afterClearDl = document.getElementById("crmDl").disabled;
        post(JSON.stringify(out));
      }, 60);
    }, 120);
  }, 250);
});
<\/script></body></html>`;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "crmui-"));
{
  const s = APP.replace('<script src="reconcile.js"></script>', STUBS + '<script src="reconcile.js"></script>');
  const at = s.lastIndexOf("</body>");
  fs.writeFileSync(path.join(TMP, "a.html"), s.slice(0, at) + DRIVE);
  fs.mkdirSync(path.join(TMP, "menus", "adm"), { recursive: true }); fs.mkdirSync(path.join(TMP, "menus", "crm"), { recursive: true });
  fs.mkdirSync(path.join(TMP, "lib"), { recursive: true });   // the xlsx/zip engine app.html now loads before the menus
  ["reconcile.js", "lib/xlsx.js", "lib/import.js", "app.js", "menus/adm/adm.js", "menus/crm/crm.js"].forEach((f) => fs.copyFileSync(path.join(ROOT, f), path.join(TMP, f)));
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
      check("…and “how many at once” defaults to 1", o.countDefault === "1", o.countDefault);

      console.log("");
      check("the badge counts the real users, skipping header/blank/comment", /\b3\b/.test(o.badge), o.badge);
      check("…and download turns on", o.dlDisabledFull === false, String(o.dlDisabledFull));
      check("the command carries the base, users.txt and the count",
        o.cmd === "node loadtest.js --base https://ums-41.osl.team --users users.txt --count 40 --keep-open", o.cmd);
      check("…the count is a plain number, not localized into another script", /--count 40\b/.test(o.cmd), o.cmd);
      check("the headed toggle reaches the command", / --headed --keep-open$/.test(o.cmdHeaded), o.cmdHeaded);

      console.log("");
      check("with close-after-visit off the browser is kept open (--keep-open)", / --keep-open$/.test(o.cmdKeepOpen), o.cmdKeepOpen);
      check("…and ticking it drops --keep-open", !/--keep-open/.test(o.cmdClosed), o.cmdClosed);
      check("Maximize adds --maximize, between headed and keep-open", / --headed --maximize --keep-open$/.test(o.cmdMax), o.cmdMax);

      console.log("");
      check("parallel is the default, and it carries the typed count", /--count 40/.test(o.cmd), o.cmd);
      check("Sequential switches the command to --count 1", /--count 1\b/.test(o.cmdSeq) && !/--count 40/.test(o.cmdSeq), o.cmdSeq);
      check("…and marks itself the chosen one", o.seqOn === true, String(o.seqOn));
      check("…and hides the count, which means nothing one at a time", o.countHidden === "none", o.countHidden);
      check("back to Parallel restores the count in the command", /--count 40/.test(o.cmdPar), o.cmdPar);
      check("…and the count field returns", o.countShown !== "none", o.countShown);

      console.log("");
      check("⬇ users.txt hands over a file named users.txt", o.dl && o.dl.name === "users.txt", o.dl && o.dl.name);
      check("…holding exactly the clean two-column lines",
        o.dl && o.dl.text === "alice,pw-a\nbob,pw-b\ncarol,a long pass\n", o.dl && JSON.stringify(o.dl.text));
      check("Copy puts the command on the clipboard", o.copied === o.cmdHeaded, o.copied);

      console.log("");
      check("✕ Clear empties the user box", o.afterClearUsers === "", JSON.stringify(o.afterClearUsers));
      check("…the badge falls back to none", /0|০/.test(o.afterClearBadge) && !/\b3\b/.test(o.afterClearBadge), o.afterClearBadge);
      check("…and users.txt is disabled again", o.afterClearDl === true, String(o.afterClearDl));
    }
    console.log(fail ? "\n" + fail + " FAILED" : "\nall good");
    srv.close();
    setTimeout(() => process.exit(fail ? 1 : 0), 200);
  };
});
