/* In-tool update checker. On load it asks GitHub what the latest version is and, if that's newer
   than the running extension, drops a dismissible banner telling the user to pull the new code and
   reload — no store, no auto-update infrastructure, just a nudge that a newer build exists.

   It needs the repo (below) to be reachable without auth — a public repo, or a public raw URL. If
   the fetch fails for any reason (private repo, offline, rate limit) it stays silent: the tool works
   exactly as before, it just won't show the banner. host_permissions carries raw.githubusercontent
   so the cross-origin fetch is allowed. Change REPO/BRANCH here if the deploy source moves. */
(function () {
  "use strict";
  var REPO = "oslraahat/Ums-Reconciler";   // owner/repo the users deploy from
  var BRANCH = "development";               // the branch users pull (change to "main" if you tag releases there)
  var MANIFEST_URL = "https://raw.githubusercontent.com/" + REPO + "/" + BRANCH + "/ums-reconciler/manifest.json";

  function running() { try { return chrome.runtime.getManifest().version; } catch (e) { return ""; } }
  /* numeric, dotted-version compare: returns >0 when a is newer than b */
  function newer(a, b) {
    var A = String(a).split("."), B = String(b).split("."), n = Math.max(A.length, B.length);
    for (var i = 0; i < n; i++) { var x = parseInt(A[i] || "0", 10) || 0, y = parseInt(B[i] || "0", 10) || 0; if (x !== y) return x - y; }
    return 0;
  }
  function showBanner(latest, cur) {
    if (typeof document === "undefined" || !document.body || document.getElementById("updBanner")) return;
    var bar = document.createElement("div");
    bar.id = "updBanner";
    bar.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:9999;background:#ffb454;color:#3a2606;" +
      "font:600 13px/1.45 system-ui,'Segoe UI','Noto Sans Bengali',sans-serif;padding:10px 44px 10px 16px;" +
      "display:flex;gap:10px;align-items:center;justify-content:center;text-align:center;box-shadow:0 -2px 14px rgba(0,0,0,.3)";
    var msg = document.createElement("span");
    msg.textContent = "🔔 নতুন আপডেট আছে — v" + latest + " (তুমি v" + cur + "-এ)। নতুন কোড নিয়ে extension টা reload দাও।";
    bar.appendChild(msg);
    var x = document.createElement("button");
    x.textContent = "✕";
    x.title = "বন্ধ করো";
    x.style.cssText = "position:absolute;right:12px;top:50%;transform:translateY(-50%);background:transparent;border:none;" +
      "color:#3a2606;font-weight:800;font-size:16px;cursor:pointer;line-height:1";
    x.addEventListener("click", function () { try { bar.remove(); } catch (e) {} });
    bar.appendChild(x);
    document.body.appendChild(bar);
  }
  var lastCheck = 0;
  function check() {
    var now = Date.now();
    if (now - lastCheck < 60000) return;   // don't hammer GitHub — at most once a minute
    lastCheck = now;
    var cur = running(); if (!cur) return;
    try {
      fetch(MANIFEST_URL, { cache: "no-store" })
        .then(function (r) { return r && r.ok ? r.json() : null; })
        .then(function (m) { var latest = m && m.version; if (latest && newer(latest, cur) > 0) showBanner(latest, cur); })
        .catch(function () {});
    } catch (e) {}
  }

  if (typeof document !== "undefined" && document.addEventListener) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", check);
    else check();
    /* re-check when the tool tab comes back to the foreground, so a page left open for a while still
       notices a newer build without a manual refresh */
    document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") check(); });
  }
})();
