#!/usr/bin/env node
"use strict";
/* Load-test the UMS CRM Dashboard.
 *
 * The question this answers: when many people are logged in and open
 * /Student/CrmConversation/Dashboard at the same time, does it get slow — and if so, is it the
 * server taking longer to answer, or the browser taking longer to draw what it answered?
 *
 * A browser extension cannot do this. It lives inside one browser, and one browser is one person:
 * log a second user in and the first is logged out, because a site keeps one session per browser.
 * "Fifty people at once" needs fifty separate sessions, and the only thing that makes those is a
 * separate cookie jar each. Playwright's browser contexts are exactly that — N isolated sessions
 * inside one real Chrome, each like its own incognito window that does not share cookies with the
 * others — so N users can be logged in together and hit the page together, which is the whole test.
 *
 * Two phases:
 *   1. Log everyone in (up to `count` at a time), each in their own context. Report who got in.
 *   2. Have all the logged-in users open the Dashboard together, and time each open — separating
 *      the server's part (request sent → last byte back) from the browser's part (last byte →
 *      page finished drawing), because those are two different kinds of slow with two different
 *      fixes.
 *
 * It drives the Chrome already installed on the machine (channel: "chrome"); nothing is downloaded.
 *
 *   node loadtest.js --base https://ums-41.osl.team --users users.txt --count 10
 *   node loadtest.js --base https://ums-41.osl.team --users users.txt --count 25 --headed
 *
 * See --help for every option.
 *
 * This file is a thin entry point: the pieces live under src/ (src/lib, src/browser) and the
 * two-phase orchestration in src/loadtest.js. The re-exports below keep the module surface that
 * host/host.js and admission.js depend on (login, hitDashboard, ms, …).
 */
const { main } = require("./src/loadtest");
const { parseArgs } = require("./src/lib/args");
const { readUsers } = require("./src/lib/users");
const { stats, ms } = require("./src/lib/stats");
const { login } = require("./src/browser/login");
const { hitDashboard } = require("./src/browser/dashboard");

if (require.main === module) {
  main().catch(function (e) { console.error("\nfailed: " + (e && e.stack || e)); process.exit(1); });
}
module.exports = { readUsers: readUsers, stats: stats, parseArgs: parseArgs,
  login: login, hitDashboard: hitDashboard, ms: ms };
