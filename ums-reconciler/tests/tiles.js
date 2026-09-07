/* "868 CW empty but 867 Total Problem — one too many?"
 *
 * A student is one Reg + Student PID pair — that is the key duplicate rows are dropped on at
 * import — so a Reg listed against two programs is two students. The tile was counting by Reg
 * alone, which made it read one short of the buckets above it. It now counts on the same basis as
 * every other tile, so it is always their exact sum.
 *
 *   node tests/tiles.js
 */
"use strict";
const fs = require("fs");
const path = require("path");

const APP = fs.readFileSync(path.join(__dirname, "..", "app.js"), "utf8");

let fail = 0;
const check = (name, ok, extra) => { if (!ok) fail++; console.log((ok ? "PASS  " : "FAIL  ") + name + (!ok && extra ? "   " + extra : "")); };

/* the real counting loop, lifted from app.js. "zero" — a student who never paid — is as clean as
   "ok": there is no money to reconcile, so it is not a problem anyone has to work on. */
const notOk = (st) => st !== "ok" && st !== "zero";

function tally(students) {
  const T = { ok: 0, no: 0, cw: 0, zero: 0, nf: 0, err: 0, stu: 0 };
  const bump = function (st) {
    if (st === "ok") T.ok++; else if (st === "no") T.no++; else if (st === "cw") T.cw++;
    else if (st === "zero") T.zero++; else if (st === "nf") T.nf++; else T.err++;
  };
  students.forEach(function (stu) {
    (stu.results || []).forEach(function (x) { bump(x.res.st); });
    (stu.results || []).forEach(function (x) { if (notOk(x.res.st)) T.stu++; });
  });
  return T;
}
const stu = (n, sts) => ({ reg: n, results: sts.map(function (s) { return { res: { st: s } }; }) });

/* ---- the reported case: 868 rows, one student with two programs ---- */
{
  const list = [];
  for (let i = 1; i <= 866; i++) list.push(stu("R" + i, ["cw"]));
  list.push(stu("R867", ["cw", "cw"]));          // one student, two programs
  const T = tally(list);
  check("868 programs counted", T.cw === 868, "cw=" + T.cw);
  check("Total Problem matches — a Reg with two PIDs is two students", T.stu === 868, "stu=" + T.stu);
  check("no gap left to explain", T.cw - T.stu === 0, T.cw - T.stu);
}

/* ---- the tile is exactly the sum of the failing buckets ---- */
{
  const T = tally([stu("A", ["cw"]), stu("B", ["no"]), stu("C", ["nf"])]);
  check("no duplicates → students == problem programs", T.stu === T.cw + T.no + T.nf, T.stu);
}

/* ---- one Reg against four programs is four students here ---- */
{
  const T = tally([stu("A", ["no", "cw", "nf", "error"])]);
  check("four bad programs → four, one per Reg + PID", T.stu === 4, "stu=" + T.stu);
  check("…and all four programs are still counted", T.no + T.cw + T.nf + T.err === 4);
}

/* ---- a Reg with one good and one bad program contributes only the bad one ---- */
{
  const T = tally([stu("A", ["ok", "cw"])]);
  check("only the failing program counts", T.stu === 1 && T.ok === 1 && T.cw === 1);
}

/* ---- nothing failing, nothing counted ---- */
{
  const T = tally([stu("A", ["ok", "ok"]), stu("B", ["ok"])]);
  check("clean students are not problems", T.stu === 0, "stu=" + T.stu);
}

/* ---- the tile has to say which unit it means ---- */
check("the tile carries a tooltip", /probTile\.title =/.test(APP), "app.js");
check("…naming students and programs separately",
  /probTile\.title = t\("tt_prob"\)/.test(APP), "app.js");
/* recountAll() and the live run each keep their own copy of the rule — they must not drift */
check("both counting sites use Reg + PID",
  (APP.match(/notOk\((?:x\.res\.st|res\.st)\)\) T\.stu\+\+/g) || []).length === 2,
  (APP.match(/notOk\(/g) || []).length + " notOk site(s)");
/* one definition of "needs a person", shared by the tile, its ⟳ and the filter — three copies of
   the same condition is how "zero" ends up excluded in one place and counted in another */
/* Two-server mode reuses the "zero" slot for "Actual has a row Expected never had", which IS a
   problem — so the rule now bends on the mode. Still ONE definition: the tile, its ⟳ and the
   filter must keep reading it from the same place. */
check("Total Problem, its re-run and its filter share one rule",
  /const notOk = function \(st\) \{ return srvMode \? st !== "ok" : \(st !== "ok" && st !== "zero"\); \};/.test(APP) &&
  /st === "prob" \? notOk\(x\.res\.st\)/.test(APP) &&
  /if \(filter === "prob"\) return notOk\(st\);/.test(APP), "app.js");
check("nobody counts by Reg alone any more",
  !/results\.some\(function \(x\) \{ return x\.res\.st !== "ok"; \}\)\) T\.stu/.test(APP), "app.js");

/* the EN wording must stay free of Bangla — the app has an English mode */
{
  ["tt_prob"].forEach(function (k) {
    const m = APP.match(new RegExp(k + ': \\{ bn: "[^"]*", en: "([^"]*)" \\}'));
    check(k + " has clean English", !!m && !/[ঀ-৿]/.test(m[1]), m ? m[1] : "not found");
  });
}
/* ---- the progress counter must count the same unit the tiles do ----
   "Done · 9832/9832" above tiles adding up to 10,515: T.total was students.length (unique Reg)
   while every tile counted Reg + PID, so on any sheet where one Reg carries two programs the two
   could never agree. Both sides count pairs now. */
{
  // startRun()'s worker loop, reduced to its counting
  const runLoop = function (students) {
    const T = { done: 0, total: 0, ok: 0, no: 0, cw: 0, nf: 0, err: 0 };
    T.total = students.reduce(function (n, s) { return n + s.results.length; }, 0);  // = entries.length
    students.forEach(function (stu) {
      stu.results.forEach(function (x) {
        const st = x.res.st;
        if (st === "ok") T.ok++; else if (st === "no") T.no++; else if (st === "cw") T.cw++;
        else if (st === "nf") T.nf++; else T.err++;
        T.done++;                       // per pair — inside the items loop
      });
    });
    return T;
  };
  // the reported run: 9,832 Regs · 10,515 pairs, 683 Regs carrying a second program
  const list = [];
  for (let i = 1; i <= 9149; i++) list.push(stu("R" + i, ["ok"]));
  for (let i = 1; i <= 683; i++) list.push(stu("D" + i, ["ok", i <= 350 ? "cw" : "ok"]));
  const T = runLoop(list);
  check("progress total counts pairs, not cards", T.total === 10515, "total=" + T.total);
  check("…and the card count is a different number", list.length === 9832, "cards=" + list.length);
  check("every pair is ticked off", T.done === T.total, T.done + "/" + T.total);
  check("progress agrees with the tiles", T.done === T.ok + T.no + T.cw + T.nf + T.err,
    T.done + " vs " + (T.ok + T.no + T.cw + T.nf + T.err));
}

/* the two lines that carry the rule — a refactor must not quietly put them back on Reg */
check("run total is entries.length", /T\.total = entries\.length;/.test(APP), "app.js");
check("…never students.length again", !/T\.total = students\.length/.test(APP), "app.js");
{
  // it has to sit between the per-pair push and the per-card renderStudent() — not after it
  const push = APP.indexOf("stu.results.push({ item");
  const card = APP.indexOf("renderStudent(stu);", push);
  const tick = APP.indexOf("T.done++;", push);
  check("T.done ticks per pair, inside the items loop",
    push > 0 && card > push && tick > push && tick < card, "push=" + push + " tick=" + tick + " card=" + card);
}
check("…not once per card", !/running--; T\.done\+\+/.test(APP), "app.js");

/* ---- Zero Pay is not a problem ----
   A student who never paid has nothing to reconcile: Program Wise carries rows but every figure on
   them is 0, so Course Wise having nothing is the correct outcome. compare() has always told this
   apart (`zeroPayment`), but statusOf() filed it under CW ফাঁকা and Total Problem counted it — so
   hundreds of perfectly ordinary records sat on the work list. Its own tile now, and outside the
   count. The Load error tile gave up its slot: a load failure retries itself instead. */
{
  const T = tally([stu("A", ["zero"]), stu("B", ["zero", "zero"]), stu("C", ["ok"])]);
  check("zero-pay programs are counted on their own tile", T.zero === 3, "zero=" + T.zero);
  check("…and none of them is a problem", T.stu === 0, "stu=" + T.stu);
  check("…nor are they filed as CW ফাঁকা", T.cw === 0, "cw=" + T.cw);
}
{
  // mixed: only the genuinely broken ones make the count
  const T = tally([stu("A", ["zero", "no"]), stu("B", ["zero"]), stu("C", ["cw"]), stu("D", ["ok"])]);
  check("Total Problem = the failing buckets, Zero Pay excluded",
    T.stu === T.no + T.cw + T.nf + T.err && T.stu === 2, "stu=" + T.stu);
  check("…while Zero Pay is still visible on its own", T.zero === 2, "zero=" + T.zero);
}

/* statusOf() must decide zero BEFORE cw — a zero-pay student has an empty Course Wise too, so
   testing cwEmpty first would swallow every one of them */
{
  const z = APP.indexOf('if (r.zeroPayment) return "zero";');
  const c = APP.indexOf('if (out.cwEmpty || r.emptyCourseWise) return "cw";');
  check("zero-pay is decided before CW ফাঁকা", z > 0 && c > z, "zero@" + z + " cw@" + c);
}

/* the tile, the filter and the export all have to know the new status */
{
  const HTML = fs.readFileSync(path.join(__dirname, "..", "app.html"), "utf8");
  check("the Load error tile is gone", !/data-f="error"/.test(HTML) && !/id="t-err"/.test(HTML), "app.html");
  check("…and Zero Pay took the slot", /data-f="zero"[\s\S]{0,300}id="t-zero"/.test(HTML), "app.html");
  check("the tile has a ⟳ of its own", /data-rr="zero"/.test(HTML), "app.html");
  check("there is a Zero Pay filter", /data-f="zero" data-i18n="f_zero"/.test(HTML), "app.html");
  check("paintTiles fills it", /\$\("t-zero"\)\.textContent = T\.zero/.test(APP), "app.js");
  check("the export knows the label", /zero: "Zero Pay"/.test(APP), "app.js");
  check("…and colours it clean, not amber", /\(st === "ok" \|\| st === "zero"\) \? "g"/.test(APP), "app.js");
  check("the tooltip says Zero Pay is outside the count", /Zero Pay এতে নেই/.test(APP), "app.js");
}

/* a load failure has no tile any more, so it must retry itself */
{
  check("a failed student is tried again, a named number of times",
    /for \(let a = 0; a < ITEM_TRIES; a\+\+\) \{\s*attempts = a \+ 1;\s*try \{ out = srvMode \? await testOneServers\(stu\.reg, spid\) : await testOne\(/.test(APP) &&
    +(/const ITEM_TRIES = (\d+);/.exec(APP) || [0, 0])[1] >= 3,
    (/const ITEM_TRIES = (\d+);/.exec(APP) || [])[1]);
  check("…with a growing pause between", /if \(a < ITEM_TRIES - 1\) await backoff\(a\)/.test(APP), "app.js");
  check("…but Stop cuts it short at once", /if \(e && e\.name === "AbortError"\) break;/.test(APP), "app.js");
}

/* ---- the English labels ----
   The same bucket is named in four places — the tile, the filter chip, the row pill and the two
   exports — and they had drifted apart in case and wording ("CW empty" beside "Only CW empty").
   One spelling per bucket, so a filter and the column it filters read the same. */
{
  const lbl = (k) => (APP.match(new RegExp(k + ': \{ bn: "[^"]*", en: "([^"]*)" \}')) || [])[1];
  // read the key off the STLBL line by hand — a \b inside a JS string literal is a backspace
  const STLBL_LINE = (APP.match(/const STLBL = .*/) || [""])[0];
  const STLBL = function (k) {
    const at = STLBL_LINE.indexOf(k + ': "');
    if (at < 0) return undefined;
    const from = at + k.length + 3;
    return STLBL_LINE.slice(from, STLBL_LINE.indexOf('"', from));
  };

  check("the CW bucket reads CW Empty everywhere",
    lbl("t_cw") === "CW Empty" && lbl("f_cw") === "CW Empty" &&
    lbl("pill_cw") === "CW Empty" && STLBL("cw") === "CW Empty",
    [lbl("t_cw"), lbl("f_cw"), lbl("pill_cw"), STLBL("cw")].join(" / "));
  check("…and Program Not Found likewise",
    lbl("t_nf") === "Program Not Found" && lbl("f_nf") === "Program Not Found" &&
    lbl("pill_nf") === "Program Not Found" && STLBL("nf") === "Program Not Found",
    [lbl("t_nf"), lbl("f_nf"), lbl("pill_nf"), STLBL("nf")].join(" / "));
  /* the chips sit directly under the tiles they filter — "Only Matched" under "Matched" read as
     two different things */
  check("a filter chip is named after its tile, with no 'Only'",
    lbl("f_ok") === "Matched" && lbl("f_no") === "Mismatch" && lbl("f_zero") === "Zero Pay",
    [lbl("f_ok"), lbl("f_no"), lbl("f_zero")].join(" / "));
  check("no 'Only …' label survives", !/en: "Only /.test(APP), (APP.match(/en: "Only [^"]*"/g) || []).join(", "));

  /* The exported HTML report used to hard-code its own filter buttons, which is exactly how they
     drifted from the app's. Every one of them now reads out of the same label table the tiles and
     the Status column use, so the guard is that none of them has grown its own copy again — and
     that the table still spells the buckets the way the tiles do. */
  check("the exported report takes its buttons from the label table, not its own copy",
    ["no", "cw", "zero", "ok", "nf"].every(function (k) {
      return new RegExp('data-f="' + k + '">. \\+ xesc\\(LBL\\.' + k + '\\)').test(APP);
    }), (APP.match(/data-f="\w+">[A-Z][^<']*</g) || []).join(", ") || "app.js");
  check("…and both label tables name every bucket",
    /const STLBL_SRV = \{[\s\S]*?nf: "[^"]+"[\s\S]*?\};/.test(APP) &&
    ["ok", "no", "error", "cw", "zero", "nf"].every(function (k) {
      return new RegExp("STLBL_SRV = \\{[\\s\\S]*?" + k + ': "').test(APP);
    }), "app.js");

  // the warn bucket went with v13.0.0; its labels lingered and would have shown up in a lang sweep
  check("no leftover Warning labels", !/t_warn|f_warn|pill_warn/.test(APP),
    (APP.match(/[tf]_warn|pill_warn/g) || []).join(", "));
}


console.log(fail ? "\n" + fail + " FAILED" : "\nসব ঠিক আছে");
process.exit(fail ? 1 : 0);
