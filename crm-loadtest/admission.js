#!/usr/bin/env node
"use strict";
/* admission.js — one UMS new-student admission on an already-logged-in page, timed.
 *
 * This is the engine behind the extension's "New Admission" load test: "how fast can I complete 1
 * — or 1000 — admissions?". The flow is ported from the proven UMS-Admission-Dashboard project
 * (ums-admission-blast.js): fill the NewStudentAdmission form, cascade the Class → Program →
 * Session → Branch dropdowns, pick a course through its batch-day → batch-time → batch cascade,
 * open the payment section, pay the minimum, submit, and read back the Registration Number.
 *
 * The caller (the host, or a CLI) logs in once and hands a page in; admit() drives one admission
 * and returns { ok, reg, ms }. Nothing is typed by a human: the name is a random unique nickname,
 * every dropdown value is read off the page itself. Only the mobile number (and how many) comes
 * from the user.
 *
 * IMPORTANT: this creates a REAL admission record on the server it runs against — it is a load /
 * throughput test for a test or demo UMS, not something to point at production.
 *
 * This file is a thin entry point: the flow lives under src/ (src/admission/admit.js,
 * src/admission/configure.js, src/lib/names.js) and the CLI orchestration in src/admission.js.
 * The re-exports below keep the module surface host/host.js depends on (admit, …).
 */
const { main } = require("./src/admission");
const { admit, DEFAULTS } = require("./src/admission/admit");
const { configureCourse } = require("./src/admission/configure");
const { uniqueName } = require("./src/lib/names");

module.exports = { admit: admit, configureCourse: configureCourse, uniqueName: uniqueName, DEFAULTS: DEFAULTS };

if (require.main === module) main();
