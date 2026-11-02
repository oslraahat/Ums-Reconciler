/* Read-only discovery of a UMS page: what it asks for, and what it calls.
 *
 *   node tools/discover.js --base https://ums-4.osl.team --page /Student/Admission/NewAdmission
 *   node tools/discover.js --base https://ums-4.osl.team --page /Student/FranchisorTransaction/Create
 *   node tools/discover.js --base ... --page ... --loader /Student/Admission/GetSessionByProgram --params programId=68
 *
 * Step 1 of docs/franchise-scenarios.md. Add Course, Due Payment, Transfer and Program Migration
 * have to be mapped before any of them can be built, and mapping is reading: fetch the page, list
 * its form fields and dropdowns, and pull the endpoints its own inline script calls. The same thing
 * was done by hand for the report and written up as docs/franchise-api.md; this makes it repeatable
 * and, more to the point, makes the refusals automatic rather than remembered.
 *
 * The cookie comes from the environment, never the command line:
 *
 *   UMS_COOKIE=".UERP_AUTH=…" node tools/discover.js --base … --page …
 *
 * so it stays out of the shell history and out of this file's output. It is never printed, not even
 * truncated.
 *
 * What this will not do, by construction:
 *
 *   - anything to a host that is not *.osl.team. Real admissions create real records, and umsbd.net
 *     and orgbd.net are not test servers. Checked on the parsed hostname, not by substring.
 *   - POST to anything but a loader. A loader is Get…/Load…/…DataTable…: it answers a question. A
 *     path with Create/Save/Insert/Update/Delete/Submit/Cancel/Migrate/Transfer/Pay in it changes
 *     something, and discovery has no business sending one. Named and refused, loudly.
 *   - send a password. Not as a field, not as a default, not blank. A password input found on a page
 *     is REPORTED and never filled.
 *   - follow a redirect to a login page and carry on as though the answer meant anything.
 */
"use strict";

const fs = require("fs");

/* Required rather than run, this file hands over its decisions and does nothing else — see the
   bottom of the file. The refusals below are the whole point of the tool, and a test that proved
   them by RUNNING the tool would, the moment a guard broke, perform the very POST the guard exists
   to prevent. Asking the decision function is the only way to test a refusal without depending on
   it, so the decisions are plain functions and the command line is just one caller. */

// ---------- arguments ----------
let base = "", page = "", loader = "", params = "", out = "";
function readArgs() {
  const argv = process.argv.slice(2);
  const arg = function (name, dflt) {
    const i = argv.indexOf("--" + name);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
  };
  base = (arg("base", "") || "").replace(/\/+$/, "");
  page = arg("page", "");
  loader = arg("loader", "");
  params = arg("params", "");
  out = arg("out", "");
}

// ---------- the gate ----------
/* On the parsed hostname. A substring test passes "osl.team.evil.com" and would have sent the
   session cookie to it. */
function isTest(u) {
  try {
    const h = new URL(u);
    return /^https:$/.test(h.protocol) && /(^|\.)osl\.team$/i.test(h.hostname);
  } catch (e) { return false; }
}
let cookie = "";

// ---------- write-endpoint refusal ----------
const WRITES = /(Create|Save|Insert|Add|Update|Edit|Delete|Remove|Submit|Confirm|Approve|Cancel|Migrat|Transfer|Pay(ment)?|Admission)/i;
const LOADERS = /(^|\/)(Get|Load)[A-Za-z]*$|DataTable|CalculationData$/;
function classify(path) {
  const tail = path.split("?")[0];
  if (LOADERS.test(tail)) return "loader";
  if (WRITES.test(tail)) return "WRITE";
  return "unknown";
}

// ---------- fetching ----------
async function get(path) {
  const url = base + path;
  const res = await fetch(url, {
    redirect: "manual",
    headers: { cookie: cookie, "user-agent": "ums-reconciler-discover/1 (read-only)" }
  });
  const loc = res.headers.get("location") || "";
  if (res.status >= 300 && res.status < 400) {
    return { status: res.status, redirect: loc, text: "" };
  }
  const text = await res.text();
  return { status: res.status, redirect: "", text: text };
}

function looksLikeLogin(r) {
  if (/\/Account\/Login|\/Login/i.test(r.redirect)) return true;
  return /name="?Password"?|id="?Password"?|type="password"/i.test(r.text) &&
    /sign ?in|log ?in|লগইন/i.test(r.text);
}

// ---------- parsing ----------
function attrs(tag) {
  const o = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(tag))) o[m[1].toLowerCase()] = m[2];
  return o;
}
function tags(html, name) {
  const out = [];
  const re = new RegExp("<" + name + "\\b[^>]*>", "gi");
  let m;
  while ((m = re.exec(html))) out.push({ raw: m[0], at: m.index, a: attrs(m[0]) });
  return out;
}

function report(path, r) {
  const html = r.text;
  const lines = [];
  const say = function (s) { lines.push(s); };

  say("# " + path);
  say("");
  say("HTTP " + r.status + (r.redirect ? " → " + r.redirect : ""));
  if (looksLikeLogin(r)) {
    say("");
    say("**This is the login page, not the page asked for.** The session cookie is expired or has no");
    say("rights to it. Nothing below would mean anything, so nothing below is reported.");
    return lines.join("\n");
  }
  say("");

  // forms
  const forms = tags(html, "form");
  say("## Forms (" + forms.length + ")");
  forms.forEach(function (f, i) {
    say("");
    say((i + 1) + ". action=`" + (f.a.action || "(this page)") + "`  method=`" +
      (f.a.method || "get").toUpperCase() + "`" +
      (f.a.action ? "  → " + classify(f.a.action) : ""));
  });

  // fields, with passwords named and never touched
  const inputs = tags(html, "input").concat(tags(html, "textarea"));
  const pw = inputs.filter(function (x) { return (x.a.type || "").toLowerCase() === "password"; });
  const token = inputs.filter(function (x) { return /RequestVerificationToken/i.test(x.a.name || ""); });
  const fields = inputs.filter(function (x) {
    const t = (x.a.type || "text").toLowerCase();
    return t !== "password" && x.a.name && !/RequestVerificationToken/i.test(x.a.name);
  });
  say("");
  say("## Fields (" + fields.length + ")");
  say("");
  say("| name | type | id | value |");
  say("|---|---|---|---|");
  fields.slice(0, 80).forEach(function (x) {
    say("| `" + x.a.name + "` | " + (x.a.type || "text") + " | " + (x.a.id || "") + " | " +
      (x.a.value ? "`" + x.a.value.slice(0, 30) + "`" : "") + " |");
  });
  if (fields.length > 80) say("| … | (" + (fields.length - 80) + " more) | | |");

  if (pw.length) {
    say("");
    say("## Password fields — " + pw.length + ", reported and NOT filled");
    say("");
    pw.forEach(function (x) { say("- `" + (x.a.name || x.a.id || "(unnamed)") + "`"); });
    say("");
    say("A password is never filled and never submitted by this tool. If a scenario needs one, it is");
    say("entered by a person, in a browser.");
  }

  /* The antiforgery token is worth naming either way: UMS answers a RequestVerificationToken HEADER
     with 302 → PermissionDenied, which looks exactly like an expired session and is not one — but
     the hidden FORM field is what its own pages post. See docs/franchise-api.md. */
  say("");
  say("## Antiforgery token");
  say("");
  say(token.length
    ? "Present as a hidden form field (" + token.length + "). Post it as a FIELD, never as a header."
    : "No hidden token field on this page.");

  // dropdowns
  const sels = tags(html, "select");
  say("");
  say("## Dropdowns (" + sels.length + ")");
  say("");
  sels.forEach(function (s) {
    const after = html.slice(s.at, html.indexOf("</select>", s.at) + 9);
    const n = (after.match(/<option/gi) || []).length;
    say("- `" + (s.a.id || s.a.name || "(unnamed)") + "` — " + n + " option" + (n === 1 ? "" : "s") +
      (n <= 1 ? "  ← filled by a loader, so it is part of the cascade" : ""));
  });

  /* The cascade: every path the page's own script calls. This is the part that cannot be guessed,
     and the part docs/franchise-api.md exists to record. */
  const found = {};
  const pre = /["'](\/[A-Za-z][A-Za-z0-9_]*\/[A-Za-z][A-Za-z0-9_]*(?:\/[A-Za-z][A-Za-z0-9_]*)?)["']/g;
  let m;
  while ((m = pre.exec(html))) found[m[1]] = (found[m[1]] || 0) + 1;
  const paths = Object.keys(found).sort();
  say("");
  say("## Endpoints this page references (" + paths.length + ")");
  say("");
  say("| path | times | kind |");
  say("|---|---|---|");
  paths.forEach(function (pth) {
    say("| `" + pth + "` | " + found[pth] + " | " + classify(pth) + " |");
  });
  const writes = paths.filter(function (pth) { return classify(pth) === "WRITE"; });
  if (writes.length) {
    say("");
    say("### The " + writes.length + " that change something");
    say("");
    say("Named so they can be mapped, and never requested here. A dry run assembles the payload for");
    say("one of these and displays it; sending it is a separate, explicit step on *.osl.team.");
    say("");
    writes.forEach(function (pth) { say("- `" + pth + "`"); });
  }
  return lines.join("\n");
}

// ---------- a loader may be asked a question; nothing else may ----------
async function askLoader(path, qs) {
  if (classify(path) !== "loader") {
    console.error("refused: `" + path + "` is not a loader (" + classify(path) + ").");
    console.error("Discovery reads. A path that changes something is mapped from the page that calls");
    console.error("it, never by sending it.");
    process.exit(4);
  }
  if (/password/i.test(qs)) {
    console.error("refused: a password is never sent by this tool.");
    process.exit(5);
  }
  const res = await fetch(base + path, {
    method: "POST",
    redirect: "manual",
    headers: {
      cookie: cookie,
      "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
      "x-requested-with": "XMLHttpRequest",
      /* Its own pages are the Referer these controllers check; see docs/franchise-api.md. And the
         RequestVerificationToken HEADER is deliberately absent — it answers 302 PermissionDenied. */
      referer: base + (page || "/")
    },
    body: qs
  });
  const text = await res.text();
  console.log("HTTP " + res.status + (res.headers.get("location") ? " → " + res.headers.get("location") : ""));
  console.log(text.slice(0, 4000));
  if (text.length > 4000) console.log("\n… " + (text.length - 4000) + " more characters");
}

/* Every refusal happens here, before anything is sent — which is also why each one can be tested by
   asking the function above rather than by letting the tool run and seeing what it did. */
async function main() {
  readArgs();
  if (!base || (!page && !loader)) {
    console.log(fs.readFileSync(__filename, "utf8").split("*/")[0].replace(/^\/\* ?| ?\* ?/gm, ""));
    process.exit(1);
  }
  if (!isTest(base)) {
    console.error("refused: " + base + " is not an https *.osl.team host.");
    console.error("Real admissions create real records. umsbd.net and orgbd.net are not test servers.");
    process.exit(2);
  }
  cookie = process.env.UMS_COOKIE || "";
  if (!cookie) {
    console.error("no UMS_COOKIE in the environment. Sign in to " + base + " in a browser, copy the");
    console.error("session cookie, and pass it as UMS_COOKIE=… so it stays out of the command line.");
    process.exit(3);
  }
  try {
    if (loader) {
      await askLoader(loader, params);
      return;
    }
    const r = await get(page);
    const md = report(page, r);
    if (out) {
      fs.appendFileSync(out, "\n\n" + md + "\n");
      console.log("appended to " + out);
    } else {
      console.log(md);
    }
  } catch (e) {
    console.error("failed: " + (e && e.message ? e.message : e));
    process.exit(1);
  }
}

if (require.main === module) {
  main();
} else {
  module.exports = {
    isTest: isTest, classify: classify, looksLikeLogin: looksLikeLogin,
    WRITES: WRITES, LOADERS: LOADERS
  };
}
