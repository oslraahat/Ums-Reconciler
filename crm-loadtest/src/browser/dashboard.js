"use strict";
/* ---------------- one user: open the Dashboard, timed ---------------- */
/* The wall clock says how long the open took; the browser's own Navigation Timing says where the
   time went — responseEnd−requestStart is the server's share (request sent to last byte of HTML),
   loadEventEnd−responseEnd is the browser's (parsing, scripts, drawing). Under load one of those
   two grows, and which one is the answer. */
async function hitDashboard(page, url, opts) {
  const t0 = Date.now();
  let status = 0;
  try {
    const resp = await page.goto(url, { waitUntil: opts.wait, timeout: opts.navTimeout });
    status = resp ? resp.status() : 0;
  } catch (e) {
    return { ok: false, why: (e.message || String(e)).split("\n")[0].slice(0, 80), wall: Date.now() - t0 };
  }
  const wall = Date.now() - t0;
  const onLogin = /Account\/Login/i.test(page.url());
  if (onLogin) return { ok: false, why: "session dropped — bounced to login", wall: wall };

  const nav = await page.evaluate(function () {
    const n = performance.getEntriesByType("navigation")[0];
    if (!n) return null;
    return {
      ttfb: Math.round(n.responseStart - n.requestStart),
      server: Math.round(n.responseEnd - n.requestStart),
      dom: Math.round(n.domContentLoadedEventEnd - n.startTime),
      load: Math.round(n.loadEventEnd - n.startTime)
    };
  }).catch(function () { return null; });

  return {
    ok: status > 0 && status < 400,
    status: status, wall: wall,
    server: nav ? nav.server : null,
    render: nav && nav.load > 0 ? nav.load - nav.server : null,
    load: nav ? (nav.load > 0 ? nav.load : nav.dom) : wall
  };
}

module.exports = { hitDashboard: hitDashboard };
