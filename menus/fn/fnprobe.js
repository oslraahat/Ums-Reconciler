/* Console-error collector for Function Check (Browser / Headless modes).
 * Registered dynamically at document_start in the MAIN world only while a deep sweep is running, so
 * it is NOT part of the always-on content scripts. It records uncaught errors / rejections into a
 * page global that the post-load probe reads back. It only listens — it changes nothing. */
(function () {
  try {
    // Neuter native dialogs the moment the page starts: an alert/confirm/prompt fired during page
    // LOAD blocks the page thread, which would hang our probe injection and time the page out even
    // though it opens fine by hand.
    try { window.alert = function () {}; window.confirm = function () { return true; }; window.prompt = function () { return null; }; } catch (_) {}
    if (window.__fnErr) return;
    window.__fnErr = [];    // things that actually break the page — these fail the check
    window.__fnWarn = [];   // cosmetic only (a picture that did not load) — never fails the check
    /* The same broken element usually appears more than once on a page, which printed the identical
       sentence twice. Collapse repeats into "… ×2" instead of listing them again. */
    var seen = {};
    var add = function (arr, s) {
      try {
        s = String(s).slice(0, 200);
        var k = (arr === window.__fnWarn ? "w|" : "e|") + s;
        var c = seen[k];
        if (c) { c.n++; arr[c.i] = s + " ×" + c.n; return; }
        if (arr.length >= 20) return;
        arr.push(s);
        seen[k] = { n: 1, i: arr.length - 1 };
      } catch (_) {}
    };
    var push = function (s) { add(window.__fnErr, s); };
    var frameOf = function (err) {
      try {
        var fr = String(err.stack || "").split("\n")[1] || "";
        fr = fr.trim().replace(/^at\s+/, "");
        return fr ? " @ " + fr.slice(0, 90) : "";
      } catch (_) { return ""; }
    };
    /* This listener is in the CAPTURE phase, which means it also fires for a resource that failed to
       load (a missing <script src>, <link>, <img>). Those events carry no message and no filename, so
       reporting them as "script error" said nothing — name the file that is actually missing instead.
       The other source of a blank message is a script served cross-origin without CORS headers, where
       the browser deliberately withholds the detail; say so rather than pretending it is unknown. */
    window.addEventListener("error", function (e) {
      try {
        var el = e && e.target;
        if (el && el !== window && el.tagName) {
          var tag = String(el.tagName).toLowerCase();
          // Read the ATTRIBUTE, not el.src: an empty src resolves against the document, so el.src
          // returned the PAGE's own address and the message looked as if the page had failed to load.
          var raw = el.getAttribute ? (el.getAttribute("src") || el.getAttribute("href") || "") : "";
          var where = raw ? (el.src || el.href || raw) : "src খালি — কোনো ঠিকানা বসানো নেই";
          // A picture that does not load is cosmetic; a missing script or stylesheet actually breaks
          // the page. Only the latter should fail the check.
          var cosmetic = /^(img|picture|source|video|audio|track)$/.test(tag);
          add(cosmetic ? window.__fnWarn : window.__fnErr, "লোড হয়নি <" + tag + ">: " + where);
          return;
        }
        var err = e && e.error;
        var m = (e && e.message) || (err && err.message) || "";
        if (!m || /^script error\.?$/i.test(m)) {
          push("cross-origin script error — ব্রাউজার বিস্তারিত দেখায় না"
            + (e && e.filename ? " (" + e.filename + ")" : ""));
          return;
        }
        if (err && err.name && m.indexOf(err.name) !== 0) m = err.name + ": " + m;
        if (e && e.filename) m += " (" + String(e.filename).split("/").pop() + ":" + (e.lineno || 0) + ":" + (e.colno || 0) + ")";
        else if (err) m += frameOf(err);
        push(m);
      } catch (_) {}
    }, true);
    window.addEventListener("unhandledrejection", function (e) {
      try {
        var r = e && e.reason;
        var m = (r && r.message) || String(r == null ? "" : r);
        if (r && r.name && m.indexOf(r.name) !== 0) m = r.name + ": " + m;
        if (r && r.stack) m += frameOf(r);
        push("unhandledrejection: " + m);
      } catch (_) {}
    });
  } catch (_) {}
})();
