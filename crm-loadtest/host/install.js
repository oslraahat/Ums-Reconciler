#!/usr/bin/env node
"use strict";
/* Register the native-messaging host so the extension's Run button can reach it.
 *
 * This writes the host manifest (with the real absolute paths and the one extension ID allowed to
 * connect) and points Chrome — and Edge — at it through a per-user registry key. Nothing here
 * needs admin rights; it is all under HKEY_CURRENT_USER. Run it once, then reload the extension.
 *
 *   node install.js                 # uses the default extension id below
 *   node install.js --ext <id>      # if your unpacked extension has a different id
 *   node install.js --uninstall     # remove the registry keys and the manifest
 *
 * The extension id is shown at chrome://extensions with Developer mode on, and in the address bar
 * when the dashboard is open (chrome-extension://<id>/app.html).
 */
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const HOST_NAME = "com.umsreconciler.crmloadtest";
const DEFAULT_EXT = "nckmmnajiljhljgalonghmllifnbokdk";   // fixed by manifest "key" — stable regardless of the unpacked folder path
const HERE = __dirname;
const MANIFEST = path.join(HERE, HOST_NAME + ".json");
const LAUNCHER = path.join(HERE, "run.bat");

const args = process.argv.slice(2);
const uninstall = args.indexOf("--uninstall") >= 0;
const extAt = args.indexOf("--ext");
const ext = extAt >= 0 ? args[extAt + 1] : DEFAULT_EXT;

const BROWSERS = [
  ["Chrome", "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\" + HOST_NAME],
  ["Edge", "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\" + HOST_NAME]
];

function reg(a) { return execFileSync("reg", a, { encoding: "utf8" }); }

if (uninstall) {
  BROWSERS.forEach(function (b) {
    try { reg(["delete", b[1], "/f"]); console.log("  removed the " + b[0] + " key"); }
    catch (e) { console.log("  no " + b[0] + " key to remove"); }
  });
  try { fs.unlinkSync(MANIFEST); console.log("  removed the manifest"); } catch (e) {}
  console.log("\n  done. reload the extension.\n");
  process.exit(0);
}

if (process.platform !== "win32") {
  console.error("This installer is for Windows. On macOS/Linux the manifest goes under\n" +
    "~/.config/google-chrome/NativeMessagingHosts/ (or the Chromium/Edge equivalent) instead.");
  process.exit(2);
}
if (!fs.existsSync(LAUNCHER)) { console.error("run.bat is missing next to install.js"); process.exit(2); }
if (!/^[a-p]{32}$/.test(ext)) {
  console.error('that does not look like an extension id (32 letters a-p): "' + ext + '"');
  process.exit(2);
}

/* the manifest Chrome reads: what to launch, and who is allowed to launch it */
const manifest = {
  name: HOST_NAME,
  description: "CRM Dashboard load-test runner for UMS Reconciler",
  path: LAUNCHER,
  type: "stdio",
  allowed_origins: ["chrome-extension://" + ext + "/"]
};
fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2));
console.log("\n  manifest written: " + MANIFEST);
console.log("  allowed extension: " + ext);

let ok = 0;
BROWSERS.forEach(function (b) {
  try { reg(["add", b[1], "/ve", "/t", "REG_SZ", "/d", MANIFEST, "/f"]); console.log("  registered for " + b[0]); ok++; }
  catch (e) { console.log("  could not register for " + b[0] + " (it may not be installed) — that is fine"); }
});

console.log(ok
  ? "\n  installed. RELOAD the extension (chrome://extensions → ↻) and the Run button will work.\n"
  : "\n  nothing registered — is Chrome or Edge installed for this user?\n");
