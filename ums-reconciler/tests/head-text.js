/* The panel and the batch page must pick the same table.
 *
 * Program Wise has no id to grab, so both find it by scoring header words. They share headScore()
 * in reconcile.js — but they were not sharing what they fed it. content.js hands it the header's
 * rendered TEXT; app.js handed it the raw HTML of the table, and headScore() is an indexOf search,
 * so app.js was also searching tag names and attribute values.
 *
 * A table whose header reads "Sl. Reg Date Course" but whose markup carries data-col="current due"
 * and class="received" therefore scored 0 in the panel and 4 in the batch page. Same page, two
 * different tables read, two different reports about one student — and nothing on either to say
 * they had read different things.
 *
 *   node tests/head-text.js
 */
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const APP = fs.readFileSync(path.join(ROOT, "app.js"), "utf8");
const CONTENT = fs.readFileSync(path.join(ROOT, "content.js"), "utf8");
const g = {};
new Function("self", fs.readFileSync(path.join(ROOT, "reconcile.js"), "utf8"))(g);
const U = g.UMSREC;

let fail = 0;
const check = (name, ok, extra) => {
  if (!ok) fail++;
  console.log((ok ? "PASS  " : "FAIL  ") + name + (!ok && extra !== undefined ? "   " + extra : ""));
};

function lift(src, name) {
  let at = src.indexOf("function " + name + "(");
  if (at < 0) throw new Error("no such function: " + name);
  let d = 0;
  for (let j = src.indexOf("{", at); j < src.length; j++) {
    if (src[j] === "{") d++;
    else if (src[j] === "}") { d--; if (!d) return src.slice(at, j + 1); }
  }
  throw new Error("unbalanced " + name);
}

/* the batch page's reader: HTML in, whatever it decides to score out */
const headOf = new Function(lift(APP, "headOf") + "\nreturn headOf;")();

/* the panel's reader, on the same markup — a tiny DOM is enough for what headerText() touches */
function panelHead(html) {
  const rowsOf = function (h) {
    return (h.match(/<tr[\s\S]*?<\/tr>/gi) || []).map(function (tr) {
      return (tr.match(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi) || [])
        .map(function (c) { return c.replace(/<[^>]*>/g, ""); }).join("");
    });
  };
  const thead = (h) => { const m = /<thead[\s\S]*?<\/thead>/i.exec(h); return m ? m[0] : null; };
  const t = { querySelector: (s) => (s === "thead" && thead(html) ? { html: thead(html) } : null) };
  const head = t.querySelector("thead");
  const rows = head ? rowsOf(head.html) : rowsOf(html).slice(0, 3);
  return rows.join(" ").toLowerCase();
}

/* ---------- the case that split them ---------- */
{
  /* a layout table: its words are all in the markup, none of them in what a person reads */
  const trap = '<table><thead><tr>' +
    '<th data-sort="mrn">Sl.</th>' +
    '<th data-col="current due">Reg</th>' +
    '<th class="received">Date</th>' +
    '<th id="receivable">Course</th>' +
    '</tr></thead><tbody><tr><td>1</td><td>2</td><td>3</td><td>4</td></tr></tbody></table>';
  const batch = U.headScore(headOf(trap));
  const panel = U.headScore(panelHead(trap));
  check("a table whose header words live only in its markup scores 0 in the batch page",
    batch === 0, "score " + batch);
  check("…exactly as it does in the panel", panel === 0, "score " + panel);
  check("…and the two agree", batch === panel, "batch " + batch + " vs panel " + panel);
}

/* ---------- and a real Program Wise table still wins ---------- */
{
  const real = '<table class="table table-striped"><thead><tr>' +
    ['Sl.', 'MRN', 'CRN', 'Date', 'Income', 'Consideration Amount', 'Previous Due',
      'Receivable', 'Received', 'Current Due'].map(function (h) {
      return '<th class="text-center">' + h + '</th>';
    }).join("") + '</tr></thead><tbody><tr>' + '<td>x</td>'.repeat(10) + '</tr></tbody></table>';
  const batch = U.headScore(headOf(real));
  const panel = U.headScore(panelHead(real));
  check("the real Program Wise table still scores", batch > 4, "score " + batch);
  check("…and both readers give it the same score", batch === panel, "batch " + batch + " vs panel " + panel);
}

/* ---------- a header that is not in row one ---------- */
{
  /* a filter row above the header — the reason the score exists rather than reading row one */
  const late = '<table><tr><td>Session</td><td>Program</td></tr><tr>' +
    ['Sl.', 'MRN', 'Date', 'Receivable', 'Received', 'Current Due'].map(function (h) {
      return "<th>" + h + "</th>";
    }).join("") + "</tr></table>";
  check("a header pushed out of row one is still found by both",
    U.headScore(headOf(late)) === U.headScore(panelHead(late)) && U.headScore(headOf(late)) > 0,
    "batch " + U.headScore(headOf(late)) + " vs panel " + U.headScore(panelHead(late)));
}

/* ---------- the shape of it ---------- */
{
  check("the batch page strips the markup before scoring",
    /part\.replace\(\/<\[\^>\]\*>\/g, " "\)/.test(lift(APP, "headOf")), "app.js headOf");
  check("…and the panel still passes rendered text",
    /textContent/.test(lift(CONTENT, "headerText")), "content.js headerText");
  check("…and there is still only one scorer", /U\.headScore\(/.test(APP) && /U\.headScore\(/.test(CONTENT),
    "both call reconcile.js");
}

console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
process.exit(fail ? 1 : 0);
