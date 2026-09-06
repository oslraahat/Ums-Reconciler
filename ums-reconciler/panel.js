/* Pop-out reconciler window. Reads captured data from chrome.storage.local
 * for the studentProgramId passed as ?spid=... and renders the same report.
 * Uses self.UMSREC (reconcile.js) — same logic as the in-page panel. */
(function () {
  "use strict";
  const U = self.UMSREC;
  const spid = (location.search.match(/spid=([^&]+)/) || [])[1] || "unknown";
  const KP = "program_" + spid, KC = "course_" + spid;

  document.getElementById("spid").textContent = "Program " + spid;

  function loadBoth(cb) {
    chrome.storage.local.get([KP, KC], function (o) { cb(o[KP] || null, o[KC] || null); });
  }

  // scraped tables carry `rows`; the old `count` field went away when parseTable replaced scrape()
  const rowCount = function (d) { return (d && d.rows) ? d.rows.length : 0; };

  function refreshStatus() {
    loadBoth(function (pw, cw) {
      const p = document.getElementById("p"), c = document.getElementById("c");
      if (pw) { p.className = "ok"; p.textContent = "✓ " + rowCount(pw.data) + " rows"; }
      else { p.className = "mut"; p.textContent = "not captured"; }
      if (cw) { c.className = "ok"; c.textContent = "✓ " + rowCount(cw.data) + " rows"; }
      else { c.className = "mut"; c.textContent = "not captured"; }
    });
  }

  function runVerify() {
    loadBoth(function (pw, cw) {
      const out = document.getElementById("out");
      if (!pw || !cw) {
        out.innerHTML = '<div class="verdict vno">দুইটা পেজেই (Program Wise + Course Wise) একবার করে ভিজিট করো, তারপর Verify।</div>';
        return;
      }
      out.innerHTML = U.renderReport(U.compare(pw.data, cw.data, { tolerance: 0 }), pw.data, cw.data);
    });
  }

  document.getElementById("verify").addEventListener("click", runVerify);
  document.getElementById("refresh").addEventListener("click", function () { refreshStatus(); runVerify(); });
  document.getElementById("clear").addEventListener("click", function () {
    chrome.storage.local.remove([KP, KC], function () {
      document.getElementById("out").innerHTML = "";
      refreshStatus();
    });
  });

  // live update when the UMS tabs capture new data
  chrome.storage.onChanged.addListener(function (changes) {
    if (changes[KP] || changes[KC]) { refreshStatus(); runVerify(); }
  });

  refreshStatus();
  runVerify();
})();
