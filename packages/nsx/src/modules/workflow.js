"use strict";

/**
 * NSXWorkflow — Workflow filtering (Facade)
 * Wraps app.js workflow functions via delayed binding
 * Must load AFTER app.js
 */

(function() {
  // Delayed facade binding
  function initFacade() {
    if (!window.getDisplayWorkflows || !window.openFilterModal) {
      setTimeout(initFacade, 100);
      return;
    }
    window.NSXWorkflow = {
      getDisplayWorkflows: window.getDisplayWorkflows.bind(window),
      openFilterModal: window.openFilterModal.bind(window),
    };
  }
  initFacade();
})();
