"use strict";
/**
 * NSXCore machine domain — the current DE1 machine-state value.
 *
 * This is a PASSIVE value holder, not an auto-tracking listener: it does NOT
 * subscribe to the "machineState" event itself. app.js's own
 * NSXCore.on("machineState", ...) handler is the sole writer (via
 * setMachineState) — it needs to read the previous value BEFORE overwriting
 * it (to detect session-start/session-end transitions), all synchronously
 * within one callback. If this domain also listened to "machineState"
 * independently, script load order (core domains load before app.js) would
 * make it run first on every dispatch, so app.js's "read previous, then
 * write new" logic would always see the NEW value already — silently
 * breaking every transition check. Keeping this a plain get/set avoids that
 * race entirely: there is still exactly one writer, exactly one place that
 * reads-then-writes, same as when this was a local app.js variable.
 *
 * Registered on NSXCore:
 *   Selectors: getMachineState(), isEspressoLikeState(state)
 *   Commands:  setMachineState(state)
 */
(function () {
  const NSXCore = window.NSXCore;
  if (!NSXCore) {
    console.error("[NSXCore.machine] core.js must load before domains/machine.js");
    return;
  }

  let _state = "idle";

  function getMachineState() { return _state; }
  function setMachineState(state) { _state = state; }
  function isEspressoLikeState(state) { return state === "espresso" || state === "skipStep"; }

  NSXCore.register({
    getMachineState,
    setMachineState,
    isEspressoLikeState,
  });
})();
