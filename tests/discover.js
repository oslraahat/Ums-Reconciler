/* tools/discover.js refuses what it is supposed to refuse.
 *
 *   node tests/discover.js
 *
 * The discovery tool's value is not what it reads — it is what it will not do. It maps admission
 * pages on a live server, so it is one typo away from a real record on a real one.
 *
 * The first version of this test ran the tool. That was the wrong shape, and running it proved why:
 * with the loader guard broken on purpose, to check the test would notice, the tool went on and
 * POSTed to /Student/Admission/NewStudentAdmission on ums-4 — the exact irreversible action the
 * guard exists to prevent. A test for a refusal must not depend on the refusal working.
 *
 * So the decisions are asked directly. tools/discover.js required rather than run exports them and
 * does nothing else: no argument parsing, no gate, no request. Nothing in this file can reach the
 * network, which is the point rather than a convenience.
 *
 * Two refusals are also checked end to end, by exit code — but only the two that happen before the
 * cookie is even read, so a broken guard still cannot send anything.
 */
const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");
const TOOL = path.join(__dirname, "..", "tools", "discover.js");
const D = require(TOOL);

let fail = 0;
const check = function (name, ok, extra) {
  if (!ok) fail++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (!ok && extra !== undefined ? "   " + extra : ""));
};

// ---- the host gate ----
/* A substring test is the classic way to get this wrong, and it is wrong in both directions: it
   passes a host that merely contains the right letters, and the cookie goes with the request. */
[
  ["https://ums-3.umsbd.net", "a production host"],
  ["https://ums-3.orgbd.net", "the other production host"],
  ["http://ums-4.osl.team", "plain http, where the cookie would travel in the clear"],
  ["https://osl.team.example.com", "a host that merely CONTAINS osl.team"],
  ["https://notosl.team", "a host ending in the right letters but a different domain"],
  ["https://osl.team.co", "the domain with something appended"],
  ["ums-4.osl.team", "no scheme at all"],
  ["", "nothing"]
].forEach(function (c) {
  check("the gate rejects " + c[1] + ": " + (c[0] || "(empty)"), D.isTest(c[0]) === false);
});
[
  "https://ums-4.osl.team",
  "https://ums-3.osl.team",
  "https://qa.osl.team"
].forEach(function (u) {
  // and it must accept the test servers, or it rejects everything and proves nothing
  check("the gate accepts the test server " + u, D.isTest(u) === true);
});

// ---- only a loader may be asked a question ----
/* Everything that creates, changes, cancels, migrates or takes money is named here. If classify()
   calls one of these a loader, askLoader() would send it. */
[
  "/Student/Admission/NewStudentAdmission",
  "/Student/Admission/NewAdmission",
  "/Student/CancelCourse/CancelCourseOrSubject",
  "/Student/FranchisorTransaction/Create",
  "/Student/FranchisorPercentSettings/Create",
  "/Student/Payment/CourseWisePayment",
  "/Student/Program/Migrate",
  "/Student/Course/AddCourse",
  "/Student/Payment/SavePayment",
  "/Student/Something/Delete",
  "/Student/Something/UpdateStudent",
  "/Student/Something/ApproveDiscount"
].forEach(function (p) {
  check("classified as a write, so never sent: " + p, D.classify(p) === "WRITE");
});
[
  "/Administration/CommonAjax/LoadProgram",
  "/Administration/CommonAjax/LoadSession",
  "/Student/Admission/GetSessionByProgram",
  "/Student/Admission/GetBranchByProgramSession",
  "/Student/FranchisorCalculation/CourseWiseDataTable",
  "/Student/FranchiseeCalculation/CourseWiseCalculationData"
].forEach(function (p) {
  check("classified as a loader, so askable: " + p, D.classify(p) === "loader");
});

/* The dangerous middle: a path that is neither obviously a loader nor obviously a write must not
   fall through to "askable". Anything unrecognised is refused, because askLoader() only proceeds on
   "loader" — so the default has to be something else. */
["/Student/Mystery/DoThing", "/Student/Report/Whatever"].forEach(function (p) {
  check("an unrecognised path is not treated as a loader: " + p, D.classify(p) !== "loader");
});

/* ---- the verified-read exceptions ----
   A few controllers answer a LOOKUP on a path whose name says it writes. The refusal pattern stays
   as it is and each exception is listed instead, so the question for a test is not "does the list
   work" but "can the list be widened without anyone meaning to". */
{
  const src = fs.readFileSync(TOOL, "utf8");
  const block = src.slice(src.indexOf("const VERIFIED_READS"), src.indexOf("function verifiedRead"));
  const entries = (block.match(/path:\s*"([^"]+)"/g) || []).map(s => s.replace(/path:\s*"|"/g, ""));

  check("the exceptions are a list of named paths, not a looser pattern",
    entries.length > 0 && !/VERIFIED_READS\s*=\s*\//.test(src), entries.join(", "));
  check("every exception is still classified a WRITE by the pattern",
    entries.every(p => D.classify(p) === "WRITE"), entries.filter(p => D.classify(p) !== "WRITE").join(", "));
  check("every exception names the fields it may be sent",
    (block.match(/fields:\s*\[/g) || []).length === entries.length);
  check("every exception records why it only reads",
    (block.match(/why:/g) || []).length === entries.length);
  /* The point of the whole arrangement: nothing is sent on the strength of a list entry alone. */
  check("an exception still needs --allow-verified-read on the command line",
    /if \(!allowVerified\) \{/.test(src) && /--allow-verified-read was not given/.test(src));
  check("an extra field voids the exception",
    /A lookup given fields it does/.test(src) && /extra\.length/.test(src));
  check("the tool says so on stderr every time it uses one",
    /sending a POST to a path named like a write/.test(src));

  /* Asked, not run. I wrote these three as exit-code tests first, and breaking each guard to check
     the test noticed showed the tool going on to make the request — including a POST to
     /Student/Admission/NewStudentAdmission. The same trap this file was rewritten to avoid, walked
     into again by three new checks. A refusal is asked of the function that decides it. */
  check("a listed path is recognised when sent exactly its own fields",
    (D.verifiedRead("/Student/StudentTransfer/Create", "stdRollOrRegistrationNo=1") || {}).extra
      ? D.verifiedRead("/Student/StudentTransfer/Create", "stdRollOrRegistrationNo=1").extra.length === 0
      : false);
  check("an extra field is reported, so the caller can refuse it",
    (D.verifiedRead("/Student/StudentTransfer/Create", "stdRollOrRegistrationNo=1&amount=500") || {})
      .extra.join(",") === "amount");
  check("a path that is not listed gets no exception at all",
    D.verifiedRead("/Student/Admission/NewStudentAdmission", "x=1") === null);
  check("…nor does a path that merely looks similar",
    D.verifiedRead("/Student/StudentTransfer/CreateTransfer", "stdRollOrRegistrationNo=1") === null);
  check("every listed path appears in the exported list, so the list is the only way in",
    D.VERIFIED_READS.every(v => entries.indexOf(v.path) >= 0) &&
    D.VERIFIED_READS.length === entries.length);
}

// ---- a password is reported, never filled or sent ----
{
  const src = fs.readFileSync(TOOL, "utf8");
  check("a password parameter is refused before any request",
    /if \(\/password\/i\.test\(qs\)\)/.test(src) && /refused: a password is never sent/.test(src));
  check("a password input is reported and not filled",
    /Password fields/.test(src) && /NOT filled/.test(src));
  check("passwords are excluded from the field table",
    /t !== "password"/.test(src));
}

// ---- the cookie ----
{
  const src = fs.readFileSync(TOOL, "utf8");
  const body = src.replace(/^[\s\S]*?\*\//, "");   // past the usage comment
  check("the cookie is read from the environment, not an argument",
    /process\.env\.UMS_COOKIE/.test(src) && !/--cookie/.test(body));
  /* `cookie` is the value; UMS_COOKIE is only its name, and "session cookie" in an error message is
     prose. Only the value being printed matters, so the variable's own use is what is looked for. */
  check("the cookie value is never printed",
    !/console\.\w+\(\s*cookie\b/.test(src) &&
    !/console\.\w+\([^)]*\+\s*cookie\b/.test(src) &&
    !/console\.\w+\([^)]*\$\{\s*cookie\s*\}/.test(src));
}

// ---- a login page is not mistaken for an answer ----
check("a redirect to login is recognised",
  D.looksLikeLogin({ redirect: "/Account/Login?ReturnUrl=%2F", text: "" }) === true);
check("a login form served with HTTP 200 is recognised",
  D.looksLikeLogin({ redirect: "", text: '<input type="password" name="Password"> Sign in' }) === true);
check("an ordinary page is not mistaken for login",
  D.looksLikeLogin({ redirect: "", text: "<select id=ProgramId></select>" }) === false);

/* ---- required must mean required, not run ----
   If this file ever starts parsing arguments or exiting on require, every check above becomes a
   check on whatever the test runner's argv happened to be. */
{
  const src = fs.readFileSync(TOOL, "utf8");
  check("the command line runs only when the file is the entry point",
    /if \(require\.main === module\) \{\s*\n\s*main\(\);/.test(src));
  check("the gate and the cookie are read inside main\\(\\), not at load",
    /async function main\(\)[\s\S]*?if \(!isTest\(base\)\)[\s\S]*?UMS_COOKIE/.test(src));
}

// ---- end to end, but only where no request is possible ----
/* Both of these exit before the cookie is read, so even with every guard broken there is nothing to
   send. The write-endpoint and password refusals are NOT tested this way, on purpose: if those
   guards were broken, running the tool is exactly what would do the damage. */
function run(args, env) {
  try {
    const stdout = execFileSync(process.execPath, [TOOL].concat(args), {
      env: Object.assign({}, process.env, { UMS_COOKIE: "" }, env || {}),
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20000
    });
    return { code: 0, out: stdout, err: "" };
  } catch (e) {
    return { code: e.status === undefined ? -1 : e.status, out: String(e.stdout || ""), err: String(e.stderr || "") };
  }
}
{
  const r = run(["--base", "https://ums-3.umsbd.net", "--page", "/Student/Admission/NewAdmission"]);
  check("running it against a production host exits 2 and says why",
    r.code === 2 && /refused/i.test(r.err), "exit=" + r.code + " " + r.err.slice(0, 80));
}
{
  const r = run(["--base", "https://ums-4.osl.team", "--page", "/Student/Admission/NewAdmission"],
    { UMS_COOKIE: "" });
  check("running it with no cookie exits 3 and asks for one",
    r.code === 3 && /UMS_COOKIE/.test(r.err), "exit=" + r.code + " " + r.err.slice(0, 80));
}

console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
process.exit(fail ? 1 : 0);
