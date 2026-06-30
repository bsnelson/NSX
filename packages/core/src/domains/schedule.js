"use strict";
/**
 * NSXCore schedule domain — headless state + gateway sync for the machine on/off schedule.
 *
 * Owns scheduleState (enabled, days, onHour/Minute, offHour/Minute, scheduleId),
 * persists through the core store, and syncs to the gateway schedule API.
 *
 * Registered on NSXCore:
 *   Selectors: getScheduleState()
 *   Commands:  applySchedule(patch), setScheduleId(id), hydrateSchedule(),
 *              syncScheduleToApi()
 *   Event:     'scheduleChanged' -> state snapshot
 */
(function () {
  const NSXCore = window.NSXCore;
  if (!NSXCore) {
    console.error("[NSXCore.schedule] core.js must load before domains/schedule.js");
    return;
  }

  const DEFAULTS = {
    enabled: false,
    days: [1, 2, 3, 4, 5],
    onHour: 6, onMinute: 0,
    offHour: 22, offMinute: 0,
    scheduleId: null,
  };

  const state = Object.assign({}, DEFAULTS);

  function pad2(n) { return String(n).padStart(2, "0"); }

  function emitChanged() {
    NSXCore.emit("scheduleChanged", Object.assign({}, state));
  }

  /** Patch state, persist to store, emit, then sync to the gateway API. */
  function applySchedule(patch) {
    if (patch && typeof patch === "object") Object.assign(state, patch);
    NSXCore.patchStore({ nsx_schedule: Object.assign({}, state) });
    emitChanged();
    syncScheduleToApi();
  }

  /** Update only the stored schedule ID (set after creating/loading from the API). */
  function setScheduleId(id) {
    state.scheduleId = id ?? null;
    NSXCore.patchStore({ nsx_schedule: Object.assign({}, state) });
  }

  function hydrateSchedule() {
    const s = NSXCore.getStore();
    if (s.nsx_schedule && typeof s.nsx_schedule === "object") {
      Object.assign(state, DEFAULTS, s.nsx_schedule);
    }
  }

  async function syncScheduleToApi() {
    const { updateSchedule, createSchedule } = window.NSXApi || {};
    const t = window.NSXI18n?.t || ((k) => k);

    if (!state.enabled) {
      if (state.scheduleId && typeof updateSchedule === "function") {
        try {
          await updateSchedule(state.scheduleId, { id: state.scheduleId, enabled: false });
        } catch {}
      }
      return;
    }

    const days = state.days.length > 0 ? state.days : [1, 2, 3, 4, 5, 6, 7];
    const time = `${pad2(state.onHour)}:${pad2(state.onMinute)}`;

    if (state.scheduleId && typeof updateSchedule === "function") {
      try {
        await updateSchedule(state.scheduleId, {
          id: state.scheduleId,
          time,
          daysOfWeek: days,
          enabled: true,
          keepAwakeFor: 0,
        });
        return;
      } catch {
        state.scheduleId = null;
        NSXCore.patchStore({ nsx_schedule: Object.assign({}, state) });
      }
    }

    if (typeof createSchedule !== "function") return;
    try {
      const created = await createSchedule({
        time,
        daysOfWeek: days,
        enabled: true,
        keepAwakeFor: 0,
      });
      state.scheduleId = created?.id || null;
      NSXCore.patchStore({ nsx_schedule: Object.assign({}, state) });
    } catch (err) {
      NSXCore.emit("toast", t("toast.scheduleFailed") + ": " + err.message);
    }
  }

  NSXCore.register({
    getScheduleState: () => Object.assign({}, state),
    applySchedule,
    setScheduleId,
    hydrateSchedule,
    syncScheduleToApi,
  });
})();
