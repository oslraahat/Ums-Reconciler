"use strict";
/* summary statistics over a list of numbers, and a compact millisecond formatter for display */

function stats(xs) {
  const v = xs.filter(function (x) { return typeof x === "number" && isFinite(x); }).sort(function (a, b) { return a - b; });
  if (!v.length) return null;
  const at = function (p) { return v[Math.min(v.length - 1, Math.floor(p * (v.length - 1)))]; };
  const sum = v.reduce(function (a, b) { return a + b; }, 0);
  return { n: v.length, min: v[0], median: at(0.5), p95: at(0.95), max: v[v.length - 1], mean: Math.round(sum / v.length) };
}
const ms = function (n) { return n == null ? "  —  " : (n >= 1000 ? (n / 1000).toFixed(1) + "s" : n + "ms"); };

module.exports = { stats: stats, ms: ms };
