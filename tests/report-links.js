/* The Expected / Actual link columns of the exported page.
 *
 * Reported: they are not there. They were — the columns, the empty cells and the script that
 * filled them were all in the file. What was not there was the time: the script built an anchor
 * for every row before the page would show anything, and the run in question was 800,000 rows on
 * a 660 MB page. Measured at 400,000: 6.8 s of parsing HTML into 800,000 anchors, and then the
 * browser holds all of them. At twice that, on a machine with other things to do, the answer is
 * that the links never appear.
 *
 * So nothing is built up front any more. The stylesheet writes "Open ↗" into an empty cell, which
 * costs nothing per row, and a real anchor is made for a row when the pointer arrives on it —
 * before any click, middle-click or right-click, so Open in new tab and Copy link address still
 * work on the row being pointed at. Touch has no hover, so a click on an unfilled cell opens it.
 *
 * Three things have to be true at once and none of them shows up in the file's text: the cell has
 * to READ as a link before anyone touches it, hovering has to produce a real anchor with the right
 * address, and clicking without hovering has to open the same address. So this opens the page.
 *
 *   node tests/report-links.js
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");

const ROOT = path.join(__dirname, "..");
const APP = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
let fail = 0;
const check = (name, ok, extra) => {
  if (!ok) fail++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (!ok && extra !== undefined ? "   " + extra : ""));
};

const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium"].filter((p) => fs.existsSync(p))[0];
if (!CHROME) { console.log("SKIP  Chrome not found — a page has to be opened to be read"); process.exit(0); }

/* ---- buildHtml, lifted, with the handful of things it stands on ---- */
function lift(name) {
  const at = APP.search(new RegExp("\\n  (?:(?:async )?function " + name + "\\s*\\()"));
  if (at < 0) throw new Error("missing " + name);
  let d = 0;
  for (let j = APP.indexOf("{", at); j < APP.length; j++) {
    if (APP[j] === "{") d++;
    else if (APP[j] === "}") { d--; if (!d) return APP.slice(at, j + 1); }
  }
  throw new Error("unbalanced " + name);
}
const page = (srvMode, rows) => new Function("t", "xesc", "esc", "ver", "srvMode", "STLBL",
  "STLBL_SRV", "lang", "baseUrl", "baseUrl2", "tol", "conc", "T",
  lift("payBase") + lift("buildHtml") + "\nreturn buildHtml;")(
  (k) => k,
  (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
  (s) => String(s == null ? "" : s), () => "0", srvMode,
  { ok: "Matched", no: "Mismatch", cw: "CW Empty", zero: "Zero Pay", nf: "No Program", error: "Load error" },
  { ok: "Identical", no: "Different", cw: "Missing on Actual", zero: "Extra on Actual",
    nf: "Page not read", error: "Load error" }, "en",
  "https://ums-5.osl.team", "https://ums-41.osl.team", 0, 25, { total: 0 })(rows);

const ROWS = [];
for (let i = 0; i < 40; i++) {
  const st = i % 5 === 0 ? "no" : "ok";
  ROWS.push({ reg: String(1956000 + i), spid: String(6686700 + i), program: "",
    status: st, result: st, remarks: "সারি " + i, details: "", link: "u", link2: "u",
    color: st === "ok" ? "g" : "r" });
}
/* one row the servers gave no Student PID for — it has no link to build and must not pretend */
ROWS.push({ reg: "1956999", spid: "", program: "", status: "nf", result: "nf",
  remarks: "no programme", details: "", link: "", link2: "", color: "r" });

const PROBE = `<script>
addEventListener("load", function () {
  setTimeout(function () {
    var out = {};
    var rows = document.querySelectorAll("#tb tr");
    out.rows = rows.length;
    var td = rows[0].cells[3], td2 = rows[0].cells[4];

    /* before anything is touched: no anchors anywhere, and the cell still reads as a link */
    out.anchorsAtLoad = document.querySelectorAll("#tb a").length;
    out.cellText = getComputedStyle(td, "::after").content;
    out.cellColour = getComputedStyle(td, "::after").color;
    out.cellCursor = getComputedStyle(td, "::after").cursor;

    /* the row with no Student PID says so instead */
    var last = rows[rows.length - 1];
    out.noIdText = getComputedStyle(last.cells[3], "::after").content;
    out.noIdClass = last.cells[3].className;

    /* hover the third row — as a pointer would, before any button is pressed */
    var tr = rows[2];
    tr.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    var a = tr.cells[3].querySelector("a"), b = tr.cells[4] ? tr.cells[4].querySelector("a") : null;
    out.hoverMade = document.querySelectorAll("#tb a").length;
    out.href = a ? a.getAttribute("href") : "(none)";
    out.href2 = b ? b.getAttribute("href") : "(none)";
    out.target = a ? a.getAttribute("target") : "";
    out.rel = a ? a.getAttribute("rel") : "";
    out.text = a ? a.textContent : "";
    /* …and once it is a link, the stylesheet stops writing over it */
    out.filledText = getComputedStyle(tr.cells[3], "::after").content;
    /* hovering again must not add a second one */
    tr.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    out.hoverTwice = tr.cells[3].querySelectorAll("a").length;

    /* a click with no hover first — what a touch screen does */
    var opened = [];
    window.open = function (u) { opened.push(u); return null; };
    rows[5].cells[3].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    rows[5].cells[4].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    /* and on the row with no id, which must open nothing */
    last.cells[3].dispatchEvent(new MouseEvent("click", { bubbles: true }));
    out.opened = opened.join(" ");

    /* the filter still works, since it reads the row attribute and not the cells */
    document.querySelector('.f[data-f="no"]').click();
    var shown = 0;
    [].forEach.call(document.querySelectorAll("#tb tr"), function (r) {
      if (!r.classList.contains("hide")) shown++;
    });
    out.afterFilter = shown;

    var x = new XMLHttpRequest(); x.open("POST", "/done", true); x.send(JSON.stringify(out));
  }, 120);
});
<\/script></body></html>`;

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "umsrl-"));
fs.writeFileSync(path.join(TMP, "srv.html"), page(true, ROWS) + PROBE);
fs.writeFileSync(path.join(TMP, "one.html"), page(false, ROWS) + PROBE);

let waiting = null;
const srv = http.createServer((q, r) => {
  if (q.method === "POST") {
    let b = ""; q.on("data", (c) => { b += c; });
    q.on("end", () => { r.writeHead(204); r.end(); const w = waiting; waiting = null; if (w) w(b); });
    return;
  }
  const f = path.join(TMP, q.url.replace(/^\/+/, "").split("?")[0]);
  if (!fs.existsSync(f)) { r.writeHead(404); r.end(); return; }
  r.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  r.end(fs.readFileSync(f));
});

const jobs = [{ file: "srv.html", label: "two servers", srv: true },
  { file: "one.html", label: "one server", srv: false }];
let at = 0;

srv.listen(0, "127.0.0.1", function next() {
  if (at >= jobs.length) {
    console.log(fail ? "\n" + fail + " FAILED" : "\nall good");
    srv.close();
    return setTimeout(() => process.exit(fail ? 1 : 0), 200);
  }
  const j = jobs[at++];
  const ch = spawn(CHROME, ["--headless=new", "--disable-gpu", "--no-sandbox", "--no-first-run",
    "--user-data-dir=" + path.join(TMP, "prof" + at),
    "http://127.0.0.1:" + srv.address().port + "/" + j.file], { stdio: "ignore" });
  const timer = setTimeout(() => { const w = waiting; waiting = null; if (w) w(null); }, 60000);
  waiting = (body) => {
    clearTimeout(timer);
    try { ch.kill(); } catch (e) {}
    console.log("\n--- " + j.label + " ---");
    if (!body) { check("the page reported back", false, "nothing in 60s"); return setTimeout(next, 300); }
    const o = JSON.parse(body);

    check("the page has its rows", o.rows === ROWS.length, String(o.rows));
    /* the whole point: nothing is built until somebody points at it */
    check("no anchor exists before the pointer arrives", o.anchorsAtLoad === 0, String(o.anchorsAtLoad));
    check("…but the cell already reads as a link", /Open/.test(o.cellText), o.cellText);
    check("…in a link's colour, with a pointer cursor",
      o.cellColour === "rgb(143, 180, 255)" && o.cellCursor === "pointer",
      o.cellColour + " / " + o.cellCursor);
    check("a row with no Student PID says so instead of offering a link",
      /—/.test(o.noIdText) && /\bn\b/.test(o.noIdClass), o.noIdText + " / " + o.noIdClass);

    console.log("  (hover)");
    check("hovering a row builds its link", o.hoverMade > 0, String(o.hoverMade));
    check("…only that row's", o.hoverMade === (j.srv ? 2 : 1), o.hoverMade + " anchor(s)");
    check("…addressed at the right student",
      /studentProgramId=6686702/.test(o.href) && /stdRollOrRegistrationNo=1956002/.test(o.href), o.href);
    check("…on the Expected server", o.href.indexOf("https://ums-5.osl.team/") === 0, o.href);
    if (j.srv) {
      check("…and the second on the Actual one",
        o.href2.indexOf("https://ums-41.osl.team/") === 0 && /studentProgramId=6686702/.test(o.href2), o.href2);
    } else {
      check("…and there is no second column to fill", o.href2 === "(none)", o.href2);
    }
    /* a real anchor, so Open in new tab and Copy link address are the browser's own */
    check("…as a real anchor, opening in a new tab",
      o.target === "_blank" && o.rel === "noopener" && /Open/.test(o.text),
      o.target + " " + o.rel + " " + JSON.stringify(o.text));
    check("…and the stylesheet stops writing over the cell once it is filled",
      o.filledText === "none", o.filledText);
    check("hovering the same row twice does not stack anchors", o.hoverTwice === 1, String(o.hoverTwice));

    console.log("  (click, with no hover — a touch screen)");
    const want = j.srv ? 2 : 1;
    const opened = String(o.opened || "").split(" ").filter(Boolean);
    check("a click opens the student's page", opened.length === want,
      opened.length + " opened: " + o.opened);
    check("…at the right address",
      opened[0] && /stdRollOrRegistrationNo=1956005/.test(opened[0]) &&
      opened[0].indexOf("https://ums-5.osl.team/") === 0, opened[0]);
    if (j.srv) {
      check("…and the Actual column opens the other server",
        opened[1] && opened[1].indexOf("https://ums-41.osl.team/") === 0, opened[1]);
    }
    check("…and a row with no Student PID opens nothing",
      opened.length === want, "expected " + want + ", got " + opened.length);

    console.log("  (and the rest of the page still works)");
    check("the filter still selects", o.afterFilter === 8, o.afterFilter + " of " + ROWS.length);

    setTimeout(next, 300);
  };
});
