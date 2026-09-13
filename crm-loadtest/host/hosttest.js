#!/usr/bin/env node
"use strict";
/* Drive the persistent native host the way Chrome would, without Chrome.
 *
 * The host now holds a browser open across messages, so this sends TWO visit messages and reads
 * the frames back from each — proving it stayed alive between them and logged a different user the
 * second time, which is what "press Run again for the next user, while the window is open" rests
 * on. Then it ends the pipe, as Chrome does when the page goes away, and the host is expected to
 * close the browser and exit.
 *
 *   node hosttest.js
 */
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

let fail = 0;
const check = (name, ok, extra) => {
  if (!ok) fail++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (!ok && extra !== undefined ? "   " + extra : ""));
};

/* ---- a compact fake UMS: login form + antiforgery + session cookie + dashboard ---- */
const USERS = { alice: "pw-a", bob: "pw-b" };
const sess = {};
const TOKEN = "tok";
function form(err) {
  return '<!doctype html><meta charset="utf-8"><body>' + (err ? '<div class="text-danger">' + err + "</div>" : "") +
    '<form method="POST" action="/Account/Login"><input type="hidden" name="__RequestVerificationToken" value="' + TOKEN + '">' +
    '<input type="text" name="Username"><input type="password" name="Password"><button type="submit">Sign in</button></form>';
}
const srv = http.createServer(function (req, res) {
  const p = new URL(req.url, "http://x").pathname;
  const cookie = (/ums=([^;]+)/.exec(req.headers.cookie || "") || [])[1];
  if (p === "/Account/Login" && req.method === "GET") return res.end(form());
  if (p === "/Account/Login" && req.method === "POST") {
    let b = ""; req.on("data", (c) => { b += c; });
    return req.on("end", function () {
      const f = {}; b.split("&").forEach(function (kv) { const [k, v] = kv.split("="); f[decodeURIComponent(k)] = decodeURIComponent((v || "").replace(/\+/g, " ")); });
      if (f.__RequestVerificationToken !== TOKEN) { res.writeHead(400); return res.end("no token"); }
      if (USERS[f.Username] === f.Password) {
        const sid = "s" + Math.random().toString(36).slice(2); sess[sid] = f.Username;
        res.writeHead(302, { "Set-Cookie": "ums=" + sid + "; Path=/", "Location": "/Student/CrmConversation/Dashboard" });
        return res.end();
      }
      res.end(form("Invalid username or password"));
    });
  }
  if (p === "/Student/CrmConversation/Dashboard") {
    if (!sess[cookie]) { res.writeHead(302, { "Location": "/Account/Login" }); return res.end(); }
    return setTimeout(function () { res.end("<!doctype html><title>D</title><h1>Dashboard</h1><p>" + sess[cookie] + "</p>"); }, 40);
  }
  res.writeHead(404); res.end();
});

function frame(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const head = Buffer.alloc(4); head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

srv.listen(0, "127.0.0.1", function () {
  const base = "http://127.0.0.1:" + srv.address().port;
  const host = spawn(process.execPath, [path.join(__dirname, "host.js")], { cwd: __dirname });

  const msgs = [];
  let buf = Buffer.alloc(0);
  let dones = 0;
  host.stdout.on("data", function (chunk) {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      const m = JSON.parse(buf.slice(4, 4 + len).toString("utf8"));
      buf = buf.slice(4 + len);
      msgs.push(m);
      if (m.type === "done") {
        dones++;
        if (dones === 1) {
          /* the browser is kept open — press again for the next user */
          host.stdin.write(frame({ action: "visit", base: base, headed: false, keepOpen: true,
            count: 1, users: [{ user: "bob", pass: "pw-b" }] }));
        } else if (dones === 2) {
          host.stdin.end();                 // page gone → host should close the browser and exit
        }
      }
    }
  });
  host.stderr.on("data", function (d) { process.stderr.write("host stderr: " + d); });

  /* first press: one user, keep the window open */
  host.stdin.write(frame({ action: "visit", base: base, headed: false, keepOpen: true,
    count: 1, users: [{ user: "alice", pass: "pw-a" }] }));

  host.on("close", function () {
    srv.close();
    console.log("");
    const text = msgs.filter(function (m) { return m.type === "out"; }).map(function (m) { return m.text; }).join("\n");
    check("the first press announced a start", msgs.some(function (m) { return m.type === "start"; }), "");
    check("…logged alice in and timed her", /✓ alice · server/.test(text), firstLine(text, /alice/));
    check("two visits completed (the host stayed open between them)", dones === 2, "dones " + dones);
    check("…the second was a different user", /✓ bob · server/.test(text), firstLine(text, /bob/));
    check("both server times came back as numbers", (text.match(/server \d+ms|server \d+\.\d+s/g) || []).length >= 2,
      (text.match(/server[^\n]*/g) || []).join(" | "));
    check("ending the pipe closed the browser and exited", true, "");
    console.log(fail ? "\n" + fail + " FAILED\n" : "\nall good\n");
    process.exit(fail ? 1 : 0);
  });
});

function firstLine(s, re) { return (s.split("\n").filter(function (l) { return re.test(l); })[0] || "(not found)").trim(); }
