/* Single Reconcile depends on the panel actually capturing each page. Three ways it stopped:
 *
 *   1. init read `conc` from storage, but that variable was deleted with the batch code —
 *      a strict-mode ReferenceError killed the callback, so captureNow() never ran.
 *   2. Program Wise is found by its column names, not an id. Matching only the FIRST <tr>
 *      missed any page where a filter row or a <thead> pushed the labels out of row one.
 *   3. The table is often drawn after this script runs; one attempt at load found nothing.
 *
 *   node tests/capture.js
 */
"use strict";
const fs = require("fs");
const path = require("path");

const SRC = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
const REC = fs.readFileSync(path.join(__dirname, "..", "reconcile.js"), "utf8");

let fail = 0;
const check = (name, ok, extra) => { if (!ok) fail++; console.log((ok ? "PASS  " : "FAIL  ") + name + (extra ? "   " + extra : "")); };

/* ---------- the smallest DOM the panel touches ---------- */
const PW_HEAD = ["SL", "Date", "MRN", "CRN", "Income", "Consideration Amount", "Previous Due",
  "Deducted Amount", "Receivable", "Prev. Std. Discount", "Booking Discount", "Special Discount",
  "Received", "Cash Back", "Current Due"];
const PW_ROW = ["1", "01/01/2025", "111", "-", "17,000", "-", "-", "-", "17,000", "-", "-", "-",
  "10,000", "-", "7,000"];

function el(tag, attrs) {
  const n = {
    tagName: tag.toUpperCase(), id: "", className: "", children: [], attrs: attrs || {},
    style: {}, _text: "",
    set innerHTML(v) { n._text = String(v); }, get innerHTML() { return n._text; },
    set textContent(v) { n._text = String(v); },
    get textContent() { return n.children.length ? n.children.map((c) => c.textContent).join(" ") : n._text; },
    classList: { toggle: () => {}, add: () => {}, remove: () => {}, contains: () => false },
    getAttribute: (a) => (a in n.attrs ? String(n.attrs[a]) : null),
    setAttribute: (a, v) => { n.attrs[a] = v; },
    appendChild: (c) => { n.children.push(c); return c; },
    addEventListener: () => {},
    querySelector: (sel) => find(n, sel)[0] || null,
    querySelectorAll: (sel) => find(n, sel)
  };
  return n;
}
function walk(n, out) { n.children.forEach((c) => { out.push(c); walk(c, out); }); return out; }
function match(n, sel) {
  if (sel[0] === "#") return n.id === sel.slice(1);
  return n.tagName === sel.toUpperCase();
}
function find(n, sel) { return walk(n, []).filter((c) => sel.split(",").some((s) => match(c, s.trim()))); }

function cell(text, colspan) { const c = el("td", colspan ? { colspan } : {}); c.textContent = text; return c; }
function row(cells) { const r = el("tr"); cells.forEach((c) => r.appendChild(c)); return r; }

/* three real-world shapes of the same Program Wise table */
function plainTable() {                       // header is row one
  const t = el("table");
  t.appendChild(row(PW_HEAD.map((h) => cell(h))));
  t.appendChild(row(PW_ROW.map((v) => cell(v))));
  return t;
}
function filterRowTable() {                   // a search/filter row sits above the header
  const t = el("table");
  t.appendChild(row([cell("Search:", 15)]));
  t.appendChild(row(PW_HEAD.map((h) => cell(h))));
  t.appendChild(row(PW_ROW.map((v) => cell(v))));
  return t;
}
function theadTable() {                       // labels live in <thead>, body rows in <tbody>
  const t = el("table");
  const head = el("thead"), body = el("tbody");
  head.appendChild(row(PW_HEAD.map((h) => cell(h))));
  body.appendChild(row(PW_ROW.map((v) => cell(v))));
  t.appendChild(head); t.appendChild(body);
  return t;
}

/* ---------- run content.js against a fake page ---------- */
function runPanel(opts) {
  opts = opts || {};
  const store = Object.assign({}, opts.store);
  const body = el("body"), head = el("head"), root = el("html");
  root.appendChild(head); root.appendChild(body);
  if (opts.table) body.appendChild(opts.table);

  const document = {
    documentElement: root, head, body,
    createElement: (tag) => el(tag),
    getElementById: (id) => walk(root, []).find((c) => c.id === id) || null,
    querySelector: (sel) => find(root, sel)[0] || null,
    querySelectorAll: (sel) => find(root, sel)
  };
  /* innerHTML on the panel: give it the two status spans the code looks up by id */
  const origAppend = body.appendChild;
  body.appendChild = function (c) {
    if (/umsrec-p/.test(c.innerHTML || "")) {
      ["umsrec-tt", "umsrec-p", "umsrec-c", "umsrec-out", "umsrec-min", "umsrec-pop",
       "umsrec-power", "umsrec-clear", "umsrec-verify", "umsrec-dash", "umsrec-copy"].forEach((id) => {
        const s = el("span"); s.id = id; c.appendChild(s);
      });
    }
    if (/umsrec-bub/.test(c.innerHTML || "")) {
      ["umsrec-bub", "umsrec-batch"].forEach((id) => { const s = el("div"); s.id = id; c.appendChild(s); });
    }
    return origAppend.call(body, c);
  };

  const saved = {};
  const chrome = {
    runtime: { id: "test", getURL: (p) => p },
    storage: {
      local: {
        get: (keys, cb) => { const o = {}; [].concat(keys).forEach((k) => { if (k in store) o[k] = store[k]; }); cb(o); },
        set: (o, cb) => { Object.assign(store, o); Object.assign(saved, o); if (cb) cb(); },
        remove: (k, cb) => { [].concat(k).forEach((x) => delete store[x]); if (cb) cb(); }
      },
      onChanged: { addListener: () => {} }
    }
  };

  const timers = [];
  const sandbox = {
    document, chrome, location: { pathname: opts.path || "/Student/Payment/HistoryOfPayment", search: "?studentProgramId=999", href: "u" },
    window: { open: () => {} },
    MutationObserver: function (fn) { timers.push(fn); this.observe = () => {}; this.disconnect = () => { timers.length = 0; }; },
    setInterval: () => 0, clearInterval: () => {}, Date, console
  };
  const self = {};
  sandbox.self = self;
  new Function("self", REC)(self);

  const names = Object.keys(sandbox);
  let err = null;
  try {
    new Function(...names, SRC)(...names.map((n) => sandbox[n]));
  } catch (e) { err = e; }
  return { saved, store, err, body, redraw: () => timers.slice().forEach((f) => f()),
    status: () => (document.getElementById("umsrec-p") || {}).textContent };
}

/* ---------- 1. the ReferenceError ---------- */
{
  const r = runPanel({ table: plainTable(), store: { conc: 25, baseUrl: "https://ums-5.osl.team" } });
  check("init survives stored batch settings (conc/baseUrl)", !r.err, r.err ? String(r.err.message) : "");
  check("Program Wise captured when batch settings exist", !!r.saved["program_999"],
    Object.keys(r.saved).join(",") || "nothing saved");
}

/* ---------- 2. header not in row one ---------- */
[["plain header", plainTable], ["filter row above header", filterRowTable], ["header in <thead>", theadTable]]
  .forEach(([label, mk]) => {
    const r = runPanel({ table: mk() });
    const got = r.saved["program_999"];
    check("Program Wise found — " + label, !!got && got.data.rows.length === 1,
      got ? got.data.rows.length + " rows" : "not captured");
  });

/* ---------- 3. table arrives late ---------- */
{
  const r = runPanel({});                       // no table at load
  check("no table at load → nothing saved yet", !r.saved["program_999"]);
  check("status says why", /পাওয়া যায়নি/.test(r.status() || ""), r.status());
  // the page now draws the table and the observer fires
  r.body.appendChild(plainTable());
  r.redraw();
  check("captured once the table appears", !!r.saved["program_999"],
    r.saved["program_999"] ? r.saved["program_999"].data.rows.length + " rows" : "still nothing");
}

/* ---------- the source guards, so a future cleanup cannot undo this ---------- */
check("content.js no longer reads conc/baseUrl", !/\b(conc|baseUrl)\s*=\s*o\./.test(SRC));
check("content.js scores the header region, not just row one", /headerText/.test(SRC));
check("content.js retries until the table appears", /captureWhenReady/.test(SRC));

/* reconcile.js on its own — rawText() needs no DOM at all */
const RECG = {};
new Function("self", REC)(RECG);
const U = RECG.UMSREC;

/* ---- ⧉ কাঁচা সারি কপি ----
   When a receipt is disputed — "this one is not really a mismatch" — only the actual cells on the
   two pages settle it, and copying eleven columns out of UMS by hand is where that goes wrong.
   The panel already holds them parsed, so it hands them over verbatim. */
{
  const pw = { ok: true, rows: [{ date: "15/10/2023", mrn: "-", crn: "9643232014", income: "0",
    consideration: "5,185", previousDue: "5,185", deducted: "0", receivable: "5,185", prevStd: "0",
    booking: "0", special: "0", received: "0", cashBack: "0", currentDue: "0" }] };
  const cw = { ok: true, rows: [{ date: "15/10/2023", course: "Engineering  Full\tCourse", mrn: "-",
    crn: "9643232014", income: "0", consideration: "5,185", previousDue: "5,185", deducted: "0",
    receivable: "5,185", prevStd: "0", booking: "0", special: "0", grossReceived: "0",
    dueAdjustment: "0", cashBack: "5,185", netReceived: "(5,185)", currentDue: "0" }] };
  const txt = U.rawText(pw, cw, { spid: "2394829", reg: "2365277" });
  const lines = txt.split("\n");

  check("it names the student", /studentProgramId 2394829 · reg 2365277/.test(lines[0]), lines[0]);
  check("both pages are in it", /## Program Wise/.test(txt) && /## Course Wise/.test(txt));

  const cwHead = lines[lines.indexOf("## Course Wise — 1 rows") + 1].split("\t");
  const cwBody = lines[lines.indexOf("## Course Wise — 1 rows") + 2].split("\t");
  check("every Course Wise column is there", cwHead.length === U.RAW_CW.length, cwHead.length + " cols");
  check("…including the ones an argument turns on",
    ["dueAdjustment", "cashBack", "grossReceived", "netReceived"].every((k) => cwHead.indexOf(k) >= 0), cwHead.join(","));
  check("the row lines up with the header", cwBody.length === cwHead.length,
    cwBody.length + " vs " + cwHead.length);

  /* a course name holding a tab would shift every later column by one and quietly corrupt the
     numbers — the whole point is that they arrive unchanged */
  check("a tab inside a course name cannot shift the columns",
    cwBody[cwHead.indexOf("course")] === "Engineering Full Course" &&
    cwBody[cwHead.indexOf("course")].indexOf("	") < 0, cwBody[cwHead.indexOf("course")]);
  check("…and the figures land under their own names",
    cwBody[cwHead.indexOf("cashBack")] === "5,185" && cwBody[cwHead.indexOf("dueAdjustment")] === "0",
    cwBody.join("|"));
  // brackets are how UMS writes a negative; stripping them here would change the meaning
  check("negatives keep their brackets", cwBody[cwHead.indexOf("netReceived")] === "(5,185)",
    cwBody[cwHead.indexOf("netReceived")]);

  // half a capture is still worth handing over, but it must say which half is missing
  const half = U.rawText(pw, null, { spid: "2394829" });
  check("one page captured still copies", /## Program Wise — 1 rows/.test(half));
  check("…and says the other was not", /## Course Wise — 0 rows\n\(not captured\)/.test(half), half.slice(-40));
}

/* the button has to exist, ask for both pages, and survive a refused clipboard */
{
  check("the panel carries the button", /id="umsrec-copy"/.test(SRC), "content.js");
  check("…it copies what was captured, not what is on screen", /U\.rawText\(pw && pw\.data, cw && cw\.data/.test(SRC), "content.js");
  check("…it names the reg as well as the spid", /stdRollOrRegistrationNo=\(\[\^&\]\+\)/.test(SRC), "content.js");
  check("…nothing captured is said, not copied", /Nothing captured yet/.test(SRC), "content.js");
  /* the label replaces itself with the outcome, so both have to be in the same language — a
     Bangla "✓ কপি হয়েছে" flashing over an English button reads as a glitch */
  check("…and the button speaks one language",
    /⧉ Copy Both Tables/.test(SRC) && !/flash\("[^"]*[ঀ-৿]/.test(SRC), "content.js");
  check("…and a refused clipboard falls back", /document\.execCommand\("copy"\)/.test(SRC), "content.js");
}

console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
process.exit(fail ? 1 : 0);
