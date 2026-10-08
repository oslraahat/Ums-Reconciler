/* Console-error collector for Function Check (Browser / Headless modes).
 * Registered dynamically at document_start in the MAIN world only while a deep sweep is running, so
 * it is NOT part of the always-on content scripts. It records uncaught errors / rejections into a
 * page global that the post-load probe reads back. It only listens — it changes nothing. */
(function () {
  try {
    if (window.__fnErr) return;
    window.__fnErr = [];
    window.addEventListener("error", function (e) {
      try {
        var m = (e && e.message) || (e && e.error && e.error.message) || "script error";
        if (e && e.filename) m += " (" + String(e.filename).split("/").pop() + ":" + (e.lineno || 0) + ")";
        window.__fnErr.push(String(m).slice(0, 140));
      } catch (_) {}
    }, true);
    window.addEventListener("unhandledrejection", function (e) {
      try {
        var r = e && e.reason;
        window.__fnErr.push("unhandledrejection: " + String((r && r.message) || r || "").slice(0, 120));
      } catch (_) {}
    });
  } catch (_) {}
})();
