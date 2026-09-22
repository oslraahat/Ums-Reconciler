"use strict";
/* argument parsing for the CRM Dashboard load test: DEFAULTS, parseArgs, and the --help text */

const DEFAULTS = {
  base: "",
  users: "",
  count: 10,
  headed: false,
  dash: "/Student/CrmConversation/Dashboard",
  login: "/Account/Login",
  userField: "",          // auto-detected when blank
  passField: "",          // auto-detected when blank
  wait: "load",           // "load" | "domcontentloaded" | "networkidle"
  navTimeout: 60000,      // per navigation, ms
  out: "",                // write a CSV here as well
  warmup: true,           // one lone user first, as the "not busy" baseline
  keepOpen: false,        // leave the browser open at the end instead of closing it
  maximize: false         // open the window maximized to the display (with --headed)
};

function parseArgs(argv) {
  const o = Object.assign({}, DEFAULTS);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = function () { return argv[++i]; };
    if (a === "--help" || a === "-h") { o.help = true; }
    else if (a === "--base") o.base = next();
    else if (a === "--users") o.users = next();
    else if (a === "--count") o.count = Math.max(1, parseInt(next(), 10) || 1);
    else if (a === "--headed") o.headed = true;
    else if (a === "--headless") o.headed = false;
    else if (a === "--dash") o.dash = next();
    else if (a === "--login") o.login = next();
    else if (a === "--user-field") o.userField = next();
    else if (a === "--pass-field") o.passField = next();
    else if (a === "--wait") o.wait = next();
    else if (a === "--nav-timeout") o.navTimeout = Math.max(1000, parseInt(next(), 10) || 60000);
    else if (a === "--out") o.out = next();
    else if (a === "--no-warmup") o.warmup = false;
    else if (a === "--keep-open") o.keepOpen = true;
    else if (a === "--maximize") o.maximize = true;
    else { console.error("unknown option: " + a); o.help = true; }
  }
  return o;
}

const HELP = `
CRM Dashboard load test — N isolated logins in parallel, timed.

  --base <url>          UMS address, e.g. https://ums-41.osl.team   (required)
  --users <file>        one "username,password" per line           (required)
                        (comma, tab or the first space separates the two;
                         blank lines and a "username,password" header are skipped)
  --count <n>           how many at once (default ${DEFAULTS.count})
  --headed              show the browser (default: hidden/headless)
  --dash <path>         the page to test (default ${DEFAULTS.dash})
  --login <path>        login page, if the site does not redirect there itself
                        (default ${DEFAULTS.login})
  --user-field <sel>    CSS selector for the username box (default: auto-detect)
  --pass-field <sel>    CSS selector for the password box (default: auto-detect)
  --wait <when>         when a load is "done": load | domcontentloaded | networkidle
                        (default ${DEFAULTS.wait})
  --nav-timeout <ms>    give up on a page after this long (default ${DEFAULTS.navTimeout})
  --out <file.csv>      also write the per-user numbers to a CSV
  --no-warmup           skip the single lone-user baseline
  --keep-open           leave the browser open at the end (for a look)
  --maximize            open the window maximized to the display (with --headed)
`;

module.exports = { DEFAULTS: DEFAULTS, parseArgs: parseArgs, HELP: HELP };
