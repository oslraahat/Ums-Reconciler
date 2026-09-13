#!/usr/bin/env node
"use strict";
/* Native-messaging host for the CRM load test — a persistent browser session.
 *
 * The extension connects once and keeps the port open. Each "Run" press sends a "visit" message;
 * this host holds one real Chrome open across them and, message by message, logs the given users
 * into their own isolated contexts and opens the Dashboard, timing each. Because the browser stays
 * open between messages, pressing Run again lands the next user in the same window beside the ones
 * already there — until "Close" is sent, or the extension disconnects, at which point the browser
 * closes and their sessions are gone.
 *
 * Which users a message carries is the extension's business: sequential sends one at a time and
 * advances; parallel sends the whole list with a count. Keep-open vs close-after-each is a flag on
 * the message. The login and timing themselves are loadtest.js's own functions, imported, so the
 * numbers here and on the command line are produced by the same code.
 *
 * Wire format is Chrome's: 4-byte little-endian length, then that many bytes of UTF-8 JSON. stdout
 * carries only these frames.
 */
const path = require("path");
const lt = require(path.join(__dirname, "..", "loadtest.js"));
const { chromium } = require(path.join(__dirname, "..", "node_modules", "playwright-core"));

/* ---------------- framing ---------------- */
function send(obj) {
  const body = Buffer.from(JSON.stringify(obj), "utf8");
  const head = Buffer.alloc(4); head.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([head, body]));
}
let buf = Buffer.alloc(0);
const queue = [];
let working = false;
process.stdin.on("data", function (chunk) {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const msg = JSON.parse(buf.slice(4, 4 + len).toString("utf8"));
    buf = buf.slice(4 + len);
    queue.push(msg); pump();
  }
});
process.stdin.on("end", function () { shutdown(0); });

/* ---------------- the browser it holds ---------------- */
let browser = null;

async function pump() {
  if (working) return;                     // one message at a time, in order
  working = true;
  while (queue.length) {
    const m = queue.shift();
    try {
      if (m.action === "close") { await closeBrowser(); send({ type: "closed" }); }
      else await visit(m);
    } catch (e) { send({ type: "error", text: (e && e.message) || String(e) }); }
  }
  working = false;
}

async function visit(m) {
  const base = String(m.base || "").replace(/\/+$/, "");
  const users = m.users || [];
  const count = Math.max(1, parseInt(m.count, 10) || 1);
  const keepOpen = !!m.keepOpen;
  const opts = {
    dash: m.dash || "/Student/CrmConversation/Dashboard", login: "/Account/Login",
    userField: m.userField || "", passField: m.passField || "",
    wait: "load", navTimeout: 60000
  };
  const dashUrl = base + opts.dash;

  if (!browser) browser = await chromium.launch({ channel: "chrome", headless: !m.headed });
  send({ type: "start", count: users.length, keepOpen: keepOpen });

  /* a small pool so `count` users go at once; each keeps or drops its context per keepOpen */
  let next = 0;
  async function one(u) {
    const context = await browser.newContext();
    send({ type: "out", text: "→ " + u.user });
    let li;
    try { li = await lt.login(context, base, Object.assign({}, opts, { __user: u.user, __pass: u.pass })); }
    catch (e) { li = { ok: false, why: (e.message || String(e)).split("\n")[0].slice(0, 80) }; }
    if (!li.ok) { send({ type: "out", text: "  ✗ " + (li.why || "login failed") }); await context.close().catch(function () {}); return; }
    let d;
    try { d = await lt.hitDashboard(li.page, dashUrl, opts); }
    catch (e) { d = { ok: false, why: (e.message || String(e)).split("\n")[0].slice(0, 80) }; }
    if (d.ok) send({ type: "out", text: "  ✓ " + u.user + " · server " + lt.ms(d.server) + " · full " + lt.ms(d.load) });
    else send({ type: "out", text: "  ✗ " + u.user + " — " + (d.why || "dashboard failed") });
    if (!keepOpen) await context.close().catch(function () {});
  }
  await Promise.all(Array.from({ length: Math.min(count, users.length || 1) }, async function () {
    while (next < users.length) { const i = next++; await one(users[i]); }
  }));

  if (!keepOpen && browser) {
    /* nothing is meant to stay on screen — free the window, but keep the host alive for the next
       press so the extension's port need not reconnect */
    await browser.close().catch(function () {});
    browser = null;
  }
  send({ type: "done", keepOpen: keepOpen });
}

async function closeBrowser() {
  if (browser) { try { await browser.close(); } catch (e) {} browser = null; }
}
function shutdown(code) {
  closeBrowser().finally(function () { setTimeout(function () { process.exit(code || 0); }, 50); });
}
