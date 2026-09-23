/* In-tool update helper.
   Chrome will not let an extension write to its own (loaded) folder — the File System Access API
   aborts it "due to security policy", by design, so a fully in-tool self-install is impossible. So
   this does the two things that DO work reliably:
     • Notify: check the GitHub repo and, when there's a newer build, reveal the topbar "↓ Update"
       button and drop a bottom panel.
     • Act: the panel gives the two-step update that actually works — run update.bat (it writes the
       files from outside Chrome), then Reload — with a one-click Reload (chrome.runtime.reload) and a
       "Download zip" button (chrome.downloads) for anyone who doesn't have update.bat handy.
   Text follows the tool language (self.APP.getLang). Change REPO/BRANCH if the deploy source moves. */
(function () {
  "use strict";
  var REPO = "oslraahat/Ums-Reconciler";
  var BRANCH = "development";
  var MANIFEST_URL = "https://raw.githubusercontent.com/" + REPO + "/" + BRANCH + "/ums-reconciler/manifest.json";
  var ZIP_URL = "https://codeload.github.com/" + REPO + "/zip/refs/heads/" + BRANCH;

  function running() { try { return chrome.runtime.getManifest().version; } catch (e) { return ""; } }
  function newer(a, b) {
    var A = String(a).split("."), B = String(b).split("."), n = Math.max(A.length, B.length);
    for (var i = 0; i < n; i++) { var x = parseInt(A[i] || "0", 10) || 0, y = parseInt(B[i] || "0", 10) || 0; if (x !== y) return x - y; }
    return 0;
  }
  function isEn() { try { return self.APP && self.APP.getLang && self.APP.getLang() === "en"; } catch (e) { return false; } }
  function L(bn, en) { return isEn() ? en : bn; }
  function idleLabel() { try { if (self.APP && self.APP.t) return self.APP.t("upd_btn"); } catch (e) {} return L("⬇ আপডেট", "⬇ Update"); }

  function reloadExt() { try { if (chrome.runtime && chrome.runtime.reload) chrome.runtime.reload(); } catch (e) {} }
  function downloadZip() {
    try {
      if (chrome.downloads && chrome.downloads.download) chrome.downloads.download({ url: ZIP_URL, filename: "Ums-Reconciler-" + BRANCH + ".zip" });
      else self.open(ZIP_URL, "_blank");
    } catch (e) { try { self.open(ZIP_URL, "_blank"); } catch (e2) {} }
  }

  function btn(label, cls, onClick) {
    var b = document.createElement("button");
    b.className = "updb" + (cls ? " " + cls : "");
    b.textContent = label;
    b.addEventListener("click", onClick);
    return b;
  }
  function showPanel(latest, cur) {
    if (typeof document === "undefined" || !document.body) return;
    var old = document.getElementById("updPanel"); if (old) try { old.remove(); } catch (e) {}
    var p = document.createElement("div");
    p.id = "updPanel"; p.className = "on";
    var msg = document.createElement("span");
    msg.className = "updmsg";
    msg.textContent = L(
      "🔔 নতুন আপডেট — v" + latest + " (তুমি v" + cur + "-এ)।  আপডেট করতে: ১) update.bat চালাও, তারপর ২) Reload চাপো।",
      "🔔 New update — v" + latest + " (you have v" + cur + ").  To update: 1) run update.bat, then 2) click Reload.");
    p.appendChild(msg);
    p.appendChild(btn(L("↻ Reload", "↻ Reload"), "", reloadExt));
    p.appendChild(btn(L("⬇ zip নামাও", "⬇ Download zip"), "sec", downloadZip));
    var x = document.createElement("button");
    x.className = "updx"; x.textContent = "✕"; x.title = L("বন্ধ করো", "Close");
    x.addEventListener("click", function () { try { p.remove(); } catch (e) {} });
    p.appendChild(x);
    document.body.appendChild(p);
  }

  /* One-click auto-update via the native host (the CRM load-test host — it runs outside Chrome, so it
     CAN write the extension folder). If the host isn't installed / fails, fall back to the panel. */
  var HOST = "com.umsreconciler.crmloadtest";
  function setBtn(txt, dis) { var b = document.getElementById("updBtn"); if (b) { b.textContent = txt; b.disabled = !!dis; } }
  function stageText(s) {
    var bn = { download: "নামছে…", extract: "খুলছে…", write: "লিখছে…" }, en = { download: "Downloading…", extract: "Extracting…", write: "Installing…" };
    return L(bn[s] || "…", en[s] || "…");
  }
  function autoUpdate(cur) {
    var done = false;
    function fallback() { setBtn(idleLabel(), false); showPanel(latestVer || cur, cur); }
    try {
      setBtn(L("⏳ আপডেট হচ্ছে…", "⏳ Updating…"), true);
      var port = chrome.runtime.connectNative(HOST);
      port.onMessage.addListener(function (msg) {
        if (!msg) return;
        if (msg.type === "updateOut") setBtn("⏳ " + stageText(msg.stage), true);
        else if (msg.type === "updated") { done = true; try { port.disconnect(); } catch (e) {} setBtn(L("✓ হয়ে গেছে — reload", "✓ Done — reloading"), true); setTimeout(function () { try { if (chrome.runtime.reload) chrome.runtime.reload(); } catch (e) {} }, 500); }
        else if (msg.type === "error") { done = true; try { port.disconnect(); } catch (e) {} if (self.alert) alert(L("আপডেট হলো না: ", "Update failed: ") + (msg.text || "")); fallback(); }
      });
      port.onDisconnect.addListener(function () { if (!done) fallback(); });   // host missing → manual panel
      port.postMessage({ action: "update" });
    } catch (e) { fallback(); }
  }

  var lastCheck = 0, hasUpdate = false, latestVer = "";
  function check() {
    var now = Date.now();
    if (now - lastCheck < 60000) return;
    lastCheck = now;
    var cur = running(); if (!cur) return;
    try {
      fetch(MANIFEST_URL, { cache: "no-store" })
        .then(function (r) { return r && r.ok ? r.json() : null; })
        .then(function (m) {
          var latest = m && m.version;
          if (latest && newer(latest, cur) > 0) {
            hasUpdate = true; latestVer = latest;
            var b = document.getElementById("updBtn");
            if (b) { b.style.display = "inline-flex"; b.textContent = idleLabel(); b.title = L("নতুন আপডেট — v" + latest, "New update — v" + latest); }
            showPanel(latest, cur);
          }
        })
        .catch(function () {});
    } catch (e) {}
  }

  function init() {
    var b = document.getElementById("updBtn");
    if (b) b.addEventListener("click", function () { if (hasUpdate) autoUpdate(running()); else check(); });
    check();
  }
  if (typeof document !== "undefined" && document.addEventListener) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();
    document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") check(); });
  }
})();
