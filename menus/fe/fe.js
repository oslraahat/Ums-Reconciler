/* "For Franchisee" — the same check from the other side of the report.
 * The Franchisee controller answers in a different JSON shape and reuses one field name for a
 * different quantity; fr-core.js normalises both and scopes the rules accordingly. */
(function () {
  "use strict";
  var A = self.APP || (self.APP = {});
  var panel = null;

  function onShow() {
    if (!panel) panel = A.frUi.mount("fe", "feBox");
    if (panel) {
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
    var box = document.getElementById("feBox");
    if (!box || !box.dataset.built) return;
    box.dataset.built = "";
    box.innerHTML = "";
    panel = null;
    var sec = document.getElementById("pgFe");
    if (sec && sec.classList.contains("on")) onShow();
  }

  A.fe = { onShow: onShow, relang: relang };
})();
