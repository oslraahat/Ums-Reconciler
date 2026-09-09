/* A server that has stopped producing pages is not a page that is still being built.
 *
 * fetchTables() will not accept a Course Wise page with no table in it — a half-built page is not
 * an answer, and a real one is usually a moment away, so it asks again: up to CW_TRIES times, with
 * a pause that doubles. 0.8 + 1.6 + 3.2 + 6.4 + 12.8 seconds of waiting, and five more requests.
 *
 * That is right when the server is answering and this one page is late. It is wrong when the
 * server is not answering at all — when it gave no Program Wise table for this student either. The
 * two blanks then have one cause (the session, the permission, or a student this server does not
 * hold) and no amount of asking for the other page will change it. Every student walked the whole
 * ladder anyway, at the moment the server was least able to serve them, and sweepUnanswered() then
 * took each of them round again.
 *
 * Measured through the real page, ten students, one side blind: 354 seconds and 36 requests each,
 * against 0.2 seconds and 4 when both answer. With the guard, 12.9 seconds and 16.
 *
 * The single-server path has always had this: testOne() returns the moment Program Wise comes back
 * without a table and never opens the loop. This is the two-server path catching up.
 *
 * Parsing is stubbed here — a page either holds a table or does not, which is the only distinction
 * the retry decision turns on. The control flow is the real one.
 *
 *   node tests/one-side-blind.js
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
  let d = 0;
  for (let j = APP.indexOf("{", at); j < APP.length; j++) {
    if (APP[j] === "{") d++;
    else if (APP[j] === "}") { d--; if (!d) return APP.slice(at, j + 1); }
  }
  throw new Error("unbalanced " + name);
}
const CW_TRIES = +(/const CW_TRIES = (\d+);/.exec(APP) || [])[1];

/* One server, answering however the case says. Requests are counted, and the pauses are counted
   rather than taken — what is on trial is how many times it asks, not how long node sleeps. */
function ask(pwHasTable, cwHasTable) {
  const calls = { pw: 0, cw: 0 };
  const pauses = [];
  const fetchHtml = function (url) {
    const isCw = /CourseWise/.test(url);
    calls[isCw ? "cw" : "pw"]++;
    return Promise.resolve({ ok: true, status: 200, redirected: false,
      html: (isCw ? cwHasTable : pwHasTable) ? "<table>rows</table>" : "<div>no table here</div>" });
  };
  const made = new Function("fetchHtml", "pwUrl", "cwUrl", "parseFrag", "sliceTable", "scrape",
    "CW_TRIES", "backoff",
    src("cwSettled") + src("fetchTables") + "\nreturn fetchTables;")(
    fetchHtml,
    (reg, spid, base) => base + "/ProgramWise?reg=" + reg,
    (reg, spid, base) => base + "/CourseWise?reg=" + reg,
    (frag) => frag,                                   // the fragment IS the table, or null
    (html) => (/<table>/.test(html) ? html : null),
    /* U.parseTable() of nothing is "nothing was read" — the distinction the whole retry decision
       turns on, and the one thing the stub must not flatten */
    (table) => (table ? { ok: true, rows: [{ a: 1 }], noData: false } : { ok: false, rows: [] }),
    CW_TRIES,
    (n) => { pauses.push(n); return Promise.resolve(); });
  return made("https://s.test", "1956022", "7345470")
    .then((out) => ({ out: out, calls: calls, pauses: pauses,
      total: calls.pw + calls.cw }));
}

(async function () {
  check("CW_TRIES is the ladder's length, and it is a long one", CW_TRIES >= 4, String(CW_TRIES));

  /* ---- the server is answering ---- */
  {
    const r = await ask(true, true);
    check("a server that answers is asked twice and no more", r.total === 2,
      r.calls.pw + " program + " + r.calls.cw + " course");
    check("…and nothing is waited for", r.pauses.length === 0, r.pauses.join(","));
    check("…and both tables come back", r.out.pw.ok && r.out.cw.ok, JSON.stringify(r.out));
  }

  /* ---- the server is answering, but Course Wise is not built yet ----
     This is what the ladder is FOR, and it must survive the fix untouched. */
  {
    const r = await ask(true, false);
    check("a late Course Wise page is asked for again, the whole ladder",
      r.calls.cw === CW_TRIES, r.calls.cw + " of " + CW_TRIES);
    check("…with a pause before each retry", r.pauses.length === CW_TRIES - 1, r.pauses.join(","));
    check("…and the Program Wise side is still reported", r.out.pw.ok === true, JSON.stringify(r.out.pw));
    check("…while Course Wise is reported as unread, not as empty",
      r.out.cw.ok === false, JSON.stringify(r.out.cw));
  }

  /* ---- the server is not answering at all ---- */
  {
    const r = await ask(false, false);
    check("a server with no Program Wise table is not asked five more times",
      r.calls.cw === 1, r.calls.cw + " course requests");
    check("…so the student costs two requests, not " + (1 + CW_TRIES), r.total === 2, r.total);
    check("…and nothing is waited for", r.pauses.length === 0,
      r.pauses.length + " pauses totalling " + r.pauses.reduce((a, b) => a + b, 0));
    /* the verdict is unchanged — both sides unread, which compareServers() reports as its own
       finding rather than as a difference between the servers */
    check("…and both sides are still reported as unread",
      r.out.pw.ok === false && r.out.cw.ok === false, JSON.stringify(r.out));
  }

  /* ---- and the case in between: no Program Wise, but Course Wise is there ---- */
  {
    const r = await ask(false, true);
    check("a Course Wise page that arrived is not asked for again", r.calls.cw === 1, r.calls.cw);
    check("…and it is reported, even with no Program Wise beside it",
      r.out.cw.ok === true && r.out.pw.ok === false, JSON.stringify(r.out));
  }

  /* ---- the same rule, stated once, in the path that has always had it ---- */
  check("the single-server path returns before its loop when Program Wise is blank",
    /if \(!pw \|\| !pw\.ok \|\| !pw\.rows\.length\) \{[\s\S]{0,120}return \{ kind: "error"/.test(src("testOne")),
    "testOne");

  console.log(fail ? "\n" + fail + " FAILED" : "\nall good");
  process.exit(fail ? 1 : 0);
})();
