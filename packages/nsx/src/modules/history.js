"use strict";

/**
 * NSXHistory — Shot history management (Facade)
 * Wraps app.js history functions via delayed binding
 * Must load AFTER app.js
 */

(function() {
  // Delayed facade binding
  function initFacade() {
    if (!window.renderHistory) {
      setTimeout(initFacade, 100);
      return;
    }
    window.NSXHistory = {
      renderHistory: window.renderHistory.bind(window),
    };
  }
  initFacade();
})();
