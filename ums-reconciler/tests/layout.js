/* Start / Pause / Stop belong at the right edge of the settings row. The row is a four-column
 * grid holding only three children, so without being told otherwise the buttons sat in column 3
 * and left column 4 empty — a gap on the right with the buttons floating in the middle.
 *
 * The catch: below 820px that grid collapses to a single column, and a hard `grid-column:4` there
 * would invent three empty implicit columns and push the buttons off on their own. So the rule
 * has to be undone in the same media query that collapses the grid — which is why this is a class
 * and not the inline style it started as.
 *
 *   node tests/layout.js
 */
"use strict";
const fs = require("fs");
const path = require("path");

const HTML = fs.readFileSync(path.join(__dirname, "..", "app.html"), "utf8");

let fail = 0;
const check = (name, ok, extra) => { if (!ok) fail++; console.log((ok ? "PASS  " : "FAIL  ") + name + (!ok && extra ? "   " + extra : "")); };

/* ---- the row itself ---- */
const g4 = (HTML.match(/\.g4\{([^}]*)\}/) || [])[1] || "";
check("the settings row is a 4-column grid", /grid-template-columns:\s*1fr 1fr 1fr/.test(g4), g4);

const kids = (HTML.match(/<div class="grid g4">([\s\S]*?)\n      <\/div>/) || [])[1] || "";
const childDivs = (kids.match(/\n        <div[ >]/g) || []).length;
check("it holds three children, so one column is spare", childDivs === 3, childDivs + " children");

/* ---- the buttons take the spare column ---- */
const rb = (HTML.match(/\.runbtns\{([^}]*)\}/) || [])[1] || "";
check("a .runbtns rule exists", !!rb, "not found");
check("it sits in the last column", /grid-column:\s*4/.test(rb), rb);
check("the three buttons are inside it",
  /<div class="runbtns">[\s\S]*?id="run"[\s\S]*?id="pause"[\s\S]*?id="stop"[\s\S]*?<\/div>/.test(HTML));
check("Start spans both rows beside Pause and Stop",
  /id="run"[^>]*grid-row:1\/3/.test(HTML) && /id="pause"[^>]*grid-column:2;grid-row:1/.test(HTML) &&
  /id="stop"[^>]*grid-column:2;grid-row:2/.test(HTML));

/* ---- and give it back when the row collapses ---- */
const mq = (HTML.match(/@media \(max-width:820px\)\{[\s\S]*?\n\s*\.runbtns\{[^}]*\}[^}]*\}/) || [])[0] || "";
check("the narrow-screen rule covers .runbtns", /\.runbtns\{/.test(mq), mq || "not found");
check("…and releases the column there", /\.runbtns\{[^}]*grid-column:\s*auto/.test(mq), mq);
check("…and drops the label-alignment nudge too", /\.runbtns\{[^}]*margin-top:\s*0/.test(mq), mq);
check("the same query collapses the grid to one column",
  /\.g3,\.g4\{grid-template-columns:1fr\}/.test(mq), mq);

/* ---- no leftover inline copy to drift out of sync ---- */
check("the styles live in the class, not inline on the div",
  !/<div style="[^"]*grid-column:4/.test(HTML), "inline copy still present");

console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
process.exit(fail ? 1 : 0);
