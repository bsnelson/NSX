"use strict";
/**
 * NSXCore flush domain — headless state + logic for the machine flush/rinse.
 *
 * Owns flushPresets / activeFlushPreset / flushFlow / flushDuration, persists the
 * preset map + active-preset name through the core store, and pushes rinseData to
 * the machine via the core push helpers. Emits 'flushChanged' after every state
 * change; presentations subscribe and render (all DOM stays in the skin).
 *
 * Registered on NSXCore:
 *   Selectors: getFlushFlow(), getFlushDuration(), getFlushPresets(), getActiveFlushPreset()
 *   Commands:  selectFlushPreset(name), setFlushFlow(v), setFlushDuration(v),
 *              deactivateFlushPreset(), setFlushPresets(presets), hydrateFlush()
 *   Event:     'flushChanged' -> { flow, duration, active, presets }
 */
(function () {
  const NSXCore = window.NSXCore;
  if (!NSXCore) {
    console.error("[NSXCore.flush] core.js must load before domains/flush.js");
    return;
  }

  const DEFAULTS = {
    kurz:   { name: "Short",  flow: 10, duration: 3  },
    normal: { name: "Normal", flow: 10, duration: 5  },
    lang:   { name: "Long",   flow: 10, duration: 10 },
  };

  let presets = Object.assign({}, DEFAULTS);
  let active = "normal";
  let flow = presets[active].flow;
  let duration = presets[active].duration;

  const clampFlow = (v) => Math.min(10, Math.max(1, v));
  const clampDuration = (v) => Math.min(60, Math.max(1, v));

  function emitChanged() {
    NSXCore.emit("flushChanged", { flow, duration, active, presets });
  }

  // Flush-domain-specific machine writes (debounced), built on the core push helper.
  function pushFlow() {
    NSXCore.debounced("flushFlow", () => NSXCore.push({ rinseData: { flow: parseFloat(flow) } }));
  }
  function pushDuration() {
    NSXCore.debounced("flushDur", () => NSXCore.push({ rinseData: { duration: parseFloat(duration) } }));
  }
  function pushBoth() {
    NSXCore.debounced("flush", () => NSXCore.push({ rinseData: { flow: parseFloat(flow), duration: parseFloat(duration) } }));
  }

  function selectFlushPreset(name) {
    if (!presets[name]) return;
    active = name;
    NSXCore.saveActivePresetName("nsx_flush_active_preset", name);
    flow = presets[name].flow;
    duration = presets[name].duration;
    emitChanged();
    pushBoth();
  }

  function deactivateFlushPreset() {
    active = null;
    NSXCore.saveActivePresetName("nsx_flush_active_preset", "");
    emitChanged();
  }

  function setFlushFlow(v) {
    flow = clampFlow(v);
    active = null;
    NSXCore.saveActivePresetName("nsx_flush_active_preset", "");
    emitChanged();
    pushFlow();
  }

  function setFlushDuration(v) {
    duration = clampDuration(v);
    active = null;
    NSXCore.saveActivePresetName("nsx_flush_active_preset", "");
    emitChanged();
    pushDuration();
  }

  function setFlushPresets(next) {
    if (!next || typeof next !== "object") return;
    presets = next;
    NSXCore.patchStore({ nsx_flush_presets: presets });
    if (active && presets[active]) {
      flow = presets[active].flow;
      duration = presets[active].duration;
      pushBoth();
    }
    emitChanged();
  }

  // Load this domain's slice from the already-loaded core store.
  function hydrateFlush() {
    const s = NSXCore.getStore();
    if (s.nsx_flush_presets && typeof s.nsx_flush_presets === "object") {
      const stored = s.nsx_flush_presets;
      presets = {
        kurz:   { ...DEFAULTS.kurz,   ...stored.kurz   },
        normal: { ...DEFAULTS.normal, ...stored.normal },
        lang:   { ...DEFAULTS.lang,   ...stored.lang   },
      };
    }
    if (typeof s.nsx_flush_active_preset === "string") {
      if (presets[s.nsx_flush_active_preset]) active = s.nsx_flush_active_preset;
      else if (s.nsx_flush_active_preset === "") active = null;
    }
    const state = presets[active] ?? presets.normal;
    flow = state.flow;
    duration = state.duration;
  }

  NSXCore.register({
    getFlushFlow: () => flow,
    getFlushDuration: () => duration,
    getFlushPresets: () => presets,
    getActiveFlushPreset: () => active,
    selectFlushPreset,
    setFlushFlow,
    setFlushDuration,
    deactivateFlushPreset,
    setFlushPresets,
    hydrateFlush,
  });
})();
