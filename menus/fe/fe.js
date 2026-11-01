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

  function relang() {
    var box = document.getElementById("feBox");
    if (box && box.dataset.built) { box.dataset.built = ""; box.innerHTML = ""; panel = null; }
  }

  A.fe = { onShow: onShow, relang: relang };
})();
