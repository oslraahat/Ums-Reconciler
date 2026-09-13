#!/usr/bin/env node
"use strict";
/* Drive the native-messaging host the way Chrome would, without Chrome.
 *
 * Chrome spawns host.js and speaks the length-prefixed frame protocol to its stdio. This does the
 * same: it stands up a fake UMS, spawns host.js, writes one framed config message, and reads the
 * frames that come back — asserting the host started the run, forwarded loadtest.js's output, and
 * finished cleanly. It proves everything up to the extension's own connectNative call, which only
 * a loaded extension can make.
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

/* ---- a compact fake UMS: login form with an antiforgery token, a session cookie, a dashboard ---- */
const USERS = { alice: "pw-a", bob: "pw-b", carol: "pw-c" };
const sess = {};
const TOKEN = "tok";
function form(err) {
  return '<!doctype html><meta charset="utf-8"><body>' + (err ? '<div class="text-danger">' + err + "</div>" : "") +
    '<form method="POST" action="/Account/Login">' +
    '<input type="hidden" name="__RequestVerificationToken" value="' + TOKEN + '">' +
    '<input type="text" name="Username"><input type="password" name="Password">' +
    '<button type="submit">Sign in</button></form>';
}
const srv = http.createServer(function (req, res) {
  const u = new URL(req.url, "http://x"), p = u.pathname;
  const cookie = (/ums=([^;]+)/.exec(req.headers.cookie || "") || [])[1];
  if (p === "/Account/Login" && req.method === "GET") { res.end(form()); return; }
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
    return setTimeout(function () { res.end("<!doctype html><title>D</title><h1>Dashboard</h1><p>" + sess[cookie] + "</p>"); }, 60);
  }
  res.writeHead(404); res.end();
});

/* ---- frame helpers ---- */
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
  host.stdout.on("data", function (chunk) {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      msgs.push(JSON.parse(buf.slice(4, 4 + len).toString("utf8")));
      buf = buf.slice(4 + len);
    }
  });
  host.stderr.on("data", function (d) { process.stderr.write("host stderr: " + d); });

  /* one config message, then close our writer so the host is not left waiting */
  host.stdin.write(frame({
    base: base, count: 3, headed: false, noWarmup: false,
    users: [{ user: "alice", pass: "pw-a" }, { user: "bob", pass: "pw-b" },
      { user: "carol", pass: "WRONG" }]
  }));

  host.on("close", function () {
    srv.close();
    console.log("");
    const types = msgs.map(function (m) { return m.type; });
    const text = msgs.filter(function (m) { return m.type === "out"; }).map(function (m) { return m.text; }).join("\n");

    check("the host announced the start", types[0] === "start", types.slice(0, 3).join(","));
    check("…with the user count it was handed", msgs[0] && msgs[0].count === 3, msgs[0] && msgs[0].count);
    check("it forwarded loadtest's output", types.indexOf("out") >= 0, types.join(","));
    check("…including the login result", /logged in/.test(text), firstLine(text, /logged in/));
    check("…and the Dashboard timing", /Dashboard load/.test(text), firstLine(text, /Dashboard load/));
    check("two logged in, the wrong password did not", /2 of 3 logged in/.test(text), firstLine(text, /of 3 logged in/));
    const done = msgs[msgs.length - 1];
    check("it finished with a done frame, exit 0", done && done.type === "done" && done.code === 0,
      JSON.stringify(done));

    console.log(fail ? "\n" + fail + " FAILED\n" : "\nall good\n");
    process.exit(fail ? 1 : 0);
  });
});

function firstLine(s, re) { return (s.split("\n").filter(function (l) { return re.test(l); })[0] || "(not found)").trim(); }
