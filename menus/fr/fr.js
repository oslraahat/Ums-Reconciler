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

  /* The panel is built from JS, so applyLang() cannot repaint it; rebuild it in the new language. */
  function relang() {
    var box = document.getElementById("frBox");
    if (box && box.dataset.built) { box.dataset.built = ""; box.innerHTML = ""; panel = null; }
  }

  A.fr = { onShow: onShow, relang: relang };
})();
