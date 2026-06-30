"use strict";
/**
 * NSXCore hotwater domain — headless state + logic for the hot-water dispense.
 *
 * Owns hotwaterPresets / activeHotwaterPreset / hotwaterTemp / hotwaterFlow /
 * hotwaterVolume, persists through the core store, and pushes hotWaterData to
 * the machine. Emits 'hotwaterChanged' after every state change.
 *
 * Registered on NSXCore:
 *   Selectors: getHotwaterTemp(), getHotwaterFlow(), getHotwaterVolume(),
 *              getHotwaterPresets(), getActiveHotwaterPreset()
 *   Commands:  selectHotwaterPreset(name), setHotwaterTemp(v), setHotwaterFlow(v),
 *              setHotwaterVolume(v), deactivateHotwaterPreset(),
 *              setHotwaterPresets(presets), hydrateHotwater()
 *   Event:     'hotwaterChanged' -> { temp, flow, volume, active, presets }
 */
(function () {
  const NSXCore = window.NSXCore;
  if (!NSXCore) {
    console.error("[NSXCore.hotwater] core.js must load before domains/hotwater.js");
    return;
  }

  const DEFAULTS = {
    klein:  { name: "Little", temp: 80, flow: 5.0, volume: 40  },
    mittel: { name: "Medium", temp: 80, flow: 5.0, volume: 100 },
    gross:  { name: "Large",  temp: 80, flow: 5.0, volume: 150 },
  };

  let presets = Object.assign({}, DEFAULTS);
  let active = "mittel";
  let temp   = presets[active].temp;
  let flow   = presets[active].flow ?? 1.5;
  let volume = presets[active].volume;

  const clampTemp   = (v) => Math.min(100, Math.max(50, v));
  const clampFlow   = (v) => Math.round(Math.min(10.0, Math.max(0.5, v)) * 10) / 10;
  const clampVolume = (v) => Math.min(500, Math.max(10, v));

  function emitChanged() {
    NSXCore.emit("hotwaterChanged", { temp, flow, volume, active, presets });
  }

  function pushTemp()   { NSXCore.debounced("hwTemp",   () => NSXCore.push({ hotWaterData: { targetTemperature: parseFloat(temp) } })); }
  function pushFlow()   { NSXCore.debounced("hwFlow",   () => NSXCore.push({ hotWaterData: { flow: parseFloat(flow) } })); }
  function pushVolume() { NSXCore.debounced("hwVolume", () => NSXCore.push({ hotWaterData: { volume: parseFloat(volume) } })); }
  function pushAll()    { NSXCore.debounced("hotwater", () => NSXCore.push({ hotWaterData: { targetTemperature: parseFloat(temp), flow: parseFloat(flow), volume: parseFloat(volume) } })); }

  function selectHotwaterPreset(name) {
    if (!presets[name]) return;
    active = name;
    NSXCore.saveActivePresetName("nsx_hotwater_active_preset", name);
    temp   = presets[name].temp;
    flow   = presets[name].flow ?? 1.5;
    volume = presets[name].volume;
    emitChanged();
    pushAll();
  }

  function deactivateHotwaterPreset() {
    active = null;
    NSXCore.saveActivePresetName("nsx_hotwater_active_preset", "");
    emitChanged();
  }

  function setHotwaterTemp(v) {
    temp = clampTemp(v);
    active = null;
    NSXCore.saveActivePresetName("nsx_hotwater_active_preset", "");
    emitChanged();
    pushTemp();
  }

  function setHotwaterFlow(v) {
    flow = clampFlow(v);
    active = null;
    NSXCore.saveActivePresetName("nsx_hotwater_active_preset", "");
    emitChanged();
    pushFlow();
  }

  function setHotwaterVolume(v) {
    volume = clampVolume(v);
    active = null;
    NSXCore.saveActivePresetName("nsx_hotwater_active_preset", "");
    emitChanged();
    pushVolume();
  }

  function setHotwaterPresets(next) {
    if (!next || typeof next !== "object") return;
    presets = next;
    NSXCore.patchStore({ nsx_hotwater_presets: presets });
    if (active && presets[active]) {
      temp   = presets[active].temp;
      flow   = presets[active].flow ?? 1.5;
      volume = presets[active].volume;
      pushAll();
    }
    emitChanged();
  }

  function hydrateHotwater() {
    const s = NSXCore.getStore();
    if (s.nsx_hotwater_presets && typeof s.nsx_hotwater_presets === "object") {
      const stored = s.nsx_hotwater_presets;
      presets = {
        klein:  { ...DEFAULTS.klein,  ...stored.klein  },
        mittel: { ...DEFAULTS.mittel, ...stored.mittel },
        gross:  { ...DEFAULTS.gross,  ...stored.gross  },
      };
    }
    if (typeof s.nsx_hotwater_active_preset === "string") {
      if (presets[s.nsx_hotwater_active_preset]) active = s.nsx_hotwater_active_preset;
      else if (s.nsx_hotwater_active_preset === "") active = null;
    }
    const state = presets[active] ?? presets.mittel;
    temp   = state.temp;
    flow   = state.flow ?? 1.5;
    volume = state.volume;
  }

  NSXCore.register({
    getHotwaterTemp:          () => temp,
    getHotwaterFlow:          () => flow,
    getHotwaterVolume:        () => volume,
    getHotwaterPresets:       () => presets,
    getActiveHotwaterPreset:  () => active,
    selectHotwaterPreset,
    setHotwaterTemp,
    setHotwaterFlow,
    setHotwaterVolume,
    deactivateHotwaterPreset,
    setHotwaterPresets,
    hydrateHotwater,
  });
})();
