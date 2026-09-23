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
   controls needed to fit a toggle and a button on one line. The exact fractions have been tuned
   more than once, so what is checked is the ordering, not the numbers. */
{
  const fr = tracks.map(function (t) { return parseFloat((/([\d.]+)fr/.exec(t) || [0, 0])[1]); });
  check("…with the two short fields taking a smaller share than the rest",
    fr[0] < fr[2] && fr[1] < fr[2] && fr[0] < fr[3] && fr[1] < fr[3], fr.join(" / "));
}

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
    /padding:8px 12px/.test(inp) && /border:1px/.test(inp) && /--ctl-h:37px/.test(HTML),
    inp.slice(0, 60));
}

/* ---- and level, and flush ----
   Measured on the settings row: the four controls were 41px each and their bottoms still did not
   line up, and 93px of nothing sat between the Folder button and the run buttons.

   The gap was the column being wider than what it held. The 2px was stranger: the toggle is a
   <label>, and the page gives field labels a 5px bottom margin so they stand off their input. That
   margin made the flex row 46px tall while the toggle stayed 41, and align-items:center then put
   everything else 2px lower — the row read as uneven for a reason that was nowhere near the row. */
{
  check("the toggle is not carrying a field label's margin",
    /\.srvsw\{margin:0;/.test(HTML), (/\.srvsw\{[^;]*/.exec(HTML) || [""])[0]);
  /* the header still needs its own margin-left, and is more specific, so it survives that reset */
  check("…while the header toggle keeps the margin that places it",
    /\.ch \.srvsw\{margin-left:auto\}/.test(HTML), "app.html");
  /* a label rule that no longer sets a bottom margin would make the reset above pointless, and the
     next person to widen the row would not know why it was there */
  check("…and that margin is really where it comes from",
    /label\{[^}]*margin-bottom:5px/.test(HTML), (/label\{[^}]*\}/.exec(HTML) || [""])[0]);

  check("the toggle fills what the button leaves",
    /\.saverow \.srvsw\{flex:1 1 auto;min-width:0\}/.test(HTML) &&
    /\.saverow \.btn\{flex:0 0 auto\}/.test(HTML), "app.html");
  /* the column had a third of the row and its contents needed a quarter of it */
  check("…and its column is no wider than they need",
    /minmax\(240px,1fr\)/.test(HTML), (/\.g4\{[^}]*\}/.exec(HTML) || [""])[0]);
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
  /\.g3,\.g4[^{]*\{grid-template-columns:1fr\}/.test(mq), mq);
check("…the CRM base+mode row collapses there too",
  /\.crmtop[^{]*\{grid-template-columns:1fr\}/.test(mq), mq);

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
  /* A selected chip IS the accent block, so its text is white whatever colour its bucket wears.
     The base rule says that, but the two srv rules above are a class more specific than it — and
     come later — so a selected "Missing on Actual" kept its red on the purple and went muddy. */
  check("a selected chip is white whatever its bucket colour",
    /body\.srv \.filters \.fb\.active\{color:#fff\}/.test(HTML), "app.html");
  /* equal weight, so it only wins by being last: it has to stay below them */
  check("…and says so after the rules it has to beat",
    HTML.indexOf('body.srv .filters .fb.active{color:#fff}') >
      HTML.lastIndexOf('body.srv .filters .fb[data-f='), "app.html");

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
  /* Loose in the row they wrap one at a time: in Bengali, where the filter chips are longer, the
     third ended up alone on the next line at the far left, reading as a stray control. */
  check("…and wrap as one group, not one at a time",
    /<div class="dlgroup">[\s\S]*?id="html"[\s\S]*?id="xlsx"[\s\S]*?id="raw"[\s\S]*?<\/div>/.test(HTML) &&
    /\.filters \.dlgroup\{margin-left:auto/.test(HTML), "app.html");
  check("…with no leftover inline push on the first one",
    !/id="html"[^>]*margin-left:auto/.test(HTML), "app.html");
  check("…in both themes", /body\.light \.filters \.fb\.dl\{/.test(HTML), "app.html");
}

/* ---- the parts the browser draws, not the page ----
   Scrollbars, the caret, the selection highlight, a number input's spinner and the list a <select>
   drops down are all painted by the browser, and it paints them light unless told the surface is
   dark. On the dark theme that put a white bar down the side of every scrolling box. */
{
  const APP = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");
  const CONTENT = fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8");
  const PANEL = fs.readFileSync(path.join(__dirname, "..", "panel.html"), "utf8");

  check("the page says which way round it is", /color-scheme:dark/.test(HTML), "app.html");
  check("…and says so again on the light theme",
    /body\.light\{[^}]*color-scheme:light/.test(HTML), "app.html");
  /* The viewport's own scrollbar follows the ROOT element, and the theme class lives on <body> —
     so the stylesheet reaches every box inside the page but not the one down the side of it. */
  check("…and the theme switch reaches the root, where the page's own bar lives",
    /document\.documentElement\.style\.colorScheme = \(t === "light" \? "light" : "dark"\)/.test(APP),
    "app.js");
  /* the in-page panel scrolls inside UMS's own page, which is light — without this its bar is
     drawn to match the page behind it rather than the dark panel it is in */
  check("the in-page panel says so too", /#umsrec\{color-scheme:dark/.test(CONTENT), "content.js");
  check("…and follows the system theme", /#umsrec\{color-scheme:light/.test(CONTENT), "content.js");
  check("the pop-out window says so", /color-scheme:dark/.test(PANEL) && /color-scheme:light/.test(PANEL),
    "panel.html");
}

/* ---- no leftover inline copy to drift out of sync ---- */
check("the styles live in the class, not inline on the div",
  !/<div style="[^"]*grid-column:4/.test(HTML), "inline copy still present");

console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
process.exit(fail ? 1 : 0);
