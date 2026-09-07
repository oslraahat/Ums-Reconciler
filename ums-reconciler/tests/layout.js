/* Start / Pause / Stop belong at the right edge of the settings row. The row is a four-column grid,
 * and it once held only three children, so without being told otherwise the buttons sat in column 3
 * and left column 4 empty — a gap on the right with the buttons floating in the middle. The spare
 * column now holds the save controls, which is why the buttons must still be PINNED to the last one
 * rather than simply landing there.
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
const tracks = ((/grid-template-columns:([^;]*)/.exec(g4) || [])[1] || "").match(/minmax\([^)]*\)|[\d.]+fr|auto/g) || [];
check("the settings row is a 4-column grid", tracks.length === 4, tracks.join(" | "));
/* Tolerance and Parallel hold two or three characters; an equal quarter each was width the save
   controls needed to fit a toggle and a button on one line. */
check("…with the narrow fields narrower than the rest",
  /minmax\(110px,\.6fr\) minmax\(130px,\.6fr\)/.test(g4), g4);

const kids = (HTML.match(/<div class="grid g4">([\s\S]*?)\n      <\/div>/) || [])[1] || "";
const childDivs = (kids.match(/\n        <div[ >]/g) || []).length;
check("every column is used now", childDivs === 4, childDivs + " children");
/* the save controls are the third column, between Parallel and the run buttons */
check("…the third being where a run's results go",
  kids.indexOf('id="conc"') < kids.indexOf('id="saveSw"') &&
  kids.indexOf('id="saveSw"') < kids.indexOf('class="runbtns"'), "app.html");
check("…with the folder button beside the toggle, on one line",
  /id="saveSw"[\s\S]{0,300}?id="pickDir"/.test(kids) && /\.saverow\{[^}]*flex-wrap:nowrap/.test(HTML),
  "app.html");

/* ---- everything on the row is the same height ----
   Measured before the fix: input 41px, toggle 30px, folder button 32px. They align at the top
   because the row is align-items:start, so the mismatch shows up at the bottom, on one line. */
{
  check("there is one number for a control's height",
    /--ctl-h:\d+px;/.test(HTML), (HTML.match(/--ctl-h:[^;]*/) || ["not defined"])[0]);
  check("…and the save controls use it, rather than their own",
    /\.saverow \.srvsw, \.saverow \.btn\{min-height:var\(--ctl-h\)\}/.test(HTML), "app.html");
  /* it has to match what an input actually comes out as: padding + border, top and bottom */
  const inp = (HTML.match(/input,select,textarea\{([^}]*)\}/) || [])[1] || "";
  check("…and it is the height an input really is",
    /padding:10px 12px/.test(inp) && /border:1px/.test(inp) && /--ctl-h:41px/.test(HTML),
    inp.slice(0, 60));
}

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

/* ---- the tiles mean different things in the two modes, so they cannot keep one set of colours ----
   Grey is the colour of "nothing to do here" — CW Empty, Zero Pay. In two-server mode the same two
   slots hold "Missing on Actual", which is money that did not survive the migration and the most
   serious verdict a run can reach, and "Extra on Actual", which counts as a problem too (notOk).
   Both were being painted the benign grey while a lesser finding sat beside them in red. */
{
  const APP = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

  check("the mode reaches the tiles at all",
    /document\.body\.classList\.toggle\("srv", srvMode\);/.test(APP), "app.js");
  /* applyTheme() used to assign body.className outright, which wiped .srv the moment the theme was
     switched. Nothing depended on it before, which is exactly why it went unnoticed. */
  check("…and the theme stops wiping it",
    /document\.body\.classList\.toggle\("light", t === "light"\)/.test(APP) &&
    !/document\.body\.className =/.test(APP), "app.js");
  ["cw", "zero"].forEach(function (f) {
    check('…"' + f + '" is not benign grey in two-server mode',
      new RegExp('body\\.srv \\.tile\\[data-f="' + f + '"\\] \\.dot\\{background:var\\(--(no|warn)\\)').test(HTML),
      "app.html");
    /* the chip under the tile has to agree with it, or the two say different things about one bucket */
    check('…and its filter chip agrees',
      new RegExp('body\\.srv \\.filters \\.fb\\[data-f="' + f + '"\\]\\{color:var\\(--(no|warn)\\)').test(HTML),
      "app.html");
  });
  check("…while a single-server run keeps the colours it had",
    /\.filters \.fb\[data-f="cw"\]\{color:#9aa3bd\}/.test(HTML), "app.html");
}

/* ---- an action should not look like a filter ----
   The three exports sat in the same grey chip as the filter chips beside them, so downloading a
   report read as another way to narrow the list. */
{
  check("the exports are marked as something else",
    (HTML.match(/class="fb dl"/g) || []).length === 3,
    (HTML.match(/class="fb dl"/g) || []).length + " of 3");
  check("…and look it", /\.filters \.fb\.dl\{/.test(HTML), "app.html");
  check("…in both themes", /body\.light \.filters \.fb\.dl\{/.test(HTML), "app.html");
}

/* ---- no leftover inline copy to drift out of sync ---- */
check("the styles live in the class, not inline on the div",
  !/<div style="[^"]*grid-column:4/.test(HTML), "inline copy still present");

console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
process.exit(fail ? 1 : 0);
