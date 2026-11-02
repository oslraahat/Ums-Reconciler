/* Read-only discovery of a UMS page: what it asks for, and what it calls.
 *
 *   node tools/discover.js --base https://ums-4.osl.team --page /Student/Admission/NewAdmission
 *   node tools/discover.js --base https://ums-4.osl.team --page /Student/FranchisorTransaction/Create
 *   node tools/discover.js --base ... --page ... --loader /Student/Admission/GetSessionByProgram --params programId=68
 *
 * Maps a UMS page by reading it: the form fields, the dropdowns, and the endpoints its own script
 * calls. Nothing about it is tied to a particular menu — it is how docs/franchise-api.md was
 * written, and it is here for the next time an endpoint has to be found rather than guessed. What
 * makes it worth keeping as a tool rather than a habit is that the refusals below are automatic.
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
let base = "", page = "", loader = "", params = "", out = "", allowVerified = false;
function readArgs() {
  const argv = process.argv.slice(2);
  const arg = function (name, dflt) {
    const i = argv.indexOf("--" + name);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : dflt;
  };
  base = (arg("base", "") || "").replace(/\/+$/, "");
  page = normPath(arg("page", ""), "--page");
  loader = normPath(arg("loader", ""), "--loader");
  params = arg("params", "");
  out = arg("out", "");
  allowVerified = argv.indexOf("--allow-verified-read") >= 0;
}

/* Git Bash on Windows rewrites an argument that looks like a Unix path into a Windows one before
   the program ever sees it: `--page /Student/X` arrives as `C:/Program Files/Git/Student/X`. Pasted
   onto the base that gave https://ums-3.osl.teamC:/Program Files/… , whose hostname parses as
   "ums-3.osl.teamc", and the only thing said about it was "fetch failed".
   Recovered here rather than worked around at the call site, and SAID rather than done quietly:
   silently rewriting what someone typed is its own way to waste an afternoon. */
function normPath(v, which) {
  if (!v) return "";
  let p = v;
  const msys = p.match(/^[A-Za-z]:[\\/](?:.*[\\/])?Git[\\/](.*)$/);
  if (msys) {
    p = "/" + msys[1].replace(/\\/g, "/");
    console.error("note: the shell rewrote " + which + " as a Windows path; reading it as " + p);
    console.error("      (pass MSYS_NO_PATHCONV=1, or a leading // , to stop it at the source)");
  }
  try {
    // a full URL is accepted too, so a link can be pasted straight in
    const u = new URL(p);
    if (/^https?:$/.test(u.protocol)) return u.pathname + (u.search || "");
  } catch (e) { /* not a URL, which is the normal case */ }
  return p.startsWith("/") ? p : "/" + p;
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

/* A few of these controllers answer a LOOKUP on a path whose name says it writes. UMS's Transfer
   page is the clearest: GET /Student/StudentTransfer/Create serves the page, and its search button
   POSTs to the SAME url with one field, stdRollOrRegistrationNo, to find the student — the second
   step does not exist until that has returned.
   Loosening the pattern to let those through would also let through everything else named Create.
   So the pattern stays, and each exception is a named entry with the evidence for it and the exact
   fields it may be sent. Anything not listed, or listed but sent a field it does not name, is
   refused as before — and even a listed one needs --allow-verified-read on the command line, so no
   POST to a path called Create can happen by default or by accident.
   An entry here is a claim that a request only reads. It is made from the page's own script, it is
   written down, and it is one line to remove if it turns out to be wrong. */
const VERIFIED_READS = [{
  path: "/Student/StudentTransfer/Create",
  fields: ["stdRollOrRegistrationNo"],
  why: "the page's own search button (#studentPrn, \"Find Student\"): $.ajax({ url: " +
       "'/Student/StudentTransfer/Create', type: 'POST', data: { stdRollOrRegistrationNo: " +
       "$('#PrnNoFirst').val() } }) — a student lookup, rendered into the page; the transfer itself " +
       "is a later step with its own submit. Run on ums-3: answers an HTML fragment, and for an " +
       "unknown number \"Please provide valid Registration No./ Roll No.\""
}, {
  path: "/Student/AddCourse/GenerateStudentProgramDetails",
  fields: ["stdRollOrRegistrationNo"],
  why: "the page's own $.ajax POST with data { stdRollOrRegistrationNo } — it renders the student's " +
       "programmes so one can be chosen. Corroborated in our own shipped code: menus/cc/cc-page.js " +
       "calls the identical action on the CancelCourse controller purely to list programmes"
}, {
  path: "/Student/CancelCourse/GenerateStudentProgramDetails",
  fields: ["stdRollOrRegistrationNo"],
  why: "the same action, and the one Course Cancel has used read-only since it shipped — " +
       "menus/cc/cc-page.js asks it for a student's programmes and cancels nothing by doing so"
}];
function verifiedRead(path, qs) {
  const tail = path.split("?")[0];
  const hit = VERIFIED_READS.filter(function (v) { return v.path.toLowerCase() === tail.toLowerCase(); })[0];
  if (!hit) return null;
  const sent = String(qs || "").split("&").filter(Boolean).map(function (kv) { return kv.split("=")[0]; });
  const extra = sent.filter(function (k) { return hit.fields.indexOf(k) < 0; });
  return extra.length ? { hit: hit, extra: extra } : { hit: hit, extra: [] };
}

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

/* These pages keep almost nothing inline: the dropdowns arrive server-rendered and the cascade lives
   in /Scripts/…. Four pages each reported one shared loader and nothing else until the scripts were
   read too. Same-origin only, and capped — a page that references forty bundles is not an invitation
   to fetch forty bundles. */
async function scriptsOf(html, limit) {
  const srcs = [];
  const re = /<script[^>]*\bsrc="([^"]+)"/gi;
  let m;
  while ((m = re.exec(html)) && srcs.length < limit) {
    const s = m[1];
    if (/^https?:\/\//i.test(s) || s.startsWith("//")) continue;   // off-site, including analytics
    srcs.push(s.startsWith("/") ? s : "/" + s);
  }
  const bodies = [];
  for (const s of srcs) {
    try {
      const got = await get(s);
      if (got.status === 200 && got.text) bodies.push({ src: s, text: got.text });
    } catch (e) { /* a missing bundle says nothing about the page */ }
  }
  return bodies;
}

function report(path, r, scripts) {
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
  /* A field with an id and no name is still a field: these pages post what their own script
     collects, not what a <form> submits, so requiring a name reported "Fields (0)" on a page with
     23 dropdowns and a dozen inputs. Hidden fields are kept too — they carry the ids the write
     endpoint actually keys on. */
  const fields = inputs.filter(function (x) {
    const t = (x.a.type || "text").toLowerCase();
    return t !== "password" && t !== "submit" && t !== "button" &&
      (x.a.name || x.a.id) && !/RequestVerificationToken/i.test(x.a.name || "");
  });
  say("");
  say("## Fields (" + fields.length + ")");
  say("");
  say("| name | type | id | value |");
  say("|---|---|---|---|");
  fields.slice(0, 80).forEach(function (x) {
    say("| `" + (x.a.name || "(id only)") + "` | " + (x.a.type || "text") + " | " + (x.a.id || "") + " | " +
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

  /* The page's OWN cascade, which is the part that cannot be guessed and the reason for the run.
     It was missing entirely at first: these scripts call their own controller with a RELATIVE url —
     $.post("GenerateStudentProgramDetails", …) — and a pattern that required a leading slash found
     only the left menu's links, so every page reported the same two loaders from the shared layout
     and none of its own. Resolved against the controller the page itself is in. */
  const ctrl = path.replace(/^\/+/, "").split("/").slice(0, 2).join("/");
  const rel = {};
  // $.post("GenerateStudentProgramDetails", …) — bare action against its own controller
  const relpat = /(?:url\s*:\s*|\$\.(?:post|get|getJSON)\s*\(\s*|action\s*:\s*)["']([A-Za-z][A-Za-z0-9_]*)["']/g;
  while ((m = relpat.exec(html))) rel["/" + ctrl + "/" + m[1]] = (rel["/" + ctrl + "/" + m[1]] || 0) + 1;
  /* And the shape these pages actually use, which is neither of the two above:
         url: $("body").attr("data-project-root") + "Student/AddCourse/GetSomething"
     a root read off the <body> plus a path with no leading slash. Nothing that required a leading
     slash saw any of it, which is why every page reported only the left menu's links and the same
     two loaders from the shared layout. An initial capital is what separates these from the
     ordinary "a/b" strings in the page. */
  const rootpat = /["']([A-Z][A-Za-z0-9_]*\/[A-Za-z][A-Za-z0-9_]*(?:\/[A-Za-z0-9_]+)?)["']/g;
  while ((m = rootpat.exec(html))) rel["/" + m[1]] = (rel["/" + m[1]] || 0) + 1;
  /* and the same two shapes again inside each script the page loads, which is where these pages
     actually keep their cascade */
  (scripts || []).forEach(function (sc) {
    let x;
    const a = new RegExp(relpat.source, "g");
    while ((x = a.exec(sc.text))) rel["/" + ctrl + "/" + x[1]] = (rel["/" + ctrl + "/" + x[1]] || 0) + 1;
    const b = new RegExp(rootpat.source, "g");
    while ((x = b.exec(sc.text))) rel["/" + x[1]] = (rel["/" + x[1]] || 0) + 1;
    const c = new RegExp(pre.source, "g");
    while ((x = c.exec(sc.text))) rel[x[1]] = (rel[x[1]] || 0) + 1;
  });
  const relPaths = Object.keys(rel).sort();
  if (scripts && scripts.length) {
    say("");
    say("## Scripts read (" + scripts.length + ")");
    say("");
    scripts.forEach(function (sc) { say("- `" + sc.src + "` — " + sc.text.length + " bytes"); });
  }
  if (relPaths.length) {
    say("");
    say("## This page's own cascade (" + relPaths.length + ")");
    say("");
    say("Called with a relative url by the page's own script, resolved against `/" + ctrl + "/`.");
    say("");
    say("| path | times | kind |");
    say("|---|---|---|");
    relPaths.forEach(function (pth) {
      say("| `" + pth + "` | " + rel[pth] + " | " + classify(pth) + " |");
    });
    say("");
    say("Note: `kind` is judged on the whole path, deliberately over-inclusively — a controller");
    say("called AddCourse or Payment makes everything under it a WRITE, so a read-only loader there");
    say("is refused too. That is the safe direction: it is mapped from the page instead of called.");
  }
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
    const v = verifiedRead(path, qs);
    if (!v) {
      console.error("refused: `" + path + "` is not a loader (" + classify(path) + ").");
      console.error("Discovery reads. A path that changes something is mapped from the page that calls");
      console.error("it, never by sending it.");
      process.exit(4);
    }
    if (v.extra.length) {
      console.error("refused: `" + path + "` is a verified read, but only with " +
        v.hit.fields.join(", ") + ".");
      console.error("These were also sent: " + v.extra.join(", ") + ". A lookup given fields it does");
      console.error("not take is no longer the request that was verified.");
      process.exit(6);
    }
    if (!allowVerified) {
      console.error("refused: `" + path + "` is a verified read, but --allow-verified-read was not given.");
      console.error("Why it is one: " + v.hit.why);
      console.error("Pass --allow-verified-read to send exactly: " + v.hit.fields.join(", "));
      process.exit(7);
    }
    console.error("note: sending a POST to a path named like a write, on the strength of a recorded");
    console.error("      exception. " + v.hit.why);
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
    const scripts = await scriptsOf(r.text, 12);
    const md = report(page, r, scripts);
    if (out) {
      fs.appendFileSync(out, "\n\n" + md + "\n");
      console.log("appended to " + out);
    } else {
      console.log(md);
    }
  } catch (e) {
    /* "fetch failed" is undici saying a network error happened and nothing about which. The cause
       carries the code — ENOTFOUND, ECONNREFUSED, a certificate error — and that is the difference
       between "wrong address", "server down" and "self-signed certificate on an internal host". */
    const c = (e && e.cause) || {};
    console.error("failed: " + ((e && e.message) || e) +
      (c.code ? " (" + c.code + ")" : "") +
      (c.message && c.message !== (e && e.message) ? " — " + c.message : ""));
    if (/SELF_SIGNED|UNABLE_TO_VERIFY|CERT/.test(String(c.code))) {
      console.error("The host's certificate does not verify. That is normal for an internal server,");
      console.error("and it is not something this tool works around: a discovery run that ignores");
      console.error("certificates is a discovery run that cannot tell the server from anything else");
      console.error("on the network. Export the server's CA with NODE_EXTRA_CA_CERTS instead.");
    }
    process.exit(1);
  }
}

if (require.main === module) {
  main();
} else {
  module.exports = {
    isTest: isTest, classify: classify, looksLikeLogin: looksLikeLogin,
    WRITES: WRITES, LOADERS: LOADERS,
    verifiedRead: verifiedRead, VERIFIED_READS: VERIFIED_READS
  };
}
