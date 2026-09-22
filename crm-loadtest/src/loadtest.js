"use strict";
/* orchestration for the CRM Dashboard load test: parse argv, log everyone in, then time them all
   opening the Dashboard together. The single-responsibility pieces live under src/lib and
   src/browser; this module only wires them into the two-phase run. */
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");
const { parseArgs, HELP } = require("./lib/args");
const { readUsers } = require("./lib/users");
const { pool } = require("./lib/pool");
const { stats, ms } = require("./lib/stats");
const { csv } = require("./lib/csv");
const { login } = require("./browser/login");
const { hitDashboard } = require("./browser/dashboard");

/* ---------------- run ---------------- */
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(HELP); return; }
  if (!opts.base) { console.error("--base is required (e.g. --base https://ums-41.osl.team)"); process.exit(2); }
  if (!opts.users) { console.error("--users is required (a file of username,password lines)"); process.exit(2); }
  opts.base = opts.base.replace(/\/+$/, "");

  const users = readUsers(opts.users);
  if (!users.length) { console.error("no users read from " + opts.users); process.exit(2); }

  console.log("");
  console.log("  target   " + opts.base + opts.dash);
  console.log("  users    " + users.length + " from " + path.basename(opts.users));
  console.log("  at once  " + opts.count + (opts.headed ? "   · headed (browser visible)" : "   · headless"));
  console.log("");

  const browser = await chromium.launch({ channel: "chrome", headless: !opts.headed,
    args: (opts.maximize && opts.headed) ? ["--start-maximized"] : [] });

  /* ---- phase 1: log everyone in, each in an isolated context ---- */
  process.stdout.write("  logging in… ");
  const sessions = await pool(users, opts.count, async function (u) {
    const context = await browser.newContext((opts.maximize && opts.headed) ? { viewport: null } : {});
    const o = Object.assign({}, opts, { __user: u.user, __pass: u.pass });
    let res;
    try { res = await login(context, opts.base, o); }
    catch (e) { res = { ok: false, why: (e.message || String(e)).split("\n")[0].slice(0, 80) }; }
    if (!res.ok) { await context.close().catch(function () {}); }
    return { user: u, context: context, page: res.page, ok: res.ok, why: res.why, loginMs: res.ms };
  });
  const inOk = sessions.filter(function (s) { return s.ok; });
  const inBad = sessions.filter(function (s) { return !s.ok; });
  console.log(inOk.length + " of " + users.length + " logged in");
  if (inBad.length) {
    console.log("  could not log in:");
    inBad.slice(0, 20).forEach(function (s) { console.log("    " + s.user.user.padEnd(22) + (s.why || "")); });
    if (inBad.length > 20) console.log("    …and " + (inBad.length - 20) + " more");
  }
  if (!inOk.length) { await browser.close(); console.log("\n  nobody logged in — nothing to measure.\n"); return; }

  const dashUrl = opts.base + opts.dash;

  /* ---- optional baseline: one user alone, so "busy" has something to be compared to ---- */
  let base1 = null;
  if (opts.warmup && inOk.length > 1) {
    process.stdout.write("\n  baseline (1 user alone)… ");
    base1 = await hitDashboard(inOk[0].page, dashUrl, opts);
    console.log(base1.ok ? ("server " + ms(base1.server) + " · full " + ms(base1.load)) : ("failed: " + base1.why));
  }

  /* ---- phase 2: everyone opens the Dashboard together ---- */
  process.stdout.write("\n  " + inOk.length + " users opening the Dashboard together… ");
  const hits = await pool(inOk, opts.count, async function (s) {
    const r = await hitDashboard(s.page, dashUrl, opts);
    return Object.assign({ user: s.user.user }, r);
  });
  const hitOk = hits.filter(function (h) { return h.ok; });
  console.log(hitOk.length + " loaded, " + (hits.length - hitOk.length) + " failed");

  /* ---- the numbers ---- */
  const sv = stats(hitOk.map(function (h) { return h.server; }));
  const ld = stats(hitOk.map(function (h) { return h.load; }));
  console.log("\n  Dashboard load, " + inOk.length + " at once");
  console.log("                      min      median      p95       max");
  if (sv) console.log("    server answer   " + ms(sv.min).padStart(7) + "   " + ms(sv.median).padStart(8) + "   " + ms(sv.p95).padStart(7) + "   " + ms(sv.max).padStart(7));
  if (ld) console.log("    full page load  " + ms(ld.min).padStart(7) + "   " + ms(ld.median).padStart(8) + "   " + ms(ld.p95).padStart(7) + "   " + ms(ld.max).padStart(7));

  if (base1 && base1.ok && ld && base1.load) {
    const factor = (ld.median / base1.load);
    console.log("\n  alone the full load was " + ms(base1.load) + "; with " + inOk.length +
      " at once the middle one was " + ms(ld.median) + "  (" + factor.toFixed(1) + "× " +
      (factor >= 1.3 ? "slower — the page does degrade under load" : "— little change") + ")");
    if (sv && base1.server) {
      const sf = sv.median / base1.server;
      console.log("  of which the server's share went " + sf.toFixed(1) + "× (" +
        (sf >= 1.3 ? "the server is the bottleneck" : "the server held up; the slowdown is in the browser/render") + ")");
    }
  }

  const failed = hits.filter(function (h) { return !h.ok; });
  if (failed.length) {
    console.log("\n  did not load for:");
    failed.slice(0, 20).forEach(function (h) { console.log("    " + h.user.padEnd(22) + (h.why || "")); });
    if (failed.length > 20) console.log("    …and " + (failed.length - 20) + " more");
  }

  /* ---- optional CSV ---- */
  if (opts.out) {
    const rows = ["username,logged_in,dashboard_ok,status,server_ms,render_ms,full_load_ms,wall_ms,note"];
    sessions.forEach(function (s) {
      if (!s.ok) { rows.push([s.user.user, "no", "", "", "", "", "", "", csv(s.why)].join(",")); }
    });
    hits.forEach(function (h) {
      rows.push([h.user, "yes", h.ok ? "yes" : "no", h.status || "", h.server == null ? "" : h.server,
        h.render == null ? "" : h.render, h.load == null ? "" : h.load, h.wall == null ? "" : h.wall,
        csv(h.why || "")].join(","));
    });
    fs.writeFileSync(opts.out, rows.join("\n"));
    console.log("\n  per-user numbers written to " + opts.out);
  }

  if (!opts.keepOpen) await browser.close();
  else console.log("\n  (browser left open — close it yourself, or Ctrl+C here)");
  console.log("");
}

module.exports = { main: main };
