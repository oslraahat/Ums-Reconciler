/* Function Check — the pass/fail brain (fnClassify).
 *
 * The crawl opens every menu/sub-menu page and this decides healthy vs broken. It must FAIL on an
 * HTTP error, a redirect to the login page, a .NET/UMS error page, or a blank page — and PASS a
 * normal page, without being fooled by the mere word "error" in a label. parseNav needs a real DOM
 * (DOMParser), so it is exercised live; this pins the classifier, which is pure.
 *
 *   node tests/fn-check.js
 */
"use strict";
const fs = require("fs");
const path = require("path");

const self = { APP: {} };
new Function("self", fs.readFileSync(path.join(__dirname, "..", "menus", "fn", "fn.js"), "utf8"))(self);
const U = self.APP.fn;

let fail = 0;
const check = (name, ok, extra) => { if (!ok) fail++; console.log((ok ? "PASS  " : "FAIL  ") + name + (!ok && extra !== undefined ? "   " + extra : "")); };
const BASE = "https://ums-4.osl.team/";
const cl = (res) => U.classify(res, BASE);

/* ---- healthy pages pass ---- */
{
  const r = cl({ status: 200, redirected: false, html: "<html><body><h2>Payment History</h2><table><tr><td>x</td></tr></table></body></html>", finalUrl: BASE + "Student/Payment/PaymentHistory" });
  check("a normal page with a table → Pass", r.pass, r.reason);
}
{
  // a page whose only 'error' is a column label / help text must not be condemned
  const r = cl({ status: 200, redirected: false, html: "<html><body><form><label>Error Margin</label><input><select><option>A</option></select></form></body></html>" });
  check("the word 'error' in a label alone → still Pass", r.pass, r.reason);
}

/* ---- HTTP errors fail ---- */
{
  check("HTTP 500 → Fail", cl({ status: 500, html: "oops" }).pass === false);
  check("HTTP 404 → Fail", cl({ status: 404, html: "" }).pass === false);
  check("HTTP 403 → Fail", cl({ status: 403, html: "" }).pass === false);
  const r = cl({ status: 502, html: "" });
  check("…and the reason names the status", /502/.test(r.reason), r.reason);
}

/* ---- a redirect to the login page fails ---- */
{
  const r = cl({ status: 200, redirected: true, html: "<html><body><form action='/Account/Login'>sign in</form></body></html>", finalUrl: BASE + "Account/Login?ReturnUrl=%2fStudent" });
  check("redirect to the login page → Fail", r.pass === false && r.kind === "login", r.reason);
}

/* ---- a .NET / UMS error page fails even at HTTP 200 ---- */
{
  const ysod = "<html><body><h1>Server Error in '/' Application.</h1><h2>Exception Details: System.NullReferenceException</h2><b>Stack Trace:</b></body></html>";
  const r = cl({ status: 200, redirected: false, html: ysod, finalUrl: BASE + "Student/Foo" });
  check("ASP.NET yellow-screen-of-death → Fail", r.pass === false && r.kind === "page", r.reason);
}
{
  const r = cl({ status: 200, html: "<html><body><h2>IIS detail</h2><p>Parser Error Message: could not load type 'Foo'</p></body></html>" });
  check("ASP.NET parser/'could not load type' error → Fail", r.pass === false, r.reason);
}

/* ---- false-positive guards: generic phrases HIDDEN in a healthy page must NOT fail ----
   reg: /Student/NextPaymentDateSettings/Index opens fine, but its markup carries a hidden toast
   template "Something went wrong" — matching that in raw HTML wrongly condemned a working page. */
{
  const page = "<html><body><h2>Next Payment Date Settings</h2><table><tr><td>row</td></tr></table>" +
    "<div class='toast' style='display:none'>Something went wrong</div>" +
    "<div class='validation-summary-errors' style='display:none'><ul></ul></div>" +
    "<script>var m='An error occurred'; function fail(){alert('Something went wrong');}</script></body></html>";
  const r = cl({ status: 200, redirected: false, html: page, finalUrl: BASE + "Student/NextPaymentDateSettings/Index" });
  check("hidden 'Something went wrong' toast on a working page → Pass (not a false fail)", r.pass, r.reason);
}
{
  const r = cl({ status: 200, html: "<html><body><h3>Report</h3><div class='validation-summary-errors'></div><form><input></form></body></html>" });
  check("an EMPTY validation-summary-errors div → Pass", r.pass, r.reason);
}
{
  const r = cl({ status: 200, html: "<html><body><h2>Settings</h2><p>If something goes wrong, contact admin.</p><table><tr><td>x</td></tr></table></body></html>" });
  check("help text mentioning errors → Pass", r.pass, r.reason);
}

/* ---- a blank / contentless page fails ---- */
{
  check("empty body → Fail", cl({ status: 200, html: "<html><head></head><body></body></html>" }).pass === false);
  const r = cl({ status: 200, html: "<html><body>   \n  </body></html>" });
  check("whitespace-only body → Fail (blank)", r.pass === false && r.kind === "blank", r.reason);
}
{
  // a short page that still has real structure (a form) is NOT blank
  const r = cl({ status: 200, html: "<html><body><form><input name=q></form></body></html>" });
  check("short but has a form → Pass (not blank)", r.pass, r.reason);
}

/* ---- a network/other error carried in → Fail ---- */
{
  const r = cl({ error: "timeout after 30s" });
  check("a fetch error object → Fail with its reason", r.pass === false && /timeout/.test(r.reason), r.reason);
}

/* ---- Browser / Headless verdict (fnClassifyProbe) — from the rendered page ---- */
{
  const ok = U.classifyProbe({ errText: "", serverErr: false, isLogin: false, bodyLen: 500, hasStructure: true, consoleErr: "" });
  check("probe: a healthy rendered page → Pass", ok.pass, ok.reason);
  const login = U.classifyProbe({ isLogin: true, bodyLen: 300, hasStructure: true });
  check("probe: login page → Fail", login.pass === false && login.kind === "login", login.reason);
  const srv = U.classifyProbe({ serverErr: true, errText: "System.NullReferenceException", bodyLen: 200, hasStructure: true });
  check("probe: rendered .NET error → Fail", srv.pass === false && srv.kind === "page", srv.reason);
  const toast = U.classifyProbe({ errText: "Could not save the record", bodyLen: 400, hasStructure: true });
  check("probe: a VISIBLE error toast → Fail", toast.pass === false && toast.kind === "page", toast.reason);
  const js = U.classifyProbe({ consoleErr: "Uncaught TypeError: x is not a function (app.js:12)", bodyLen: 400, hasStructure: true });
  check("probe: an uncaught JS console error → Fail", js.pass === false && js.kind === "js", js.reason);
  const blank = U.classifyProbe({ bodyLen: 5, hasStructure: false });
  check("probe: blank rendered page → Fail", blank.pass === false && blank.kind === "blank", blank.reason);
  const none = U.classifyProbe(null);
  check("probe: no result at all → Fail", none.pass === false, none.reason);
}

console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
process.exit(fail ? 1 : 0);
