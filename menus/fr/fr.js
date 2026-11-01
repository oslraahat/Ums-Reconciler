/* "For Franchisor" — checks the Franchisor Calculation report's arithmetic against the FRS.
 * The work lives in fr-core.js (what UMS is asked, and which rules hold where) and fr-ui.js (the
 * panel, shared with the Franchisee menu). This only names the side and the container. */
(function () {
  "use strict";
  var A = self.APP || (self.APP = {});
  var panel = null;

  function onShow() {
    if (!panel) panel = A.frUi.mount("fr", "frBox");
    if (panel) {
      // start from whatever server the rest of the panel is pointed at
      try {
        var b = document.getElementById("base");
        if (b && b.value) panel.setBase(b.value);
      } catch (e) {}
      panel.loadProgs();
    }
  }

  /* The panel is written from JS, so applyLang() cannot repaint it — it has to be rebuilt. Two
     things that rebuild must not do: leave the section empty (the old version cleared the box and
     waited for the user to navigate away and back), and pull the panel out from under a running
     check (render() would then write to a detached node, the throw would be swallowed, and the run
     would die with nothing on screen — while a fresh mount armed the shared Referer rule over the
     old run's requests). So: skip while busy, and remount at once if this section is the open one. */
  function relang() {
    if (panel && panel.isRunning && panel.isRunning()) return;
    var box = document.getElementById("frBox");
    if (!box || !box.dataset.built) return;
    box.dataset.built = "";
    box.innerHTML = "";
    panel = null;
    var sec = document.getElementById("pgFr");
    if (sec && sec.classList.contains("on")) onShow();
  }

  A.fr = { onShow: onShow, relang: relang };
})();
