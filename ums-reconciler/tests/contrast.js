/* Can the words on this page actually be read?
 *
 * The light theme redefined its surfaces — background, card, text, border — and kept the dark
 * theme's four semantic colours. Those were chosen to glow on #161a2b, and on white they wash out.
 * Measured against the surfaces they really sit on, every one of them was below what body text
 * needs, and the tile numbers were the worst thing on the page:
 *
 *     --ok   #37d18b   1.73:1        --warn #ffb454   1.55:1
 *     --no   #ff6b7d   2.41:1        --mut  #8b90ad   2.76:1
 *
 * That is what "ধুয়ে গেছে" looks like, and no amount of looking at a screenshot settles it —
 * contrast is a number. So this renders the real page in both themes and measures every kind of
 * text on it. WCAG AA wants 4.5:1 for body text, 3:1 for large.
 *
 * The in-page panel is measured too, and on a hostile page: it is injected INTO the UMS document,
 * so the UMS stylesheet reaches it. A host rule as ordinary as "th { background:#eef1f8 }" once
 * painted the panel's own report table light while its text stayed #eef1fb — 1.00:1, the whole
 * answer invisible, on a page nobody here controls.
 *
 * Needs Chrome; skips cleanly without one.
 *
 *   node tests/contrast.js
 */
"use strict";
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
let fail = 0;
const check = (name, ok, extra) => {
  if (!ok) fail++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (!ok && extra !== undefined ? "   " + extra : ""));
};

const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "/usr/bin/google-chrome", "/usr/bin/chromium"].filter((p) => fs.existsSync(p))[0];
if (!CHROME) { console.log("SKIP  Chrome not found — contrast has to be rendered to be measured"); process.exit(0); }

/* Every kind of text on the page, named as a person would name it. A run's results are poured in
   as static DOM afterwards, so the finding lines and pills are real ones. */
const PROBES = [
  ["#prog", "the progress badge"], ["#conn", "the connection badge"],
  /* paintConn() puts the badge in one of these the moment a connection is tested, and each has a
     colour of its own now — a green and a red on their own tints, which the lilac default never
     had to answer for. Both are on screen for the whole of every run. */
  ["#conn2", "the second connection badge — logged in"],
  ["#connFail", "a connection badge — not logged in"],
  ["#concNote", "the note under Parallel"], [".hint", "the hint under a card"],
  [".tile .v", "a tile number"], [".tile .l", "a tile label"], [".rr", "a tile re-run arrow"],
  [".filters .fb", "a filter chip"], [".filters .fb.active", "the active filter chip"],
  [".filters .fb.dl", "an export button"],
  [".pill.ok", "the ✓ pill"], [".pill.no", "the ✕ pill"], [".pill.mut", "the missing pill"],
  [".pd", "a finding line"], [".pwhy", "the explanation under it"],
  [".stu .sh .reg", "the Reg number"], [".stu .sh .mut", "the programme count"],
  [".cpy", "a copy icon"], [".mk", "the Mark-as-matched button"],
  ["#ckTxt", "the resume bar"], [".ckh", "the resume hint"],
  ["#run", "Start"], ["#pause", "Pause"], ["#pasteBtn", "Check"], ["#pickDir", "the folder button"]
];

const MEASURE = `<script>setTimeout(function () {
  function toRgb(c) {
    const m = /rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)/.exec(c || "");
    return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null;
  }
  function lum(c) {
    const f = [c.r, c.g, c.b].map(function (v) {
      v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
  }
  /* What is actually painted behind this text. A gradient is not a backgroundColor, and reading
     past one lands on the card and reports a button as unreadable when it is not — so take the
     gradient's first colour stop, which is its darkest end on every button here. */
  function bgOf(el) {
    let e = el;
    while (e) {
      const cs = getComputedStyle(e);
      /* Not by matching the gradient's own parentheses — its colour stops have parentheses too,
         so [^)] stops inside the first rgb( and the stop is never found. Take the first rgb() in
         the whole declaration; computed style has already turned every hex into one. */
      const bi = cs.backgroundImage || "";
      if (bi.indexOf("gradient") >= 0) {
        const stop = /rgba?\\([^)]*\\)/.exec(bi);
        const c = stop && toRgb(stop[0]);
        if (c) return c;
      }
      const c = toRgb(cs.backgroundColor);
      if (c && c.a > 0.85) return c;
      e = e.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  }
  const out = [];
  ${JSON.stringify(PROBES)}.forEach(function (p) {
    const el = document.querySelector(p[0]);
    if (!el || el.offsetParent === null) { out.push("skip|" + p[1] + "|0|0"); return; }
    const cs = getComputedStyle(el);
    const fg = toRgb(cs.color), bg = bgOf(el);
    if (!fg) { out.push("skip|" + p[1] + "|0|0"); return; }
    const a = Math.max(lum(fg), lum(bg)), b = Math.min(lum(fg), lum(bg));
    const px = parseFloat(cs.fontSize);
    const large = px >= 24 || (px >= 18.66 && +cs.fontWeight >= 600);
    out.push("t|" + p[1] + "|" + ((a + 0.05) / (b + 0.05)).toFixed(2) + "|" + (large ? 3 : 4.5));
  });
  const d = document.createElement("pre"); d.id = "C";
  d.textContent = out.join("\\n");
  document.body.appendChild(d);
}, 300)<\/script>`;

/* the page, with a finished two-server run painted into it */
function page(light) {
  const store = JSON.stringify({
    baseUrl: "https://ums-5.osl.team", baseUrl2: "https://ums-41.osl.team", srvMode: true,
    saveOnFinish: true, saveDirName: "ums-reconciler", appConc: 25, appTol: 0, tolMigrated: true,
    theme: light ? "light" : "dark", lang: "bn"
  });
  const stub = "<script>window.chrome={runtime:{id:'x',getManifest:function(){return{version:'0'}}}," +
    "storage:{local:{get:function(k,cb){cb(" + store + ")},set:function(){},remove:function(){}}," +
    "onChanged:{addListener:function(){}}}};" +
    "window.fetch=function(){return new Promise(function(){})};" +
    "window.indexedDB={open:function(){var r={};setTimeout(function(){r.onerror&&r.onerror()},0);return r}};" +
    "<\/script>";
  const cards =
    '<div class="stu"><div class="sh"><span class="reg">1956107</span><span class="mut">· ১ প্রোগ্রাম · মোট ১</span>' +
    '<button class="mk">✓ মিলেছে ধরো</button></div>' +
    '<div class="prow"><span class="pill no">✕ আলাদা</span><div class="pinfo">' +
    '<div class="pn"><span class="mut">Reg:</span> 1956107 <span class="cpy">⧉</span></div>' +
    '<div class="pd">একই ঘরে দুই সার্ভারে দুই অঙ্ক — Expected 4,636, Actual 0</div>' +
    '<div class="pwhy">সারিটা দুই সার্ভারেই আছে, কিন্তু টাকার অঙ্ক আলাদা</div></div></div></div>' +
    '<div class="stu"><div class="prow"><span class="pill ok">✓ এক</span></div></div>' +
    '<div class="stu"><div class="prow"><span class="pill mut">Actual-এ নেই</span></div></div>';
  const paint = "<script>setTimeout(function(){" +
    "document.getElementById('list').innerHTML=" + JSON.stringify(cards) + ";" +
    "document.getElementById('prog').className='badge';" +
    /* the two states paintConn() actually sets, side by side as the card shows them */
    "var c2=document.getElementById('conn2');c2.style.display='';c2.className='badge ok';" +
    "c2.textContent='Expected · ✓ লগইন আছে';" +
    "var cf=c2.cloneNode(true);cf.id='connFail';cf.className='badge no';" +
    "cf.textContent='Actual · ✗ লগইন নেই';c2.parentNode.appendChild(cf);" +
    "document.getElementById('prog').textContent='✅ শেষ · ৮,৭৩৫/৮,৭৩৫';" +
    "var n=document.getElementById('concNote');n.textContent='⚠ কার্যত ১২টি · http/1.1';n.className='cnote warn';" +
    "var b=document.getElementById('ckBar');b.style.display='';" +
    "document.getElementById('ckTxt').innerHTML='<b>৮২,৩০০</b> / ১,০০,০০০ পর্যন্ত সেভ করা আছে';" +
    "['html','xlsx','raw'].forEach(function(i){document.getElementById(i).disabled=false});" +
    "},100)<\/script>";
  const s = fs.readFileSync(path.join(ROOT, "app.html"), "utf8")
    .replace('<script src="reconcile.js"></script>', stub + '<script src="reconcile.js"></script>');
  const at = s.lastIndexOf("</body>");
  return s.slice(0, at) + paint + MEASURE + s.slice(at);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "umscon-"));
["app.js", "reconcile.js"].forEach((f) => fs.copyFileSync(path.join(ROOT, f), path.join(TMP, f)));

function measure(light) {
  const f = path.join(TMP, (light ? "light" : "dark") + ".html");
  fs.writeFileSync(f, page(light));
  const r = spawnSync(CHROME, ["--headless", "--disable-gpu", "--no-sandbox",
    "--allow-file-access-from-files", "--virtual-time-budget=9000",
    "--user-data-dir=" + path.join(TMP, "p"), "--dump-dom",
    "file:///" + f.replace(/\\/g, "/")], { encoding: "utf8", maxBuffer: 1 << 26 });
  const m = /<pre id="C">([\s\S]*?)<\/pre>/.exec(r.stdout || "");
  if (!m) return null;
  return m[1].split("\n").filter((l) => l.indexOf("t|") === 0).map((l) => {
    const p = l.split("|");
    return { what: p[1], ratio: +p[2], need: +p[3] };
  });
}

/* ---------- the in-page panel, on a page that styles tables against it ---------- */
{
  const SRC = fs.readFileSync(path.join(ROOT, "content.js"), "utf8");
  /* the panel's own CSS and markup, lifted from the file it ships in */
  const css = (function () {
    const at = SRC.indexOf("const css = `");
    return SRC.slice(at + 13, SRC.indexOf("`;", at + 13));
  })();
  const markup = (function () {
    const at = SRC.indexOf("el.innerHTML =");
    const expr = SRC.slice(at + "el.innerHTML =".length, SRC.indexOf("document.body.appendChild(el)", at))
      .trim().replace(/;$/, "").replace(/\/\*[\s\S]*?\*\//g, "").trim();
    /* trim AFTER stripping the comments: a leading newline turns "return" into "return;" */
    return new Function("return " + expr)();
  })();
  const REPORT = '<div class="verdict vno">✕ ২ টি গরমিল</div>' +
    '<div class="tbl"><table><tr><th>রসিদ</th><th>ঘর</th><th>PW</th><th>CW</th><th>পার্থক্য</th></tr>' +
    "<tr><td>MRN 2220262250</td><td>Received</td><td>4,636</td><td>0</td><td>-4,636</td></tr></table></div>";
  const PANEL_PROBES = [
    ["#umsrec-tt", "the panel name"], ["#umsrec .ic", "a panel icon"],
    ["#umsrec-verify", "Single Reconcile"], ["#umsrec .row-actions.small button", "a small button"],
    ["#umsrec .verdict", "the verdict line"], ["#umsrec .tbl th", "a report heading"],
    ["#umsrec .tbl td", "a report cell"], ["#umsrec .st", "the capture status"]
  ];
  /* A UMS-shaped host: dark navbar, white cards, and — the part that matters — bare th/td rules,
     which is how every Bootstrap-era admin page in the world styles its tables. */
  const HOST = "body{margin:0;background:#f4f6fb;color:#222;font:14px system-ui}" +
    "table{border-collapse:collapse;width:100%;background:#fff;font-size:12px}" +
    "th,td{border:1px solid #dde1ee;padding:6px 8px;text-align:center;color:#222}" +
    "th{background:#eef1f8}td{background:#fff}";
  const html = "<!doctype html><html><head><meta charset=utf-8><style>" + HOST + css +
    "</style></head><body><table><tr><th>Sl.</th><td>1</td></tr></table>" +
    '<div id="umsrec">' + markup.replace(/(<div[^>]*id="umsrec-out"[^>]*>)/, "$1" + REPORT) + "</div>" +
    MEASURE.replace(JSON.stringify(PROBES), JSON.stringify(PANEL_PROBES)) + "</body></html>";
  const f = path.join(TMP, "panel.html");
  fs.writeFileSync(f, html);
  const r = spawnSync(CHROME, ["--headless", "--disable-gpu", "--no-sandbox",
    "--allow-file-access-from-files", "--virtual-time-budget=6000",
    "--user-data-dir=" + path.join(TMP, "p"), "--dump-dom",
    "file:///" + f.split(path.sep).join("/")], { encoding: "utf8", maxBuffer: 1 << 26 });
  const m = /<pre id="C">([\s\S]*?)<\/pre>/.exec(r.stdout || "");
  const rows = m ? m[1].split("\n").filter(function (l) { return l.indexOf("t|") === 0; })
    .map(function (l) { const p = l.split("|"); return { what: p[1], ratio: +p[2], need: +p[3] }; }) : [];
  if (!rows.length) check("the panel rendered", false, "nothing measured");
  else {
    const low = rows.filter(function (x) { return x.ratio < x.need; });
    check("the panel is readable on a page that styles tables against it", low.length === 0,
      low.map(function (x) { return x.what + " " + x.ratio.toFixed(2) + ":1"; }).join(" · "));
    check("…measured across the panel (" + rows.length + " kinds of text)", rows.length >= 7,
      rows.length + " probes found");
  }
}

[["dark", false], ["light", true]].forEach(function (mode) {
  const rows = measure(mode[1]);
  if (!rows || !rows.length) { check(mode[0] + " theme rendered", false, "nothing measured"); return; }
  const low = rows.filter((r) => r.ratio < r.need);
  check("every word on the " + mode[0] + " theme is readable", low.length === 0,
    low.map((r) => r.what + " " + r.ratio.toFixed(2) + ":1 (needs " + r.need + ")").join(" · "));
  /* and it really did look at the whole page, not at three elements that happened to exist */
  check("…measured across the page (" + rows.length + " kinds of text)", rows.length >= 18,
    rows.length + " probes found");
});

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {}
console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
process.exit(fail ? 1 : 0);
