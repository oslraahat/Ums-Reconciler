/* Clicking the toolbar icon opens the Batch page.
 *
 * There was no action in the manifest at all, so the icon was a grey square that did nothing. The
 * things that can go wrong here are all quiet ones: a popup instead of a tab (a popup closes the
 * moment the window loses focus, which would end a run mid-way), a second copy of the page opened
 * over a run that is still going, and asking for the "tabs" permission — "Read your browsing
 * history" on the install prompt — to find a page the extension already owns.
 *
 *   node tests/toolbar.js
 */
"use strict";
const fs = require("fs");
const path = require("path");

const DIR = path.join(__dirname, "..");
const M = JSON.parse(fs.readFileSync(path.join(DIR, "manifest.json"), "utf8"));
const BG = fs.readFileSync(path.join(DIR, "background.js"), "utf8");
/* comments stripped, for the checks that ask what the file DOES not what it explains — the comment
   about why chrome.tabs.query is avoided says the words it is looking for */
const CODE = BG.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

let fail = 0;
const check = (name, ok, extra) => {
  if (!ok) fail++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (!ok && extra !== undefined ? "   " + extra : ""));
};

/* ---------- the button exists at all ---------- */
check("the manifest declares a toolbar action", !!M.action, JSON.stringify(M.action));
/* a popup would close the moment the window lost focus, taking a run with it */
check("…and it is not a popup", !M.action || !M.action.default_popup,
  M.action && M.action.default_popup);
check("…it says what it is on hover", !!(M.action && M.action.default_title),
  M.action && M.action.default_title);

/* ---------- something has to handle the click ---------- */
check("a service worker is registered",
  !!(M.background && M.background.service_worker), JSON.stringify(M.background));
check("…and the file it names exists",
  !!(M.background && fs.existsSync(path.join(DIR, M.background.service_worker))),
  M.background && M.background.service_worker);
check("…listening for the click", /chrome\.action\.onClicked\.addListener/.test(BG), "background.js");
check("…and opening the Batch page", /chrome\.runtime\.getURL\(PAGE\)/.test(BG) &&
  /const PAGE = "app\.html";/.test(BG) && fs.existsSync(path.join(DIR, "app.html")), "background.js");

/* ---------- back to the run, not on top of it ---------- */
{
  /* A run lives in its tab and holds everything it has found. A second copy starts empty and looks
     exactly like the first was lost, while the real one carries on unseen. */
  check("an open page is returned to, not opened again",
    /chrome\.tabs\.update\(open\.tabId, \{ active: true \}\)/.test(BG), "background.js");
  check("…and its window brought forward, wherever it is",
    /chrome\.windows\.update\(open\.windowId, \{ focused: true \}\)/.test(BG), "background.js");
  check("…while a page that is not open is created",
    /chrome\.tabs\.create\(\{ url: url \}\)/.test(BG), "background.js");
  /* the look and the click are not one instant — the tab can be closed in between */
  check("…and a tab closed between the look and the click still opens one",
    /catch \(e\) \{ \/\* it was closed between the look and the click/.test(BG), "background.js");
}

/* ---------- and it costs no new permission ---------- */
{
  /* chrome.tabs.query({url}) would find the tab, and would put "Read your browsing history" on the
     install prompt. runtime.getContexts() only ever reports this extension's own pages. */
  check("finding the page asks for nothing extra",
    /chrome\.runtime\.getContexts/.test(CODE) && !/chrome\.tabs\.query/.test(CODE), "background.js");
  check("…so \"tabs\" is not in the permissions",
    (M.permissions || []).indexOf("tabs") < 0, (M.permissions || []).join(", "));
  /* nativeMessaging is a deliberate third: the CRM · Dashboard Run button reaches a local host
     that runs the load test, since the extension itself cannot. It carries no browsing-data
     prompt. The guard stays — the set is exactly these three and nothing has crept in beside them. */
  check("…and the permission list is exactly the three it should be",
    JSON.stringify(M.permissions) === JSON.stringify(["storage", "downloads", "nativeMessaging"]),
    JSON.stringify(M.permissions));
  /* an older Chrome has no getContexts; the click must still open the page */
  check("…and where getContexts is missing, the click still works",
    /if \(!chrome\.runtime\.getContexts\) return null;/.test(BG), "background.js");
}

/* ---------- the icon ---------- */
{
  /* without one Chrome draws a grey square with a letter in it, which is what the toolbar is full
     of — and the button is now the way in */
  check("the extension has icons", !!M.icons, JSON.stringify(M.icons));
  const sizes = ["16", "32", "48", "128"];
  check("…in every size Chrome asks for",
    sizes.every((s) => M.icons && M.icons[s]), Object.keys(M.icons || {}).join(","));
  check("…the files are all there",
    sizes.every((s) => M.icons && fs.existsSync(path.join(DIR, M.icons[s]))),
    sizes.filter((s) => !(M.icons && fs.existsSync(path.join(DIR, M.icons[s])))).join(",") || "");
  /* a PNG states its own dimensions at bytes 16..24; a 128 shrunk into a 16 slot looks like mud */
  check("…and each really is the size it is filed under", sizes.every(function (s) {
    const b = fs.readFileSync(path.join(DIR, M.icons[s]));
    return b.readUInt32BE(16) === +s && b.readUInt32BE(20) === +s;
  }), sizes.map(function (s) {
    const b = fs.readFileSync(path.join(DIR, M.icons[s]));
    return s + "→" + b.readUInt32BE(16) + "x" + b.readUInt32BE(20);
  }).join(" "));
  check("…and the button wears them too",
    !!(M.action && M.action.default_icon), JSON.stringify(M.action && M.action.default_icon));
}

/* ---------- first install ---------- */
{
  check("a fresh install opens the page once", /chrome\.runtime\.onInstalled\.addListener/.test(BG), "background.js");
  /* an update must not: it can land in the middle of a run, and a new tab in front of one is the
     last thing that helps */
  check("…and an update does not", /if \(details\.reason !== "install"\) return;/.test(BG), "background.js");
}

console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
process.exit(fail ? 1 : 0);
