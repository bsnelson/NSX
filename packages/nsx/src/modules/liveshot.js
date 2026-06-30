"use strict";

/**
 * NSXLiveShot — Live shot session management (Facade)
 * Wraps app.js live shot functions via delayed binding
 * Must load AFTER app.js
 */

(function() {
  // Delayed facade binding (waits for app.js)
  function initFacade() {
    if (!window.startLiveShotSession || !window.endLiveShotSession) {
      setTimeout(initFacade, 100);
      return;
    }
    window.NSXLiveShot = {
      startLiveShotSession: window.startLiveShotSession.bind(window),
      endLiveShotSession: window.endLiveShotSession.bind(window),
    };
  }
  initFacade();
})();
