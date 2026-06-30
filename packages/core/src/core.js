"use strict";
/**
 * NSXCore — the shared, headless facade that every skin presentation depends on.
 *
 * Phase 1 (this file): an event bus + a register() hook for commands/selectors,
 * plus a bridge that turns api.js's low-level window CustomEvents into semantic
 * core events. As logic is extracted from app.js (Phases 2+), each domain calls
 * NSXCore.register({ ... }) to attach its commands/selectors and uses
 * NSXCore.emit(...) to publish state changes. No DOM access lives here.
 *
 * The contract (stable names):
 *   Events (core -> presentation, via NSXCore.on(name, cb)):
 *     machineConnected, scaleConnected, scaleWeight, machineState, waterLevel,
 *     liveShot, devices, timeToReady,
 *     workflowsChanged, selectedWorkflow, shotsChanged, needsWater, syncState, toast
 *   Commands (presentation -> core, attached as NSXCore.<name>(...)):
 *     selectWorkflow, pushSteamTemp, tareScale, startSteam, saveRecipe, ...
 *   Selectors (sync reads, attached as NSXCore.get<X>()):
 *     getMachineState, getWorkflows, getSelectedWorkflow, getLiveShot, ...
 */
(function () {
  const _listeners = new Map(); // event name -> Set<callback>

  const NSXCore = {
    /** Subscribe to a semantic core event. Returns an unsubscribe function. */
    on(name, cb) {
      if (typeof cb !== "function") return () => {};
      let set = _listeners.get(name);
      if (!set) { set = new Set(); _listeners.set(name, set); }
      set.add(cb);
      return () => NSXCore.off(name, cb);
    },

    /** Unsubscribe a previously registered callback. */
    off(name, cb) {
      _listeners.get(name)?.delete(cb);
    },

    /** Publish a semantic core event to all subscribers. */
    emit(name, payload) {
      const set = _listeners.get(name);
      if (!set) return;
      for (const cb of [...set]) {
        try { cb(payload); }
        catch (e) { console.error(`[NSXCore] "${name}" listener threw`, e); }
      }
    },

    /**
     * Attach commands/selectors as methods on NSXCore. Domains call this during
     * extraction so presentations can invoke NSXCore.<command>() / NSXCore.get<X>().
     */
    register(impl) {
      if (impl && typeof impl === "object") Object.assign(NSXCore, impl);
      return NSXCore;
    },
  };

  // ── Bridge: api.js low-level window CustomEvents -> semantic core events ──────
  // Lets presentations subscribe to stable semantic names instead of api internals.
  const bridge = (winEvent, coreEvent, map) =>
    window.addEventListener(winEvent, (e) =>
      NSXCore.emit(coreEvent, map ? map(e.detail) : e.detail));

  bridge("gateway:status",       "machineConnected", d => d?.connected);
  bridge("scale:status",         "scaleConnected",   d => d?.connected);
  bridge("scale:weight",         "scaleWeight",      d => d);
  bridge("gateway:machineState", "machineState",     d => d);
  bridge("water:level",          "waterLevel",       d => d);
  bridge("gateway:devices",      "devices",          d => d);
  bridge("gateway:snapshot",     "liveShot",         d => d);
  bridge("gateway:timeToReady",  "timeToReady",      d => d);

  window.NSXCore = NSXCore;
})();
