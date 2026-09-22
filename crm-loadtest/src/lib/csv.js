"use strict";
/* quote a single CSV field only when it needs it */

function csv(s) { s = String(s == null ? "" : s); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

module.exports = { csv: csv };
