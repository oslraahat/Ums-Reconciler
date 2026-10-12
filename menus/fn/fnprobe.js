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
    window.__fnErr = [];
    var push = function (s) { try { if (window.__fnErr.length < 20) window.__fnErr.push(String(s).slice(0, 200)); } catch (_) {} };
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
          var src = el.src || el.href || "";
          push("লোড হয়নি <" + tag + ">: " + (src || "(src নেই)"));
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
