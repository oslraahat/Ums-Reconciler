/* The two-server mode's wiring in app.js — the parts reconcile.js cannot answer for.
 *
 * compareServers() is guarded by tests/server-diff.js. What is left is the plumbing around it, and
 * every one of these has a way of going quietly wrong: a finding landing in the wrong tile, a
 * label that still says "Zero Pay" while the column under it counts extra rows, a URL built
 * against the Expected server when the Actual one was meant, or a bucket that stops counting as a
 * problem because the single-server rule leaked across.
 *
 *   node tests/server-mode.js
 */
"use strict";
const fs = require("fs");
const path = require("path");

const APP = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
const HTML = fs.readFileSync(path.join(__dirname, "..", "app.html"), "utf8");
const g = {};
new Function("self", fs.readFileSync(path.join(__dirname, "..", "reconcile.js"), "utf8"))(g);
const U = g.UMSREC;

let fail = 0;
const check = (name, ok, extra) => {
  if (!ok) fail++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (!ok && extra ? "   " + extra : ""));
};

/* lift a function out of app.js by name, brace-matched — the same trick manual-ok.js uses */
function src(name) {
  const at = APP.indexOf("function " + name + "(");
  if (at < 0) throw new Error("no such function: " + name);
  let depth = 0;
  for (let j = APP.indexOf("{", at); j < APP.length; j++) {
    if (APP[j] === "{") depth++;
    else if (APP[j] === "}") { depth--; if (!depth) return APP.slice(at, j + 1); }
  }
  throw new Error("unbalanced " + name);
}

/* ---- every finding lands in exactly one bucket, and the serious ones win ---- */
{
  const statusOfSrv = new Function(src("statusOfSrv") + "\nreturn statusOfSrv;")();
  const of = (kinds) => statusOfSrv({ result: { errors: kinds.map((k) => ({ kind: k })) } });

  check("identical → ok", of([]) === "ok", of([]));
  check("a changed amount → no", of(["srvcell"]) === "no", of(["srvcell"]));
  check("a changed word → no", of(["srvtext"]) === "no", of(["srvtext"]));
  check("a dropped column → no", of(["srvcol"]) === "no", of(["srvcol"]));
  check("a row missing on Actual → cw", of(["srvlost"]) === "cw", of(["srvlost"]));
  check("a row only on Actual → zero", of(["srvextra"]) === "zero", of(["srvextra"]));
  check("a page never read → nf", of(["srvside"]) === "nf", of(["srvside"]));

  /* the order matters: a student with several kinds gets filed under the worst one, because that
     is the one someone has to go and act on */
  check("unread page outranks everything", of(["srvside", "srvcell", "srvlost"]) === "nf");
  check("a missing row outranks a changed cell", of(["srvcell", "srvlost"]) === "cw");
  check("a changed cell outranks an extra row", of(["srvextra", "srvcell"]) === "no");
  /* nothing may fall through to "ok" just because a kind was not listed — a finding nobody
     recognised must still count as a difference */
  check("an unknown finding is never filed as identical", of(["srvsomethingnew"]) === "no");
}

/* ---- "zero" is clean on one server and a fault across two ---- */
{
  const notOk = new Function("srvMode",
    APP.match(/const notOk = function \(st\) \{[^\n]*\};/)[0] + "\nreturn notOk;");
  const single = notOk(false), pair = notOk(true);
  check("single-server: Zero Pay is not a problem", single("zero") === false);
  check("two-server: an extra row on Actual IS a problem", pair("zero") === true);
  check("both agree that identical is clean", single("ok") === false && pair("ok") === false);
  check("both agree that a difference is not", single("no") === true && pair("no") === true);
}

/* ---- the labels ---- */
{
  const t = new Function("DICT", "srvMode", "lang",
    APP.match(/function t\(k\) \{[^\n]*\}/)[0] + "\nreturn t;");
  const DICT = { t_zero: { bn: "Zero Pay", en: "Zero Pay" }, s_t_zero: { bn: "Actual-এ বাড়তি", en: "Extra on Actual" },
    t_ok: { bn: "মিলেছে", en: "Matched" } };
  check("two-server mode prefers the s_ twin", t(DICT, true, "en")("t_zero") === "Extra on Actual");
  check("single-server mode keeps the plain key", t(DICT, false, "en")("t_zero") === "Zero Pay");
  check("a key with no twin is unaffected by the mode", t(DICT, true, "en")("t_ok") === "Matched");

  /* every bucket a run can produce must have a two-server reading, or a tile would sit there
     saying "Zero Pay" over a column counting rows that only exist on Actual */
  ["t_ok", "t_no", "t_cw", "t_zero", "t_nf", "pill_ok", "pill_no", "pill_cw", "pill_zero",
    "pill_nf", "f_ok", "f_no", "f_cw", "f_zero", "f_nf", "tt_prob", "d_allmatch", "subtitle",
    "base_l"
  ].forEach(function (k) {
    check("s_" + k + " exists", new RegExp("\\bs_" + k + ": \\{ bn:").test(APP));
  });
  /* the app has an English mode — Bangla leaking into an en string is invisible until someone
     switches, and then it is on every tile at once */
  const bad = [];
  (APP.match(/\bs_\w+: \{ bn: "[^"]*", en: "([^"]*)" \}/g) || []).forEach(function (m) {
    const en = /en: "([^"]*)"/.exec(m)[1];
    if (/[ঀ-৿]/.test(en)) bad.push(en);
  });
  check("no Bangla in the English two-server labels", bad.length === 0, bad.join(" / "));
}

/* ---- URLs are built against the server that was asked for ---- */
{
  const api = new Function("baseUrl",
    src("payBase") + "\n" + src("pwUrl") + "\n" + src("cwUrl") +
    "\nreturn { pwUrl: pwUrl, cwUrl: cwUrl };")("https://ums-5.osl.team");
  check("no server named → Expected",
    api.pwUrl("1659665", "1977523").indexOf("https://ums-5.osl.team/Student/Payment/") === 0,
    api.pwUrl("1659665", "1977523"));
  check("Actual server honoured on Program Wise",
    api.pwUrl("1659665", "1977523", "https://ums-41.osl.team").indexOf("https://ums-41.osl.team/") === 0,
    api.pwUrl("1659665", "1977523", "https://ums-41.osl.team"));
  check("Actual server honoured on Course Wise",
    api.cwUrl("1659665", "1977523", "https://ums-41.osl.team").indexOf("https://ums-41.osl.team/") === 0);
  /* the query string is the student, and it must not change with the server — the whole point is
     asking two servers the same question */
  const q = (u) => u.slice(u.indexOf("?"));
  check("the same student is asked of both servers",
    q(api.pwUrl("1659665", "1977523")) === q(api.pwUrl("1659665", "1977523", "https://ums-41.osl.team")),
    q(api.pwUrl("1659665", "1977523")));
  check("a trailing slash on the address does not double up",
    api.pwUrl("1", "2", "https://ums-41.osl.team/").indexOf("team//") < 0,
    api.pwUrl("1", "2", "https://ums-41.osl.team/"));
}

/* ---- the page has the controls the code reaches for ---- */
{
  ["srvSw", "base2", "base2row", "conn2", "srvHint"].forEach(function (id) {
    check('app.html has #' + id, new RegExp('id="' + id + '"').test(HTML));
  });
  check("the second address starts hidden", /id="base2row"[^>]*display:none/.test(HTML));
  /* Beside the first, not under it: they hold the same kind of thing and the mode is about
     comparing them. The track gains a column with the field — without that the buttons land in the
     wrong one, or a hole opens where they should be. */
  check("the two addresses sit side by side",
    /\.connGrid\.two\{grid-template-columns:1fr 1fr auto auto\}/.test(HTML) &&
    /cg\.classList\.toggle\("two", srvMode\)/.test(APP), "app.html / app.js");
  check("…in that order in the markup, so the buttons stay on the end",
    HTML.indexOf('id="base"') < HTML.indexOf('id="base2row"') &&
    HTML.indexOf('id="base2row"') < HTML.indexOf('id="testConn"'), "app.html");
  /* a grid item will not shrink below its content without this, and a long URL would push the
     buttons off the edge of the card */
  check("…and either address may shrink", /\.connGrid > div\{min-width:0\}/.test(HTML), "app.html");
  /* The switch decides what the whole card is for, so it belongs in the header with the heading
     and the badges — under the address fields it explained them only after they were read. */
  check("the mode switch lives in the card header",
    /<div class="ch">(?:(?!<\/div>)[\s\S])*id="srvSw"/.test(HTML), "app.html");
  check("…pushed into the space on the right", /\.ch \.srvsw\{margin-left:auto/.test(HTML), "app.html");
  check("…and it shows when it is on", /\.srvsw\.on\{/.test(HTML) &&
    /parentNode\.classList\.toggle\("on", srvMode\)/.test(APP), "app.html / app.js");
  /* Look and placement are separate rules: the settings row uses the same toggle and must not
     inherit a margin that only makes sense beside a heading. */
  check("…and its look is not tied to the card header",
    /\n  \.srvsw\{display:inline-flex/.test(HTML) && /\.ch \.srvsw\{margin-left:auto\}/.test(HTML),
    "app.html");
  /* the knob follows :checked, so it cannot end up pointing the other way from the input it is
     drawn on — the one failure a hand-painted toggle actually has */
  check("the toggle draws itself from the checkbox's own state",
    /\.srvsw input:checked \+ \.tg\{/.test(HTML) &&
    /<input type="checkbox" id="srvSw"><i class="tg">/.test(HTML), "app.html");
  /* hidden with opacity, not display:none — display:none takes it out of the tab order and the
     switch stops being reachable from the keyboard */
  check("…and the checkbox stays focusable behind it",
    /\.srvsw input\{position:absolute;opacity:0/.test(HTML) &&
    /input:focus-visible \+ \.tg\{outline/.test(HTML), "app.html");
  check("app.js reads every one of them",
    ["srvSw", "base2", "base2row", "conn2", "srvHint"].every(function (id) {
      return APP.indexOf('"' + id + '"') >= 0;
    }));
  check("the mode is remembered between sessions",
    /chrome\.storage\.local\.set\(\{ srvMode: srvMode \}\)/.test(APP) &&
    /"baseUrl2", "srvMode"/.test(APP), "app.js");
  check("switching mode clears the finished run",
    /function setSrvMode\(v\) \{[\s\S]*?students = \[\];/.test(APP), "app.js");
  /* applySrvMode() ends by calling applyLang(), which repaints every data-i18n node. A label
     assigned by hand before that call is overwritten by it — the mode switch looked like it did
     nothing to the Base URL label. Every mode-dependent word goes through the s_ twin instead. */
  check("no label is written by hand around applyLang()",
    !/textContent = t\(srvMode \?/.test(APP),
    (APP.match(/textContent = t\(srvMode \?[^;]*/g) || []).join(" / "));
  /* a run needs a session on BOTH servers; one green badge would say it is ready when half of it
     cannot load a page */
  check("Test Connection checks both servers", /if \(srvMode\) await testOneConn\("conn2", baseUrl2\)/.test(APP), "app.js");
  /* two badges side by side have to say which server each is, or a red one sends you to the
     wrong place — and with one server there is nothing to disambiguate, so the tag stays off */
  check("each badge names its server, but only when there are two",
    /const tag = srvMode \? t\(p\[1\]\) \+ " · " : "";/.test(APP), "app.js");
  /* the badges used to carry data-i18n, so applyLang() repainted a tested badge back to
     "not checked" — the answer was on screen and a language switch threw it away */
  check("a language switch does not wipe a tested badge",
    !/id="conn2?"[^>]*data-i18n/.test(HTML) && /const connState = \{ conn: null, conn2: null \};/.test(APP),
    "app.html / app.js");
}

/* ---- end to end: two servers in, one report line out ---- */
{
  const HEAD = ["SL", "Date", "MRN", "CRN", "Income", "Consideration Amount", "Previous Due",
    "Deducted Amount", "Receivable", "Prev. Std. Discount", "Booking Discount", "Special Discount",
    "Received", "Cash Back", "Current Due"];
  const ROW = ["1", "01/01/2025", "111", "-", "17,000", "-", "-", "-", "17,000", "-", "-", "-",
    "10,000", "-", "7,000"];
  const td = (v) => ({ textContent: v, getAttribute: () => null });
  const mk = (rows) => U.parseTable({
    querySelectorAll: (s) => (s === "tr" ? [{ querySelectorAll: () => HEAD.map(td) }]
      .concat(rows.map((r) => ({ querySelectorAll: () => r.map(td) }))) : []),
    querySelector: () => null
  }, "pw");
  const empty = { ok: true, rows: [], header: [], cols: {}, totalRow: null, noData: true };

  const exp = { pw: mk([ROW]), cw: empty };
  const act = { pw: mk([ROW.slice(0, 12).concat(["8,000", "-", "9,000"])]), cw: empty };
  const r = U.compareServers(exp, act, { tolerance: 0 });
  const statusOfSrv = new Function(src("statusOfSrv") + "\nreturn statusOfSrv;")();

  check("a real difference reaches the mismatch bucket", statusOfSrv({ result: r }) === "no");
  const line = U.summaryServers(r);
  check("the one-line summary names both servers' figures",
    /Expected 10,000/.test(line) && /Actual 8,000/.test(line), line);
  check("…and says how many more there are", /আরও/.test(line), line);
  check("an unchanged Course Wise on both sides raises nothing",
    r.errors.every(function (e) { return e.side === "Program Wise"; }),
    r.errors.map(function (e) { return e.side; }).join(","));

  const same = U.compareServers(exp, { pw: mk([ROW]), cw: empty }, { tolerance: 0 });
  check("identical servers reach the clean bucket", statusOfSrv({ result: same }) === "ok");
}

console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
process.exit(fail ? 1 : 0);
