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
  return new Function("conc", "srvMode", "connProto", "HOST_LIMIT_H1", "pagesPerHost",
    src("realConc") + "\nreturn realConc();")(conc, srvMode, { conn: p1, conn2: p2 },
    constOf("HOST_LIMIT_H1"), pagesPerHost);
}
const pagesPerHost = new Function(src("pagesPerHost") + "\nreturn pagesPerHost;")();
const pagesPerStudent = (srv) => new Function("srvMode",
  src("pagesPerStudent") + "\nreturn pagesPerStudent();")(srv);

check("the six is the browser's, and it is written down once",
  constOf("HOST_LIMIT_H1") === 6, "HOST_LIMIT_H1=" + constOf("HOST_LIMIT_H1"));

/* One student is two page loads — Program Wise and Course Wise, fetched together — and in
   two-server mode that pair goes to both servers at once. The box is set in students, so every
   number derived from it has to be divided or multiplied by this and nothing here may forget it. */
check("a student costs two pages on one server", pagesPerStudent(false) === 2,
  String(pagesPerStudent(false)));
check("…and four across two", pagesPerStudent(true) === 4, String(pagesPerStudent(true)));
check("…of which each host sees two", pagesPerHost() === 2, String(pagesPerHost()));

/* ---------- one server ---------- */
check("nothing is claimed before the connection is tested",
  ceiling(25, false, "", "") === null, String(ceiling(25, false, "", "")));
/* six connections, two pages each: three students, not six — the old answer counted a student as
   a request and so promised twice the run that was possible */
check("on HTTP/1.1, 25 students is really 3", ceiling(25, false, "http/1.1", "") === 3,
  String(ceiling(25, false, "http/1.1", "")));
check("…and 2 is really 2 — the browser is not the limit there",
  ceiling(2, false, "http/1.1", "") === 2, String(ceiling(2, false, "http/1.1", "")));
check("on HTTP/2 the setting means what it says",
  ceiling(25, false, "h2", "") === 25, String(ceiling(25, false, "h2", "")));
check("…and on HTTP/3 too", ceiling(300, false, "h3", "") === 300,
  String(ceiling(300, false, "h3", "")));

/* ---------- two servers are two hosts, but one student needs both of them ---------- */
/* The pools do not add up: a student is not finished until both halves are, so the run goes at
   the rate of whichever host allows fewer. Adding them said twelve where the truth is three. */
check("two HTTP/1.1 servers give three, not twelve",
  ceiling(25, true, "http/1.1", "http/1.1") === 3, String(ceiling(25, true, "http/1.1", "http/1.1")));
check("…and one of each is bounded by the slow half, not freed by the fast one",
  ceiling(25, true, "http/1.1", "h2") === 3, String(ceiling(25, true, "http/1.1", "h2")));
check("…while two fast ones are not bounded at all",
  ceiling(25, true, "h2", "h2") === 25, String(ceiling(25, true, "h2", "h2")));
/* the second server's protocol is only consulted when there IS a second server */
check("in one-server mode the second server is not counted",
  ceiling(25, false, "http/1.1", "h2") === 3, String(ceiling(25, false, "http/1.1", "h2")));
/* it is a ceiling, never a floor: one student at a time is always allowed */
check("…and it never falls below one", ceiling(1, false, "http/1.1", "") === 1,
  String(ceiling(1, false, "http/1.1", "")));

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
  const both = (k) => new RegExp(k + ': \\{ bn: "[^"]+",\\s*\\n?\\s*en: "[^"]+" \\}').test(APP);
  check("both readings are said in both languages",
    both("conc_real") && both("conc_capped") && both("conc_why_capped") && both("conc_many_pc"),
    ["conc_real", "conc_capped", "conc_why_capped", "conc_many_pc"]
      .filter((k) => !both(k)).join(", ") || "DICT");

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
  /* ---------- and what the line actually reads ----------
     The arithmetic above is only worth anything if the sentence on screen carries it. This is the
     case that prompted the change: five in the box, two servers, and four machines pointed at the
     same UMS — the number that decides whether the server stays up is 80, and it appeared nowhere. */
  {
    const DICT = new Function("return " + (/const DICT = \{[\s\S]*?\n  \};/.exec(APP) || [""])[0]
      .replace(/^const DICT = /, "").replace(/;$/, ""))();
    const paint = (conc, srvMode, proto, lang) => {
      const el = { textContent: "", title: "", className: "" };
      new Function("conc", "srvMode", "connProto", "HOST_LIMIT_H1", "lang", "$", "t",
        src("pagesPerStudent") + src("pagesPerHost") + src("realConc") + src("paintConc") +
        "\npaintConc();")(conc, srvMode, { conn: proto, conn2: proto }, constOf("HOST_LIMIT_H1"),
        lang, (id) => (id === "concNote" ? el : null),
        (k) => (DICT[k] ? DICT[k][lang] || DICT[k].en : k));
      return el;
    };
    const bn = paint(5, true, "h2", "bn");
    check("five students, two servers: the line says twenty requests",
      /৫/.test(bn.textContent) && /২০/.test(bn.textContent), bn.textContent);
    const en = paint(5, true, "h2", "en");
    check("…and says it in English too", /5 students/.test(en.textContent) && /20 requests/.test(en.textContent),
      en.textContent);
    check("…while one server is half of that",
      /10 requests/.test(paint(5, false, "h2", "en").textContent),
      paint(5, false, "h2", "en").textContent);
    /* the tool cannot see the other machines, so it says what four of them would come to */
    check("…and the tooltip warns that several PCs add up",
      /80/.test(en.title), en.title);
    /* a capped line still has to carry both units, or the warning loses the number it is about */
    const cap = paint(25, false, "http/1.1", "en");
    check("a capped line names students and requests",
      /3 students/.test(cap.textContent) && /not 25/.test(cap.textContent) && /6 requests/.test(cap.textContent),
      cap.textContent);
  }

  check("…and no tooltip claims a protocol the server did not speak",
    !/conc_why_room: \{ bn: "[^"]*HTTP\/2/.test(APP) &&
    !/conc_why_capped: \{ bn: "[^"]*HTTP\/2/.test(APP), "conc_why_room / conc_why_capped");
}

console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
process.exit(fail ? 1 : 0);
