#!/usr/bin/env node
"use strict";
/* Load-test the UMS CRM Dashboard.
 *
 * The question this answers: when many people are logged in and open
 * /Student/CrmConversation/Dashboard at the same time, does it get slow — and if so, is it the
 * server taking longer to answer, or the browser taking longer to draw what it answered?
 *
 * A browser extension cannot do this. It lives inside one browser, and one browser is one person:
 * log a second user in and the first is logged out, because a site keeps one session per browser.
 * "Fifty people at once" needs fifty separate sessions, and the only thing that makes those is a
 * separate cookie jar each. Playwright's browser contexts are exactly that — N isolated sessions
 * inside one real Chrome, each like its own incognito window that does not share cookies with the
 * others — so N users can be logged in together and hit the page together, which is the whole test.
 *
 * Two phases:
 *   1. Log everyone in (up to `count` at a time), each in their own context. Report who got in.
 *   2. Have all the logged-in users open the Dashboard together, and time each open — separating
 *      the server's part (request sent → last byte back) from the browser's part (last byte →
 *      page finished drawing), because those are two different kinds of slow with two different
 *      fixes.
 *
 * It drives the Chrome already installed on the machine (channel: "chrome"); nothing is downloaded.
 *
 *   node loadtest.js --base https://ums-41.osl.team --users users.txt --count 10
 *   node loadtest.js --base https://ums-41.osl.team --users users.txt --count 25 --headed
 *
 * See --help for every option.
 */
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

/* ---------------- arguments ---------------- */
const DEFAULTS = {
  base: "",
  users: "",
  count: 10,
  headed: false,
  dash: "/Student/CrmConversation/Dashboard",
  login: "/Account/Login",
  userField: "",          // auto-detected when blank
  passField: "",          // auto-detected when blank
  wait: "load",           // "load" | "domcontentloaded" | "networkidle"
  navTimeout: 60000,      // per navigation, ms
  out: "",                // write a CSV here as well
  warmup: true,           // one lone user first, as the "not busy" baseline
  keepOpen: false         // leave the browser open at the end instead of closing it
};

function parseArgs(argv) {
  const o = Object.assign({}, DEFAULTS);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = function () { return argv[++i]; };
    if (a === "--help" || a === "-h") { o.help = true; }
    else if (a === "--base") o.base = next();
    else if (a === "--users") o.users = next();
    else if (a === "--count") o.count = Math.max(1, parseInt(next(), 10) || 1);
    else if (a === "--headed") o.headed = true;
    else if (a === "--headless") o.headed = false;
    else if (a === "--dash") o.dash = next();
    else if (a === "--login") o.login = next();
    else if (a === "--user-field") o.userField = next();
    else if (a === "--pass-field") o.passField = next();
    else if (a === "--wait") o.wait = next();
    else if (a === "--nav-timeout") o.navTimeout = Math.max(1000, parseInt(next(), 10) || 60000);
    else if (a === "--out") o.out = next();
    else if (a === "--no-warmup") o.warmup = false;
    else if (a === "--keep-open") o.keepOpen = true;
    else { console.error("unknown option: " + a); o.help = true; }
  }
  return o;
}

const HELP = `
CRM Dashboard load test — N isolated logins in parallel, timed.

  --base <url>          UMS address, e.g. https://ums-41.osl.team   (required)
  --users <file>        one "username,password" per line           (required)
                        (comma, tab or the first space separates the two;
                         blank lines and a "username,password" header are skipped)
  --count <n>           how many at once (default ${DEFAULTS.count})
  --headed              show the browser (default: hidden/headless)
  --dash <path>         the page to test (default ${DEFAULTS.dash})
  --login <path>        login page, if the site does not redirect there itself
                        (default ${DEFAULTS.login})
  --user-field <sel>    CSS selector for the username box (default: auto-detect)
  --pass-field <sel>    CSS selector for the password box (default: auto-detect)
  --wait <when>         when a load is "done": load | domcontentloaded | networkidle
                        (default ${DEFAULTS.wait})
  --nav-timeout <ms>    give up on a page after this long (default ${DEFAULTS.navTimeout})
  --out <file.csv>      also write the per-user numbers to a CSV
  --no-warmup           skip the single lone-user baseline
  --keep-open           leave the browser open at the end (for a look)
`;

/* ---------------- users file ---------------- */
function readUsers(file) {
  const raw = fs.readFileSync(file, "utf8");
  const out = [];
  raw.split(/\r?\n/).forEach(function (line, i) {
    const s = line.trim();
    if (!s || s.startsWith("#")) return;
    /* comma or tab first; otherwise the FIRST space — the username has no spaces, the password
       may, so everything after the first space is the password */
    let user, pass;
    if (s.indexOf(",") >= 0) { const p = s.split(","); user = p[0]; pass = p.slice(1).join(","); }
    else if (s.indexOf("\t") >= 0) { const p = s.split("\t"); user = p[0]; pass = p.slice(1).join("\t"); }
    else { const at = s.indexOf(" "); if (at < 0) { user = s; pass = ""; } else { user = s.slice(0, at); pass = s.slice(at + 1); } }
    user = user.trim(); pass = pass.trim();
    // a column-name header, in any capitalisation ("User Name", "Login", "Pwd" …) — not a login
    if (i === 0 && /^(user\s*(name|id)?|login|email)$/i.test(user) && /^(pass\s*(word)?|pwd)$/i.test(pass)) return;
    if (user) out.push({ user: user, pass: pass, line: i + 1 });
  });
  return out;
}

/* ---------------- one user: log in ---------------- */
/* The login form is the one thing this tool cannot know in advance, so it finds it rather than
   being told: go to the site, and if a password box is on the page, this is the login page. The
   password box is unambiguous; the username box is the visible text box just before it in the
   same form. Filling the site's real form means the browser sends the ASP.NET antiforgery token
   with it automatically — the thing that makes raw HTTP logins so fragile is simply not our
   problem here. Selectors can still be forced with --user-field / --pass-field. */
async function login(context, base, opts) {
  const page = await context.newPage();
  page.setDefaultTimeout(opts.navTimeout);
  const t0 = Date.now();

  /* Going straight to the Dashboard is the honest path: a logged-out user is redirected to the
     login page by the site itself, which is also how we will confirm success later. */
  const target = base + opts.dash;
  await page.goto(target, { waitUntil: "domcontentloaded" });

  const passSel = opts.passField || 'input[type="password"]';
  const hasPass = await page.$(passSel);
  if (!hasPass) {
    /* No password box and not sent to the login page → already usable, or an unexpected page. */
    const onLogin = /Account\/Login/i.test(page.url());
    if (!onLogin) return { page: page, ok: true, note: "no login needed", ms: Date.now() - t0 };
    /* On the login page but the selector missed — try the configured login path explicitly. */
    await page.goto(base + opts.login, { waitUntil: "domcontentloaded" });
  }

  const pass = await page.$(passSel);
  if (!pass) { await page.close(); return { ok: false, why: "no password field found — pass --pass-field" }; }

  let userSel = opts.userField;
  if (!userSel) {
    /* the visible, non-hidden text-ish input that comes before the password box */
    userSel = await page.evaluate(function (ps) {
      const pw = document.querySelector(ps);
      const inputs = Array.prototype.slice.call(document.querySelectorAll("input"));
      const before = inputs.slice(0, inputs.indexOf(pw));
      const cand = before.reverse().find(function (el) {
        const ty = (el.type || "text").toLowerCase();
        if (["hidden", "checkbox", "radio", "submit", "button"].indexOf(ty) >= 0) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (!cand) return null;
      if (cand.id) return "#" + CSS.escape(cand.id);
      if (cand.name) return 'input[name="' + cand.name.replace(/"/g, '\\"') + '"]';
      return null;
    }, passSel);
  }
  if (!userSel) { await page.close(); return { ok: false, why: "no username field found — pass --user-field" }; }

  await page.fill(userSel, opts.__user);
  await page.fill(passSel, opts.__pass);

  /* submit and wait for the page to settle wherever it lands */
  await Promise.all([
    page.waitForLoadState("domcontentloaded"),
    (async function () {
      const btn = await page.$('button[type="submit"], input[type="submit"], button:not([type])');
      if (btn) await btn.click(); else await page.press(passSel, "Enter");
    })()
  ]).catch(function () {});
  /* a moment for a redirect that the click did not wait out */
  await page.waitForTimeout(400);

  const stillLogin = /Account\/Login/i.test(page.url()) || !!(await page.$(passSel));
  if (stillLogin) {
    const msg = (await page.evaluate(function () {
      const e = document.querySelector(".validation-summary-errors, .text-danger, .alert-danger, [role=alert]");
      return e ? e.textContent.replace(/\s+/g, " ").trim().slice(0, 80) : "";
    })) || "still on the login page";
    await page.close();
    return { ok: false, why: msg };
  }
  return { page: page, ok: true, ms: Date.now() - t0 };
}

/* ---------------- one user: open the Dashboard, timed ---------------- */
/* The wall clock says how long the open took; the browser's own Navigation Timing says where the
   time went — responseEnd−requestStart is the server's share (request sent to last byte of HTML),
   loadEventEnd−responseEnd is the browser's (parsing, scripts, drawing). Under load one of those
   two grows, and which one is the answer. */
async function hitDashboard(page, url, opts) {
  const t0 = Date.now();
  let status = 0;
  try {
    const resp = await page.goto(url, { waitUntil: opts.wait, timeout: opts.navTimeout });
    status = resp ? resp.status() : 0;
  } catch (e) {
    return { ok: false, why: (e.message || String(e)).split("\n")[0].slice(0, 80), wall: Date.now() - t0 };
  }
  const wall = Date.now() - t0;
  const onLogin = /Account\/Login/i.test(page.url());
  if (onLogin) return { ok: false, why: "session dropped — bounced to login", wall: wall };

  const nav = await page.evaluate(function () {
    const n = performance.getEntriesByType("navigation")[0];
    if (!n) return null;
    return {
      ttfb: Math.round(n.responseStart - n.requestStart),
      server: Math.round(n.responseEnd - n.requestStart),
      dom: Math.round(n.domContentLoadedEventEnd - n.startTime),
      load: Math.round(n.loadEventEnd - n.startTime)
    };
  }).catch(function () { return null; });

  return {
    ok: status > 0 && status < 400,
    status: status, wall: wall,
    server: nav ? nav.server : null,
    render: nav && nav.load > 0 ? nav.load - nav.server : null,
    load: nav ? (nav.load > 0 ? nav.load : nav.dom) : wall
  };
}

/* ---------------- a small parallel pool ---------------- */
async function pool(items, size, worker) {
  const out = new Array(items.length);
  let next = 0;
  async function run() {
    while (next < items.length) {
      const i = next++;
      out[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
  return out;
}

/* ---------------- statistics ---------------- */
function stats(xs) {
  const v = xs.filter(function (x) { return typeof x === "number" && isFinite(x); }).sort(function (a, b) { return a - b; });
  if (!v.length) return null;
  const at = function (p) { return v[Math.min(v.length - 1, Math.floor(p * (v.length - 1)))]; };
  const sum = v.reduce(function (a, b) { return a + b; }, 0);
  return { n: v.length, min: v[0], median: at(0.5), p95: at(0.95), max: v[v.length - 1], mean: Math.round(sum / v.length) };
}
const ms = function (n) { return n == null ? "  —  " : (n >= 1000 ? (n / 1000).toFixed(1) + "s" : n + "ms"); };

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

  const browser = await chromium.launch({ channel: "chrome", headless: !opts.headed });

  /* ---- phase 1: log everyone in, each in an isolated context ---- */
  process.stdout.write("  logging in… ");
  const sessions = await pool(users, opts.count, async function (u) {
    const context = await browser.newContext();
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
function csv(s) { s = String(s == null ? "" : s); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

if (require.main === module) {
  main().catch(function (e) { console.error("\nfailed: " + (e && e.stack || e)); process.exit(1); });
}
module.exports = { readUsers: readUsers, stats: stats, parseArgs: parseArgs,
  login: login, hitDashboard: hitDashboard, ms: ms };
