/* In-tool updater. Two parts:
   1) A check on load (and on tab focus) that drops a banner when the GitHub repo has a newer build.
   2) A topbar "⟳ Update" button that actually DOES the update from inside the tool: it downloads the
      latest code zip from the public repo, unzips it in the browser, and writes the files straight
      into the extension folder through the File System Access API (the same API the tool already uses
      for "save to folder"), then offers to reload the extension. No update.bat, no chrome://extensions.

   The one thing Chrome can't skip: an unpacked extension only picks up new files when it is RELOADED,
   so after writing we call chrome.runtime.reload(). The user grants the extension folder once (a
   readwrite directory handle, remembered in IndexedDB); after that it's a single click.

   Change REPO/BRANCH if the deploy source moves. */
(function () {
  "use strict";
  var REPO = "oslraahat/Ums-Reconciler";
  var BRANCH = "development";
  var MANIFEST_URL = "https://raw.githubusercontent.com/" + REPO + "/" + BRANCH + "/ums-reconciler/manifest.json";
  var ZIP_URL = "https://codeload.github.com/" + REPO + "/zip/refs/heads/" + BRANCH;   // final URL, no github.com redirect
  var ZIP_ROOT = "Ums-Reconciler-" + BRANCH + "/ums-reconciler/";   // the folder inside the archive we want

  function running() { try { return chrome.runtime.getManifest().version; } catch (e) { return ""; } }
  function newer(a, b) {
    var A = String(a).split("."), B = String(b).split("."), n = Math.max(A.length, B.length);
    for (var i = 0; i < n; i++) { var x = parseInt(A[i] || "0", 10) || 0, y = parseInt(B[i] || "0", 10) || 0; if (x !== y) return x - y; }
    return 0;
  }

  /* ---- remember the extension-folder handle across sessions ---- */
  function idb(run) {
    return new Promise(function (resolve, reject) {
      var q; try { q = indexedDB.open("umsrec_update", 1); } catch (e) { reject(e); return; }
      q.onupgradeneeded = function () { try { q.result.createObjectStore("h"); } catch (e) {} };
      q.onerror = function () { reject(q.error); };
      q.onsuccess = function () {
        var db = q.result;
        try {
          var tx = db.transaction("h", "readwrite"), st = tx.objectStore("h"), r = run(st);
          tx.oncomplete = function () { resolve(r && r.result); };
          tx.onerror = function () { reject(tx.error); };
        } catch (e) { reject(e); }
      };
    });
  }
  function savedDir() { return idb(function (st) { return st.get("dir"); }).catch(function () { return null; }); }
  function rememberDir(h) { return idb(function (st) { return st.put(h, "dir"); }).catch(function () {}); }

  /* the extension folder, with readwrite permission — reuse the remembered one or ask the user to pick
     it (must be the "ums-reconciler" folder, i.e. the one that holds manifest.json) */
  async function ensureDir() {
    var h = await savedDir();
    if (h) {
      try {
        var p = await h.queryPermission({ mode: "readwrite" });
        if (p !== "granted") p = await h.requestPermission({ mode: "readwrite" });
        if (p === "granted") { try { await h.getFileHandle("manifest.json"); return h; } catch (e) {} }
      } catch (e) {}
    }
    if (!self.showDirectoryPicker) throw new Error("এই ব্রাউজার in-tool আপডেট সাপোর্ট করে না — update.bat ব্যবহার করো");
    h = await self.showDirectoryPicker({ mode: "readwrite", id: "umsrec-ext" });
    try { await h.getFileHandle("manifest.json"); }
    catch (e) { throw new Error("ভুল ফোল্ডার — যেটাতে manifest.json আছে সেই \"ums-reconciler\" ফোল্ডারটা বাছো"); }
    await rememberDir(h);
    return h;
  }

  /* ---- unzip everything under ZIP_ROOT ---- */
  async function inflate(u8) {
    var ds = new DecompressionStream("deflate-raw");
    var s = new Response(u8).body.pipeThrough(ds);
    return new Uint8Array(await new Response(s).arrayBuffer());
  }
  async function unzipExtension(buf) {
    var u8 = new Uint8Array(buf), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    var eocd = -1;
    for (var i = u8.length - 22; i >= 0; i--) { if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; } }
    if (eocd < 0) throw new Error("ডাউনলোড করা ফাইল ZIP নয়");
    var count = dv.getUint16(eocd + 10, true), off = dv.getUint32(eocd + 16, true), td = new TextDecoder("utf-8");
    var out = [];
    for (var n = 0; n < count; n++) {
      if (dv.getUint32(off, true) !== 0x02014b50) break;
      var method = dv.getUint16(off + 10, true), cs = dv.getUint32(off + 20, true),
        nl = dv.getUint16(off + 28, true), el = dv.getUint16(off + 30, true), cl = dv.getUint16(off + 32, true),
        lho = dv.getUint32(off + 42, true);
      var name = td.decode(u8.subarray(off + 46, off + 46 + nl));
      off += 46 + nl + el + cl;
      if (name.indexOf(ZIP_ROOT) !== 0) continue;
      var rel = name.slice(ZIP_ROOT.length);
      if (!rel || rel.charAt(rel.length - 1) === "/") continue;   // skip the folder entries
      var lnl = dv.getUint16(lho + 26, true), lel = dv.getUint16(lho + 28, true), ds0 = lho + 30 + lnl + lel;
      var comp = u8.subarray(ds0, ds0 + cs);
      var bytes = method === 0 ? comp.slice() : (method === 8 ? await inflate(comp) : null);
      if (bytes) out.push({ path: rel, bytes: bytes });
    }
    if (!out.length) throw new Error("ZIP-এ ums-reconciler ফাইল পাওয়া গেল না");
    return out;
  }

  /* write each file into the folder, creating sub-folders (menus/…, lib/…) as needed */
  async function writeAll(root, files) {
    for (var i = 0; i < files.length; i++) {
      var parts = files[i].path.split("/"), dir = root;
      for (var j = 0; j < parts.length - 1; j++) dir = await dir.getDirectoryHandle(parts[j], { create: true });
      var fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
      var w = await fh.createWritable();
      await w.write(files[i].bytes);
      await w.close();
    }
  }

  function setBtn(txt, disabled) {
    var b = document.getElementById("updBtn"); if (!b) return;
    b.textContent = txt; b.disabled = !!disabled;
  }

  async function runUpdate() {
    var cur = running();
    var b = document.getElementById("updBtn"); var label = (b && b.dataset && b.dataset.label) || "⟳ Update";
    try {
      setBtn("⏳ দেখছি…", true);
      var latest = "";
      try { var r = await fetch(MANIFEST_URL, { cache: "no-store" }); if (r.ok) { var m = await r.json(); latest = m && m.version; } } catch (e) {}
      if (latest && newer(latest, cur) <= 0) {
        setBtn("✓ সর্বশেষ", false);
        setTimeout(function () { setBtn(label, false); }, 2500);
        return;
      }
      setBtn("📁 ফোল্ডার…", true);
      var dir = await ensureDir();
      setBtn("⏳ নামাচ্ছি…", true);
      var resp = await fetch(ZIP_URL, { cache: "no-store" });
      if (!resp.ok) throw new Error("ডাউনলোড ব্যর্থ (" + resp.status + ")");
      var buf = await resp.arrayBuffer();
      setBtn("⏳ লিখছি…", true);
      var files = await unzipExtension(buf);
      await writeAll(dir, files);
      var banner = document.getElementById("updBanner"); if (banner) try { banner.remove(); } catch (e) {}
      setBtn("✓ হয়ে গেছে", true);
      var doReload = self.confirm ? confirm("আপডেট হয়ে গেছে (v" + (latest || "?") + ")। এখন extension reload দেব? (reload-এর পর এই পেজটা আবার খুলতে হতে পারে)") : true;
      if (doReload && chrome.runtime && chrome.runtime.reload) chrome.runtime.reload();
      else setBtn(label, false);
    } catch (e) {
      setBtn(label, false);
      if (self.alert) alert("আপডেট হলো না: " + ((e && e.message) || e));
    }
  }

  /* ---- notification banner (unchanged behaviour) ---- */
  function showBanner(latest, cur) {
    if (typeof document === "undefined" || !document.body || document.getElementById("updBanner")) return;
    var bar = document.createElement("div");
    bar.id = "updBanner";
    bar.style.cssText = "position:fixed;left:0;right:0;bottom:0;z-index:9999;background:#ffb454;color:#3a2606;" +
      "font:600 13px/1.45 system-ui,'Segoe UI','Noto Sans Bengali',sans-serif;padding:10px 44px 10px 16px;" +
      "display:flex;gap:12px;align-items:center;justify-content:center;text-align:center;box-shadow:0 -2px 14px rgba(0,0,0,.3)";
    var msg = document.createElement("span");
    msg.textContent = "🔔 নতুন আপডেট আছে — v" + latest + " (তুমি v" + cur + "-এ)।";
    bar.appendChild(msg);
    var go = document.createElement("button");
    go.textContent = "এখনই আপডেট করো";
    go.style.cssText = "background:#3a2606;color:#ffd98a;border:none;border-radius:7px;padding:6px 12px;font-weight:800;cursor:pointer;font-size:12.5px";
    go.addEventListener("click", runUpdate);
    bar.appendChild(go);
    var x = document.createElement("button");
    x.textContent = "✕"; x.title = "বন্ধ করো";
    x.style.cssText = "position:absolute;right:12px;top:50%;transform:translateY(-50%);background:transparent;border:none;color:#3a2606;font-weight:800;font-size:16px;cursor:pointer;line-height:1";
    x.addEventListener("click", function () { try { bar.remove(); } catch (e) {} });
    bar.appendChild(x);
    document.body.appendChild(bar);
  }

  var lastCheck = 0;
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
            showBanner(latest, cur);
            var b = document.getElementById("updBtn"); if (b) { b.textContent = "⟳ Update ●"; b.style.background = "rgba(255,180,84,.35)"; }
          }
        })
        .catch(function () {});
    } catch (e) {}
  }

  function init() {
    var b = document.getElementById("updBtn");
    if (b) { if (b.dataset) b.dataset.label = b.textContent; b.addEventListener("click", runUpdate); }
    check();
  }
  if (typeof document !== "undefined" && document.addEventListener) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();
    document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") check(); });
  }
})();
