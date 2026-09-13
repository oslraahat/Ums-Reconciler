#!/usr/bin/env node
"use strict";
/* Native-messaging host for the CRM load test.
 *
 * A browser extension cannot run Playwright or open isolated sessions, but Chrome lets an
 * extension talk to one small local program that can — this is it. The CRM · Dashboard "Run"
 * button connects here, sends the base URL, the user list and the count, and this runs the real
 * loadtest.js and streams every line it prints back to the page, so the report appears in the UI.
 *
 * The wire format is Chrome's: each message is a 4-byte little-endian length followed by that many
 * bytes of UTF-8 JSON. stdout carries ONLY these frames — loadtest.js's own output is captured on
 * a pipe and forwarded as frames, never written straight through, or it would corrupt the stream.
 *
 * Installed by install.js, which registers this host and locks it to the one extension ID.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

/* ---------------- framing ---------------- */
function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]));
}

let buf = Buffer.alloc(0);
let handled = false;
process.stdin.on("data", function (chunk) {
  buf = Buffer.concat([buf, chunk]);
  /* one config message is all we expect; read the first complete frame and act on it */
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const msg = buf.slice(4, 4 + len);
    buf = buf.slice(4 + len);
    if (!handled) { handled = true; onConfig(JSON.parse(msg.toString("utf8"))); }
  }
});
/* If Chrome closes the port (the page navigated away, the button was pressed again), go quietly. */
process.stdin.on("end", function () { if (!child) process.exit(0); });

/* ---------------- run ---------------- */
let child = null;
function onConfig(cfg) {
  const tool = path.join(__dirname, "..", "loadtest.js");
  if (!fs.existsSync(tool)) { send({ type: "error", text: "loadtest.js not found beside the host" }); return end(1); }

  /* the user list arrives in the message, never on disk; write it to a private temp file just for
     the length of the run and delete it after, passwords and all */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "crmlt-"));
  const usersFile = path.join(dir, "users.txt");
  const lines = (cfg.users || []).map(function (u) { return String(u.user || "") + "," + String(u.pass || ""); });
  fs.writeFileSync(usersFile, lines.join("\n"));

  const args = [tool, "--base", String(cfg.base || ""), "--users", usersFile,
    "--count", String(Math.max(1, parseInt(cfg.count, 10) || 1))];
  if (cfg.headed) args.push("--headed");
  if (cfg.dash) { args.push("--dash", String(cfg.dash)); }
  if (cfg.noWarmup) args.push("--no-warmup");

  send({ type: "start", count: lines.length });

  child = spawn(process.execPath, args, { cwd: path.join(__dirname, "..") });
  let tail = "";
  const feed = function (data) {
    tail += data.toString("utf8");
    const parts = tail.split(/\r?\n/);
    tail = parts.pop();
    parts.forEach(function (line) { send({ type: "out", text: line }); });
  };
  child.stdout.on("data", feed);
  child.stderr.on("data", feed);
  child.on("error", function (e) { send({ type: "error", text: (e && e.message) || String(e) }); end(1, dir); });
  child.on("close", function (code) {
    if (tail) send({ type: "out", text: tail });
    send({ type: "done", code: code });
    end(code, dir);
  });
}

function end(code, dir) {
  if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (e) {} }
  /* let the last frame flush before the pipe closes */
  setTimeout(function () { process.exit(code || 0); }, 50);
}
