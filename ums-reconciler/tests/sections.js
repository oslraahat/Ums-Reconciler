/* Two sections, one page.
 *
 * Payment History and CRM are two places to work, and the obvious way to build that — two .html
 * files — is the wrong one here. Leaving this page ends a run: the workers, every answer they have
 * collected, the list on screen and the few hundred students the checkpoint has not written yet
 * all live in this document. So the sections hide and show, and nothing is torn down on the way
 * out. The menu carries a dot to say the other one is still going.
 *
 * What that arrangement can get wrong: a control the run needs left outside the section that
 * hides, so it disappears mid-run; both sections shown or neither; the choice forgotten; the
 * subtitle stuck on the wrong one after the language changes under it; and the dot lying.
 *
 *   node tests/sections.js
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const HTML = fs.readFileSync(path.join(ROOT, "app.html"), "utf8");
const APP = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
let fail = 0;
const check = (name, ok, extra) => {
  if (!ok) fail++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (!ok && extra !== undefined ? "   " + extra : ""));
};

/* ---------- the run's controls must be inside the section that hides ---------- */
{
  const from = HTML.indexOf('<section id="pgPay"');
  const to = HTML.indexOf('<section id="pgCrm"');
  check("both sections are in the page", from > 0 && to > from, from + " / " + to);
  const pay = HTML.slice(from, to);
  /* every id the run reaches for while it is going. If one of these were left outside, it would
     still be on screen with CRM open — and worse, a control for a section you cannot see. */
  const needed = ["conn", "conn2", "base", "base2", "srvSw", "cnt", "file", "link", "paste",
    "pasteBtn", "clearImp", "impNote", "preview", "tol", "conc", "concNote", "saveSw", "pickDir",
    "saveWhere", "run", "pause", "stop", "prog", "ckBar", "ckGo", "ckDrop", "ckDead", "srvNote",
    "fill", "list", "listNote", "html", "xlsx", "raw"];
  check("every control a run uses is inside Payment History",
    needed.filter(function (i) { return pay.indexOf('id="' + i + '"') < 0; }).length === 0,
    needed.filter(function (i) { return pay.indexOf('id="' + i + '"') < 0; }).join(", "));
  /* …and CRM holds none of them */
  const crm = HTML.slice(to);
  check("…and none of them is in CRM",
    needed.filter(function (i) { return crm.indexOf('id="' + i + '"') >= 0; }).length === 0,
    needed.filter(function (i) { return crm.indexOf('id="' + i + '"') >= 0; }).join(", "));
}

/* ---------- the reason this is one page, kept where it can be read ---------- */
check("the stylesheet hides a section rather than the page leaving",
  /\.page\{display:none\}/.test(HTML) && /\.page\.on\{display:block\}/.test(HTML), "app.html");
{
  /* showPage()'s own body, brace-matched — reaching a fixed number of characters past its name
     ran into the wiring below it and called that a teardown */
  const at = APP.indexOf("function showPage(");
  let d = 0, body = "";
  for (let j = APP.indexOf("{", at); j < APP.length; j++) {
    if (APP[j] === "{") d++;
    else if (APP[j] === "}") { d--; if (!d) { body = APP.slice(at, j + 1); break; } }
  }
  check("showPage() was found", !!body, "app.js");
  /* it moves two classes and remembers a word. Anything that empties the list, stops a run or
     rebuilds the students would make switching sections cost what leaving the page costs. */
  check("…and tears nothing down",
    !/innerHTML/.test(body) && !/run\./.test(body) && !/students/.test(body) &&
    !/entries/.test(body), body.slice(0, 200));
}

const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium"].filter((p) => fs.existsSync(p))[0];
if (!CHROME) {
  console.log("SKIP  Chrome not found — the switching itself needs a page");
  console.log(fail ? "\n" + fail + " FAILED" : "\nall good");
  process.exit(fail ? 1 : 0);
}

/* ---------- and the switching, in a page ---------- */
const STUBS = `<script>
window.__saved = {};
window.chrome = { runtime: { id: "t", getManifest: function () { return { version: "0" }; } },
  storage: { local: {
    get: function (k, cb) { cb({ theme: "dark", lang: "en", appConc: 4, appTol: 0, tolMigrated: true,
      baseUrl: "https://ums-5.osl.team" }); },
    set: function (o) { Object.keys(o).forEach(function (k) { window.__saved[k] = o[k]; }); },
    remove: function () {} }, onChanged: { addListener: function () {} } } };
window.fetch = function () { return new Promise(function () {}); };
</script>`;

const DRIVE = `<script>
var out = {};
function post(b) { try { var x = new XMLHttpRequest(); x.open("POST", "/done", true); x.send(b); } catch (e) {} }
addEventListener("load", function () {
  setTimeout(function () {
    var on = function (id) { return document.getElementById(id).classList.contains("on"); };
    var shown = function (id) {
      var e = document.getElementById(id);
      return getComputedStyle(e).display !== "none";
    };
    var sub = function () { return document.getElementById("sub"); };

    out.start = [on("pgPay"), on("pgCrm"), on("navPay"), on("navCrm")].join(",");
    out.startShown = [shown("pgPay"), shown("pgCrm")].join(",");
    out.startSub = sub().textContent.slice(0, 24);

    document.getElementById("navCrm").click();
    out.crm = [on("pgPay"), on("pgCrm"), on("navPay"), on("navCrm")].join(",");
    out.crmShown = [shown("pgPay"), shown("pgCrm")].join(",");
    out.crmSub = sub().textContent.slice(0, 24);
    out.crmSubKey = sub().getAttribute("data-i18n");
    out.remembered = window.__saved.page;

    /* the language changes under it — the subtitle has to follow the section, not the section it
       was on when the page loaded */
    document.getElementById("lang").click();
    out.afterLang = sub().textContent.slice(0, 24);
    out.afterLangKey = sub().getAttribute("data-i18n");
    out.stillCrm = on("pgCrm");

    document.getElementById("navPay").click();
    out.back = [on("pgPay"), on("pgCrm")].join(",");
    out.backShown = [shown("pgPay"), shown("pgCrm")].join(",");
    out.rememberedAgain = window.__saved.page;

    /* the dot only means something if it is off when nothing is running */
    out.dotAtRest = document.getElementById("navPay").classList.contains("running");
    out.crmSubHidden = getComputedStyle(document.getElementById("crmSub")).display;
    document.getElementById("navCrmDash").click();
    out.dashOpens = [on("pgCrm"), on("crmDash"), on("navCrmDash")].join(",");
    out.crmSubShown = getComputedStyle(document.getElementById("crmSub")).display;

    /* and the bar that is supposed to stay where it is — back on the long section, because
       CRM is one card and there is nothing there to scroll */
    document.getElementById("navPay").click();
    var before = document.querySelector(".topbar").getBoundingClientRect().top;
    scrollTo(0, 1200);
    /* A sticky offset is applied while the scroll is processed, not when scrollTo() returns —
       measuring in the same breath reads the position the element would have had without it,
       which is how this first reported a menu 1,118px above the window. */
    setTimeout(function () {
    var t = document.querySelector(".topbar").getBoundingClientRect();
    /* the column stretches the whole page so its border does; the menu inside it is what sticks */
    var side = document.querySelector(".sidein").getBoundingClientRect();
    var col = document.querySelector(".side").getBoundingClientRect();
    out.colH = Math.round(col.height);
    out.docH = Math.round(document.documentElement.scrollHeight);
    out.scrolled = Math.round(scrollY);
    out.topBefore = Math.round(before);
    out.topAfter = Math.round(t.top);
    out.topH = Math.round(t.height);
    out.menuTop = Math.round(side.top);
    out.topVar = getComputedStyle(document.documentElement).getPropertyValue("--top-h").trim();
    post(JSON.stringify(out));
    }, 250);
  }, 300);
});
<\/script></body></html>`;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "umssec-"));
{
  const s = HTML.replace('<script src="reconcile.js"></script>', STUBS + '<script src="reconcile.js"></script>');
  const at = s.lastIndexOf("</body>");
  fs.writeFileSync(path.join(TMP, "a.html"), s.slice(0, at) + DRIVE);
  fs.mkdirSync(path.join(TMP, "menus", "adm"), { recursive: true }); fs.mkdirSync(path.join(TMP, "menus", "crm"), { recursive: true });
  fs.mkdirSync(path.join(TMP, "lib"), { recursive: true });   // the xlsx/zip engine app.html now loads before the menus
  ["reconcile.js", "lib/xlsx.js", "app.js", "menus/adm/adm.js", "menus/crm/crm.js"].forEach((f) => fs.copyFileSync(path.join(ROOT, f), path.join(TMP, f)));
}

let waiting = null;
const srv = http.createServer((q, r) => {
  if (q.method === "POST") {
    let b = ""; q.on("data", (c) => { b += c; });
    q.on("end", () => { r.writeHead(204); r.end(); const w = waiting; waiting = null; if (w) w(b); });
    return;
  }
  const f = path.join(TMP, q.url.replace(/^\/+/, "").split("?")[0] || "a.html");
  fs.readFile(f, (e, b) => {
    if (e) { r.writeHead(404); r.end(); return; }
    r.writeHead(200, { "Content-Type": /\.js$/.test(f) ? "text/javascript" : "text/html; charset=utf-8" });
    r.end(b);
  });
});

srv.listen(0, "127.0.0.1", () => {
  const ch = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
    /* wide on purpose: below 820px the menu is supposed to lie down across the top and stop
       being sticky at all, and a headless window defaults to 800 — which read as a broken
       sidebar for as long as it took to notice */
    "--window-size=1366,900",
    "--user-data-dir=" + path.join(TMP, "prof"),
    "http://127.0.0.1:" + srv.address().port + "/a.html"], { stdio: "ignore" });
  const timer = setTimeout(() => { const w = waiting; waiting = null; if (w) w(null); }, 60000);
  waiting = (body) => {
    clearTimeout(timer);
    try { ch.kill(); } catch (e) {}
    if (!body) { check("the page reported back", false, "nothing in 60s"); }
    else {
      const o = JSON.parse(body);
      console.log("\n--- as the page opens ---");
      check("Payment History is the one open", o.start === "true,false,true,false", o.start);
      check("…and it is the only one drawn", o.startShown === "true,false", o.startShown);

      console.log("\n--- pressing CRM ---");
      check("the sections swap", o.crm === "false,true,false,true", o.crm);
      check("…and exactly one is drawn", o.crmShown === "false,true", o.crmShown);
      check("…the subtitle follows the section", /CRM/.test(o.crmSub), o.crmSub);
      check("…and the choice is remembered", o.remembered === "crm", String(o.remembered));

      console.log("\n--- and the language changes under it ---");
      /* the subtitle is written as a key, not as text, so applyLang() repaints the right one —
         set as text it would revert to Payment History's line on the next language press */
      check("the subtitle is still CRM's", o.afterLangKey === "crm_sub", o.afterLangKey);
      check("…in the new language", /CRM/.test(o.afterLang), o.afterLang);
      check("…and the section did not move", o.stillCrm === true, String(o.stillCrm));

      console.log("\n--- and back ---");
      check("Payment History returns", o.back === "true,false", o.back);
      check("…drawn again, with CRM put away", o.backShown === "true,false", o.backShown);
      check("…and that choice is remembered too", o.rememberedAgain === "pay", String(o.rememberedAgain));
      check("the running dot is off while nothing runs", o.dotAtRest === false, String(o.dotAtRest));

      console.log("\n--- what is inside CRM ---");
      check("its pages are not listed while another section is open",
        o.crmSubHidden === "none", o.crmSubHidden);
      check("…and Dashboard opens CRM and itself",
        o.dashOpens === "true,true,true", o.dashOpens);
      check("…and the list appears with it", o.crmSubShown === "flex", o.crmSubShown);

      console.log("\n--- the topbar, with the page scrolled under it ---");
      check("the page really scrolled", o.scrolled > 0, o.scrolled + "px");
      check("the topbar stays at the top", o.topAfter === 0 && o.topBefore === 0,
        "before " + o.topBefore + ", after " + o.topAfter);
      /* the offset is measured rather than written down: 61px here, 77 once the subtitle wraps */
      check("…and its height is published for whatever sticks below it",
        o.topVar === o.topH + "px", o.topVar + " vs " + o.topH + "px");
      check("…which is where the menu starts", o.menuTop === o.topH,
        "menu at " + o.menuTop + ", topbar " + o.topH + " tall");
      /* and it has to keep starting there however far the page goes: the column is as tall as
         the page, so the sticky menu inside it never runs out of room to stick in */
      check("…and the column runs the length of the page",
        o.colH >= o.docH - o.topH - 2, o.colH + " of " + (o.docH - o.topH));
    }
    console.log(fail ? "\n" + fail + " FAILED" : "\nall good");
    srv.close();
    setTimeout(() => process.exit(fail ? 1 : 0), 200);
  };
});
