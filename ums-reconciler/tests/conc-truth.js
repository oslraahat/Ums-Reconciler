/* "একসাথে কয়টি অনুরোধ: 25" was telling people something that may not be true.
 *
 * The run fires `conc` fetches at once, but the browser decides how many leave the machine. Over
 * HTTP/1.1 Chrome holds six connections per host and queues the rest — measured, not assumed:
 * fifty simultaneous fetches to an HTTP/1.1 host arrived six at a time. Over HTTP/2 they are
 * multiplexed down one connection and the setting means what it says. So a run set to 25 against
 * an HTTP/1.1 server has 25 outstanding and six on the wire, and raising the number does nothing
 * at all — while every estimate of "how long will 100,000 take" is built on it.
 *
 * The tool now reads the protocol off the connection test and says which it is. This checks the
 * arithmetic, and — the part that matters most — that the answer is only ever displayed. If it
 * ever fed back into the run, a wrong reading would change what gets checked.
 *
 *   node tests/conc-truth.js
 */
"use strict";
const fs = require("fs");
const path = require("path");

const APP = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

let fail = 0;
const check = (name, ok, extra) => {
  if (!ok) fail++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (!ok && extra !== undefined ? "   " + extra : ""));
};

function src(name) {
  let at = APP.indexOf("function " + name + "(");
  if (at < 0) throw new Error("no such function: " + name);
  if (APP.slice(at - 6, at) === "async ") at -= 6;
  let depth = 0;
  for (let j = APP.indexOf("{", at); j < APP.length; j++) {
    if (APP[j] === "{") depth++;
    else if (APP[j] === "}") { depth--; if (!depth) return APP.slice(at, j + 1); }
  }
  throw new Error("unbalanced " + name);
}
const constOf = (n) => +(new RegExp("const " + n + " = (\\d+);").exec(APP) || [])[1];

/* realConc() reads conc, srvMode and the two protocols; the harness supplies them */
function ceiling(conc, srvMode, p1, p2) {
  return new Function("conc", "srvMode", "connProto", "HOST_LIMIT_H1",
    src("realConc") + "\nreturn realConc();")(conc, srvMode, { conn: p1, conn2: p2 },
    constOf("HOST_LIMIT_H1"));
}

check("the six is the browser's, and it is written down once",
  constOf("HOST_LIMIT_H1") === 6, "HOST_LIMIT_H1=" + constOf("HOST_LIMIT_H1"));

/* ---------- one server ---------- */
check("nothing is claimed before the connection is tested",
  ceiling(25, false, "", "") === null, String(ceiling(25, false, "", "")));
check("on HTTP/1.1, 25 is really 6", ceiling(25, false, "http/1.1", "") === 6,
  String(ceiling(25, false, "http/1.1", "")));
check("…and 4 is really 4 — the browser is not the limit there",
  ceiling(4, false, "http/1.1", "") === 4, String(ceiling(4, false, "http/1.1", "")));
check("on HTTP/2 the setting means what it says",
  ceiling(25, false, "h2", "") === 25, String(ceiling(25, false, "h2", "")));
check("…and on HTTP/3 too", ceiling(300, false, "h3", "") === 300,
  String(ceiling(300, false, "h3", "")));

/* ---------- two servers are two hosts, so two connection pools ---------- */
check("two HTTP/1.1 servers give twelve, not six",
  ceiling(25, true, "http/1.1", "http/1.1") === 12, String(ceiling(25, true, "http/1.1", "http/1.1")));
check("…and one of each is still bounded by the slow half's six",
  ceiling(25, true, "http/1.1", "h2") === 25, String(ceiling(25, true, "http/1.1", "h2")));
/* the second server's protocol is only consulted when there IS a second server */
check("in one-server mode the second server is not counted",
  ceiling(25, false, "http/1.1", "h2") === 6, String(ceiling(25, false, "http/1.1", "h2")));

/* ---------- and it never touches the run ---------- */
{
  /* This is the whole safety argument. realConc() is a sentence on the screen; if it ever reached
     the worker count, a misread protocol would silently change how the run is carried out. */
  const users = [];
  APP.split("\n").forEach(function (ln, i) {
    if (/realConc\s*\(/.test(ln) && !/function realConc/.test(ln)) users.push((i + 1) + ": " + ln.trim());
  });
  check("realConc() is read in exactly one place", users.length === 1, users.join(" | "));
  check("…and that place is the note under the box, not the run",
    users.length === 1 && /const real = realConc\(\);/.test(users[0]) &&
    src("paintConc").indexOf("realConc()") >= 0, users.join(" | "));
  /* the run's width comes from conc and pace(), and from nothing else */
  const run = src("startRun");
  check("the number of workers still comes from the user's setting alone",
    /const workers = Math\.min\(Math\.max\(1, conc\), students\.length\);/.test(run) &&
    run.indexOf("realConc") < 0 && run.indexOf("HOST_LIMIT") < 0, "startRun");
  check("…and no protocol reading reaches the fetch path",
    src("fetchHtml").indexOf("Proto") < 0 && src("fetchHtml").indexOf("HOST_LIMIT") < 0, "fetchHtml");
}

/* ---------- the note keeps up with what it describes ---------- */
{
  check("changing the number repaints the note", /this\.value = conc; paintConc\(\);/.test(APP), "app.js");
  check("switching mode repaints it too — two servers, two pools",
    src("applySrvMode").indexOf("paintConc()") >= 0, "applySrvMode");
  check("testing the connection repaints it", src("testConn").indexOf("paintConc()") >= 0, "testConn");
  /* a failed test must not leave a stale verdict standing next to a red badge */
  check("a re-test clears the old protocol before asking again",
    /connState\[badge\] = "busy"; connProto\[badge\] = "";/.test(APP), "testOneConn");
  check("both readings are said in both languages",
    /conc_real: \{ bn: "[^"]+", en: "[^"]+" \}/.test(APP) &&
    /conc_capped: \{ bn: "[^"]+", en: "[^"]+" \}/.test(APP) &&
    /conc_why_capped: \{ bn: "[^"]+", en: "[^"]+" \}/.test(APP), "DICT");

  /* The line has to name WHICH number, in the units the box above is set in. "all of them count"
     named nothing a reader could point at — someone asked what it meant, which settles it. */
  check("the note names the number rather than saying \"all of them\"",
    /conc_real: \{ bn: "[^"]*\{n\}[^"]*"/.test(APP) &&
    /conc_capped: \{ bn: "[^"]*\{n\}[^"]*\{c\}[^"]*"/.test(APP), "conc_real / conc_capped");
  /* …and in Bengali numerals, like every other number the page prints */
  check("…in the same numerals as the rest of the page",
    /lang === "bn" \? Number\(v\)\.toLocaleString\("bn-BD"\)/.test(src("paintConc")), "paintConc");
  /* A ✓ has two reasons behind it and they lead to opposite advice: on HTTP/2 raising the number
     is worth trying, on HTTP/1.1 with room still left it is worth nothing past six. One tooltip
     for both would have to be false in one of them — it was, and it is the sentence someone reads
     before deciding whether to raise it. */
  check("the reason under a ✓ depends on the protocol, not on the verdict",
    /conc_why_h2: \{ bn: "[^"]+", en: "[^"]+" \}/.test(APP) &&
    /conc_why_room: \{ bn: "[^"]+", en: "[^"]+" \}/.test(APP) &&
    /"conc_why_h2" : "conc_why_room"/.test(src("paintConc")), "paintConc");
  check("…and no tooltip claims a protocol the server did not speak",
    !/conc_why_room: \{ bn: "[^"]*HTTP\/2/.test(APP) &&
    !/conc_why_capped: \{ bn: "[^"]*HTTP\/2/.test(APP), "conc_why_room / conc_why_capped");
}

console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
process.exit(fail ? 1 : 0);
