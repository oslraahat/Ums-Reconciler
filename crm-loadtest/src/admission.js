"use strict";
/* ---------------- CLI (manual fallback) ---------------- */
/* node admission.js --base <url> --email <e> --password <p> --mobile <m> [--count N] [--pool P]
 *                    [--program <kw>] [--received <amt>] [--headed]
 * Logs in once, runs `count` real admissions through `pool` parallel tabs, prints the rate. */
const path = require("path");
const { admit } = require("./admission/admit");
const { login } = require("./browser/login");

async function main() {
  const a = process.argv.slice(2);
  const get = function (f, d) { const i = a.indexOf(f); return i >= 0 && a[i + 1] ? a[i + 1] : d; };
  const base = String(get("--base", "")).replace(/\/+$/, "");
  const email = get("--email", ""), pass = get("--password", ""), mobile = get("--mobile", "");
  const count = Math.max(1, parseInt(get("--count", "1"), 10) || 1);
  const pool = Math.max(1, Math.min(count, parseInt(get("--pool", "1"), 10) || 1));
  const headed = a.indexOf("--headed") >= 0;
  const admOpts = { mobile: mobile, program: get("--program", ""), received: parseInt(get("--received", "15000"), 10) || 15000, session: get("--session", "2025") };
  if (!base || !email || !pass || !mobile) {
    console.error("Usage: node admission.js --base <url> --email <e> --password <p> --mobile <m> [--count N] [--pool P] [--program kw] [--headed]");
    process.exit(1);
  }
  const { chromium } = require(path.join(__dirname, "..", "node_modules", "playwright-core"));
  const browser = await chromium.launch({ channel: "chrome", headless: !headed });
  const context = await browser.newContext();
  const opts = { dash: "/Student/Admission/NewStudentAdmission", login: "/Account/Login", userField: "", passField: "", wait: "load", navTimeout: 60000, __user: email, __pass: pass };
  const li = await login(context, base, opts);
  if (!li.ok) { console.error("✗ login — " + (li.why || "failed")); await browser.close(); process.exit(1); }
  console.log("→ logged in · " + count + " admission(s), " + pool + " at once");
  const t0 = Date.now();
  let next = 0, ok = 0, fail = 0;
  const worker = async function (idx) {
    const page = idx === 0 ? li.page : await context.newPage();
    while (true) {
      const i = next++; if (i >= count) break;
      let r; try { r = await admit(page, base, admOpts, function () {}); } catch (e) { r = { ok: false, why: (e.message || String(e)).slice(0, 80) }; }
      if (r.ok) { ok++; console.log("  ✓ #" + (i + 1) + "/" + count + " · reg " + r.reg + " · " + (r.ms / 1000).toFixed(1) + "s"); }
      else { fail++; console.log("  ✗ #" + (i + 1) + "/" + count + " — " + (r.why || "failed")); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(pool, count) }, function (_, i) { return worker(i); }));
  const secs = (Date.now() - t0) / 1000;
  console.log("── " + ok + " ok · " + fail + " failed · " + secs.toFixed(1) + "s · ~" + (secs > 0 ? Math.round(ok / secs * 60) : 0) + "/min");
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
}

module.exports = { main: main };
