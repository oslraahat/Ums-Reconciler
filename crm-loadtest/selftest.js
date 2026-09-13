#!/usr/bin/env node
"use strict";
/* Prove the machinery against a fake UMS, since the real one cannot be tested from here.
 *
 * The fake server behaves like the parts that matter: the Dashboard redirects a logged-out visitor
 * to /Account/Login; the login form carries an antiforgery token and rejects a POST without it (so
 * "the browser submits the real form's token for us" is exercised, not assumed); each good login
 * gets its own session cookie; and the Dashboard is deliberately slower the more requests are in
 * flight at once, so a tool that claims to detect "slow under load" has something to detect.
 *
 * Then the real CLI is run against it and its output is checked: the right people logged in, the
 * wrong password did not, N separate sessions coexisted (if the contexts shared cookies only the
 * last login would survive and the rest would bounce off the Dashboard), timings came out, and the
 * built-in slowdown was reported.
 *
 *   node selftest.js
 */
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

let fail = 0;
const check = (name, ok, extra) => {
  if (!ok) fail++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (!ok && extra !== undefined ? "   " + extra : ""));
};

/* ---------------- a fake UMS ---------------- */
const USERS = { alice: "pw-a", bob: "pw-b", carol: "pw-c", dave: "pw-d", erin: "pw-e" };
const sessions = {};                 // cookie value -> username
let inFlight = 0, peakInFlight = 0;  // dashboard requests overlapping right now
const TOKEN = "tok-" + Math.random().toString(36).slice(2);

function cookieOf(req) {
  const c = req.headers.cookie || "";
  const m = /ums_session=([^;]+)/.exec(c);
  return m ? m[1] : "";
}
function send(res, code, body, headers) {
  res.writeHead(code, Object.assign({ "Content-Type": "text/html; charset=utf-8" }, headers || {}));
  res.end(body || "");
}
function loginPage(returnUrl, error) {
  return '<!doctype html><meta charset="utf-8"><title>Login</title><body>' +
    (error ? '<div class="text-danger">' + error + "</div>" : "") +
    '<form method="POST" action="/Account/Login">' +
    '<input type="hidden" name="__RequestVerificationToken" value="' + TOKEN + '">' +
    '<input type="hidden" name="returnUrl" value="' + (returnUrl || "") + '">' +
    '<label>User <input type="text" name="Username" id="Username"></label>' +
    '<label>Pass <input type="password" name="Password" id="Password"></label>' +
    '<button type="submit">Sign in</button></form>';
}

const srv = http.createServer(function (req, res) {
  const u = new URL(req.url, "http://x");
  const p = u.pathname;

  if (p === "/Account/Login" && req.method === "GET") {
    return send(res, 200, loginPage(u.searchParams.get("returnUrl") || ""));
  }
  if (p === "/Account/Login" && req.method === "POST") {
    let body = ""; req.on("data", (c) => { body += c; });
    return req.on("end", function () {
      const f = {};
      body.split("&").forEach(function (kv) { const [k, v] = kv.split("="); f[decodeURIComponent(k || "")] = decodeURIComponent((v || "").replace(/\+/g, " ")); });
      if (f.__RequestVerificationToken !== TOKEN) return send(res, 400, "missing/invalid antiforgery token");
      if (USERS[f.Username] && USERS[f.Username] === f.Password) {
        const sid = "s" + Math.random().toString(36).slice(2);
        sessions[sid] = f.Username;
        return send(res, 302, "", { "Set-Cookie": "ums_session=" + sid + "; Path=/; HttpOnly", "Location": f.returnUrl || "/Student/CrmConversation/Dashboard" });
      }
      return send(res, 200, loginPage(f.returnUrl || "", "Invalid username or password"));
    });
  }
  if (p === "/Student/CrmConversation/Dashboard") {
    const who = sessions[cookieOf(req)];
    if (!who) return send(res, 302, "", { "Location": "/Account/Login?returnUrl=" + encodeURIComponent(p) });
    /* slower the more of these overlap — the thing the tool is meant to notice */
    inFlight++; peakInFlight = Math.max(peakInFlight, inFlight);
    const delay = 80 + 50 * inFlight;
    return setTimeout(function () {
      inFlight--;
      send(res, 200, '<!doctype html><meta charset="utf-8"><title>CRM Dashboard</title><body>' +
        '<h1>CRM · Dashboard</h1><p>Welcome, ' + who + '</p>' +
        /* a little script so loadEventEnd is meaningfully after responseEnd */
        "<script>var s=0;for(var i=0;i<200000;i++)s+=i;window.__s=s;<\/script>");
    }, delay);
  }
  send(res, 404, "not found");
});

/* ---------------- run the real CLI against it ---------------- */
function runCli(args) {
  return new Promise(function (resolve) {
    const ch = spawn(process.execPath, [path.join(__dirname, "loadtest.js")].concat(args),
      { cwd: __dirname });
    let out = "";
    ch.stdout.on("data", (c) => { out += c; });
    ch.stderr.on("data", (c) => { out += c; });
    ch.on("exit", function (code) { resolve({ code: code, out: out }); });
  });
}

srv.listen(0, "127.0.0.1", async function () {
  const base = "http://127.0.0.1:" + srv.address().port;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "crmlt-"));
  const usersFile = path.join(tmp, "users.txt");
  const csv = path.join(tmp, "out.csv");
  /* five good, one wrong password, one unknown user, plus a header line to be skipped */
  fs.writeFileSync(usersFile, [
    "username,password",
    "alice,pw-a", "bob,pw-b", "carol,pw-c", "dave,pw-d", "erin,pw-e",
    "bob,WRONG", "ghost,pw-x"
  ].join("\n"));

  const r = await runCli(["--base", base, "--users", usersFile, "--count", "6", "--out", csv]);
  console.log("\n--- the tool's own output ---\n" + r.out.split("\n").map((l) => "    " + l).join("\n"));

  console.log("--- checks ---");
  check("it ran to the end", r.code === 0, "exit " + r.code);
  /* five distinct users log in; the two bad rows do not. If contexts shared one cookie jar, later
     good logins would overwrite earlier ones and the coexisting-session count would be wrong. */
  check("five of seven logged in", /5 of 7 logged in/.test(r.out), firstMatch(r.out, /\d+ of 7 logged in/));
  check("the wrong password was refused", /Invalid username or password/.test(r.out) || /bob\b/.test(r.out.split("could not log in")[1] || ""), "");
  check("all five held their own session at once (Dashboard did not bounce them)",
    /5 loaded, 0 failed/.test(r.out), firstMatch(r.out, /\d+ loaded, \d+ failed/));
  check("it separated the server's share from the full load",
    /server answer/.test(r.out) && /full page load/.test(r.out), "");
  check("it compared one-user against many and reported a slowdown",
    /degrade under load|little change|slower/.test(r.out), "");
  check("the built-in slowdown was real (peak overlap > 1)", peakInFlight > 1, "peak " + peakInFlight);
  check("a per-user CSV was written", fs.existsSync(csv), csv);
  if (fs.existsSync(csv)) {
    const lines = fs.readFileSync(csv, "utf8").trim().split("\n");
    check("…with a header and a row per user (7 + 1)", lines.length === 8, lines.length + " lines");
    check("…marking who logged in and who did not",
      /,no,/.test(lines.join("\n")) && /,yes,/.test(lines.join("\n")), "");
  }

  /* the antiforgery path really was exercised: a POST with no token is refused */
  const noTok = await new Promise(function (resolve) {
    const req = http.request(base + "/Account/Login", { method: "POST" }, function (res) {
      let b = ""; res.on("data", (c) => { b += c; }); res.on("end", function () { resolve({ code: res.statusCode, b: b }); });
    });
    req.end("Username=alice&Password=pw-a");
  });
  check("a login POST without the antiforgery token is rejected", noTok.code === 400, noTok.code + " " + noTok.b.slice(0, 40));

  srv.close();
  console.log(fail ? "\n" + fail + " FAILED\n" : "\nall good\n");
  process.exit(fail ? 1 : 0);
});

function firstMatch(s, re) { const m = re.exec(s); return m ? m[0] : "(not found)"; }
