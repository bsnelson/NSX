/**
 * app.js
 *
 * Application entry point — orchestrator:
 *   - Initializes all modules
 *   - Wires up event listeners
 *   - Manages global state
 *   - Coordinates UI updates
 *
 * Depends on: config.js, api.js, ui.js, router.js
 * Must be loaded last so all modules are available.
 */
"use strict";

(() => {
const { GATEWAY, WS_BASE } = window.NSXConfig || {};
const {
  fetchCurrentWorkflow,
  fetchMachineInfo,
  fetchShotDetails,
  fetchShots,
  pushWorkflow,
  pushSteamSettings,
  pushHotwaterSettings,
  pushFlushSettings,
  fetchSchedules,
  fetchLatestSteam,
  fetchSteamById,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  setMachineState,
  tareScale,
  pushRefillLevel,
  initiateScaleConnect,
  initiateDE1Connect,
  disconnectScale,
  deleteShotById,
  updateShotRecord,
  updateShotMetadata,
  fetchBeans,
  createBean,
  updateBean,
  fetchBatches,
  fetchBatch,
  createBatch,
  updateBatch,
  deleteBatch,
  deleteBean,
  archiveBean,
  unarchiveBean,
  fetchProfiles,
  fetchProfilesIncludingHidden,
  fetchProfileById,
  saveProfile,
  deleteProfile,
  setProfileVisibility,
  fetchDeletedProfiles,
  purgeProfile,
  restoreProfile,
  fetchGrinders,
  createGrinder,
  updateGrinder,
  deleteGrinder,
  getStoreValue,
  setStoreValue,
  setDisplayBrightness,
  fetchDisplayState,
  fetchPresenceSettings,
  updatePresenceSettings,
  signalUserPresenceHeartbeat: apiSignalUserPresenceHeartbeat,
  fetchMachineSettings,
  updateMachineSettings,
} = window.NSXApi || {};
const {
  renderShotGraph,
  renderWorkflows,
  setBrewGroupTemperature,
  setCurrentWorkflow,
  setHotwaterWidget,
  initLiveShotChart,
  updateLiveShotChart,
  initSteamChart,
  updateSteamChart,
  setMachineConnected,
  setMachineInfo,
  setMachineStateText,
  setScaleConnected,
  setSteamWidget,
  setSteamTemperatureOrb,
  setWaterLevel,
  setWaterRefillLevel,
  setWaterDisplayUnit,
  showToast,
  showStateToast,
  updateWorkflowLegendLive,
  updateRecipeListFade,
  updateActiveWorkflowCardHistoricalValues,
  renderHistoryAccordion,
  updateHistoryShotDuration,
  updateRecipeRating,
  setOnRecipesRendered,
  setWorkflowSyncState,
} = window.NSXUI || {};

/* ── Translations ─────────────────────────────────────── */
const { t, setLang, getLang, applyTranslations } = window.NSXI18n || {};

/* ── Confirm Dialog ───────────────────────────────────── */
function showConfirm(message, okLabel = null) {
  return new Promise(resolve => {
    const modal = document.getElementById('confirm-modal');
    const msgEl = document.getElementById('confirm-message');
    const okBtn = document.getElementById('btn-confirm-ok');
    const cancelBtn = document.getElementById('btn-confirm-cancel');
    if (!modal || !msgEl || !okBtn || !cancelBtn) { resolve(window.confirm(message)); return; }

    msgEl.textContent = message;
    okBtn.textContent = okLabel ?? t('action.delete');
    modal.hidden = false;

    function cleanup(result) {
      modal.hidden = true;
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      modal.removeEventListener('click', onBackdrop);
      resolve(result);
    }
    function onOk() { cleanup(true); }
    function onCancel() { cleanup(false); }
    function onBackdrop(e) { if (e.target === modal) cleanup(false); }

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    modal.addEventListener('click', onBackdrop);
  });
}

/* ── Alert Dialog ─────────────────────────────────────── */
function showAlert(message) {
  return new Promise(resolve => {
    const modal = document.getElementById('alert-modal');
    const msgEl = document.getElementById('alert-message');
    const okBtn = document.getElementById('btn-alert-ok');
    if (!modal || !msgEl || !okBtn) { window.alert(message); resolve(); return; }

    msgEl.textContent = message;
    modal.hidden = false;

    function cleanup() {
      modal.hidden = true;
      okBtn.removeEventListener('click', onOk);
      modal.removeEventListener('click', onBackdrop);
      resolve();
    }
    function onOk() { cleanup(); }
    function onBackdrop(e) { if (e.target === modal) cleanup(); }

    okBtn.addEventListener('click', onOk);
    modal.addEventListener('click', onBackdrop);
  });
}

/* ── Global State ─────────────────────────────────────── */
let selectedWorkflowIndex = 0;
let _lastRecipeId = null;
let historySelectedRecipeIndex = -1;
let historyRecipes = [];
let shots = [];
let historyShots = [];
let workflowItems = [];
let workflowSearchQuery = '';
const shotDetailsCache = new Map();
let currentMachineState = 'idle';
let _workflowPushNonce = 0;
let displayWs = null;
let displayReconnectDelay = 1000;
let liveShot = null;
let liveWeight = 0;
let liveVolumeIntegrated = 0;
let _liveVolumeCountingActive = false;
let _lastSnapTime = null;
let currentScaleRate = 0;
let _forcedLiveWorkflow = null;
let machineConnectedState = false;
let currentWaterLevelPct = null;
let _espressoFullscreenVisible = false;
let _espressoFullscreenCloseTimer = null;

let steamSession = null;
let steamTimerInterval = null;
let _hotWaterStartWeight = 0;
let _hotWaterDone = false;
let _flushTimerInterval = null;
let _flushStartTime = 0;
let _flushDone = false;
let _peditorActiveTab = 'phasen';
let _lastEspressoSubstate = null;
let _lastProfileFrameLabel = null;
let _skipStepInFlight = false;
let _skipStepGuardFrame = null;
let _skipStepLastSentAt = 0;
const SKIP_STEP_MIN_INTERVAL_MS = 800;
let _skipStepRecoveryTimer = null;

function _isEspressoLikeState(state) {
  return state === 'espresso' || state === 'skipStep';
}

function _clearSkipStepRecoveryTimer() {
  if (_skipStepRecoveryTimer !== null) {
    clearTimeout(_skipStepRecoveryTimer);
    _skipStepRecoveryTimer = null;
  }
}

function _scheduleSkipStepRecovery() {
  _clearSkipStepRecoveryTimer();
  _skipStepRecoveryTimer = setTimeout(() => {
    _skipStepRecoveryTimer = null;
    if (currentMachineState === 'skipStep' && liveShot) {
      setMachineState?.('espresso').catch(() => {});
    }
  }, 700);
}

const menuButtonEl = document.getElementById("btn-menu");

/* ── Machine State Banner ─────────────────────────────── */
const machineStateBannerEl = document.getElementById("machine-state-banner");
const machineStateTextEl   = document.getElementById("machine-state-text");
const readyInChipEl        = document.getElementById("ready-in-chip");

function formatMmSs(ms) {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function updateMachineStateBanner(state, substate) {
  if (!machineStateTextEl) return;

  // Show substate only when state is "espresso" (hide "espresso" itself)
  if (state === 'espresso' && substate) {
    machineStateTextEl.textContent = substate;
  } else {
    machineStateTextEl.textContent = state;
  }

  if (machineStateBannerEl) {
    machineStateBannerEl.hidden = !state;
  }

  if (readyInChipEl && state !== 'heating' && state !== 'preheating') {
    readyInChipEl.hidden = true;
  }
}

/* ── Machine State Validation (Reaprime Best Practice) ─────– */
const ALLOWED_OPERATIONS = {
  idle: ['setState', 'uploadProfile', 'updateSettings', 'setWorkflow'],
  booting: ['setState'],
  sleeping: ['setState'],
  heating: ['setState'],
  preheating: ['setState'],
  espresso: ['stopShot'],
  hotWater: ['setState'],
  flush: ['setState'],
  steam: ['setState'],
  steamRinse: ['setState'],
  cleaning: ['setState'],
  descaling: ['setState'],
  error: ['setState'],
  needsWater: ['setState'],
};

function canExecuteOperation(operation, state = currentMachineState) {
  return ALLOWED_OPERATIONS[state]?.includes(operation) ?? false;
}

/* ── Workflow Search & Filter ─────────────────────────── */

const EMPTY_VALUE = '—';
const workflowFilters = { roasters: new Set(), beans: new Set(), grinders: new Set(), profiles: new Set() };

function hasActiveFilters() {
  return workflowFilters.roasters.size > 0
    || workflowFilters.beans.size > 0
    || workflowFilters.grinders.size > 0
    || workflowFilters.profiles.size > 0;
}

function getDisplayWorkflows() {
  if (!workflowSearchQuery && !hasActiveFilters()) return workflowItems.map(_attachRecipeRating);
  const q = workflowSearchQuery ? workflowSearchQuery.toLowerCase() : null;
  return workflowItems.reduce((acc, w, i) => {
    if (q) {
      const textMatch = [w.coffeeRoaster, w.coffeeName, w.grinderModel, w.profileTitle]
        .some(v => v && v.toLowerCase().includes(q));
      if (!textMatch) return acc;
    }
    if (workflowFilters.roasters.size > 0 && !workflowFilters.roasters.has(w.coffeeRoaster)) return acc;
    if (workflowFilters.beans.size > 0    && !workflowFilters.beans.has(w.coffeeName))       return acc;
    if (workflowFilters.grinders.size > 0 && !workflowFilters.grinders.has(w.grinderModel))  return acc;
    if (workflowFilters.profiles.size > 0 && !workflowFilters.profiles.has(w.profileTitle))  return acc;
    acc.push(_attachRecipeRating({ ...w, _origIdx: i }));
    return acc;
  }, []);
}

/* ── Workflow Filter Modal ────────────────────────────── */

const filterModalEl       = document.getElementById('workflow-filter-modal');
const filterBtnEl         = document.getElementById('btn-workflow-filter');
const filterChipsRoaster  = document.getElementById('filter-chips-roaster');
const filterChipsBean     = document.getElementById('filter-chips-bean');
const filterChipsGrinder  = document.getElementById('filter-chips-grinder');
const filterChipsProfile  = document.getElementById('filter-chips-profile');

function updateFilterButtonState() {
  filterBtnEl?.classList.toggle('is-active', hasActiveFilters());
}

function buildFilterChips(containerEl, values, activeSet) {
  containerEl.innerHTML = '';
  const allValues = [EMPTY_VALUE, ...values.filter(v => v !== EMPTY_VALUE)];
  allValues.forEach(val => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'filter-chip' + (val === EMPTY_VALUE ? ' filter-chip-empty' : '');
    btn.textContent = val === EMPTY_VALUE ? t('filter.empty') : val;
    btn.dataset.value = val;
    if (activeSet.has(val)) btn.classList.add('is-selected');
    containerEl.appendChild(btn);
  });
}

function openFilterModal() {
  const roasters = [...new Set(workflowItems.map(w => w.coffeeRoaster))].sort();
  const beans    = [...new Set(workflowItems.map(w => w.coffeeName))].sort();
  const grinders = [...new Set(workflowItems.map(w => w.grinderModel))].sort();
  const profiles = [...new Set(workflowItems.map(w => w.profileTitle))].sort();
  buildFilterChips(filterChipsRoaster, roasters, workflowFilters.roasters);
  buildFilterChips(filterChipsBean,    beans,    workflowFilters.beans);
  buildFilterChips(filterChipsGrinder, grinders, workflowFilters.grinders);
  buildFilterChips(filterChipsProfile, profiles, workflowFilters.profiles);
  filterModalEl.hidden = false;
}

function handleFilterChipClick(event, activeSet) {
  const chip = event.target.closest('.filter-chip');
  if (!chip) return;
  const val = chip.dataset.value;
  if (activeSet.has(val)) {
    activeSet.delete(val);
    chip.classList.remove('is-selected');
  } else {
    activeSet.add(val);
    chip.classList.add('is-selected');
  }
  updateFilterButtonState();
  renderWorkflows(getDisplayWorkflows(), selectedWorkflowIndex);
}

filterChipsRoaster?.addEventListener('click', e => handleFilterChipClick(e, workflowFilters.roasters));
filterChipsBean?.addEventListener('click',    e => handleFilterChipClick(e, workflowFilters.beans));
filterChipsGrinder?.addEventListener('click', e => handleFilterChipClick(e, workflowFilters.grinders));
filterChipsProfile?.addEventListener('click', e => handleFilterChipClick(e, workflowFilters.profiles));

filterBtnEl?.addEventListener('click', openFilterModal);

document.getElementById('btn-filter-done')?.addEventListener('click', () => {
  filterModalEl.hidden = true;
});

document.getElementById('btn-filter-reset')?.addEventListener('click', () => {
  workflowFilters.roasters.clear();
  workflowFilters.beans.clear();
  workflowFilters.grinders.clear();
  workflowFilters.profiles.clear();
  filterModalEl.hidden = true;
  updateFilterButtonState();
  renderWorkflows(getDisplayWorkflows(), selectedWorkflowIndex);
});

filterModalEl?.addEventListener('click', e => {
  if (e.target === filterModalEl) filterModalEl.hidden = true;
});

/* ── History Filter Modal ─────────────────────────────── */

const historyFilterModalEl = document.getElementById('history-filter-modal');

function _openHistoryFilterModal() {
  const all = buildWorkflowItemsFromShots(shots);
  const roasters = [...new Set(all.map(w => w.coffeeRoaster))].sort();
  const beans    = [...new Set(all.map(w => w.coffeeName))].sort();
  const grinders = [...new Set(all.map(w => w.grinderModel))].sort();
  const profiles = [...new Set(all.map(w => w.profileTitle))].sort();
  buildFilterChips(document.getElementById('history-filter-chips-roaster'), roasters, _historyFilters.roasters);
  buildFilterChips(document.getElementById('history-filter-chips-bean'),    beans,    _historyFilters.beans);
  buildFilterChips(document.getElementById('history-filter-chips-grinder'), grinders, _historyFilters.grinders);
  buildFilterChips(document.getElementById('history-filter-chips-profile'), profiles, _historyFilters.profiles);
  historyFilterModalEl.hidden = false;
}

function _handleHistoryChipClick(event, activeSet) {
  const chip = event.target.closest('.filter-chip');
  if (!chip) return;
  const val = chip.dataset.value;
  if (activeSet.has(val)) { activeSet.delete(val); chip.classList.remove('is-selected'); }
  else                    { activeSet.add(val);    chip.classList.add('is-selected'); }
  _updateHistoryFilterBtn();
  renderHistory();
}

document.getElementById('btn-history-filter')?.addEventListener('click', _openHistoryFilterModal);

document.getElementById('btn-history-filter-done')?.addEventListener('click', () => {
  historyFilterModalEl.hidden = true;
});

document.getElementById('btn-history-filter-reset')?.addEventListener('click', () => {
  _historyFilters.roasters.clear();
  _historyFilters.beans.clear();
  _historyFilters.grinders.clear();
  _historyFilters.profiles.clear();
  _historyFilters.favoritesOnly = false;
  _historyFilters.minRating = 0;
  const favBtn = document.getElementById('history-filter-fav-btn');
  if (favBtn) favBtn.classList.remove('is-active');
  const ratingSlider = document.getElementById('history-filter-rating');
  if (ratingSlider) ratingSlider.value = 0;
  const ratingVal = document.getElementById('history-filter-rating-val');
  if (ratingVal) ratingVal.textContent = '—';
  historyFilterModalEl.hidden = true;
  _updateHistoryFilterBtn();
  renderHistory();
});

document.getElementById('history-filter-fav-btn')?.addEventListener('click', () => {
  _historyFilters.favoritesOnly = !_historyFilters.favoritesOnly;
  document.getElementById('history-filter-fav-btn')?.classList.toggle('is-active', _historyFilters.favoritesOnly);
  _updateHistoryFilterBtn();
  renderHistory();
});

document.getElementById('history-filter-rating')?.addEventListener('input', e => {
  const val = Number(e.target.value);
  _historyFilters.minRating = val;
  const ratingVal = document.getElementById('history-filter-rating-val');
  if (ratingVal) ratingVal.textContent = val > 0 ? `≥ ${val}` : '—';
  _updateHistoryFilterBtn();
  renderHistory();
});

historyFilterModalEl?.addEventListener('click', e => {
  if (e.target === historyFilterModalEl) historyFilterModalEl.hidden = true;
});

document.getElementById('history-filter-chips-roaster')?.addEventListener('click', e => _handleHistoryChipClick(e, _historyFilters.roasters));
document.getElementById('history-filter-chips-bean')?.addEventListener('click',    e => _handleHistoryChipClick(e, _historyFilters.beans));
document.getElementById('history-filter-chips-grinder')?.addEventListener('click', e => _handleHistoryChipClick(e, _historyFilters.grinders));
document.getElementById('history-filter-chips-profile')?.addEventListener('click', e => _handleHistoryChipClick(e, _historyFilters.profiles));

document.getElementById('history-search')?.addEventListener('input', e => {
  _historySearch = e.target.value.trim();
  clearTimeout(_historySearchTimer);
  if (!_historySearch) {
    historyShots = [...shots];
    renderHistory();
    return;
  }
  renderHistory();
  _historySearchTimer = setTimeout(async () => {
    try {
      const res = await fetchShots(200, 0, _historySearch);
      historyShots = Array.isArray(res?.items) ? res.items : [];
      renderHistory();
    } catch (err) {
      console.warn('History-Serversuche fehlgeschlagen:', err?.message);
    }
  }, 400);
});

/* ── API mapping helpers ──────────────────────────────– */

function calcRatio(dose, yield_) {
  return dose > 0 ? `1:${(yield_ / dose).toFixed(1)}` : "—";
}

function _resolveProfileTemp(prof) {
  // groupTemp (set by editor), then first frame temp, then tank_temperature
  const g = Number(prof?.groupTemp);
  if (Number.isFinite(g) && g > 0) return g;
  const frames = prof?.steps ?? prof?.frames ?? [];
  if (Array.isArray(frames)) {
    for (const f of frames) {
      const t = Number(f?.temperature);
      if (Number.isFinite(t) && t > 0) return t;
    }
  }
  const tank = Number(prof?.tank_temperature);
  return (Number.isFinite(tank) && tank > 0) ? tank : null;
}

function mapApiWorkflowToDisplay(wf) {
  const ctx = wf?.context || {};
  const dose = ctx.targetDoseWeight || 0;
  const yield_ = ctx.targetYield || 0;
  const prof = wf?.profile || {};
  const resolvedTemp = _resolveProfileTemp(prof);
  return {
    coffeeRoaster: ctx.coffeeRoaster || "—",
    coffeeName: ctx.coffeeName || "—",
    grinderModel: ctx.grinderModel || "—",
    grinderSetting: ctx.grinderSetting || "—",
    targetDoseWeight: dose,
    targetYield: yield_,
    ratio: calcRatio(dose, yield_),
    profileTitle: prof.title || wf?.name || "—",
    profileTemp: resolvedTemp != null ? `${resolvedTemp}°C` : "—",
    beverageType: String(prof.beverage_type || "") || "—",
    gatewayWorkflow: wf || null,
  };
}

function mapShotToWorkflow(shot) {
  const ctx = shot?.workflow?.context || {};
  const dose = ctx.targetDoseWeight || 0;
  const yield_ = ctx.targetYield || 0;
  const profileTitle =
    shot?.workflow?.profile?.title ||
    shot?.workflow?.profileTitle ||
    shot?.profileTitle ||
    shot?.workflow?.name ||
    "—";

  const shotProf = shot?.workflow?.profile || shot?.profile || {};
  const shotTemp = _resolveProfileTemp(shotProf);
  return {
    coffeeRoaster: ctx.coffeeRoaster || "—",
    coffeeName: ctx.coffeeName || "—",
    grinderModel: ctx.grinderModel || "—",
    grinderSetting: ctx.grinderSetting || "—",
    targetDoseWeight: dose,
    targetYield: yield_,
    ratio: calcRatio(dose, yield_),
    profileTitle,
    profileTemp: shotTemp != null ? `${shotTemp}°C` : "—",
  };
}

function normalizeWorkflowKeyPart(value) {
  return String(value || "—").trim().toLocaleLowerCase("de-DE");
}

function getWorkflowKey(workflow) {
  return [
    normalizeWorkflowKeyPart(workflow?.coffeeRoaster),
    normalizeWorkflowKeyPart(workflow?.coffeeName),
    normalizeWorkflowKeyPart(workflow?.grinderModel),
    normalizeWorkflowKeyPart(workflow?.profileTitle),
  ].join("||");
}

function formatShotDateShort(timestamp) {
  if (!timestamp) return "--.--.----";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "--.--.----";
  return new Intl.DateTimeFormat("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).format(date);
}

/* ── Shot caching and data helpers ───────────────────────– */

function getShotDetailsCached(shotId) {
  if (!shotId) {
    return Promise.reject(new Error("Ungültige Shot-ID"));
  }

  if (shotDetailsCache.has(shotId)) {
    return Promise.resolve(shotDetailsCache.get(shotId));
  }

  return fetchShotDetails(shotId).then((fullShot) => {
    shotDetailsCache.set(shotId, fullShot);
    const listShot = shots.find(s => s.id === shotId) || historyShots.find(s => s.id === shotId);
    if (listShot) {
      if (fullShot.annotations) listShot.annotations = fullShot.annotations;
      if (fullShot.metadata)    listShot.metadata    = fullShot.metadata;
    }
    return fullShot;
  });
}

function getShotDurationSeconds(fullShot) {
  const normalized = normalizeShotData(fullShot);
  if (!normalized?.elapsed?.length) return null;
  const last = normalized.elapsed[normalized.elapsed.length - 1];
  return Number.isFinite(last) ? Math.max(0, last) : null;
}

function normalizeShotData(shot) {
  if (!shot) return null;

  const toFiniteNumber = (value, fallback = 0) => {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };

  const normalizeTemperatureCelsius = (value) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    // Some records store deci-degrees (e.g. 890 => 89.0 C), others store C directly.
    return n > 200 ? n / 10 : n;
  };

  const frames = (() => {
    const profile = shot?.workflow?.profile || shot?.profile || null;
    const list = profile?.steps ?? profile?.frames ?? [];
    return Array.isArray(list) ? list : [];
  })();

  const rebaseElapsedToZero = (values) => {
    if (!Array.isArray(values) || values.length === 0) return [];
    const numeric = values.map((v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    });
    const first = numeric.find((v) => v !== null);
    const base = first != null ? first : 0;
    return numeric.map((v) => {
      if (v === null) return 0;
      return Math.max(0, v - base);
    });
  };

  if (shot.elapsed?.length) {
    const elapsed = rebaseElapsedToZero(shot.elapsed);
    return {
      ...shot,
      elapsed,
      scaleRate:
        shot.scaleRate ||
        shot.weightFlow ||
        shot.weight_flow ||
        shot.weightflow ||
        Array.from({ length: elapsed.length }, () => 0),
    };
  }

  const measurements = shot.measurements;
  if (!Array.isArray(measurements) || measurements.length === 0) return null;

  const elapsed = [];
  const pressure = [];
  const targetPressure = [];
  const flow = [];
  const targetFlow = [];
  const temperature = [];
  const targetTemperature = [];
  const scaleRate = [];
  const substates = [];
  const rawProfileFrames = [];

  let shotStartTime = null;

  for (const m of measurements) {
    const machine = m.machine;
    if (!machine || !machine.state) continue;

    if (machine.state.substate !== 'preinfusion' && machine.state.substate !== 'pouring') {
      continue;
    }

    const timestamp = new Date(machine.timestamp).getTime();
    if (!Number.isFinite(timestamp)) continue;
    if (shotStartTime == null) shotStartTime = timestamp;
    const time = (timestamp - shotStartTime) / 1000;
    if (time < 0) continue;

    elapsed.push(time);
    pressure.push(machine.pressure || 0);
    targetPressure.push(machine.targetPressure || 0);
    flow.push(machine.flow || 0);
    targetFlow.push(machine.targetFlow || 0);
    temperature.push(normalizeTemperatureCelsius(machine.groupTemperature));
    targetTemperature.push(normalizeTemperatureCelsius(machine.targetGroupTemperature));
    substates.push(machine.state?.substate || '');

    const rawProfileFrame =
      machine.profileFrame ??
      machine.profile_frame ??
      machine.state?.profileFrame ??
      machine.state?.profile_frame;
    const profileFrame = Number(rawProfileFrame);
    rawProfileFrames.push(Number.isFinite(profileFrame) ? profileFrame : null);

    const rawWeightFlow =
      m.scale?.weightFlow ??
      m.scale?.weight_flow ??
      m.scale?.flow ??
      machine.weightFlow ??
      machine.weight_flow ??
      m.weightFlow ??
      m.weight_flow;

    scaleRate.push(toFiniteNumber(rawWeightFlow, 0));
  }

  const phaseMarkers = [];
  let lastProfileFrame = null;
  for (let i = 0; i < rawProfileFrames.length; i += 1) {
    const profileFrame = rawProfileFrames[i];
    if (!Number.isFinite(profileFrame)) continue;
    if (profileFrame === lastProfileFrame) continue;

    const frameDef = frames[profileFrame] ?? null;
    const frameLabel = String(frameDef?.name || `Step ${profileFrame + 1}`);
    phaseMarkers.push({
      time: Math.max(0, Number(elapsed[i]) || 0),
      label: frameLabel,
    });
    lastProfileFrame = profileFrame;
  }

  return {
    elapsed,
    pressure,
    targetPressure,
    flow,
    targetFlow,
    temperature,
    targetTemperature,
    scaleRate,
    substates,
    phaseMarkers,
  };
}

function buildShotDiffData(currentShot, latestShot, currentDurationSec, latestDurationSec) {
  const current = mapShotToWorkflow(currentShot);
  const latest = mapShotToWorkflow(latestShot);

  const rows = [];
  const toNumberOrNull = (value) => {
    const n = Number(String(value ?? "").replace(",", "."));
    return Number.isFinite(n) ? n : null;
  };
  const formatSigned = (value, decimals = 1, unit = "") => {
    if (!Number.isFinite(value)) return "--";
    const sign = value > 0 ? "+" : "";
    return `${sign}${value.toFixed(decimals)}${unit}`;
  };

  const currentGrind = String(current.grinderSetting ?? "—").trim();
  const latestGrind = String(latest.grinderSetting ?? "—").trim();
  if (currentGrind !== latestGrind) {
    const currentGrindNum = toNumberOrNull(current.grinderSetting);
    const latestGrindNum = toNumberOrNull(latest.grinderSetting);
    const grindDelta =
      currentGrindNum !== null && latestGrindNum !== null
        ? ` (${formatSigned(currentGrindNum - latestGrindNum, 2)})`
        : "";
    rows.push({ label: t('recipe.grindSize'), value: `${current.grinderSetting || "—"}${grindDelta}` });
  }

  const currentDose = Number(current.targetDoseWeight || 0);
  const latestDose = Number(latest.targetDoseWeight || 0);
  if (Math.abs(currentDose - latestDose) > 0.0001) {
    const doseDelta = formatSigned(currentDose - latestDose, 1, "g");
    rows.push({ label: t('recipeEdit.dose'), value: `${currentDose.toFixed(1)}g (${doseDelta})` });
  }

  const currentYield = Number(current.targetYield || 0);
  const latestYield = Number(latest.targetYield || 0);
  const currentRatio = current.ratio || "—";
  const latestRatio = latest.ratio || "—";
  if (Math.abs(currentYield - latestYield) > 0.0001 || currentRatio !== latestRatio) {
    const yieldDelta = formatSigned(currentYield - latestYield, 1, "g");
    const currentRatioNum = currentDose > 0 ? currentYield / currentDose : null;
    const latestRatioNum = latestDose > 0 ? latestYield / latestDose : null;
    const ratioDelta =
      currentRatioNum !== null && latestRatioNum !== null
        ? formatSigned(currentRatioNum - latestRatioNum, 2)
        : "--";
    rows.push({
      label: t('recipe.beverage'),
      value: `${currentYield.toFixed(1)}g (${currentRatio}) (${yieldDelta}, ${ratioDelta})`,
    });
  }

  const hasCurrentDuration = Number.isFinite(currentDurationSec);
  const hasLatestDuration = Number.isFinite(latestDurationSec);
  if (hasCurrentDuration && (!hasLatestDuration || Math.abs(currentDurationSec - latestDurationSec) > 0.049)) {
    const durationDelta = hasLatestDuration
      ? formatSigned(currentDurationSec - latestDurationSec, 1, "s")
      : "--";
    rows.push({ label: t('recipe.duration'), value: `${currentDurationSec.toFixed(1)}s (${durationDelta})` });
  }

  return rows;
}

function buildWorkflowItemsFromShots(shotItems) {
  const grouped = new Map();

  for (const shot of shotItems) {
    const mapped = mapShotToWorkflow(shot);
    const key = [
      normalizeWorkflowKeyPart(mapped.coffeeRoaster),
      normalizeWorkflowKeyPart(mapped.coffeeName),
      normalizeWorkflowKeyPart(mapped.grinderModel),
      normalizeWorkflowKeyPart(mapped.profileTitle),
    ].join("||");

    const timestamp = shot?.timestamp ? Date.parse(shot.timestamp) : 0;
    const latestTimestamp = Number.isFinite(timestamp) ? timestamp : 0;
    const existing = grouped.get(key);

    const rv = Number(shot?.annotations?.enjoyment ?? shot?.metadata?.rating);
    const prevMax = existing?.ratingMax ?? null;
    const prevCount = existing?.ratingCount ?? 0;
    // ratingCount = how many shots share the maximum rating (not total rated shots)
    let ratingMax = prevMax;
    let ratingCount = prevCount;
    if (Number.isFinite(rv)) {
      if (prevMax === null || rv > prevMax) { ratingMax = rv; ratingCount = 1; }
      else if (rv === prevMax) { ratingCount = prevCount + 1; }
    }

    if (!existing || latestTimestamp >= existing.latestTimestamp) {
      grouped.set(key, {
        ...mapped,
        latestTimestamp,
        gatewayWorkflow: shot?.workflow || null,
        ratingMax,
        ratingCount,
      });
    } else {
      existing.ratingMax = ratingMax;
      existing.ratingCount = ratingCount;
    }
  }

  return Array.from(grouped.values())
    .sort((a, b) => b.latestTimestamp - a.latestTimestamp)
    .map(({ latestTimestamp, ratingMax, ratingCount, ...item }) => {
      const cached = _recipeRatingCache.get(getWorkflowKey(item));
      item.maxRating  = cached ? cached.max   : (ratingMax ?? null);
      item.ratedCount = cached ? cached.count : (ratingCount || 0);
      return item;
    });
}


function findShotsForWorkflow(workflow) {
  const source = shots;
  if (!workflow || !Array.isArray(source) || source.length === 0) {
    return [];
  }

  const key = getWorkflowKey(workflow);

  return source
    .filter((shot) => {
      const mapped = mapShotToWorkflow(shot);
      return getWorkflowKey(mapped) === key;
    })
    .sort((a, b) => {
      const tsA = Date.parse(a?.timestamp || 0);
      const tsB = Date.parse(b?.timestamp || 0);
      return (Number.isFinite(tsB) ? tsB : 0) - (Number.isFinite(tsA) ? tsA : 0);
    });
}

function findShotsForHistoryWorkflow(workflow, source) {
  if (!workflow || !Array.isArray(source) || source.length === 0) {
    return [];
  }

  const key = getWorkflowKey(workflow);

  return source
    .filter((shot) => {
      const mapped = mapShotToWorkflow(shot);
      return getWorkflowKey(mapped) === key;
    })
    .sort((a, b) => {
      const tsA = Date.parse(a?.timestamp || 0);
      const tsB = Date.parse(b?.timestamp || 0);
      return (Number.isFinite(tsB) ? tsB : 0) - (Number.isFinite(tsA) ? tsA : 0);
    });
}

/* ── Recipe Store (Bridge KV) ─────────────────────────── */

const _RECIPE_NS  = 'NSX';
const _RECIPE_KEY = 'recipes';

async function _loadRecipesFromStore() {
  try {
    const data = await getStoreValue?.(_RECIPE_NS, _RECIPE_KEY);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

async function _saveRecipesToStore(recipes) {
  try {
    await setStoreValue?.(_RECIPE_NS, _RECIPE_KEY, recipes);
  } catch (err) {
    console.warn('Rezepte konnten nicht gespeichert werden:', err?.message);
  }
}

function _makeRecipeId() {
  return `recipe-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

/* ── Workflow Management ──────────────────────────────── */

function _getLiveProfileFrames() {
  const profile = liveShot?.workflow?.profile;
  const title = profile?.title;

  // Prefer the profiles cache — it has frame names; the gateway payload often doesn't.
  if (title && _profileRecordsCache) {
    const match = _profileRecordsCache.find(r => String(r.profile?.title || '').trim() === title.trim());
    const cacheFrames = match?.profile?.steps ?? match?.profile?.frames;
    if (cacheFrames?.length) return cacheFrames;
  }

  // Fall back to whatever the gateway payload includes.
  return profile?.steps ?? profile?.frames ?? [];
}

function workflowToGatewayPayload(workflow) {
  if (workflow?._resolvedPayload) return workflow._resolvedPayload;
  if (workflow?.gatewayWorkflow && typeof workflow.gatewayWorkflow === "object") {
    return workflow.gatewayWorkflow;
  }
  return {
    profile: { title: workflow?.profileTitle || "—" },
    context: {
      coffeeRoaster: workflow?.coffeeRoaster || "—",
      coffeeName: workflow?.coffeeName || "—",
      grinderModel: workflow?.grinderModel || "—",
      grinderSetting: workflow?.grinderSetting || "—",
      targetDoseWeight: Number(workflow?.targetDoseWeight || 0),
      targetYield: Number(workflow?.targetYield || 0),
    },
  };
}

async function _buildRecipeGatewayPayload(workflow) {
  const title = String(workflow?.profileTitle || '').trim();
  const storedProfileId = String(workflow?.selectedProfileId || '').trim();
  const expectedProfile = Boolean(storedProfileId || (title && title !== '—'));
  let profileObj = null;
  let profileId  = null;

  const matchFrom = (records) => {
    const match =
      (storedProfileId && records.find(r => String(r.id || '') === storedProfileId)) ||
      (title && title !== '—' && (
        records.find(r => _isUserOwnedProfile(r) && String(r.profile?.title || '').trim() === title) ||
        records.find(r => String(r.profile?.title || '').trim() === title)
      ));
    if (!match) return false;
    // Prefer the user-owned copy with the same title and the highest version number.
    const matchTitle = String(match.profile?.title || '').trim();
    const userCopies = matchTitle
      ? records.filter(r => _isUserOwnedProfile(r) && String(r.profile?.title || '').trim() === matchTitle)
      : [];
    const bestUserCopy = userCopies.length
      ? userCopies.reduce((best, r) => (Number(r.profile?.version) || 0) > (Number(best.profile?.version) || 0) ? r : best)
      : null;
    const effective = bestUserCopy || match;
    profileObj = effective.profile;
    profileId  = effective.id ?? null;
    return true;
  };

  if (expectedProfile) {
    try { matchFrom(await _ensureProfilesLoaded()); } catch { /* fall through */ }
    // If the cache was empty/stale (e.g. right after wake), force a fresh load and retry once.
    if (!profileObj) {
      try { matchFrom(await _ensureProfilesLoaded(true)); } catch { /* fall through */ }
    }
    // Refuse to push a frameless profile — it would start the shot then immediately
    // stop it (and the gateway records nothing). Signal failure to the caller instead.
    if (!profileObj) return null;
  }

  let resolvedProfile;
  if (profileObj) {
    const desiredTemp = Number(workflow.groupTemp);
    const baseline    = _profileEditorGroupTemp(profileObj);
    const delta       = Number.isFinite(desiredTemp) && desiredTemp > 0 && Number.isFinite(baseline) && baseline > 0
      ? desiredTemp - baseline
      : 0;
    const stepsKey = Array.isArray(profileObj.steps) ? 'steps' : 'frames';
    const adjustedSteps = delta !== 0
      ? _extractFrames(profileObj).map(f => {
          const t = Number(f.temperature);
          return { ...f, temperature: Number.isFinite(t) ? Math.round((t + delta) * 10) / 10 : f.temperature };
        })
      : _extractFrames(profileObj);
    resolvedProfile = { ...profileObj, [stepsKey]: adjustedSteps, groupTemp: desiredTemp > 0 ? desiredTemp : (profileObj.groupTemp ?? baseline) };
  } else {
    resolvedProfile = { title };
  }

  if (!scaleConnected) {
    if (workflow.useVolumeStopWhenNoScale) {
      const factor = workflow.volumeCalibration?.factor ?? 1.0;
      const yield_ = Number(workflow.targetYield || 0);
      if (yield_ > 0 && factor > 0) {
        resolvedProfile = { ...resolvedProfile, target_volume: Math.round(yield_ * factor) };
      }
    } else {
      resolvedProfile = { ...resolvedProfile, target_volume: 0 };
    }
  }

  const tags = Array.isArray(workflow.tags) ? workflow.tags : [];
  const workflowName = [workflow.coffeeRoaster, workflow.coffeeName, resolvedProfile?.title || workflow.profileTitle]
    .map(v => String(v || '').trim())
    .filter(v => v && v !== '—')
    .join(' · ') || '—';
  const payload = {
    name: workflowName,
    profile: resolvedProfile,
    profileId,
    context: {
      coffeeRoaster:    workflow.coffeeRoaster    || '—',
      coffeeName:       workflow.coffeeName       || '—',
      grinderModel:     workflow.grinderModel     || '—',
      grinderSetting:   workflow.grinderSetting   || '—',
      targetDoseWeight: Number(workflow.targetDoseWeight || 0),
      targetYield:      Number(workflow.targetYield      || 0),
      ...(workflow.grinderId   ? { grinderId:   workflow.grinderId   } : {}),
      ...(workflow.beanBatchId ? { beanBatchId: workflow.beanBatchId } : {}),
      extras: tags.length > 0 ? { tags } : null,
    },
    // Bundle the machine-function settings into the same atomic workflow update so the
    // gateway applies them in ONE PUT (instead of 4 racing PUTs that get "Queue Cancelled").
    steamSettings: { targetTemperature: _steamEnabled ? steamTemp : 0, flow: _steamEnabled ? steamFlow : 0, duration: steamDuration },
    hotWaterData:  { targetTemperature: NSXCore.getHotwaterTemp(), volume: NSXCore.getHotwaterVolume() },
    rinseData:     { flow: NSXCore.getFlushFlow(), duration: NSXCore.getFlushDuration() },
  };

  workflow._resolvedPayload = payload;
  return payload;
}

async function pushSelectedWorkflowToMachine(workflow) {
  if (!workflow) return;

  if (!canExecuteOperation('setWorkflow')) {
    showToast(t('toast.recipeStateError').replace('{state}', currentMachineState));
    setWorkflowSyncState?.('error');
    return;
  }

  const nonce = ++_workflowPushNonce;
  try {
    const payload = await _buildRecipeGatewayPayload(workflow);
    if (nonce !== _workflowPushNonce) return;
    if (!payload) {
      // Profile could not be resolved — don't push an invalid (frameless) profile.
      setWorkflowSyncState?.('error');
      showToast(t('toast.recipeNotSet'));
      return;
    }
    await pushWorkflow({ context: { extras: null } });
    if (nonce !== _workflowPushNonce) return;
    await pushWorkflow(payload);
    setWorkflowSyncState?.('synced');
    showToast(`${workflow.coffeeRoaster} ${workflow.coffeeName}`);
    signalUserPresence();
  } catch (err) {
    console.warn("Rezept konnte nicht auf Maschine gesetzt werden:", err?.message || err);
    setWorkflowSyncState?.('error');
    showToast(t('toast.recipeNotSet'));
  }
}

async function _pushCurrentSkinStateToMachine(bypassStateCheck = false) {
  if (!bypassStateCheck && !canExecuteOperation('setWorkflow')) return;
  const workflow = workflowItems[selectedWorkflowIndex];
  if (workflow) {
    // The recipe payload already bundles steam/hotwater/flush → a single atomic PUT.
    const nonce = ++_workflowPushNonce;
    try {
      const payload = await _buildRecipeGatewayPayload(workflow);
      if (nonce !== _workflowPushNonce) return;
      if (payload) {
        await pushWorkflow(payload);
        setWorkflowSyncState?.('synced');
      } else {
        // Profile unresolved — leave the machine's current profile untouched rather
        // than overwriting it with an invalid (frameless) one.
        setWorkflowSyncState?.('error');
      }
    } catch (err) {
      console.warn('Rezept-Sync fehlgeschlagen:', err?.message);
      setWorkflowSyncState?.('error');
    }
    return;
  }
  // No recipe selected — still sync the standalone machine-function settings.
  try {
    await pushSteamSettings(_steamEnabled ? steamTemp : 0, _steamEnabled ? steamFlow : 0);
  } catch (err) {
    console.warn('Steam-Sync fehlgeschlagen:', err?.message);
  }
  try {
    await pushHotwaterSettings(NSXCore.getHotwaterTemp(), NSXCore.getHotwaterVolume());
  } catch (err) {
    console.warn('Hotwater-Sync fehlgeschlagen:', err?.message);
  }
  try {
    await pushFlushSettings(NSXCore.getFlushFlow(), NSXCore.getFlushDuration());
  } catch (err) {
    console.warn('Flush-Sync fehlgeschlagen:', err?.message);
  }
}

// Coalesce rapid state-sync triggers (init + scale:status + devices fire together at
// startup) into a single push, so we don't send several overlapping workflow PUTs.
let _pushStateTimer = null;
let _pushStateBypass = false;
function _schedulePushCurrentSkinState(bypassStateCheck = false) {
  _pushStateBypass = _pushStateBypass || bypassStateCheck;
  clearTimeout(_pushStateTimer);
  _pushStateTimer = setTimeout(() => {
    const bypass = _pushStateBypass;
    _pushStateBypass = false;
    _pushCurrentSkinStateToMachine(bypass).catch(() => {});
  }, 250);
}

let _pushDebounceTimer = null;

function renderHomeRecentRecipes() {
  const card   = document.getElementById('home-recent-recipes');
  const headEl = document.getElementById('home-rr-header');
  const rowsEl = document.getElementById('home-rr-rows');
  if (!card || !rowsEl) return;
  if (!workflowItems || workflowItems.length === 0) {
    card.hidden = false;
    if (headEl) headEl.innerHTML = '';
    rowsEl.innerHTML = `<button type="button" class="home-rr-row home-rr-row--empty">
      <span class="home-rr-empty-label">${t('home.createRecipe')}</span>
    </button>`;
    rowsEl.querySelector('.home-rr-row--empty')?.addEventListener('click', () => openWorkflowCreateModal());
    return;
  }
  const top3 = workflowItems
    .map((w, i) => ({ w, i }))
    .sort((a, b) => (b.w.lastUsed || 0) - (a.w.lastUsed || 0))
    .slice(0, 3);
  card.hidden = false;

  if (headEl) {
    const labels = [t('home.bean'), t('home.dose'), t('home.grinder'), t('home.grindSize'),
                    t('home.profile'), t('home.temperature'), t('home.inOut'), t('home.lastShot')];
    headEl.innerHTML = '<span></span>' + labels.map(l => `<span class="home-rr-header-cell">${l}</span>`).join('');
  }

  const c = v => `<span class="home-rr-cell">${v}</span>`;

  const rowData = top3.map(({ w, i }, rank) => {
    const bean     = [w.coffeeRoaster, w.coffeeName].filter(v => v && v !== '—').join(' · ') || '—';
    const dose     = w.targetDoseWeight > 0 ? `${w.targetDoseWeight}g` : '—';
    const grinder  = w.grinderModel || '—';
    const setting  = w.grinderSetting || '—';
    const profile  = w.profileTitle || '—';
    const g        = Number(w.groupTemp);
    const temp     = w.profileTemp || (g > 0 ? `${g}°C` : '—');
    const ratio    = w.ratio && w.ratio !== '—' ? w.ratio : '—';
    const lastShot = findShotsForWorkflow(w)[0];
    const sel = i === selectedWorkflowIndex;
    const existingDot = document.getElementById('home-workflow-sync');
    const syncState = sel && existingDot
      ? (['is-synced', 'is-pending', 'is-error'].find(cls => existingDot.classList.contains(cls)) ?? '')
      : '';
    const syncDot = sel ? `<span class="workflow-sync-dot home-rr-sync-dot${syncState ? ' ' + syncState : ''}"></span>` : '';
    return { i, rank, lastShot, html: `<button type="button" class="home-rr-row${sel ? ' is-selected' : ''}" data-workflow-index="${i}">
      <span class="home-rr-rank">${rank + 1}</span>
      ${c(bean)}${c(dose)}${c(grinder)}${c(setting)}${c(profile)}${c(temp)}${c(ratio)}<span class="home-rr-cell home-rr-dur" data-rr-shot-id="${lastShot?.id || ''}">—</span>
      ${syncDot}
    </button>` };
  });

  rowsEl.innerHTML = rowData.map(r => r.html).join('');

  rowsEl.querySelectorAll('.home-rr-row').forEach(row => {
    row.addEventListener('click', () => {
      const idx = Number(row.dataset.workflowIndex);
      row.style.transition = 'transform 100ms ease, opacity 100ms ease';
      row.style.transform = 'scale(0.98)';
      row.style.opacity = '0.75';
      setTimeout(() => {
        row.style.transform = '';
        row.style.opacity = '';
        row.style.transition = '';
        selectWorkflow(idx);
        if (storeSettings.nsx_recent_recipe_nav === true) {
          window.NSXRouter?.setTab(1);
        }
      }, 120);
    });
  });

  for (const { lastShot } of rowData) {
    if (!lastShot?.id) continue;
    getShotDetailsCached(lastShot.id)
      .then(full => {
        const secs = getShotDurationSeconds(full);
        if (!Number.isFinite(secs)) return;
        const span = rowsEl.querySelector(`.home-rr-dur[data-rr-shot-id="${lastShot.id}"]`);
        if (span) span.textContent = `${Math.round(secs)}s`;
      })
      .catch(() => {});
  }
}

function selectWorkflow(index) {
  if (!Number.isInteger(index) || index < 0 || index >= workflowItems.length) {
    return;
  }

  if (!workflowItems[index]?.isPending) {
    const pendingCount = workflowItems.filter(w => w.isPending).length;
    if (pendingCount > 0) {
      workflowItems = workflowItems.filter(w => !w.isPending);
      index = index - pendingCount;
      if (index < 0 || index >= workflowItems.length) return;
    }
  }

  _clearDoseScaleState();
  selectedWorkflowIndex = index;
  _lastRecipeId = workflowItems[index]?.id ?? null;
  patchStoreSettings({ nsx_last_recipe_id: _lastRecipeId });
  renderWorkflows(getDisplayWorkflows(), selectedWorkflowIndex);
  renderHomeRecentRecipes();
  setCurrentWorkflow(workflowItems[index]);
  plotWorkflowShot(workflowItems[index]);

  setWorkflowSyncState?.('pending');
  clearTimeout(_pushDebounceTimer);
  _pushDebounceTimer = setTimeout(() => {
    pushSelectedWorkflowToMachine(workflowItems[selectedWorkflowIndex]);
  }, 400);
}

function plotWorkflowShot(workflow, requestedIndex, _retrying = false) {
  const graphEl = document.getElementById("workflow-shot-graph");
  if (!graphEl) return;
  if (graphEl._liveMode && liveShot) return;

  const workflowKey = getWorkflowKey(workflow);
  const currentNavState = graphEl._shotNav;
  const workflowChanged = !currentNavState || currentNavState.workflowKey !== workflowKey;

  if (workflowChanged && !_retrying && fetchShots) {
    const filterParams = {
      limit: 30,
      offset: 0,
      ...(workflow.coffeeName && { coffeeName: workflow.coffeeName }),
      ...(workflow.coffeeRoaster && { coffeeRoaster: workflow.coffeeRoaster }),
      ...(workflow.grinderModel && { grinderModel: workflow.grinderModel }),
      ...(workflow.profileTitle && { profileTitle: workflow.profileTitle }),
    };
    fetchShots(filterParams).then(res => {
      const fetched = Array.isArray(res?.items) ? res.items : [];
      if (fetched.length > 0) {
        const existingIds = new Set(shots.map(s => s.id));
        const newShots = fetched.filter(s => !existingIds.has(s.id));
        if (newShots.length > 0) {
          shots = [...newShots, ...shots];
        }
      }
      plotWorkflowShot(workflow, requestedIndex, true);
    }).catch(() => {
      plotWorkflowShot(workflow, requestedIndex, true);
    });
    return;
  }

  const matchingShots = findShotsForWorkflow(workflow);

  if (matchingShots.length === 0) {
    graphEl.innerHTML = `<div style="display: flex; align-items: center; justify-content: center; height: 100%; color: var(--c-label-3);">${t('recipe.noShot')}</div>`;
    const reserveEl = document.getElementById('workflow-graph-reserve');
    if (reserveEl) {
      reserveEl.querySelector('.workflow-shot-meta')?.remove();
      reserveEl.querySelector('.workflow-shot-diff')?.remove();
      const histBtn = reserveEl.querySelector('#btn-workflow-history-shortcut');
      if (histBtn) histBtn.hidden = true;
    }
    graphEl.parentElement?.querySelector('.workflow-legend')?.remove();
    _updateScaleIndicatorVisibility();
    return;
  }

  const fallbackIndex = workflowChanged ? 0 : currentNavState.index;
  const rawIndex = Number.isInteger(requestedIndex) ? requestedIndex : fallbackIndex;
  const maxIndex = matchingShots.length - 1;
  const safeIndex = Math.max(0, Math.min(rawIndex, maxIndex));

  if (fetchShots && safeIndex >= matchingShots.length - 5) {
    const filterParams = {
      limit: 30,
      offset: matchingShots.length,
      ...(workflow.coffeeName && { coffeeName: workflow.coffeeName }),
      ...(workflow.coffeeRoaster && { coffeeRoaster: workflow.coffeeRoaster }),
      ...(workflow.grinderModel && { grinderModel: workflow.grinderModel }),
      ...(workflow.profileTitle && { profileTitle: workflow.profileTitle }),
    };
    fetchShots(filterParams).then(res => {
      const fetched = Array.isArray(res?.items) ? res.items : [];
      if (fetched.length > 0) {
        const existingIds = new Set(shots.map(s => s.id));
        shots = [...shots, ...fetched.filter(s => !existingIds.has(s.id))];
      }
    }).catch(() => {});
  }

  const shot = matchingShots[safeIndex];

  graphEl._shotNav = {
    workflowKey,
    index: safeIndex,
    total: matchingShots.length,
  };

  const latestShot = matchingShots[0];

  Promise.all([
    getShotDetailsCached(shot.id),
    shot.id === latestShot.id
      ? Promise.resolve(null)
      : getShotDetailsCached(latestShot.id).catch(() => null),
  ])
    .then(([fullShot, latestFullShot]) => {
      const currentDurationSec = getShotDurationSeconds(fullShot);
      const latestDurationSec =
        shot.id === latestShot.id
          ? currentDurationSec
          : getShotDurationSeconds(latestFullShot);

      const diffRows = buildShotDiffData(shot, latestShot, currentDurationSec, latestDurationSec);

      const isHistorical = safeIndex > 0;
      const navContext = {
        canGoOlder: safeIndex < maxIndex,
        canGoNewer: isHistorical,
        onOlder: () => plotWorkflowShot(workflow, safeIndex + 1),
        onNewer: () => plotWorkflowShot(workflow, safeIndex - 1),
        onAdoptRecipe: isHistorical ? () => {
          const shotWorkflow = {
            ...mapShotToWorkflow(fullShot),
            gatewayWorkflow: fullShot?.workflow || null,
          };
          pushSelectedWorkflowToMachine(shotWorkflow);
        } : undefined,
      };

      // API never returns annotations, and the re-fetched fullShot can lag behind an
      // edit (dose/yield etc.) that lives on the in-memory list shot — merge both so the
      // date-picker meta reflects the latest edit.
      const shotForGraph = {
        ...fullShot,
        ...(shot.annotations ? { annotations: shot.annotations } : {}),
        workflow: {
          ...(fullShot.workflow || {}),
          context: { ...(fullShot.workflow?.context || {}), ...(shot.workflow?.context || {}) },
        },
      };
      renderShotGraph(graphEl, shotForGraph, workflow, undefined, navContext, diffRows, normalizeShotData);
      _updateScaleIndicatorVisibility();

      const reserveEl = document.getElementById('workflow-graph-reserve');
      const histBtn = reserveEl?.querySelector('#btn-workflow-history-shortcut');
      if (histBtn) histBtn.hidden = false;

      const displayWorkflow = isHistorical ? mapShotToWorkflow(fullShot) : workflow;
      updateActiveWorkflowCardHistoricalValues?.(displayWorkflow);
    })
    .catch(err => {
      console.error("plotWorkflowShot: failed to load shot details:", err);
      graphEl.innerHTML = '<div style="display: flex; align-items: center; justify-content: center; height: 100%; color: var(--c-label-3);">Fehler beim Laden</div>';
    });
}

/* ── Espresso Fullscreen ───────────────────────────── */

const espressoFullscreenEl = document.getElementById('espresso-fullscreen');
const espressoFullscreenGraphEl = document.getElementById('espresso-fs-graph');

function _clearEspressoFullscreenCloseTimer() {
  if (_espressoFullscreenCloseTimer) {
    clearTimeout(_espressoFullscreenCloseTimer);
    _espressoFullscreenCloseTimer = null;
  }
}

function _scheduleEspressoFullscreenReturn() {
  _clearEspressoFullscreenCloseTimer();
  _espressoFullscreenCloseTimer = setTimeout(() => {
    _espressoFullscreenCloseTimer = null;
    if (currentMachineState === 'espresso') return;
    closeEspressoFullscreen();
    window.NSXRouter?.setTab(1);
  }, 2000);
}

function _getActiveWorkflow() {
  return _forcedLiveWorkflow || workflowItems[selectedWorkflowIndex] || null;
}

function _getLiveDisplayWeight() {
  if (scaleConnected) return liveWeight;
  const wf = _getActiveWorkflow();
  if (wf?.useVolumeStopWhenNoScale && _liveVolumeCountingActive) {
    const factor = wf.volumeCalibration?.factor ?? 1.0;
    return factor > 0 ? liveVolumeIntegrated / factor : 0;
  }
  return liveWeight;
}

function _formatFsStateLabel(state) {
  if (!state) return 'espresso';
  return String(state).replace(/([A-Z])/g, ' $1').trim();
}

function _setFsText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function _setFsProgress(percent) {
  const fillEl = document.getElementById('espresso-fs-progress');
  if (!fillEl) return;
  const safe = Math.max(0, Math.min(100, percent));
  fillEl.style.width = `${safe.toFixed(1)}%`;
}

function _updateReserveWidget() {
  const timeEl     = document.getElementById('shot-live-time');
  const weightEl   = document.getElementById('shot-live-weight');
  const progressEl = document.getElementById('shot-live-progress');
  if (!timeEl && !weightEl && !progressEl) return;

  const elapsed    = liveShot?.elapsed?.length ? liveShot.elapsed[liveShot.elapsed.length - 1] : 0;
  const weightNow  = _getLiveDisplayWeight();
  const workflow   = _getActiveWorkflow();
  const targetYield = Number(
    workflow?.targetYield
    || workflow?.gatewayWorkflow?.context?.targetYield
    || workflow?.gatewayWorkflow?.targetYield
    || 0
  );
  const targetText = targetYield > 0 ? targetYield.toFixed(0) : '—';
  const pct = targetYield > 0 ? Math.min(100, (weightNow / targetYield) * 100) : 0;

  if (timeEl)     timeEl.textContent  = `${Math.max(0, elapsed).toFixed(1)}s`;
  if (weightEl)   weightEl.textContent = `${weightNow.toFixed(1)} / ${targetText} g`;
  if (progressEl) progressEl.style.width = `${pct.toFixed(1)}%`;
}

function updateEspressoFullscreen() {
  if (!_espressoFullscreenVisible) return;

  const workflow = _getActiveWorkflow();
  const coffeeName = workflow?.coffeeName
    || workflow?.gatewayWorkflow?.context?.coffeeName
    || '—';
  const profileTitle = workflow?.profileTitle
    || workflow?.gatewayWorkflow?.profile?.title
    || t('shot.extraction');
  const targetYield = Number(
    workflow?.targetYield
    || workflow?.gatewayWorkflow?.context?.targetYield
    || workflow?.gatewayWorkflow?.targetYield
    || 0
  );

  const lastSnap = liveShot?.lastSnap || null;
  const elapsed = liveShot?.elapsed?.length ? liveShot.elapsed[liveShot.elapsed.length - 1] : 0;
  const pressure = Number(lastSnap?.pressure ?? 0);
  const flow = Number(lastSnap?.flow ?? 0);
  const temp = Number(lastSnap?.groupTemperature ?? 0);
  const waterText = Number.isFinite(currentWaterLevelPct) ? `${Math.round(currentWaterLevelPct)}%` : '—';
  const topTempText = Number.isFinite(temp) && temp > 0 ? `${temp.toFixed(1)}°C` : '—';
  const _displayWeight = _getLiveDisplayWeight();
  const topWeightText = `${_displayWeight.toFixed(1)}g`;
  const onlineText = machineConnectedState ? 'Online' : 'Offline';

  _setFsText('espresso-fs-coffee', coffeeName);
  _setFsText('espresso-fs-title', profileTitle);
  const fsStateText = _lastEspressoSubstate === 'pouring' && _lastProfileFrameLabel
    ? _lastProfileFrameLabel
    : _formatFsStateLabel(_lastEspressoSubstate || 'espresso');
  _setFsText('espresso-fs-state', fsStateText);
  _setFsText('espresso-fs-top-temp', topTempText);
  _setFsText('espresso-fs-top-water', waterText);
  _setFsText('espresso-fs-top-weight', topWeightText);
  _setFsText('espresso-fs-top-online', onlineText);

  _setFsText('espresso-fs-time', `${Math.max(0, elapsed).toFixed(1)}s`);
  _setFsText('espresso-fs-pressure', pressure.toFixed(1));
  _setFsText('espresso-fs-flow', flow.toFixed(1));
  _setFsText('espresso-fs-temp', Number.isFinite(temp) && temp > 0 ? temp.toFixed(1) : '—');

  const weightNow = _getLiveDisplayWeight();
  const targetText = targetYield > 0 ? targetYield.toFixed(0) : '—';
  _setFsText('espresso-fs-weight', `${weightNow.toFixed(1)} / ${targetText} g`);
  const pct = targetYield > 0 ? (weightNow / targetYield) * 100 : 0;
  _setFsProgress(pct);
}

function openEspressoFullscreen() {
  // Fullscreen disabled — live shot is shown in the Rezepte tab.
}

function closeEspressoFullscreen() {
  _clearEspressoFullscreenCloseTimer();
  _espressoFullscreenVisible = false;
  if (!espressoFullscreenEl) return;
  espressoFullscreenEl.hidden = true;
}

/* ── Live Shot Session ───────────────────────────────── */

function startLiveShotSession() {
  const workflow = _forcedLiveWorkflow || workflowItems[selectedWorkflowIndex];
  liveShot = {
    dataStart: null,
    elapsed: [],
    pressure: [],
    targetPressure: [],
    flow: [],
    targetFlow: [],
    temperature: [],
    targetTemperature: [],
    scaleRate: [],
    substates: [],
    phaseMarkers: [],
    lastProfileFrame: null,
    workflow: workflowToGatewayPayload(workflow),
    lastSnap: null,
  };
  liveWeight = 0;
  liveVolumeIntegrated = 0;
  _liveVolumeCountingActive = false;
  _lastSnapTime = null;
  currentScaleRate = 0;
  _skipStepInFlight = false;
  _skipStepGuardFrame = null;
  _skipStepLastSentAt = 0;

  document.querySelector('.workflow-graph-area')?.classList.add('is-live');
  _updateScaleIndicatorVisibility();

  requestAnimationFrame(() => {
    if (espressoFullscreenGraphEl) initLiveShotChart?.(espressoFullscreenGraphEl);
    const wfGraphEl = document.getElementById('workflow-shot-graph');
    if (wfGraphEl) initLiveShotChart?.(wfGraphEl);
  });
}

async function endLiveShotSession() {
  const _reserve = document.getElementById('workflow-graph-reserve');
  if (_reserve) { _reserve.classList.add('is-visible'); }

  const _capturedWeight        = liveWeight;
  const _capturedSubstate      = _lastEspressoSubstate;
  const _capturedWorkflow      = _forcedLiveWorkflow || workflowItems[selectedWorkflowIndex];
  const _capturedScaleConnected = scaleConnected;
  _lastEspressoSubstate   = null;
  _lastProfileFrameLabel  = null;

  const _wasDone = _capturedSubstate === 'pouringDone';
  const _targetYield  = Number(_capturedWorkflow?.targetYield  || 0);
  const _targetVolume = Number(_capturedWorkflow?.gatewayWorkflow?.profile?.target_volume
    || _capturedWorkflow?.profile?.target_volume || 0);

  const _wasWeightStop = _targetYield > 0 && _capturedWeight >= _targetYield * 0.92;

  let _stopReason;
  if (_wasWeightStop) {
    _stopReason = t('shot.stopWeight').replace('{weight}', _capturedWeight.toFixed(1));
  } else if (!_wasDone) {
    _stopReason = t('shot.stopManual');
  } else if (_targetVolume > 0) {
    _stopReason = t('shot.stopVolume');
  } else {
    _stopReason = t('shot.stopProfile');
  }
  showToast(_stopReason, 6000);

  const _capturedVolume = liveVolumeIntegrated;
  liveShot   = null;
  liveWeight = 0;
  liveVolumeIntegrated = 0;
  _liveVolumeCountingActive = false;
  _lastSnapTime = null;
  _skipStepInFlight = false;
  _skipStepGuardFrame = null;
  _skipStepLastSentAt = 0;
  _clearDoseScaleState();
  const prevCount = shots.length;
  const prevLatestShotId = shots[0]?.id || null;

  const _hideLiveWidget = () => {
    const r = document.getElementById('workflow-graph-reserve');
    if (r) r.classList.remove('shot-active');
    document.querySelector('.workflow-graph-area')?.classList.remove('is-live');
  };

  const _runPostShotActions = (newShot) => {
    if (!_capturedWorkflow || !newShot) return;

    // 1. Virtual scale calibration
    const recipeIdx = workflowItems.indexOf(_capturedWorkflow);
    if (newShot.id && recipeIdx !== -1) {
      getShotDetailsCached(newShot.id).then(fullShot => {
        let shotVolume = null;
        let shotWeight = null;
        const meas = fullShot?.measurements;
        if (Array.isArray(meas)) {
          for (let i = meas.length - 1; i >= 0; i--) {
            const w = meas[i]?.scale?.weight ?? meas[i]?.scale?.weight_grams ?? null;
            if (Number.isFinite(w) && w > 0 && shotWeight === null) { shotWeight = w; }
            const v = meas[i]?.machine?.volume ?? meas[i]?.volume ?? null;
            if (Number.isFinite(v) && v > 0 && shotVolume === null) { shotVolume = v; }
            if (shotWeight !== null && shotVolume !== null) break;
          }
        }
        if (shotVolume === null) {
          const snapVol = Number(fullShot?.snapshot?.volume);
          if (Number.isFinite(snapVol) && snapVol > 0) shotVolume = snapVol;
        }
        const newSample = Number.isFinite(shotVolume) && Number.isFinite(shotWeight) && shotWeight > 0
          ? shotVolume / shotWeight : null;
        const SAMPLE_MIN_VOLUME = 5;
        const SAMPLE_RATIO_MIN = 0.5;
        const SAMPLE_RATIO_MAX = 1.5;
        const sampleValid = newSample !== null
          && shotVolume >= SAMPLE_MIN_VOLUME
          && newSample >= SAMPLE_RATIO_MIN
          && newSample <= SAMPLE_RATIO_MAX;
        if (!sampleValid) return;
        const currentIdx = workflowItems.indexOf(_capturedWorkflow);
        if (currentIdx === -1) return;
        const recipe = workflowItems[currentIdx];
        const cal = recipe.volumeCalibration ?? { factor: 1.0, samples: [] };
        const samples = [...(cal.samples || []), newSample].slice(-4);
        const factor = samples.reduce((a, b) => a + b, 0) / samples.length;
        workflowItems[currentIdx] = { ...recipe, volumeCalibration: { factor, samples } };
        _saveRecipesToStore(workflowItems);
      }).catch(() => {});
    }

    // 2. Volume-stop estimated yield annotation
    if (_capturedWeight < 1 && _capturedWorkflow.useVolumeStopWhenNoScale && _capturedVolume > 0 && newShot.id) {
      const factor = _capturedWorkflow.volumeCalibration?.factor ?? 1.0;
      const estimatedYield = factor > 0 ? _capturedVolume / factor : 0;
      if (estimatedYield > 0) {
        const roundedYield = Math.round(estimatedYield * 10) / 10;
        const existingAnn = newShot.annotations ?? {};
        const existingExtras = existingAnn.extras ?? {};
        updateShotMetadata(newShot.id, {
          rating: existingAnn.enjoyment,
          favorite: existingExtras.favorite,
          notes: existingAnn.espressoNotes,
          tags: existingExtras.tags,
          actualYield: roundedYield,
          virtualScale: true,
        }).catch(() => {});
        newShot.annotations = {
          ...existingAnn,
          extras: { ...existingExtras, actualYield: roundedYield, virtualScale: true },
        };
      }
    }

    // 3. Deduct dose from bean batch weightRemaining
    const batchId = _capturedWorkflow.beanBatchId ?? null;
    const dose    = Number(_capturedWorkflow.targetDoseWeight) || 0;
    if (batchId && dose > 0) {
      fetchBatch(String(batchId)).then(batch => {
        if (batch?.weightRemaining != null) {
          const newWeight = Math.max(0, Number(batch.weightRemaining) - dose);
          return updateBatch(String(batchId), { weightRemaining: newWeight });
        }
      }).catch(err => console.warn('[NSX] batch deduction error:', err));
    }
  };

  const applyRefreshedShots = (newShots) => {
    shots = Array.isArray(newShots) ? newShots : [];

    _runPostShotActions(newShots[0]);

    if (workflowItems[selectedWorkflowIndex]) {
      workflowItems[selectedWorkflowIndex].lastUsed = Date.now();
      workflowItems.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
      selectedWorkflowIndex = 0;
      _saveRecipesToStore(workflowItems);
    } else if (workflowItems.length > 0) {
      selectedWorkflowIndex = Math.max(0, Math.min(selectedWorkflowIndex, workflowItems.length - 1));
    }
    renderWorkflows(getDisplayWorkflows(), selectedWorkflowIndex);
    if (workflowItems.length > 0) {
      setCurrentWorkflow(workflowItems[selectedWorkflowIndex]);
      plotWorkflowShot(workflowItems[selectedWorkflowIndex], 0);
    }
    renderHistory();
    _updateScaleIndicatorVisibility();
    setTimeout(_hideLiveWidget, 800);
  };

  const POLL_INTERVAL = 2000;
  const POLL_TIMEOUT  = 30000;
  const pollStart = Date.now();

  const pollForNewShot = async () => {
    try {
      const result  = await fetchShots(20);
      const newShots = result.items || [];
      const nextLatestShotId = newShots[0]?.id || null;
      const hasNew = (Boolean(nextLatestShotId) && nextLatestShotId !== prevLatestShotId)
                  || newShots.length > prevCount;
      if (hasNew) {
        const newIds = new Set(newShots.map(s => s.id));
        const merged = [...newShots, ...shots.filter(s => !newIds.has(s.id))];
        applyRefreshedShots(merged);
        return;
      }
    } catch (e) {
      console.warn('Shot poll error:', e.message);
    }

    if (Date.now() - pollStart < POLL_TIMEOUT) {
      setTimeout(pollForNewShot, POLL_INTERVAL);
    } else {
      _hideLiveWidget();
    }
  };

  pollForNewShot();
}

/* ── Steam Session ───────────────────────────────────── */

function startSteamSession() {
  steamSession = {
    startTime: Date.now(),
    elapsed: [],
    pressure: [],
    targetPressure: [],
    flow: [],
    targetFlow: [],
    scaleRate: [],
    temperature: [],
    targetTemperature: [],
  };

  const cornerEl        = document.getElementById('steam-corner');
  const cornerElapsedEl = document.getElementById('steam-corner-elapsed');
  const cornerRingEl    = document.getElementById('steam-corner-ring-progress');

  if (cornerRingEl)   cornerRingEl.style.strokeDashoffset = String(HW_CIRCUMFERENCE);
  if (cornerElapsedEl) cornerElapsedEl.textContent = '0';
  if (cornerEl)        cornerEl.hidden = false;

  steamTimerInterval = setInterval(() => {
    const sec = Math.floor((Date.now() - steamSession.startTime) / 1000);
    const remaining = Math.max(0, steamDuration - sec);
    if (cornerElapsedEl) cornerElapsedEl.textContent = String(remaining);
    if (cornerRingEl && steamDuration > 0) {
      const pct = Math.min(sec / steamDuration, 1);
      cornerRingEl.style.strokeDashoffset = String(HW_CIRCUMFERENCE * (1 - pct));
    }
    const remMm = String(Math.floor(remaining / 60)).padStart(2, '0');
    const remSs = String(remaining % 60).padStart(2, '0');
    const timeStr = `${remMm}:${remSs}`;
    const fullElapsedEl  = document.getElementById('steam-overlay-elapsed');
    const fullProgressEl = document.getElementById('steam-overlay-progress');
    if (fullElapsedEl)  fullElapsedEl.textContent = timeStr;
    if (fullProgressEl && steamDuration > 0) {
      const pct = Math.min(sec / steamDuration, 1) * 100;
      fullProgressEl.style.width = `${pct.toFixed(1)}%`;
    }
  }, 1000);
}

function endSteamSession() {
  clearInterval(steamTimerInterval);
  steamTimerInterval = null;
  steamSession = null;
  const cornerEl  = document.getElementById('steam-corner');
  const overlayEl = document.getElementById('steam-overlay');
  if (cornerEl)  cornerEl.hidden  = true;
  if (overlayEl) overlayEl.hidden = true;
}

/* ── Hot Water Session ────────────────────────────────── */
const HW_CIRCUMFERENCE = 2 * Math.PI * 80;

function startHotWaterSession() {
  _hotWaterStartWeight = liveWeight;
  _hotWaterDone = false;
  const overlayEl     = document.getElementById('hotwater-overlay');
  const centerEl      = document.getElementById('hotwater-ring-center');
  const dispensedEl   = document.getElementById('hotwater-dispensed');
  const targetLabelEl = document.getElementById('hotwater-target-label');
  const progressEl    = document.getElementById('hotwater-ring-progress');
  const doneEl        = document.getElementById('hotwater-done-overlay');
  if (centerEl)       centerEl.hidden = false;
  if (dispensedEl)    dispensedEl.textContent = '0';
  if (targetLabelEl)  targetLabelEl.textContent = NSXCore.getHotwaterVolume() > 0 ? `/ ${NSXCore.getHotwaterVolume()} ml` : '/ — ml';
  if (progressEl)     progressEl.style.strokeDashoffset = String(HW_CIRCUMFERENCE);
  if (doneEl)         doneEl.hidden = true;
  if (overlayEl)      overlayEl.hidden = false;
}

function endHotWaterSession() {
  _hotWaterStartWeight = 0;
  _hotWaterDone = false;
  const overlayEl = document.getElementById('hotwater-overlay');
  if (overlayEl) overlayEl.hidden = true;
}

/* ── Flush Session ───────────────────────────────────── */
function startFlushSession() {
  _flushStartTime = Date.now();
  _flushDone = false;
  const overlayEl    = document.getElementById('flush-overlay');
  const centerEl     = document.getElementById('flush-ring-center');
  const elapsedEl    = document.getElementById('flush-elapsed');
  const targetLabelEl = document.getElementById('flush-target-label');
  const progressEl   = document.getElementById('flush-ring-progress');
  const doneEl       = document.getElementById('flush-done-overlay');
  if (centerEl)      centerEl.hidden = false;
  if (elapsedEl)     elapsedEl.textContent = '0';
  if (progressEl)    progressEl.style.strokeDashoffset = String(HW_CIRCUMFERENCE);
  if (doneEl)        doneEl.hidden = true;
  if (overlayEl)     overlayEl.hidden = false;

  _flushTimerInterval = setInterval(() => {
    const elapsed = (Date.now() - _flushStartTime) / 1000;
    const flushDuration = NSXCore.getFlushDuration();
    if (elapsedEl) elapsedEl.textContent = String(Math.max(0, flushDuration - Math.floor(elapsed)));
    if (progressEl && flushDuration > 0) {
      const pct = Math.min(elapsed / flushDuration, 1);
      progressEl.style.strokeDashoffset = String(HW_CIRCUMFERENCE * (1 - pct));
      if (pct >= 1) {
        clearInterval(_flushTimerInterval);
        _flushTimerInterval = null;
        _flushDone = true;
        setMachineState?.('idle').catch(() => {});
        if (centerEl) centerEl.hidden = true;
        if (doneEl)   doneEl.hidden = false;
        setTimeout(endFlushSession, 2000);
      }
    }
  }, 250);
}

function endFlushSession() {
  clearInterval(_flushTimerInterval);
  _flushTimerInterval = null;
  _flushStartTime = 0;
  _flushDone = false;
  const overlayEl = document.getElementById('flush-overlay');
  if (overlayEl) overlayEl.hidden = true;
}

/* ── Needs Water Overlay ─────────────────────────────── */

function showNeedsWaterOverlay() {
  const overlayEl = document.getElementById('needswater-overlay');
  if (overlayEl) overlayEl.hidden = false;
}

function hideNeedsWaterOverlay() {
  const overlayEl = document.getElementById('needswater-overlay');
  if (overlayEl) overlayEl.hidden = true;
}

/* ── API Data Loading ────────────────────────────────── */

async function loadApiData() {
  try {
    const info = await fetchMachineInfo();
    setMachineInfo(info);
  } catch (e) {
    console.warn("Maschinen-Info konnte nicht geladen werden:", e.message);
  }

  try {
    const wf = await fetchCurrentWorkflow();
    setCurrentWorkflow(mapApiWorkflowToDisplay(wf));
    setWorkflowSyncState?.('synced');
  } catch (e) {
    console.warn("Aktueller Workflow konnte nicht geladen werden:", e.message);
  }

  _ensureProfilesLoaded().catch(() => {});

  try {
    const schedules = await fetchSchedules();
    const existing = Array.isArray(schedules) ? schedules[0] : schedules?.items?.[0];
    if (existing?.id && !scheduleState.scheduleId) {
      scheduleState.scheduleId = existing.id;
      saveScheduleState();
      console.log('[Schedule] Loaded existing schedule id from API:', existing.id);
    }
  } catch (e) {
    console.warn('[Schedule] Could not fetch schedules on startup:', e.message);
  }

  try {
    const [storedRecipes, shotsResult] = await Promise.all([
      _loadRecipesFromStore(),
      fetchShots(200).catch(() => ({ items: [], total: 0 })),
    ]);
    shots = shotsResult.items || [];
    _shotsTotalCount = Number.isFinite(shotsResult.total) ? shotsResult.total : shots.length;

    workflowItems = storedRecipes;
    workflowItems.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));

    if (workflowItems.length > 0 && _lastRecipeId) {
      const stored = workflowItems.findIndex(w => w.id === _lastRecipeId);
      if (stored >= 0) selectedWorkflowIndex = stored;
    }

    renderWorkflows(getDisplayWorkflows(), selectedWorkflowIndex);
    renderHomeRecentRecipes();
    renderHistory();
    if (workflowItems.length > 0) {
      setCurrentWorkflow(workflowItems[selectedWorkflowIndex]);
      plotWorkflowShot(workflowItems[selectedWorkflowIndex]);
      if (canExecuteOperation('setWorkflow')) {
        _schedulePushCurrentSkinState();
      }
    } else {
      setCurrentWorkflow(null);
    }
  } catch (e) {
    console.warn("Initialisierung fehlgeschlagen:", e.message);
    workflowItems = [];
    renderWorkflows([], selectedWorkflowIndex);
    renderHistory();
  }
}

/* ── Clock ────────────────────────────────────────────– */

function tick() {
  const clockEl = document.getElementById("clock");
  if (clockEl) {
    clockEl.textContent = new Date().toLocaleTimeString("de-DE", {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
}
tick();
setInterval(tick, 1000);

/* ── Presence Heartbeat (Reaprime Best Practice) ──────────– */
function signalUserPresence() {
  if (!_presenceEnabled) return;

  if (typeof apiSignalUserPresenceHeartbeat === 'function') {
    apiSignalUserPresenceHeartbeat()
      .catch(err => console.debug('Heartbeat failed:', err.message));
    return;
  }

  fetch(`${GATEWAY}/api/v1/machine/heartbeat`, { method: 'POST' })
    .catch(err => console.debug('Heartbeat failed:', err.message));
}

function setupPresenceTracking() {
  ['pointerdown', 'keydown', 'touchstart'].forEach(event => {
    document.addEventListener(event, signalUserPresence, { passive: true });
  });
}

/* ── Display Control (Reaprime Best Practice) ─────────────– */
function setupDisplayControl() {
  const wsUrl = WS_BASE + '/ws/v1/display';

  const connect = () => {
    try {
      displayWs = new WebSocket(wsUrl);

      displayWs.onopen = () => {
        displayReconnectDelay = 1000;
      };

      displayWs.onmessage = (event) => {
        try {
          JSON.parse(event.data);
        } catch {
          // ignore invalid display state frames
        }
      };

      displayWs.onerror = () => {
        // close triggers reconnect
      };

      displayWs.onclose = () => {
        setTimeout(connect, displayReconnectDelay);
        displayReconnectDelay = Math.min(displayReconnectDelay * 2, 30_000);
      };
    } catch (err) {
      console.debug('Display control not available:', err.message);
    }
  };

  connect();
}

/* ── Event Listeners ──────────────────────────────────– */

window.addEventListener('ui:seriesVisibilityChanged', ({ detail }) => {
  if (detail.mode === 'history') {
    patchStoreSettings({ nsx_series_visibility_history: detail.visibility });
  } else if (detail.mode !== 'live') {
    patchStoreSettings({ nsx_series_visibility: detail.visibility });
  }
});

window.addEventListener("gateway:status", (event) => {
  machineConnectedState = Boolean(event.detail?.connected);
  setMachineConnected(machineConnectedState);
  updateEspressoFullscreen();
  if (!event.detail?.connected && machineStateBannerEl) {
    machineStateBannerEl.hidden = true;
  }
});

let scaleConnected = false;

window.addEventListener("scale:status", (event) => {
  const wasConnected = scaleConnected;
  scaleConnected = Boolean(event.detail?.connected);
  setScaleConnected(scaleConnected);
  const toggle = document.getElementById('scale-connect-toggle');
  if (toggle) toggle.checked = scaleConnected;
  const scalePill = document.getElementById('workflow-scale-pill');
  if (scalePill && !scaleConnected) scalePill.textContent = '';
  if (scaleConnected !== wasConnected) _schedulePushCurrentSkinState();
});

window.addEventListener("gateway:devices", (event) => {
  const machineConnected = Boolean(event.detail?.machineConnected);
  const scaleIsConnected = Boolean(event.detail?.scaleConnected);

  machineConnectedState = machineConnected;
  setMachineConnected(machineConnected);
  scaleConnected = scaleIsConnected;
  setScaleConnected(scaleConnected);
  updateEspressoFullscreen();

  const toggle = document.getElementById('scale-connect-toggle');
  if (toggle) toggle.checked = scaleConnected;
});

let _lastAutoTareAt = 0;
function _maybeAutoTareNegative(weight) {
  if (storeSettings.nsx_tare_on_negative === false) return;
  if (!scaleConnected || !Number.isFinite(weight) || weight >= -1.0) return;
  // Don't interfere while the machine is actively dispensing.
  if (['espresso', 'steam', 'hotWater', 'flush'].includes(currentMachineState)) return;
  const now = Date.now();
  if (now - _lastAutoTareAt < 1500) return;
  _lastAutoTareAt = now;
  tareScale?.().catch(() => {});
}

window.addEventListener("scale:weight", (event) => {
  const newWeight = event.detail?.weight ?? liveWeight;
  const apiRate = event.detail?.weightFlow ?? event.detail?.weight_flow;
  currentScaleRate = Number.isFinite(apiRate) && apiRate >= 0 ? apiRate : 0;
  liveWeight = newWeight;
  _maybeAutoTareNegative(newWeight);
  const scalePill = document.getElementById('workflow-scale-pill');
  if (scalePill) scalePill.textContent = scaleConnected ? newWeight.toFixed(1) + 'g' : '';
  const dosePill = document.getElementById('workflow-dose-pill');
  if (dosePill) {
    const doseWidget = document.getElementById('workflow-dose-widget');
    if (scaleConnected && doseWidget && !doseWidget.hidden) {
      const cup = Number(storeSettings.nsx_dosing_cup_weight) || 0;
      dosePill.textContent = `${(newWeight - cup).toFixed(1)}g`;
    } else {
      dosePill.textContent = '';
    }
  }
  const sbwPill = document.getElementById('workflow-sbw-pill');
  if (sbwPill) {
    const sbwWidget = document.getElementById('workflow-sbw-widget');
    const pitcher = pitcherPresets[activePitcherIndex];
    if (scaleConnected && sbwWidget && !sbwWidget.hidden && pitcher?.pitcherWeight != null) {
      sbwPill.textContent = `${(newWeight - pitcher.pitcherWeight).toFixed(1)}g`;
    } else {
      sbwPill.textContent = '';
    }
  }
  updateEspressoFullscreen();
  if (currentMachineState === 'hotWater' && !_hotWaterDone) {
    const dispensed = Math.max(0, newWeight - _hotWaterStartWeight);
    const dispensedEl = document.getElementById('hotwater-dispensed');
    const progressEl  = document.getElementById('hotwater-ring-progress');
    if (dispensedEl) dispensedEl.textContent = dispensed.toFixed(0);
    if (progressEl && NSXCore.getHotwaterVolume() > 0) {
      const pct = Math.min(dispensed / NSXCore.getHotwaterVolume(), 1);
      progressEl.style.strokeDashoffset = String(HW_CIRCUMFERENCE * (1 - pct));
      if (pct >= 1) {
        _hotWaterDone = true;
        const centerEl = document.getElementById('hotwater-ring-center');
        const doneEl   = document.getElementById('hotwater-done-overlay');
        if (centerEl) centerEl.hidden = true;
        if (doneEl)   doneEl.hidden = false;
        setTimeout(endHotWaterSession, 2000);
      }
    }
  }
});

document.getElementById('scale-connect-toggle')?.addEventListener('change', (event) => {
  if (event.target.checked) {
    initiateScaleConnect?.();
    setTimeout(() => {
      if (!scaleConnected) {
        const toggle = document.getElementById('scale-connect-toggle');
        if (toggle) toggle.checked = false;
      }
    }, 5000);
  } else {
    disconnectScale?.();
  }
});

document.getElementById('machine-icon-area')?.addEventListener('click', () => {
  if (!machineConnectedState) {
    initiateDE1Connect?.();
  }
});

window.addEventListener("water:level", (event) => {
  const level = Number(event.detail?.currentLevel);
  const refillLevel = Number(event.detail?.refillLevel);
  if (Number.isFinite(level)) {
    currentWaterLevelPct = level;
    setWaterLevel(level);
  }
  if (Number.isFinite(refillLevel) && refillLevel !== refillLevelMm) {
    refillLevelMm = refillLevel;
    setWaterRefillLevel(refillLevel);
  }
});

window.addEventListener("gateway:timeToReady", (event) => {
  if (!readyInChipEl) return;
  const { remainingMs } = event.detail;
  const isWarmingUp = currentMachineState === 'heating' || currentMachineState === 'preheating';
  if (isWarmingUp && typeof remainingMs === 'number' && remainingMs > 0) {
    readyInChipEl.textContent = t('machine.readyIn').replace('{time}', formatMmSs(remainingMs));
    readyInChipEl.hidden = false;
  } else {
    readyInChipEl.hidden = true;
  }
});

const MACHINE_STATE_LABELS = {
  sleeping:       () => t('machine.state.sleeping'),
  heating:        () => t('machine.state.heating'),
  preheating:     () => t('machine.state.preheating'),
  espresso:       () => t('machine.state.espresso'),
  steam:          () => t('steam.title'),
  hotWater:       () => t('hotwater.title'),
  cleanMeSoon:    () => t('machine.state.cleanMeSoon'),
  descaleNeeded:  () => t('machine.state.descaleNeeded'),
};

window.addEventListener("gateway:machineState", (event) => {
  const state = event.detail?.state || 'idle';
  const substate = event.detail?.substate;
  const prevState = currentMachineState;
  const wasEspressoLike = _isEspressoLikeState(prevState);
  const isEspressoLike = _isEspressoLikeState(state);
  currentMachineState = state;
  setMachineStateText(state);
  _updatePhoneMachineCard();

  if (state !== prevState && MACHINE_STATE_LABELS[state]) {
    showStateToast?.(MACHINE_STATE_LABELS[state]());
  }
  updateMachineStateBanner(state, substate);
  const toggle = document.getElementById('machine-power-toggle');
  if (toggle) toggle.checked = state !== 'sleeping';

  const historyTabEl = document.getElementById('tabitem-history');
  if (historyTabEl) historyTabEl.hidden = state === 'espresso';

  if (state === 'espresso' && !wasEspressoLike) {
    window.NSXRouter?.setTab(1);
    tareScale?.().catch(() => {});
    startLiveShotSession();
    const _reserve = document.getElementById('workflow-graph-reserve');
    if (_reserve) { _reserve.classList.add('is-visible'); _reserve.classList.add('shot-active'); }
  } else if (wasEspressoLike && !isEspressoLike) {
    _clearSkipStepRecoveryTimer();
    endLiveShotSession();
  } else if (state === 'skipStep' && wasEspressoLike) {
    _scheduleSkipStepRecovery();
  } else if (state === 'espresso') {
    _clearSkipStepRecoveryTimer();
  }

  if (state === 'steam' && prevState !== 'steam') {
    startSteamSession();
  } else if (prevState === 'steam' && state !== 'steam') {
    endSteamSession();
  }

  if (state === 'hotWater' && prevState !== 'hotWater') {
    startHotWaterSession();
  } else if (prevState === 'hotWater' && state !== 'hotWater' && !_hotWaterDone) {
    endHotWaterSession();
  }

  if (state === 'flush' && prevState !== 'flush') {
    startFlushSession();
  } else if (prevState === 'flush' && state !== 'flush' && !_flushDone) {
    endFlushSession();
  }

  if (state === 'needsWater' && prevState !== 'needsWater') {
    showNeedsWaterOverlay();
  } else if (prevState === 'needsWater' && state !== 'needsWater') {
    hideNeedsWaterOverlay();
  }

  window.NSXScreensaver?.handleMachineState(state);
});


window.addEventListener("gateway:snapshot", (event) => {
  const snap = event.detail;
  if (Number.isFinite(snap?.groupTemperature)) {
    _phoneGroupTemp = snap.groupTemperature;
    setBrewGroupTemperature(snap.groupTemperature);
  }
  if (Number.isFinite(snap?.steamTemperature)) {
    _phoneSteamTemp = snap.steamTemperature;
    setSteamTemperatureOrb?.(snap.steamTemperature);
  }
  _updatePhoneMachineCard();

  if (steamSession && snap?.state?.state === 'steam') {
    const t = (Date.now() - steamSession.startTime) / 1000;
    steamSession.elapsed.push(t);
    steamSession.pressure.push(snap.pressure ?? 0);
    steamSession.targetPressure.push(null);
    steamSession.flow.push(snap.flow ?? 0);
    steamSession.targetFlow.push(null);
    steamSession.scaleRate.push(null);
    steamSession.temperature.push(snap.steamTemperature ?? null);
    steamSession.targetTemperature.push(null);

    const graphEl = document.getElementById('steam-overlay-graph');
    if (graphEl?._liveMode) updateSteamChart?.(graphEl, steamSession);

    const snapPressure = snap.pressure ?? null;
    const snapFlow     = snap.flow     ?? null;
    const snapTemp     = snap.steamTemperature ?? null;
    const pEl = document.getElementById('steam-corner-pressure');
    const fEl = document.getElementById('steam-corner-flow');
    const tEl = document.getElementById('steam-corner-temp');
    if (pEl) pEl.textContent = Number.isFinite(snapPressure) ? snapPressure.toFixed(1) : '—';
    if (fEl) fEl.textContent = Number.isFinite(snapFlow)     ? snapFlow.toFixed(1)     : '—';
    if (tEl) tEl.textContent = Number.isFinite(snapTemp)     ? Math.round(snapTemp).toString() : '—';
  }

  if (snap?.state?.state === 'espresso' && snap.state?.substate) {
    _lastEspressoSubstate = snap.state.substate;
  }
  if (snap?.state?.state === 'espresso' && !liveShot) {
    updateEspressoFullscreen();
  }

  if (liveShot && snap?.state?.state === 'espresso') {
    const substate = snap.state?.substate;
    if (substate === 'preinfusion' || substate === 'pouring') {
      if (liveShot.dataStart === null) {
        liveShot.dataStart = new Date(snap.timestamp).getTime();
      }
      const t = (new Date(snap.timestamp).getTime() - liveShot.dataStart) / 1000;
      const frames = _getLiveProfileFrames();
      const rawProfileFrame =
        snap.profileFrame ??
        snap.profile_frame ??
        snap.state?.profileFrame ??
        snap.state?.profile_frame;
      const profileFrame = Number(rawProfileFrame);

      if (Number.isFinite(profileFrame) && profileFrame !== liveShot.lastProfileFrame) {
        const frameDef = frames[profileFrame] ?? null;
        const frameLabel = String(frameDef?.name || `Step ${profileFrame + 1}`);
        liveShot.phaseMarkers.push({ time: Math.max(0, t), label: frameLabel });
        if (substate === 'pouring') _lastProfileFrameLabel = frameLabel;
        if (_skipStepGuardFrame !== null && profileFrame !== _skipStepGuardFrame) {
          _skipStepGuardFrame = null;
        }
        liveShot.lastProfileFrame = profileFrame;
      }

      if (!scaleConnected) {
        const activeWf = _getActiveWorkflow();
        if (activeWf?.useVolumeStopWhenNoScale) {
          const countStart = Number(
            activeWf._resolvedPayload?.profile?.target_volume_count_start
            ?? activeWf.gatewayWorkflow?.profile?.target_volume_count_start
            ?? 0
          );
          const snapTime = new Date(snap.timestamp).getTime();
          if (Number.isFinite(profileFrame) && profileFrame >= countStart) {
            if (!_liveVolumeCountingActive) {
              _liveVolumeCountingActive = true;
              _lastSnapTime = snapTime;
            }
            if (_lastSnapTime !== null) {
              const dt = (snapTime - _lastSnapTime) / 1000;
              if (dt > 0 && dt < 2) {
                liveVolumeIntegrated += Number(snap.flow ?? 0) * dt;
              }
            }
            _lastSnapTime = snapTime;
          }
        }
      }

      liveShot.elapsed.push(t);
      liveShot.pressure.push(snap.pressure ?? 0);
      liveShot.targetPressure.push(snap.targetPressure > 0 ? snap.targetPressure : null);
      liveShot.flow.push(snap.flow ?? 0);
      liveShot.targetFlow.push(snap.targetFlow > 0 ? snap.targetFlow : null);
      liveShot.temperature.push(snap.groupTemperature ?? 0);
      liveShot.targetTemperature.push(snap.targetGroupTemperature > 0 ? snap.targetGroupTemperature : null);
      liveShot.scaleRate.push(currentScaleRate);
      liveShot.substates.push(substate);
    }
    liveShot.lastSnap = snap;

    if (espressoFullscreenGraphEl?._liveMode) {
      updateLiveShotChart?.(espressoFullscreenGraphEl, liveShot);
    }
    const wfGraphEl = document.getElementById('workflow-shot-graph');
    if (wfGraphEl?._liveMode) {
      updateLiveShotChart?.(wfGraphEl, liveShot);
      updateWorkflowLegendLive?.(wfGraphEl, {
        pressure:    Number(snap.pressure    ?? 0),
        flow:        Number(snap.flow        ?? 0),
        scaleRate:   currentScaleRate,
        temperature: Number(snap.groupTemperature ?? 0),
      });
    }
    _updateReserveWidget();
    updateEspressoFullscreen();
  }

});

const workflowListEl = document.getElementById("workflow-list");

const scaleTareButtonEl = document.getElementById("btn-scale-tare");
const waterRefillLabelEl = document.getElementById("water-refill-label");
const recipeListScrollEl = document.getElementById("recipe-list-scroll");

document.getElementById('btn-workflow-edit-active')?.addEventListener('click', () => {
  const activeCard = workflowListEl.querySelector('.workflow-card-active');
  if (activeCard) openWorkflowEditModal(Number(activeCard.dataset.workflowIndex));
});

workflowListEl.addEventListener("click", (event) => {

  const deleteBtn = event.target.closest(".workflow-delete-btn");
  if (deleteBtn && workflowListEl.contains(deleteBtn)) {
    openDeleteConfirm(Number(deleteBtn.dataset.deleteIndex));
    return;
  }

  const cardEl = event.target.closest(".workflow-card");
  if (!cardEl || !workflowListEl.contains(cardEl)) {
    return;
  }

  const nextIndex = Number(cardEl.dataset.workflowIndex);
  if (Number.isNaN(nextIndex) || nextIndex === selectedWorkflowIndex) {
    return;
  }

  cardEl.style.transition = 'transform 100ms ease, opacity 100ms ease';
  cardEl.style.transform = 'scale(0.98)';
  cardEl.style.opacity = '0.75';

  closeAllSwipes();
  setTimeout(() => {
    cardEl.style.transform = '';
    cardEl.style.opacity = '';
    cardEl.style.transition = '';
    selectWorkflow(nextIndex);
  }, 120);
});

recipeListScrollEl.addEventListener("scroll", updateRecipeListFade, { passive: true });

/* ── Workflow Search ──────────────────────────────────── */
const workflowSearchEl = document.querySelector('.workflows-search');
workflowSearchEl?.addEventListener('input', () => {
  workflowSearchQuery = workflowSearchEl.value.trim();
  renderWorkflows(getDisplayWorkflows(), selectedWorkflowIndex);
});


// Rubber-band overswing for workflow list
;(() => {
  const el = recipeListScrollEl;
  let startY = 0;
  let active = false;

  el.addEventListener('touchstart', e => {
    startY = e.touches[0].clientY;
    active = true;
    el.style.transition = '';
  }, { passive: true });

  el.addEventListener('touchmove', e => {
    if (!active) return;
    const dy = e.touches[0].clientY - startY;
    const atTop = el.scrollTop <= 0;
    const atBottom = el.scrollTop >= el.scrollHeight - el.clientHeight - 1;
    if ((atTop && dy > 0) || (atBottom && dy < 0)) {
      el.style.transform = `translateY(${dy * 0.28}px)`;
    } else {
      el.style.transform = '';
    }
  }, { passive: true });

  const release = () => {
    if (!active) return;
    active = false;
    el.style.transition = 'transform 440ms cubic-bezier(0.23, 1, 0.32, 1)';
    el.style.transform = 'translateY(0)';
    el.addEventListener('transitionend', () => { el.style.transition = ''; }, { once: true });
  };

  el.addEventListener('touchend', release, { passive: true });
  el.addEventListener('touchcancel', release, { passive: true });
})();

if (menuButtonEl) {
  menuButtonEl.addEventListener("click", () => {
    window.NSXSettings?.open();
  });
}

document.getElementById('btn-app-settings')?.addEventListener('click', () => {
  window.NSXSettings?.open();
});

const SKIN_DEFAULTS = {
  language: 'en',
  theme: 'dark',
  scaleKey: 'auto',
  brightness: 100,
  presenceEnabled: false,
  sleepTimeoutMinutes: 60,
  homeLabel: 'Home',
};

let _currentTheme = SKIN_DEFAULTS.theme;
let _skinBrightness = SKIN_DEFAULTS.brightness;
let _skinBrightnessApplyTimer = null;
let _presenceEnabled = SKIN_DEFAULTS.presenceEnabled;
let _presenceTimeoutMinutes = SKIN_DEFAULTS.sleepTimeoutMinutes;

function _normalizePresenceTimeout(minutes) {
  const numericMinutes = Math.round(Number(minutes));
  if (!Number.isFinite(numericMinutes)) return SKIN_DEFAULTS.sleepTimeoutMinutes;
  return Math.max(15, Math.min(120, numericMinutes));
}

function _normalizeWaterUnit(unit) {
  return unit === 'ml' ? 'ml' : 'pct';
}

function _normalizeBrightness(value) {
  const numericValue = Math.round(Number(value));
  if (!Number.isFinite(numericValue)) return SKIN_DEFAULTS.brightness;
  return Math.max(0, Math.min(100, numericValue));
}

function _applySkinBrightness(level, persist = true) {
  _skinBrightness = _normalizeBrightness(level);
  if (persist) {
    patchStoreSettings({ nsx_display_brightness: _skinBrightness });
  }
  clearTimeout(_skinBrightnessApplyTimer);
  _skinBrightnessApplyTimer = setTimeout(() => {
    setDisplayBrightness?.(_skinBrightness).catch((err) => {
      console.debug('Display brightness update failed:', err?.message || err);
    });
  }, 120);
  _pushScreensaverConfig();
}

function _pushScreensaverConfig() {
  const lvl = Number(storeSettings.nsx_screensaver_brightness);
  window.NSXScreensaver?.setConfig?.({
    dimEnabled:        storeSettings.nsx_screensaver_dim_enabled !== false,
    dimLevel:          Number.isFinite(lvl) ? lvl : 50,
    wakeLockNormal:    storeSettings.nsx_wakelock_normal !== false,
    wakeLockLocked:    storeSettings.nsx_wakelock_locked === true,
    restoreBrightness: _skinBrightness,
  });
}

function _applyTheme(theme) {
  const valid = ['white', 'dark'];
  _currentTheme = valid.includes(theme) ? theme : 'dark';
  document.documentElement.dataset.theme = _currentTheme;
}

let _currentScale = SKIN_DEFAULTS.scaleKey;
let _currentScaleKey = SKIN_DEFAULTS.scaleKey;
let _draftScaleKey = SKIN_DEFAULTS.scaleKey;
let _draftIsManual = false;

const SCALE_REF_WIDTH  = 1200;
const SCALE_REF_HEIGHT = 750;

const DEVICE_SCALE_PRESETS = {
  'P85Pro':  '100',
  'M50mini': '100',
  'A11':     '100',
  'A11+':    '100',
  'iPad11':  '98',
};

function _normalizeScalePercent(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return 100;
  return Math.max(90, Math.min(110, n));
}

function _resolveScaleKey(key) {
  if (key === 'auto') return 'auto';
  if (DEVICE_SCALE_PRESETS[key]) return DEVICE_SCALE_PRESETS[key];
  return String(_normalizeScalePercent(key));
}

function _applyScale(setting) {
  if (_PHONE_MEDIA?.matches) {
    _currentScale = '100';
    const scale = 1;
    document.documentElement.style.setProperty('--app-scale', '1');
    const appEl = document.querySelector('.app');
    if (appEl) { appEl.style.zoom = ''; appEl.style.width = ''; appEl.style.height = ''; }
    document.querySelectorAll('.modal-sheet, .field-picker-sheet').forEach(el => {
      el.style.zoom = ''; el.style.width = ''; el.style.height = ''; el.style.maxHeight = '';
    });
    document.querySelectorAll('.modal-alert').forEach(el => { el.style.zoom = ''; el.style.width = ''; });
    const stgInnerEl = document.getElementById('stg-inner');
    if (stgInnerEl) { stgInnerEl.style.zoom = ''; stgInnerEl.style.width = ''; stgInnerEl.style.height = ''; }
    return;
  }
  const normalized = _resolveScaleKey(setting);
  const resolved = (normalized === 'auto')
    ? String(Math.round(Math.min(window.innerWidth / SCALE_REF_WIDTH, window.innerHeight / SCALE_REF_HEIGHT) * 100))
    : (normalized || '100');
  _currentScale = resolved;
  const scale = Number(_currentScale) / 100;

  document.documentElement.style.setProperty('--app-scale', String(scale));

  const appEl = document.querySelector('.app');
  if (appEl) {
    if (scale === 1) {
      appEl.style.zoom = '';
      appEl.style.width = '';
      appEl.style.height = '';
    } else {
      appEl.style.zoom = String(scale);
      appEl.style.width = `${(window.innerWidth / scale).toFixed(4)}px`;
      appEl.style.height = `${(window.innerHeight / scale).toFixed(4)}px`;
    }
  }

  // Modals live outside .app so they don't inherit its zoom.
  // Strategy: express the overlay's fixed physical gap (top: 20px, sides: 10px)
  // in CSS pixels by dividing by scale. After zoom those resolve back to exactly
  // the original physical gap at every scale level.
  // Modals with auto/small height (filter, batch pickers) skip height compensation.
  const autoHeightModalIds = new Set([
    'workflow-filter-modal',
    'batch-add-modal',
    'batch-date-picker-modal',
    'field-picker-modal',
    'steam-corner',
    'hotwater-overlay',
    'needswater-overlay',
    'flush-overlay',
    'alert-modal',
    'confirm-modal',
    'workflow-delete-confirm',
    'virtual-scale-info-modal',
    'visualizer-import-modal',
  ]);
  // Corner panels have their own fixed CSS width and must not be stretched
  const autoWidthModalIds = new Set(['steam-corner', 'flush-overlay', 'hotwater-overlay', 'needswater-overlay']);
  document.querySelectorAll('.modal-sheet, .field-picker-sheet').forEach(el => {
    const overlayId = el.closest('.modal-overlay')?.id ?? '';
    const isAutoHeight = autoHeightModalIds.has(overlayId);
    const isAutoWidth  = autoWidthModalIds.has(overlayId);
    if (scale === 1) {
      el.style.zoom = '';
      el.style.width = '';
      el.style.height = '';
      el.style.maxHeight = '';
    } else {
      el.style.zoom = String(scale);
      if (!isAutoWidth) {
        // overlay padding: 10px each side → 20px total horizontal
        el.style.width = `${(window.innerWidth - 20) / scale}px`;
      }
      if (!isAutoHeight) {
        // overlay padding: 20px top, 0 bottom
        el.style.height = `${(window.innerHeight - 20) / scale}px`;
        el.style.maxHeight = 'none';
      }
    }
  });

  // Alert dialogs: compensate width only (height is auto/content-driven)
  document.querySelectorAll('.modal-alert').forEach(el => {
    if (scale === 1) {
      el.style.zoom = '';
      el.style.width = '';
    } else {
      el.style.zoom = String(scale);
      el.style.width = `calc(min(270px, 84vw) / ${scale})`;
    }
  });

  // Settings overlay inner content — use explicit px to avoid % resolution issues
  // inside position:fixed parent in Chromium
  const stgInnerEl = document.getElementById('stg-inner');
  if (stgInnerEl) {
    if (scale === 1) {
      stgInnerEl.style.zoom   = '';
      stgInnerEl.style.width  = '';
      stgInnerEl.style.height = '';
    } else {
      stgInnerEl.style.zoom   = String(scale);
      stgInnerEl.style.width  = `${Math.ceil(window.innerWidth  / scale)}px`;
      stgInnerEl.style.height = `${Math.ceil(window.innerHeight / scale)}px`;
    }
  }

  requestAnimationFrame(() => {
    [
      document.getElementById('workflow-shot-graph'),
      document.getElementById('espresso-fs-graph'),
      document.getElementById('shot-review-graph'),
    ].forEach(el => {
      if (el?._chart && el.offsetWidth > 0) {
        el._chart.setSize({ width: el.offsetWidth, height: el.offsetHeight || 300 });
      }
    });
  });
}



window.NSXSkinControls = {
  getTheme:          () => _currentTheme,
  getBrightness:     () => _skinBrightness,
  getPresenceEnabled:() => _presenceEnabled,
  getPresenceTimeout:() => _presenceTimeoutMinutes,
  getScaleKey:       () => _currentScaleKey,
  getCurrentScale:   () => _currentScale,
  getHomeLabel:      () => storeSettings.nsx_home_label || SKIN_DEFAULTS.homeLabel,
  getLang:           () => getLang?.() ?? SKIN_DEFAULTS.language,
  SCALE_PRESETS: DEVICE_SCALE_PRESETS,

  setTheme(theme) {
    _applyTheme(theme);
    setStoreValue('skin', 'theme', theme).catch(() => {});
  },
  setBrightness(v) {
    _applySkinBrightness(v);
  },
  setPresenceEnabled(v) {
    _presenceEnabled = Boolean(v);
    patchStoreSettings({ nsx_presence_enabled: _presenceEnabled });
    if (typeof updatePresenceSettings === 'function') {
      updatePresenceSettings({ userPresenceEnabled: _presenceEnabled, sleepTimeoutMinutes: _presenceTimeoutMinutes }).catch(() => {});
    }
  },
  setPresenceTimeout(v) {
    _presenceTimeoutMinutes = _normalizePresenceTimeout(v);
    patchStoreSettings({ nsx_sleep_timeout_minutes: _presenceTimeoutMinutes });
    if (typeof updatePresenceSettings === 'function') {
      updatePresenceSettings({ userPresenceEnabled: _presenceEnabled, sleepTimeoutMinutes: _presenceTimeoutMinutes }).catch(() => {});
    }
  },
  setScale(key) {
    _currentScaleKey = key;
    _draftScaleKey = key;
    _applyScale(key === 'auto' ? 'auto' : key);
    patchStoreSettings({ nsx_display_scale: key });
  },
  setHomeLabel(label) {
    const trimmed = (label ?? '').trim();
    patchStoreSettings({ nsx_home_label: trimmed || null });
    window.NSXRouter?.setHomeLabelOverride(trimmed);
  },
  setLang(lang) {
    setLang?.(lang);
    setStoreValue('skin', 'lang', lang).catch(() => {});
    applyTranslations?.();
  },

  getLockscreenEnabled: () => storeSettings.nsx_lockscreen_enabled !== false,
  setLockscreenEnabled(v) {
    patchStoreSettings({ nsx_lockscreen_enabled: Boolean(v) });
    window.NSXScreensaver?.setEnabled(Boolean(v));
    document.body.classList.toggle('lockscreen-disabled', !v);
  },
  getWakeOnUnlock: () => storeSettings.nsx_wake_on_unlock !== false,
  setWakeOnUnlock(v) {
    patchStoreSettings({ nsx_wake_on_unlock: Boolean(v) });
  },

  getScreensaverDimEnabled: () => storeSettings.nsx_screensaver_dim_enabled !== false,
  setScreensaverDimEnabled(v) {
    patchStoreSettings({ nsx_screensaver_dim_enabled: Boolean(v) });
    _pushScreensaverConfig();
  },
  getScreensaverBrightness: () => {
    const n = Number(storeSettings.nsx_screensaver_brightness);
    return Number.isFinite(n) ? n : 50;
  },
  setScreensaverBrightness(v) {
    const n = Math.max(0, Math.min(100, Math.round(Number(v))));
    patchStoreSettings({ nsx_screensaver_brightness: Number.isFinite(n) ? n : 50 });
    _pushScreensaverConfig();
  },
  getWakeLockNormal: () => storeSettings.nsx_wakelock_normal !== false,
  setWakeLockNormal(v) {
    patchStoreSettings({ nsx_wakelock_normal: Boolean(v) });
    _pushScreensaverConfig();
  },
  getWakeLockLocked: () => storeSettings.nsx_wakelock_locked === true,
  setWakeLockLocked(v) {
    patchStoreSettings({ nsx_wakelock_locked: Boolean(v) });
    _pushScreensaverConfig();
  },

  getRefillLevelMm: () => refillLevelMm,
  setRefillLevelMm(v) {
    refillLevelMm = Math.min(43, Math.max(5, Math.round(Number(v))));
    setWaterRefillLevel?.(refillLevelMm);
    pushRefillLevel?.(refillLevelMm)?.catch(() => {});
  },

  getWaterUnit: () => _normalizeWaterUnit(storeSettings.nsx_water_unit),
  setWaterUnit(unit) {
    const normalizedUnit = _normalizeWaterUnit(unit);
    patchStoreSettings({ nsx_water_unit: normalizedUnit });
    setWaterDisplayUnit?.(normalizedUnit);
  },

  getRecentRecipeNav: () => storeSettings.nsx_recent_recipe_nav === true,
  setRecentRecipeNav(v) {
    patchStoreSettings({ nsx_recent_recipe_nav: Boolean(v) });
  },

  getShowRecipeCardRating: () => storeSettings.nsx_show_recipe_card_rating !== false,
  setShowRecipeCardRating(v) {
    patchStoreSettings({ nsx_show_recipe_card_rating: Boolean(v) });
    _applyShowRecipeCardRating();
  },

  getTareOnNegative: () => storeSettings.nsx_tare_on_negative !== false,
  setTareOnNegative(v) {
    patchStoreSettings({ nsx_tare_on_negative: Boolean(v) });
  },

  getDosingCupWeight: () => Number(storeSettings.nsx_dosing_cup_weight) || 0,
  setDosingCupWeight(v) {
    const n = Math.max(0, Math.round(Number(v) * 10) / 10);
    patchStoreSettings({ nsx_dosing_cup_weight: Number.isFinite(n) ? n : 0 });
  },
  measureDosingCup() {
    if (!scaleConnected) { showToast('Scale not connected'); return null; }
    const w = liveWeight;
    if (!Number.isFinite(w) || w <= 0) { showToast('Place the empty cup on the scale first'); return null; }
    const rounded = Math.round(w * 10) / 10;
    patchStoreSettings({ nsx_dosing_cup_weight: rounded });
    showToast(`Dosing cup weight set to ${rounded} g`);
    return rounded;
  },

  getRatioDoseEnabled: () => _ratioDoseEnabled,
  setRatioDoseEnabled(v) {
    _ratioDoseEnabled = Boolean(v);
    patchStoreSettings({ nsx_ratio_dose_enabled: _ratioDoseEnabled });
    _applyRatioDoseVisible();
    if (!_ratioDoseEnabled) _clearDoseScaleState();
  },
  getBatchFreezeEnabled: () => _batchFreezeEnabled,
  setBatchFreezeEnabled(v) {
    _batchFreezeEnabled = Boolean(v);
    patchStoreSettings({ nsx_batch_freeze_enabled: _batchFreezeEnabled });
  },
};

Promise.all([
  getStoreValue('skin', 'lang').catch(() => null),
  getStoreValue('skin', 'theme').catch(() => null),
]).then(([lang, theme]) => {
  const targetLang = (lang === 'en' || lang === 'de') ? lang : SKIN_DEFAULTS.language;
  setLang?.(targetLang);
  _applyTheme(theme || SKIN_DEFAULTS.theme);
  applyTranslations();
});

document.getElementById('btn-home-profile-picker')?.addEventListener('click', () => {
  openProfilePickerModal('home');
});

const homeWorkflowWidget = document.getElementById('btn-home-workflow-edit');
homeWorkflowWidget?.addEventListener('click', () => {
  if (workflowItems.length === 0) openWorkflowCreateModal();
  else openWorkflowEditModal(selectedWorkflowIndex);
});
homeWorkflowWidget?.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    if (workflowItems.length === 0) openWorkflowCreateModal();
    else openWorkflowEditModal(selectedWorkflowIndex);
  }
});

/* ── Reinigung Flow ─────────────────────────────────── */
{
  const cleaningModalEl       = document.getElementById('cleaning-modal');
  const cleaningStep1El       = document.getElementById('cleaning-step-1');
  const cleaningStep2El       = document.getElementById('cleaning-step-2');
  const cleaningStep3El       = document.getElementById('cleaning-step-3');
  const cleaningStep4El       = document.getElementById('cleaning-step-4');
  const cleaningProfileListEl = document.getElementById('cleaning-profile-list');
  const cleaningStep3IdleEl   = document.getElementById('cleaning-step3-idle');
  const cleaningGraphEl       = document.getElementById('cleaning-live-graph');
  const cleaningStep3TitleEl  = document.getElementById('cleaning-step3-title');

  let _cleaningPreShotId       = null;
  let _cleaningPreShotIds      = new Set();
  let _cleaningRunStartedAt    = 0;
  let _cleaningProfileHint     = null;
  let _cleaningWasEspresso     = false;
  let _cleaningStateHandler    = null;
  let _cleaningSnapshotHandler = null;

  function _parseShotTimestampMs(shot) {
    const ts = shot?.timestamp ? Date.parse(shot.timestamp) : NaN;
    return Number.isFinite(ts) ? ts : 0;
  }

  function _extractShotProfileTitle(shot) {
    return String(
      shot?.workflow?.profile?.title ||
      shot?.profile?.title ||
      shot?.profileTitle ||
      ''
    ).trim();
  }

  function _looksLikeCleaningProfileTitle(title) {
    return /clean|reinig|backflush|flush/i.test(String(title || ''));
  }

  async function _fetchRecentShots(limit = 80) {
    const safeLimit = Math.max(1, Number(limit) || 80);
    const res = await fetchShots(safeLimit);
    const items = Array.isArray(res?.items) ? res.items.slice() : [];
    items.sort((a, b) => _parseShotTimestampMs(b) - _parseShotTimestampMs(a));
    return items;
  }

  function _toShotIdSet(items) {
    const ids = new Set();
    for (const shot of (Array.isArray(items) ? items : [])) {
      if (shot?.id != null) ids.add(String(shot.id));
    }
    return ids;
  }

  async function _fetchMostRecentShot() {
    const items = await _fetchRecentShots(40);
    return items[0] || null;
  }

  async function _refreshShotsFromApi(limit = 80) {
    const fresh = await _fetchRecentShots(limit);
    shots = fresh;
    renderWorkflows(getDisplayWorkflows(), selectedWorkflowIndex);
    renderHistory();
  }

  async function _findCleaningShotCandidate() {
    const items = await _fetchRecentShots(80);
    if (!items.length) return null;

    const runStartMs = Number(_cleaningRunStartedAt || 0);
    const hintedTitle = String(_cleaningProfileHint || '').trim();

    const newSinceStart = items
      .filter((shot) => {
        if (!shot?.id) return false;
        const id = String(shot.id);
        if (_cleaningPreShotIds.has(id)) return false;
        const ts = _parseShotTimestampMs(shot);
        if (runStartMs > 0 && ts > 0 && ts < (runStartMs - 10_000)) return false;
        return true;
      })
      .sort((a, b) => _parseShotTimestampMs(b) - _parseShotTimestampMs(a));

    if (newSinceStart.length === 1) {
      return newSinceStart[0];
    }

    if (newSinceStart.length > 1) {
      const titleMatches = newSinceStart.filter((shot) => {
        const title = _extractShotProfileTitle(shot);
        if (!title) return false;
        if (hintedTitle && title === hintedTitle) return true;
        return _looksLikeCleaningProfileTitle(title);
      });
      if (titleMatches.length === 1) return titleMatches[0];
      if (titleMatches.length > 1) return titleMatches[0];
    }

    const candidates = items
      .filter((shot) => {
        if (!shot?.id || shot.id === _cleaningPreShotId) return false;
        const ts = _parseShotTimestampMs(shot);
        if (runStartMs > 0 && ts > 0 && ts < (runStartMs - 10_000)) return false;

        const title = _extractShotProfileTitle(shot);
        if (!title) return false;
        if (hintedTitle && title === hintedTitle) return true;
        return _looksLikeCleaningProfileTitle(title);
      })
      .sort((a, b) => _parseShotTimestampMs(b) - _parseShotTimestampMs(a));

    return candidates[0] || null;
  }

  function _cleaningShowStep(n) {
    [cleaningStep1El, cleaningStep2El, cleaningStep3El, cleaningStep4El]
      .forEach((el, i) => { if (el) el.hidden = (i + 1) !== n; });
  }

  function _cleaningStopGraph() {
    if (_cleaningSnapshotHandler) {
      window.removeEventListener('gateway:snapshot', _cleaningSnapshotHandler);
      _cleaningSnapshotHandler = null;
    }
    if (cleaningGraphEl?._chart) {
      cleaningGraphEl._chart.destroy();
      cleaningGraphEl._chart = null;
      cleaningGraphEl._liveMode = false;
    }
    if (cleaningGraphEl)   cleaningGraphEl.hidden = true;
    if (cleaningStep3IdleEl) cleaningStep3IdleEl.hidden = false;
    if (cleaningStep3TitleEl) cleaningStep3TitleEl.textContent = t('cleaning.title');
  }

  function _cleaningClose() {
    if (cleaningModalEl) cleaningModalEl.hidden = true;
    _cleaningPreShotId   = null;
    _cleaningPreShotIds = new Set();
    _cleaningRunStartedAt = 0;
    _cleaningProfileHint  = null;
    _cleaningWasEspresso = false;
    const hadCleaningProfile = !!_forcedLiveWorkflow;
    _forcedLiveWorkflow  = null;
    if (_cleaningStateHandler) {
      window.removeEventListener('gateway:machineState', _cleaningStateHandler);
      _cleaningStateHandler = null;
    }
    _cleaningStopGraph();
    if (hadCleaningProfile) {
      const current = workflowItems[selectedWorkflowIndex];
      if (current) {
        setCurrentWorkflow?.(current);
        _schedulePushCurrentSkinState(true);
      }
    }
  }

  document.getElementById('btn-home-cleaning')?.addEventListener('click', () => {
    _cleaningShowStep(1);
    if (cleaningModalEl) cleaningModalEl.hidden = false;
  });

  document.getElementById('btn-cleaning-cancel')?.addEventListener('click', _cleaningClose);
  document.getElementById('btn-cleaning-step3-abort')?.addEventListener('click', _cleaningClose);
  document.getElementById('btn-cleaning-step2-back')?.addEventListener('click', () => _cleaningShowStep(1));

  // Schritt 1 → 2: Profile laden und filtern
  document.getElementById('btn-cleaning-ready')?.addEventListener('click', async () => {
    try {
      // _ensureProfilesLoaded gibt normalisierte Records zurück: { id, profile: { title, ... }, ... }
      const allRecords = await _ensureProfilesLoaded();
      const cleanedRecords = allRecords.filter(r =>
        /clean|reinig|backflush|flush/i.test(r.profile?.title || '')
      );

      // If exactly one cleaning profile exists, select it immediately and skip list step.
      if (cleanedRecords.length === 1) {
        await _cleaningSelectProfile(cleanedRecords[0]);
        return;
      }

      const list = cleanedRecords.length > 0 ? cleanedRecords : allRecords;

      cleaningProfileListEl.innerHTML = '';

      if (cleanedRecords.length === 0 && allRecords.length > 0) {
        const note = document.createElement('p');
        note.className = 'cleaning-profile-fallback-note';
        note.textContent = t('cleaning.noProfiles');
        cleaningProfileListEl.appendChild(note);
      }

      list.forEach(record => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'cleaning-profile-item';
        btn.textContent = record.profile?.title || record.id || '—';
        btn.addEventListener('click', () => _cleaningSelectProfile(record));
        cleaningProfileListEl.appendChild(btn);
      });

      _cleaningShowStep(2);
    } catch (err) {
      showToast(t('toast.profilesLoadFailed') + ': ' + err.message);
    }
  });

  // Schritt 2 → 3: Workflow pushen, Maschine überwachen
  async function _cleaningSelectProfile(record) {
    try {
      const [preShots, latest, currentWf] = await Promise.all([
        _fetchRecentShots(80),
        _fetchMostRecentShot(),
        fetchCurrentWorkflow(),
      ]);
      _cleaningPreShotId = latest?.id ?? null;
      _cleaningPreShotIds = _toShotIdSet(preShots);
      _cleaningRunStartedAt = Date.now();

      // Run cleaning profile without stop-at limits so all steps can complete.
      const cleaningProfile = JSON.parse(JSON.stringify(record?.profile || {}));
      cleaningProfile.target_weight = 0;
      cleaningProfile.target_volume = 0;
      _cleaningProfileHint = String(cleaningProfile?.title || '').trim() || null;

      const cleaningContext = {
        ...(currentWf?.context || {}),
        coffeeRoaster: '—',
        coffeeName: t('cleaning.title'),
        grinderSetting: '—',
        targetDoseWeight: 0,
        targetYield: 0,
      };

      // Use the exact same workflow push path as regular recipe selection.
      // This avoids divergent behavior between cleaning wizard and workflow editor.
      const cleaningWorkflow = {
        coffeeRoaster: cleaningContext.coffeeRoaster,
        coffeeName: cleaningContext.coffeeName,
        grinderModel: cleaningContext.grinderModel || '—',
        grinderSetting: cleaningContext.grinderSetting,
        targetDoseWeight: Number(cleaningContext.targetDoseWeight || 0),
        targetYield: Number(cleaningContext.targetYield || 0),
        profileTitle: cleaningProfile?.title || t('cleaning.title'),
        gatewayWorkflow: {
          ...(currentWf || {}),
          context: cleaningContext,
          profile: cleaningProfile,
          profileId: record?.id ?? currentWf?.profileId ?? null,
        },
      };

      // Ensure cleaning run/graph uses this selected workflow, not the last recipe index.
      _forcedLiveWorkflow = cleaningWorkflow;
      setCurrentWorkflow?.(mapApiWorkflowToDisplay(cleaningWorkflow.gatewayWorkflow));

      await pushSelectedWorkflowToMachine(cleaningWorkflow);

      showToast(t('toast.cleaningProfile'));
    } catch (err) {
      _forcedLiveWorkflow = null;
      showToast(t('toast.recipeSetFailed') + ': ' + err.message);
      return;
    }

    _cleaningShowStep(3);

    // Auf Espresso-Zyklus warten: espresso → idle = fertig
    _cleaningWasEspresso = false;
    _cleaningStateHandler = ({ detail }) => {
      const state = detail?.state || 'idle';
      const isRunningState = state === 'espresso';

      if (isRunningState && !_cleaningWasEspresso) {
        // Maschine läuft — Anleitung ausblenden, Graph einblenden
        _cleaningWasEspresso = true;
        if (cleaningStep3IdleEl)  cleaningStep3IdleEl.hidden  = true;
        if (cleaningGraphEl)      cleaningGraphEl.hidden      = false;
        if (cleaningStep3TitleEl) cleaningStep3TitleEl.textContent = t('toast.cleaningRunning');

        requestAnimationFrame(() => {
          initLiveShotChart?.(cleaningGraphEl);
          // Snapshot-Updates für den Reinigungsgraph
          _cleaningSnapshotHandler = () => {
            if (liveShot) updateLiveShotChart?.(cleaningGraphEl, liveShot);
          };
          window.addEventListener('gateway:snapshot', _cleaningSnapshotHandler);
        });

      } else if (_cleaningWasEspresso && !isRunningState) {
        // Extraktion beendet
        window.removeEventListener('gateway:machineState', _cleaningStateHandler);
        _cleaningStateHandler = null;
        _cleaningWasEspresso  = false;
        _cleaningStopGraph();
        _cleaningShowStep(4);
      }
    };
    window.addEventListener('gateway:machineState', _cleaningStateHandler);
  }

  // Schritt 4: Fertig — Shot behalten, zurück zu Home
  document.getElementById('btn-cleaning-done')?.addEventListener('click', async () => {
    try {
      await _refreshShotsFromApi(80);
    } catch (err) {
      console.warn('Shots konnten nach Reinigung nicht aktualisiert werden:', err.message);
    }
    _cleaningClose();
    window.NSXRouter?.setTab(0);
  });
}

document.querySelector('.workflow-scale-indicator')?.addEventListener('click', function() {
  this.classList.remove('is-bouncing');
  void this.offsetWidth;
  this.classList.add('is-bouncing');
  this.addEventListener('animationend', () => this.classList.remove('is-bouncing'), { once: true });
  if (!scaleConnected) {
    initiateScaleConnect?.();
    showToast(t('toast.scaleConnecting'));
  } else {
    tareScale?.().catch(() => {});
  }
});

if (scaleTareButtonEl) {
  scaleTareButtonEl.addEventListener("click", async () => {
    signalUserPresence();
    if (!scaleConnected) {
      initiateScaleConnect?.();
      showToast(t('toast.scaleConnecting'));
      return;
    }
    try {
      await tareScale();
      showToast(t('toast.scaleTared'));
    } catch (err) {
      showToast(t('toast.tareFailed') + ': ' + err.message);
    }
  });
}

let refillLevelMm = 30;

function applyRefillLevel() {
  setWaterRefillLevel?.(refillLevelMm);
  pushRefillLevel?.(refillLevelMm)?.catch(() => {
    showToast?.(t('toast.refillFailed'));
  });
}

document.getElementById('btn-refill-down')?.addEventListener('click', () => {
  refillLevelMm = Math.max(refillLevelMm - 1, 5);
  applyRefillLevel();
});
document.getElementById('btn-refill-up')?.addEventListener('click', () => {
  refillLevelMm = Math.min(refillLevelMm + 1, 43);
  applyRefillLevel();
});

if (window.navigator.standalone === true) {
  document.documentElement.classList.add('pwa-standalone');
}

function _setRealVh() {
  document.documentElement.style.setProperty('--real-vh', window.innerHeight + 'px');
  document.documentElement.style.setProperty('--real-vw', window.innerWidth + 'px');
}
_setRealVh();
window.addEventListener("resize", () => {
  _setRealVh();
  updateRecipeListFade();
});

document.getElementById("btn-sleep").addEventListener("click", async () => {
  if (document.body.classList.contains('lockscreen-disabled')) return;
  signalUserPresence();
  window.NSXScreensaver?.show(false, true);
  window.NSXScreensaver?.clearSuppressions();
  if (currentMachineState === 'sleeping') {
    setMachineStateText("sleeping");
    return;
  }
  try {
    const alertStates = ['needsWater', 'error', 'descaling', 'cleanMeSoon', 'descaleNeeded'];
    if (alertStates.includes(currentMachineState)) {
      await setMachineState("idle");
    }
    await setMachineState("sleeping");
    setMachineStateText("sleeping");
  } catch (err) {
    window.NSXScreensaver?.hide();
    showToast(t('toast.sleepFailed') + ': ' + err.message);
  }
});

const powerToggleEl = document.getElementById('machine-power-toggle');
if (powerToggleEl) {
  powerToggleEl.addEventListener('change', async () => {
    signalUserPresence();
    const targetState = powerToggleEl.checked ? 'idle' : 'sleeping';
    if (targetState === 'sleeping') {
      window.NSXScreensaver?.suppressForToggleSleep();
    }
    try {
      await setMachineState(targetState);
      setMachineStateText(targetState);
      if (targetState === 'idle') {
        _schedulePushCurrentSkinState(true);
      }
    } catch (err) {
      window.NSXScreensaver?.clearSuppressions();
      powerToggleEl.checked = !powerToggleEl.checked;
      showToast(t('toast.controlFailed') + ': ' + err.message);
    }
  });
}

/* ── Preset Active State Persistence ─────────────────── */

// Settings store lives in core/store.js. `storeSettings` is the core's single,
// stable object (mutated in place by NSXCore.patchStore/replaceStore), so this
// alias and the ~80 reads below stay valid for the app's lifetime.
const NSXCore = window.NSXCore;
const storeSettings = NSXCore.getStore();

function patchStoreSettings(patch) {
  NSXCore.patchStore(patch);
}

function saveActivePresetName(storageKey, name) {
  NSXCore.saveActivePresetName(storageKey, name);
}

/* ── Steam State ──────────────────────────────────────── */

const STEAM_PRESET_DEFAULTS = {
  schwach: { name: 'Weak',   temp: 165, flow: 0.6, duration: 60, calibFactor: null },
  normal:  { name: 'Normal', temp: 165, flow: 1.0, duration: 60, calibFactor: null },
  stark:   { name: 'Strong', temp: 165, flow: 1.5, duration: 60, calibFactor: null },
};

function loadSteamPresets() {
  return Object.assign({}, STEAM_PRESET_DEFAULTS);
}

function saveSteamPresets(presets) {
  patchStoreSettings({ nsx_steam_presets: presets });
}

let steamPresets = loadSteamPresets();
let activeSteamPreset = 'normal';
const _sp = steamPresets[activeSteamPreset] ?? steamPresets.normal;
let steamTemp     = _sp.temp;
let steamFlow     = _sp.flow;
let steamDuration = _sp.duration ?? 60;

function _updateSteamWidget() {
  setSteamWidget(steamTemp, steamFlow, steamDuration);
}

function _updateSteamPresetButtons() {
  document.querySelectorAll('.steam-card .steam-preset-btn').forEach(btn => {
    const key = btn.dataset.preset;
    btn.classList.toggle('is-active', btn.dataset.preset === activeSteamPreset);
    if (steamPresets[key]?.name) btn.textContent = steamPresets[key].name;
  });
}

function _deactivateSteamPreset() {
  activeSteamPreset = null;
  saveActivePresetName('nsx_steam_active_preset', '');
  _updateSteamPresetButtons();
}

function selectSteamPreset(presetName) {
  if (!steamPresets[presetName]) return;
  activeSteamPreset = presetName;
  saveActivePresetName('nsx_steam_active_preset', presetName);
  steamTemp     = steamPresets[presetName].temp;
  steamFlow     = steamPresets[presetName].flow;
  steamDuration = steamPresets[presetName].duration ?? 60;
  _updateSteamPresetButtons();
  _updateSteamWidget();
  pushSteam();
}

document.querySelectorAll('.steam-card .steam-preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    _clearSbwState(false); // manual preset choice supersedes auto-steam; drop its active state without reverting
    selectSteamPreset(btn.dataset.preset);
  });
});

/* ── Steam Settings Modal ────────────────────────────── */

const steamSettingsModalEl = document.getElementById('steam-settings-modal');
let _steamSettingsDraft = null;

function _renderSteamPurgeToggle(mode) {
  document.querySelectorAll('#steam-purge-segment .grinder-toggle-btn').forEach(btn => {
    btn.classList.toggle('is-active', Number(btn.dataset.mode) === mode);
  });
}

function _openSteamSettingsModal() {
  _steamSettingsDraft = JSON.parse(JSON.stringify(steamPresets));
  _pitcherDraft = pitcherPresets.map(p => ({ ...p }));
  _calibDraft = JSON.parse(JSON.stringify(steamCalibration));
  _calibActivePreset = activeSteamPreset ?? 'normal';
  const presetEls = steamSettingsModalEl?.querySelectorAll('.steam-settings-preset') ?? [];
  presetEls.forEach(el => {
    const key = el.dataset.preset;
    const p = _steamSettingsDraft[key];
    if (!p) return;
    el.querySelector('.steam-settings-name-input').value = p.name ?? key;
    _renderSteamSettingsValues(el, p);
  });
  _renderPitcherPresetCards();
  _renderCalibCard();
  _fetchAndShowLastSteam();
  fetchMachineSettings?.().then(s => {
    _renderSteamPurgeToggle(s?.steamPurgeMode ?? 0);
  }).catch(() => {});
  _applySbwEnabled();
  if (steamSettingsModalEl) steamSettingsModalEl.hidden = false;
}

function _renderSteamSettingsValues(presetEl, p) {
  presetEl.querySelectorAll('.steam-settings-value').forEach(span => {
    const field = span.dataset.field;
    if (!field) return;
    const unit = span.dataset.unit ?? '';
    if (field === 'temp')     span.textContent = p.temp.toFixed(0) + unit;
    if (field === 'flow')     span.textContent = p.flow.toFixed(1) + unit;
    if (field === 'duration') span.textContent = p.duration.toFixed(0) + unit;
  });
}

steamSettingsModalEl?.querySelectorAll('.steam-settings-preset').forEach(presetEl => {
  const key = presetEl.dataset.preset;
  presetEl.querySelectorAll('.steam-settings-up, .steam-settings-down').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = _steamSettingsDraft?.[key];
      if (!p) return;
      const field = btn.dataset.field;
      const dir = btn.classList.contains('steam-settings-up') ? 1 : -1;
      if (field === 'temp')     p.temp     = Math.min(165, Math.max(100, p.temp + dir * 5));
      if (field === 'flow')     p.flow     = Math.round(Math.min(4.0, Math.max(0.3, p.flow + dir * 0.1)) * 10) / 10;
      if (field === 'duration') p.duration = Math.min(300, Math.max(1, p.duration + dir * 1));
      _renderSteamSettingsValues(presetEl, p);
    });
  });
});

steamSettingsModalEl?.querySelectorAll('.steam-settings-name-input').forEach(input => {
  input.addEventListener('click', () => {
    window._openTextPicker(input.value, val => { input.value = val || input.placeholder; });
  });
});

steamSettingsModalEl?.querySelectorAll('.steam-settings-value').forEach(span => {
  span.addEventListener('click', () => {
    const presetEl = span.closest('.steam-settings-preset');
    const key = presetEl?.dataset.preset;
    const p = _steamSettingsDraft?.[key];
    if (!p) return;
    const field = span.dataset.field;
    if (field === 'temp')     openNumberPicker(_npMakeRange(100, 165, 5), p.temp,     v => { p.temp     = v; _renderSteamSettingsValues(presetEl, p); });
    if (field === 'flow')     openNumberPicker(_npMakeRange(0.3, 4.0, 0.1), p.flow,   v => { p.flow     = v; _renderSteamSettingsValues(presetEl, p); }, 1);
    if (field === 'duration') openNumberPicker(_npMakeRange(1, 300, 1), p.duration,   v => { p.duration = v; _renderSteamSettingsValues(presetEl, p); });
  });
});

document.getElementById('btn-steam-settings')?.addEventListener('click', _openSteamSettingsModal);

document.getElementById('btn-steam-settings-cancel')?.addEventListener('click', () => {
  if (steamSettingsModalEl) steamSettingsModalEl.hidden = true;
});

document.getElementById('sbw-enabled-toggle')?.addEventListener('change', e => {
  sbwEnabled = e.target.checked;
  _saveSbwEnabled();
  _applySbwEnabled();
});

document.querySelectorAll('#steam-purge-segment .grinder-toggle-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const mode = Number(btn.dataset.mode);
    _renderSteamPurgeToggle(mode);
    updateMachineSettings?.({ steamPurgeMode: mode }).catch(() => {});
  });
});

document.getElementById('btn-steam-by-weight-info')?.addEventListener('click', () => {
  showAlert(
    'Steam by Weight\n\n' +
    'This feature automatically calculates steaming duration based on milk weight.\n\n' +
    '1. Weigh the empty jug once — saved as the tare weight.\n' +
    '2. Fill the jug with milk and weigh it — the milk weight is recorded.\n' +
    '3. Steam and enter how long it took — saved as the calibration time.\n\n' +
    'Next time you place a filled jug on the scale and zero it, NSX interpolates the required steaming time from the milk weight and inserts it into the steaming duration automatically.'
  );
});

document.getElementById('btn-calib-info')?.addEventListener('click', () => {
  showAlert(
    'Calibration\n\n' +
    'Calibration must be performed separately for each steam preset (Weak, Normal, Strong).\n\n' +
    'Because each preset uses a different temperature and flow rate, the time required to heat the same amount of milk will vary. ' +
    'By calibrating per preset, NSX can accurately calculate the correct steaming duration for any milk weight.'
  );
});

/* ── Steam Calibration ───────────────────────────────── */

const STEAM_CALIB_DEFAULTS = {
  schwach: { milkWeight: null, steamingTime: null },
  normal:  { milkWeight: null, steamingTime: null },
  stark:   { milkWeight: null, steamingTime: null },
};

let steamCalibration = JSON.parse(JSON.stringify(STEAM_CALIB_DEFAULTS));
let _calibDraft = null;
let _calibActivePreset = 'normal';

function _saveCalibration() {
  patchStoreSettings({ nsx_steam_calibration: steamCalibration });
}

function _renderCalibCard() {
  const draft = _calibDraft;
  if (!draft) return;

  // Preset buttons
  const btnsEl = document.getElementById('calib-preset-btns');
  if (btnsEl) {
    btnsEl.innerHTML = Object.entries(steamPresets).map(([key, sp]) =>
      `<button type="button" class="grinder-toggle-btn${_calibActivePreset === key ? ' is-active' : ''}" data-key="${key}">${sp.name ?? key}</button>`
    ).join('');
    btnsEl.querySelectorAll('.grinder-toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        _calibActivePreset = btn.dataset.key;
        _renderCalibCard();
      });
    });
  }

  const entry = draft[_calibActivePreset] ?? { milkWeight: null, steamingTime: null };

  const milkWeightEl = document.getElementById('calib-milk-weight');
  if (milkWeightEl) milkWeightEl.textContent = entry.milkWeight != null ? entry.milkWeight.toFixed(1) + ' g' : '— g';

  const timeEl = document.getElementById('calib-steam-time');
  if (timeEl) timeEl.value = entry.steamingTime != null ? String(entry.steamingTime) : '';
}

function _steamDurationFromMeasurements(measurements) {
  if (!Array.isArray(measurements) || measurements.length < 2) return null;
  const steamMs = measurements
    .filter(m => m?.machine?.state?.state === 'steam')
    .map(m => new Date(m.machine.timestamp).getTime())
    .filter(t => Number.isFinite(t));
  if (steamMs.length < 2) return null;
  return (Math.max(...steamMs) - Math.min(...steamMs)) / 1000;
}

async function _fetchAndShowLastSteam() {
  const el = document.getElementById('calib-last-steam');
  if (!el) return;
  el.textContent = '…';
  try {
    const latest = await fetchLatestSteam();
    let record = latest;
    if (latest?.id && !Array.isArray(latest.measurements)) {
      record = await fetchSteamById(latest.id);
    }
    const dur = _steamDurationFromMeasurements(record?.measurements);
    el.textContent = Number.isFinite(dur) ? dur.toFixed(0) + ' s' : '—';
  } catch {
    el.textContent = '—';
  }
}

document.getElementById('btn-calib-measure-milk')?.addEventListener('click', () => {
  if (!scaleConnected) { showToast('Scale not connected'); return; }
  const w = liveWeight;
  if (!Number.isFinite(w) || w <= 0) { showToast('Tare the scale, then place the milk pitcher'); return; }
  if (_calibDraft?.[_calibActivePreset]) {
    _calibDraft[_calibActivePreset].milkWeight = Math.round(w * 10) / 10;
  }
  _renderCalibCard();
});

document.getElementById('calib-steam-time')?.addEventListener('input', e => {
  const v = parseFloat(e.target.value);
  if (_calibDraft?.[_calibActivePreset]) {
    _calibDraft[_calibActivePreset].steamingTime = Number.isFinite(v) && v > 0 ? v : null;
  }
});

/* ── Pitcher Presets ─────────────────────────────────── */

const PITCHER_PRESET_DEFAULTS = [
  { name: 'Pitcher 1', steamPreset: 'normal', pitcherWeight: null },
  { name: 'Pitcher 2', steamPreset: 'normal', pitcherWeight: null },
  { name: 'Pitcher 3', steamPreset: 'normal', pitcherWeight: null },
];

let pitcherPresets = PITCHER_PRESET_DEFAULTS.map(p => ({ ...p }));
let _pitcherDraft = null;

function _savePitcherPresets() {
  patchStoreSettings({ nsx_pitcher_presets: pitcherPresets });
}

function _renderPitcherPresetCards() {
  const cards = steamSettingsModalEl?.querySelectorAll('.pitcher-preset-card[data-pitcher]') ?? [];
  cards.forEach((card, idx) => {
    const p = _pitcherDraft?.[idx] ?? pitcherPresets[idx];
    if (!p) return;

    card.querySelector('.pitcher-preset-name').value = p.name ?? `Pitcher ${idx + 1}`;

    const weightEl = card.querySelector('.pitcher-weight-value');
    weightEl.textContent = p.pitcherWeight != null ? p.pitcherWeight.toFixed(1) + ' g' : '— g';

    const btnsEl = card.querySelector('.pitcher-steam-preset-btns');
    btnsEl.innerHTML = Object.entries(steamPresets).map(([key, sp]) =>
      `<button type="button" class="grinder-toggle-btn${p.steamPreset === key ? ' is-active' : ''}" data-key="${key}">${sp.name ?? key}</button>`
    ).join('');
    btnsEl.querySelectorAll('.grinder-toggle-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        if (_pitcherDraft?.[idx]) _pitcherDraft[idx].steamPreset = btn.dataset.key;
        _renderPitcherPresetCards();
      });
    });
  });
}

steamSettingsModalEl?.querySelectorAll('.pitcher-preset-card[data-pitcher] .pitcher-measure-btn').forEach((btn, idx) => {
  btn.addEventListener('click', () => {
    if (!scaleConnected) { showToast('Scale not connected'); return; }
    const w = liveWeight;
    if (!Number.isFinite(w) || w <= 0) { showToast('Tare the scale first, then place the pitcher'); return; }
    if (_pitcherDraft?.[idx]) _pitcherDraft[idx].pitcherWeight = Math.round(w * 10) / 10;
    _renderPitcherPresetCards();
  });
});

document.getElementById('btn-steam-settings-save')?.addEventListener('click', () => {
  if (!_steamSettingsDraft) return;

  // Save steam presets
  steamSettingsModalEl?.querySelectorAll('.steam-settings-preset').forEach(el => {
    const key = el.dataset.preset;
    if (_steamSettingsDraft[key]) {
      _steamSettingsDraft[key].name = el.querySelector('.steam-settings-name-input').value.trim() || key;
    }
  });
  steamPresets = _steamSettingsDraft;
  saveSteamPresets(steamPresets);
  _updateSteamPresetButtons();
  if (activeSteamPreset && steamPresets[activeSteamPreset]) {
    steamTemp     = steamPresets[activeSteamPreset].temp;
    steamFlow     = steamPresets[activeSteamPreset].flow;
    steamDuration = steamPresets[activeSteamPreset].duration ?? 60;
    _updateSteamWidget();
    pushSteam();
  }

  // Save pitcher presets
  if (_pitcherDraft) {
    steamSettingsModalEl?.querySelectorAll('.pitcher-preset-card[data-pitcher]').forEach((card, idx) => {
      if (_pitcherDraft[idx]) {
        _pitcherDraft[idx].name = card.querySelector('.pitcher-preset-name').value.trim() || `Pitcher ${idx + 1}`;
      }
    });
    pitcherPresets = _pitcherDraft;
    _savePitcherPresets();
    _updateSbwWidget();
  }

  if (_calibDraft) {
    steamCalibration = _calibDraft;
    _saveCalibration();
    Object.entries(steamCalibration).forEach(([key, c]) => {
      if (steamPresets[key] && c.milkWeight > 0 && c.steamingTime > 0) {
        steamPresets[key].calibFactor = c.steamingTime / c.milkWeight;
      }
    });
    saveSteamPresets(steamPresets);
    _updateSbwWidget();
  }

  if (steamSettingsModalEl) steamSettingsModalEl.hidden = true;
});

let _steamEnabled = true;

function _setSteamEnabled(enabled, push = true) {
  _steamEnabled = enabled;
  patchStoreSettings({ nsx_steam_enabled: enabled });
  const toggle = document.getElementById('steam-power-toggle');
  if (toggle) toggle.checked = enabled;
  const controls = document.querySelector('.steam-controls');
  const presets = document.querySelector('.steam-presets');
  if (controls) controls.style.opacity = enabled ? '' : '0.4';
  if (presets) presets.style.opacity = enabled ? '' : '0.4';
  if (!push) return;
  if (enabled) {
    pushSteamSettings(steamTemp, steamFlow).catch(() => {});
  } else {
    pushSteamSettings(0, 0).catch(() => {});
  }
}

document.getElementById('steam-power-toggle')?.addEventListener('change', (e) => {
  _setSteamEnabled(e.target.checked);
});

document.getElementById('btn-steam-temp-up')?.addEventListener('click', () => {
  steamTemp = Math.min(steamTemp + 5, 165);
  _deactivateSteamPreset(); _updateSteamWidget(); pushSteamTemp();
});
document.getElementById('btn-steam-temp-down')?.addEventListener('click', () => {
  steamTemp = Math.max(steamTemp - 5, 100);
  _deactivateSteamPreset(); _updateSteamWidget(); pushSteamTemp();
});
document.getElementById('btn-steam-flow-up')?.addEventListener('click', () => {
  steamFlow = Math.round(Math.min(steamFlow + 0.1, 4.0) * 10) / 10;
  _deactivateSteamPreset(); _updateSteamWidget(); pushSteamFlow();
});
document.getElementById('btn-steam-flow-down')?.addEventListener('click', () => {
  steamFlow = Math.round(Math.max(steamFlow - 0.1, 0.5) * 10) / 10;
  _deactivateSteamPreset(); _updateSteamWidget(); pushSteamFlow();
});
document.getElementById('btn-steam-dur-up')?.addEventListener('click', () => {
  steamDuration = Math.min(steamDuration + 1, 180);
  _deactivateSteamPreset(); _updateSteamWidget(); pushSteamDuration();
});
document.getElementById('btn-steam-dur-down')?.addEventListener('click', () => {
  steamDuration = Math.max(steamDuration - 1, 1);
  _deactivateSteamPreset(); _updateSteamWidget(); pushSteamDuration();
});

/* ── Hotwater State ───────────────────────────────────── */

/* ── Hotwater State (domain in core/domains/hotwater.js) ── */

NSXCore.on('hotwaterChanged', () => {
  setHotwaterWidget(NSXCore.getHotwaterTemp(), NSXCore.getHotwaterFlow(), NSXCore.getHotwaterVolume());
  _updateHotwaterPresetButtons();
});

function _updateHotwaterPresetButtons() {
  const presets = NSXCore.getHotwaterPresets();
  const active  = NSXCore.getActiveHotwaterPreset();
  document.querySelectorAll('.hotwater-card .steam-preset-btn').forEach(btn => {
    const key = btn.dataset.preset;
    btn.textContent = presets[key]?.name ?? key;
    btn.classList.toggle('is-active', key === active);
  });
}

document.querySelectorAll('.hotwater-card .steam-preset-btn').forEach(btn => {
  btn.addEventListener('click', () => NSXCore.selectHotwaterPreset(btn.dataset.preset));
});

document.getElementById('btn-hotwater-temp-up')?.addEventListener('click', () =>
  NSXCore.setHotwaterTemp(NSXCore.getHotwaterTemp() + 5));
document.getElementById('btn-hotwater-temp-down')?.addEventListener('click', () =>
  NSXCore.setHotwaterTemp(NSXCore.getHotwaterTemp() - 5));
document.getElementById('btn-hotwater-flow-up')?.addEventListener('click', () =>
  NSXCore.setHotwaterFlow(NSXCore.getHotwaterFlow() + 1.0));
document.getElementById('btn-hotwater-flow-down')?.addEventListener('click', () =>
  NSXCore.setHotwaterFlow(NSXCore.getHotwaterFlow() - 1.0));
document.getElementById('btn-hotwater-vol-up')?.addEventListener('click', () =>
  NSXCore.setHotwaterVolume(NSXCore.getHotwaterVolume() + 10));
document.getElementById('btn-hotwater-vol-down')?.addEventListener('click', () =>
  NSXCore.setHotwaterVolume(NSXCore.getHotwaterVolume() - 10));

/* ── Hotwater Settings Modal ─────────────────────────── */

const hotwaterSettingsModalEl = document.getElementById('hotwater-settings-modal');
let _hotwaterSettingsDraft = null;

function _openHotwaterSettingsModal() {
  _hotwaterSettingsDraft = JSON.parse(JSON.stringify(NSXCore.getHotwaterPresets()));
  const presetEls = hotwaterSettingsModalEl?.querySelectorAll('.hotwater-settings-preset') ?? [];
  presetEls.forEach(el => {
    const key = el.dataset.preset;
    const p = _hotwaterSettingsDraft[key];
    if (!p) return;
    el.querySelector('.steam-settings-name-input').value = p.name ?? key;
    _renderHotwaterSettingsValues(el, p);
  });
  if (hotwaterSettingsModalEl) hotwaterSettingsModalEl.hidden = false;
}

function _renderHotwaterSettingsValues(presetEl, p) {
  presetEl.querySelectorAll('.hotwater-settings-value').forEach(span => {
    const field = span.dataset.field;
    if (!field) return;
    const unit = span.dataset.unit ?? '';
    if (field === 'temp')   span.textContent = p.temp.toFixed(0) + unit;
    if (field === 'flow')   span.textContent = p.flow.toFixed(1) + unit;
    if (field === 'volume') span.textContent = p.volume.toFixed(0) + unit;
  });
}

hotwaterSettingsModalEl?.querySelectorAll('.hotwater-settings-preset').forEach(presetEl => {
  const key = presetEl.dataset.preset;
  presetEl.querySelectorAll('.hotwater-settings-up, .hotwater-settings-down').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = _hotwaterSettingsDraft?.[key];
      if (!p) return;
      const field = btn.dataset.field;
      const dir = btn.classList.contains('hotwater-settings-up') ? 1 : -1;
      if (field === 'temp')   p.temp   = Math.min(100, Math.max(50, p.temp + dir * 5));
      if (field === 'flow')   p.flow   = Math.round(Math.min(10.0, Math.max(0.5, p.flow + dir * 0.5)) * 10) / 10;
      if (field === 'volume') p.volume = Math.min(500, Math.max(10, p.volume + dir * 10));
      _renderHotwaterSettingsValues(presetEl, p);
    });
  });
});

hotwaterSettingsModalEl?.querySelectorAll('.steam-settings-name-input').forEach(input => {
  input.addEventListener('click', () => {
    window._openTextPicker(input.value, val => { input.value = val || input.placeholder; });
  });
});

hotwaterSettingsModalEl?.querySelectorAll('.hotwater-settings-value').forEach(span => {
  span.addEventListener('click', () => {
    const presetEl = span.closest('.hotwater-settings-preset');
    const key = presetEl?.dataset.preset;
    const p = _hotwaterSettingsDraft?.[key];
    if (!p) return;
    const field = span.dataset.field;
    if (field === 'temp')   openNumberPicker(_npMakeRange(50, 100, 5),   p.temp,   v => { p.temp   = v; _renderHotwaterSettingsValues(presetEl, p); });
    if (field === 'flow')   openNumberPicker(_npMakeRange(0.5, 10.0, 0.5), p.flow, v => { p.flow   = v; _renderHotwaterSettingsValues(presetEl, p); }, 1);
    if (field === 'volume') openNumberPicker(_npMakeRange(10, 500, 10),  p.volume, v => { p.volume = v; _renderHotwaterSettingsValues(presetEl, p); });
  });
});

document.getElementById('btn-hotwater-settings')?.addEventListener('click', _openHotwaterSettingsModal);

document.getElementById('btn-hotwater-settings-cancel')?.addEventListener('click', () => {
  if (hotwaterSettingsModalEl) hotwaterSettingsModalEl.hidden = true;
});

document.getElementById('btn-hotwater-settings-save')?.addEventListener('click', () => {
  if (!_hotwaterSettingsDraft) return;
  hotwaterSettingsModalEl?.querySelectorAll('.hotwater-settings-preset').forEach(el => {
    const key = el.dataset.preset;
    if (!_hotwaterSettingsDraft[key]) return;
    const nameVal = el.querySelector('.steam-settings-name-input')?.value.trim();
    _hotwaterSettingsDraft[key].name = nameVal || key;
  });
  NSXCore.setHotwaterPresets(_hotwaterSettingsDraft);
  if (hotwaterSettingsModalEl) hotwaterSettingsModalEl.hidden = true;
});

/* ── Flush State (domain in core/domains/flush.js) ────── */

// Flush state + machine push live in core. This skin renders on 'flushChanged'
// and drives the domain via NSXCore commands; all DOM stays here.
NSXCore.on('flushChanged', () => {
  updateFlushDisplay();
  _updateFlushPresetButtons();
});

function updateFlushDisplay() {
  const flowEl = document.getElementById('flush-flow');
  const durEl  = document.getElementById('flush-duration');
  if (flowEl) flowEl.textContent = `${NSXCore.getFlushFlow()} ml/s`;
  if (durEl)  durEl.textContent  = `${NSXCore.getFlushDuration()} s`;
}

function _updateFlushPresetButtons() {
  const presets = NSXCore.getFlushPresets();
  const active  = NSXCore.getActiveFlushPreset();
  document.querySelectorAll('.cleaning-card .steam-preset-btn').forEach(btn => {
    const key = btn.dataset.preset;
    btn.textContent = presets[key]?.name ?? key;
    btn.classList.toggle('is-active', key === active);
  });
}

document.querySelectorAll('.cleaning-card .steam-preset-btn').forEach(btn => {
  btn.addEventListener('click', () => NSXCore.selectFlushPreset(btn.dataset.preset));
});

document.getElementById('btn-flush-flow-up')?.addEventListener('click', () =>
  NSXCore.setFlushFlow(NSXCore.getFlushFlow() + 1));
document.getElementById('btn-flush-flow-down')?.addEventListener('click', () =>
  NSXCore.setFlushFlow(NSXCore.getFlushFlow() - 1));
document.getElementById('btn-flush-duration-up')?.addEventListener('click', () =>
  NSXCore.setFlushDuration(NSXCore.getFlushDuration() + 1));
document.getElementById('btn-flush-duration-down')?.addEventListener('click', () =>
  NSXCore.setFlushDuration(NSXCore.getFlushDuration() - 1));

/* ── Flush Settings Modal ────────────────────────────── */

const flushSettingsModalEl = document.getElementById('flush-settings-modal');
let _flushSettingsDraft = null;
let _flushMachineTemp = 80;
let _flushMachineTimeout = 10;

function _renderFlushMachineSettings() {
  const tempEl    = document.getElementById('flush-settings-temp');
  const timeoutEl = document.getElementById('flush-settings-timeout');
  if (tempEl)    tempEl.textContent    = `${_flushMachineTemp}°C`;
  if (timeoutEl) timeoutEl.textContent = `${_flushMachineTimeout} s`;
}

function _openFlushSettingsModal() {
  _flushSettingsDraft = JSON.parse(JSON.stringify(NSXCore.getFlushPresets()));
  flushSettingsModalEl?.querySelectorAll('.flush-settings-preset').forEach(el => {
    const key = el.dataset.preset;
    const p = _flushSettingsDraft[key];
    if (!p) return;
    el.querySelector('.steam-settings-name-input').value = p.name ?? key;
    _renderFlushSettingsValues(el, p);
  });
  fetchMachineSettings?.().then(s => {
    if (s?.flushTemp    != null) _flushMachineTemp    = Number(s.flushTemp);
    if (s?.flushTimeout != null) _flushMachineTimeout = Number(s.flushTimeout);
    _renderFlushMachineSettings();
  }).catch(() => {});
  _renderFlushMachineSettings();
  if (flushSettingsModalEl) flushSettingsModalEl.hidden = false;
}

function _renderFlushSettingsValues(presetEl, p) {
  presetEl.querySelectorAll('.flush-settings-value').forEach(span => {
    const field = span.dataset.field;
    if (!field) return;
    const unit = span.dataset.unit ?? '';
    if (field === 'flow')     span.textContent = p.flow.toFixed(0) + unit;
    if (field === 'duration') span.textContent = p.duration.toFixed(0) + unit;
  });
}

flushSettingsModalEl?.querySelectorAll('.flush-settings-preset').forEach(presetEl => {
  const key = presetEl.dataset.preset;
  presetEl.querySelectorAll('.flush-settings-up, .flush-settings-down').forEach(btn => {
    btn.addEventListener('click', () => {
      const p = _flushSettingsDraft?.[key];
      if (!p) return;
      const field = btn.dataset.field;
      const dir = btn.classList.contains('flush-settings-up') ? 1 : -1;
      if (field === 'flow')     p.flow     = Math.min(10, Math.max(1, p.flow + dir));
      if (field === 'duration') p.duration = Math.min(60, Math.max(1, p.duration + dir));
      _renderFlushSettingsValues(presetEl, p);
    });
  });
  presetEl.querySelector('.steam-settings-name-input')?.addEventListener('click', function() {
    window._openTextPicker(this.value, val => { this.value = val || this.placeholder; });
  });
  presetEl.querySelectorAll('.flush-settings-value').forEach(span => {
    span.addEventListener('click', () => {
      const p = _flushSettingsDraft?.[key];
      if (!p) return;
      const field = span.dataset.field;
      if (field === 'flow')     openNumberPicker(_npMakeRange(1, 10, 1),  p.flow,     v => { p.flow     = v; _renderFlushSettingsValues(presetEl, p); });
      if (field === 'duration') openNumberPicker(_npMakeRange(1, 60, 1),  p.duration, v => { p.duration = v; _renderFlushSettingsValues(presetEl, p); });
    });
  });
});

document.getElementById('btn-flush-temp-up')?.addEventListener('click', () => {
  _flushMachineTemp = Math.min(100, _flushMachineTemp + 1);
  _renderFlushMachineSettings();
});
document.getElementById('btn-flush-temp-down')?.addEventListener('click', () => {
  _flushMachineTemp = Math.max(0, _flushMachineTemp - 1);
  _renderFlushMachineSettings();
});
document.getElementById('flush-settings-temp')?.addEventListener('click', () => {
  openNumberPicker(_npMakeRange(0, 100, 1), _flushMachineTemp, v => { _flushMachineTemp = v; _renderFlushMachineSettings(); });
});
document.getElementById('btn-flush-timeout-up')?.addEventListener('click', () => {
  _flushMachineTimeout = Math.min(120, _flushMachineTimeout + 1);
  _renderFlushMachineSettings();
});
document.getElementById('btn-flush-timeout-down')?.addEventListener('click', () => {
  _flushMachineTimeout = Math.max(0, _flushMachineTimeout - 1);
  _renderFlushMachineSettings();
});
document.getElementById('flush-settings-timeout')?.addEventListener('click', () => {
  openNumberPicker(_npMakeRange(0, 120, 1), _flushMachineTimeout, v => { _flushMachineTimeout = v; _renderFlushMachineSettings(); });
});

document.getElementById('btn-flush-settings')?.addEventListener('click', _openFlushSettingsModal);

document.getElementById('btn-flush-settings-cancel')?.addEventListener('click', () => {
  if (flushSettingsModalEl) flushSettingsModalEl.hidden = true;
});

document.getElementById('btn-flush-settings-save')?.addEventListener('click', () => {
  if (!_flushSettingsDraft) return;
  flushSettingsModalEl?.querySelectorAll('.flush-settings-preset').forEach(el => {
    const key = el.dataset.preset;
    if (!_flushSettingsDraft[key]) return;
    const nameVal = el.querySelector('.steam-settings-name-input')?.value.trim();
    _flushSettingsDraft[key].name = nameVal || key;
  });
  NSXCore.setFlushPresets(_flushSettingsDraft);
  updateMachineSettings?.({ flushTemp: _flushMachineTemp, flushTimeout: _flushMachineTimeout }).catch(() => {});
  if (flushSettingsModalEl) flushSettingsModalEl.hidden = true;
});

/* ── Tap-to-edit for Steam / Hotwater / Flush values ──── */
{
  document.getElementById('steam-temp')?.addEventListener('click', () =>
    openNumberPicker(_npMakeRange(130, 165, 5), steamTemp, v => { steamTemp = v; saveSteamState(); pushSteamTemp(); }));
  document.getElementById('steam-flow')?.addEventListener('click', () =>
    openNumberPicker(_npMakeRange(0.5, 2.5, 0.1), steamFlow, v => { steamFlow = v; saveSteamState(); pushSteamFlow(); }, 1));
  document.getElementById('steam-duration')?.addEventListener('click', () =>
    openNumberPicker(_npMakeRange(1, 180, 1), steamDuration, v => { steamDuration = v; saveSteamState(); pushSteamDuration(); }));

  document.getElementById('hotwater-temp')?.addEventListener('click', () =>
    openNumberPicker(_npMakeRange(50, 100, 5), NSXCore.getHotwaterTemp(), v => NSXCore.setHotwaterTemp(v)));
  document.getElementById('hotwater-flow')?.addEventListener('click', () =>
    openNumberPicker(_npMakeRange(0.5, 10.0, 0.1), NSXCore.getHotwaterFlow(), v => NSXCore.setHotwaterFlow(v), 1));
  document.getElementById('hotwater-volume')?.addEventListener('click', () =>
    openNumberPicker(_npMakeRange(10, 500, 10), NSXCore.getHotwaterVolume(), v => NSXCore.setHotwaterVolume(v)));

  document.getElementById('flush-flow')?.addEventListener('click', () =>
    openNumberPicker(_npMakeRange(1, 10, 1), NSXCore.getFlushFlow(), v => NSXCore.setFlushFlow(v)));
  document.getElementById('flush-duration')?.addEventListener('click', () =>
    openNumberPicker(_npMakeRange(1, 60, 1), NSXCore.getFlushDuration(), v => NSXCore.setFlushDuration(v)));
}

/* ── Machine Settings Push ────────────────────────────── */

// push() / debounced() live in core/push.js. Core emits 'toast' on push errors;
// render it here where the DOM lives.
const push = NSXCore.push;
const debounced = NSXCore.debounced;
NSXCore.on('toast', (msg) => showToast(msg));

function pushSteamTemp()     { debounced('steamTemp',     () => push({ steamSettings: { targetTemperature: parseFloat(steamTemp) } })); }
function pushSteamFlow()     { debounced('steamFlow',     () => push({ steamSettings: { flow: parseFloat(steamFlow) } })); }
function pushSteamDuration() { debounced('steamDuration', () => push({ steamSettings: { duration: parseFloat(steamDuration) } })); }
function pushSteam()         { debounced('steam',         () => push({ steamSettings: { targetTemperature: parseFloat(steamTemp), flow: parseFloat(steamFlow), duration: parseFloat(steamDuration) } })); }



/* ── Schedule State ───────────────────────────────────── */

const SCHEDULE_DEFAULTS = {
  enabled: false,
  days: [1, 2, 3, 4, 5],
  onHour: 6, onMinute: 0,
  offHour: 22, offMinute: 0,
  scheduleId: null,
};

function loadScheduleState() {
  return Object.assign({}, SCHEDULE_DEFAULTS);
}

function saveScheduleState() {
  patchStoreSettings({ nsx_schedule: scheduleState });
}

let scheduleState = loadScheduleState();

function applyPresetButtonStates() {
  document.querySelectorAll('.steam-card .steam-preset-btn').forEach(btn => {
    btn.classList.toggle('is-active', btn.dataset.preset === activeSteamPreset);
  });
  _updateHotwaterPresetButtons();
  _updateFlushPresetButtons();
}

async function hydrateUiSettingsFromStore() {
  try {
    if (!(await NSXCore.loadStore())) return;

    if (storeSettings.nsx_steam_presets && typeof storeSettings.nsx_steam_presets === 'object') {
      steamPresets = {
        schwach: { ...STEAM_PRESET_DEFAULTS.schwach, ...storeSettings.nsx_steam_presets.schwach },
        normal:  { ...STEAM_PRESET_DEFAULTS.normal,  ...storeSettings.nsx_steam_presets.normal  },
        stark:   { ...STEAM_PRESET_DEFAULTS.stark,   ...storeSettings.nsx_steam_presets.stark   },
      };
    }
    const savedActive = storeSettings.nsx_steam_active_preset;
    if (typeof savedActive === 'string' && steamPresets[savedActive]) {
      activeSteamPreset = savedActive;
    } else if (savedActive === '' || savedActive === null) {
      activeSteamPreset = null;
    }

    if (storeSettings.nsx_steam_calibration && typeof storeSettings.nsx_steam_calibration === 'object') {
      steamCalibration = {
        schwach: { ...STEAM_CALIB_DEFAULTS.schwach, ...storeSettings.nsx_steam_calibration.schwach },
        normal:  { ...STEAM_CALIB_DEFAULTS.normal,  ...storeSettings.nsx_steam_calibration.normal  },
        stark:   { ...STEAM_CALIB_DEFAULTS.stark,   ...storeSettings.nsx_steam_calibration.stark   },
      };
    }

    if (Array.isArray(storeSettings.nsx_pitcher_presets)) {
      pitcherPresets = storeSettings.nsx_pitcher_presets.map((p, i) => ({
        ...PITCHER_PRESET_DEFAULTS[i],
        ...p,
      })).slice(0, 3);
      while (pitcherPresets.length < 3) pitcherPresets.push({ ...PITCHER_PRESET_DEFAULTS[pitcherPresets.length] });
    }

    if (typeof storeSettings.nsx_active_pitcher === 'number' && storeSettings.nsx_active_pitcher >= 0 && storeSettings.nsx_active_pitcher <= 2) {
      activePitcherIndex = storeSettings.nsx_active_pitcher;
    }

    if (storeSettings.nsx_sbw_enabled === true) {
      sbwEnabled = true;
    }

    if (storeSettings.nsx_ratio_dose_enabled === true) {
      _ratioDoseEnabled = true;
    }
    if (storeSettings.nsx_batch_freeze_enabled === true) {
      _batchFreezeEnabled = true;
    }

    NSXCore.hydrateHotwater();
    NSXCore.hydrateFlush();

    if (storeSettings.nsx_schedule && typeof storeSettings.nsx_schedule === 'object') {
      scheduleState = Object.assign({}, SCHEDULE_DEFAULTS, storeSettings.nsx_schedule);
    }

    if (typeof storeSettings.nsx_presence_enabled === 'boolean') {
      _presenceEnabled = storeSettings.nsx_presence_enabled;
    }
    if (Number.isFinite(Number(storeSettings.nsx_sleep_timeout_minutes))) {
      _presenceTimeoutMinutes = _normalizePresenceTimeout(storeSettings.nsx_sleep_timeout_minutes);
    }

      if (Number.isFinite(Number(storeSettings.nsx_display_brightness))) {
        _skinBrightness = _normalizeBrightness(storeSettings.nsx_display_brightness);
        setDisplayBrightness?.(_skinBrightness).catch(() => {});
      }

    if (typeof storeSettings.scalePowerMode === 'string') {
      _scalePowerMode = storeSettings.scalePowerMode;
      window.NSXScreensaver?.setScalePowerMode(_scalePowerMode);
    }

    if (typeof storeSettings.nsx_last_recipe_id === 'string') {
      _lastRecipeId = storeSettings.nsx_last_recipe_id;
    }

    if (storeSettings.nsx_series_visibility && typeof storeSettings.nsx_series_visibility === 'object') {
      window.NSXUI?.setSeriesVisibility('workflow', storeSettings.nsx_series_visibility);
    }
    if (storeSettings.nsx_series_visibility_history && typeof storeSettings.nsx_series_visibility_history === 'object') {
      window.NSXUI?.setSeriesVisibility('history', storeSettings.nsx_series_visibility_history);
    }

    _restoreCollapsedProfileGroups(storeSettings.nsx_profile_picker_collapsed_groups);

    if (Array.isArray(storeSettings.nsx_bean_manager_collapsed_roasters)) {
      _beanManagerCollapsedRoasters = new Set(storeSettings.nsx_bean_manager_collapsed_roasters);
    }

    setWaterDisplayUnit?.(_normalizeWaterUnit(storeSettings.nsx_water_unit));

    if (storeSettings.nsx_lockscreen_enabled === false) {
      window.NSXScreensaver?.setEnabled(false);
      document.body.classList.add('lockscreen-disabled');
    }

    window.NSXScreensaver?.setUnlockCallback(() => {
      if (storeSettings.nsx_wake_on_unlock !== false && currentMachineState === 'sleeping') {
        setMachineState('idle')
          .then(() => _schedulePushCurrentSkinState(true))
          .catch(() => {});
      }
    });

    if (typeof storeSettings.nsx_steam_enabled === 'boolean') {
      _setSteamEnabled(storeSettings.nsx_steam_enabled, false);
    }

    _pushScreensaverConfig();

    const steamState = steamPresets[activeSteamPreset] ?? steamPresets.normal;
    steamTemp = steamState.temp;
    steamFlow = steamState.flow;
    steamDuration = steamState.duration ?? 60;

    setSteamWidget(steamTemp, steamFlow, steamDuration);
    _updateSteamPresetButtons();
    _updateSbwWidget();
    _applySbwEnabled();
    _applyRatioDoseVisible();
    _applyShowRecipeCardRating();
    setHotwaterWidget(NSXCore.getHotwaterTemp(), NSXCore.getHotwaterFlow(), NSXCore.getHotwaterVolume());
    updateFlushDisplay();
    renderScheduleUI();
    applyPresetButtonStates();

    if (storeSettings.nsx_home_label) {
      window.NSXRouter?.setHomeLabelOverride(storeSettings.nsx_home_label);
    }
    if (storeSettings.nsx_display_scale) {
      _currentScaleKey = _resolveScaleKey(storeSettings.nsx_display_scale);
      _draftScaleKey = _currentScaleKey;
      const scaleValue = _currentScaleKey === 'auto' ? 'auto' : _currentScaleKey;
      _applyScale(scaleValue);
    }
  } catch (err) {
    console.debug('Store load failed:', err?.message || err);
  }
}

function pad2(n) { return String(n).padStart(2, '0'); }

function renderScheduleUI() {
  const toggleEl = document.getElementById('schedule-enabled');
  if (toggleEl) toggleEl.checked = scheduleState.enabled;

  document.querySelectorAll('.schedule-day-btn').forEach(btn => {
    btn.classList.toggle('is-active', scheduleState.days.includes(Number(btn.dataset.day)));
  });

  const onH  = document.getElementById('schedule-on-hour');
  const onM  = document.getElementById('schedule-on-minute');
  const offH = document.getElementById('schedule-off-hour');
  const offM = document.getElementById('schedule-off-minute');
  if (onH)  onH.textContent  = pad2(scheduleState.onHour);
  if (onM)  onM.textContent  = pad2(scheduleState.onMinute);
  if (offH) offH.textContent = pad2(scheduleState.offHour);
  if (offM) offM.textContent = pad2(scheduleState.offMinute);
}

async function syncScheduleToApi() {
  if (!scheduleState.enabled) {
    if (scheduleState.scheduleId) {
      try {
        await updateSchedule(scheduleState.scheduleId, { id: scheduleState.scheduleId, enabled: false });
      } catch {}
    }
    return;
  }
  const days = scheduleState.days.length > 0 ? scheduleState.days : [1, 2, 3, 4, 5, 6, 7];
  const time = `${pad2(scheduleState.onHour)}:${pad2(scheduleState.onMinute)}`;
  if (scheduleState.scheduleId) {
    try {
      await updateSchedule(scheduleState.scheduleId, {
        id: scheduleState.scheduleId,
        time,
        daysOfWeek: days,
        enabled: true,
        keepAwakeFor: 0,
      });
      return;
    } catch {
      scheduleState.scheduleId = null;
      saveScheduleState();
    }
  }
  try {
    const created = await createSchedule({
      time,
      daysOfWeek: days,
      enabled: true,
      keepAwakeFor: 0,
    });
    scheduleState.scheduleId = created?.id || null;
    saveScheduleState();
  } catch (err) {
    showToast(t('toast.scheduleFailed') + ': ' + err.message);
  }
}

function applyScheduleState() {
  saveScheduleState();
  renderScheduleUI();
  syncScheduleToApi();
}

// Toggle schedule enabled
document.getElementById('schedule-enabled')?.addEventListener('change', (e) => {
  scheduleState.enabled = e.target.checked;
  applyScheduleState();
});

// Day buttons
document.querySelectorAll('.schedule-day-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const day = Number(btn.dataset.day);
    const idx = scheduleState.days.indexOf(day);
    if (idx >= 0) scheduleState.days.splice(idx, 1);
    else scheduleState.days.push(day);
    applyScheduleState();
  });
});

// On-time buttons
document.getElementById('btn-sch-on-h-up')?.addEventListener('click', () => {
  scheduleState.onHour = (scheduleState.onHour + 1) % 24;
  applyScheduleState();
});
document.getElementById('btn-sch-on-h-down')?.addEventListener('click', () => {
  scheduleState.onHour = (scheduleState.onHour + 23) % 24;
  applyScheduleState();
});
document.getElementById('btn-sch-on-m-up')?.addEventListener('click', () => {
  scheduleState.onMinute = (scheduleState.onMinute + 15) % 60;
  applyScheduleState();
});
document.getElementById('btn-sch-on-m-down')?.addEventListener('click', () => {
  scheduleState.onMinute = (scheduleState.onMinute + 45) % 60;
  applyScheduleState();
});

// Off-time buttons (client-side sleep, no API endpoint for sleep schedules)
document.getElementById('btn-sch-off-h-up')?.addEventListener('click', () => {
  scheduleState.offHour = (scheduleState.offHour + 1) % 24;
  applyScheduleState();
});
document.getElementById('btn-sch-off-h-down')?.addEventListener('click', () => {
  scheduleState.offHour = (scheduleState.offHour + 23) % 24;
  applyScheduleState();
});
document.getElementById('btn-sch-off-m-up')?.addEventListener('click', () => {
  scheduleState.offMinute = (scheduleState.offMinute + 15) % 60;
  applyScheduleState();
});
document.getElementById('btn-sch-off-m-down')?.addEventListener('click', () => {
  scheduleState.offMinute = (scheduleState.offMinute + 45) % 60;
  applyScheduleState();
});

// Client-side sleep timer (checks every minute)

/* ── Swipe-to-Delete ──────────────────────────────────── */

const DELETE_ZONE_WIDTH = 80;
let swipeState = null;

function getSwipeLayer(cardEl) {
  return cardEl?.querySelector('.workflow-swipe-layer');
}

function closeAllSwipes(except = null) {
  workflowListEl.querySelectorAll('.workflow-card.swipe-open').forEach(el => {
    if (el === except) return;
    el.classList.remove('swipe-open');
    const layer = getSwipeLayer(el);
    if (layer) { layer.style.transition = ''; layer.style.transform = 'translateX(0)'; }
  });
}

workflowListEl.addEventListener('touchstart', (e) => {
  if (e.touches.length !== 1) return;
  const cardEl = e.target.closest('.workflow-card');
  if (!cardEl) { closeAllSwipes(); return; }

  closeAllSwipes(cardEl);

  swipeState = {
    cardEl,
    layer: getSwipeLayer(cardEl),
    startX: e.touches[0].clientX,
    startY: e.touches[0].clientY,
    isHorizontal: null,
    wasOpen: cardEl.classList.contains('swipe-open'),
  };
}, { passive: true });

workflowListEl.addEventListener('touchmove', (e) => {
  if (!swipeState) return;
  const dx = e.touches[0].clientX - swipeState.startX;
  const dy = e.touches[0].clientY - swipeState.startY;

  if (swipeState.isHorizontal === null) {
    if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
    swipeState.isHorizontal = Math.abs(dx) > Math.abs(dy) * 1.2;
    if (!swipeState.isHorizontal) { swipeState = null; return; }
  }

  e.preventDefault();

  const base = swipeState.wasOpen ? -DELETE_ZONE_WIDTH : 0;
  const clamped = Math.max(-DELETE_ZONE_WIDTH, Math.min(0, base + dx));

  swipeState.layer.style.transition = 'none';
  swipeState.layer.style.transform = `translateX(${clamped}px)`;
}, { passive: false });

workflowListEl.addEventListener('touchend', (e) => {
  if (!swipeState || !swipeState.isHorizontal) { swipeState = null; return; }

  e.stopPropagation();

  const dx = e.changedTouches[0].clientX - swipeState.startX;
  const layer = swipeState.layer;
  const cardEl = swipeState.cardEl;
  const THRESHOLD = DELETE_ZONE_WIDTH * 0.35;

  layer.style.transition = '';

  const shouldOpen = swipeState.wasOpen ? dx < THRESHOLD : dx < -THRESHOLD;

  if (shouldOpen) {
    layer.style.transform = `translateX(-${DELETE_ZONE_WIDTH}px)`;
    cardEl.classList.add('swipe-open');
  } else {
    layer.style.transform = 'translateX(0)';
    cardEl.classList.remove('swipe-open');
  }

  swipeState = null;
}, { passive: true });

/* ── History Swipe-to-Delete ──────────────────────────── */
const historyListEl = document.getElementById('history-accordion-list');
let historySwipeState = null;
const HISTORY_DELETE_WIDTH = 80;

function getHistorySwipeLayer(itemEl) {
  return itemEl?.querySelector('.history-swipe-layer');
}

function closeAllHistorySwipes(except = null) {
  historyListEl?.querySelectorAll('.history-accordion-item.swipe-open').forEach(el => {
    if (el === except) return;
    el.classList.remove('swipe-open');
    const layer = getHistorySwipeLayer(el);
    if (layer) { layer.style.transition = ''; layer.style.transform = 'translateX(0)'; }
  });
}

historyListEl?.addEventListener('touchstart', (e) => {
  if (e.touches.length !== 1) return;
  const itemEl = e.target.closest('.history-accordion-item');
  if (!itemEl) { closeAllHistorySwipes(); return; }
  closeAllHistorySwipes(itemEl);
  historySwipeState = {
    itemEl,
    layer: getHistorySwipeLayer(itemEl),
    startX: e.touches[0].clientX,
    startY: e.touches[0].clientY,
    isHorizontal: null,
    wasOpen: itemEl.classList.contains('swipe-open'),
  };
}, { passive: true });

historyListEl?.addEventListener('touchmove', (e) => {
  if (!historySwipeState) return;
  const dx = e.touches[0].clientX - historySwipeState.startX;
  const dy = e.touches[0].clientY - historySwipeState.startY;
  if (historySwipeState.isHorizontal === null) {
    if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
    historySwipeState.isHorizontal = Math.abs(dx) > Math.abs(dy) * 1.2;
    if (!historySwipeState.isHorizontal) { historySwipeState = null; return; }
  }
  e.preventDefault();
  const base = historySwipeState.wasOpen ? -HISTORY_DELETE_WIDTH : 0;
  const clamped = Math.max(-HISTORY_DELETE_WIDTH, Math.min(0, base + dx));
  historySwipeState.layer.style.transition = 'none';
  historySwipeState.layer.style.transform = `translateX(${clamped}px)`;
}, { passive: false });

historyListEl?.addEventListener('touchend', (e) => {
  if (!historySwipeState || !historySwipeState.isHorizontal) { historySwipeState = null; return; }
  e.stopPropagation();
  const dx = e.changedTouches[0].clientX - historySwipeState.startX;
  const { layer, itemEl } = historySwipeState;
  const THRESHOLD = HISTORY_DELETE_WIDTH * 0.35;
  layer.style.transition = '';
  const shouldOpen = historySwipeState.wasOpen ? dx < THRESHOLD : dx < -THRESHOLD;
  if (shouldOpen) {
    layer.style.transform = `translateX(-${HISTORY_DELETE_WIDTH}px)`;
    itemEl.classList.add('swipe-open');
  } else {
    layer.style.transform = 'translateX(0)';
    itemEl.classList.remove('swipe-open');
  }
  historySwipeState = null;
}, { passive: true });

/* ── Delete Confirm Dialog ────────────────────────────── */

const deleteConfirmEl = document.getElementById('workflow-delete-confirm');
const deleteConfirmMsgEl = document.getElementById('delete-confirm-message');
let pendingDeleteIndex = null;
let pendingDeleteShotId = null;

function openDeleteConfirm(index) {
  const workflow = workflowItems[index];
  if (!workflow || !deleteConfirmEl) return;
  pendingDeleteIndex = index;
  if (deleteConfirmMsgEl) {
    const name = [workflow.coffeeRoaster, workflow.coffeeName].filter(v => v && v !== '—').join(' · ') || workflow.profileTitle;
    deleteConfirmMsgEl.textContent = `${name}`;
  }
  const titleEl = deleteConfirmEl.querySelector('.modal-alert-title');
  if (titleEl) titleEl.textContent = t('recipeDelete.title');
  deleteConfirmEl.hidden = false;
}

document.getElementById('btn-delete-cancel')?.addEventListener('click', () => {
  if (deleteConfirmEl) deleteConfirmEl.hidden = true;
  closeAllSwipes();
  pendingDeleteIndex = null;
  pendingDeleteShotId = null;
});

deleteConfirmEl?.addEventListener('click', (e) => {
  if (e.target === deleteConfirmEl) {
    deleteConfirmEl.hidden = true;
    closeAllSwipes();
    pendingDeleteIndex = null;
    pendingDeleteShotId = null;
  }
});

document.getElementById('btn-delete-confirm')?.addEventListener('click', async () => {
  if (deleteConfirmEl) deleteConfirmEl.hidden = true;

  if (pendingDeleteShotId) {
    const shotId = pendingDeleteShotId;
    pendingDeleteShotId = null;
    await _deleteHistoryShot(shotId);
    return;
  }

  const index = pendingDeleteIndex;
  if (!Number.isInteger(index)) return;
  closeAllSwipes();
  pendingDeleteIndex = null;
  await deleteWorkflowShots(index);
});

async function deleteWorkflowShots(workflowIndex) {
  const workflow = workflowItems[workflowIndex];
  if (!workflow) return;

  showToast(t('toast.deleting'));

  // Remove recipe from store
  workflowItems.splice(workflowIndex, 1);
  await _saveRecipesToStore(workflowItems);
  selectedWorkflowIndex = Math.max(0, Math.min(selectedWorkflowIndex, Math.max(0, workflowItems.length - 1)));
  historySelectedRecipeIndex = Math.min(historySelectedRecipeIndex, workflowItems.length - 1);
  renderWorkflows(getDisplayWorkflows(), selectedWorkflowIndex);
  renderHomeRecentRecipes();
  renderHistory();
  if (workflowItems.length > 0) {
    setCurrentWorkflow(workflowItems[selectedWorkflowIndex]);
    plotWorkflowShot(workflowItems[selectedWorkflowIndex]);
    setWorkflowSyncState?.('pending');
    clearTimeout(_pushDebounceTimer);
    _pushDebounceTimer = setTimeout(() => {
      pushSelectedWorkflowToMachine(workflowItems[selectedWorkflowIndex]);
    }, 400);
  }

  showToast(t('toast.recipeDeleted'));
}

/* ── History ─────────────────────────────────────────── */

/* ── History Search & Filter ──────────────────────────── */

let _historySearch = '';
let _historyServerResults = null;
let _historySearchTimer = null;
let _shotsTotalCount = 0;
const _historyFilters = { roasters: new Set(), beans: new Set(), grinders: new Set(), profiles: new Set(), favoritesOnly: false, minRating: 0 };

function _hasActiveHistoryFilters() {
  return _historyFilters.roasters.size > 0 || _historyFilters.beans.size > 0
      || _historyFilters.grinders.size > 0 || _historyFilters.profiles.size > 0
      || _historyFilters.favoritesOnly || _historyFilters.minRating > 0;
}

function _updateHistoryFilterBtn() {
  document.getElementById('btn-history-filter')
    ?.classList.toggle('is-active', _hasActiveHistoryFilters());
}

function _getFilteredHistoryRecipes(all) {
  const doTextFilter = historyShots.length === 0 && Boolean(_historySearch);
  if (!doTextFilter && !_hasActiveHistoryFilters()) return all;
  const q = doTextFilter ? _historySearch.toLowerCase() : null;
  return all.filter(w => {
    if (q) {
      const match = [w.coffeeRoaster, w.coffeeName, w.grinderModel, w.profileTitle]
        .some(v => v && v.toLowerCase().includes(q));
      if (!match) return false;
    }
    if (_historyFilters.roasters.size > 0 && !_historyFilters.roasters.has(w.coffeeRoaster)) return false;
    if (_historyFilters.beans.size    > 0 && !_historyFilters.beans.has(w.coffeeName))        return false;
    if (_historyFilters.grinders.size > 0 && !_historyFilters.grinders.has(w.grinderModel))   return false;
    if (_historyFilters.profiles.size > 0 && !_historyFilters.profiles.has(w.profileTitle))   return false;
    return true;
  });
}

function _updateLoadMoreButton() {
  const wrap = document.getElementById('history-load-more-wrap');
  if (!wrap) return;
  wrap.hidden = !_historySearch || historyShots.length >= _shotsTotalCount;
}

async function _loadMoreHistory() {
  const btn = document.getElementById('btn-history-load-more');
  if (btn) btn.disabled = true;
  try {
    const res = await fetchShots(50, historyShots.length, _historySearch);
    const newItems = Array.isArray(res?.items) ? res.items : [];
    _shotsTotalCount = Number.isFinite(res?.total) ? res.total : _shotsTotalCount;
    if (newItems.length > 0) {
      const existingIds = new Set(historyShots.map(s => s.id));
      historyShots = [...historyShots, ...newItems.filter(s => !existingIds.has(s.id))];
    }
  } catch (err) {
    console.warn('Mehr Shots konnten nicht geladen werden:', err?.message);
  } finally {
    if (btn) btn.disabled = false;
  }
  renderHistory();
}

const _recipeRatingCache = new Map(); // key: getWorkflowKey → { max:number|null, count:number }

function _computeMaxRating(shotList) {
  // count = how many shots share the maximum rating (not total rated shots)
  let max = null, count = 0;
  for (const s of shotList || []) {
    const r = Number(s?.annotations?.enjoyment ?? s?.metadata?.rating);
    if (!Number.isFinite(r)) continue;
    if (max === null || r > max) { max = r; count = 1; }
    else if (r === max) { count++; }
  }
  return { max, count };
}

async function _fetchAllRecipeShots(params) {
  const all = [];
  let offset = 0;
  const pageLimit = 200;
  while (true) {
    const res = await fetchShots({ ...params, limit: pageLimit, offset });
    const items = Array.isArray(res?.items) ? res.items : [];
    all.push(...items);
    const total = Number.isFinite(res?.total) ? res.total : all.length;
    offset += items.length;
    if (items.length === 0 || all.length >= total) break;
  }
  return all;
}

function _attachRecipeRating(w) {
  const key = getWorkflowKey(w);
  const cached = _recipeRatingCache.get(key);
  const approx = cached ?? _computeMaxRating(findShotsForWorkflow(w));
  w.maxRating  = cached ? cached.max   : approx.max;
  w.ratedCount = cached ? cached.count : approx.count;
  return w;
}

function _loadRecipeRatings(recipes) {
  for (const r of recipes || []) {
    const key = getWorkflowKey(r);
    if (_recipeRatingCache.has(key)) {
      const c = _recipeRatingCache.get(key);
      updateRecipeRating?.(key, c.max, c.count);
      continue;
    }
    const params = {};
    if (r.coffeeName    && r.coffeeName    !== '—') params.coffeeName    = r.coffeeName;
    if (r.coffeeRoaster && r.coffeeRoaster !== '—') params.coffeeRoaster = r.coffeeRoaster;
    if (r.grinderModel  && r.grinderModel  !== '—') params.grinderModel  = r.grinderModel;
    if (r.profileTitle  && r.profileTitle  !== '—') params.profileTitle  = r.profileTitle;
    _fetchAllRecipeShots(params)
      .then(items => {
        const matched = items.filter(s => getWorkflowKey(mapShotToWorkflow(s)) === key);
        const { max, count } = _computeMaxRating(matched);
        _recipeRatingCache.set(key, { max, count });
        updateRecipeRating?.(key, max, count);
      })
      .catch(() => {});
  }
}

// Recipe cards show the instant rating approximation from already-loaded shots
// (via _attachRecipeRating) — free. The authoritative per-recipe shot fetch is
// deferred to when the History tab is opened (see renderHistory) to avoid a burst
// of /shots requests at startup.

function _filterShotsByFavAndRating(shotList) {
  const { favoritesOnly, minRating } = _historyFilters;
  if (!favoritesOnly && minRating <= 0) return shotList;
  return shotList.filter(shot => {
    const ann = shot.annotations ?? {};
    if (favoritesOnly) {
      const isFav = ann.extras?.favorite ?? shot.metadata?.favorite === true;
      if (!isFav) return false;
    }
    if (minRating > 0) {
      const rating = ann.enjoyment ?? shot.metadata?.rating ?? null;
      if (rating === null || rating < minRating) return false;
    }
    return true;
  });
}

function renderHistory() {
  const raw = historyShots.length > 0 ? historyShots : shots;
  const source = _filterShotsByFavAndRating(raw);
  historyRecipes = buildWorkflowItemsFromShots(source);
  const filtered = _getFilteredHistoryRecipes(historyRecipes);
  let selectedShots = null;
  if (historySelectedRecipeIndex >= 0 && historySelectedRecipeIndex < filtered.length) {
    selectedShots = findShotsForHistoryWorkflow(filtered[historySelectedRecipeIndex], source);
  }
  renderHistoryAccordion?.(filtered, historySelectedRecipeIndex, selectedShots);
  // Only fetch authoritative per-recipe ratings when the History tab is actually
  // shown — avoids a burst of /shots requests during the startup pre-render.
  if (window._currentTabIndex === 2) _loadRecipeRatings(filtered);
  if (selectedShots) _loadHistoryShotDurations(selectedShots);
  _updateLoadMoreButton();
}

function _loadHistoryShotDurations(recipeShots) {
  for (const shot of recipeShots) {
    if (!shot?.id) continue;
    getShotDetailsCached(shot.id)
      .then(full => updateHistoryShotDuration?.(shot.id, getShotDurationSeconds(full)))
      .catch(() => updateHistoryShotDuration?.(shot.id, null));
  }
}

document.getElementById('btn-history-load-more')?.addEventListener('click', () => _loadMoreHistory());

document.getElementById('history-accordion-list')?.addEventListener('click', e => {
  const deleteAllBtn = e.target.closest('.history-delete-all-btn');
  if (deleteAllBtn) {
    const idx = parseInt(deleteAllBtn.dataset.historyRecipeIndex, 10);
    if (!Number.isInteger(idx)) return;
    const recipe = historyRecipes[idx];
    if (!recipe) return;
    const recipeShotIds = findShotsForWorkflow(recipe).map(s => s.id);
    if (!recipeShotIds.length) return;
    (async () => {
      if (!await showConfirm(t('confirm.deleteRecipeShots').replace('{count}', recipeShotIds.length))) {
        closeAllHistorySwipes();
        return;
      }
      try {
        await Promise.all(recipeShotIds.map(id => deleteShotById(id)));
        shots = shots.filter(s => !recipeShotIds.includes(s.id));
        recipeShotIds.forEach(id => shotDetailsCache.delete(id));
        _recipeRatingCache.clear();
        historySelectedRecipeIndex = -1;
        renderHistory();
        renderWorkflows(getDisplayWorkflows(), selectedWorkflowIndex);
        showToast(t('toast.shotsDeleted').replace('{count}', recipeShotIds.length));
      } catch {
        showToast(t('toast.shotsDeleteFailed'));
      }
    })();
    return;
  }

  const deleteBtn = e.target.closest('.history-shot-delete-btn');
  if (deleteBtn) {
    const shotId = deleteBtn.dataset.shotId;
    if (shotId) _confirmDeleteHistoryShot(shotId);
    return;
  }

  const header = e.target.closest('.history-accordion-header');
  if (header) {
    const item = header.closest('[data-history-recipe-index]');
    if (!item) return;
    const idx = parseInt(item.dataset.historyRecipeIndex, 10);
    if (!Number.isInteger(idx)) return;
    if (item.classList.contains('swipe-open')) {
      closeAllHistorySwipes();
      return;
    }
    historySelectedRecipeIndex = historySelectedRecipeIndex === idx ? -1 : idx;
    renderHistory();
  }
});

function _confirmDeleteHistoryShot(shotId) {
  if (!deleteConfirmEl || !deleteConfirmMsgEl) return;
  pendingDeleteShotId = shotId;
  pendingDeleteIndex = null;
  deleteConfirmMsgEl.textContent = t('confirm.deleteShot');
  const titleEl = deleteConfirmEl.querySelector('.modal-alert-title');
  if (titleEl) titleEl.textContent = t('shotDelete.title');
  deleteConfirmEl.hidden = false;
}

async function _deleteHistoryShot(shotId) {
  try {
    await deleteShotById(shotId);
    shots = shots.filter(s => s.id !== shotId);
    shotDetailsCache.delete(shotId);
    _recipeRatingCache.clear();
    if (historySelectedRecipeIndex >= workflowItems.length) {
      historySelectedRecipeIndex = workflowItems.length > 0 ? 0 : -1;
    }
    renderHistory();
    renderWorkflows(getDisplayWorkflows(), selectedWorkflowIndex);
    showToast(t('toast.shotDeleted'));
  } catch {
    showToast(t('toast.shotDeleteFailed'));
  }
}

/* ── Steam by Weight – recipe page widget ──────────────── */

let activePitcherIndex = 0;
let sbwEnabled = false;

function _saveActivePitcher() {
  setStoreValue?.('skin', 'nsx_active_pitcher', activePitcherIndex).catch(() => {});
}

function _saveSbwEnabled() {
  patchStoreSettings({ nsx_sbw_enabled: sbwEnabled });
}

function _applySbwEnabled() {
  const widget = document.getElementById('workflow-sbw-widget');
  if (widget) widget.hidden = !sbwEnabled;
  const bottom = document.querySelector('.steam-settings-bottom');
  if (bottom) bottom.classList.toggle('sbw-disabled', !sbwEnabled);
  const toggle = document.getElementById('sbw-enabled-toggle');
  if (toggle) toggle.checked = sbwEnabled;
}

function _sbwCalibFactor() {
  const pitcher = pitcherPresets[activePitcherIndex];
  if (!pitcher?.steamPreset) return null;
  return steamPresets[pitcher.steamPreset]?.calibFactor ?? null;
}

/* ── Dose Scaling ────────────────────────────────────── */

let _ratioDoseEnabled = false;
let _batchFreezeEnabled = false;
let _scaledDose = null;
let _scaledYield = null;

function _applyRatioDoseVisible() {
  const widget = document.getElementById('workflow-dose-widget');
  if (widget) widget.hidden = !_ratioDoseEnabled;
}

function _applyShowRecipeCardRating() {
  document.body.classList.toggle('hide-recipe-card-rating', storeSettings.nsx_show_recipe_card_rating === false);
}

function _clearDoseScaleState() {
  if (_scaledDose === null) return;
  _scaledDose = null;
  _scaledYield = null;
  document.getElementById('btn-dose-scale')?.classList.remove('is-active');
  const doseYieldEl = document.querySelector('[data-field="dose-yield"]');
  if (doseYieldEl) {
    doseYieldEl.classList.remove('is-scaled');
    const wf = workflowItems[selectedWorkflowIndex];
    if (wf) doseYieldEl.textContent = `${wf.targetDoseWeight}g:${wf.targetYield}g`;
  }
}

function _applyDoseScale() {
  const wf = workflowItems[selectedWorkflowIndex];
  if (!wf) { showAlert('No recipe selected.'); return; }
  const recipeDose  = Number(wf.targetDoseWeight || 0);
  const recipeYield = Number(wf.targetYield || 0);
  if (recipeDose <= 0 || recipeYield <= 0) {
    showAlert('The selected recipe has no dose or yield configured.');
    return;
  }
  if (!scaleConnected) { showAlert('Scale is not connected.'); return; }
  const cupWeight = Number(storeSettings.nsx_dosing_cup_weight) || 0;
  const doseWeight = Math.round((liveWeight - cupWeight) * 10) / 10;
  if (doseWeight <= 0) {
    showAlert(cupWeight > 0
      ? 'Place the dosing cup with beans on the scale first.'
      : 'Place beans on the scale first.');
    return;
  }

  const ratio = recipeYield / recipeDose;
  _scaledDose  = doseWeight;
  _scaledYield = Math.round(_scaledDose * ratio * 10) / 10;

  // Update recipe card display
  const doseYieldEl = document.querySelector('[data-field="dose-yield"]');
  if (doseYieldEl) {
    doseYieldEl.textContent = `${_scaledDose}g:${_scaledYield}g`;
    doseYieldEl.classList.add('is-scaled');
  }

  document.getElementById('btn-dose-scale')?.classList.add('is-active');

  // Push to machine (partial — only dose/yield, rest unchanged)
  pushWorkflow({ context: { targetDoseWeight: _scaledDose, targetYield: _scaledYield } }).catch(() => {});
}

document.getElementById('btn-dose-scale')?.addEventListener('click', () => {
  if (_scaledDose !== null) {
    // Revert: clear state and re-push original recipe values
    _clearDoseScaleState();
    const wf = workflowItems[selectedWorkflowIndex];
    if (wf) pushWorkflow({ context: { targetDoseWeight: Number(wf.targetDoseWeight || 0), targetYield: Number(wf.targetYield || 0) } }).catch(() => {});
  } else {
    _applyDoseScale();
  }
});

function _updateSbwWidget() {
  const pitcher = pitcherPresets[activePitcherIndex];
  const nameEl = document.getElementById('sbw-pitcher-label');
  if (nameEl) nameEl.textContent = pitcher?.name || `Pitcher ${activePitcherIndex + 1}`;
  const btn = document.getElementById('btn-steam-by-weight');
  const hasCalib = _sbwCalibFactor() != null && pitcher?.pitcherWeight != null;
  btn?.classList.toggle('is-ready', hasCalib);
}

let _sbwSaved = null;

function _clearSbwState(restore = true) {
  if (_sbwSaved === null) return;
  if (restore) {
    activeSteamPreset = _sbwSaved.preset;
    steamTemp     = _sbwSaved.temp;
    steamFlow     = _sbwSaved.flow;
    steamDuration = _sbwSaved.duration;
    saveActivePresetName('nsx_steam_active_preset', _sbwSaved.preset ?? '');
    _updateSteamPresetButtons();
    _updateSteamWidget();
    pushSteam();
  }
  _sbwSaved = null;
  document.getElementById('btn-steam-by-weight')?.classList.remove('is-active');
}

function _toggleSbwPreset() {
  if (_sbwSaved !== null) {
    _clearSbwState(true);
  } else {
    _applySbwPreset();
  }
}

function _applySbwPreset() {
  const pitcher = pitcherPresets[activePitcherIndex];
  if (!pitcher) return;
  if (pitcher.pitcherWeight == null) {
    showAlert('Pitcher weight not set.\n\nMeasure the empty pitcher weight in Steam Settings → pitcher card.');
    return;
  }
  const calibFactor = _sbwCalibFactor();
  if (calibFactor == null) {
    const presetName = steamPresets[pitcher.steamPreset]?.name ?? pitcher.steamPreset ?? '—';
    showAlert(`No calibration for preset "${presetName}".\n\nOpen Steam Settings → Calibration card, select this preset, measure the milk weight and enter the steaming time.`);
    return;
  }
  const milkWeight = liveWeight - pitcher.pitcherWeight;
  if (milkWeight <= 0) { showToast('Place filled pitcher on scale and tare it first'); return; }

  // Remember current steam settings so a second tap can revert (toggle, like auto-dose).
  _sbwSaved = { preset: activeSteamPreset, temp: steamTemp, flow: steamFlow, duration: steamDuration };

  selectSteamPreset(pitcher.steamPreset);
  const newDuration = Math.max(5, Math.round(milkWeight * calibFactor));
  steamDuration = newDuration;
  _updateSteamWidget();
  document.getElementById('btn-steam-by-weight')?.classList.add('is-active');
  showToast(`Steam time set to ${newDuration}s for ${milkWeight.toFixed(0)}g milk`);
}

/* ── Long-press pitcher strip ──────────────────────────── */
(function() {
  const btn = document.getElementById('btn-steam-by-weight');
  const strip = document.getElementById('sbw-pitcher-strip');
  if (!btn || !strip) return;

  let longPressTimer = null;
  let stripOpen = false;
  let hoveredIdx = null;

  function renderStrip() {
    strip.innerHTML = pitcherPresets.map((p, i) =>
      `<div class="sbw-strip-item${i === activePitcherIndex ? ' is-active' : ''}" data-idx="${i}">${p.name || `Pitcher ${i + 1}`}</div>`
    ).join('');
  }

  function openStrip() {
    renderStrip();
    strip.hidden = false;
    stripOpen = true;
    hoveredIdx = null;
    navigator.vibrate?.(30);
  }

  function closeStrip(select) {
    strip.hidden = true;
    stripOpen = false;
    if (select && hoveredIdx != null && hoveredIdx !== activePitcherIndex) {
      activePitcherIndex = hoveredIdx;
      _saveActivePitcher();
      _updateSbwWidget();
    }
    hoveredIdx = null;
  }

  function updateHover(clientX, clientY) {
    const items = [...strip.querySelectorAll('.sbw-strip-item')];
    // Find the single item whose center is closest to the touch point
    let closest = null;
    let closestDist = Infinity;
    items.forEach(item => {
      const r = item.getBoundingClientRect();
      const cy = (r.top + r.bottom) / 2;
      const dist = Math.abs(clientY - cy);
      if (dist < closestDist) { closestDist = dist; closest = item; }
    });
    hoveredIdx = null;
    items.forEach(item => {
      const isClosest = item === closest;
      item.classList.toggle('is-hovered', isClosest);
      if (isClosest) hoveredIdx = Number(item.dataset.idx);
    });
  }

  let lastTouchTime = 0;

  // Touch
  btn.addEventListener('touchstart', e => {
    longPressTimer = setTimeout(openStrip, 400);
  }, { passive: true });

  btn.addEventListener('touchmove', e => {
    if (!stripOpen) { clearTimeout(longPressTimer); return; }
    const t = e.touches[0];
    updateHover(t.clientX, t.clientY);
  }, { passive: true });

  btn.addEventListener('touchend', e => {
    lastTouchTime = Date.now();
    clearTimeout(longPressTimer);
    if (stripOpen) {
      closeStrip(true);
    } else {
      _toggleSbwPreset();
    }
  });

  btn.addEventListener('touchcancel', () => {
    clearTimeout(longPressTimer);
    closeStrip(false);
  });

  // Mouse (for desktop testing)
  let mouseDownOnBtn = false;
  btn.addEventListener('mousedown', () => {
    mouseDownOnBtn = true;
    longPressTimer = setTimeout(openStrip, 400);
  });

  document.addEventListener('mousemove', e => {
    if (!stripOpen) return;
    updateHover(e.clientX, e.clientY);
  });

  document.addEventListener('mouseup', e => {
    clearTimeout(longPressTimer);
    if (stripOpen) {
      closeStrip(true);
    } else if (mouseDownOnBtn && Date.now() - lastTouchTime > 600) {
      // Plain click (not a long-press) — skip if it's an emulated event after a real touch.
      _toggleSbwPreset();
    }
    mouseDownOnBtn = false;
  });
})();

function _updateScaleIndicatorVisibility() {
  const area = document.getElementById('workflow-scale-area');
  if (!area) return;
  const onRecipesTab = window._currentTabIndex === 1;
  area.classList.toggle('is-visible', onRecipesTab && !liveShot);
  if (onRecipesTab && !liveShot) _updateSbwWidget();
}

window.addEventListener('router:tabchange', e => {
  const idx = e.detail?.index;
  window._currentTabIndex = idx;
  const reserve = document.getElementById('workflow-graph-reserve');
  if (reserve) reserve.classList.toggle('is-visible', idx === 1);
  _updateScaleIndicatorVisibility();
  if (idx === 1) {
    if (liveShot) {
      const wfGraphEl = document.getElementById('workflow-shot-graph');
      if (wfGraphEl && !wfGraphEl._liveMode) initLiveShotChart?.(wfGraphEl);
      if (wfGraphEl?._liveMode) updateLiveShotChart?.(wfGraphEl, liveShot);
    } else if (workflowItems.length > 0) {
      plotWorkflowShot(workflowItems[selectedWorkflowIndex]);
    }
  }
  if (idx === 2) renderHistory();
});

/* ── Shot Review Modal ───────────────────────────────── */

const shotReviewModalEl  = document.getElementById('shot-review-modal');
const shotReviewTitleEl  = document.getElementById('shot-review-title');
const shotReviewGraphEl  = document.getElementById('shot-review-graph');
const shotReviewRecipeGridEl  = document.getElementById('shot-review-recipe-grid');
const shotReviewResultsGridEl = document.getElementById('shot-review-results-grid');
const shotReviewRatingEl    = document.getElementById('shot-review-rating');
const shotReviewRatingValEl = document.getElementById('shot-review-rating-val');
const shotReviewRatingMaxEl = document.getElementById('shot-review-rating-max');
const shotReviewFavBtn      = document.getElementById('btn-shot-review-fav');
const shotReviewNotesEl     = document.getElementById('shot-review-notes');
const shotReviewTagsEl      = document.getElementById('shot-review-tags');
const shotReviewTagPanelEl  = document.getElementById('shot-review-tag-panel');
const shotReviewTagInputEl  = document.getElementById('shot-review-tag-input');
const shotReviewTagListEl   = document.getElementById('shot-review-tag-list');

let _reviewShotId  = null;
let _reviewTags    = [];

function _getShotTags(s) {
  return Array.isArray(s.annotations?.extras?.tags) ? s.annotations.extras.tags
       : Array.isArray(s.metadata?.tags)            ? s.metadata.tags
       : [];
}

function _getAllUsedTags() {
  const set = new Set();
  for (const s of shots) _getShotTags(s).forEach(t => set.add(t));
  return [...set].sort();
}

function _renderReviewTags() {
  if (!shotReviewTagsEl) return;
  shotReviewTagsEl.innerHTML = _reviewTags.length
    ? _reviewTags.map(t => `<button type="button" class="shot-review-tag-chip is-selected" data-tag="${_escapeHtml(t)}">${_escapeHtml(t)}</button>`).join('')
    : '<span class="shot-review-tags-empty">Keine Tags</span>';
}

function _renderTagSuggestions(query) {
  if (!shotReviewTagListEl) return;
  const all = _getAllUsedTags();
  const q = query.toLowerCase();
  const filtered = all.filter(t => !_reviewTags.includes(t) && (!q || t.toLowerCase().includes(q)));
  shotReviewTagListEl.innerHTML = filtered.map(t =>
    `<button type="button" class="shot-review-tag-chip" data-tag="${_escapeHtml(t)}">${_escapeHtml(t)}</button>`
  ).join('');
}
let _reviewRating  = null;
let _reviewFav     = false;
let _reviewDraft   = null;
let _reviewAnalysisRows = [];

function _srTile(field, label, value, { editable = true, inputMode = 'text' } = {}) {
  const isEmpty = value === '' || value === null || value === undefined;
  const display = isEmpty
    ? `<span class="bean-manager-prop-empty">—</span>`
    : _escapeHtml(String(value));
  const inner = `<span class="bean-manager-prop-label">${_escapeHtml(label)}</span>`
              + `<span class="bean-manager-prop-value">${display}</span>`;
  if (!editable) {
    return `<div class="bean-manager-prop-tile bean-manager-prop-tile--static">${inner}</div>`;
  }
  return `<button type="button" class="bean-manager-prop-tile" data-sr-field="${field}" data-sr-value="${_escapeHtml(String(value ?? ''))}" data-sr-inputmode="${inputMode}">${inner}</button>`;
}

function _renderShotReviewFields() {
  const d = _reviewDraft;
  if (!d) return;
  if (shotReviewRecipeGridEl) {
    const sub = (html) => `<div class="shot-review-prop-subgrid">${html}</div>`;
    shotReviewRecipeGridEl.innerHTML =
      sub(
        _srTile('coffeeRoaster',    t('shotReview.roaster'),   d.coffeeRoaster) +
        _srTile('coffeeName',       t('shotReview.bean'),      d.coffeeName) +
        _srTile('roastDate',        t('shotReview.roastDate'), d.dispRoastDate, { editable: false }) +
        _srTile('actualDoseWeight', t('shotReview.dose'),      d.actualDoseWeight, { inputMode: 'numeric' })
      ) +
      sub(
        _srTile('grinderModel',   t('shotReview.grinder'),   d.grinderModel) +
        _srTile('grinderSetting', t('shotReview.grindSize'), d.grinderSetting)
      ) +
      sub(
        _srTile('profile',     t('shotReview.profile'),      d.dispProfile, { editable: false }) +
        _srTile('temperature', t('shotReview.temperature'),  d.dispTemp, { editable: false }) +
        _srTile('targetYield', t('shotReview.targetWeight'), d.targetYield, { inputMode: 'numeric' })
      );
  }
  if (shotReviewResultsGridEl) {
    // Yield label + ratio are computed at render time so the ratio tracks dose edits.
    let yieldDisp;
    if (d.outValue === undefined) {
      yieldDisp = '…';
    } else if (d.outValue === null) {
      yieldDisp = '—';
    } else {
      const outStr = `${d.outEstimated ? '~' : ''}${d.outEstimated ? Math.round(d.outValue) : d.outValue.toFixed(1)} ${d.outUnit}`;
      const dose = Number(d.actualDoseWeight);
      const ratio = Number.isFinite(dose) && dose > 0 ? ` (1:${(d.outValue / dose).toFixed(1)})` : '';
      yieldDisp = `${outStr}${ratio}`;
    }
    let html =
      _srTile('time',     t('shotReview.time'),  d.dispDuration, { editable: false }) +
      _srTile('yield',    t('shotReview.yield'), yieldDisp, { editable: false }) +
      _srTile('drinkTds', 'TDS %', d.drinkTds, { inputMode: 'numeric' }) +
      _srTile('drinkEy',  'EY %',  d.drinkEy,  { inputMode: 'numeric' });
    for (const r of _reviewAnalysisRows) {
      html += _srTile(null, r.label, r.value, { editable: false });
    }
    shotReviewResultsGridEl.innerHTML = html;
  }
}

function _setShotReviewFav(val) {
  _reviewFav = val;
  shotReviewFavBtn?.classList.toggle('is-fav', val);
}

function _setShotReviewRating(val) {
  const isNone = val == null;
  _reviewRating = isNone ? null : val;
  const fill = isNone ? 0 : val;
  if (shotReviewRatingValEl) {
    shotReviewRatingValEl.textContent = isNone ? t('shotReview.noRating') : val;
    shotReviewRatingValEl.classList.toggle('is-none', isNone);
  }
  if (shotReviewRatingMaxEl) shotReviewRatingMaxEl.hidden = isNone;
  if (shotReviewRatingEl) {
    shotReviewRatingEl.value = fill;
    shotReviewRatingEl.style.setProperty('--fill', `${fill}%`);
  }
}

function openShotReview(shotId) {
  const shot = shots.find(s => s.id === shotId)
    ?? historyShots.find(s => s.id === shotId);
  if (!shot || !shotReviewModalEl) return;

  _reviewShotId = shotId;

  const ctx = shot.workflow?.context || {};
  const date = new Date(shot.timestamp);
  const dateStr = isNaN(date.getTime()) ? '—'
    : date.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  if (shotReviewTitleEl)  shotReviewTitleEl.textContent = dateStr;

  const ann = shot.annotations ?? {};
  // The review edits the actual shot's dose (annotations.actualDoseWeight), the same
  // field the date-picker meta shows; fall back to the recipe target if none recorded.
  const measuredDose = Number(ann.actualDoseWeight);
  const dose = Number.isFinite(measuredDose) && measuredDose > 0
    ? measuredDose
    : Number(ctx.targetDoseWeight || 0);
  const tds  = ann.drinkTds ?? ann.extras?.drinkTds ?? null;
  const ey   = ann.drinkEy  ?? ann.extras?.drinkEy  ?? null;
  const profile = shot.workflow?.profile;
  const profileTitle = profile?.title || ctx.profileTitle || '—';
  const temp = _resolveProfileTemp(profile);
  const targetYield = Number(ctx.targetYield || profile?.target_weight || 0);

  _reviewAnalysisRows = [];
  _reviewDraft = {
    coffeeRoaster:    ctx.coffeeRoaster || '',
    coffeeName:       ctx.coffeeName    || '',
    grinderModel:     ctx.grinderModel  || '',
    grinderSetting:   (ctx.grinderSetting ?? '') === '' ? '' : String(ctx.grinderSetting),
    actualDoseWeight: dose > 0 ? dose : null,
    targetYield:      targetYield > 0 ? targetYield : null,
    drinkTds:         tds != null ? Number(tds) : null,
    drinkEy:          ey  != null ? Number(ey)  : null,
    dispRoastDate:    ctx.beanBatchId ? '…' : '—',
    dispProfile:      profileTitle,
    dispTemp:         temp ? `${temp.toFixed(1)} °C` : '—',
    dispDuration:     '…',
    outValue:         undefined, // undefined = loading, null = no data, number = actual out
    outUnit:          'g',
    outEstimated:     false,
  };
  _renderShotReviewFields();

  const initRating = ann.enjoyment ?? shot.metadata?.rating ?? null;
  const initFav    = ann.extras?.favorite ?? shot.metadata?.favorite === true;
  _reviewTags = [..._getShotTags(shot)];
  _setShotReviewRating(initRating);
  _setShotReviewFav(initFav);
  if (shotReviewNotesEl) shotReviewNotesEl.value = ann.espressoNotes ?? shot.metadata?.notes ?? '';
  _renderReviewTags();

  const workflowTagsGroupEl = document.getElementById('shot-review-workflow-tags-group');
  const workflowTagsEl      = document.getElementById('shot-review-workflow-tags');
  const workflowTags = ctx.extras?.tags;
  if (workflowTagsGroupEl && workflowTagsEl) {
    if (Array.isArray(workflowTags) && workflowTags.length) {
      workflowTagsEl.innerHTML = workflowTags
        .map(tag => `<span class="shot-review-workflow-tag">${_escapeHtml(tag)}</span>`)
        .join('');
      workflowTagsGroupEl.hidden = false;
    } else {
      workflowTagsGroupEl.hidden = true;
    }
  }
  if (shotReviewTagPanelEl) shotReviewTagPanelEl.hidden = true;

  if (shotReviewGraphEl) shotReviewGraphEl.innerHTML = '';
  shotReviewModalEl.hidden = false;

  if (ctx.beanBatchId) {
    fetchBatch(ctx.beanBatchId)
      .then(batch => {
        if (_reviewShotId !== shotId || !_reviewDraft) return;
        const rd = batch?.roastDate;
        if (rd) {
          const d = new Date(rd);
          const dateStr = isNaN(d.getTime()) ? rd
            : d.toLocaleDateString(getLang?.() === 'en' ? 'en-US' : 'de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
          _reviewDraft.dispRoastDate = `${dateStr} · ${formatBatchAge(rd)}`;
        } else {
          _reviewDraft.dispRoastDate = '—';
        }
        _renderShotReviewFields();
      })
      .catch(() => {
        if (_reviewShotId !== shotId || !_reviewDraft) return;
        _reviewDraft.dispRoastDate = '—';
        _renderShotReviewFields();
      });
  }

  getShotDetailsCached(shotId)
    .then(fullShot => {
      if (_reviewShotId !== shotId || !_reviewDraft) return;
      const secs = getShotDurationSeconds(fullShot);
      _reviewDraft.dispDuration = Number.isFinite(secs) ? `${secs.toFixed(0)} s` : '—';

      let actualOut = null;
      let outUnit = 'g';
      let isEstimatedOut = false;
      const annYield = Number(fullShot?.annotations?.actualYield ?? fullShot?.annotations?.extras?.actualYield ?? ann?.extras?.actualYield);
      if (Number.isFinite(annYield) && annYield > 0) {
        actualOut = annYield;
      } else {
        const snapVol = Number(fullShot?.snapshot?.volume);
        if (Number.isFinite(snapVol) && snapVol > 0) {
          actualOut = snapVol; outUnit = 'ml';
        } else {
          const meas = fullShot?.measurements;
          if (Array.isArray(meas)) {
            for (let i = meas.length - 1; i >= 0; i--) {
              const w = meas[i]?.scale?.weight ?? meas[i]?.scale?.weight_grams ?? null;
              if (Number.isFinite(w) && w > 0) { actualOut = w; break; }
            }
          }
        }
        const annExtras = fullShot?.annotations?.extras ?? ann.extras ?? {};
        if (actualOut === null && annExtras.virtualScale === true) {
          const estYield = annExtras.actualYield ?? null;
          if (estYield != null) { actualOut = estYield; isEstimatedOut = true; }
        }
      }
      _reviewDraft.outValue     = actualOut; // number or null
      _reviewDraft.outUnit      = outUnit;
      _reviewDraft.outEstimated = isEstimatedOut;

      _reviewAnalysisRows = window.NSXUI?.renderShotAnalysis(normalizeShotData(fullShot)) || [];
      _renderShotReviewFields();

      if (shotReviewGraphEl) {
        requestAnimationFrame(() => {
          renderShotGraph?.(shotReviewGraphEl, fullShot, null, undefined, null, null, normalizeShotData, 'history');
        });
      }
    })
    .catch(() => {
      if (_reviewShotId !== shotId || !_reviewDraft) return;
      _reviewDraft.dispDuration = '—';
      const estYield = ann.extras?.virtualScale === true ? (ann.extras?.actualYield ?? null) : null;
      _reviewDraft.outValue     = estYield != null ? estYield : null;
      _reviewDraft.outUnit      = 'g';
      _reviewDraft.outEstimated = estYield != null;
      _renderShotReviewFields();
    });
}

function closeShotReview() {
  if (shotReviewModalEl) shotReviewModalEl.hidden = true;
  _reviewShotId = null;
}

shotReviewRatingEl?.addEventListener('input', () => {
  const v = Number(shotReviewRatingEl.value);
  _setShotReviewRating(v === 0 ? null : v);
});

shotReviewFavBtn?.addEventListener('click', () => {
  _setShotReviewFav(!_reviewFav);
});

// Tap-to-edit shot-review tiles (recipe + results), like the bean manager.
[shotReviewRecipeGridEl, shotReviewResultsGridEl].forEach(gridEl => {
  gridEl?.addEventListener('pointerdown', (e) => {
    const tile = e.target.closest('.bean-manager-prop-tile[data-sr-field]');
    if (!tile || !_reviewDraft) return;
    e.preventDefault();
    const field     = tile.dataset.srField;
    const inputMode = tile.dataset.srInputmode || 'text';
    const current   = tile.dataset.srValue || '';
    openFieldPicker(null, [], {
      inputMode,
      initialValue: current,
      onConfirm: (val) => {
        const trimmed = (val ?? '').trim();
        if (inputMode === 'numeric') {
          const n = parseFloat(trimmed);
          _reviewDraft[field] = Number.isFinite(n) ? n : null;
        } else {
          _reviewDraft[field] = trimmed;
        }
        _renderShotReviewFields();
      },
    });
  });
});

document.getElementById('btn-shot-review-close')?.addEventListener('click', closeShotReview);

document.getElementById('btn-shot-review-tag-add')?.addEventListener('click', () => {
  if (!shotReviewTagPanelEl) return;
  const opening = shotReviewTagPanelEl.hidden;
  shotReviewTagPanelEl.hidden = !opening;
  if (opening) {
    if (shotReviewTagInputEl) shotReviewTagInputEl.value = '';
    _renderTagSuggestions('');
    shotReviewTagInputEl?.focus();
  }
});

shotReviewTagInputEl?.addEventListener('input', () => {
  _renderTagSuggestions(shotReviewTagInputEl.value);
});

shotReviewTagInputEl?.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const val = shotReviewTagInputEl.value.trim();
  if (val && !_reviewTags.includes(val)) {
    _reviewTags.push(val);
    _renderReviewTags();
  }
  shotReviewTagInputEl.value = '';
  _renderTagSuggestions('');
});

shotReviewTagListEl?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-tag]');
  if (!btn) return;
  const tag = btn.dataset.tag;
  if (!_reviewTags.includes(tag)) {
    _reviewTags.push(tag);
    _renderReviewTags();
    _renderTagSuggestions(shotReviewTagInputEl?.value ?? '');
  }
});

shotReviewTagsEl?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-tag]');
  if (!btn) return;
  const tag = btn.dataset.tag;
  _reviewTags = _reviewTags.filter(t => t !== tag);
  _renderReviewTags();
  if (shotReviewTagPanelEl && !shotReviewTagPanelEl.hidden) {
    _renderTagSuggestions(shotReviewTagInputEl?.value ?? '');
  }
});

document.getElementById('btn-shot-review-save')?.addEventListener('click', async () => {
  if (!_reviewShotId) return;
  const id = _reviewShotId;
  const notes = shotReviewNotesEl?.value ?? '';
  const d = _reviewDraft ?? {};
  const ctxPatch = {
    coffeeRoaster:    d.coffeeRoaster?.trim()   || null,
    coffeeName:       d.coffeeName?.trim()      || null,
    grinderModel:     d.grinderModel?.trim()    || null,
    grinderSetting:   d.grinderSetting?.trim()  || null,
    targetYield:      d.targetYield ?? null,
  };
  const doseVal = d.actualDoseWeight;
  // Build full merged workflow so a top-level partial PUT doesn't drop the profile
  const cachedShot = shotDetailsCache.get(id);
  const mergedWorkflow = cachedShot
    ? { ...(cachedShot.workflow || {}), context: { ...(cachedShot.workflow?.context || {}), ...ctxPatch } }
    : null;
  closeShotReview();
  try {
    const tags = [..._reviewTags];
    const extras = { favorite: _reviewFav ?? false, tags };
    const tdsVal = d.drinkTds;
    const eyVal  = d.drinkEy;
    const patch = {
      annotations: {
        enjoyment: _reviewRating,
        espressoNotes: notes ?? null,
        actualDoseWeight: Number.isFinite(doseVal) ? doseVal : null,
        drinkTds: Number.isFinite(tdsVal) ? tdsVal : null,
        drinkEy:  Number.isFinite(eyVal)  ? eyVal  : null,
        extras,
      },
      ...(mergedWorkflow ? { workflow: mergedWorkflow } : {}),
    };
    await updateShotRecord(id, patch);
    const shot = shots.find(s => s.id === id);
    if (shot) {
      shot.annotations = {
        ...(shot.annotations || {}),
        enjoyment: _reviewRating,
        espressoNotes: notes,
        actualDoseWeight: Number.isFinite(doseVal) ? doseVal : (shot.annotations?.actualDoseWeight ?? null),
        drinkTds: Number.isFinite(tdsVal) ? tdsVal : (shot.annotations?.drinkTds ?? null),
        drinkEy:  Number.isFinite(eyVal)  ? eyVal  : (shot.annotations?.drinkEy  ?? null),
        extras: { ...(shot.annotations?.extras || {}), favorite: _reviewFav, tags },
      };
      if (shot.workflow?.context) Object.assign(shot.workflow.context, ctxPatch);
    }
    shotDetailsCache.delete(id);
    _recipeRatingCache.clear();
    renderHistory();
    showToast(t('toast.shotSaved'));
  } catch {
    showToast(t('toast.saveFailed'));
  }
});

document.getElementById('history-accordion-list')?.addEventListener('click', e => {
  if (e.target.closest('.history-shot-delete-btn')) return;
  const row = e.target.closest('.history-shot-row');
  if (row?.dataset.shotId) openShotReview(row.dataset.shotId);
});

/* ── History Shortcut Button ────────────────────────── */

document.getElementById('btn-workflow-history-shortcut')?.addEventListener('click', () => {
  const currentWorkflow = workflowItems[selectedWorkflowIndex];
  if (!currentWorkflow) return;
  const matching = findShotsForWorkflow(currentWorkflow);
  if (!matching?.length) return;
  // Open the shot currently shown by the date picker (shot-nav index), not the latest.
  const graphEl = document.getElementById('workflow-shot-graph');
  const navIdx = Number(graphEl?._shotNav?.index);
  const idx = Number.isInteger(navIdx) ? Math.max(0, Math.min(navIdx, matching.length - 1)) : 0;
  const shot = matching[idx] || matching[0];
  if (shot?.id) openShotReview(shot.id);
});

/* ── Workflow Edit Modal ──────────────────────────────── */

const workflowEditModalEl = document.getElementById('workflow-edit-modal');

let _editDose = 0;
let _editYield = 0;
let _editGrind = 16;
let _editSteamTemp = 135;
let _editSteamDur = 60;
let _editHwTemp = 80;
let _editHwVol = 150;
let _editGroupTemp = 93;
let _editPickedRoaster = '';
let _editPickedBeanName = '';
let _editPickedBeanOrigin = '';
let _editPickedBeanVariety = '';
let _editPickedBeanProcess = '';
let _editPickedBatchId = null;
let _editPickedBatchRoastDate = null;
let _editPickedGrinderId = null;
let _editPickedGrinderModel = '';
let _editTags = [];
let _editUseVolumeStop = false;
let _editBeanAgeRequestId = 0;
let _originalIdentity = null;
let _grindersCache = [];
let _editSelectedProfileId = null;
let _editSelectedProfileObj = null;
let _profileRecordsCache = null;
let _profileRecordsCacheAll = null;
let _deletedProfilesCache = null;
let _profilePickerSelectedRecord = null;
let _profilePickerContext = 'editor'; // 'editor' | 'home'
let _profileFavorites = new Set();
let _collapsedProfileGroups = new Set();
let _profilePickerMode = 'my'; // 'my' | 'trash' | 'hidden' | 'copy'
let _profilePickerShowHidden = false;

function _normalizeCollapsedProfileGroups(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((group) => String(group || '').trim())
    .filter(Boolean))];
}

function _restoreCollapsedProfileGroups(value) {
  _collapsedProfileGroups = new Set(_normalizeCollapsedProfileGroups(value));
}

function _persistCollapsedProfileGroups() {
  patchStoreSettings({
    nsx_profile_picker_collapsed_groups: [..._collapsedProfileGroups],
  });
}

function _expandProfileGroup(group) {
  const normalized = String(group || '').trim();
  if (!normalized) return;
  if (_collapsedProfileGroups.delete(normalized)) {
    _persistCollapsedProfileGroups();
  }
}

function _toggleProfileGroup(group) {
  const normalized = String(group || '').trim();
  if (!normalized) return;
  if (_collapsedProfileGroups.has(normalized)) {
    _collapsedProfileGroups.delete(normalized);
  } else {
    _collapsedProfileGroups.add(normalized);
  }
  _persistCollapsedProfileGroups();
}

async function _loadProfileFavorites() {
  if (!getStoreValue) return;
  try {
    const saved = await getStoreValue('NSX', 'profile-favorites');
    const ids = Array.isArray(saved) ? saved : (Array.isArray(saved?.value) ? saved.value : []);
    _profileFavorites = new Set(ids.map(String));
  } catch {
    _profileFavorites = new Set();
  }
}

async function _saveProfileFavorites() {
  if (!setStoreValue) return;
  try {
    await setStoreValue('NSX', 'profile-favorites', [..._profileFavorites]);
  } catch {
    // store API may not be available
  }
}

const profilePickerModalEl = document.getElementById('profile-picker-modal');
const profilePickerListEl = document.getElementById('profile-picker-list');
const profilePickerPreviewEl = document.getElementById('profile-picker-preview');
const profilePickerSearchEl = document.getElementById('profile-picker-search');
const profilePickerSourceEl = document.getElementById('profile-picker-source');
const profilePickerModeIndicatorEl = document.getElementById('profile-picker-mode-indicator');
const profilePickerAddMenuEl = document.getElementById('profile-picker-add-menu');
const profileInfoModalEl = document.getElementById('profile-info-modal');
const profileInfoBodyEl = document.getElementById('profile-info-body');

function _isUserOwnedProfile(record) {
  if (record?.isDefault) return false;
  const src = String(record?.metadata?.source || '').trim().toLowerCase();
  return !src || src === 'user';
}

function _isPresetProfile(record) {
  return !(_isUserOwnedProfile(record));
}

function _profilePresetCategory(record) {
  const title = String(record?.profile?.title || '');
  const { group } = _profileGroupOf(title);
  if (group) return group;
  if (record?.isDefault) return 'Built-in';
  const src = String(record?.metadata?.source || '').trim();
  if (src) return src.charAt(0).toUpperCase() + src.slice(1);
  return t('profileEditor.morePresets');
}

function _peditorDefaultFrame(name) {
  name = name ?? t('profileEditor.defaultPhaseName');
  return {
    name,
    temperature: 93,
    sensor: 'coffee',
    pump: 'pressure',
    transition: 'fast',
    pressure: 6,
    flow: 2,
    seconds: 10,
    volume: 0,
    exit_if: false,
    exit_type: 'pressure_over',
    exit_pressure_over: 0,
    exit_pressure_under: 0,
    exit_flow_over: 0,
    exit_flow_under: 0,
    exit_weight: 0,
    max_flow_or_pressure: 0,
    max_flow_or_pressure_range: 0.6,
  };
}

function _openNewProfileFromScratch() {
  const draft = {
    title: t('profileEditor.defaultTitle'),
    author: '',
    notes: '',
    beverage_type: 'espresso',
    stop_at_type: 'weight',
    target_weight: 36,
    target_volume: 0,
    steps: [_peditorDefaultFrame()],
  };
  if (profilePickerModalEl) profilePickerModalEl.hidden = true;
  if (profileInfoModalEl) profileInfoModalEl.hidden = true;
  openProfileEditorModal({ id: null, profile: draft, metadata: { source: 'user' }, isDefault: false });
}

function _openProfileFromPresetCopy(record) {
  if (!record?.profile) {
    showToast(t('toast.presetNotLoaded'));
    return;
  }
  const copied = _peditorClone(record.profile) || {};
  const baseTitle = String(copied.title || 'Preset').trim() || 'Preset';
  copied.title = `${baseTitle} ${t('profileEditor.copySuffix')}`;
  copied.author = '';
  if (!Array.isArray(copied.steps) && !Array.isArray(copied.frames)) {
    copied.steps = [_peditorDefaultFrame()];
  }
  if (profilePickerModalEl) profilePickerModalEl.hidden = true;
  if (profileInfoModalEl) profileInfoModalEl.hidden = true;
  openProfileEditorModal({ id: null, profile: copied, metadata: { source: 'user' }, isDefault: false });
}

function _updateProfilePickerToolbar() {
  const isMy = _profilePickerMode === 'my';
  const useBtn          = document.getElementById('btn-profile-picker-use');
  const trashBtn        = document.getElementById('btn-profile-picker-open-trash');
  const emptyTrashBtn   = document.getElementById('btn-profile-picker-empty-trash');
  const addBtn          = document.getElementById('btn-profile-picker-open-add');
  const toggleHiddenBtn = document.getElementById('btn-profile-picker-toggle-hidden');
  const backBtn         = document.getElementById('btn-profile-picker-back-my');
  if (useBtn)           useBtn.hidden = (_profilePickerContext === 'home') || !isMy;
  if (trashBtn)         trashBtn.hidden = !isMy || _profilePickerContext === 'recipe';
  if (emptyTrashBtn)    emptyTrashBtn.hidden = _profilePickerMode !== 'trash';
  if (addBtn)           addBtn.hidden = !isMy || _profilePickerContext === 'recipe';
  if (toggleHiddenBtn) {
    toggleHiddenBtn.hidden = !isMy;
    toggleHiddenBtn.setAttribute('aria-pressed', String(_profilePickerShowHidden));
    toggleHiddenBtn.innerHTML = _profilePickerShowHidden
      ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`
      : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
  }
  if (backBtn)          backBtn.hidden = isMy;
}

function _setProfilePickerMode(mode) {
  _profilePickerMode = mode === 'trash' ? 'trash' : mode === 'hidden' ? 'hidden' : mode === 'copy' ? 'copy' : 'my';
  if (profilePickerSearchEl) {
    profilePickerSearchEl.placeholder = _profilePickerMode === 'trash'
      ? t('profileEditor.searchTrash')
      : t('profileEditor.search');
  }
  _updateProfilePickerToolbar();
  _profilePickerSelectedRecord = null;
  _renderProfilePickerList();
  if (!_profilePickerSelectedRecord) _renderProfilePreview(null);
  if (_profilePickerMode === 'trash') {
    _ensureDeletedProfilesLoaded().then(() => _renderProfilePickerList());
  }
  if (_profilePickerMode === 'hidden' || _profilePickerMode === 'copy') {
    _ensureProfilesWithHiddenLoaded().then(() => _renderProfilePickerList());
  }
}

function _escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function _extractFrames(profile) {
  const frames = profile?.steps ?? profile?.frames ?? [];
  return Array.isArray(frames) ? frames : [];
}

function _profileSourceBadge(record) {
  if (record?.isDefault) return 'D';
  const src = record?.metadata?.source;
  if (src === 'visualizer' || src === 'downloaded') return 'V';
  return 'U';
}

function _profileEditorGroupTemp(profile) {
  const directTemp = Number(profile?.groupTemp);
  if (Number.isFinite(directTemp) && directTemp > 0) return directTemp;

  const firstFrameTemp = _extractFrames(profile)
    .map((frame) => Number(frame?.temperature))
    .find((temperature) => Number.isFinite(temperature) && temperature > 0);

  return Number.isFinite(firstFrameTemp) ? firstFrameTemp : null;
}

function _matchesProfileSource(record, source) {
  if (source === 'all') return true;
  if (source === 'favorites') return _profileFavorites.has(String(record?.id || ''));
  if (source === 'builtin') return record?.isDefault === true;
  if (source === 'downloaded') {
    const src = record?.metadata?.source;
    return src === 'visualizer' || src === 'downloaded';
  }
  if (source === 'user') return _isUserOwnedProfile(record);
  return true;
}

function _matchesProfileSearch(record, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  const title = String(record?.profile?.title || '').toLowerCase();
  const author = String(record?.profile?.author || '').toLowerCase();
  return title.includes(q) || author.includes(q);
}

function _normalizeProfileRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.profile && typeof raw.profile === 'object') return raw;
  const profile = raw.steps || raw.frames || raw.title ? raw : null;
  if (!profile) return null;
  return {
    id: raw.id || null,
    profile,
    metadata: raw.metadata || null,
    isDefault: raw.isDefault === true,
  };
}

async function _ensureProfilesLoaded(force = false) {
  if (!fetchProfiles) return [];
  if (_profileRecordsCache?.length && !force) return _profileRecordsCache;
  const data = await fetchProfiles();
  const list = Array.isArray(data) ? data : (data?.items ?? data?.records ?? []);
  const records = list
    .map(_normalizeProfileRecord)
    .filter(Boolean)
    .filter(r => r.profile);
  // Never cache an empty result: the gateway can transiently return no profiles
  // (e.g. just after wake while it re-initializes). Caching [] would persist a
  // broken state — every recipe push would then send a frameless profile.
  if (records.length) _profileRecordsCache = records;
  return records;
}

async function _ensureProfilesWithHiddenLoaded(force = false) {
  if (_profileRecordsCacheAll?.length && !force) return _profileRecordsCacheAll;
  const data = await fetchProfilesIncludingHidden();
  const list = Array.isArray(data) ? data : (data?.items ?? data?.records ?? []);
  const records = list.map(_normalizeProfileRecord).filter(Boolean).filter(r => r.profile);
  if (records.length) _profileRecordsCacheAll = records;
  return records;
}

async function _ensureDeletedProfilesLoaded(force = false) {
  if (!fetchDeletedProfiles) return [];
  if (_deletedProfilesCache && !force) return _deletedProfilesCache;
  const data = await fetchDeletedProfiles();
  const list = Array.isArray(data) ? data : (data?.items ?? data?.records ?? []);
  _deletedProfilesCache = list
    .map(_normalizeProfileRecord)
    .filter(Boolean)
    .filter(r => r.profile);
  return _deletedProfilesCache;
}

function _profileMetrics(profile) {
  const frames = _extractFrames(profile);
  let duration = 0;
  const temperatures = [];
  for (const f of frames) {
    duration += Number(f?.seconds || 0);
    const t = Number(f?.temperature);
    if (Number.isFinite(t) && t > 0) temperatures.push(t);
  }

  let stopAt = t('profileEditor.noStopGoal');
  if (Number(profile?.target_weight) > 0) stopAt = t('profileEditor.stopAtWeight').replace('{weight}', Number(profile.target_weight).toFixed(0));
  else if (Number(profile?.target_volume) > 0) stopAt = t('profileEditor.stopAtVolume').replace('{volume}', Number(profile.target_volume).toFixed(0));

  let tempText = 'N/A';
  if (temperatures.length) {
    const min = Math.min(...temperatures);
    const max = Math.max(...temperatures);
    tempText = Math.abs(min - max) < 0.05 ? `${min.toFixed(1)}°C` : `${min.toFixed(1)}-${max.toFixed(1)}°C`;
  }

  return {
    frameCount: frames.length,
    duration,
    stopAt,
    temperature: tempText,
  };
}

function _profileSparkSvg(profile, { showXTicks = true, showYTicks = true, showStageLabels = true, legendFontSize = 10, centerLegend = false, lineStrokeWidth = 2.2, compactMargins = false, showLegend = true, selectedFrameIdx = -1, tickFontSize = 11 } = {}) {
  const frames = _extractFrames(profile);
  if (!frames.length) {
    return `<div class="profile-picker-placeholder">Keine Profildaten</div>`;
  }

  const isLight = document.documentElement.dataset.theme?.startsWith('light');
  const clr = {
    bg:           isLight ? '#ffffff'                  : 'rgba(0,0,0,0.22)',
    grid:         isLight ? 'rgba(0,0,0,0.12)'        : 'rgba(255,255,255,0.10)',
    plotFill:     isLight ? 'rgba(0,0,0,0.02)'        : 'rgba(255,255,255,0.02)',
    plotStroke:   isLight ? 'rgba(0,0,0,0.12)'        : 'rgba(255,255,255,0.10)',
    tickText:     isLight ? 'rgba(60,60,67,0.60)'     : 'rgba(235,235,245,0.55)',
    xTickText:    isLight ? 'rgba(60,60,67,0.70)'     : 'rgba(235,235,245,0.65)',
    xTickLine:    isLight ? 'rgba(0,0,0,0.18)'        : 'rgba(255,255,255,0.18)',
    legendText:   isLight ? 'rgba(0,0,0,0.75)'        : 'rgba(235,235,245,0.82)',
    stageBandOdd: isLight ? 'rgba(0,0,0,0.03)'        : 'rgba(255,255,255,0.035)',
    stageBandEven:isLight ? 'rgba(0,0,0,0.015)'       : 'rgba(255,255,255,0.02)',
    stageLabel:   isLight ? 'rgba(0,0,0,0.80)'        : 'rgba(235,235,245,0.85)',
    stageSep:     isLight ? 'rgba(0,0,0,0.10)'        : 'rgba(255,255,255,0.11)',
  };

  const width = 680;
  const height = 274;
  const plotLeft = compactMargins ? 10 : 44;
  const plotRight = compactMargins ? 10 : 50;
  const plotTop = compactMargins ? 10 : 78;
  const plotBottom = compactMargins ? 8 : 26;
  const plotW = width - plotLeft - plotRight;
  const plotH = height - plotTop - plotBottom;
  const tempBandH = Math.floor(plotH / 3);
  const pfBandH = plotH - tempBandH;
  const pfBandTop = plotTop + tempBandH;

  const pressureValues = frames.map(f => Number(f?.pressure)).filter(Number.isFinite);
  const flowValues = frames.map(f => Number(f?.flow)).filter(Number.isFinite);
  const tempValues = frames.map(f => Number(f?.temperature)).filter(Number.isFinite);

  const maxPressureRaw = pressureValues.length ? Math.max(...pressureValues, 0) : 0;
  const maxFlowRaw = flowValues.length ? Math.max(...flowValues, 0) : 0;
  const minTempRaw = tempValues.length ? Math.min(...tempValues) : 88;
  const maxTempRaw = tempValues.length ? Math.max(...tempValues) : 94;

  const pressureMax = Math.max(8, Math.ceil((maxPressureRaw + 1) / 2.5) * 4);

  const tempMin = Math.max(70, Math.floor(minTempRaw - 1));
  const tempMaxCandidate = Math.min(105, Math.ceil(maxTempRaw + 1));
  const tempMax = Math.max(tempMin + 6, tempMaxCandidate);

  let totalT = 0;
  for (const f of frames) totalT += Math.max(0.1, Number(f?.seconds || 0));
  totalT = Math.max(totalT, 1);

  let stageT = 0;
  const stageSegments = frames.map((f, idx) => {
    const seg = Math.max(0.1, Number(f?.seconds || 0));
    const x0 = plotLeft + (stageT / totalT) * plotW;
    const x1 = plotLeft + ((stageT + seg) / totalT) * plotW;
    stageT += seg;
    return {
      x0,
      x1,
      label: String(f?.name || `Step ${idx + 1}`),
      odd: idx % 2 === 1,
      isLast: idx === frames.length - 1,
    };
  });

  const toStepPoints = (valueGetter, yMap) => {
    let t = 0;
    const pts = [];
    for (const f of frames) {
      const seg = Math.max(0.1, Number(f?.seconds || 0));
      const x0 = plotLeft + (t / totalT) * plotW;
      const x1 = plotLeft + ((t + seg) / totalT) * plotW;
      const v = valueGetter(f);
      const y = yMap(v);
      pts.push(`${x0.toFixed(2)},${y.toFixed(2)}`);
      pts.push(`${x1.toFixed(2)},${y.toFixed(2)}`);
      t += seg;
    }
    return pts.join(' ');
  };

  const yPressure = (value) => {
    const v = Number.isFinite(value) ? Math.max(0, Math.min(pressureMax, value)) : 0;
    return pfBandTop + (1 - v / pressureMax) * pfBandH;
  };
  const yFlow = (value) => {
    const v = Number.isFinite(value) ? Math.max(0, Math.min(pressureMax, value)) : 0;
    return pfBandTop + (1 - v / pressureMax) * pfBandH;
  };
  const yTemp = (value) => {
    const v = Number.isFinite(value) ? Math.max(tempMin, Math.min(tempMax, value)) : tempMin;
    return plotTop + 3 + (1 - (v - tempMin) / (tempMax - tempMin)) * (tempBandH - 6);
  };

  const pressurePts = toStepPoints((f) => Number(f?.pressure), yPressure);
  const flowPts = toStepPoints((f) => Number(f?.flow), yFlow);
  const tempPts = toStepPoints((f) => Number(f?.temperature), yTemp);

  const gridLines = [];
  const leftTicks = [];
  for (let i = 0; i <= 3; i++) {
    const v = (pressureMax / 3) * i;
    const y = yPressure(v);
    gridLines.push(`<line x1="${plotLeft}" y1="${y.toFixed(2)}" x2="${(plotLeft + plotW).toFixed(2)}" y2="${y.toFixed(2)}" stroke="${clr.grid}" stroke-width="1"></line>`);
    leftTicks.push(`<text x="${(plotLeft - 8).toFixed(2)}" y="${(y + 3).toFixed(2)}" text-anchor="end" fill="${clr.tickText}" font-size="${tickFontSize}">${v.toFixed(0)}</text>`);
  }

  const rightTicks = [];
  const tempTickVals = [tempMin, (tempMin + tempMax) / 2, tempMax];
  for (const v of tempTickVals) {
    const y = yTemp(v);
    rightTicks.push(`<text x="${(plotLeft + plotW + 8).toFixed(2)}" y="${(y + 3).toFixed(2)}" text-anchor="start" fill="${clr.tickText}" font-size="${tickFontSize}">${v.toFixed(0)}</text>`);
  }

  const xAxisLine = `<line x1="${plotLeft}" y1="${plotTop + plotH}" x2="${(plotLeft + plotW).toFixed(2)}" y2="${plotTop + plotH}" stroke="${clr.xTickLine}" stroke-width="1.5"></line>`;
  const xAxisY = plotTop + plotH;
  const xTickLabels = [];
  const xTickCount = Math.min(10, Math.max(6, Math.round(totalT / 4) + 1));
  for (let i = 0; i < xTickCount; i++) {
    const ratio = xTickCount <= 1 ? 0 : (i / (xTickCount - 1));
    const t = totalT * ratio;
    const x = plotLeft + ratio * plotW;
    const lbl = totalT < 30 ? t.toFixed(1).replace(/\.0$/, '') : t.toFixed(0);
    xTickLabels.push(`<text x="${x.toFixed(2)}" y="${(xAxisY + 16).toFixed(2)}" text-anchor="middle" fill="${clr.xTickText}" font-size="${tickFontSize}">${lbl}s</text>`);
  }

  const stageBands = [];
  const stageLabels = [];
  const stageSeparators = [];
  const labelStripTop = Math.min(28, plotTop - 2);
  const labelStripH   = Math.max(0, plotTop - labelStripTop - 2);
  for (let idx = 0; idx < stageSegments.length; idx++) {
    const seg = stageSegments[idx];
    const w = Math.max(0, seg.x1 - seg.x0);
    if (labelStripH > 0) stageBands.push(`<rect x="${seg.x0.toFixed(2)}" y="${labelStripTop}" width="${w.toFixed(2)}" height="${labelStripH}" fill="${seg.odd ? clr.stageBandOdd : clr.stageBandEven}"></rect>`);
    const cx = seg.x0 + w / 2;
    const isEdge = idx === 0 || idx === stageSegments.length - 1;
    const shouldShowLabel = w >= 20 || (isEdge && w >= 10);
    if (shouldShowLabel) {
      const maxLen = w < 28 ? 6 : w < 38 ? 10 : 18;
      const safeLabel = _escapeHtml(seg.label.length > maxLen ? `${seg.label.slice(0, maxLen)}...` : seg.label);
      const labelY = labelStripTop + (idx % 2 === 0 ? 16 : 36);
      stageLabels.push(`<text x="${cx.toFixed(2)}" y="${labelY}" text-anchor="middle" fill="${clr.stageLabel}" font-size="${tickFontSize}">${safeLabel}</text>`);
    }
    if (!seg.isLast) {
      stageSeparators.push(`<line x1="${seg.x1.toFixed(2)}" y1="${labelStripTop}" x2="${seg.x1.toFixed(2)}" y2="${(plotTop + plotH).toFixed(2)}" stroke="${clr.stageSep}" stroke-width="1"></line>`);
    }
  }


  const sparkFramesData = _escapeHtml(JSON.stringify(frames.map(f => ({
    p:  Number(f?.pressure)    || 0,
    fl: Number(f?.flow)        || 0,
    t:  Number(f?.temperature) || 0,
    s:  Math.max(0.1, Number(f?.seconds || 0)),
  }))));

  const legendY = 16;
  const charW = legendFontSize * 0.62;
  const lineLen = 14;
  const lineGap = 4;
  const legGap = 20;
  const leg1W = lineLen + lineGap + Math.ceil('Pressure (bar)'.length * charW);
  const leg2W = lineLen + lineGap + Math.ceil('Flow (ml/s)'.length * charW);
  const leg3W = lineLen + lineGap + Math.ceil('Temp (°C)'.length * charW);
  const legendTotalW = leg1W + legGap + leg2W + legGap + leg3W;
  const legendStartX = centerLegend ? Math.round(plotLeft + plotW / 2 - legendTotalW / 2) : 18;
  const l2x = legendStartX + leg1W + legGap;
  const l3x = l2x + leg2W + legGap;

  return `
    <div class="profile-spark-wrap">
      <svg class="profile-spark" viewBox="0 0 ${width} ${height}" width="100%" preserveAspectRatio="${compactMargins ? 'none' : 'xMidYMid meet'}"
           data-frames="${sparkFramesData}"
           data-plot-left="${plotLeft}" data-plot-w="${plotW}" data-total-t="${totalT.toFixed(3)}"
           data-pf-band-top="${pfBandTop.toFixed(2)}" data-plot-top="${plotTop}" data-plot-h="${plotH}"
           aria-hidden="true">
        <rect x="0" y="0" width="${width}" height="${height}" rx="12" ry="12" fill="${clr.bg}"></rect>
        ${showLegend ? `
        <line x1="${legendStartX}" y1="${legendY}" x2="${legendStartX + lineLen}" y2="${legendY}" stroke="#17c29a" stroke-width="2.2"></line>
        <text x="${legendStartX + lineLen + lineGap}" y="${legendY + 3}" fill="${clr.legendText}" font-size="${legendFontSize}" class="pspark-lbl" data-key="pressure" data-label="Pressure (bar)">Pressure (bar)</text>
        <line x1="${l2x}" y1="${legendY}" x2="${l2x + lineLen}" y2="${legendY}" stroke="#7aaaff" stroke-width="2.2"></line>
        <text x="${l2x + lineLen + lineGap}" y="${legendY + 3}" fill="${clr.legendText}" font-size="${legendFontSize}" class="pspark-lbl" data-key="flow" data-label="Flow (ml/s)">Flow (ml/s)</text>
        <line x1="${l3x}" y1="${legendY}" x2="${l3x + lineLen}" y2="${legendY}" stroke="#ff7a84" stroke-width="2.2"></line>
        <text x="${l3x + lineLen + lineGap}" y="${legendY + 3}" fill="${clr.legendText}" font-size="${legendFontSize}" class="pspark-lbl" data-key="temp" data-label="Temp (°C)">Temp (°C)</text>
        ` : ''}

        ${stageBands.join('')}
        ${stageSeparators.join('')}
        ${showStageLabels ? stageLabels.join('') : ''}
        ${selectedFrameIdx >= 0 && stageSegments[selectedFrameIdx] ? (() => {
          const s = stageSegments[selectedFrameIdx];
          return `<rect x="${s.x0.toFixed(2)}" y="${plotTop}" width="${(s.x1 - s.x0).toFixed(2)}" height="${plotH}" fill="rgba(10,132,255,0.18)" rx="2"></rect>`;
        })() : ''}

        <rect x="${plotLeft}" y="${plotTop}" width="${plotW}" height="${plotH}" fill="${clr.plotFill}" stroke="${clr.plotStroke}" stroke-width="1"></rect>
        <line x1="${plotLeft}" y1="${pfBandTop.toFixed(2)}" x2="${(plotLeft + plotW).toFixed(2)}" y2="${pfBandTop.toFixed(2)}" stroke="${clr.stageSep}" stroke-width="1" stroke-dasharray="4,3"></line>
        ${gridLines.join('')}
        ${showYTicks ? leftTicks.join('') : ''}
        ${showYTicks ? rightTicks.join('') : ''}
        ${showXTicks ? xAxisLine : ''}

        <polyline points="${pressurePts}" fill="none" stroke="#17c29a" stroke-width="${lineStrokeWidth}" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"></polyline>
        <polyline points="${flowPts}" fill="none" stroke="#7aaaff" stroke-width="${lineStrokeWidth}" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"></polyline>
        <polyline points="${tempPts}" fill="none" stroke="#ff7a84" stroke-width="${lineStrokeWidth}" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"></polyline>
        ${showXTicks ? xTickLabels.join('') : ''}

        <line class="pspark-cursor" x1="${plotLeft}" y1="${plotTop}" x2="${plotLeft}" y2="${(plotTop + plotH).toFixed(2)}" stroke="${clr.xTickLine}" stroke-width="1.5" stroke-dasharray="4,3" visibility="hidden"></line>
      </svg>
    </div>`;
}

function _setupProfileSparkInteraction(containerEl) {
  const svgEl = containerEl?.querySelector('.profile-spark');
  if (!svgEl) return;

  let frames;
  try { frames = JSON.parse(svgEl.dataset.frames || '[]'); } catch { return; }
  const plotLeft  = Number(svgEl.dataset.plotLeft);
  const plotW     = Number(svgEl.dataset.plotW);
  const totalT    = Number(svgEl.dataset.totalT);
  const viewBoxW  = 680;

  const lblEls = {};
  svgEl.querySelectorAll('.pspark-lbl').forEach(el => { lblEls[el.dataset.key] = el; });
  const cursorEl = svgEl.querySelector('.pspark-cursor');

  function frameAtClientX(clientX) {
    const rect = svgEl.getBoundingClientRect();
    if (!rect.width) return null;
    const svgX = (clientX - rect.left) * (viewBoxW / rect.width);
    const ratio = (svgX - plotLeft) / plotW;
    if (ratio < 0 || ratio > 1) return null;
    const tAtX = ratio * totalT;
    let t = 0;
    for (const f of frames) {
      if (t + f.s >= tAtX) return { f, svgX };
      t += f.s;
    }
    return frames.length ? { f: frames[frames.length - 1], svgX } : null;
  }

  function showAt(clientX) {
    const hit = frameAtClientX(clientX);
    if (!hit) { reset(); return; }
    const { f, svgX } = hit;
    if (lblEls.pressure) lblEls.pressure.textContent = `${f.p.toFixed(1)} bar`;
    if (lblEls.flow)     lblEls.flow.textContent     = `${f.fl.toFixed(1)} ml/s`;
    if (lblEls.temp)     lblEls.temp.textContent     = `${f.t.toFixed(1)} °C`;
    if (cursorEl) {
      cursorEl.setAttribute('x1', svgX.toFixed(1));
      cursorEl.setAttribute('x2', svgX.toFixed(1));
      cursorEl.setAttribute('visibility', 'visible');
    }
  }

  function reset() {
    svgEl.querySelectorAll('.pspark-lbl').forEach(el => { el.textContent = el.dataset.label; });
    if (cursorEl) cursorEl.setAttribute('visibility', 'hidden');
  }

  svgEl.addEventListener('pointermove', e => showAt(e.clientX));
  svgEl.addEventListener('pointerleave', reset);
  svgEl.addEventListener('touchstart', e => showAt(e.touches[0].clientX), { passive: true });
  svgEl.addEventListener('touchmove',  e => showAt(e.touches[0].clientX), { passive: true });
  svgEl.addEventListener('touchend',   reset, { passive: true });
}

function _findRecordById(id) {
  return (_profileRecordsCache || []).find(r => String(r.id) === String(id));
}

function _profileLooksActive(record) {
  if (!record) return false;
  if (_editSelectedProfileId && record.id && String(record.id) === String(_editSelectedProfileId)) return true;
  const current = _editSelectedProfileObj;
  if (!current) return false;
  const a = String(current.title || '').trim();
  const b = String(record.profile?.title || '').trim();
  const aa = String(current.author || '').trim();
  const bb = String(record.profile?.author || '').trim();
  return a && b && a === b && aa === bb;
}

function _applyProfileToEditor(record) {
  if (!record?.profile) return;
  _editSelectedProfileId = record.id ?? null;
  _editSelectedProfileObj = JSON.parse(JSON.stringify(record.profile));
  const groupTemp = _profileEditorGroupTemp(record.profile);
  const targetWeight = Number(record.profile?.target_weight);

  if (Number.isFinite(groupTemp) && groupTemp > 0) {
    _setEditGroupTemp(groupTemp);
    _editSelectedProfileObj.groupTemp = groupTemp;
  }
  if (Number.isFinite(targetWeight) && targetWeight > 0) {
    _setEditYield(targetWeight);
  }

  const input = document.getElementById('edit-profile');
  if (input) input.value = record.profile.title || '';
  _syncProfileDisplay();
  _updateEditDirtyState();
}

function _renderProfilePreview(record) {
  if (!profilePickerPreviewEl) return;
  if (!record?.profile) {
    profilePickerPreviewEl.innerHTML = _profilePickerMode === 'preset'
      ? `<div class="profile-picker-placeholder">${t('profilePicker.presetHint')}</div>`
      : `<div class="profile-picker-placeholder">${t('profilePicker.placeholder')}</div>`;
    return;
  }

  const profile = record.profile;
  const metrics = _profileMetrics(profile);
  const recordId = _escapeHtml(record?.id || '');
  const isTrash = _profilePickerMode === 'trash';
  const isHiddenMode = _profilePickerMode === 'hidden';
  const isCopyMode = _profilePickerMode === 'copy';
  const isDefault = record?.isDefault === true;
  const deleteBtn = `<button type="button" id="btn-profile-preview-delete" class="profile-preview-btn profile-preview-btn-danger" style="width: 44px; padding: 0; display: flex; align-items: center; justify-content: center;" aria-label="${isTrash ? t('profilePicker.permDeleteAria') : t('profilePicker.deleteAria')}" data-profile-id="${recordId}">🗑</button>`;
  const isHidden = record.visibility === 'hidden';
  const eyeHideBtn = `<button type="button" id="btn-profile-preview-toggle-visibility" class="profile-preview-btn profile-preview-btn-secondary" style="width:44px;padding:0;display:flex;align-items:center;justify-content:center;" aria-label="${isHidden ? t('profilePicker.showAria') : t('profilePicker.hideAria')}" data-profile-id="${recordId}" data-hidden="${isHidden}">${isHidden
    ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>'
    : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>'
  }</button>`;
  const useBtn = _profilePickerContext !== 'home' ? `<button type="button" id="btn-profile-preview-use" class="profile-preview-btn profile-preview-btn-primary">${t('profilePicker.use2')}</button>` : '';
  const editBtn = `<button type="button" id="btn-profile-preview-edit" class="profile-preview-btn profile-preview-btn-secondary">${t('profilePicker.edit')}</button>`;
  const detailsBtn = `<button type="button" id="btn-profile-preview-details" class="profile-preview-btn profile-preview-btn-secondary">${t('profilePicker.details')}</button>`;
  const copyEditBtn = `<button type="button" id="btn-profile-preview-copy" class="profile-preview-btn profile-preview-btn-primary">${t('profilePicker.copyEdit')}</button>`;
  const actions = isTrash
    ? `${detailsBtn}<button type="button" id="btn-profile-preview-restore" class="profile-preview-btn profile-preview-btn-primary" data-profile-id="${recordId}">${t('profilePicker.restore')}</button>`
    : isCopyMode
      ? `${detailsBtn}${copyEditBtn}`
      : isHiddenMode
        ? `${detailsBtn}${eyeHideBtn}`
        : isDefault
          ? `${useBtn}${detailsBtn}${_profilePickerContext !== 'recipe' ? editBtn : ''}${_profilePickerContext !== 'recipe' ? eyeHideBtn : ''}`
          : `${useBtn}${detailsBtn}${_profilePickerContext !== 'recipe' ? editBtn : ''}${_profilePickerContext !== 'recipe' ? eyeHideBtn : ''}${_profilePickerContext !== 'recipe' ? deleteBtn : ''}`;
  profilePickerPreviewEl.innerHTML = `
    <div class="profile-preview-card">
      <div class="profile-preview-header">
        <div class="profile-preview-header-text">
          <div class="profile-preview-title">${_escapeHtml(profile.title || 'Untitled')}</div>
          <div class="profile-preview-sub">${profile.author ? `${t('profilePicker.by')} ${_escapeHtml(profile.author)}` : t('profilePicker.noAuthor')}</div>
        </div>
        <div class="profile-preview-actions">${actions}</div>
      </div>
      ${_profileSparkSvg(profile, { showXTicks: false, showYTicks: false, showStageLabels: false, legendFontSize: 13, centerLegend: true })}
      ${profile.notes ? `<div class="profile-preview-notes">${_escapeHtml(profile.notes)}</div>` : ''}
    </div>`;
  _setupProfileSparkInteraction(profilePickerPreviewEl);

  document.getElementById('btn-profile-preview-use')?.addEventListener('click', () => {
    _applyProfileToEditor(record);
    if (profilePickerModalEl) profilePickerModalEl.hidden = true;
  });
  document.getElementById('btn-profile-preview-copy')?.addEventListener('click', () => {
    _openProfileFromPresetCopy(record);
  });
  document.getElementById('btn-profile-preview-details')?.addEventListener('click', () => {
    _openProfileInfoModal(record, _profilePickerContext === 'recipe');
  });
  // Returns the id of the profile that should be selected after removing removedId from list.
  // Picks the profile at the same sorted position, or the last if it was at the end.
  function _pickNextId(list, removedId) {
    const sorted = [...(list || [])].sort((a, b) =>
      String(a.profile?.title || '').localeCompare(String(b.profile?.title || ''), 'de'));
    const idx = sorted.findIndex(r => String(r.id) === String(removedId));
    const remaining = sorted.filter((_, i) => i !== idx);
    if (!remaining.length) return null;
    return String(remaining[Math.min(idx >= 0 ? idx : 0, remaining.length - 1)].id);
  }

  function _applyNextSelection(newList, nextId) {
    _profilePickerSelectedRecord =
      (nextId ? (newList.find(r => String(r.id) === nextId) ?? null) : null)
      ?? newList[0] ?? null;
    _renderProfilePickerList();
    _renderProfilePreview(_profilePickerSelectedRecord);
  }

  document.getElementById('btn-profile-preview-toggle-visibility')?.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-profile-id]');
    const profileId = btn?.getAttribute('data-profile-id');
    const currentlyHidden = btn?.getAttribute('data-hidden') === 'true';
    const newVisibility = currentlyHidden ? 'visible' : 'hidden';
    const srcList = currentlyHidden
      ? (Array.isArray(_profileRecordsCacheAll) ? _profileRecordsCacheAll : []).filter(r => r.visibility === 'hidden')
      : (Array.isArray(_profileRecordsCache) ? _profileRecordsCache : []);
    const nextId = _pickNextId(srcList, profileId);
    try {
      await setProfileVisibility(profileId, newVisibility);
      _profileRecordsCache = null;
      _profileRecordsCacheAll = null;
      await Promise.all([_ensureProfilesLoaded(true), _ensureProfilesWithHiddenLoaded()]);
      const newList = currentlyHidden
        ? (Array.isArray(_profileRecordsCacheAll) ? _profileRecordsCacheAll : []).filter(r => r.visibility === 'hidden')
        : (Array.isArray(_profileRecordsCache) ? _profileRecordsCache : []);
      _applyNextSelection(newList, nextId);
      showToast(currentlyHidden ? t('toast.presetVisible') : t('toast.presetHidden'));
    } catch (err) {
      showToast(t('toast.error') + ': ' + err.message);
    }
  });
  document.getElementById('btn-profile-preview-edit')?.addEventListener('click', () => {
    if (profilePickerModalEl) profilePickerModalEl.hidden = true;
    openProfileEditorModal(record);
  });
  document.getElementById('btn-profile-preview-restore')?.addEventListener('click', async (e) => {
    const profileId = e.target.closest('[data-profile-id]')?.getAttribute('data-profile-id') || recordId;
    const title = _profilePickerSelectedRecord?.profile?.title || t('profileEditor.unnamed');
    const nextId = _pickNextId(Array.isArray(_deletedProfilesCache) ? _deletedProfilesCache : [], profileId);
    try {
      await restoreProfile(profileId);
      _deletedProfilesCache = null;
      _profileRecordsCache = null;
      _profileRecordsCacheAll = null;
      showToast(t('toast.profileRestored').replace('{name}', title));
      await Promise.all([_ensureDeletedProfilesLoaded(), _ensureProfilesLoaded(true)]);
      _applyNextSelection(Array.isArray(_deletedProfilesCache) ? _deletedProfilesCache : [], nextId);
    } catch (err) {
      showToast(t('toast.error') + ': ' + err.message);
    }
  });
  document.getElementById('btn-profile-preview-delete')?.addEventListener('click', async (e) => {
    const profileId = e.target.closest('[data-profile-id]')?.getAttribute('data-profile-id');
    if (_profilePickerMode === 'trash') {
      const title = _profilePickerSelectedRecord?.profile?.title || t('profileEditor.unnamed');
      if (!await showConfirm(t('confirm.purgeProfile').replace('{name}', title), t('action.purge'))) return;
      const nextId = _pickNextId(Array.isArray(_deletedProfilesCache) ? _deletedProfilesCache : [], profileId);
      try {
        await purgeProfile(profileId);
        _deletedProfilesCache = null;
        showToast(t('toast.profilePurged').replace('{name}', title));
        await _ensureDeletedProfilesLoaded();
        _applyNextSelection(Array.isArray(_deletedProfilesCache) ? _deletedProfilesCache : [], nextId);
      } catch (err) {
        showToast(t('toast.deleteFailed') + ': ' + err.message);
      }
    } else {
      if (!await showConfirm(t('confirm.deleteProfile'))) return;
      const nextId = _pickNextId(Array.isArray(_profileRecordsCache) ? _profileRecordsCache : [], profileId);
      try {
        await deleteProfile(profileId);
        showToast(t('toast.profileDeleted'));
        _profileRecordsCache = null;
        _deletedProfilesCache = null;
        await _ensureProfilesLoaded();
        _applyNextSelection(Array.isArray(_profileRecordsCache) ? _profileRecordsCache : [], nextId);
      } catch (err) {
        showToast(t('toast.deleteFailed') + ': ' + err.message);
      }
    }
  });
}

function _profileGroupOf(title) {
  const sep = String(title || '').indexOf('/');
  if (sep > 0) return { group: title.slice(0, sep).trim(), name: title.slice(sep + 1).trim() };
  return { group: null, name: String(title || '') };
}

function _renderProfileItem(record, displayTitle, grouped) {
  const selected = _profilePickerSelectedRecord && String(_profilePickerSelectedRecord.id) === String(record.id);
  const active = _profileLooksActive(record);
  const id = _escapeHtml(record.id || '');
  const badge = _profileSourceBadge(record);
  const badgeClass = badge === 'D' ? 'profile-picker-badge-d' : badge === 'V' ? 'profile-picker-badge-v' : 'profile-picker-badge-u';
  return `
    <div class="profile-picker-item${selected ? ' is-selected' : ''}${active ? ' is-active' : ''}${grouped ? ' is-grouped' : ''}" data-profile-id="${id}" role="button" tabindex="0">
      <span class="profile-picker-item-meta">
        <span class="profile-picker-item-title">${_escapeHtml(displayTitle)}</span>
        <span class="profile-picker-item-sub">${_escapeHtml(record.profile?.author || '')}</span>
      </span>
      <span class="profile-picker-badge ${badgeClass}">${badge}</span>
    </div>`;
}

function _renderProfilePickerList() {
  if (!profilePickerListEl) return;
  const isTrash  = _profilePickerMode === 'trash';
  const isHidden = _profilePickerMode === 'hidden';
  const isCopy   = _profilePickerMode === 'copy';
  let list;
  if (isTrash) {
    list = Array.isArray(_deletedProfilesCache) ? _deletedProfilesCache : [];
  } else if (isHidden) {
    list = (Array.isArray(_profileRecordsCacheAll) ? _profileRecordsCacheAll : []).filter(r => r.visibility === 'hidden');
  } else if (isCopy) {
    list = Array.isArray(_profileRecordsCacheAll) ? _profileRecordsCacheAll : (Array.isArray(_profileRecordsCache) ? _profileRecordsCache : []);
  } else if (_profilePickerShowHidden) {
    list = Array.isArray(_profileRecordsCacheAll) ? _profileRecordsCacheAll : (Array.isArray(_profileRecordsCache) ? _profileRecordsCache : []);
  } else {
    list = Array.isArray(_profileRecordsCache) ? _profileRecordsCache : [];
  }
  const q = String(profilePickerSearchEl?.value || '').trim();
  const filtered = list.filter(r => _matchesProfileSearch(r, q));

  if (!filtered.length) {
    profilePickerListEl.innerHTML = `<div class="profile-picker-placeholder">${isTrash ? t('profileEditor.trashEmpty') : isHidden ? t('profileEditor.hiddenEmpty') : t('profileEditor.noProfiles')}</div>`;
    return;
  }

  const isMy = _profilePickerMode === 'my';
  const ordered = [...filtered].sort((a, b) => String(a.profile?.title || '').localeCompare(String(b.profile?.title || ''), 'de'));
  const autoSelected = !_profilePickerSelectedRecord && ordered.length > 0;
  if (autoSelected) _profilePickerSelectedRecord = ordered[0];

  // Group profiles by A/B title prefix (only when not searching)
  const html = [];
  if (isMy && !q) {
    const groups = new Map();
    const entries = []; // { sortKey, render }
    for (const r of ordered) {
      const { group, name } = _profileGroupOf(r.profile?.title || '');
      if (group) {
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push({ r, name });
      } else {
        entries.push({ sortKey: r.profile?.title || '', render: () => _renderProfileItem(r, r.profile?.title || '', false) });
      }
    }
    for (const [group, members] of groups) {
      const collapsed = _collapsedProfileGroups.has(group);
      entries.push({ sortKey: group, render: () => {
        const rows = [`<button type="button" class="profile-picker-group-header${collapsed ? ' is-collapsed' : ''}" data-group="${_escapeHtml(group)}">
          <svg class="profile-picker-group-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
          <span class="profile-picker-group-name">${_escapeHtml(group)}</span>
        </button>`];
        if (!collapsed) {
          for (const { r, name } of members) rows.push(_renderProfileItem(r, name, true));
        }
        return rows.join('');
      }});
    }
    entries.sort((a, b) => a.sortKey.localeCompare(b.sortKey, 'de'));
    for (const entry of entries) html.push(entry.render());
  } else {
    for (const r of ordered) {
      html.push(_renderProfileItem(r, r.profile?.title || '', false));
    }
  }

  profilePickerListEl.innerHTML = html.join('');
  if (autoSelected) _renderProfilePreview(ordered[0]);
}

function _renderProfileInfoBody(record, readOnly = false) {
  if (!profileInfoBodyEl) return;
  const profile = record?.profile;
  if (!profile) {
    profileInfoBodyEl.innerHTML = '<div class="profile-picker-placeholder">Profil nicht gefunden</div>';
    return;
  }
  const frames = _extractFrames(profile);
  const metrics = _profileMetrics(profile);
  const recordId = _escapeHtml(record?.id || '');
  profileInfoBodyEl.innerHTML = `
    ${_profileSparkSvg(profile)}
    <div class="profile-info-title">${_escapeHtml(profile.title || t('profileEditor.unnamed'))}</div>
    ${profile.author ? `<div class="profile-info-author">${t('profilePicker.by')} ${_escapeHtml(profile.author)}</div>` : ''}
    <div class="profile-info-cards">
      <div class="profile-info-card"><span class="profile-info-card-label">${t('profileEditor.stopGoal')}</span><span class="profile-info-card-value">${_escapeHtml(metrics.stopAt)}</span></div>
      <div class="profile-info-card"><span class="profile-info-card-label">${t('profileEditor.temperature')}</span><span class="profile-info-card-value">${_escapeHtml(metrics.temperature)}</span></div>
      <div class="profile-info-card"><span class="profile-info-card-label">${t('recipe.duration')}</span><span class="profile-info-card-value">${metrics.duration.toFixed(0)}s</span></div>
    </div>
    ${profile.notes ? `<div class="profile-info-notes">${_escapeHtml(profile.notes)}</div>` : ''}
    <div class="profile-steps">
      ${frames.map((frame, idx) => {
        const pump = frame?.pump === 'flow' ? t('profileEditor.flow') : t('profileEditor.pressure');
        const value = frame?.pump === 'flow'
          ? Number(frame?.flow || 0).toFixed(1) + ' ml/s'
          : Number(frame?.pressure || 0).toFixed(1) + ' bar';
        return `<div class="profile-step">
          <span class="profile-step-index">${idx + 1}</span>
          <div class="profile-step-main">
            <span class="profile-step-name">${_escapeHtml(frame?.name || `Step ${idx + 1}`)}</span>
            <span class="profile-step-detail">${pump} ${value} · ${Number(frame?.seconds || 0).toFixed(1)}s · ${Number(frame?.temperature || 0).toFixed(1)}°C</span>
          </div>
        </div>`;
      }).join('')}
    </div>`;
  _setupProfileSparkInteraction(profileInfoBodyEl);

  // Attach delete handler
  document.getElementById('btn-profile-info-delete')?.addEventListener('click', async (e) => {
    const profileId = e.target.getAttribute('data-profile-id');
    if (window.confirm(t('confirm.deleteProfile'))) {
      try {
        await deleteProfile(profileId);
        showToast(t('toast.profileDeleted'));
        _profileRecordsCache = null;
        if (profileInfoModalEl) profileInfoModalEl.hidden = true;
        if (profilePickerModalEl && !profilePickerModalEl.hidden) {
          await _ensureProfilesLoaded();
          _renderProfilePickerList();
        }
      } catch (err) {
        showToast(t('toast.deleteFailed') + ': ' + err.message);
      }
    }
  });
}

async function _openProfileInfoModal(record, readOnly = false) {
  if (!profileInfoModalEl) return;
  let resolved = record;
  if (!resolved?.profile && resolved?.id && fetchProfileById) {
    try {
      const one = await fetchProfileById(resolved.id);
      const normalized = _normalizeProfileRecord(one?.profile ? one : { ...one, id: resolved.id });
      if (normalized?.profile) resolved = normalized;
    } catch {
      // Keep fallback record.
    }
  }
  if (resolved?.profile) {
    _profilePickerSelectedRecord = resolved;
  }
  _renderProfileInfoBody(resolved, readOnly);
  if (!readOnly) {
    document.getElementById('btn-profile-info-edit-inline')?.addEventListener('click', () => {
      if (profileInfoModalEl) profileInfoModalEl.hidden = true;
      if (profilePickerModalEl) profilePickerModalEl.hidden = true;
      openProfileEditorModal(resolved);
    });
  }
  profileInfoModalEl.hidden = false;
}

/* ── Profile Editor ──────────────────────────────────────── */

let _peditorRecord  = null;
let _peditorFrames  = [];
let _peditorTitle   = '';
let _peditorAuthor  = '';
let _peditorNotes   = '';
let _peditorStopWeightValue   = 36;
let _peditorStopWeightEnabled = false;
let _peditorStopVolumeValue   = 0;
let _peditorStopVolumeEnabled = false;
let _peditorStopVolumeStartIndex = 0;
let _peditorGroupTemp = 93;
let _peditorTankTempEnabled = false;
let _peditorTankTempValue = 0;
let _peditorLimiterFlowRange = 0.6;
let _peditorLimiterPressureRange = 0.6;
let _peditorOriginalProfile = null;
let _peditorOriginalSnapshot = '';
let _peditorBeanieMode = true;
let _peditorSelectedFrameIdx = 0;

const profileEditorModalEl  = document.getElementById('profile-editor-modal');
const profileEditorFramesEl = document.getElementById('profile-editor-frames');
const profileEditorChartEl  = document.getElementById('profile-editor-chart');
const profileEditorDirtyBadgeEl = document.getElementById('profile-editor-dirty-badge');
const profileEditorStopConfigEl = document.getElementById('profile-editor-stop-config');

function _peditorClone(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

function _peditorFramesPayload() {
  return _peditorFrames.map((frame) => {
    const payload = {
      ..._peditorClone(frame._rest),
      name: frame.name,
      pump: frame.pump,
      flow: frame.flow,
      pressure: frame.pressure,
      seconds: frame.seconds,
      temperature: frame.temperature,
      transition: frame.transition,
      sensor: frame.sensor,
      limiter: { value: frame.limiterEnabled ? frame.limiterValue : 0, range: frame.pump === 'pressure' ? _peditorLimiterFlowRange : _peditorLimiterPressureRange },
      volume: frame.volumeEnabled ? frame.volumeValue : 0,
      weight: frame.weightEnabled ? frame.weightValue : 0,
      exit_if: frame.exitEnabled,
      exit_type: frame.exitType,
      exit_pressure_over: 0,
      exit_pressure_under: 0,
      exit_flow_over: 0,
      exit_flow_under: 0,
      exit_weight: 0,
    };

    if (frame.exitEnabled) {
      payload.exit = _peditorExitToObject(frame.exitType, frame.exitValue);
      switch (frame.exitType) {
        case 'pressure_under':
          payload.exit_pressure_under = frame.exitValue;
          break;
        case 'flow_over':
          payload.exit_flow_over = frame.exitValue;
          break;
        case 'flow_under':
          payload.exit_flow_under = frame.exitValue;
          break;
        case 'weight':
          payload.exit_weight = frame.exitValue;
          break;
        default:
          payload.exit_pressure_over = frame.exitValue;
          break;
      }
    }

    return payload;
  });
}

function _peditorSnapshot() {
  return JSON.stringify({
    title: _peditorTitle,
    author: _peditorAuthor,
    notes: _peditorNotes,
    stopWeightEnabled: _peditorStopWeightEnabled,
    stopWeightValue: _peditorStopWeightValue,
    stopVolumeEnabled: _peditorStopVolumeEnabled,
    stopVolumeValue: _peditorStopVolumeValue,
    stopVolumeStartIndex: _peditorStopVolumeStartIndex,
    frames: _peditorFramesPayload(),
  });
}

function _peditorHasExecutionChanges() {
  const execKeys = s => ({
    frames: s.frames,
    stopWeightEnabled: s.stopWeightEnabled,
    stopWeightValue: s.stopWeightValue,
    stopVolumeEnabled: s.stopVolumeEnabled,
    stopVolumeValue: s.stopVolumeValue,
    stopVolumeStartIndex: s.stopVolumeStartIndex,
  });
  const curr = execKeys(JSON.parse(_peditorSnapshot()));
  const orig = execKeys(JSON.parse(_peditorOriginalSnapshot || '{}'));
  return JSON.stringify(curr) !== JSON.stringify(orig);
}

function _peditorRefreshDirtyState() {
  const dirty = _peditorSnapshot() !== _peditorOriginalSnapshot;
  if (profileEditorDirtyBadgeEl) profileEditorDirtyBadgeEl.hidden = !dirty;
  return dirty;
}

function _peditorRenderStopControls() {
  const stopWeightEl = document.getElementById('profile-editor-stop-weight-enabled');
  const stopVolumeEl = document.getElementById('profile-editor-stop-volume-enabled');
  const stopWeightValEl = document.getElementById('profile-editor-stop-weight-val');
  const stopVolumeValEl = document.getElementById('profile-editor-stop-volume-val');
  const stopVolumeStartValEl = document.getElementById('profile-editor-stop-volume-start-val');
  const stopWeightStepperEl = document.getElementById('profile-editor-stop-weight-stepper');
  const stopVolumeStepperEl = document.getElementById('profile-editor-stop-volume-stepper');
  const stopVolumeStartStepperEl = document.getElementById('profile-editor-stop-volume-start-stepper');
  const maxStageIndex = Math.max(0, (_peditorFrames.length || 1) - 1);
  _peditorStopVolumeStartIndex = Math.max(0, Math.min(_peditorStopVolumeStartIndex, maxStageIndex));

  if (profileEditorStopConfigEl) profileEditorStopConfigEl.hidden = false;
  if (stopWeightEl) stopWeightEl.checked = _peditorStopWeightEnabled;
  if (stopVolumeEl) stopVolumeEl.checked = _peditorStopVolumeEnabled;
  if (stopWeightValEl) stopWeightValEl.textContent = `${_peditorStopWeightValue}g`;
  if (stopVolumeValEl) stopVolumeValEl.textContent = `${_peditorStopVolumeValue}ml`;
  const _svPhaseName = _peditorFrames[_peditorStopVolumeStartIndex]?.name?.trim() || `Phase ${_peditorStopVolumeStartIndex + 1}`;
  if (stopVolumeStartValEl) stopVolumeStartValEl.textContent = `ab ${_svPhaseName}`;
  if (stopWeightStepperEl) stopWeightStepperEl.hidden = !_peditorStopWeightEnabled;
  if (stopVolumeStepperEl) stopVolumeStepperEl.hidden = false;
  if (stopVolumeStartStepperEl) stopVolumeStartStepperEl.hidden = !_peditorStopVolumeEnabled;

  const groupTempValEl = document.getElementById('peditor-group-temp-val');
  if (groupTempValEl) groupTempValEl.textContent = `${_peditorGroupTemp.toFixed(1)} °C`;

  const tankTempToggleEl  = document.getElementById('peditor-tank-temp-enabled');
  const tankTempValEl     = document.getElementById('peditor-tank-temp-val');
  const tankTempStepperEl = document.getElementById('peditor-tank-temp-stepper');
  if (tankTempToggleEl)  tankTempToggleEl.checked = _peditorTankTempEnabled;
  if (tankTempValEl)     tankTempValEl.textContent = `${_peditorTankTempValue}°C`;
  if (tankTempStepperEl) tankTempStepperEl.hidden = !_peditorTankTempEnabled;

  const limiterFlowRangeValEl     = document.getElementById('peditor-limiter-flow-range-val');
  const limiterPressureRangeValEl = document.getElementById('peditor-limiter-pressure-range-val');
  if (limiterFlowRangeValEl)     limiterFlowRangeValEl.textContent     = _peditorLimiterFlowRange.toFixed(2);
  if (limiterPressureRangeValEl) limiterPressureRangeValEl.textContent = _peditorLimiterPressureRange.toFixed(2);
}

function _peditorBuildProfile() {
  const base = _peditorClone(_peditorOriginalProfile) || {};
  const frames = _peditorFramesPayload();

  base.title        = _peditorTitle || t('profileEditor.unnamed');
  base.author       = _peditorAuthor.trim();
  base.notes        = _peditorNotes.trim();
  base.beverage_type        = String(base.beverage_type        || 'espresso');
  base.version              = String(base.version              || '2');
  base.lang                 = String(base.lang                 || 'en');
  base.type                 = String(base.type                 || 'advanced');
  base.legacy_profile_type  = String(base.legacy_profile_type  || 'settings_2c');
  base.reference_file       = String(base.reference_file       ?? '');
  delete base.profile_notes;

  base.target_weight = _peditorStopWeightEnabled ? _peditorStopWeightValue : 0;
  base.target_volume = _peditorStopVolumeEnabled ? _peditorStopVolumeValue : 0;
  base.target_volume_count_start = _peditorStopVolumeStartIndex;
  if (_peditorStopWeightEnabled) base.stop_at_type = 'weight';
  else if (_peditorStopVolumeEnabled) base.stop_at_type = 'volume';
  else base.stop_at_type = base.stop_at_type || 'weight';

  base.groupTemp = _peditorGroupTemp;
  base.tank_temperature = _peditorTankTempEnabled ? _peditorTankTempValue : 0;
  base.limiter_flow_range     = _peditorLimiterFlowRange;
  base.limiter_pressure_range = _peditorLimiterPressureRange;

  if (Array.isArray(_peditorOriginalProfile?.frames) || !Array.isArray(_peditorOriginalProfile?.steps)) {
    base.frames = _peditorClone(frames);
  }
  if (Array.isArray(_peditorOriginalProfile?.steps) || !Array.isArray(_peditorOriginalProfile?.frames)) {
    base.steps = _peditorClone(frames);
  }

  return base;
}

function _peditorBuildCreateFallback(profile) {
  const safe = _peditorClone(profile) || {};
  const orig = _peditorOriginalProfile || {};
  const origSteps = Array.isArray(orig.steps) ? orig.steps :
                    Array.isArray(orig.frames) ? orig.frames : [];
  const toNum = (v, d = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };

  function normalizeExit(frame) {
    const direct = frame?.exit;
    if (direct && typeof direct === 'object') {
      const t = String(direct.type || '').toLowerCase();
      const c = String(direct.condition || '').toLowerCase();
      const type = (t === 'flow' || t === 'weight') ? t : 'pressure';
      const condition = (c === 'under') ? 'under' : 'over';
      return { type, condition, value: toNum(direct.value, 0) };
    }

    const et = String(frame?.exit_type || '').toLowerCase();
    switch (et) {
      case 'pressure_under':
        return { type: 'pressure', condition: 'under', value: toNum(frame?.exit_pressure_under, 0) };
      case 'flow_over':
        return { type: 'flow', condition: 'over', value: toNum(frame?.exit_flow_over, 0) };
      case 'flow_under':
        return { type: 'flow', condition: 'under', value: toNum(frame?.exit_flow_under, 0) };
      case 'weight':
        return { type: 'weight', condition: 'over', value: toNum(frame?.exit_weight, 0) };
      default:
        return { type: 'pressure', condition: 'over', value: toNum(frame?.exit_pressure_over, 0) };
    }
  }

  const defaultStep = {
    name: t('profileEditor.defaultPhaseName'),
    pump: 'pressure',
    transition: 'fast',
    exit: null,
    volume: 0,
    seconds: 10,
    weight: 0,
    temperature: 93,
    sensor: 'coffee',
    pressure: 6,
    limiter: null,
  };

  const steps = _extractFrames(safe).map((f, idx) => {
    const frame = _peditorClone(f) || {};
    const origStep = origSteps[idx] || null;
    const exitEnabled = Boolean(frame.exit_if);
    const pump = frame.pump === 'flow' ? 'flow' : 'pressure';

    const step = {
      name: String(frame.name || `Phase ${idx + 1}`),
      pump,
      transition: frame.transition === 'smooth' ? 'smooth' : 'fast',
      exit: exitEnabled ? normalizeExit(frame) : null,
      volume: toNum(frame.volume, 0),
      seconds: Math.max(0, toNum(frame.seconds, 0)),
      weight: toNum(frame.weight, 0),
      temperature: toNum(frame.temperature, 93),
      sensor: String(frame.sensor || 'coffee'),
    };

    // Only include flow/pressure matching the original step's keys (or pump type for new steps)
    const origHasFlow = origStep === null || 'flow' in origStep;
    const origHasPressure = origStep === null || 'pressure' in origStep;
    if (origHasFlow || pump === 'flow') step.flow = Math.max(0, toNum(frame.flow, 0));
    if (origHasPressure || pump === 'pressure') step.pressure = Math.max(0, toNum(frame.pressure, 0));

    // Preserve limiter: null when original had null and no limiter is active
    const limiterValue = toNum(frame.limiter?.value, 0);
    const limiterRange = toNum(frame.limiter?.range, 0.6);
    if (limiterValue > 0) {
      step.limiter = { value: limiterValue, range: limiterRange };
    } else if (origStep !== null && 'limiter' in origStep) {
      step.limiter = origStep.limiter;
    } else {
      step.limiter = null;
    }

    return step;
  });

  // Build profile: clone original exactly, then override only user-editable fields.
  // This preserves non-editable fields (version, lang, type, etc.) in their original form.
  const profileResult = _peditorClone(orig) || {};

  profileResult.version  = String((Number(orig.version) || 1) + 1);
  profileResult.title    = String(safe.title || _peditorTitle || '').trim() || t('profileEditor.defaultTitle');
  profileResult.notes    = String(safe.notes ?? '');
  profileResult.author   = String(safe.author ?? '');
  profileResult.beverage_type = String(safe.beverage_type || 'espresso');
  profileResult.target_volume = toNum(safe.target_volume, 0);
  profileResult.target_weight = toNum(safe.target_weight, 0);
  profileResult.target_volume_count_start = Math.max(0, Math.trunc(toNum(safe.target_volume_count_start, 0)));
  profileResult.tank_temperature = toNum(safe.tank_temperature, 0);

  if (Array.isArray(orig.steps) || !Array.isArray(orig.frames)) {
    profileResult.steps = steps.length ? steps : [defaultStep];
  }
  if (Array.isArray(orig.frames)) {
    profileResult.frames = steps.length ? steps : [defaultStep];
  }

  return {
    profile: profileResult,
    parentId: null,
    metadata: { source: 'user' },
  };
}

function _peditorFormatVal(f) {
  return f.pump === 'flow' ? `${f.flow.toFixed(1)} ml/s` : `${f.pressure.toFixed(1)} bar`;
}

function _peditorExitSuffix(frame) {
  switch (frame?.exitType) {
    case 'flow_over':
    case 'flow_under':
      return 'ml/s';
    case 'weight':
      return 'g';
    default:
      return 'bar';
  }
}

function _peditorExitStep(frame) {
  return _peditorExitStepSize(frame, false);
}

function _peditorTargetStepSize(frame, coarse = false) {
  if (frame?.pump === 'flow') return coarse ? 0.5 : 0.1;
  return coarse ? 1 : 0.5;
}

function _peditorTemperatureStepSize(coarse = false) {
  return coarse ? 10 : 1;
}

function _peditorDurationStepSize(coarse = false) {
  return coarse ? 10 : 1;
}

function _peditorWeightStepSize(coarse = false) {
  return coarse ? 10 : 1;
}

function _peditorVolumeStepSize(coarse = false) {
  return coarse ? 10 : 1;
}

function _peditorPhaseIndexStepSize(coarse = false) {
  return coarse ? 5 : 1;
}

function _peditorExitStepSize(frame, coarse = false) {
  switch (frame?.exitType) {
    case 'weight':
      return coarse ? 10 : 1;
    case 'flow_over':
    case 'flow_under':
      return coarse ? 0.5 : 0.1;
    default:
      return coarse ? 1 : 0.5;
  }
}

function _peditorExitMin(frame) {
  return frame?.exitType === 'weight' ? 0 : 0;
}

function _peditorExitMax(frame) {
  switch (frame?.exitType) {
    case 'flow_over':
    case 'flow_under':
      return 15;
    case 'weight':
      return 500;
    default:
      return 14;
  }
}

function _peditorFormatExitVal(frame) {
  return `${Number(frame?.exitValue || 0).toFixed(1)} ${_peditorExitSuffix(frame)}`;
}

function _peditorFrameExitValue(raw) {
  switch (raw?.exit_type) {
    case 'pressure_under':
      return Math.max(0, Number(raw?.exit_pressure_under) || 0);
    case 'flow_over':
      return Math.max(0, Number(raw?.exit_flow_over) || 0);
    case 'flow_under':
      return Math.max(0, Number(raw?.exit_flow_under) || 0);
    case 'weight':
      return Math.max(0, Number(raw?.exit_weight) || 0);
    default:
      return Math.max(0, Number(raw?.exit_pressure_over) || 0);
  }
}

function _peditorExitFromObject(exit) {
  const type = String(exit?.type || '').toLowerCase();
  const condition = String(exit?.condition || '').toLowerCase();
  const value = Math.max(0, Number(exit?.value) || 0);

  if (type === 'flow') {
    return { type: condition === 'under' ? 'flow_under' : 'flow_over', value, enabled: true };
  }
  if (type === 'weight') {
    return { type: 'weight', value, enabled: true };
  }
  return { type: condition === 'under' ? 'pressure_under' : 'pressure_over', value, enabled: true };
}

function _peditorExitToObject(exitType, exitValue) {
  const value = Math.max(0, Number(exitValue) || 0);
  switch (exitType) {
    case 'pressure_under':
      return { type: 'pressure', condition: 'under', value };
    case 'flow_over':
      return { type: 'flow', condition: 'over', value };
    case 'flow_under':
      return { type: 'flow', condition: 'under', value };
    case 'weight':
      return { type: 'weight', condition: 'over', value };
    default:
      return { type: 'pressure', condition: 'over', value };
  }
}

function _peditorRenderChart() {
  if (profileEditorChartEl) {
    profileEditorChartEl.innerHTML = _profileSparkSvg(_peditorBuildProfile(), { tickFontSize: 14, legendFontSize: 14 });
    _setupProfileSparkInteraction(profileEditorChartEl);
  }

  const phasesEl   = document.getElementById('peditor-review-phases');
  const settingsEl = document.getElementById('peditor-review-settings');

  if (phasesEl) {
    const exitTypeLabel = et => {
      switch (et) {
        case 'pressure_under': return t('profileEditor.exitPressureUnder');
        case 'flow_over':      return t('profileEditor.exitFlowOver');
        case 'flow_under':     return t('profileEditor.exitFlowUnder');
        case 'weight':         return t('profileEditor.exitWeightOver');
        default:               return t('profileEditor.exitPressureOver');
      }
    };
    phasesEl.innerHTML = _peditorFrames.map((f, i) => {
      const bullets = [];
      bullets.push(t('profileEditor.reviewTemp').replace('{temp}', f.temperature.toFixed(1)));
      const modeLabel = f.pump === 'flow' ? t('profileEditor.flow') : t('profileEditor.pressure');
      const transLabel = f.transition === 'smooth' ? t('profileEditor.reviewSmoothTrans') : t('profileEditor.reviewFastTrans');
      bullets.push(`${modeLabel} ${_peditorFormatVal(f)} – ${transLabel}`);
      if (f.seconds > 0) bullets.push(t('profileEditor.reviewMaxSecs').replace('{secs}', f.seconds.toFixed(1)));
      if (f.exitEnabled) {
        bullets.push(`${t('profileEditor.reviewContinueWhen')} ${exitTypeLabel(f.exitType)} ${_peditorFormatExitVal(f)}`);
      }
      const name = f.name || t('profileEditor.phaseN').replace('{n}', i + 1);
      return `<div class="peditor-review-phase">
        <div class="peditor-review-phase-title">${i + 1}: ${_escapeHtml(name)}</div>
        <ul class="peditor-review-list">${bullets.map(b => `<li>${b}</li>`).join('')}</ul>
      </div>`;
    }).join('') || `<div class="bohnen-empty-state">${t('profileEditor.reviewNoPhases')}</div>`;
  }

  if (settingsEl) {
    const prof = _peditorOriginalProfile || {};
    const items = [];
    const tankTemp = Number(prof.tank_temperature);
    if (tankTemp > 0) items.push(t('profileEditor.reviewPreheat').replace('{temp}', `<span class="peditor-review-val">${tankTemp.toFixed(1)} °C</span>`));
    if (_peditorStopVolumeEnabled) {
      items.push(t('profileEditor.reviewTrackVolume').replace('{phase}', `<span class="peditor-review-val">${_peditorStopVolumeStartIndex + 1}</span>`));
    }
    if (_peditorStopWeightEnabled) items.push(t('profileEditor.reviewStopWeight').replace('{weight}', `<span class="peditor-review-val">${_peditorStopWeightValue}</span>`));
    if (_peditorStopVolumeEnabled) items.push(t('profileEditor.reviewStopVolume').replace('{volume}', `<span class="peditor-review-val">${_peditorStopVolumeValue}</span>`));
    settingsEl.innerHTML = items.length
      ? items.map(item => `<li>${item}</li>`).join('')
      : `<li style="color:var(--c-label-3)">${t('profileEditor.reviewNoSettings')}</li>`;
  }
}

function _peditorFrameFieldsHtml(f, idx) {
  return `
    <div class="peditor-frame-group-title">${t('profileEditor.temperature')}</div>
    <div class="bean-field-row">
      <span class="bean-field-label">${t('profileEditor.targetTemp')}</span>
      <div class="recipe-edit-stepper recipe-edit-stepper--double">
        <button type="button" class="recipe-edit-step-btn recipe-edit-step-btn--coarse" data-frame-idx="${idx}" data-frame-action="temp-down-big">«</button>
        <button type="button" class="recipe-edit-step-btn" data-frame-idx="${idx}" data-frame-action="temp-down">−</button>
        <span class="recipe-edit-step-val" data-frame-idx="${idx}" data-frame-display="temp">${f.temperature.toFixed(1)}°C</span>
        <button type="button" class="recipe-edit-step-btn" data-frame-idx="${idx}" data-frame-action="temp-up">+</button>
        <button type="button" class="recipe-edit-step-btn recipe-edit-step-btn--coarse" data-frame-idx="${idx}" data-frame-action="temp-up-big">»</button>
      </div>
    </div>
    <div class="bean-field-row">
      <span class="bean-field-label">${t('profileEditor.sensor')}</span>
      <div class="grinder-setting-type-toggle">
        <button type="button" class="grinder-toggle-btn${f.sensor === 'coffee' ? ' is-active' : ''}"
                data-frame-idx="${idx}" data-frame-action="sensor" data-mode="coffee">Coffee</button>
        <button type="button" class="grinder-toggle-btn${f.sensor === 'water' ? ' is-active' : ''}"
                data-frame-idx="${idx}" data-frame-action="sensor" data-mode="water">Water</button>
      </div>
    </div>
    <div class="peditor-frame-group-title">${t('profileEditor.goalSection')}</div>
    <div class="bean-field-row">
      <span class="bean-field-label">${t('profileEditor.pumpMode')}</span>
      <div class="grinder-setting-type-toggle">
        <button type="button" class="grinder-toggle-btn${f.pump === 'flow' ? ' is-active' : ''}"
                data-frame-idx="${idx}" data-frame-action="pump" data-mode="flow">Flow</button>
        <button type="button" class="grinder-toggle-btn${f.pump === 'pressure' ? ' is-active' : ''}"
                data-frame-idx="${idx}" data-frame-action="pump" data-mode="pressure">${t('profileEditor.pressure')}</button>
      </div>
    </div>
    <div class="bean-field-row">
      <span class="bean-field-label">${f.pump === 'flow' ? t('profileEditor.flow') : t('profileEditor.pressure')}</span>
      <div class="recipe-edit-stepper recipe-edit-stepper--double">
        <button type="button" class="recipe-edit-step-btn recipe-edit-step-btn--coarse" data-frame-idx="${idx}" data-frame-action="val-down-big">«</button>
        <button type="button" class="recipe-edit-step-btn" data-frame-idx="${idx}" data-frame-action="val-down">−</button>
        <span class="recipe-edit-step-val" data-frame-idx="${idx}" data-frame-display="val">${_peditorFormatVal(f)}</span>
        <button type="button" class="recipe-edit-step-btn" data-frame-idx="${idx}" data-frame-action="val-up">+</button>
        <button type="button" class="recipe-edit-step-btn recipe-edit-step-btn--coarse" data-frame-idx="${idx}" data-frame-action="val-up-big">»</button>
      </div>
    </div>
    <div class="bean-field-row">
      <span class="bean-field-label">${f.pump === 'pressure' ? t('profileEditor.flowLimit') : t('profileEditor.pressureLimit')}</span>
      <label class="power-toggle" aria-label="${t('profileEditor.limitAria')}">
        <input type="checkbox" class="power-toggle-input" ${f.limiterEnabled ? 'checked' : ''}
               data-frame-idx="${idx}" data-frame-action="limiter-toggle" role="switch" />
        <span class="power-toggle-track"><span class="power-toggle-thumb"></span></span>
      </label>
      <div class="recipe-edit-stepper" style="visibility:${f.limiterEnabled ? 'visible' : 'hidden'}">
        <button type="button" class="recipe-edit-step-btn" data-frame-idx="${idx}" data-frame-action="limiter-down">−</button>
        <span class="recipe-edit-step-val" data-frame-idx="${idx}" data-frame-display="limiter">${f.pump === 'pressure' ? f.limiterValue.toFixed(1) + ' ml/s' : f.limiterValue.toFixed(1) + ' bar'}</span>
        <button type="button" class="recipe-edit-step-btn" data-frame-idx="${idx}" data-frame-action="limiter-up">+</button>
      </div>
    </div>
    <div class="bean-field-row">
      <span class="bean-field-label">${t('profileEditor.transition')}</span>
      <div class="grinder-setting-type-toggle">
        <button type="button" class="grinder-toggle-btn${f.transition === 'fast' ? ' is-active' : ''}"
                data-frame-idx="${idx}" data-frame-action="transition" data-mode="fast">Fast</button>
        <button type="button" class="grinder-toggle-btn${f.transition === 'smooth' ? ' is-active' : ''}"
                data-frame-idx="${idx}" data-frame-action="transition" data-mode="smooth">Smooth</button>
      </div>
    </div>
    <div class="peditor-frame-group-title">${t('profileEditor.phaseEndsWhen')}</div>
    <div class="bean-field-row">
      <span class="bean-field-label">${t('profileEditor.time')}</span>
      <div class="recipe-edit-stepper recipe-edit-stepper--double">
        <button type="button" class="recipe-edit-step-btn recipe-edit-step-btn--coarse" data-frame-idx="${idx}" data-frame-action="dur-down-big">«</button>
        <button type="button" class="recipe-edit-step-btn" data-frame-idx="${idx}" data-frame-action="dur-down">−</button>
        <span class="recipe-edit-step-val" data-frame-idx="${idx}" data-frame-display="dur">${f.seconds.toFixed(1)} s</span>
        <button type="button" class="recipe-edit-step-btn" data-frame-idx="${idx}" data-frame-action="dur-up">+</button>
        <button type="button" class="recipe-edit-step-btn recipe-edit-step-btn--coarse" data-frame-idx="${idx}" data-frame-action="dur-up-big">»</button>
      </div>
    </div>
    <div class="bean-field-row">
      <span class="bean-field-label">${t('profileEditor.volume')}</span>
      <label class="power-toggle" aria-label="${t('profileEditor.volumeAria')}">
        <input type="checkbox" class="power-toggle-input" ${f.volumeEnabled ? 'checked' : ''}
               data-frame-idx="${idx}" data-frame-action="volume-toggle" role="switch" />
        <span class="power-toggle-track"><span class="power-toggle-thumb"></span></span>
      </label>
      <div class="recipe-edit-stepper recipe-edit-stepper--double" ${f.volumeEnabled ? '' : 'style="visibility:hidden"'}>
        <button type="button" class="recipe-edit-step-btn recipe-edit-step-btn--coarse" data-frame-idx="${idx}" data-frame-action="volume-down-big">«</button>
        <button type="button" class="recipe-edit-step-btn" data-frame-idx="${idx}" data-frame-action="volume-down">−</button>
        <span class="recipe-edit-step-val" data-frame-idx="${idx}" data-frame-display="volume">${f.volumeValue.toFixed(0)} ml</span>
        <button type="button" class="recipe-edit-step-btn" data-frame-idx="${idx}" data-frame-action="volume-up">+</button>
        <button type="button" class="recipe-edit-step-btn recipe-edit-step-btn--coarse" data-frame-idx="${idx}" data-frame-action="volume-up-big">»</button>
      </div>
    </div>
    <div class="bean-field-row">
      <span class="bean-field-label">${t('profileEditor.weight')}</span>
      <label class="power-toggle" aria-label="${t('profileEditor.weightStopAria')}">
        <input type="checkbox" class="power-toggle-input" ${f.weightEnabled ? 'checked' : ''}
               data-frame-idx="${idx}" data-frame-action="weight-toggle" role="switch" />
        <span class="power-toggle-track"><span class="power-toggle-thumb"></span></span>
      </label>
      <div class="recipe-edit-stepper recipe-edit-stepper--double" ${f.weightEnabled ? '' : 'style="visibility:hidden"'}>
        <button type="button" class="recipe-edit-step-btn recipe-edit-step-btn--coarse" data-frame-idx="${idx}" data-frame-action="weight-down-big">«</button>
        <button type="button" class="recipe-edit-step-btn" data-frame-idx="${idx}" data-frame-action="weight-down">−</button>
        <span class="recipe-edit-step-val" data-frame-idx="${idx}" data-frame-display="weight">${f.weightValue.toFixed(1)} g</span>
        <button type="button" class="recipe-edit-step-btn" data-frame-idx="${idx}" data-frame-action="weight-up">+</button>
        <button type="button" class="recipe-edit-step-btn recipe-edit-step-btn--coarse" data-frame-idx="${idx}" data-frame-action="weight-up-big">»</button>
      </div>
    </div>
    <div class="bean-field-row">
      <span class="bean-field-label">${t('profileEditor.earlyStop')}</span>
      <label class="power-toggle" aria-label="${t('profileEditor.earlyStopAria')}">
        <input type="checkbox" class="power-toggle-input" ${f.exitEnabled ? 'checked' : ''}
               data-frame-idx="${idx}" data-frame-action="exit-toggle" role="switch" />
        <span class="power-toggle-track"><span class="power-toggle-thumb"></span></span>
      </label>
    </div>
    <div class="bean-field-row" ${f.exitEnabled ? '' : 'style="visibility:hidden"'} data-frame-idx="${idx}" data-frame-exit-row="type">
      <span class="bean-field-label">${t('profileEditor.exitType')}</span>
      <select class="bean-field-input" data-frame-idx="${idx}" data-frame-action="exit-type">
        <option value="pressure_over" ${f.exitType === 'pressure_over' ? 'selected' : ''}>${t('profileEditor.exitPressureOver')}</option>
        <option value="pressure_under" ${f.exitType === 'pressure_under' ? 'selected' : ''}>${t('profileEditor.exitPressureUnder')}</option>
        <option value="flow_over" ${f.exitType === 'flow_over' ? 'selected' : ''}>${t('profileEditor.exitFlowOver')}</option>
        <option value="flow_under" ${f.exitType === 'flow_under' ? 'selected' : ''}>${t('profileEditor.exitFlowUnder')}</option>
        <option value="weight" ${f.exitType === 'weight' ? 'selected' : ''}>${t('profileEditor.exitWeightOver')}</option>
      </select>
    </div>
    <div class="bean-field-row" ${f.exitEnabled ? '' : 'style="visibility:hidden"'} data-frame-idx="${idx}" data-frame-exit-row="value">
      <span class="bean-field-label">${t('profileEditor.exitValue')}</span>
      <div class="recipe-edit-stepper recipe-edit-stepper--double">
        <button type="button" class="recipe-edit-step-btn recipe-edit-step-btn--coarse" data-frame-idx="${idx}" data-frame-action="exit-down-big">«</button>
        <button type="button" class="recipe-edit-step-btn" data-frame-idx="${idx}" data-frame-action="exit-down">−</button>
        <span class="recipe-edit-step-val" data-frame-idx="${idx}" data-frame-display="exit">${_peditorFormatExitVal(f)}</span>
        <button type="button" class="recipe-edit-step-btn" data-frame-idx="${idx}" data-frame-action="exit-up">+</button>
        <button type="button" class="recipe-edit-step-btn recipe-edit-step-btn--coarse" data-frame-idx="${idx}" data-frame-action="exit-up-big">»</button>
      </div>
    </div>`;
}

function _peditorFrameSummary(f) {
  const mode = f.pump === 'flow' ? 'flow' : 'pressure';
  return `${mode} ${_peditorFormatVal(f)} · ${f.temperature.toFixed(1)}°C · ${f.transition}`;
}

function _peditorFrameTilesHtml(f, idx) {
  const isFlow = f.pump === 'flow';

  const _ico   = (d) => `<svg class="peditor-tile-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const _icoLg = (d) => `<svg class="peditor-tile-icon peditor-tile-icon--lg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
  const icoTherm  = _ico(`<path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/>`);
  const icoCoffee = _ico(`<path d="M17 8h1a4 4 0 1 1 0 8h-1"/><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z"/><line x1="6" x2="6" y1="2" y2="4"/><line x1="10" x2="10" y1="2" y2="4"/><line x1="14" x2="14" y1="2" y2="4"/>`);
  const icoDrop   = _ico(`<path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"/>`);
  const icoGauge  = _ico(`<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>`);
  const icoArrow  = _ico(`<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>`);
  const icoClock  = _ico(`<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>`);
  const icoVol    = _ico(`<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/>`);
  const icoScale  = _ico(`<path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="M7 21h10"/><path d="M12 3v18"/><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"/>`);
  const icoPrUp   = _ico(`<path d="M12 5v14"/><path d="m5 12 7-7 7 7"/><path d="M3 19h18"/>`);
  const icoPrDn   = _ico(`<path d="M12 19V5"/><path d="m5 12 7 7 7-7"/><path d="M3 5h18"/>`);
  const icoFlUp   = _ico(`<path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"/><path d="m8 10 4-4 4 4"/>`);
  const icoFlDn   = _ico(`<path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"/><path d="m8 14 4 4 4-4"/>`);

  // NSX-style stepper (reuses existing CSS classes)
  const _stepper = (downBig, down, dispType, val, up, upBig) => `
    <div class="recipe-edit-stepper recipe-edit-stepper--double">
      <button type="button" class="recipe-edit-step-btn recipe-edit-step-btn--coarse" data-frame-idx="${idx}" data-frame-action="${downBig}">«</button>
      <button type="button" class="recipe-edit-step-btn" data-frame-idx="${idx}" data-frame-action="${down}">−</button>
      <span class="recipe-edit-step-val" data-frame-idx="${idx}" data-frame-display="${dispType}">${val}</span>
      <button type="button" class="recipe-edit-step-btn" data-frame-idx="${idx}" data-frame-action="${up}">+</button>
      <button type="button" class="recipe-edit-step-btn recipe-edit-step-btn--coarse" data-frame-idx="${idx}" data-frame-action="${upBig}">»</button>
    </div>`;

  const _stepperBtns = (downBig, down, up, upBig) => `
    <div class="recipe-edit-stepper recipe-edit-stepper--double">
      <button type="button" class="recipe-edit-step-btn recipe-edit-step-btn--coarse" data-frame-idx="${idx}" data-frame-action="${downBig}">«</button>
      <button type="button" class="recipe-edit-step-btn" data-frame-idx="${idx}" data-frame-action="${down}">−</button>
      <button type="button" class="recipe-edit-step-btn" data-frame-idx="${idx}" data-frame-action="${up}">+</button>
      <button type="button" class="recipe-edit-step-btn recipe-edit-step-btn--coarse" data-frame-idx="${idx}" data-frame-action="${upBig}">»</button>
    </div>`;

  const _stepperSm = (down, dispType, val, up) => `
    <div class="recipe-edit-stepper">
      <button type="button" class="recipe-edit-step-btn" data-frame-idx="${idx}" data-frame-action="${down}">−</button>
      <span class="recipe-edit-step-val" data-frame-idx="${idx}" data-frame-display="${dispType}">${val}</span>
      <button type="button" class="recipe-edit-step-btn" data-frame-idx="${idx}" data-frame-action="${up}">+</button>
    </div>`;

  // NSX-style segmented toggle (reuses existing CSS classes)
  const _toggle = (action, mode1, lbl1, mode2, lbl2, cur) => `
    <div class="grinder-setting-type-toggle">
      <button type="button" class="grinder-toggle-btn${cur === mode1 ? ' is-active' : ''}"
              data-frame-idx="${idx}" data-frame-action="${action}" data-mode="${mode1}">${lbl1}</button>
      <button type="button" class="grinder-toggle-btn${cur === mode2 ? ' is-active' : ''}"
              data-frame-idx="${idx}" data-frame-action="${action}" data-mode="${mode2}">${lbl2}</button>
    </div>`;

  // NSX-style power toggle (iOS switch)
  const _powerToggle = (action, checked) => `
    <label class="power-toggle">
      <input type="checkbox" class="power-toggle-input" ${checked ? 'checked' : ''}
             data-frame-idx="${idx}" data-frame-action="${action}" role="switch" />
      <span class="power-toggle-track"><span class="power-toggle-thumb"></span></span>
    </label>`;

  // Exit tile: active = highlighted green, inactive = dimmed
  const exitActive = (type) => f.exitEnabled && f.exitType === type;
  const _exitTile = (icon, label, type) => {
    const active = exitActive(type);
    const limiterVal = active ? _peditorFormatExitVal(f) : 'off';
    return `
    <div class="peditor-tile${active ? ' peditor-tile--active' : ''}">
      ${icon}
      <div class="peditor-tile-label">${label}</div>
      <div class="peditor-tile-value" data-frame-idx="${idx}" data-frame-display="${active ? 'exit' : ''}">${limiterVal}</div>
      <button type="button" class="peditor-tile-exit-toggle grinder-toggle-btn${active ? ' is-active' : ''}"
              data-frame-idx="${idx}" data-frame-action="exit-tile" data-exit-type="${type}">
        ${active ? 'on' : 'off'}
      </button>
      ${active ? _stepperSm('exit-down', 'exit', _peditorFormatExitVal(f), 'exit-up') : ''}
    </div>`;
  };

  const limiterVal = f.pump === 'pressure'
    ? f.limiterValue.toFixed(1) + ' ml/s'
    : f.limiterValue.toFixed(1) + ' bar';

  return `
  <div class="peditor-tiles">

    <div class="peditor-section">
      <div class="peditor-section-label">Targets</div>
      <div class="peditor-tile-grid">

        <div class="peditor-tile peditor-tile--full-stepper">
          <div class="peditor-tile-label">${f.sensor === 'water' ? 'Water' : 'Coffee'} Temperature</div>
          <div class="peditor-tile-temp-header">
            ${_icoLg(`<path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/>`)}
            ${_toggle('sensor', 'coffee', 'Coffee', 'water', 'Water', f.sensor)}
          </div>
          ${_stepper('temp-down-big', 'temp-down', 'temp', f.temperature.toFixed(1) + '°C', 'temp-up', 'temp-up-big')}
        </div>

        <div class="peditor-tile peditor-tile--wide peditor-tile--full-stepper">
          <div class="peditor-tile-label">Pump mode</div>
          <div class="peditor-tile-temp-header">
            ${_icoLg(isFlow
              ? `<path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"/>`
              : `<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>`
            )}
            ${_toggle('pump', 'flow', 'Flow', 'pressure', 'Pressure', f.pump)}
          </div>
          ${_stepper('val-down-big', 'val-down', 'val', _peditorFormatVal(f), 'val-up', 'val-up-big')}
        </div>

        <div class="peditor-tile peditor-tile--full-stepper">
          <div class="peditor-tile-label">${isFlow ? 'Pressure limit' : 'Flow limit'}</div>
          <div class="peditor-tile-temp-header">
            <span class="peditor-tile-toggle-spacer"></span>
            ${_icoLg(isFlow
              ? `<path d="m12 14 4-4"/><path d="M3.34 19a10 10 0 1 1 17.32 0"/>`
              : `<path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"/>`
            )}
            ${_powerToggle('limiter-toggle', f.limiterEnabled)}
          </div>
          <div class="peditor-tile-stepper-wrap">
            <div style="${f.limiterEnabled ? '' : 'visibility:hidden'}">
              ${_stepper('limiter-down-big', 'limiter-down', 'limiter', limiterVal, 'limiter-up', 'limiter-up-big')}
            </div>
            ${f.limiterEnabled ? '' : '<div class="peditor-tile-none-label">None</div>'}
          </div>
        </div>

      </div>
    </div>

    <div class="peditor-section">
      <div class="peditor-section-label">Stop after</div>
      <div class="peditor-tile-grid">

        <div class="peditor-tile peditor-tile--full-stepper">
          <div class="peditor-tile-label">Time</div>
          ${_icoLg(`<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>`)}
          ${_stepper('dur-down-big', 'dur-down', 'dur', f.seconds.toFixed(1) + ' s', 'dur-up', 'dur-up-big')}
        </div>

        <div class="peditor-tile peditor-tile--full-stepper">
          <div class="peditor-tile-label">Volume</div>
          <div class="peditor-tile-temp-header">
            <span class="peditor-tile-toggle-spacer"></span>
            ${_icoLg(`<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18"/>`)}
            ${_powerToggle('volume-toggle', f.volumeEnabled)}
          </div>
          <div class="peditor-tile-stepper-wrap">
            <div style="${f.volumeEnabled ? '' : 'visibility:hidden'}">
              ${_stepper('volume-down-big', 'volume-down', 'volume', f.volumeValue.toFixed(0) + ' ml', 'volume-up', 'volume-up-big')}
            </div>
            ${f.volumeEnabled ? '' : '<div class="peditor-tile-none-label">None</div>'}
          </div>
        </div>

        <div class="peditor-tile peditor-tile--full-stepper">
          <div class="peditor-tile-label">Weight</div>
          <div class="peditor-tile-temp-header">
            <span class="peditor-tile-toggle-spacer"></span>
            ${_icoLg(`<path d="m16 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="m2 16 3-8 3 8c-.87.65-1.92 1-3 1s-2.13-.35-3-1Z"/><path d="M7 21h10"/><path d="M12 3v18"/><path d="M3 7h2c2 0 5-1 7-2 2 1 5 2 7 2h2"/>`)}
            ${_powerToggle('weight-toggle', f.weightEnabled)}
          </div>
          <div class="peditor-tile-stepper-wrap">
            <div style="${f.weightEnabled ? '' : 'visibility:hidden'}">
              ${_stepper('weight-down-big', 'weight-down', 'weight', f.weightValue.toFixed(1) + ' g', 'weight-up', 'weight-up-big')}
            </div>
            ${f.weightEnabled ? '' : '<div class="peditor-tile-none-label">None</div>'}
          </div>
        </div>

      </div>
    </div>

    <div class="peditor-section">
      <div class="peditor-section-label">Move on if</div>
      <div class="peditor-tile-grid peditor-tile-grid--nowrap">

        <div class="peditor-tile peditor-tile--full-stepper peditor-tile--transition">
          <div class="peditor-tile-label">Transition</div>
          <div class="peditor-tile-temp-header">
            ${_icoLg(`<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>`)}
            <div class="grinder-setting-type-toggle peditor-transition-toggle">
              <button type="button" class="grinder-toggle-btn${f.transition === 'fast'   ? ' is-active' : ''}" data-frame-idx="${idx}" data-frame-action="transition" data-mode="fast">Fast</button>
              <button type="button" class="grinder-toggle-btn${f.transition === 'smooth' ? ' is-active' : ''}" data-frame-idx="${idx}" data-frame-action="transition" data-mode="smooth">Smooth</button>
            </div>
          </div>
        </div>
        <div class="peditor-tile peditor-tile--full-stepper peditor-tile--exit">
          <div class="peditor-tile-label">Exit condition</div>
          ${_powerToggle('exit-toggle', f.exitEnabled)}
          <div class="peditor-exit-body">
          ${_icoLg(
            f.exitType === 'pressure_over'  ? `<path d="M12 5v14"/><path d="m5 12 7-7 7 7"/><path d="M3 19h18"/>` :
            f.exitType === 'pressure_under' ? `<path d="M12 19V5"/><path d="m5 12 7 7 7-7"/><path d="M3 5h18"/>` :
            f.exitType === 'flow_over'      ? `<path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"/><path d="m8 10 4-4 4 4"/>` :
                                              `<path d="M12 22a7 7 0 0 0 7-7c0-2-1-3.9-3-5.5s-3.5-4-4-6.5c-.5 2.5-2 4.9-4 6.5C6 11.1 5 13 5 15a7 7 0 0 0 7 7z"/><path d="m8 14 4 4 4-4"/>`
          )}
          <div class="grinder-setting-type-toggle peditor-exit-type-toggle">
            <button type="button" class="grinder-toggle-btn${f.exitType === 'pressure_over'  ? ' is-active' : ''}" data-frame-idx="${idx}" data-frame-action="exit-type-select" data-mode="pressure_over">Pressure<br>over</button>
            <button type="button" class="grinder-toggle-btn${f.exitType === 'pressure_under' ? ' is-active' : ''}" data-frame-idx="${idx}" data-frame-action="exit-type-select" data-mode="pressure_under">Pressure<br>under</button>
            <button type="button" class="grinder-toggle-btn${f.exitType === 'flow_over'      ? ' is-active' : ''}" data-frame-idx="${idx}" data-frame-action="exit-type-select" data-mode="flow_over">Flow<br>over</button>
            <button type="button" class="grinder-toggle-btn${f.exitType === 'flow_under'     ? ' is-active' : ''}" data-frame-idx="${idx}" data-frame-action="exit-type-select" data-mode="flow_under">Flow<br>under</button>
          </div>
          </div>
          <div class="peditor-tile-stepper-wrap">
            <div style="${f.exitEnabled ? '' : 'visibility:hidden'}">
              ${_stepper('exit-down-big', 'exit-down', 'exit', _peditorFormatExitVal(f), 'exit-up', 'exit-up-big')}
            </div>
            ${f.exitEnabled ? '' : '<div class="peditor-tile-none-label">None</div>'}
          </div>
        </div>

      </div>
    </div>

  </div>`;
}

function _peditorRenderFrames() {
  if (!profileEditorFramesEl) return;
  _peditorRenderStopControls();
  const countEl = document.getElementById('peditor-phasen-count');
  if (countEl) countEl.textContent = _peditorFrames.length ? t('profileEditor.phasesCount').replace('{count}', _peditorFrames.length) : t('profileEditor.phasesLabel');

  const uniq = (arr) => [...new Set(arr.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de'));
  const allFrameNames = () => {
    const all = Array.isArray(_profileRecordsCacheAll) ? _profileRecordsCacheAll : (_profileRecordsCache || []);
    return uniq(all.flatMap(r => (r.profile?.steps ?? r.profile?.frames ?? []).map(s => s.name)));
  };

  if (!_peditorFrames.length) {
    profileEditorFramesEl.innerHTML = `<div class="bohnen-empty-state">${t('profileEditor.noPhases')}</div>`;
    return;
  }

  // ── Beanie master-detail layout ──────────────────────────────────────────
  profileEditorFramesEl.classList.toggle('peditor-frames--beanie', _peditorBeanieMode);
  document.getElementById('peditor-panel-phasen')?.classList.toggle('peditor-panel--beanie', _peditorBeanieMode);
  if (_peditorBeanieMode) {
    _peditorSelectedFrameIdx = Math.max(0, Math.min(_peditorSelectedFrameIdx, _peditorFrames.length - 1));
    const selIdx = _peditorSelectedFrameIdx;
    const selFrame = _peditorFrames[selIdx];

    profileEditorFramesEl.innerHTML = `
      <div class="peditor-bl-wrap">
        <div class="peditor-bl-left">
          <div class="peditor-bl-list-toolbar">
            <span class="peditor-bl-toolbar-label">Phases</span>
          </div>
          <div class="peditor-bl-list">
            ${_peditorFrames.map((f, idx) => `
              <div class="peditor-bl-item${idx === selIdx ? ' is-selected' : ''}" data-bl-select="${idx}">
                <span class="peditor-bl-item-num">${idx + 1}</span>
                <div class="peditor-bl-item-info">
                  <div class="peditor-bl-item-name">${_escapeHtml(f.name || `Phase ${idx + 1}`)}</div>
                  <div class="peditor-bl-item-summary">${_peditorFrameSummary(f)}</div>
                </div>
              </div>`).join('')}
          </div>
          <div class="peditor-bl-actions">
            <button type="button" class="peditor-bl-action-btn" data-bl-action="add" title="Add phase">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              <span>Add</span>
            </button>
            <button type="button" class="peditor-bl-action-btn" data-bl-action="dup" title="Duplicate" ${!_peditorFrames.length ? 'disabled' : ''}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>
              <span>Dup</span>
            </button>
            <button type="button" class="peditor-bl-action-btn" data-bl-action="move-up" title="Move up" ${selIdx === 0 || !_peditorFrames.length ? 'disabled' : ''}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 19V5"/><path d="m5 12 7-7 7 7"/></svg>
              <span>Up</span>
            </button>
            <button type="button" class="peditor-bl-action-btn" data-bl-action="move-down" title="Move down" ${selIdx >= _peditorFrames.length - 1 || !_peditorFrames.length ? 'disabled' : ''}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 5v14"/><path d="m19 12-7 7-7-7"/></svg>
              <span>Down</span>
            </button>
            <button type="button" class="peditor-bl-action-btn peditor-bl-action-btn--del" data-bl-action="delete" title="Delete" ${!_peditorFrames.length ? 'disabled' : ''}>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6l-1 14H6L5 6"/><path d="M8 6V4h8v2"/></svg>
              <span>Del</span>
            </button>
          </div>
          <div class="peditor-bl-chart">
            ${_profileSparkSvg(_peditorBuildProfile(), { showXTicks: false, showYTicks: false, showStageLabels: false, showLegend: false, lineStrokeWidth: 5, compactMargins: true, selectedFrameIdx: selIdx })}
          </div>
        </div>
        <div class="peditor-bl-right">
          ${selFrame ? `
          <div class="peditor-bl-detail-header">
            <div class="peditor-bl-title-field">
              <span class="peditor-bl-title-label">Title</span>
              <input type="text" class="profile-editor-frame-name peditor-bl-title-input"
                     value="${_escapeHtml(selFrame.name)}" placeholder="${t('profileEditor.phaseNamePlaceholder')}"
                     data-frame-idx="${selIdx}" data-field="name" />
            </div>
          </div>
          <div class="peditor-bl-detail-body">
            ${_peditorFrameTilesHtml(selFrame, selIdx)}
          </div>` : `<div class="bohnen-empty-state">${t('profileEditor.noPhases')}</div>`}
        </div>
      </div>`;

    profileEditorFramesEl.querySelectorAll('.profile-editor-frame-name').forEach(el => {
      el.addEventListener('pointerdown', (e) => { e.preventDefault(); openFieldPicker(el, allFrameNames()); });
    });

    profileEditorFramesEl.querySelectorAll('[data-bl-select]').forEach(el => {
      el.addEventListener('click', (e) => {
        if (e.target.closest('[data-bl-action]')) return;
        _peditorSelectedFrameIdx = parseInt(el.dataset.blSelect, 10);
        _peditorRenderFrames();
      });
    });

    profileEditorFramesEl.querySelectorAll('[data-bl-action]').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.blAction;
        const si = _peditorSelectedFrameIdx;
        const sf = _peditorFrames[si];
        if (action === 'add') {
          const last = _peditorFrames[_peditorFrames.length - 1];
          _peditorFrames.push({
            name: `Phase ${_peditorFrames.length + 1}`,
            pump: last?.pump ?? 'pressure', flow: last?.flow ?? 2.0,
            pressure: last?.pressure ?? 6.0, seconds: 10,
            temperature: last?.temperature ?? 93.0, transition: last?.transition ?? 'fast',
            sensor: last?.sensor ?? 'coffee', limiterEnabled: false, limiterValue: 0,
            limiterRange: 0.6, volumeEnabled: false, volumeValue: 36,
            weightEnabled: false, weightValue: 36, exitEnabled: false,
            exitType: 'pressure_over', exitValue: 0, _rest: {},
          });
          _peditorSelectedFrameIdx = _peditorFrames.length - 1;
        } else if (action === 'dup' && sf) {
          _peditorFrames.splice(si + 1, 0, { ..._peditorClone(sf), name: `${sf.name || `Phase ${si + 1}`} (Kopie)` });
          _peditorSelectedFrameIdx = si + 1;
        } else if (action === 'move-up' && sf && si > 0) {
          [_peditorFrames[si - 1], _peditorFrames[si]] = [_peditorFrames[si], _peditorFrames[si - 1]];
          _peditorSelectedFrameIdx = si - 1;
        } else if (action === 'move-down' && sf && si < _peditorFrames.length - 1) {
          [_peditorFrames[si + 1], _peditorFrames[si]] = [_peditorFrames[si], _peditorFrames[si + 1]];
          _peditorSelectedFrameIdx = si + 1;
        } else if (action === 'delete' && sf) {
          _peditorFrames.splice(si, 1);
          _peditorSelectedFrameIdx = Math.min(si, Math.max(0, _peditorFrames.length - 1));
        }
        _peditorRenderStopControls();
        _peditorRenderFrames();
        _peditorRenderChart();
        _peditorRefreshDirtyState();
      });
    });
    return;
  }

  // ── Original horizontal card layout ──────────────────────────────────────
  profileEditorFramesEl.innerHTML = _peditorFrames.map((f, idx) => `
    <div class="profile-editor-frame" data-idx="${idx}">
      <div class="profile-editor-frame-header">
        <span class="profile-editor-frame-num">${idx + 1}</span>
        <input type="text" class="profile-editor-frame-name bean-field-input"
               value="${_escapeHtml(f.name)}" placeholder="${t('profileEditor.phaseNamePlaceholder')}"
               data-frame-idx="${idx}" data-field="name" />
        <div class="profile-editor-frame-actions">
          <button type="button" class="profile-editor-frame-action"
            data-frame-idx="${idx}" data-frame-action="move-up" aria-label="${t('profileEditor.leftAria')}" ${idx === 0 ? 'disabled' : ''}>←</button>
          <button type="button" class="profile-editor-frame-action"
            data-frame-idx="${idx}" data-frame-action="move-down" aria-label="${t('profileEditor.rightAria')}" ${idx === _peditorFrames.length - 1 ? 'disabled' : ''}>→</button>
          <button type="button" class="profile-editor-frame-action"
            data-frame-idx="${idx}" data-frame-action="duplicate" aria-label="${t('profileEditor.dupAria')}">⧉</button>
          <button type="button" class="profile-editor-frame-del"
            data-frame-idx="${idx}" data-frame-action="delete" aria-label="${t('profileEditor.delAria')}">×</button>
        </div>
      </div>
      <div class="profile-editor-frame-fields">
        ${_peditorFrameFieldsHtml(f, idx)}
      </div>
    </div>`).join('');
  profileEditorFramesEl.querySelectorAll('.profile-editor-frame-name').forEach(el => {
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); openFieldPicker(el, allFrameNames()); });
  });
}

function _peditorFrameFrom(raw) {
  const parsedExit = raw?.exit && typeof raw.exit === 'object' ? _peditorExitFromObject(raw.exit) : null;
  const {
    name,
    pump,
    flow,
    pressure,
    seconds,
    temperature,
    transition,
    exit,
    exit_if,
    exit_type,
    exit_pressure_over,
    exit_pressure_under,
    exit_flow_over,
    exit_flow_under,
    exit_weight,
    sensor,
    limiter,
    volume,
    weight,
    // Profile-Level-Felder: nicht in Step einpacken
    tank_temperature,
    target_volume,
    target_volume_count_start,
    target_weight,
    ...rest
  } = raw;
  return {
    name: String(name || ''),
    pump: pump === 'flow' ? 'flow' : 'pressure',
    flow: Math.max(0, Number(flow) || 0),
    pressure: Math.max(0, Number(pressure) || 0),
    seconds: Math.max(0, Number(seconds) || 0),
    temperature: Number(temperature) > 0 ? Number(temperature) : 93.0,
    transition: transition === 'smooth' ? 'smooth' : 'fast',
    sensor: sensor === 'water' ? 'water' : 'coffee',
    limiterEnabled: limiter && typeof limiter === 'object' ? Number(limiter.value) > 0 : false,
    limiterValue: limiter && typeof limiter === 'object' && Number(limiter.value) > 0 ? Number(limiter.value) : 0,
    limiterRange: limiter && typeof limiter === 'object' && Number(limiter.range) > 0 ? Number(limiter.range) : 0.6,
    volumeEnabled: Number(volume) > 0,
    volumeValue: Number(volume) > 0 ? Number(volume) : 36,
    weightEnabled: Number(weight) > 0,
    weightValue: Number(weight) > 0 ? Number(weight) : 36,
    exitEnabled: exit_if != null ? Boolean(exit_if) : (parsedExit ? parsedExit.enabled : false),
    exitType: parsedExit ? parsedExit.type : String(exit_type || 'pressure_over'),
    exitValue: parsedExit ? parsedExit.value : _peditorFrameExitValue({ exit_type, exit_pressure_over, exit_pressure_under, exit_flow_over, exit_flow_under, exit_weight }),
    _rest: rest,
  };
}

function _peditorSwitchTab(tab) {
  _peditorActiveTab = tab;
  const tabs = ['ueberblick', 'phasen', 'einstellungen'];
  for (const t of tabs) {
    const panel = document.getElementById(`peditor-panel-${t}`);
    const btn = document.querySelector(`[data-peditor-tab="${t}"]`);
    const active = t === tab;
    if (panel) panel.hidden = !active;
    if (btn) {
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-selected', String(active));
    }
  }
  if (tab === 'ueberblick') _peditorRenderChart();
}

function openProfileEditorModal(record) {
  if (!profileEditorModalEl) return;
  _peditorRecord = record || null;
  _peditorSelectedFrameIdx = 0;
  const profile  = record?.profile || {};
  _peditorOriginalProfile = _peditorClone(profile) || {};

  _peditorTitle       = profile.title   || '';
  _peditorAuthor      = profile.author  || '';
  _peditorNotes       = profile.notes || profile.profile_notes || '';
  _peditorStopWeightEnabled = Number(profile.target_weight) > 0;
  _peditorStopWeightValue = _peditorStopWeightEnabled ? Number(profile.target_weight) : 36;
  _peditorStopVolumeEnabled = Number(profile.target_volume) > 0;
  _peditorStopVolumeValue = _peditorStopVolumeEnabled ? Number(profile.target_volume) : 0;
  _peditorStopVolumeStartIndex = Math.max(0, Math.trunc(Number(profile.target_volume_count_start) || 0));
  _peditorFrames      = _extractFrames(profile).map(_peditorFrameFrom);
  _peditorGroupTemp   = _profileEditorGroupTemp(profile) ?? 93;
  _peditorTankTempEnabled = Number(profile.tank_temperature) > 0;
  _peditorTankTempValue   = _peditorTankTempEnabled ? Number(profile.tank_temperature) : 0;
  _peditorLimiterFlowRange     = Number(profile.limiter_flow_range)     > 0 ? Number(profile.limiter_flow_range)     : 0.6;
  _peditorLimiterPressureRange = Number(profile.limiter_pressure_range) > 0 ? Number(profile.limiter_pressure_range) : 0.6;

  const byId = id => document.getElementById(id);
  const titleEl   = byId('profile-editor-title');
  const authorEl  = byId('profile-editor-author');
  const notesEl   = byId('profile-editor-notes');

  if (titleEl)    titleEl.value    = _peditorTitle;
  if (authorEl)   authorEl.value   = _peditorAuthor;
  if (notesEl) { notesEl.value = _peditorNotes; _autoResizeNotes(notesEl); }

  _peditorSwitchTab('ueberblick');
  _peditorRenderStopControls();
  _peditorRenderFrames();
  _peditorOriginalSnapshot = _peditorSnapshot();
  _peditorRefreshDirtyState();
  profileEditorModalEl.hidden = false;
}

function _peditorAttemptClose(force = false) {
  if (!profileEditorModalEl) return false;
  if (!force && _peditorRefreshDirtyState() && !window.confirm(t('profileEditor.discardChanges'))) {
    return false;
  }
  profileEditorModalEl.hidden = true;
  if (profileEditorDirtyBadgeEl) profileEditorDirtyBadgeEl.hidden = true;
  if (profilePickerModalEl) profilePickerModalEl.hidden = false;
  return true;
}

async function _peditorSave() {
  _peditorTitle  = (document.getElementById('profile-editor-title')?.value  || '').trim();
  _peditorAuthor = (document.getElementById('profile-editor-author')?.value || '').trim();
  _peditorNotes  = (document.getElementById('profile-editor-notes')?.value  || '').trim();

  if (!_peditorTitle) { showToast(t('toast.profileNameRequired')); return; }
  if (!_peditorFrames.length) { showToast(t('toast.addPhase')); return; }

  try {
    const cleanPayload = _peditorBuildCreateFallback(_peditorBuildProfile());
    const hasId = Boolean(_peditorRecord?.id);
    const isDefault = Boolean(_peditorRecord?.isDefault);
    const originalId = _peditorRecord?.id ?? null;
    let saved;
    if (hasId && !isDefault) {
      if (_peditorHasExecutionChanges()) {
        // Execution fields changed → new version with parent lineage
        cleanPayload.parentId = _peditorRecord.id;
        saved = await saveProfile(null, cleanPayload);
        if (saved?.id && saved?.visibility === 'deleted') {
          saved = await setProfileVisibility(saved.id, 'visible') || saved;
        }
        try { await deleteProfile(_peditorRecord.id); } catch { /* soft-delete best-effort */ }
      } else {
        // Metadata only → update in-place, same ID
        const { parentId: _ignored, ...updatePayload } = cleanPayload;
        saved = await saveProfile(_peditorRecord.id, updatePayload);
      }
    } else {
      // New profile, or default profile being copied — always create, never PUT
      if (isDefault && hasId) cleanPayload.parentId = _peditorRecord.id;
      saved = await saveProfile(null, cleanPayload);
      if (saved?.id && saved?.visibility === 'deleted') {
        saved = await setProfileVisibility(saved.id, 'visible') || saved;
      }
    }
    _peditorRecord = _normalizeProfileRecord(saved) || { id: saved?.id ?? _peditorRecord?.id ?? null, profile: payload };
    _peditorOriginalProfile = _peditorClone(_peditorRecord.profile) || _peditorClone(payload) || {};
    _peditorOriginalSnapshot = _peditorSnapshot();
    _profileRecordsCache = null;

    // Bust cached gateway payload for every recipe that uses this profile title
    for (const recipe of workflowItems) {
      if (recipe.profileTitle === _peditorTitle) {
        delete recipe._resolvedPayload;
      }
    }
    // Re-push current recipe if it references the updated profile
    const currentRecipe = workflowItems[selectedWorkflowIndex];
    if (currentRecipe?.profileTitle === _peditorTitle) {
      pushSelectedWorkflowToMachine(currentRecipe);
    }

    if (isDefault) {
      // Bundled profile copy — hide the original, close editor, reload, re-open picker with new copy selected
      if (originalId) {
        try { await setProfileVisibility(originalId, 'hidden'); } catch { /* best-effort */ }
      }
      _peditorAttemptClose(true);
      _profileRecordsCache = null;
      _profileRecordsCacheAll = null;
      await _ensureProfilesLoaded(true);
      _setProfilePickerMode('my');
      const newRecord = _normalizeProfileRecord(saved);
      if (newRecord) {
        const { group } = _profileGroupOf(newRecord.profile?.title || '');
        if (group) _expandProfileGroup(group);
        _profilePickerSelectedRecord = newRecord;
        _renderProfilePickerList();
        _renderProfilePreview(newRecord);
      }
      if (profilePickerModalEl) profilePickerModalEl.hidden = false;
      showToast(t('toast.profileCopied').replace('{name}', _peditorTitle));
    } else {
      showToast(t('toast.profileSaved').replace('{name}', _peditorTitle));
      _setProfilePickerMode('my');
      _profileRecordsCache = null;
      await _ensureProfilesLoaded();
      _renderProfilePickerList();
      _peditorAttemptClose(true);
    }
  } catch (err) {
    showToast(t('toast.saveFailed2') + ': ' + err.message);
  }
}

document.getElementById('btn-profile-editor-save')?.addEventListener('click', _peditorSave);
document.getElementById('btn-profile-editor-cancel')?.addEventListener('click', () => {
  _peditorAttemptClose();
});
profileEditorModalEl?.addEventListener('click', e => {
  const tabBtn = e.target.closest('[data-peditor-tab]');
  if (tabBtn) { _peditorSwitchTab(tabBtn.dataset.peditorTab); return; }
  if (e.target === profileEditorModalEl) _peditorAttemptClose();
});

document.getElementById('profile-editor-title')?.addEventListener('input', (e) => {
  _peditorTitle = e.target.value;
  _peditorRefreshDirtyState();
});
document.getElementById('profile-editor-author')?.addEventListener('input', (e) => {
  _peditorAuthor = e.target.value;
  _peditorRefreshDirtyState();
});
function _autoResizeNotes(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = el.scrollHeight + 'px';
}

document.getElementById('profile-editor-notes')?.addEventListener('input', (e) => {
  _peditorNotes = e.target.value;
  _autoResizeNotes(e.target);
  _peditorRefreshDirtyState();
});

document.getElementById('profile-editor-stop-weight-enabled')?.addEventListener('change', e => {
  _peditorStopWeightEnabled = e.target.checked;
  _peditorRenderStopControls();
  _peditorRefreshDirtyState();
});
document.getElementById('profile-editor-stop-volume-enabled')?.addEventListener('change', e => {
  _peditorStopVolumeEnabled = e.target.checked;
  _peditorRenderStopControls();
  _peditorRefreshDirtyState();
});
document.getElementById('btn-peditor-stop-weight-down')?.addEventListener('click', () => {
  _peditorStopWeightValue = Math.max(1, _peditorStopWeightValue - _peditorWeightStepSize(false));
  _peditorRenderStopControls();
  _peditorRefreshDirtyState();
});
document.getElementById('btn-peditor-stop-weight-up')?.addEventListener('click', () => {
  _peditorStopWeightValue = Math.min(500, _peditorStopWeightValue + _peditorWeightStepSize(false));
  _peditorRenderStopControls();
  _peditorRefreshDirtyState();
});
document.getElementById('btn-peditor-stop-weight-down-big')?.addEventListener('click', () => {
  _peditorStopWeightValue = Math.max(1, _peditorStopWeightValue - _peditorWeightStepSize(true));
  _peditorRenderStopControls();
  _peditorRefreshDirtyState();
});
document.getElementById('btn-peditor-stop-weight-up-big')?.addEventListener('click', () => {
  _peditorStopWeightValue = Math.min(500, _peditorStopWeightValue + _peditorWeightStepSize(true));
  _peditorRenderStopControls();
  _peditorRefreshDirtyState();
});
document.getElementById('btn-peditor-stop-volume-down')?.addEventListener('click', () => {
  _peditorStopVolumeValue = Math.max(1, _peditorStopVolumeValue - _peditorVolumeStepSize(false));
  _peditorRenderStopControls();
  _peditorRefreshDirtyState();
});
document.getElementById('btn-peditor-stop-volume-up')?.addEventListener('click', () => {
  _peditorStopVolumeValue = Math.min(500, _peditorStopVolumeValue + _peditorVolumeStepSize(false));
  _peditorRenderStopControls();
  _peditorRefreshDirtyState();
});
document.getElementById('btn-peditor-stop-volume-down-big')?.addEventListener('click', () => {
  _peditorStopVolumeValue = Math.max(1, _peditorStopVolumeValue - _peditorVolumeStepSize(true));
  _peditorRenderStopControls();
  _peditorRefreshDirtyState();
});
document.getElementById('btn-peditor-stop-volume-up-big')?.addEventListener('click', () => {
  _peditorStopVolumeValue = Math.min(500, _peditorStopVolumeValue + _peditorVolumeStepSize(true));
  _peditorRenderStopControls();
  _peditorRefreshDirtyState();
});
document.getElementById('btn-peditor-stop-volume-start-down')?.addEventListener('click', () => {
  _peditorStopVolumeStartIndex = Math.max(0, _peditorStopVolumeStartIndex - _peditorPhaseIndexStepSize(false));
  _peditorRenderStopControls();
  _peditorRefreshDirtyState();
});
document.getElementById('btn-peditor-stop-volume-start-up')?.addEventListener('click', () => {
  const maxStageIndex = Math.max(0, (_peditorFrames.length || 1) - 1);
  _peditorStopVolumeStartIndex = Math.min(maxStageIndex, _peditorStopVolumeStartIndex + _peditorPhaseIndexStepSize(false));
  _peditorRenderStopControls();
  _peditorRefreshDirtyState();
});

document.getElementById('peditor-group-temp-val')?.addEventListener('click', () => {
  openNumberPicker(_npMakeRange(70, 105, 1), _peditorGroupTemp, v => {
    const delta = v - _peditorGroupTemp;
    _peditorGroupTemp = v;
    _peditorApplyGroupTempDelta(delta);
    _peditorRenderStopControls();
    _peditorRenderFrames();
    _peditorRefreshDirtyState();
  });
});
document.getElementById('peditor-tank-temp-val')?.addEventListener('click', () => {
  openNumberPicker(_npMakeRange(0, 50, 1), _peditorTankTempValue, v => {
    _peditorTankTempValue = v;
    _peditorRenderStopControls();
    _peditorRefreshDirtyState();
  });
});
document.getElementById('profile-editor-stop-weight-val')?.addEventListener('click', () => {
  openNumberPicker(_npMakeRange(1, 500, 1), _peditorStopWeightValue, v => {
    _peditorStopWeightValue = v;
    _peditorRenderStopControls();
    _peditorRefreshDirtyState();
  });
});
document.getElementById('profile-editor-stop-volume-val')?.addEventListener('click', () => {
  openNumberPicker(_npMakeRange(1, 500, 1), _peditorStopVolumeValue, v => {
    _peditorStopVolumeValue = v;
    _peditorRenderStopControls();
    _peditorRefreshDirtyState();
  });
});
document.getElementById('peditor-limiter-flow-range-val')?.addEventListener('click', () => {
  openNumberPicker(_npMakeRange(0.1, 5, 0.1), _peditorLimiterFlowRange, v => {
    _peditorLimiterFlowRange = Math.round(v * 100) / 100;
    _peditorRenderStopControls();
    _peditorRefreshDirtyState();
  }, 1);
});
document.getElementById('peditor-limiter-pressure-range-val')?.addEventListener('click', () => {
  openNumberPicker(_npMakeRange(0.1, 5, 0.1), _peditorLimiterPressureRange, v => {
    _peditorLimiterPressureRange = Math.round(v * 100) / 100;
    _peditorRenderStopControls();
    _peditorRefreshDirtyState();
  }, 1);
});

function _peditorApplyGroupTempDelta(delta) {
  if (delta === 0) return;
  _peditorFrames = _peditorFrames.map(f => {
    const t = Number(f.temperature);
    return { ...f, temperature: Number.isFinite(t) ? Math.round((t + delta) * 10) / 10 : f.temperature };
  });
}

document.getElementById('btn-peditor-group-temp-down-big')?.addEventListener('click', () => {
  const delta = -_peditorTemperatureStepSize(true);
  _peditorGroupTemp = Math.max(70, Math.round((_peditorGroupTemp + delta) * 10) / 10);
  _peditorApplyGroupTempDelta(delta);
  _peditorRenderStopControls();
  _peditorRenderFrames();
  _peditorRefreshDirtyState();
});
document.getElementById('btn-peditor-group-temp-down')?.addEventListener('click', () => {
  const delta = -_peditorTemperatureStepSize(false);
  _peditorGroupTemp = Math.max(70, Math.round((_peditorGroupTemp + delta) * 10) / 10);
  _peditorApplyGroupTempDelta(delta);
  _peditorRenderStopControls();
  _peditorRenderFrames();
  _peditorRefreshDirtyState();
});
document.getElementById('btn-peditor-group-temp-up')?.addEventListener('click', () => {
  const delta = _peditorTemperatureStepSize(false);
  _peditorGroupTemp = Math.min(105, Math.round((_peditorGroupTemp + delta) * 10) / 10);
  _peditorApplyGroupTempDelta(delta);
  _peditorRenderStopControls();
  _peditorRenderFrames();
  _peditorRefreshDirtyState();
});
document.getElementById('btn-peditor-group-temp-up-big')?.addEventListener('click', () => {
  const delta = _peditorTemperatureStepSize(true);
  _peditorGroupTemp = Math.min(105, Math.round((_peditorGroupTemp + delta) * 10) / 10);
  _peditorApplyGroupTempDelta(delta);
  _peditorRenderStopControls();
  _peditorRenderFrames();
  _peditorRefreshDirtyState();
});

document.getElementById('peditor-tank-temp-enabled')?.addEventListener('change', e => {
  _peditorTankTempEnabled = e.target.checked;
  _peditorRenderStopControls();
  _peditorRefreshDirtyState();
});
document.getElementById('btn-peditor-tank-temp-down')?.addEventListener('click', () => {
  _peditorTankTempValue = Math.max(0, _peditorTankTempValue - 1);
  _peditorRenderStopControls();
  _peditorRefreshDirtyState();
});
document.getElementById('btn-peditor-tank-temp-up')?.addEventListener('click', () => {
  _peditorTankTempValue = Math.min(50, _peditorTankTempValue + 1);
  _peditorRenderStopControls();
  _peditorRefreshDirtyState();
});

document.getElementById('btn-peditor-limiter-flow-range-down')?.addEventListener('click', () => {
  _peditorLimiterFlowRange = Math.max(0.1, Math.round((_peditorLimiterFlowRange - 0.1) * 100) / 100);
  _peditorRenderStopControls();
  _peditorRefreshDirtyState();
});
document.getElementById('btn-peditor-limiter-flow-range-up')?.addEventListener('click', () => {
  _peditorLimiterFlowRange = Math.min(5, Math.round((_peditorLimiterFlowRange + 0.1) * 100) / 100);
  _peditorRenderStopControls();
  _peditorRefreshDirtyState();
});
document.getElementById('btn-peditor-limiter-pressure-range-down')?.addEventListener('click', () => {
  _peditorLimiterPressureRange = Math.max(0.1, Math.round((_peditorLimiterPressureRange - 0.1) * 100) / 100);
  _peditorRenderStopControls();
  _peditorRefreshDirtyState();
});
document.getElementById('btn-peditor-limiter-pressure-range-up')?.addEventListener('click', () => {
  _peditorLimiterPressureRange = Math.min(5, Math.round((_peditorLimiterPressureRange + 0.1) * 100) / 100);
  _peditorRenderStopControls();
  _peditorRefreshDirtyState();
});

document.getElementById('btn-profile-editor-add-frame')?.addEventListener('click', () => {
  const last = _peditorFrames[_peditorFrames.length - 1];
  _peditorFrames.push({
    name: `Phase ${_peditorFrames.length + 1}`,
    pump: last?.pump ?? 'pressure',
    flow: last?.flow ?? 2.0,
    pressure: last?.pressure ?? 6.0,
    seconds: 10,
    temperature: last?.temperature ?? 93.0,
    transition: last?.transition ?? 'fast',
    sensor: last?.sensor ?? 'coffee',
    limiterEnabled: false,
    limiterValue: 0,
    limiterRange: 0.6,
    volumeEnabled: false,
    volumeValue: 36,
    weightEnabled: false,
    weightValue: 36,
    exitEnabled: false,
    exitType: 'pressure_over',
    exitValue: 0,
    _rest: {},
  });
  if (_peditorBeanieMode) _peditorSelectedFrameIdx = _peditorFrames.length - 1;
  _peditorRenderStopControls();
  _peditorRenderFrames();
  _peditorRenderChart();
  _peditorRefreshDirtyState();
});

profileEditorFramesEl?.addEventListener('input', e => {
  const input = e.target.closest('[data-field="name"]');
  if (!input) return;
  const idx = parseInt(input.dataset.frameIdx, 10);
  if (_peditorFrames[idx]) {
    _peditorFrames[idx].name = input.value;
    if (_peditorBeanieMode) {
      const nameEl = profileEditorFramesEl.querySelector(`[data-bl-select="${idx}"] .peditor-bl-item-name`);
      if (nameEl) nameEl.textContent = input.value || `Phase ${idx + 1}`;
    }
    _peditorRenderChart();
    _peditorRefreshDirtyState();
  }
});

profileEditorFramesEl?.addEventListener('click', e => {
  const btn = e.target.closest('[data-frame-action]');
  if (!btn) return;
  const idx = parseInt(btn.dataset.frameIdx, 10);
  const f   = _peditorFrames[idx];
  const action = btn.dataset.frameAction;

  const display = (type, text) => {
    const el = profileEditorFramesEl.querySelector(`[data-frame-idx="${idx}"][data-frame-display="${type}"]`);
    if (el) el.textContent = text;
  };

  switch (action) {
    case 'delete':
      _peditorFrames.splice(idx, 1);
      if (_peditorBeanieMode) _peditorSelectedFrameIdx = Math.min(_peditorSelectedFrameIdx, Math.max(0, _peditorFrames.length - 1));
      _peditorRenderFrames();
      _peditorRenderChart();
      _peditorRefreshDirtyState();
      break;
    case 'duplicate':
      if (!f) return;
      _peditorFrames.splice(idx + 1, 0, {
        ..._peditorClone(f),
        name: `${f.name || `Phase ${idx + 1}`} (Kopie)`,
      });
      if (_peditorBeanieMode) _peditorSelectedFrameIdx = idx + 1;
      _peditorRenderFrames();
      _peditorRenderChart();
      _peditorRefreshDirtyState();
      break;
    case 'move-up':
      if (!f || idx <= 0) return;
      [_peditorFrames[idx - 1], _peditorFrames[idx]] = [_peditorFrames[idx], _peditorFrames[idx - 1]];
      if (_peditorBeanieMode && _peditorSelectedFrameIdx === idx) _peditorSelectedFrameIdx--;
      _peditorRenderFrames();
      _peditorRenderChart();
      _peditorRefreshDirtyState();
      break;
    case 'move-down':
      if (!f || idx >= _peditorFrames.length - 1) return;
      [_peditorFrames[idx + 1], _peditorFrames[idx]] = [_peditorFrames[idx], _peditorFrames[idx + 1]];
      if (_peditorBeanieMode && _peditorSelectedFrameIdx === idx) _peditorSelectedFrameIdx++;
      _peditorRenderFrames();
      _peditorRenderChart();
      _peditorRefreshDirtyState();
      break;
    case 'pump':
      if (!f) return;
      f.pump = btn.dataset.mode;
      _peditorRenderFrames();
      _peditorRenderChart();
      _peditorRefreshDirtyState();
      break;
    case 'transition':
      if (!f) return;
      f.transition = btn.dataset.mode === 'smooth' ? 'smooth' : 'fast';
      _peditorRenderFrames();
      _peditorRenderChart();
      _peditorRefreshDirtyState();
      break;
    case 'sensor':
      if (!f) return;
      f.sensor = btn.dataset.mode === 'water' ? 'water' : 'coffee';
      _peditorRenderFrames();
      _peditorRefreshDirtyState();
      break;
    case 'limiter-toggle':
    case 'limiter-tile-toggle':
      if (!f) return;
      f.limiterEnabled = !f.limiterEnabled;
      if (f.limiterEnabled && f.limiterValue === 0) f.limiterValue = f.pump === 'pressure' ? 8.0 : 6.0;
      _peditorRenderFrames();
      _peditorRefreshDirtyState();
      break;
    case 'exit-tile': {
      if (!f) return;
      const tileType = btn.dataset.exitType;
      if (f.exitEnabled && f.exitType === tileType) {
        f.exitEnabled = false;
      } else {
        f.exitEnabled = true;
        f.exitType = tileType;
        if (!f.exitValue || f.exitValue === 0)
          f.exitValue = tileType.includes('pressure') ? 6.0 : 2.0;
      }
      _peditorRenderFrames();
      _peditorRefreshDirtyState();
      break;
    }
    case 'exit-type-select': {
      if (!f) return;
      const newType = btn.dataset.mode;
      f.exitType = newType;
      if (!f.exitValue || f.exitValue === 0)
        f.exitValue = newType.includes('pressure') ? 6.0 : 2.0;
      _peditorRenderFrames();
      _peditorRefreshDirtyState();
      break;
    }
    case 'volume-tile-toggle':
      if (!f) return;
      f.volumeEnabled = !f.volumeEnabled;
      if (f.volumeEnabled && f.volumeValue === 0) f.volumeValue = 36;
      _peditorRenderFrames();
      _peditorRefreshDirtyState();
      break;
    case 'weight-tile-toggle':
      if (!f) return;
      f.weightEnabled = !f.weightEnabled;
      if (f.weightEnabled && f.weightValue === 0) f.weightValue = 36;
      _peditorRenderFrames();
      _peditorRefreshDirtyState();
      break;
    case 'limiter-down-big':
    case 'limiter-down':
      if (!f || !f.limiterEnabled) return;
      f.limiterValue = Math.max(0.1, Math.round((f.limiterValue - (action === 'limiter-down-big' ? 1.0 : 0.1)) * 10) / 10);
      display('limiter', f.pump === 'pressure' ? f.limiterValue.toFixed(1) + ' ml/s' : f.limiterValue.toFixed(1) + ' bar');
      _peditorRefreshDirtyState();
      break;
    case 'limiter-up-big':
    case 'limiter-up':
      if (!f || !f.limiterEnabled) return;
      f.limiterValue = Math.min(f.pump === 'pressure' ? 15 : 12, Math.round((f.limiterValue + (action === 'limiter-up-big' ? 1.0 : 0.1)) * 10) / 10);
      display('limiter', f.pump === 'pressure' ? f.limiterValue.toFixed(1) + ' ml/s' : f.limiterValue.toFixed(1) + ' bar');
      _peditorRefreshDirtyState();
      break;
    case 'volume-toggle':
      if (!f) return;
      f.volumeEnabled = !f.volumeEnabled;
      if (f.volumeEnabled && (!f.volumeValue || f.volumeValue === 0)) f.volumeValue = 36;
      _peditorRenderFrames();
      _peditorRefreshDirtyState();
      break;
    case 'volume-down-big':
    case 'volume-down':
      if (!f || !f.volumeEnabled) return;
      f.volumeValue = Math.max(1, f.volumeValue - (action === 'volume-down-big' ? 10 : 1));
      display('volume', f.volumeValue.toFixed(0) + ' ml');
      _peditorRefreshDirtyState();
      break;
    case 'volume-up-big':
    case 'volume-up':
      if (!f || !f.volumeEnabled) return;
      f.volumeValue = Math.min(500, f.volumeValue + (action === 'volume-up-big' ? 10 : 1));
      display('volume', f.volumeValue.toFixed(0) + ' ml');
      _peditorRefreshDirtyState();
      break;
    case 'weight-toggle':
      if (!f) return;
      f.weightEnabled = !f.weightEnabled;
      if (f.weightEnabled && (!f.weightValue || f.weightValue === 0)) f.weightValue = 36;
      _peditorRenderFrames();
      _peditorRefreshDirtyState();
      break;
    case 'weight-down-big':
    case 'weight-down':
      if (!f || !f.weightEnabled) return;
      f.weightValue = Math.max(0.1, Math.round((f.weightValue - (action === 'weight-down-big' ? 5 : 0.5)) * 10) / 10);
      display('weight', f.weightValue.toFixed(1) + ' g');
      _peditorRefreshDirtyState();
      break;
    case 'weight-up-big':
    case 'weight-up':
      if (!f || !f.weightEnabled) return;
      f.weightValue = Math.min(500, Math.round((f.weightValue + (action === 'weight-up-big' ? 5 : 0.5)) * 10) / 10);
      display('weight', f.weightValue.toFixed(1) + ' g');
      _peditorRefreshDirtyState();
      break;
    case 'exit-toggle':
      if (!f) return;
      f.exitEnabled = !f.exitEnabled;
      _peditorRenderFrames();
      _peditorRenderChart();
      _peditorRefreshDirtyState();
      break;
    case 'val-down':
    case 'val-down-big':
      if (!f) return;
      if (f.pump === 'flow') f.flow     = Math.max(0,  Math.round((f.flow     - _peditorTargetStepSize(f, action === 'val-down-big')) * 10) / 10);
      else                   f.pressure = Math.max(0,  Math.round((f.pressure - _peditorTargetStepSize(f, action === 'val-down-big')) * 10) / 10);
      display('val', _peditorFormatVal(f));
      _peditorRenderChart();
      _peditorRefreshDirtyState();
      break;
    case 'val-up':
    case 'val-up-big':
      if (!f) return;
      if (f.pump === 'flow') f.flow     = Math.min(15, Math.round((f.flow     + _peditorTargetStepSize(f, action === 'val-up-big')) * 10) / 10);
      else                   f.pressure = Math.min(14, Math.round((f.pressure + _peditorTargetStepSize(f, action === 'val-up-big')) * 10) / 10);
      display('val', _peditorFormatVal(f));
      _peditorRenderChart();
      _peditorRefreshDirtyState();
      break;
    case 'temp-down':
    case 'temp-down-big':
      if (!f) return;
      f.temperature = Math.max(70, Math.round((f.temperature - _peditorTemperatureStepSize(action === 'temp-down-big')) * 10) / 10);
      display('temp', `${f.temperature.toFixed(1)}°C`);
      _peditorRenderChart();
      _peditorRefreshDirtyState();
      break;
    case 'temp-up':
    case 'temp-up-big':
      if (!f) return;
      f.temperature = Math.min(105, Math.round((f.temperature + _peditorTemperatureStepSize(action === 'temp-up-big')) * 10) / 10);
      display('temp', `${f.temperature.toFixed(1)}°C`);
      _peditorRenderChart();
      _peditorRefreshDirtyState();
      break;
    case 'dur-down':
    case 'dur-down-big':
      if (!f) return;
      f.seconds = Math.max(0, Math.round((f.seconds - _peditorDurationStepSize(action === 'dur-down-big')) * 10) / 10);
      display('dur', `${f.seconds.toFixed(1)} s`);
      _peditorRenderChart();
      _peditorRefreshDirtyState();
      break;
    case 'dur-up':
    case 'dur-up-big':
      if (!f) return;
      f.seconds = Math.min(120, Math.round((f.seconds + _peditorDurationStepSize(action === 'dur-up-big')) * 10) / 10);
      display('dur', `${f.seconds.toFixed(1)} s`);
      _peditorRenderChart();
      _peditorRefreshDirtyState();
      break;
    case 'exit-down':
    case 'exit-down-big': {
      if (!f) return;
      const step = _peditorExitStepSize(f, action === 'exit-down-big');
      f.exitValue = Math.max(_peditorExitMin(f), Math.round((f.exitValue - step) * 10) / 10);
      display('exit', _peditorFormatExitVal(f));
      _peditorRenderChart();
      _peditorRefreshDirtyState();
      break;
    }
    case 'exit-up':
    case 'exit-up-big': {
      if (!f) return;
      const step = _peditorExitStepSize(f, action === 'exit-up-big');
      f.exitValue = Math.min(_peditorExitMax(f), Math.round((f.exitValue + step) * 10) / 10);
      display('exit', _peditorFormatExitVal(f));
      _peditorRenderChart();
      _peditorRefreshDirtyState();
      break;
    }
  }
});

profileEditorFramesEl?.addEventListener('click', e => {
  const span = e.target.closest('[data-frame-display]');
  if (!span) return;
  const idx = parseInt(span.dataset.frameIdx, 10);
  const f = _peditorFrames[idx];
  if (!f) return;

  const updateDisplay = (type, text) => {
    const el = profileEditorFramesEl.querySelector(`[data-frame-idx="${idx}"][data-frame-display="${type}"]`);
    if (el) el.textContent = text;
  };

  switch (span.dataset.frameDisplay) {
    case 'temp':
      openNumberPicker(_npMakeRange(70, 100, 1), f.temperature, v => {
        f.temperature = v;
        updateDisplay('temp', `${f.temperature.toFixed(1)}°C`);
        _peditorRenderChart();
        _peditorRefreshDirtyState();
      }, 0);
      break;
    case 'val':
      if (f.pump === 'flow') {
        openNumberPicker(_npMakeRange(0, 15, 0.1), f.flow, v => {
          f.flow = v;
          updateDisplay('val', _peditorFormatVal(f));
          _peditorRenderChart();
          _peditorRefreshDirtyState();
        }, 1);
      } else {
        openNumberPicker(_npMakeRange(0, 14, 0.5), f.pressure, v => {
          f.pressure = v;
          updateDisplay('val', _peditorFormatVal(f));
          _peditorRenderChart();
          _peditorRefreshDirtyState();
        }, 1);
      }
      break;
    case 'limiter':
      if (f.pump === 'pressure') {
        openNumberPicker(_npMakeRange(0.1, 15, 0.1), f.limiterValue, v => {
          f.limiterValue = v;
          updateDisplay('limiter', `${f.limiterValue.toFixed(1)} ml/s`);
          _peditorRefreshDirtyState();
        }, 1);
      } else {
        openNumberPicker(_npMakeRange(0.1, 12, 0.1), f.limiterValue, v => {
          f.limiterValue = v;
          updateDisplay('limiter', `${f.limiterValue.toFixed(1)} bar`);
          _peditorRefreshDirtyState();
        }, 1);
      }
      break;
    case 'dur':
      openNumberPicker(_npMakeRange(0, 120, 1), f.seconds, v => {
        f.seconds = v;
        updateDisplay('dur', `${f.seconds.toFixed(1)} s`);
        _peditorRenderChart();
        _peditorRefreshDirtyState();
      }, 0);
      break;
    case 'volume':
      openNumberPicker(_npMakeRange(1, 500, 1), f.volumeValue, v => {
        f.volumeValue = v;
        updateDisplay('volume', `${f.volumeValue.toFixed(0)} ml`);
        _peditorRefreshDirtyState();
      }, 0);
      break;
    case 'weight':
      openNumberPicker(_npMakeRange(1, 500, 1), f.weightValue, v => {
        f.weightValue = v;
        updateDisplay('weight', `${f.weightValue.toFixed(1)} g`);
        _peditorRefreshDirtyState();
      }, 0);
      break;
    case 'exit': {
      const step = _peditorExitStepSize(f, false);
      const dp = step < 1 ? Math.ceil(-Math.log10(step)) : 0;
      openNumberPicker(_npMakeRange(_peditorExitMin(f), _peditorExitMax(f), step), f.exitValue, v => {
        f.exitValue = v;
        updateDisplay('exit', _peditorFormatExitVal(f));
        _peditorRenderChart();
        _peditorRefreshDirtyState();
      }, dp);
      break;
    }
  }
});

profileEditorFramesEl?.addEventListener('change', e => {
  const select = e.target.closest('[data-frame-action="exit-type"]');
  if (!select) return;
  const idx = parseInt(select.dataset.frameIdx, 10);
  const frame = _peditorFrames[idx];
  if (!frame) return;
  frame.exitType = String(select.value || 'pressure_over');
  frame.exitValue = Math.min(frame.exitValue, _peditorExitMax(frame));
  _peditorRenderFrames();
  _peditorRenderChart();
  _peditorRefreshDirtyState();
});

async function openProfilePickerModal(context = 'editor') {
  if (!profilePickerModalEl || !fetchProfiles) {
    showToast(t('toast.profileApiMissing'));
    return;
  }
  try {
    _profilePickerContext = context;
    _profilePickerShowHidden = false;
    await Promise.all([_ensureProfilesLoaded(), _loadProfileFavorites()]);
    if (profilePickerSourceEl) profilePickerSourceEl.value = 'user';
    if (profilePickerSearchEl) profilePickerSearchEl.value = '';
    if (profilePickerAddMenuEl) profilePickerAddMenuEl.hidden = true;
    _setProfilePickerMode('my');
    const useBtn      = document.getElementById('btn-profile-picker-use');
    const cancelBtn   = document.getElementById('btn-profile-picker-cancel');
    const addBtn      = document.getElementById('btn-profile-picker-open-add');
    const trashBtn    = document.getElementById('btn-profile-picker-open-trash');
    const isRecipe    = context === 'recipe';
    if (addBtn)   addBtn.hidden   = isRecipe;
    if (trashBtn) trashBtn.hidden = isRecipe;
    if (context === 'home' || context === 'recipe') {
      if (useBtn)    useBtn.hidden = true;
      if (cancelBtn) cancelBtn.textContent = context === 'home' ? t('action.close') : t('action.cancel');
    } else {
      if (useBtn)    useBtn.hidden = false;
      if (cancelBtn) cancelBtn.textContent = t('action.cancel');
    }
    if (isRecipe) {
      const records = Array.isArray(_profileRecordsCache) ? _profileRecordsCache : [];
      let match = _editSelectedProfileId
        ? records.find(r => String(r.id) === String(_editSelectedProfileId))
        : null;
      if (!match) {
        const title = _editSelectedProfileObj?.title || document.getElementById('edit-profile')?.value?.trim();
        if (title && title !== '—') match = records.find(r => r.profile?.title === title);
      }
      if (match) {
        _profilePickerSelectedRecord = match;
        _renderProfilePickerList();
        _renderProfilePreview(match);
        requestAnimationFrame(() => {
          profilePickerListEl?.querySelector('.profile-picker-item.is-selected')?.scrollIntoView({ block: 'nearest' });
        });
      }
    }
    profilePickerModalEl.hidden = false;
  } catch (err) {
    showToast(`Profile laden fehlgeschlagen: ${err.message}`);
  }
}

function _getGrinderSteps() {
  const g = _grindersCache.find(g => g.id === _editPickedGrinderId);
  const small = (g?.settingSmallStep > 0) ? g.settingSmallStep : 0.5;
  const big   = (g?.settingBigStep   > 0) ? g.settingBigStep   : 1;
  return { small, big };
}

function _setEditDose(v) {
  _editDose = Math.max(0, Math.round(v * 10) / 10);
  const el = document.getElementById('edit-dose-display');
  if (el) el.textContent = `${_editDose.toFixed(1)}g`;
  _syncEditRatio();
}
function _setEditYield(v) {
  _editYield = Math.max(0, Math.round(v * 10) / 10);
  const el = document.getElementById('edit-yield-display');
  if (el) el.textContent = `${_editYield.toFixed(1)}g`;
  _syncEditRatio();
}
function _syncEditRatio() {
  const el = document.getElementById('edit-ratio-display');
  if (el) el.textContent = _editDose > 0 ? `1:${(_editYield / _editDose).toFixed(1)}` : '—';
}
function _setEditGrind(v) {
  const step = _getGrinderSteps().small;
  const rounded = Math.round(v / step) * step;
  _editGrind = Math.max(0, parseFloat(rounded.toFixed(4)));
  const el = document.getElementById('edit-grind-display');
  if (el) el.textContent = _editGrind % 1 === 0 ? String(_editGrind) : _editGrind.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}
function _setEditSteamTemp(v) {
  _editSteamTemp = Math.max(100, Math.min(165, Math.round(v)));
  const el = document.getElementById('edit-steam-temp-display');
  if (el) el.textContent = `${_editSteamTemp}°`;
}
function _setEditSteamDur(v) {
  _editSteamDur = Math.max(1, Math.min(180, Math.round(v)));
  const el = document.getElementById('edit-steam-dur-display');
  if (el) el.textContent = `${_editSteamDur}s`;
}
function _setEditHwTemp(v) {
  _editHwTemp = Math.max(50, Math.min(100, Math.round(v)));
  const el = document.getElementById('edit-hw-temp-display');
  if (el) el.textContent = `${_editHwTemp}°`;
}
function _setEditHwVol(v) {
  _editHwVol = Math.max(10, Math.min(500, Math.round(v)));
  const el = document.getElementById('edit-hw-vol-display');
  if (el) el.textContent = `${_editHwVol}ml`;
}
function _setEditGroupTemp(v) {
  _editGroupTemp = Math.max(80, Math.min(100, Math.round(v * 10) / 10));
  const el = document.getElementById('edit-group-temp-display');
  if (el) el.textContent = `${_editGroupTemp}°C`;
}

function openWorkflowEditModal(index) {
  const workflow = workflowItems[index];
  if (!workflow || !workflowEditModalEl) return;
  _clearDoseScaleState();

  _editPickedRoaster      = workflow.coffeeRoaster !== '—' ? workflow.coffeeRoaster : '';
  _editPickedBeanName     = (workflow.coffeeName && workflow.coffeeName !== '—') ? workflow.coffeeName : '';
  _editPickedBeanOrigin   = '';
  _editPickedBeanVariety  = '';
  _editPickedBeanProcess  = '';
  _editPickedBatchId      = workflow.beanBatchId  ?? null;
  _editPickedBatchRoastDate = null;
  _editPickedGrinderId    = workflow.grinderId    ?? null;
  _editPickedGrinderModel = workflow.grinderModel  !== '—' ? workflow.grinderModel  : '';
  _editTags = Array.isArray(workflow.tags) ? [...workflow.tags] : [];
  _renderTagChips(); _renderTagSuggestions();
  const tagsInputEl = document.getElementById('edit-tags-input');
  if (tagsInputEl) tagsInputEl.value = '';
  _editUseVolumeStop = workflow.useVolumeStopWhenNoScale ?? false;
  const vsToggle = document.getElementById('edit-volume-stop-toggle');
  if (vsToggle) vsToggle.checked = _editUseVolumeStop;
  updateBeanPickerDisplay();
  _resolveEditBeanDetails();
  updateGrinderPickerDisplay();
  if (_editPickedGrinderId && !_grindersCache?.find(g => g.id === _editPickedGrinderId)) {
    fetchGrinders().then(res => {
      _grindersCache = Array.isArray(res) ? res : (res?.items ?? []);
      updateGrinderPickerDisplay();
    }).catch(() => {});
  }
  document.getElementById('edit-profile').value = workflow.profileTitle !== '—' ? workflow.profileTitle : '';

  _setEditDose(Number(workflow.targetDoseWeight) || 18);
  _setEditYield(Number(workflow.targetYield)     || 36);

  const grindNum = parseFloat(String(workflow.grinderSetting));
  _setEditGrind(Number.isFinite(grindNum) ? grindNum : 16);

  const gwf = workflow.gatewayWorkflow;
  const gwProfile = (gwf?.profile && typeof gwf.profile === 'object') ? gwf.profile : null;
  _editSelectedProfileObj = gwProfile ? JSON.parse(JSON.stringify(gwProfile)) : null;
  _editSelectedProfileId = gwf?.profileId ?? null;
  _syncProfileDisplay();

  _setEditSteamTemp(steamTemp);
  _setEditSteamDur(steamDuration);
  _setEditHwTemp(NSXCore.getHotwaterTemp());
  _setEditHwVol(NSXCore.getHotwaterVolume());
  _setEditGroupTemp(Number(workflow.groupTemp || gwf?.profile?.groupTemp) || 93);

  _originalIdentity = {
    roaster: _editPickedRoaster || '—',
    bean:    _editPickedBeanName || '—',
    grinder: _editPickedGrinderModel || '—',
    profile: document.getElementById('edit-profile')?.value.trim() || '—',
  };
  document.getElementById('edit-card-bean')?.classList.remove('recipe-edit-card--identity-changed');
  document.getElementById('edit-card-grinder')?.classList.remove('recipe-edit-card--identity-changed');
  document.getElementById('edit-card-machine')?.classList.remove('recipe-edit-card--identity-changed');
  const titleEl = workflowEditModalEl.querySelector('.modal-title');
  if (titleEl) titleEl.textContent = t('recipeEdit.title');
  const saveBtn = document.getElementById('btn-edit-save');
  if (saveBtn) { saveBtn.textContent = t('action.save'); saveBtn.classList.remove('modal-btn-save--fork'); }

  workflowEditModalEl._editIndex = index;
  workflowEditModalEl.hidden = false;
}

function openWorkflowCreateModal() {
  if (!workflowEditModalEl) return;

  _originalIdentity = null;
  _editPickedRoaster      = '';
  _editPickedBeanName     = '';
  _editPickedBeanOrigin   = '';
  _editPickedBeanVariety  = '';
  _editPickedBeanProcess  = '';
  _editPickedBatchId      = null;
  _editPickedBatchRoastDate = null;
  _editPickedGrinderId    = null;
  _editPickedGrinderModel = '';
  _editSelectedProfileId  = null;
  _editSelectedProfileObj = null;
  _editTags = [];
  _renderTagChips(); _renderTagSuggestions();
  const tagsInputEl = document.getElementById('edit-tags-input');
  if (tagsInputEl) tagsInputEl.value = '';
  _editUseVolumeStop = false;
  const vsToggleCreate = document.getElementById('edit-volume-stop-toggle');
  if (vsToggleCreate) vsToggleCreate.checked = false;
  updateBeanPickerDisplay();

  const _applyAutoGrinder = (grinders) => {
    if (grinders.length === 1) {
      _editPickedGrinderId    = grinders[0].id;
      _editPickedGrinderModel = grinders[0].model || '';
    }
    updateGrinderPickerDisplay();
  };
  if (_grindersCache.length > 0) {
    _applyAutoGrinder(_grindersCache);
  } else {
    updateGrinderPickerDisplay();
    fetchGrinders().then(res => {
      const grinders = Array.isArray(res) ? res : (res?.items ?? []);
      _grindersCache = grinders;
      _applyAutoGrinder(grinders);
    }).catch(() => {});
  }
  document.getElementById('edit-profile').value = '';
  _syncProfileDisplay();

  _setEditDose(18);
  _setEditYield(36);
  _setEditGrind(10);
  _setEditGroupTemp(93);
  _setEditSteamTemp(steamTemp);
  _setEditSteamDur(steamDuration);
  _setEditHwTemp(NSXCore.getHotwaterTemp());
  _setEditHwVol(NSXCore.getHotwaterVolume());

  document.getElementById('edit-card-bean')?.classList.remove('recipe-edit-card--identity-changed');
  document.getElementById('edit-card-grinder')?.classList.remove('recipe-edit-card--identity-changed');
  document.getElementById('edit-card-machine')?.classList.remove('recipe-edit-card--identity-changed');

  const titleEl = workflowEditModalEl.querySelector('.modal-title');
  if (titleEl) titleEl.textContent = t('recipeEdit.newTitle');
  const saveBtn = document.getElementById('btn-edit-save');
  if (saveBtn) { saveBtn.textContent = t('action.create'); saveBtn.classList.remove('modal-btn-save--fork'); }

  workflowEditModalEl._editIndex = -1;
  workflowEditModalEl.hidden = false;
}

document.querySelector('.workflows-btn-add')?.addEventListener('click', openWorkflowCreateModal);

document.getElementById('btn-edit-cancel')?.addEventListener('click', () => {
  if (workflowEditModalEl) workflowEditModalEl.hidden = true;
});

workflowEditModalEl?.addEventListener('click', (e) => {
  if (e.target === workflowEditModalEl) workflowEditModalEl.hidden = true;
});

document.getElementById('edit-profile')?.addEventListener('input', _updateEditDirtyState);
document.getElementById('edit-profile')?.addEventListener('input', (e) => {
  const typed = String(e.target?.value || '').trim();
  const selectedTitle = String(_editSelectedProfileObj?.title || '').trim();
  if (typed !== selectedTitle) {
    _editSelectedProfileId = null;
    _editSelectedProfileObj = null;
  }
});

document.getElementById('edit-profile')?.addEventListener('click', () => openProfilePickerModal('recipe'));
document.getElementById('btn-edit-pick-profile')?.addEventListener('click', () => openProfilePickerModal('recipe'));

function _syncProfileDisplay() {
  const val = document.getElementById('edit-profile')?.value?.trim() || '';
  const el  = document.getElementById('edit-profile-display');
  if (el) el.textContent = val || '—';
}

document.getElementById('btn-edit-profile-info')?.addEventListener('click', async () => {
  if (_editSelectedProfileObj) {
    _openProfileInfoModal({ id: _editSelectedProfileId, profile: _editSelectedProfileObj }, true);
    return;
  }

  const title = String(document.getElementById('edit-profile')?.value || '').trim();
  if (!title) {
    showToast(t('toast.noProfile'));
    return;
  }

  try {
    const records = await _ensureProfilesLoaded();
    const match = records.find(r => String(r.profile?.title || '').trim() === title);
    if (!match) {
      showToast(t('toast.profileNotFound'));
      return;
    }
    _openProfileInfoModal(match, true);
  } catch {
    showToast(t('toast.profilesLoadFailed'));
  }
});

profilePickerListEl?.addEventListener('click', (e) => {
  const groupHeader = e.target.closest('.profile-picker-group-header');
  if (groupHeader && profilePickerListEl.contains(groupHeader)) {
    const group = groupHeader.dataset.group;
    _toggleProfileGroup(group);
    _renderProfilePickerList();
    return;
  }

  if (_profilePickerMode === 'my') {

  const favBtn = e.target.closest('.profile-picker-fav-btn');
  if (favBtn && profilePickerListEl.contains(favBtn)) {
    const id = String(favBtn.dataset.favId || '');
    if (_profileFavorites.has(id)) {
      _profileFavorites.delete(id);
    } else {
      _profileFavorites.add(id);
    }
    _saveProfileFavorites();
    _renderProfilePickerList();
    return;
  }
  }

  const item = e.target.closest('.profile-picker-item');
  if (!item || !profilePickerListEl.contains(item)) return;
  const id = item.dataset.profileId;
  const cache = _profilePickerMode === 'trash'
    ? (_deletedProfilesCache || [])
    : (_profilePickerMode === 'hidden' || _profilePickerMode === 'copy')
      ? (_profileRecordsCacheAll || _profileRecordsCache || [])
      : (_profileRecordsCache || []);
  const record = cache.find(r => String(r.id || '') === String(id || ''));
  if (!record) return;
  _profilePickerSelectedRecord = record;
  _renderProfilePickerList();
  _renderProfilePreview(record);
});

profilePickerSearchEl?.addEventListener('input', () => {
  _renderProfilePickerList();
});


profilePickerSourceEl?.addEventListener('change', () => {
  _renderProfilePickerList();
});

document.getElementById('btn-profile-picker-cancel')?.addEventListener('click', () => {
  if (profilePickerModalEl) profilePickerModalEl.hidden = true;
  if (profilePickerAddMenuEl) profilePickerAddMenuEl.hidden = true;
  const useBtn        = document.getElementById('btn-profile-picker-use');
  const emptyTrashBtn = document.getElementById('btn-profile-picker-empty-trash');
  const addBtn        = document.getElementById('btn-profile-picker-open-add');
  const cancelBtn     = document.getElementById('btn-profile-picker-cancel');
  if (useBtn)        useBtn.hidden = false;
  if (emptyTrashBtn) emptyTrashBtn.hidden = true;
  if (addBtn)        addBtn.hidden = false;
  if (cancelBtn)     cancelBtn.textContent = t('action.cancel');
});

document.getElementById('btn-profile-picker-use')?.addEventListener('click', () => {
  if (!_profilePickerSelectedRecord) {
    showToast(t('toast.selectProfile'));
    return;
  }
  _applyProfileToEditor(_profilePickerSelectedRecord);
  if (profilePickerModalEl) profilePickerModalEl.hidden = true;
});

profilePickerModalEl?.addEventListener('click', (e) => {
  if (e.target !== profilePickerModalEl) return;
  profilePickerModalEl.hidden = true;
  if (profilePickerAddMenuEl) profilePickerAddMenuEl.hidden = true;
  const useBtn    = document.getElementById('btn-profile-picker-use');
  const cancelBtn = document.getElementById('btn-profile-picker-cancel');
  if (useBtn)    useBtn.hidden = false;
  if (cancelBtn) cancelBtn.textContent = t('action.cancel');
});

document.getElementById('btn-profile-picker-open-add')?.addEventListener('click', () => {
  if (profilePickerAddMenuEl) profilePickerAddMenuEl.hidden = !profilePickerAddMenuEl.hidden;
});

document.getElementById('btn-profile-picker-open-trash')?.addEventListener('click', () => {
  if (profilePickerAddMenuEl) profilePickerAddMenuEl.hidden = true;
  _setProfilePickerMode('trash');
});


document.getElementById('btn-profile-picker-toggle-hidden')?.addEventListener('click', () => {
  _profilePickerShowHidden = !_profilePickerShowHidden;
  if (_profilePickerShowHidden) {
    _ensureProfilesWithHiddenLoaded().then(() => _renderProfilePickerList());
  }
  _updateProfilePickerToolbar();
  _renderProfilePickerList();
});

async function _purgeSelectedProfile() {
  if (!_profilePickerSelectedRecord) {
    showToast(t('toast.selectProfile'));
    return;
  }
  const record = _profilePickerSelectedRecord;
  const title = record.profile?.title || t('profileEditor.unnamed');
  if (!confirm(t('confirm.purgeProfile').replace('{name}', title))) return;
  try {
    await purgeProfile(record.id);
    _deletedProfilesCache = null;
    _profilePickerSelectedRecord = null;
    showToast(t('toast.profilePurged').replace('{name}', title));
    await _ensureDeletedProfilesLoaded();
    _renderProfilePickerList();
    _renderProfilePreview(null);
  } catch (err) {
    showToast(t('toast.deleteFailed') + ': ' + err.message);
  }
}

document.getElementById('btn-profile-picker-empty-trash')?.addEventListener('click', async () => {
  const records = _deletedProfilesCache || [];
  if (!records.length) { showToast(t('toast.trashEmpty')); return; }
  if (!confirm(t('confirm.emptyTrash').replace('{count}', records.length))) return;
  let failed = 0;
  for (const record of records) {
    try { await purgeProfile(record.id); } catch { failed++; }
  }
  _deletedProfilesCache = null;
  _profilePickerSelectedRecord = null;
  await _ensureDeletedProfilesLoaded();
  _renderProfilePickerList();
  _renderProfilePreview(null);
  showToast(t('toast.trashEmpty'));
});

document.getElementById('btn-profile-picker-new-empty')?.addEventListener('click', () => {
  if (profilePickerAddMenuEl) profilePickerAddMenuEl.hidden = true;
  _openNewProfileFromScratch();
});

document.getElementById('btn-profile-picker-new-preset')?.addEventListener('click', () => {
  if (profilePickerAddMenuEl) profilePickerAddMenuEl.hidden = true;
  _setProfilePickerMode('copy');
});

document.getElementById('btn-profile-picker-import-file')?.addEventListener('click', () => {
  if (profilePickerAddMenuEl) profilePickerAddMenuEl.hidden = true;
  document.getElementById('profile-import-file-input')?.click();
});

document.getElementById('btn-profile-picker-import-visualizer')?.addEventListener('click', () => {
  if (profilePickerAddMenuEl) profilePickerAddMenuEl.hidden = true;
  const modal = document.getElementById('visualizer-import-modal');
  const input = document.getElementById('visualizer-import-input');
  if (!modal || !input) return;
  input.value = '';
  modal.hidden = false;
  setTimeout(() => input.focus(), 50);
});

document.getElementById('profile-import-file-input')?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  e.target.value = '';
  if (!file) return;
  try {
    const text = await file.text();
    const json = JSON.parse(text);

    // Accept both raw profile object and bridge-wrapped format { profile: {...} }
    const profileData = json?.profile && typeof json.profile === 'object' ? json.profile : json;

    if (!profileData || typeof profileData !== 'object') throw new Error('Invalid JSON structure');
    if (!Array.isArray(profileData.steps) && !Array.isArray(profileData.frames)) {
      throw new Error('No steps found');
    }

    const title = String(profileData.title || '').trim() || file.name.replace(/\.json$/i, '');

    const payload = {
      profile: { ...profileData, title },
      parentId: null,
      metadata: { source: 'user' },
    };

    const saved = await saveProfile(null, payload);
    if (saved?.id && saved?.visibility === 'deleted') {
      await setProfileVisibility(saved.id, 'visible').catch(() => {});
    }

    _profileRecordsCache = null;
    await _ensureProfilesLoaded(true);
    _setProfilePickerMode('my');

    const newRecord = _normalizeProfileRecord(saved);
    if (newRecord) {
      const { group } = _profileGroupOf(newRecord.profile?.title || '');
      if (group) _expandProfileGroup(group);
      _profilePickerSelectedRecord = newRecord;
      _renderProfilePickerList();
      _renderProfilePreview(newRecord);
    }

    showToast(t('toast.profileImported').replace('{name}', title));
  } catch (err) {
    showToast(t('toast.profileImportFailed').replace('{error}', err.message));
  }
});

async function _importFromVisualizer(shareCode) {
  const code = shareCode.trim().toUpperCase();
  if (!code) return;

  // Step 1: resolve share code → shot ID
  const sharedRes = await fetch(`https://visualizer.coffee/api/shots/shared?code=${encodeURIComponent(code)}`);
  if (sharedRes.status === 404) throw new Error(t('toast.visualizerNotFound'));
  if (!sharedRes.ok) throw new Error(`Visualizer ${sharedRes.status}`);
  const sharedJson = await sharedRes.json();
  const shotId = sharedJson?.id;
  if (!shotId) throw new Error(t('toast.visualizerNotFound'));

  // Step 2: fetch profile JSON for that shot
  const profileRes = await fetch(`https://visualizer.coffee/api/shots/${encodeURIComponent(shotId)}/profile?format=json`);
  if (!profileRes.ok) throw new Error(`Visualizer profile ${profileRes.status}`);
  const json = await profileRes.json();
  const profileData = json?.profile && typeof json.profile === 'object' ? json.profile : json;
  if (!profileData || typeof profileData !== 'object') throw new Error('Invalid response');
  if (!Array.isArray(profileData.steps) && !Array.isArray(profileData.frames)) throw new Error('No steps found');

  const title = String(profileData.title || '').trim() || code;
  const payload = { profile: { ...profileData, title }, parentId: null, metadata: { source: 'user' } };
  const saved = await saveProfile(null, payload);
  if (saved?.id && saved?.visibility === 'deleted') {
    await setProfileVisibility(saved.id, 'visible').catch(() => {});
  }
  _profileRecordsCache = null;
  await _ensureProfilesLoaded(true);
  _setProfilePickerMode('my');
  const newRecord = _normalizeProfileRecord(saved);
  if (newRecord) {
    const { group } = _profileGroupOf(newRecord.profile?.title || '');
    if (group) _expandProfileGroup(group);
    _profilePickerSelectedRecord = newRecord;
    _renderProfilePickerList();
    _renderProfilePreview(newRecord);
  }
  showToast(t('toast.profileImported').replace('{name}', title));
}

(function () {
  const modal = document.getElementById('visualizer-import-modal');
  const input = document.getElementById('visualizer-import-input');
  const okBtn = document.getElementById('btn-visualizer-import-ok');
  const cancelBtn = document.getElementById('btn-visualizer-import-cancel');
  if (!modal || !input || !okBtn || !cancelBtn) return;

  function closeModal() { modal.hidden = true; }

  cancelBtn.addEventListener('click', closeModal);
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

  async function doImport() {
    const code = input.value.trim();
    if (!code) return;
    closeModal();
    try {
      await _importFromVisualizer(code);
    } catch (err) {
      showToast(t('toast.profileImportFailed').replace('{error}', err.message));
    }
  }

  okBtn.addEventListener('click', doImport);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') doImport(); });
})();

document.getElementById('btn-profile-picker-back-my')?.addEventListener('click', () => {
  _setProfilePickerMode('my');
});

document.getElementById('btn-profile-info-back')?.addEventListener('click', () => {
  if (profileInfoModalEl) profileInfoModalEl.hidden = true;
});

document.getElementById('btn-profile-info-use')?.addEventListener('click', () => {
  if (!_profilePickerSelectedRecord) {
    if (_editSelectedProfileObj && profileInfoModalEl) {
      profileInfoModalEl.hidden = true;
      return;
    }
    showToast(t('toast.selectProfileFirst'));
    return;
  }
  _applyProfileToEditor(_profilePickerSelectedRecord);
  if (profileInfoModalEl) profileInfoModalEl.hidden = true;
  if (profilePickerModalEl) profilePickerModalEl.hidden = true;
});

profileInfoModalEl?.addEventListener('click', (e) => {
  if (e.target === profileInfoModalEl) profileInfoModalEl.hidden = true;
});

document.getElementById('btn-edit-dose-down')?.addEventListener('click',          () => _setEditDose(_editDose - 0.1));
document.getElementById('btn-edit-dose-up')?.addEventListener('click',            () => _setEditDose(_editDose + 0.1));
document.getElementById('btn-edit-dose-down-big')?.addEventListener('click',      () => _setEditDose(_editDose - 1));
document.getElementById('btn-edit-dose-up-big')?.addEventListener('click',        () => _setEditDose(_editDose + 1));
document.getElementById('btn-edit-yield-down')?.addEventListener('click',         () => _setEditYield(_editYield - 1));
document.getElementById('btn-edit-yield-up')?.addEventListener('click',           () => _setEditYield(_editYield + 1));
document.getElementById('btn-edit-yield-down-big')?.addEventListener('click',     () => _setEditYield(_editYield - 10));
document.getElementById('btn-edit-yield-up-big')?.addEventListener('click',       () => _setEditYield(_editYield + 10));
document.getElementById('btn-edit-grind-down')?.addEventListener('click',         () => _setEditGrind(_editGrind - _getGrinderSteps().small));
document.getElementById('btn-edit-grind-up')?.addEventListener('click',           () => _setEditGrind(_editGrind + _getGrinderSteps().small));
document.getElementById('btn-edit-grind-down-big')?.addEventListener('click',     () => _setEditGrind(_editGrind - _getGrinderSteps().big));
document.getElementById('btn-edit-grind-up-big')?.addEventListener('click',       () => _setEditGrind(_editGrind + _getGrinderSteps().big));
document.getElementById('btn-edit-steam-temp-down')?.addEventListener('click', () => _setEditSteamTemp(_editSteamTemp - 5));
document.getElementById('btn-edit-steam-temp-up')?.addEventListener('click',   () => _setEditSteamTemp(_editSteamTemp + 5));
document.getElementById('btn-edit-steam-dur-down')?.addEventListener('click',  () => _setEditSteamDur(_editSteamDur - 5));
document.getElementById('btn-edit-steam-dur-up')?.addEventListener('click',    () => _setEditSteamDur(_editSteamDur + 5));
document.getElementById('btn-edit-hw-temp-down')?.addEventListener('click',    () => _setEditHwTemp(_editHwTemp - 5));
document.getElementById('btn-edit-hw-temp-up')?.addEventListener('click',      () => _setEditHwTemp(_editHwTemp + 5));
document.getElementById('btn-edit-hw-vol-down')?.addEventListener('click',     () => _setEditHwVol(_editHwVol - 10));
document.getElementById('btn-edit-hw-vol-up')?.addEventListener('click',       () => _setEditHwVol(_editHwVol + 10));
document.getElementById('btn-edit-group-temp-down')?.addEventListener('click',     () => _setEditGroupTemp(_editGroupTemp - 1));
document.getElementById('btn-edit-group-temp-up')?.addEventListener('click',       () => _setEditGroupTemp(_editGroupTemp + 1));
document.getElementById('btn-edit-group-temp-down-big')?.addEventListener('click', () => _setEditGroupTemp(_editGroupTemp - 10));
document.getElementById('btn-edit-group-temp-up-big')?.addEventListener('click',   () => _setEditGroupTemp(_editGroupTemp + 10));

/* ── Tap-to-edit for Recipe Edit display values ─────── */
document.getElementById('edit-dose-display')?.addEventListener('click', () =>
  openNumberPicker(_npMakeRange(0, 30, 0.1), _editDose, v => _setEditDose(v), 1));
document.getElementById('edit-yield-display')?.addEventListener('click', () =>
  openNumberPicker(_npMakeRange(0, 200, 1), _editYield, v => _setEditYield(v)));
document.getElementById('edit-group-temp-display')?.addEventListener('click', () =>
  openNumberPicker(_npMakeRange(80, 100, 1), _editGroupTemp, v => _setEditGroupTemp(v)));
document.getElementById('edit-grind-display')?.addEventListener('click', () => {
  const step = _getGrinderSteps().small;
  const dp = step < 1 ? Math.ceil(-Math.log10(step)) : 0;
  openNumberPicker(_npMakeRange(0, 200, step), _editGrind, v => _setEditGrind(v), dp);
});

document.getElementById('btn-edit-save')?.addEventListener('click', async () => {
  if (!workflowEditModalEl) return;
  const index = workflowEditModalEl._editIndex;
  const isCreate = index === -1;
  if (!isCreate && (!Number.isInteger(index) || !workflowItems[index])) return;

  const roaster = _editPickedRoaster      || '—';
  const bean    = _editPickedBeanName     || '—';
  const grinder = _editPickedGrinderModel || '—';
  const profile = document.getElementById('edit-profile').value.trim() || '—';
  const dose    = _editDose;
  const yield_  = _editYield;
  const setting = _editGrind % 1 === 0 ? String(_editGrind) : _editGrind.toFixed(1);
  const ratio   = dose > 0 ? `1:${(yield_ / dose).toFixed(1)}` : '—';

  const original = isCreate ? {} : workflowItems[index];

  const updated = {
    id:            original.id || _makeRecipeId(),
    lastUsed:      isCreate ? Date.now() : (original.lastUsed || 0),
    coffeeRoaster: roaster,
    coffeeName:    bean,
    beanBatchId:   _editPickedBatchId ?? original.beanBatchId ?? null,
    grinderId:     _editPickedGrinderId ?? original.grinderId ?? null,
    grinderModel:  grinder,
    grinderSetting: setting,
    targetDoseWeight: dose,
    targetYield:   yield_,
    profileTitle:  profile,
    selectedProfileId: _editSelectedProfileId ?? original.selectedProfileId ?? null,
    ratio,
    groupTemp:     _editGroupTemp,
    tags:          [..._editTags],
    useVolumeStopWhenNoScale: _editUseVolumeStop,
    volumeCalibration: (!isCreate && _editSelectedProfileId && _editSelectedProfileId !== (original.selectedProfileId ?? null))
      ? { factor: 1.0, samples: [] }
      : (original.volumeCalibration ?? { factor: 1.0, samples: [] }),
  };

  workflowEditModalEl.hidden = true;

  if (isCreate) {
    workflowItems = workflowItems.filter(w => !w.isPending);
    workflowItems.unshift(updated);
    selectedWorkflowIndex = 0;
  } else {
    workflowItems[index] = updated;
  }

  await _saveRecipesToStore(workflowItems);

  renderWorkflows(getDisplayWorkflows(), selectedWorkflowIndex);
  renderHomeRecentRecipes();
  const activeIndex = isCreate ? 0 : index;
  if (activeIndex === selectedWorkflowIndex) {
    setCurrentWorkflow(workflowItems[activeIndex]);
    plotWorkflowShot(workflowItems[activeIndex]);
    pushSelectedWorkflowToMachine(workflowItems[activeIndex]);
  }
});

/* ── Bean Picker (Rezept) ─────────────────────────────── */

function _renderVolumeStopStatus(calibration) {
  const el = document.getElementById('edit-volume-stop-status');
  if (!el) return;
  const samples = calibration?.samples;
  if (!samples || samples.length === 0) {
    el.textContent = t('recipeEdit.calibNotCalibrated');
    el.className = 'recipe-edit-calib-status recipe-edit-calib-status--uncalibrated';
  } else if (samples.length < 3) {
    el.textContent = t('recipeEdit.calibWarning');
    el.className = 'recipe-edit-calib-status recipe-edit-calib-status--warning';
  } else {
    const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
    el.textContent = t('recipeEdit.calibOk')
      .replace('{n}', String(samples.length))
      .replace('{f}', avg.toFixed(2));
    el.className = 'recipe-edit-calib-status recipe-edit-calib-status--ok';
  }
}

function _renderTagSuggestions() {
  const container = document.getElementById('edit-tags-suggestions');
  if (!container) return;
  const allTags = [...new Set(workflowItems.flatMap(w => Array.isArray(w.tags) ? w.tags : []))];
  const suggestions = allTags.filter(t => !_editTags.includes(t));
  container.innerHTML = '';
  suggestions.forEach(tag => {
    const chip = document.createElement('span');
    chip.className = 'recipe-edit-tag-suggestion';
    chip.textContent = tag;
    chip.addEventListener('click', () => { _addTag(tag); });
    container.appendChild(chip);
  });
}

function _renderTagChips() {
  const container = document.getElementById('edit-tags-chips');
  if (!container) return;
  container.innerHTML = '';
  _editTags.forEach((tag, i) => {
    const chip = document.createElement('span');
    chip.className = 'recipe-edit-tag-chip';
    chip.textContent = tag;
    const removeBtn = document.createElement('button');
    removeBtn.className = 'recipe-edit-tag-remove';
    removeBtn.type = 'button';
    removeBtn.innerHTML = '&times;';
    removeBtn.addEventListener('click', () => {
      _editTags.splice(i, 1);
      _renderTagChips(); _renderTagSuggestions();
    });
    chip.appendChild(removeBtn);
    container.appendChild(chip);
  });
}

function _addTag(value) {
  const tag = value.trim().replace(/,+$/, '').trim();
  if (!tag || _editTags.includes(tag)) return;
  _editTags.push(tag);
  _renderTagChips(); _renderTagSuggestions();
}

(function () {
  const input = document.getElementById('edit-tags-input');
  if (!input) return;
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      _addTag(input.value);
      input.value = '';
    } else if (e.key === 'Backspace' && input.value === '' && _editTags.length) {
      _editTags.pop();
      _renderTagChips(); _renderTagSuggestions();
    }
  });
  input.addEventListener('blur', () => {
    if (input.value.trim()) {
      _addTag(input.value);
      input.value = '';
    }
  });
})();

document.getElementById('edit-volume-stop-toggle')?.addEventListener('change', e => {
  _editUseVolumeStop = e.target.checked;
});

function _renderVsInfoBody() {
  const body = document.getElementById('virtual-scale-info-body');
  if (!body) return;
  const workflow = workflowItems[workflowEditModalEl?._editIndex ?? -1];
  const samples = workflow?.volumeCalibration?.samples ?? [];
  let html = `<p style="margin:0 0 10px">${t('virtualScale.infoDesc')}</p>`;
  if (samples.length === 0) {
    html += `<p style="margin:0;opacity:.7">${t('virtualScale.infoNotCalibrated')}</p>`;
  } else {
    const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
    html += `<p style="margin:0"><strong>${t('virtualScale.infoFactor')}:</strong> ${avg.toFixed(3)} ml/g</p>`;
    html += `<p style="margin:4px 0 0;opacity:.7">${t('virtualScale.infoSamples').replace('{n}', String(samples.length))}</p>`;
  }
  body.innerHTML = html;
}

document.getElementById('btn-virtual-scale-info')?.addEventListener('click', () => {
  const modal = document.getElementById('virtual-scale-info-modal');
  if (!modal) return;
  _renderVsInfoBody();
  modal.hidden = false;
});

document.getElementById('btn-virtual-scale-reset')?.addEventListener('click', () => {
  const idx = workflowEditModalEl?._editIndex ?? -1;
  if (idx < 0 || !workflowItems[idx]) return;
  workflowItems[idx] = { ...workflowItems[idx], volumeCalibration: { factor: 1.0, samples: [] } };
  _saveRecipesToStore(workflowItems).catch(() => {});
  _renderVsInfoBody();
});

document.getElementById('btn-virtual-scale-info-close')?.addEventListener('click', () => {
  document.getElementById('virtual-scale-info-modal').hidden = true;
});
document.getElementById('virtual-scale-info-modal')?.addEventListener('click', e => {
  if (e.target === document.getElementById('virtual-scale-info-modal'))
    document.getElementById('virtual-scale-info-modal').hidden = true;
});

function updateBeanPickerDisplay() {
  const set = (id, val) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val || '—';
  };
  set('edit-bean-display-roaster',  _editPickedRoaster);
  set('edit-bean-display-name',     _editPickedBeanName);
  set('edit-bean-display-origin',   _editPickedBeanOrigin);
  set('edit-bean-display-variety',  _editPickedBeanVariety);
  set('edit-bean-display-process',  _editPickedBeanProcess);
  _refreshEditBeanRoastDate();
  _updateEditDirtyState();
}

async function _resolveEditBeanDetails() {
  if (!_editPickedRoaster && !_editPickedBeanName) return;
  let bean = _beanManagerAllBeans.find(b =>
    b.roaster === _editPickedRoaster && b.name === _editPickedBeanName
  );
  if (!bean) {
    try {
      const data = await fetchBeans(true);
      const list = Array.isArray(data) ? data : (data?.items ?? []);
      bean = list.find(b => b.roaster === _editPickedRoaster && b.name === _editPickedBeanName);
    } catch { /* ignore */ }
  }
  if (bean) {
    _editPickedBeanOrigin  = bean.country      || '';
    _editPickedBeanVariety = Array.isArray(bean.variety) ? bean.variety.join(', ') : (bean.variety || '');
    _editPickedBeanProcess = bean.processing   || '';
  }
  if (_editPickedBatchId && !_editPickedBatchRoastDate) {
    try {
      const batch = await fetchBatch(String(_editPickedBatchId));
      if (batch?.roastDate) _editPickedBatchRoastDate = batch.roastDate;
    } catch { /* ignore */ }
  }
  updateBeanPickerDisplay();
}

function _refreshEditBeanRoastDate() {
  const el = document.getElementById('edit-bean-display-roastdate');
  if (!el) return;
  if (!_editPickedBatchRoastDate) { el.textContent = '—'; return; }
  const d = new Date(_editPickedBatchRoastDate);
  if (Number.isNaN(d.getTime())) { el.textContent = '—'; return; }
  const locale = getLang?.() === 'en' ? 'en-US' : 'de-DE';
  const dateStr = d.toLocaleDateString(locale, { day: '2-digit', month: '2-digit', year: '2-digit' });
  el.textContent = `${dateStr} (${formatBatchAge(_editPickedBatchRoastDate)})`;
}

function _setEditBeanAgeMessage(text, hidden = false) {
  const ageEl = document.getElementById('edit-bean-age-message');
  if (!ageEl) return;
  ageEl.hidden = !!hidden;
  ageEl.textContent = hidden ? '' : String(text || '');
}

async function _resolveSelectedBatchRoastDate() {
  if (!_editPickedBatchId) return null;
  const wantedId = String(_editPickedBatchId);

  // Direct fetch by ID — works regardless of bean name or archived state
  try {
    const batch = await fetchBatch(wantedId);
    if (batch?.roastDate) return batch.roastDate;
  } catch {
    // batch not found or API error — fall through
  }

  return null;
}

async function _refreshEditBeanAgeMessage() {
  if (!_editPickedBeanName || !_editPickedBatchId) {
    _setEditBeanAgeMessage('', true);
    return;
  }

  if (_editPickedBatchRoastDate) {
    _setEditBeanAgeMessage(t('beanEditor.age').replace('{age}', formatBatchAge(_editPickedBatchRoastDate)));
    return;
  }

  const requestId = ++_editBeanAgeRequestId;
  _setEditBeanAgeMessage(t('beanEditor.ageLoading'));
  const roastDate = await _resolveSelectedBatchRoastDate();
  if (requestId !== _editBeanAgeRequestId) return;

  if (roastDate) {
    _editPickedBatchRoastDate = roastDate;
    _setEditBeanAgeMessage(t('beanEditor.age').replace('{age}', formatBatchAge(roastDate)));
  } else {
    _setEditBeanAgeMessage(t('beanEditor.ageUnknown'));
  }
}

function updateGrinderPickerDisplay() {
  const nameEl     = document.getElementById('edit-grinder-display-name');
  const burrsEl    = document.getElementById('edit-grinder-display-burrs');
  const burrsizeEl = document.getElementById('edit-grinder-display-burrsize');
  const g = _grindersCache?.find(g => g.id === _editPickedGrinderId);
  if (nameEl) nameEl.textContent = _editPickedGrinderModel || '—';
  if (burrsEl) burrsEl.textContent = g?.burrs || '—';
  if (burrsizeEl) burrsizeEl.textContent = g?.burrSize ? `${g.burrSize} mm` : '—';
  _updateEditDirtyState();
}

function _updateEditDirtyState() {
  if (!_originalIdentity) return;
  const grinder = _editPickedGrinderModel || '—';
  const profile = document.getElementById('edit-profile')?.value.trim() || '—';
  const roaster = _editPickedRoaster || '—';
  const bean    = _editPickedBeanName || '—';

  const beanChanged    = roaster !== _originalIdentity.roaster || bean !== _originalIdentity.bean;
  const grinderChanged = grinder !== _originalIdentity.grinder;
  const profileChanged = profile !== _originalIdentity.profile;
  const anyIdentityChanged = beanChanged || grinderChanged || profileChanged;

  document.getElementById('edit-card-bean')?.classList.toggle('recipe-edit-card--identity-changed', beanChanged);
  document.getElementById('edit-card-grinder')?.classList.toggle('recipe-edit-card--identity-changed', grinderChanged);
  document.getElementById('edit-card-machine')?.classList.toggle('recipe-edit-card--identity-changed', profileChanged);

  const saveBtn = document.getElementById('btn-edit-save');
  if (saveBtn) {
    saveBtn.textContent = t('action.save');
    saveBtn.classList.remove('modal-btn-save--fork');
  }
}


document.getElementById('btn-edit-pick-bean')?.addEventListener('click', () => {
  openBeanManagerModal((bean, batch) => {
    _editPickedBatchId        = batch.id;
    _editPickedBatchRoastDate = batch.roastDate || null;
    _editPickedRoaster        = bean.roaster   || '';
    _editPickedBeanName       = bean.name      || '';
    _editPickedBeanOrigin     = bean.country   || '';
    _editPickedBeanVariety    = Array.isArray(bean.variety) ? bean.variety.join(', ') : (bean.variety || '');
    _editPickedBeanProcess    = bean.processing || '';
    updateBeanPickerDisplay();
    if (beanManagerModalEl) beanManagerModalEl.hidden = true;
  });
});

/* ── Grinder Picker (Rezept) ──────────────────────────── */

function openGrinderPickerModal() {
  const modal = document.getElementById('grinder-picker-modal');
  if (!modal) return;
  _loadAndRenderGrinderPickerList();
  modal.hidden = false;
}

async function _loadAndRenderGrinderPickerList() {
  const listEl = document.getElementById('grinder-picker-list');
  if (!listEl) return;
  listEl.innerHTML = `<div class="bohnen-empty-state">${t('status.loading')}</div>`;
  try {
    const grinders = await fetchGrinders();
    _renderGrinderPickerTiles(Array.isArray(grinders) ? grinders : (grinders?.items ?? []));
  } catch {
    listEl.innerHTML = `<div class="bohnen-empty-state">${t('status.loadFailed')}</div>`;
  }
}

function _renderGrinderPickerTiles(grinders) {
  _grindersCache = Array.isArray(grinders) ? grinders : [];
  const listEl = document.getElementById('grinder-picker-list');
  if (!listEl) return;
  if (!Array.isArray(grinders) || grinders.length === 0) {
    listEl.innerHTML = `<div class="bohnen-empty-state">${t('status.noGrinders')}</div>`;
    return;
  }
  listEl.innerHTML = '<div class="bean-tile-grid"></div>';
  const grid = listEl.querySelector('.bean-tile-grid');
  for (const g of grinders) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'bean-tile';
    const row = (label, value) => value && value !== '—'
      ? `<span class="bean-detail-label">${label}</span><span class="bean-detail-value">${value}</span>` : '';
    const burrTypeLabel    = g.burrType === 'conical' ? t('grinderEditor.conical') : g.burrType === 'flat' ? t('grinderEditor.flat') : '';
    const settingTypeLabel = g.settingType === 'preset' ? t('grinderEditor.positions') : t('grinderEditor.stepless');
    tile.innerHTML = `
      <span class="bean-tile-name">${g.model || '—'}</span>
      <hr class="bean-tile-divider">
      <div class="bean-tile-details grinder-tile-details">
        <div class="grinder-tile-meta">
          ${row(t('grinderEditor.burrs'), g.burrs)}
          ${row(t('grinderEditor.burrSize'), g.burrSize ? `${g.burrSize} mm` : '')}
          ${row(t('grinderEditor.type'), burrTypeLabel)}
          ${row(t('grinderEditor.setting'), settingTypeLabel)}
        </div>
      </div>`;
    tile.addEventListener('click', () => {
      _editPickedGrinderId    = g.id;
      _editPickedGrinderModel = g.model || '';
      updateGrinderPickerDisplay();
      const modal = document.getElementById('grinder-picker-modal');
      if (modal) modal.hidden = true;
    });
    grid.appendChild(tile);
  }
}

document.getElementById('btn-grinder-picker-cancel')?.addEventListener('click', () => {
  const modal = document.getElementById('grinder-picker-modal');
  if (modal) modal.hidden = true;
});

document.getElementById('grinder-picker-modal')?.addEventListener('click', (e) => {
  if (e.target === document.getElementById('grinder-picker-modal'))
    document.getElementById('grinder-picker-modal').hidden = true;
});

document.getElementById('btn-edit-pick-grinder')?.addEventListener('click', openGrinderPickerModal);

/* ── Bohnen Modal ─────────────────────────────────────── */

const batchAddModalEl = document.getElementById('batch-add-modal');
const batchDatePickerModalEl = document.getElementById('batch-date-picker-modal');
const _getMonthName = (month1Based) =>
  new Intl.DateTimeFormat(getLang?.() === 'en' ? 'en-US' : 'de-DE', { month: 'long' })
    .format(new Date(2000, month1Based - 1));
let _editingBean = null;
let _allBeans = [];
let _editingBatch = null;
let _lastBatches = [];
let _batchDateDraft = null;
let _batchDateViewYear = 0;
let _batchDateViewMonth = 0;
let _batchDatePickerOnApply = null;

// Rubber-band overscroll — same pattern as the workflow list
;(() => {
  const el = document.getElementById('bohnen-panel-beziehbar');
  if (!el) return;
  let startY = 0;
  let active = false;

  el.addEventListener('touchstart', e => {
    startY = e.touches[0].clientY;
    active = true;
    el.style.transition = '';
  }, { passive: true });

  el.addEventListener('touchmove', e => {
    if (!active) return;
    const dy = e.touches[0].clientY - startY;
    const atTop    = el.scrollTop <= 0;
    const atBottom = el.scrollTop >= el.scrollHeight - el.clientHeight - 1;
    if ((atTop && dy > 0) || (atBottom && dy < 0)) {
      el.style.transform = `translateY(${dy * 0.28}px)`;
    } else {
      el.style.transform = '';
    }
  }, { passive: true });

  const release = () => {
    if (!active) return;
    active = false;
    el.style.transition = 'transform 440ms cubic-bezier(0.23, 1, 0.32, 1)';
    el.style.transform = 'translateY(0)';
    el.addEventListener('transitionend', () => { el.style.transition = ''; }, { once: true });
  };

  el.addEventListener('touchend',   release, { passive: true });
  el.addEventListener('touchcancel', release, { passive: true });
})();

function createBeanTile(bean, onBeanClick) {
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'bean-tile';
  const varietyStr = Array.isArray(bean.variety) && bean.variety.length ? bean.variety.join(', ') : '—';
  const altitudeStr = Array.isArray(bean.altitude) && bean.altitude.length === 2
    ? `${bean.altitude[0]}–${bean.altitude[1]} m` : '—';
  const row = (label, value) => value && value !== '—'
    ? `<span class="bean-detail-label">${label}</span><span class="bean-detail-value">${value}</span>` : '';
  tile.innerHTML = `
    <span class="bean-tile-name">${bean.name || '—'}</span>
    <hr class="bean-tile-divider">
    <div class="bean-tile-details">
      ${row(t('beanEditor.roaster'), bean.roaster)}
      ${row(t('beanEditor.origin'), bean.country)}
      ${row(t('beanEditor.variety'), varietyStr !== '—' ? varietyStr : '')}
      ${row(t('beanEditor.process'), bean.processing)}
      ${row(t('beanEditor.altitudeLabel'), altitudeStr !== '—' ? altitudeStr : '')}
    </div>
  `;
  tile.addEventListener('click', () => { if (onBeanClick) onBeanClick(bean); });
  return tile;
}

function renderBeanFolderView(roasterMap, ungrouped, panelEl, onBeanClick) {
  panelEl.innerHTML = '<div class="bean-tile-grid"></div>';
  const grid = panelEl.querySelector('.bean-tile-grid');
  const sorted = [...roasterMap.entries()].sort((a, b) => a[0].localeCompare(b[0], 'de'));
  for (const [roaster, beans] of sorted) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'bean-tile bean-folder-tile';
    tile.innerHTML = `
      <div class="bean-folder-top">
        <svg class="bean-folder-icon" width="22" height="18" viewBox="0 0 22 18" fill="none" aria-hidden="true">
          <path d="M1 4.5C1 3.4 1.9 2.5 3 2.5H8.6C9.1 2.5 9.6 2.7 10 3.1L11.4 4.5H19C20.1 4.5 21 5.4 21 6.5V14.5C21 15.6 20.1 16.5 19 16.5H3C1.9 16.5 1 15.6 1 14.5V4.5Z" fill="currentColor" fill-opacity="0.2" stroke="currentColor" stroke-opacity="0.5" stroke-width="1"/>
        </svg>
        <span class="bean-folder-count">${beans.length}</span>
      </div>
      <span class="bean-tile-name">${roaster}</span>
    `;
    tile.addEventListener('click', () => renderBeanRoasterView(roaster, beans, roasterMap, ungrouped, panelEl, onBeanClick));
    grid.appendChild(tile);
  }
  for (const bean of ungrouped) {
    grid.appendChild(createBeanTile(bean, onBeanClick));
  }
}

function renderBeanRoasterView(roaster, beans, roasterMap, ungrouped, panelEl, onBeanClick) {
  panelEl.innerHTML = '';
  const backBar = document.createElement('div');
  backBar.className = 'bean-panel-back-bar';
  backBar.innerHTML = `
    <button type="button" class="bean-back-btn" aria-label="${t('action.back')}">
      <svg width="8" height="13" viewBox="0 0 8 13" fill="none" aria-hidden="true">
        <path d="M7 1L1 6.5L7 12" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>
    <span class="bean-back-title">${roaster}</span>
  `;
  backBar.querySelector('.bean-back-btn').addEventListener('click', () => renderBeanFolderView(roasterMap, ungrouped, panelEl, onBeanClick));
  panelEl.appendChild(backBar);
  const grid = document.createElement('div');
  grid.className = 'bean-tile-grid';
  for (const bean of beans) {
    grid.appendChild(createBeanTile(bean, onBeanClick));
  }
  panelEl.appendChild(grid);
}

function groupBeansByRoaster(beans) {
  const roasterMap = new Map();
  const ungrouped = [];
  for (const bean of beans) {
    if (bean.roaster) {
      if (!roasterMap.has(bean.roaster)) roasterMap.set(bean.roaster, []);
      roasterMap.get(bean.roaster).push(bean);
    } else {
      ungrouped.push(bean);
    }
  }
  return { roasterMap, ungrouped };
}

function renderBeanTiles(beans) {
  const panel = document.getElementById('bohnen-panel-beziehbar');
  if (!panel) return;
  if (!Array.isArray(beans) || beans.length === 0) {
    panel.innerHTML = '<div class="bohnen-empty-state">Keine Bohnen vorhanden</div>';
    return;
  }
  const { roasterMap, ungrouped } = groupBeansByRoaster(beans);
  renderBeanFolderView(roasterMap, ungrouped, panel);
}

/* ── Field Picker ──────────────────────────────────────── */
let _fieldPickerTarget = null;
let _fieldPickerAllOptions = [];
let _fieldPickerOnConfirm = null;

function _beanPickerOptions() {
  const uniq = (arr) => [...new Set(arr.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de'));
  return {
    'bean-roaster':    uniq(_allBeans.map(b => b.roaster)),
    'bean-country':    uniq(_allBeans.map(b => b.country)),
    'bean-processing': uniq(_allBeans.map(b => b.processing)),
    'bean-variety':    uniq(_allBeans.flatMap(b => Array.isArray(b.variety) ? b.variety : [])),
  };
}

function _renderFieldPickerList(filter) {
  const list = document.getElementById('field-picker-list');
  const pickerInput = document.getElementById('field-picker-input');
  if (!list) return;
  const q = filter.toLowerCase().trim();
  const current = pickerInput?.value ?? '';
  const filtered = q ? _fieldPickerAllOptions.filter(o => o.toLowerCase().includes(q)) : _fieldPickerAllOptions;
  list.innerHTML = filtered.map(o =>
    `<button type="button" class="field-picker-option${o === current ? ' is-selected' : ''}" data-value="${o.replace(/&/g,'&amp;').replace(/"/g,'&quot;')}">${o.replace(/&/g,'&amp;').replace(/</g,'&lt;')}</button>`
  ).join('');
  list.querySelectorAll('.field-picker-option').forEach(btn => {
    btn.addEventListener('click', () => {
      if (pickerInput) {
        pickerInput.value = btn.dataset.value;
        _renderFieldPickerList(btn.dataset.value);
      }
    });
  });
}

function openFieldPicker(inputEl, options, { inputMode = 'text', onConfirm = null, initialValue = null } = {}) {
  _fieldPickerTarget = inputEl;
  _fieldPickerOnConfirm = onConfirm;
  _fieldPickerAllOptions = options;
  const modal = document.getElementById('field-picker-modal');
  const pickerInput = document.getElementById('field-picker-input');
  if (!modal || !pickerInput) return;
  pickerInput.setAttribute('inputmode', inputMode);
  pickerInput.value = initialValue !== null ? String(initialValue) : (inputEl?.value || '');
  _renderFieldPickerList(pickerInput.value);
  modal.hidden = false;
  setTimeout(() => { pickerInput.focus(); pickerInput.select(); }, 60);
}

function closeFieldPicker(confirm) {
  const modal = document.getElementById('field-picker-modal');
  const pickerInput = document.getElementById('field-picker-input');
  if (confirm) {
    if (_fieldPickerOnConfirm && pickerInput) {
      _fieldPickerOnConfirm(pickerInput.value);
    } else if (_fieldPickerTarget && pickerInput) {
      _fieldPickerTarget.value = pickerInput.value;
      _fieldPickerTarget.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }
  if (modal) modal.hidden = true;
  _fieldPickerTarget = null;
  _fieldPickerOnConfirm = null;
}

document.getElementById('btn-field-picker-cancel')?.addEventListener('click', () => closeFieldPicker(false));
document.getElementById('btn-field-picker-confirm')?.addEventListener('click', () => closeFieldPicker(true));
document.getElementById('field-picker-input')?.addEventListener('input', (e) => _renderFieldPickerList(e.target.value));

/* ── Generic Search Input Modal ──────────────────────────── */
let _searchInputTarget = null;

function openSearchInputModal(inputEl) {
  _searchInputTarget = inputEl;
  const modal = document.getElementById('search-input-modal');
  const searchInput = document.getElementById('search-input-field');
  if (!modal || !searchInput) return;
  searchInput.value = inputEl?.value || '';
  searchInput.placeholder = inputEl?.placeholder || '';
  modal.hidden = false;
  setTimeout(() => { searchInput.focus(); searchInput.select(); }, 60);
}

function closeSearchInputModal(confirm) {
  const modal = document.getElementById('search-input-modal');
  const searchInput = document.getElementById('search-input-field');
  if (confirm && _searchInputTarget && searchInput) {
    _searchInputTarget.value = searchInput.value;
    _searchInputTarget.dispatchEvent(new Event('input', { bubbles: true }));
  }
  if (modal) modal.hidden = true;
  _searchInputTarget = null;
}

document.getElementById('profile-picker-search')?.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  openFieldPicker(e.target, []);
});

document.querySelector('.workflows-search')?.addEventListener('click', (e) => {
  openSearchInputModal(e.target);
});

document.getElementById('history-search')?.addEventListener('click', (e) => {
  openSearchInputModal(e.target);
});

document.getElementById('btn-search-input-cancel')?.addEventListener('click', () => closeSearchInputModal(false));
document.getElementById('btn-search-input-confirm')?.addEventListener('click', () => closeSearchInputModal(true));

/* ── Number Picker (iOS drum wheel) ───────────────────── */
let _npValues = [];
let _npCurrentFloat = 0;
let _npOnConfirm = null;
let _npDecimalPlaces = 0;
let _npFormatter = null;
let _npDragging = false;
let _npDragStartY = 0;
let _npDragStartFloat = 0;
let _npLastY = 0;
let _npLastTime = 0;
let _npVelocity = 0;
let _npAnimFrame = null;

const _NP_ITEM_H = 112;
const _NP_RADIUS = 360;
const _NP_ANGLE = 18;
const _NP_SLOTS = 11; // odd number, center slot = Math.floor(SLOTS/2)

function _npMakeRange(min, max, step) {
  const arr = [];
  const dp = step < 1 ? Math.ceil(-Math.log10(step)) : 0;
  for (let v = min; v <= max + step * 0.001; v += step) {
    arr.push(parseFloat(v.toFixed(dp)));
  }
  return arr;
}

function _npBuildItems() {
  const drum = document.getElementById('number-picker-drum');
  if (!drum) return;
  drum.innerHTML = '';
  drum.style.transform = 'none';
  drum.style.transition = '';
  for (let i = 0; i < _NP_SLOTS; i++) {
    const item = document.createElement('div');
    item.className = 'number-picker-item';
    drum.appendChild(item);
  }
}

// Each render call positions all slots based on current indexFloat.
// Uses translateY (2D) + per-item perspective() + rotateX so items stay on the
// pixel raster — avoiding the blurriness caused by translateZ in a shared 3D context.
function _npRender(indexFloat) {
  const drum = document.getElementById('number-picker-drum');
  if (!drum) return;
  const center = Math.round(indexFloat);
  const half = Math.floor(_NP_SLOTS / 2);
  const items = drum.children;
  for (let i = 0; i < _NP_SLOTS; i++) {
    const vi = center + (i - half);
    const angle = (vi - indexFloat) * _NP_ANGLE;
    if (vi < 0 || vi >= _npValues.length || Math.abs(angle) >= 90) {
      items[i].style.visibility = 'hidden';
      items[i].style.fontSize = '';
    } else {
      const rad = angle * Math.PI / 180;
      const y = (-_NP_RADIUS * Math.sin(rad)).toFixed(2);
      const fontSize = Math.round(36 * (0.6 + 0.9 * Math.pow(Math.cos(rad), 12)));
      items[i].style.visibility = '';
      items[i].style.fontSize = `${fontSize}px`;
      items[i].textContent = _npFormatter ? _npFormatter(_npValues[vi]) : _npValues[vi].toFixed(_npDecimalPlaces);
      items[i].style.transform = `translateY(${y}px) perspective(600px) rotateX(${(-angle).toFixed(2)}deg)`;
    }
  }
}

function _npSnap(indexFloat) {
  if (_npAnimFrame) cancelAnimationFrame(_npAnimFrame);
  const target = Math.max(0, Math.min(_npValues.length - 1, Math.round(indexFloat)));
  const spring = () => {
    const diff = target - _npCurrentFloat;
    if (Math.abs(diff) < 0.005) {
      _npCurrentFloat = target;
      _npRender(_npCurrentFloat);
      _npAnimFrame = null;
      return;
    }
    _npCurrentFloat += diff * 0.28;
    _npRender(_npCurrentFloat);
    _npAnimFrame = requestAnimationFrame(spring);
  };
  _npAnimFrame = requestAnimationFrame(spring);
}

function _npMomentum(velocityPxPerMs) {
  if (_npAnimFrame) cancelAnimationFrame(_npAnimFrame);
  let vel = velocityPxPerMs;
  let last = performance.now();
  const tick = (now) => {
    const dt = now - last;
    last = now;
    _npCurrentFloat += (vel * dt) / _NP_ITEM_H;
    // clamp at edges and kill velocity
    if (_npCurrentFloat <= 0) { _npCurrentFloat = 0; vel = 0; }
    if (_npCurrentFloat >= _npValues.length - 1) { _npCurrentFloat = _npValues.length - 1; vel = 0; }
    vel *= Math.pow(0.96, dt / 16);
    _npRender(_npCurrentFloat);
    if (Math.abs(vel) > 0.005) {
      _npAnimFrame = requestAnimationFrame(tick);
    } else {
      _npAnimFrame = null;
      _npSnap(_npCurrentFloat);
    }
  };
  _npAnimFrame = requestAnimationFrame(tick);
}

/* ── Text Picker ─────────────────────────────────────── */
{
  let _textPickerCallback = null;
  const _textPickerModal = document.getElementById('text-picker-modal');
  const _textPickerInput = document.getElementById('text-picker-input');

  window._openTextPicker = function(currentValue, onConfirm) {
    if (!_textPickerModal || !_textPickerInput) return;
    _textPickerCallback = onConfirm;
    _textPickerInput.value = currentValue ?? '';
    _textPickerModal.hidden = false;
    setTimeout(() => { _textPickerInput.focus(); _textPickerInput.select(); }, 80);
  };

  document.getElementById('btn-text-picker-cancel')?.addEventListener('click', () => {
    _textPickerModal.hidden = true;
    _textPickerCallback = null;
  });

  document.getElementById('btn-text-picker-confirm')?.addEventListener('click', () => {
    const val = _textPickerInput.value.trim();
    _textPickerModal.hidden = true;
    if (_textPickerCallback) _textPickerCallback(val);
    _textPickerCallback = null;
  });

  _textPickerInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter') document.getElementById('btn-text-picker-confirm')?.click();
    if (e.key === 'Escape') document.getElementById('btn-text-picker-cancel')?.click();
  });
}

function openNumberPicker(values, currentValue, onConfirm, decimalPlaces = 0, formatter = null) {
  _npValues = values;
  _npOnConfirm = onConfirm;
  _npDecimalPlaces = decimalPlaces;
  _npFormatter = formatter;
  const modal = document.getElementById('number-picker-modal');
  if (!modal) return;
  _npBuildItems();
  let best = 0, bestDiff = Infinity;
  values.forEach((v, i) => { const d = Math.abs(v - currentValue); if (d < bestDiff) { bestDiff = d; best = i; } });
  _npCurrentFloat = best;
  _npRender(_npCurrentFloat);
  modal.hidden = false;
}

function closeNumberPicker(confirm) {
  if (_npAnimFrame) { cancelAnimationFrame(_npAnimFrame); _npAnimFrame = null; }
  const modal = document.getElementById('number-picker-modal');
  if (confirm && _npOnConfirm) {
    const idx = Math.max(0, Math.min(_npValues.length - 1, Math.round(_npCurrentFloat)));
    _npOnConfirm(_npValues[idx]);
  }
  if (modal) modal.hidden = true;
  _npOnConfirm = null;
  _npFormatter = null;
}

document.getElementById('btn-number-picker-cancel')?.addEventListener('click', () => closeNumberPicker(false));
document.getElementById('btn-number-picker-confirm')?.addEventListener('click', () => closeNumberPicker(true));
window.openNumberPicker  = openNumberPicker;
window.closeNumberPicker = closeNumberPicker;

{
  const wrap = document.getElementById('number-picker-drum-wrap');
  if (wrap) {
    wrap.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (_npAnimFrame) { cancelAnimationFrame(_npAnimFrame); _npAnimFrame = null; }
      wrap.setPointerCapture(e.pointerId);
      _npDragging = true;
      _npDragStartY = e.clientY;
      _npDragStartFloat = _npCurrentFloat;
      _npLastY = e.clientY;
      _npLastTime = performance.now();
      _npVelocity = 0;
    });
    wrap.addEventListener('pointermove', (e) => {
      if (!_npDragging) return;
      const dy = e.clientY - _npDragStartY;
      const now = performance.now();
      const dt = now - _npLastTime;
      if (dt > 0) _npVelocity = (e.clientY - _npLastY) / dt;
      _npLastY = e.clientY;
      _npLastTime = now;
      _npCurrentFloat = Math.max(0, Math.min(_npValues.length - 1, _npDragStartFloat + dy / _NP_ITEM_H));
      _npRender(_npCurrentFloat);
    });
    wrap.addEventListener('pointerup', () => {
      if (!_npDragging) return;
      _npDragging = false;
      const stale = performance.now() - _npLastTime > 80;
      if (!stale && Math.abs(_npVelocity) > 0.1) {
        _npMomentum(_npVelocity);
      } else {
        _npSnap(_npCurrentFloat);
      }
    });
    wrap.addEventListener('pointercancel', () => {
      _npDragging = false;
      _npSnap(_npCurrentFloat);
    });
  }
}

{
  const beanTextInputs = {
    'bean-roaster':    id => _beanPickerOptions()[id],
    'bean-name':       ()  => [],
    'bean-country':    id => _beanPickerOptions()[id],
    'bean-processing': id => _beanPickerOptions()[id],
    'bean-variety':    id => _beanPickerOptions()[id],
  };
  Object.entries(beanTextInputs).forEach(([id, getOptions]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      openFieldPicker(el, getOptions(id));
    });
  });
}

{
  const uniq = (arr) => [...new Set(arr.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de'));
  const grinderTextInputs = {
    'grinder-model':          () => uniq(_grindersCache.map(g => g.model)),
    'grinder-burrs':          () => uniq(_grindersCache.map(g => g.burrs)),
    'grinder-setting-values': () => [],
  };
  Object.entries(grinderTextInputs).forEach(([id, getOptions]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      openFieldPicker(el, getOptions());
    });
  });
}

{
  const uniq = (arr) => [...new Set(arr.filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de'));
  const allProfiles = () => Array.isArray(_profileRecordsCacheAll) ? _profileRecordsCacheAll : (_profileRecordsCache || []);
  const profileEditorTextInputs = {
    'profile-editor-title':  () => uniq(allProfiles().map(r => r.profile?.title)),
    'profile-editor-author': () => uniq(allProfiles().map(r => r.profile?.author)),
  };
  Object.entries(profileEditorTextInputs).forEach(([id, getOptions]) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      openFieldPicker(el, getOptions());
    });
  });
}

{
  const numberPickerInputs = {
    'bean-altitude-min':  () => openNumberPicker(_npMakeRange(0, 4000, 100), parseFloat(document.getElementById('bean-altitude-min')?.value) || 0, v => { document.getElementById('bean-altitude-min').value = v; }),
    'bean-altitude-max':  () => openNumberPicker(_npMakeRange(0, 4000, 100), parseFloat(document.getElementById('bean-altitude-max')?.value) || 0, v => { document.getElementById('bean-altitude-max').value = v; }),
    'grinder-burr-size':  () => openNumberPicker(_npMakeRange(20, 140, 1),   parseFloat(document.getElementById('grinder-burr-size')?.value) || 64, v => { document.getElementById('grinder-burr-size').value = v; }),
    'grinder-small-step': () => openNumberPicker(_npMakeRange(0, 10, 0.1),   parseFloat(document.getElementById('grinder-small-step')?.value) || 0, v => { document.getElementById('grinder-small-step').value = v; }, 1),
    'grinder-big-step':   () => openNumberPicker(_npMakeRange(0, 50, 0.5),   parseFloat(document.getElementById('grinder-big-step')?.value) || 0, v => { document.getElementById('grinder-big-step').value = v; }, 1),
  };
  Object.entries(numberPickerInputs).forEach(([id, open]) => {
    document.getElementById(id)?.addEventListener('pointerdown', (e) => { e.preventDefault(); open(); });
  });
}

function formatBatchDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat(getLang?.() === 'en' ? 'en-US' : 'de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(d);
}

function _parseBatchDateValue(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (month < 1 || month > 12) return null;
  const maxDay = new Date(Date.UTC(year, month, 0, 12)).getUTCDate();
  if (day < 1 || day > maxDay) return null;
  return { year, month, day };
}

function _formatBatchDateValue(parts) {
  if (!parts) return '';
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function _formatBatchDateDisplayValue(value) {
  const parts = _parseBatchDateValue(value);
  if (!parts) return '';
  return `${String(parts.day).padStart(2, '0')}.${String(parts.month).padStart(2, '0')}.${parts.year}`;
}

function _batchDateValueToApiIso(value) {
  const parts = _parseBatchDateValue(value);
  if (!parts) return null;
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0, 0)).toISOString();
}

function _getBatchRoastDateValue() {
  return document.getElementById('batch-roast-date')?.dataset.isoDate || '';
}

function _setBatchRoastDateValue(value) {
  const input = document.getElementById('batch-roast-date');
  if (!input) return;
  const normalized = _formatBatchDateValue(_parseBatchDateValue(value));
  input.dataset.isoDate = normalized;
  input.value = normalized ? _formatBatchDateDisplayValue(normalized) : '';
}

function _batchDateDraftToDate() {
  if (!_batchDateDraft) return new Date(Date.UTC(2026, 0, 1, 12, 0, 0));
  return new Date(Date.UTC(_batchDateDraft.year, _batchDateDraft.month - 1, _batchDateDraft.day, 12, 0, 0));
}

function _setBatchDateDraftFromDate(date) {
  _batchDateDraft = {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function _setBatchDateView(year, month) {
  const date = new Date(Date.UTC(year, month - 1, 1, 12, 0, 0));
  _batchDateViewYear = date.getUTCFullYear();
  _batchDateViewMonth = date.getUTCMonth() + 1;
}

function _renderBatchDatePicker() {
  if (!_batchDateDraft) return;
  const value = _formatBatchDateValue(_batchDateDraft);
  const previewEl = document.getElementById('batch-date-picker-preview');
  const monthEl = document.getElementById('batch-date-picker-month-label');
  const yearEl = document.getElementById('batch-date-picker-year-label');
  const daysEl = document.getElementById('batch-date-picker-days');
  if (previewEl) previewEl.textContent = _formatBatchDateDisplayValue(value) || '—';
  if (monthEl) monthEl.textContent = _getMonthName(_batchDateViewMonth) || '—';
  if (yearEl) yearEl.textContent = String(_batchDateViewYear || _batchDateDraft.year);
  if (!daysEl) return;

  const firstOfMonth = new Date(Date.UTC(_batchDateViewYear, _batchDateViewMonth - 1, 1, 12, 0, 0));
  const daysInMonth = new Date(Date.UTC(_batchDateViewYear, _batchDateViewMonth, 0, 12, 0, 0)).getUTCDate();
  const startOffset = (firstOfMonth.getUTCDay() + 6) % 7;
  const today = new Date();
  const todayYear = today.getFullYear();
  const todayMonth = today.getMonth() + 1;
  const todayDay = today.getDate();

  const cells = [];
  for (let idx = 0; idx < startOffset; idx++) {
    cells.push('<span class="batch-date-picker-day batch-date-picker-day--empty" aria-hidden="true"></span>');
  }
  for (let day = 1; day <= daysInMonth; day++) {
    const isSelected = _batchDateDraft.year === _batchDateViewYear && _batchDateDraft.month === _batchDateViewMonth && _batchDateDraft.day === day;
    const isToday = todayYear === _batchDateViewYear && todayMonth === _batchDateViewMonth && todayDay === day;
    const className = [
      'batch-date-picker-day',
      isToday ? 'batch-date-picker-day--today' : '',
      isSelected ? 'is-selected' : '',
    ].filter(Boolean).join(' ');
    const valueStr = _formatBatchDateValue({ year: _batchDateViewYear, month: _batchDateViewMonth, day });
    cells.push(`<button type="button" class="${className}" data-batch-date-value="${valueStr}" role="gridcell" aria-selected="${isSelected ? 'true' : 'false'}">${day}</button>`);
  }
  daysEl.innerHTML = cells.join('');
}

function _shiftBatchDateView(part, delta) {
  const date = new Date(Date.UTC(_batchDateViewYear, _batchDateViewMonth - 1, 1, 12, 0, 0));
  if (part === 'month') date.setUTCMonth(date.getUTCMonth() + delta);
  else if (part === 'year') date.setUTCFullYear(date.getUTCFullYear() + delta);
  _setBatchDateView(date.getUTCFullYear(), date.getUTCMonth() + 1);
  _renderBatchDatePicker();
}

function openBatchDatePickerModal(onApply = null, currentIso = null) {
  _batchDatePickerOnApply = onApply;
  const current = _parseBatchDateValue(currentIso ?? _getBatchRoastDateValue());
  if (current) {
    _batchDateDraft = current;
    _setBatchDateView(current.year, current.month);
  } else {
    const now = new Date();
    _batchDateDraft = { year: now.getFullYear(), month: now.getMonth() + 1, day: now.getDate() };
    _setBatchDateView(_batchDateDraft.year, _batchDateDraft.month);
  }
  _renderBatchDatePicker();
  if (batchDatePickerModalEl) batchDatePickerModalEl.hidden = false;
}

function formatBatchDateBadge(iso) {
  if (!iso) return { day: '—', month: '', age: '' };
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { day: '—', month: '', age: '' };
  const locale = getLang?.() === 'en' ? 'en-US' : 'de-DE';
  return {
    day: String(d.getUTCDate()).padStart(2, '0'),
    month: new Intl.DateTimeFormat(locale, { month: 'short' }).format(d).replace('.', ''),
    age: formatBatchAge(iso),
  };
}

function formatBatchAge(iso) {
  if (!iso) return '—';
  const roastDate = new Date(iso);
  if (Number.isNaN(roastDate.getTime())) return '—';
  
  const now = new Date();
  const diffMs = now - roastDate;
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  
  if (diffDays < 0) return '—';
  
  if (diffDays < 7) {
    return `${diffDays} ${t(diffDays === 1 ? 'time.day' : 'time.days')}`;
  } else if (diffDays < 30) {
    const weeks = Math.floor(diffDays / 7);
    return `${weeks} ${t(weeks === 1 ? 'time.week' : 'time.weeks')}`;
  } else if (diffDays < 365) {
    const months = Math.floor(diffDays / 30);
    return `${months} ${t(months === 1 ? 'time.month' : 'time.months')}`;
  }
  const years = Math.floor(diffDays / 365);
  return `${years} ${t(years === 1 ? 'time.year' : 'time.years')}`;
}

// Debug: Log das Alter für eine Test-Packung (kommentiere später aus)
// console.log('DEBUG: Test-Batch age:', formatBatchAge('2025-04-20'));

function renderBatchList(batches) {
  _lastBatches = (Array.isArray(batches) ? batches : []).slice().sort((a, b) => {
    if (!a.roastDate) return 1;
    if (!b.roastDate) return -1;
    return new Date(b.roastDate) - new Date(a.roastDate);
  });
  const listEl = document.getElementById('batch-list');
  if (!listEl) return;

  if (_lastBatches.length === 0) {
    listEl.innerHTML = `<div class="batch-empty">${t('beanEditor.noBatches')}</div>`;
    return;
  }

  listEl.innerHTML = _lastBatches.map((b, i) => {
    const badge = formatBatchDateBadge(b.roastDate);
    return `
    <div class="batch-item" data-batch-index="${i}">
      <img src="ui/graphics/Packung.png" class="batch-item-img" alt="${t('batchEditor.title')}" draggable="false" />
      <div class="batch-roast-badge">
        <span class="batch-roast-badge-day">${badge.day}</span>
        <span class="batch-roast-badge-month">${badge.month}</span>
      </div>
      <div class="batch-age-badge">${t('beanEditor.ageLabel')}: ${badge.age}</div>
    </div>
  `;
  }).join('');
}

async function loadAndRenderBatches(beanId) {
  const listEl = document.getElementById('batch-list');
  if (listEl) listEl.innerHTML = `<div class="batch-empty">${t('status.loading')}</div>`;
  try {
    const batches = await fetchBatches(beanId);
    renderBatchList(Array.isArray(batches) ? batches : (batches?.items ?? []));
  } catch {
    if (listEl) listEl.innerHTML = `<div class="batch-empty">${t('status.loadFailed')}</div>`;
  }
}

function _setBatchDateInput(id, isoOrNull) {
  const el = document.getElementById(id);
  if (!el) return;
  const val = isoOrNull ? isoOrNull.slice(0, 10) : '';
  el.dataset.isoDate = val;
  el.value = val ? _formatBatchDateDisplayValue(val) : '';
}

function _getBatchDateInput(id) {
  return document.getElementById(id)?.dataset.isoDate || '';
}

function openBatchModal(batch = null) {
  _editingBatch = batch?.id ? batch : null;
  _setBatchRoastDateValue(batch?.roastDate ? batch.roastDate.slice(0, 10) : '');
  document.getElementById('batch-roast-level').value    = batch?.roastLevel    ?? '';
  document.getElementById('batch-weight').value         = batch?.weight        ?? '';
  document.getElementById('batch-price').value          = batch?.price         ?? '';
  document.getElementById('batch-currency').value       = batch?.currency      ?? '';
  document.getElementById('batch-quality-score').value  = batch?.qualityScore  ?? '';
  document.getElementById('batch-notes').value          = batch?.notes         ?? '';
  const isEditing = !!_editingBatch;
  const titleEl = document.querySelector('#batch-add-modal .modal-title');
  if (titleEl) titleEl.textContent = isEditing ? t('batchEditor.editTitle') : t('batchEditor.title');
  const saveBtn = document.getElementById('btn-batch-save');
  if (saveBtn) saveBtn.textContent = isEditing ? t('action.save') : t('action.add');
  const deleteBtn = document.getElementById('btn-batch-delete');
  if (deleteBtn) deleteBtn.hidden = !isEditing;
  if (batchAddModalEl) batchAddModalEl.hidden = false;
}

batchAddModalEl?.querySelector('.modal-sheet')?.addEventListener('click', (e) => {
  e.stopPropagation();
});

['pointerdown', 'pointerup', 'touchstart', 'touchend', 'click'].forEach((eventName) => {
  batchAddModalEl?.addEventListener(eventName, (e) => {
    e.stopPropagation();
  }, { passive: eventName.startsWith('touch') });
  batchDatePickerModalEl?.addEventListener(eventName, (e) => {
    e.stopPropagation();
  }, { passive: eventName.startsWith('touch') });
});

batchDatePickerModalEl?.querySelector('.modal-sheet')?.addEventListener('click', (e) => {
  e.stopPropagation();
});

document.getElementById('btn-batch-add')?.addEventListener('click', () => openBatchModal(null));
document.getElementById('batch-roast-date')?.addEventListener('click', () => openBatchDatePickerModal());

const _batchTextFields = [
  { id: 'batch-roast-level',    inputMode: 'text' },
  { id: 'batch-quality-score',  inputMode: 'decimal' },
  { id: 'batch-weight',         inputMode: 'decimal' },
  { id: 'batch-price',          inputMode: 'decimal' },
  { id: 'batch-currency',       inputMode: 'text' },
  { id: 'batch-notes',          inputMode: 'text' },
];
_batchTextFields.forEach(({ id, inputMode }) => {
  document.getElementById(id)?.addEventListener('click', () => {
    const el = document.getElementById(id);
    openFieldPicker(null, [], {
      inputMode,
      initialValue: el?.value ?? '',
      onConfirm: (val) => { if (el) el.value = val.trim(); },
    });
  });
});

document.getElementById('btn-batch-date-cancel')?.addEventListener('click', () => {
  _batchDatePickerOnApply = null;
  if (batchDatePickerModalEl) batchDatePickerModalEl.hidden = true;
});
document.getElementById('btn-batch-date-apply')?.addEventListener('click', () => {
  const displayIso = _formatBatchDateValue(_batchDateDraft);
  if (_batchDatePickerOnApply) {
    _batchDatePickerOnApply(displayIso);
    _batchDatePickerOnApply = null;
  } else {
    _setBatchRoastDateValue(displayIso);
  }
  if (batchDatePickerModalEl) batchDatePickerModalEl.hidden = true;
});
document.getElementById('btn-batch-date-clear')?.addEventListener('click', () => {
  _setBatchRoastDateValue('');
  if (batchDatePickerModalEl) batchDatePickerModalEl.hidden = true;
});
document.getElementById('btn-batch-date-month-down')?.addEventListener('click', () => _shiftBatchDateView('month', -1));
document.getElementById('btn-batch-date-month-up')?.addEventListener('click', () => _shiftBatchDateView('month', 1));
document.getElementById('btn-batch-date-year-down')?.addEventListener('click', () => _shiftBatchDateView('year', -1));
document.getElementById('btn-batch-date-year-up')?.addEventListener('click', () => _shiftBatchDateView('year', 1));
document.getElementById('batch-date-picker-days')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-batch-date-value]');
  if (!btn) return;
  const value = btn.dataset.batchDateValue;
  const parsed = _parseBatchDateValue(value);
  if (!parsed) return;
  _batchDateDraft = parsed;
  if (_batchDatePickerOnApply) {
    _batchDatePickerOnApply(value);
    _batchDatePickerOnApply = null;
  } else {
    _setBatchRoastDateValue(value);
  }
  if (batchDatePickerModalEl) batchDatePickerModalEl.hidden = true;
});
batchDatePickerModalEl?.addEventListener('click', (e) => {
  if (e.target === batchDatePickerModalEl) batchDatePickerModalEl.hidden = true;
});

document.getElementById('batch-list')?.addEventListener('click', async (e) => {
  const delBtn = e.target.closest('.batch-delete-btn');
  if (delBtn) {
    e.stopPropagation();
    const idx = Number(delBtn.dataset.batchIndex);
    const batch = _lastBatches[idx];
    if (!batch?.id || !_editingBean?.id) return;
    try {
      await deleteBatch(batch.id);
      showToast(t('toast.batchDeleted'));
      loadAndRenderBatches(_editingBean.id);
    } catch (err) {
      showToast(t('toast.batchDeleteFailed') + ': ' + err.message);
    }
    return;
  }

  const item = e.target.closest('.batch-item');
  if (item) {
    const idx = Number(item.dataset.batchIndex);
    const batch = _lastBatches[idx];
    if (batch) openBatchModal(batch);
  }
});

document.getElementById('btn-batch-cancel')?.addEventListener('click', () => {
  if (batchAddModalEl) batchAddModalEl.hidden = true;
});

document.getElementById('btn-batch-delete')?.addEventListener('click', async () => {
  if (!_editingBatch?.id || !_editingBean?.id) return;
  if (batchAddModalEl) batchAddModalEl.hidden = true;
  try {
    await deleteBatch(_editingBatch.id);
    showToast(t('toast.batchDeleted'));
    loadAndRenderBatches(_editingBean.id);
  } catch (err) {
    showToast(t('toast.batchDeleteFailed') + ': ' + err.message);
  }
});

document.getElementById('btn-batch-save')?.addEventListener('click', async () => {
  if (!_editingBean?.id) return;

  const roastDateRaw    = _getBatchRoastDateValue();
  const roastLevel      = document.getElementById('batch-roast-level')?.value.trim()   || undefined;
  const weightRaw       = document.getElementById('batch-weight')?.value;
  const priceRaw        = document.getElementById('batch-price')?.value;
  const currency        = document.getElementById('batch-currency')?.value.trim()       || undefined;
  const qualityRaw      = document.getElementById('batch-quality-score')?.value;
  const notes           = document.getElementById('batch-notes')?.value.trim()          || undefined;

  const payload = {};
  if (roastDateRaw)   payload.roastDate      = _batchDateValueToApiIso(roastDateRaw);
  if (roastLevel)     payload.roastLevel     = roastLevel;
  if (weightRaw  !== '') { const w = Number(weightRaw);  if (Number.isFinite(w)) payload.weight       = w; }
  if (priceRaw   !== '') { const p = Number(priceRaw);   if (Number.isFinite(p)) payload.price        = p; }
  if (qualityRaw !== '') { const q = Number(qualityRaw); if (Number.isFinite(q)) payload.qualityScore = q; }
  if (currency)       payload.currency       = currency;
  if (notes)          payload.notes          = notes;

  const saveBtn = document.getElementById('btn-batch-save');
  if (saveBtn) saveBtn.textContent = '…';

  try {
    if (_editingBatch?.id) {
      await updateBatch(_editingBatch.id, payload);
    } else {
      await createBatch(_editingBean.id, payload);
    }
    if (saveBtn) saveBtn.textContent = _editingBatch?.id ? t('action.save') : t('action.add');
    if (batchAddModalEl) batchAddModalEl.hidden = true;
    showToast(_editingBatch?.id ? t('toast.batchSaved') : t('toast.batchAdded'));
    loadAndRenderBatches(_editingBean.id);
    if (beanManagerModalEl && !beanManagerModalEl.hidden && _beanManagerSelectedBean?.id) {
      _beanManagerLoadBatches(_beanManagerSelectedBean.id);
    }
  } catch (err) {
    if (saveBtn) saveBtn.textContent = _editingBatch?.id ? t('action.save') : t('action.add');
    showToast(t('toast.saveFailed2') + ': ' + err.message);
  }
});

/* ── Bean Manager Modal (Profile-Picker Style) ────────── */

const beanManagerModalEl = document.getElementById('bean-manager-modal');
let _beanManagerSelectedBean = null;
let _beanManagerAllBeans = [];
let _beanManagerShowArchived = false;
let _beanManagerSearchQuery = '';
let _beanManagerShowAllFields = false;
let _beanManagerAutoSelectId = null;
let _beanManagerCollapsedRoasters = new Set();

function _persistBeanManagerCollapsedRoasters() {
  patchStoreSettings({ nsx_bean_manager_collapsed_roasters: [..._beanManagerCollapsedRoasters] });
}

function _beanManagerFilteredBeans() {
  const q = _beanManagerSearchQuery.toLowerCase().trim();
  return _beanManagerAllBeans.filter(b => {
    if (!_beanManagerShowArchived && b.archived) return false;
    if (!q) return true;
    return (b.name || '').toLowerCase().includes(q)
      || (b.roaster || '').toLowerCase().includes(q)
      || (b.country || '').toLowerCase().includes(q);
  });
}

function _beanManagerVisibleBeans() {
  const sorted = [..._beanManagerFilteredBeans()].sort((a, b) => {
    const ra = (a.roaster || '').toLowerCase();
    const rb = (b.roaster || '').toLowerCase();
    if (ra !== rb) return ra.localeCompare(rb, 'de');
    return (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase(), 'de');
  });
  const groups = new Map();
  for (const bean of sorted) {
    const key = bean.roaster || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(bean);
  }
  const visible = [];
  for (const [roaster, members] of groups) {
    if (!_beanManagerCollapsedRoasters.has(roaster)) visible.push(...members);
  }
  return visible;
}

function _beanManagerRenderList() {
  const listEl = document.getElementById('bean-manager-list');
  if (!listEl) return;
  const beans = _beanManagerFilteredBeans();
  if (beans.length === 0) {
    listEl.innerHTML = `<div class="bohnen-empty-state bean-manager-empty">${t('beanList.empty')}</div>`;
    return;
  }
  listEl.innerHTML = '';
  const sorted = [...beans].sort((a, b) => {
    const ra = (a.roaster || '').toLowerCase();
    const rb = (b.roaster || '').toLowerCase();
    if (ra !== rb) return ra.localeCompare(rb, 'de');
    return (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase(), 'de');
  });

  // Group by roaster
  const groups = new Map();
  for (const bean of sorted) {
    const key = bean.roaster || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(bean);
  }

  const chevron = `<svg class="profile-picker-group-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;

  for (const [roaster, members] of groups) {
    const collapsed = _beanManagerCollapsedRoasters.has(roaster);
    const header = document.createElement('button');
    header.type = 'button';
    header.className = 'profile-picker-group-header' + (collapsed ? ' is-collapsed' : '');
    header.dataset.bmRoaster = roaster;
    header.innerHTML = `${chevron}<span class="profile-picker-group-name">${_esc(roaster || '—')}</span>`;
    listEl.appendChild(header);

    if (!collapsed) {
      for (const bean of members) {
        const item = document.createElement('button');
        item.type = 'button';
        item.role = 'option';
        item.className = 'profile-picker-item is-grouped' + (bean.id === _beanManagerSelectedBean?.id ? ' is-selected' : '');
        if (bean.archived) item.classList.add('bean-manager-item-archived');
        const sub = [bean.processing, bean.country].filter(Boolean).join(' · ');
        item.innerHTML = `<div class="profile-picker-item-meta"><span class="profile-picker-item-title">${_esc(bean.name || '—')}</span>${sub ? `<span class="profile-picker-item-sub">${_esc(sub)}</span>` : ''}</div>`;
        item.addEventListener('click', () => _beanManagerSelectBean(bean));
        listEl.appendChild(item);
      }
    }
  }
}

function _esc(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _beanManagerSelectBean(bean) {
  _beanManagerSelectedBean = bean;
  _beanManagerShowAllFields = false;
  _beanManagerRenderList();
  _beanManagerRenderDetail(bean);
}

function _beanManagerSuggestions(field) {
  // Name is unique per bean and notes are free-form flavour combinations
  // (e.g. "Schokoladig, Nussig, Beerig") that practically never repeat verbatim,
  // so suggestions add no value there — open a plain text field instead.
  if (field === 'name' || field === 'notes') return [];
  const fromBeans = (key) => [...new Set(_beanManagerAllBeans.map(b => b[key]).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de'));
  if (field === 'variety') {
    return [...new Set(_beanManagerAllBeans.flatMap(b => Array.isArray(b.variety) ? b.variety : []).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de'));
  }
  return fromBeans(field);
}

function _beanManagerApplyField(target, field, value) {
  if (field === 'variety') {
    target.variety = value ? value.split(',').map(v => v.trim()).filter(Boolean) : undefined;
  } else if (field === 'altMin') {
    const n = Number(value);
    const max = Array.isArray(target.altitude) ? (target.altitude[1] ?? n) : n;
    target.altitude = Number.isFinite(n) ? [n, max] : undefined;
  } else if (field === 'altMax') {
    const n = Number(value);
    const min = Array.isArray(target.altitude) ? (target.altitude[0] ?? n) : n;
    target.altitude = Number.isFinite(n) ? [min, n] : undefined;
  } else if (field === 'decaf') {
    target.decaf = value === true;
  } else {
    target[field] = value || undefined;
    if (field === 'roaster' || field === 'name') target[field] = value || '';
  }
}

function _beanManagerSaveField(field, value) {
  const bean = _beanManagerSelectedBean;
  if (!bean) return;

  // Draft mode: update in-memory and re-render without API call
  if (bean._draft) {
    _beanManagerApplyField(bean, field, value);
    _beanManagerRenderDetail(bean);
    return;
  }

  if (!bean.id) return;
  const payload = {
    roaster:    bean.roaster    || '',
    name:       bean.name       || '',
    country:    bean.country    || undefined,
    region:     bean.region     || undefined,
    producer:   bean.producer   || undefined,
    species:    bean.species    || undefined,
    processing: bean.processing || undefined,
    variety:    Array.isArray(bean.variety)  ? bean.variety  : undefined,
    altitude:   Array.isArray(bean.altitude) ? bean.altitude : undefined,
    decaf:      !!bean.decaf,
    decafProcess: bean.decafProcess || undefined,
    notes:      bean.notes      || undefined,
  };
  _beanManagerApplyField(payload, field, value);
  updateBean(bean.id, payload)
    .then(() => _beanManagerLoad())
    .catch(err => showToast(t('toast.error') + ': ' + err.message));
}

function _beanManagerRenderDetail(bean) {
  const placeholder = document.getElementById('bean-manager-placeholder');
  const pickBanner  = document.getElementById('bean-manager-pick-banner');
  const detail = document.getElementById('bean-manager-detail');
  if (!bean) {
    if (pickBanner)  pickBanner.hidden  = !_beanManagerPickCallback;
    if (placeholder) placeholder.hidden = !!_beanManagerPickCallback;
    if (detail) detail.hidden = true;
    return;
  }
  if (pickBanner)  pickBanner.hidden  = true;
  if (placeholder) placeholder.hidden = true;
  if (detail) detail.hidden = false;

  const titleEl = document.getElementById('bean-manager-detail-title');
  if (titleEl) titleEl.textContent = bean._draft
    ? t('beanEditor.title')
    : (bean.roaster ? `${bean.roaster} – ${bean.name || '—'}` : (bean.name || '—'));

  const actionsEl = document.getElementById('bean-manager-detail-actions');
  if (actionsEl) {
    if (bean._draft) {
      actionsEl.innerHTML = `
        <button type="button" id="btn-bm-cancel-new" class="profile-picker-add-btn profile-picker-add-btn--text">${t('action.cancel')}</button>
        <button type="button" id="btn-bm-save-new" class="profile-picker-add-btn profile-picker-add-btn--text">${t('action.save')}</button>
      `;
    } else if (_beanManagerPickCallback) {
      actionsEl.innerHTML = '';
    } else {
      actionsEl.innerHTML = `
        <button type="button" id="btn-bm-toggle-fields" class="profile-picker-add-btn" aria-pressed="${_beanManagerShowAllFields}">
          ${_beanManagerShowAllFields
            ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`
            : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`
          }
        </button>
        <button type="button" id="btn-bm-archive" class="profile-picker-add-btn profile-picker-add-btn--text">${bean.archived ? t('action.unarchive') : t('action.archive')}</button>
        <button type="button" id="btn-bm-delete" class="profile-picker-add-btn profile-picker-add-btn--text modal-btn-destructive">${t('action.delete')}</button>
      `;
    }
  }

  const fieldsEl = document.getElementById('bean-manager-fields');
  if (fieldsEl) fieldsEl.classList.toggle('is-readonly', !!_beanManagerPickCallback);
  if (fieldsEl) {
    const varietyVal = Array.isArray(bean.variety) && bean.variety.length ? bean.variety.join(', ') : '';
    const altMin = Array.isArray(bean.altitude) ? (bean.altitude[0] ?? '') : '';
    const altMax = Array.isArray(bean.altitude) ? (bean.altitude[1] ?? '') : '';
    const isEmpty = (v) => v === '' || v === null || v === undefined;
    const val = (v) => !isEmpty(v) ? _esc(String(v)) : `<span class="bean-manager-prop-empty">—</span>`;
    const show = _beanManagerShowAllFields;
    const tile = (field, label, value, inputMode = 'text') => {
      if (!show && isEmpty(value)) return '';
      return `<button type="button" class="bean-manager-prop-tile" data-bm-field="${field}" data-bm-value="${_esc(String(value ?? ''))}" data-bm-inputmode="${inputMode}">
        <span class="bean-manager-prop-label">${_esc(label)}</span>
        <span class="bean-manager-prop-value">${val(value)}</span>
      </button>`;
    };
    const boolTile = (field, label, value) => {
      return `<button type="button" class="bean-manager-prop-tile" data-bm-field="${field}" data-bm-value="${value ? '1' : '0'}" data-bm-type="bool">
        <span class="bean-manager-prop-label">${_esc(label)}</span>
        <span class="bean-manager-prop-value">${value ? _esc(t('beanEditor.yes')) : _esc(t('beanEditor.no'))}</span>
      </button>`;
    };
    const altTile = (show || altMin !== '' || altMax !== '') ? `
      <div class="bean-manager-prop-tile bean-manager-prop-tile--split">
        <span class="bean-manager-prop-label">${_esc(t('beanEditor.altitude'))}</span>
        <div class="bean-manager-prop-split-row">
          <button type="button" class="bean-manager-prop-split-half" data-bm-field="altMin" data-bm-value="${_esc(String(altMin))}" data-bm-inputmode="numeric">
            <span class="bean-manager-prop-split-label">${_esc(t('beanEditor.altFrom'))}</span>
            <span class="bean-manager-prop-value">${val(altMin)}</span>
          </button>
          <div class="bean-manager-prop-split-divider"></div>
          <button type="button" class="bean-manager-prop-split-half" data-bm-field="altMax" data-bm-value="${_esc(String(altMax))}" data-bm-inputmode="numeric">
            <span class="bean-manager-prop-split-label">${_esc(t('beanEditor.altTo'))}</span>
            <span class="bean-manager-prop-value">${val(altMax)}</span>
          </button>
        </div>
      </div>` : '';
    fieldsEl.innerHTML = `<div class="bean-manager-prop-grid">
      ${tile('roaster',     t('beanEditor.roaster'),     bean.roaster     || '')}
      ${tile('name',        t('beanEditor.name'),         bean.name        || '')}
      ${tile('species',     t('beanEditor.species'),      bean.species     || '')}
      ${tile('country',     t('beanEditor.origin'),       bean.country     || '')}
      ${tile('region',      t('beanEditor.region'),       bean.region      || '')}
      ${tile('producer',    t('beanEditor.producer'),     bean.producer    || '')}
      ${tile('variety',     t('beanEditor.variety'),      varietyVal)}
      ${tile('processing',  t('beanEditor.process'),      bean.processing  || '')}
      ${altTile}
      ${boolTile('decaf', t('beanEditor.decaf'), !!bean.decaf)}
      ${bean.decaf ? tile('decafProcess', t('beanEditor.decafProcess'), bean.decafProcess || '') : ''}
      ${(show || !isEmpty(bean.notes)) ? `<button type="button" class="bean-manager-prop-tile bean-manager-prop-tile--full" data-bm-field="notes" data-bm-value="${_esc(String(bean.notes ?? ''))}">
        <span class="bean-manager-prop-label">${_esc(t('beanEditor.notes'))}</span>
        <span class="bean-manager-prop-value">${val(bean.notes)}</span>
      </button>` : ''}
    </div>`;
  }

  const batchesSection = document.querySelector('.bean-manager-batches-section');
  if (bean.id) {
    if (batchesSection) batchesSection.hidden = false;
    _beanManagerLoadBatches(bean.id);
  } else {
    if (batchesSection) batchesSection.hidden = true;
    const listEl = document.getElementById('bean-manager-batch-list');
    if (listEl) { listEl.innerHTML = ''; listEl._bmBatches = []; }
  }
}

async function _beanManagerLoadBatches(beanId) {
  const listEl = document.getElementById('bean-manager-batch-list');
  if (!listEl) return;
  listEl.innerHTML = `<div class="batch-empty">${t('status.loading')}</div>`;
  try {
    // Always load every batch (incl. archived) so "add batch" can prefill from the
    // latest batch even when all previous ones are archived; the list view hides
    // archived batches itself in _beanManagerRenderBatches().
    const batches = await fetchBatches(beanId, true);
    const items = Array.isArray(batches) ? batches : (batches?.items ?? []);
    _beanManagerRenderBatches(items);
  } catch {
    listEl.innerHTML = `<div class="batch-empty">${t('status.loadFailed')}</div>`;
  }
}

let _beanManagerShowArchivedBatches = false;
let _beanManagerPickCallback = null;

function _beanManagerRenderBatches(batches) {
  const listEl = document.getElementById('bean-manager-batch-list');
  if (!listEl) return;
  const sorted = [...batches].sort((a, b) => {
    if (!a.roastDate) return 1;
    if (!b.roastDate) return -1;
    return new Date(b.roastDate) - new Date(a.roastDate);
  });
  listEl._bmBatches = sorted;

  const archiveChk = document.getElementById('chk-bean-manager-batch-show-archived');
  if (archiveChk) archiveChk.checked = _beanManagerShowArchivedBatches;

  const visible = _beanManagerShowArchivedBatches ? sorted : sorted.filter(b => !b.archived);
  if (visible.length === 0) {
    listEl.innerHTML = `<div class="batch-empty">${t('beanEditor.noBatches')}</div>`;
    return;
  }

  const fmtDate = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    return `${String(d.getUTCDate()).padStart(2,'0')}.${String(d.getUTCMonth()+1).padStart(2,'0')}.${d.getUTCFullYear()}`;
  };

  // pencil, archive-box, snowflake SVGs
  const iconEdit     = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
  const iconArchive  = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><polyline points="20 6 9 17 4 12"/></svg>`;
  const iconFreeze   = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><line x1="12" y1="2" x2="12" y2="22"/><path d="M17 7l-5-5-5 5"/><path d="M17 17l-5 5-5-5"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M7 7l-5 5 5 5"/><path d="M17 7l5 5-5 5"/></svg>`;

  const pickMode = !!_beanManagerPickCallback;
  listEl.innerHTML = visible.map((b) => {
    const cls = [
      'bean-manager-batch-row',
      b.frozen   ? 'is-frozen'   : '',
      b.archived ? 'is-archived' : '',
      pickMode   ? 'bean-manager-batch-row--pick' : '',
    ].filter(Boolean).join(' ');

    const roastDateStr  = fmtDate(b.roastDate);
    const weightRemStr  = b.weightRemaining != null ? `${b.weightRemaining} g` : '—';
    const weightStr     = b.weight != null ? `${b.weight} g` : '—';

    return `<div class="${cls}" data-bm-batch-id="${_esc(b.id)}">
      <div class="bm-batch-fields">
        <div class="bm-batch-field">
          <span class="bm-batch-field-label">${_esc(t('batchEditor.roastDate'))}</span>
          <span class="bm-batch-field-value">${_esc(roastDateStr)}</span>
        </div>
        <div class="bm-batch-field">
          <span class="bm-batch-field-label">${_esc(t('batchEditor.weightRemaining'))}</span>
          <span class="bm-batch-field-value">${_esc(weightRemStr)}</span>
        </div>
        <div class="bm-batch-field">
          <span class="bm-batch-field-label">${_esc(t('batchEditor.weight'))}</span>
          <span class="bm-batch-field-value">${_esc(weightStr)}</span>
        </div>
      </div>
      ${pickMode ? '' : `<div class="bm-batch-actions">
        <button class="bm-batch-action-btn" data-bm-batch-action="edit" data-bm-batch-id="${_esc(b.id)}">${iconEdit}</button>
        ${_batchFreezeEnabled ? `<button class="bm-batch-action-btn${b.frozen ? ' is-active' : ''}" data-bm-batch-action="frozen" data-bm-batch-id="${_esc(b.id)}">${iconFreeze}</button>` : ''}
        <button class="bm-batch-action-btn${b.archived ? ' is-active' : ''}" data-bm-batch-action="archive" data-bm-batch-id="${_esc(b.id)}">${iconArchive}</button>
      </div>`}
    </div>`;
  }).join('');
}

async function _beanManagerLoad() {
  const listEl = document.getElementById('bean-manager-list');
  if (listEl) listEl.innerHTML = `<div class="bohnen-empty-state bean-manager-empty">${t('status.loading')}</div>`;
  try {
    // Always load every bean (incl. archived) so autocomplete suggestions draw
    // from all beans; the list view hides archived ones via _beanManagerFilteredBeans().
    const data = await fetchBeans(true);
    _beanManagerAllBeans = Array.isArray(data) ? data : (data?.items ?? []);
    if (_beanManagerSelectedBean) {
      _beanManagerSelectedBean = _beanManagerAllBeans.find(b => b.id === _beanManagerSelectedBean.id) ?? null;
    }
    if (!_beanManagerSelectedBean && !_beanManagerPickCallback) {
      if (_beanManagerAutoSelectId) {
        _beanManagerSelectedBean = _beanManagerAllBeans.find(b => b.id === _beanManagerAutoSelectId) ?? null;
      }
      if (!_beanManagerSelectedBean) {
        _beanManagerSelectedBean = _beanManagerFilteredBeans()[0] ?? null;
      }
    }
    _beanManagerAutoSelectId = null;
    _beanManagerRenderList();
    if (_beanManagerSelectedBean) {
      _beanManagerRenderDetail(_beanManagerSelectedBean);
    }
  } catch {
    if (listEl) listEl.innerHTML = `<div class="bohnen-empty-state bean-manager-empty">${t('status.loadFailed')}</div>`;
  }
}

function openBeanManagerModal(pickCallback = null) {
  if (!beanManagerModalEl) return;
  _beanManagerPickCallback = typeof pickCallback === 'function' ? pickCallback : null;
  beanManagerModalEl.hidden = false;
  const searchEl = document.getElementById('bean-manager-search');
  if (searchEl) searchEl.value = '';
  _beanManagerSearchQuery = '';
  _beanManagerSelectedBean = null;
  _beanManagerAutoSelectId = null;
  const pickBanner = document.getElementById('bean-manager-pick-banner');
  if (pickBanner) pickBanner.hidden = true;
  const beanModalTitleEl = beanManagerModalEl.querySelector('.modal-title');
  if (beanModalTitleEl) beanModalTitleEl.textContent = pickCallback ? t('beanManager.pickTitle') : t('beanList.title');
  const placeholderEl = document.getElementById('bean-manager-placeholder');
  if (placeholderEl) placeholderEl.hidden = !!pickCallback;
  document.getElementById('bean-manager-detail') && (document.getElementById('bean-manager-detail').hidden = true);
  const addBtn = document.getElementById('btn-bean-manager-new');
  if (addBtn) addBtn.hidden = !!pickCallback;
  _beanManagerLoad();
}

document.getElementById('btn-bohnen')?.addEventListener('click', () => openBeanManagerModal());

document.getElementById('btn-bean-manager-close')?.addEventListener('click', () => {
  if (beanManagerModalEl) beanManagerModalEl.hidden = true;
});

beanManagerModalEl?.addEventListener('click', (e) => {
  if (e.target === beanManagerModalEl) beanManagerModalEl.hidden = true;
});

document.getElementById('bean-manager-search')?.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  const current = _beanManagerSearchQuery;
  openFieldPicker(null, [], {
    initialValue: current,
    onConfirm: (val) => {
      _beanManagerSearchQuery = val.trim();
      const searchEl = document.getElementById('bean-manager-search');
      if (searchEl) searchEl.value = _beanManagerSearchQuery;
      _beanManagerRenderList();
    },
  });
});

document.getElementById('bean-manager-list')?.addEventListener('click', (e) => {
  const header = e.target.closest('[data-bm-roaster]');
  if (!header) return;
  const roaster = header.dataset.bmRoaster;
  if (_beanManagerCollapsedRoasters.has(roaster)) {
    _beanManagerCollapsedRoasters.delete(roaster);
  } else {
    _beanManagerCollapsedRoasters.add(roaster);
  }
  _persistBeanManagerCollapsedRoasters();
  _beanManagerRenderList();
});

document.getElementById('btn-bean-manager-new')?.addEventListener('click', () => {
  _beanManagerSelectedBean = { _draft: true };
  _beanManagerShowAllFields = true;
  _beanManagerRenderList();
  _beanManagerRenderDetail(_beanManagerSelectedBean);
});

document.getElementById('chk-bean-manager-toggle-archive')?.addEventListener('change', (e) => {
  _beanManagerShowArchived = e.target.checked;
  _beanManagerLoad();
});


document.getElementById('bean-manager-detail')?.addEventListener('pointerdown', (e) => {
  const target = e.target.closest('.bean-manager-prop-split-half') || e.target.closest('.bean-manager-prop-tile[data-bm-field]');
  if (!target) return;
  e.preventDefault();
  const field   = target.dataset.bmField;
  const value   = target.dataset.bmValue;
  const type    = target.dataset.bmType;
  if (type === 'bool') {
    _beanManagerSaveField(field, value !== '1');
    return;
  }
  const inputMode = target.dataset.bmInputmode || 'text';
  openFieldPicker(null, _beanManagerSuggestions(field), {
    inputMode,
    initialValue: value,
    onConfirm: (newValue) => _beanManagerSaveField(field, newValue.trim()),
  });
});

document.getElementById('bean-manager-detail')?.addEventListener('click', async (e) => {
  if (e.target.closest('#btn-bm-cancel-new')) {
    _beanManagerSelectedBean = null;
    _beanManagerShowAllFields = false;
    _beanManagerRenderDetail(null);
    _beanManagerRenderList();
    return;
  }

  if (e.target.closest('#btn-bm-save-new')) {
    const draft = _beanManagerSelectedBean;
    if (!draft?._draft) return;
    const payload = {};
    if (draft.roaster)    payload.roaster     = draft.roaster;
    if (draft.name)       payload.name        = draft.name;
    if (draft.country)    payload.country     = draft.country;
    if (draft.region)     payload.region      = draft.region;
    if (draft.producer)   payload.producer    = draft.producer;
    if (draft.species)    payload.species     = draft.species;
    if (draft.processing) payload.processing  = draft.processing;
    if (draft.variety?.length) payload.variety = draft.variety;
    if (draft.altitude)   payload.altitude    = draft.altitude;
    if (draft.decaf)      payload.decaf       = draft.decaf;
    if (draft.decafProcess) payload.decafProcess = draft.decafProcess;
    if (draft.notes)      payload.notes       = draft.notes;
    const saveBtn = e.target.closest('#btn-bm-save-new');
    if (saveBtn) saveBtn.textContent = '…';
    try {
      const created = await createBean(payload);
      _beanManagerShowAllFields = false;
      await _beanManagerLoad();
      const newBean = _beanManagerAllBeans.find(b => b.id === created?.id) ?? null;
      if (newBean) _beanManagerSelectBean(newBean);
    } catch (err) {
      if (saveBtn) saveBtn.textContent = t('action.save');
      showToast(t('toast.error') + ': ' + err.message);
    }
    return;
  }

  if (e.target.closest('#btn-bm-toggle-fields')) {
    _beanManagerShowAllFields = !_beanManagerShowAllFields;
    _beanManagerRenderDetail(_beanManagerSelectedBean);
    return;
  }

  if (e.target.closest('#btn-bm-archive')) {
    if (!_beanManagerSelectedBean?.id) return;
    const bean = _beanManagerSelectedBean;
    const isArchived = !!bean.archived;
    if (!isArchived) {
      const visible = _beanManagerVisibleBeans();
      const idx = visible.findIndex(b => b.id === bean.id);
      const next = visible[idx + 1] ?? visible[idx - 1] ?? null;
      _beanManagerAutoSelectId = next?.id ?? null;
    }
    try {
      if (isArchived) { await unarchiveBean(bean.id, bean); showToast(t('toast.beanUnarchived')); }
      else            { await archiveBean(bean.id, bean);   showToast(t('toast.beanArchived'));   }
      _beanManagerLoad();
    } catch (err) { showToast(t('toast.error') + ': ' + err.message); }
    return;
  }

  if (e.target.closest('#btn-bm-delete')) {
    if (!_beanManagerSelectedBean?.id) return;
    if (!await showConfirm(t('confirm.deleteBean').replace('{name}', _beanManagerSelectedBean.name || t('beanEditor.unnamed')))) return;
    const deletedId = _beanManagerSelectedBean.id;
    try {
      await deleteBean(deletedId);
    } catch (err) {
      showToast(t('toast.error') + ': ' + err.message);
      return;
    }
    showToast(t('toast.beanDeleted'));
    _beanManagerSelectedBean = null;
    _beanManagerAllBeans = _beanManagerAllBeans.filter(b => b.id !== deletedId);
    _beanManagerRenderList();
    const detailEl = document.getElementById('bean-manager-detail');
    const placeholderEl = document.getElementById('bean-manager-placeholder');
    if (detailEl) detailEl.hidden = true;
    if (placeholderEl) placeholderEl.hidden = false;
    _beanManagerLoad();
    return;
  }
});

document.getElementById('btn-bean-manager-batch-add')?.addEventListener('click', () => {
  if (!_beanManagerSelectedBean?.id) return;
  _editingBean = _beanManagerSelectedBean;
  const listEl = document.getElementById('bean-manager-batch-list');
  const batches = listEl?._bmBatches;
  const latest = batches?.find(b => !b.archived) ?? batches?.[0] ?? null;
  if (latest) {
    openBatchModal({ ...latest, id: undefined, roastDate: undefined });
  } else {
    openBatchModal(null);
  }
});

document.getElementById('bean-manager-batch-list')?.addEventListener('click', async (e) => {
  // Action buttons
  const actionBtn = e.target.closest('[data-bm-batch-action]');
  if (actionBtn) {
    const action = actionBtn.dataset.bmBatchAction;
    const batchId = actionBtn.dataset.bmBatchId;
    const listEl = document.getElementById('bean-manager-batch-list');
    const batch = listEl?._bmBatches?.find(b => b.id === batchId);
    if (!batch) return;
    if (action === 'edit') {
      _editingBean = _beanManagerSelectedBean;
      openBatchModal(batch);
    } else if (action === 'archive') {
      try {
        await updateBatch(batchId, { archived: !batch.archived });
              if (_beanManagerSelectedBean?.id) _beanManagerLoadBatches(_beanManagerSelectedBean.id);
      } catch (err) { showToast(t('toast.error') + ': ' + err.message); }
    } else if (action === 'frozen') {
      try {
        await updateBatch(batchId, { frozen: !batch.frozen });
        if (_beanManagerSelectedBean?.id) _beanManagerLoadBatches(_beanManagerSelectedBean.id);
      } catch (err) { showToast(t('toast.error') + ': ' + err.message); }
    }
    return;
  }

  // Row pick
  const row = e.target.closest('.bean-manager-batch-row');
  if (!row) return;
  const batchId = row.dataset.bmBatchId;
  const listEl = document.getElementById('bean-manager-batch-list');
  const batch = listEl?._bmBatches?.find(b => b.id === batchId);
  if (_beanManagerPickCallback && batch && _beanManagerSelectedBean) {
    _beanManagerPickCallback(_beanManagerSelectedBean, batch);
  }
});

document.getElementById('chk-bean-manager-batch-show-archived')?.addEventListener('change', (e) => {
  _beanManagerShowArchivedBatches = e.target.checked;
  if (_beanManagerSelectedBean?.id) _beanManagerLoadBatches(_beanManagerSelectedBean.id);
});

// After batch delete, refresh the bean manager batch list if it's open
document.getElementById('btn-batch-delete')?.addEventListener('click', () => {
  if (beanManagerModalEl && !beanManagerModalEl.hidden && _beanManagerSelectedBean?.id) {
    const beanId = _beanManagerSelectedBean.id;
    setTimeout(() => _beanManagerLoadBatches(beanId), 200);
  }
});

/* ── Mühlen Modal ─────────────────────────────────────── */

const muehlenModalEl = document.getElementById('muehlen-modal');
const muehlenCreateModalEl = document.getElementById('muehlen-create-modal');
let _editingGrinder = null;

function renderGrinderTiles(grinders, gramsMap = new Map()) {
  const panel = document.getElementById('muehlen-panel-list');
  if (!panel) return;

  if (!Array.isArray(grinders) || grinders.length === 0) {
    panel.innerHTML = `<div class="bohnen-empty-state">${t('status.noGrinders')}</div>`;
    return;
  }

  panel.innerHTML = '<div class="bean-tile-grid"></div>';
  const grid = panel.querySelector('.bean-tile-grid');

  for (const g of grinders) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'bean-tile';

    const row = (label, value) => value && value !== '—'
      ? `<span class="bean-detail-label">${label}</span><span class="bean-detail-value">${value}</span>`
      : '';

    const burrTypeLabel    = g.burrType === 'conical' ? t('grinderEditor.conical') : g.burrType === 'flat' ? t('grinderEditor.flat') : '';
    const settingTypeLabel = g.settingType === 'preset' ? t('grinderEditor.positions') : t('grinderEditor.stepless');

    const totalGrams = gramsMap.get(normalizeWorkflowKeyPart(g.model)) || 0;
    const gramsStr   = totalGrams >= 1000
      ? `${(totalGrams / 1000).toFixed(1).replace('.', ',')} kg`
      : totalGrams > 0 ? `${Math.round(totalGrams)} g` : '';

    tile.innerHTML = `
      <span class="bean-tile-name">${g.model || '—'}</span>
      <hr class="bean-tile-divider">
      <div class="bean-tile-details grinder-tile-details">
        <div class="grinder-tile-meta">
          ${row(t('grinderEditor.burrs'), g.burrs)}
          ${row(t('grinderEditor.burrSize'), g.burrSize ? `${g.burrSize} mm` : '')}
          ${row(t('grinderEditor.type'), burrTypeLabel)}
          ${row(t('grinderEditor.setting'), settingTypeLabel)}
        </div>
        ${gramsStr ? `<div class="grinder-tile-grams">
          <span class="bean-detail-label">${t('grinderEditor.gramsUsed')}</span>
          <span class="bean-detail-value">${gramsStr}</span>
        </div>` : ''}
      </div>
    `;

    tile.addEventListener('click', () => openGrinderDetailModal(g));
    grid.appendChild(tile);
  }
}

async function loadAndRenderGrinders() {
  const panel = document.getElementById('muehlen-panel-list');
  if (panel) panel.innerHTML = `<div class="bohnen-empty-state">${t('status.loading')}</div>`;
  try {
    const [grindersRes, peek] = await Promise.all([fetchGrinders(), fetchShots(1)]);
    const gList = Array.isArray(grindersRes) ? grindersRes : (grindersRes?.items ?? []);
    _grindersCache = gList;

    // Fetch all shots to sum grams per grinder model
    const total = peek?.total || 0;
    let allShots = peek?.items || [];
    if (total > allShots.length) {
      try {
        const all = await fetchShots(total);
        allShots = all?.items || allShots;
      } catch { /* use peek items as fallback */ }
    }

    const gramsMap = new Map();
    for (const shot of allShots) {
      const ctx   = shot?.workflow?.context || {};
      const model = normalizeWorkflowKeyPart(ctx.grinderModel);
      if (model === '—') continue;
      const dose  = Number(ctx.targetDoseWeight || 0);
      if (dose > 0) gramsMap.set(model, (gramsMap.get(model) || 0) + dose);
    }

    renderGrinderTiles(gList, gramsMap);
  } catch {
    if (panel) panel.innerHTML = '<div class="bohnen-empty-state">Fehler beim Laden</div>';
  }
}

function openMuehlenModal() {
  if (muehlenModalEl) {
    muehlenModalEl.hidden = false;
    loadAndRenderGrinders();
  }
}

document.getElementById('btn-muehlen')?.addEventListener('click', openMuehlenModal);

muehlenModalEl?.addEventListener('click', (e) => {
  if (e.target === muehlenModalEl) muehlenModalEl.hidden = true;
});

/* ── Mühlen Create / Edit Modal ───────────────────────── */

function _setGrinderSettingType(type) {
  const toggle = document.getElementById('grinder-setting-type-toggle');
  toggle?.querySelectorAll('.grinder-toggle-btn').forEach(btn => {
    btn.classList.toggle('is-active', btn.dataset.type === type);
  });
  const numericEl = document.getElementById('grinder-numeric-fields');
  const presetEl  = document.getElementById('grinder-preset-fields');
  if (numericEl) numericEl.hidden = type !== 'numeric';
  if (presetEl)  presetEl.hidden  = type !== 'preset';
}

document.getElementById('grinder-setting-type-toggle')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.grinder-toggle-btn');
  if (btn?.dataset.type) _setGrinderSettingType(btn.dataset.type);
});

function openGrinderDetailModal(grinder = null) {
  _editingGrinder = grinder;

  const titleEl = muehlenCreateModalEl?.querySelector('.modal-title');
  if (titleEl) titleEl.textContent = grinder ? t('grinderEditor.editTitle') : t('grinderEditor.title');

  document.getElementById('grinder-model').value      = grinder?.model             ?? '';
  document.getElementById('grinder-burrs').value      = grinder?.burrs             ?? '';
  document.getElementById('grinder-burr-size').value  = grinder?.burrSize          ?? '';
  document.getElementById('grinder-burr-type').value  = grinder?.burrType          ?? '';
  document.getElementById('grinder-small-step').value = grinder?.settingSmallStep  ?? '';
  document.getElementById('grinder-big-step').value   = grinder?.settingBigStep    ?? '';

  const presetsRaw = Array.isArray(grinder?.settingValues)
    ? grinder.settingValues.join(', ')
    : '';
  document.getElementById('grinder-setting-values').value = presetsRaw;

  _setGrinderSettingType(grinder?.settingType ?? 'numeric');

  document.getElementById('grinder-model')
    ?.closest('.bean-field-row')?.classList.remove('is-invalid');

  const deleteBtn = document.getElementById('btn-grinder-delete');
  if (deleteBtn) deleteBtn.hidden = !grinder?.id;

  if (muehlenCreateModalEl) muehlenCreateModalEl.hidden = false;
}

document.getElementById('btn-muehlen-close')?.addEventListener('click', () => {
  if (muehlenModalEl) muehlenModalEl.hidden = true;
});

document.getElementById('btn-muehlen-new')?.addEventListener('click', () => openGrinderDetailModal(null));

document.getElementById('btn-muehlen-back')?.addEventListener('click', () => {
  if (muehlenCreateModalEl) muehlenCreateModalEl.hidden = true;
});

muehlenCreateModalEl?.addEventListener('click', (e) => {
  if (e.target === muehlenCreateModalEl) muehlenCreateModalEl.hidden = true;
});

document.getElementById('btn-grinder-delete')?.addEventListener('click', async () => {
  if (!_editingGrinder?.id) return;
  try {
    await deleteGrinder(_editingGrinder.id);
    if (muehlenCreateModalEl) muehlenCreateModalEl.hidden = true;
    showToast(t('toast.grinderDeleted').replace('{name}', _editingGrinder.model));
    loadAndRenderGrinders();
  } catch (err) {
    showToast(t('toast.grinderDeleteFailed') + ': ' + err.message);
  }
});

document.getElementById('btn-muehlen-save')?.addEventListener('click', async () => {
  const modelEl = document.getElementById('grinder-model');
  const model   = modelEl?.value.trim() ?? '';

  if (!model) {
    modelEl?.closest('.bean-field-row')?.classList.add('is-invalid');
    showToast(t('toast.grinderModelRequired'));
    return;
  }
  modelEl?.closest('.bean-field-row')?.classList.remove('is-invalid');

  const burrs       = document.getElementById('grinder-burrs')?.value.trim()     || undefined;
  const burrSizeRaw = document.getElementById('grinder-burr-size')?.value;
  const burrType    = document.getElementById('grinder-burr-type')?.value         || undefined;

  const activeTypeBtn = document.querySelector('#grinder-setting-type-toggle .grinder-toggle-btn.is-active');
  const settingType   = activeTypeBtn?.dataset.type ?? 'numeric';

  const smallStepRaw = document.getElementById('grinder-small-step')?.value;
  const bigStepRaw   = document.getElementById('grinder-big-step')?.value;
  const presetsRaw   = document.getElementById('grinder-setting-values')?.value.trim() ?? '';

  const payload = { model, settingType };
  if (burrs) payload.burrs = burrs;

  const burrSize = burrSizeRaw !== '' ? Number(burrSizeRaw) : null;
  if (Number.isFinite(burrSize) && burrSize > 0) payload.burrSize = burrSize;
  if (burrType) payload.burrType = burrType;

  if (settingType === 'numeric') {
    const small = smallStepRaw !== '' ? Number(smallStepRaw) : null;
    const big   = bigStepRaw   !== '' ? Number(bigStepRaw)   : null;
    if (Number.isFinite(small) && small > 0) payload.settingSmallStep = small;
    if (Number.isFinite(big)   && big   > 0) payload.settingBigStep   = big;
  } else {
    const values = presetsRaw ? presetsRaw.split(',').map(v => v.trim()).filter(Boolean) : undefined;
    if (values?.length) payload.settingValues = values;
  }

  const saveBtn = document.getElementById('btn-muehlen-save');
  if (saveBtn) saveBtn.textContent = '…';

  try {
    if (_editingGrinder?.id) {
      await updateGrinder(_editingGrinder.id, payload);
    } else {
      await createGrinder(payload);
    }
    if (saveBtn) saveBtn.textContent = t('action.save');
    if (muehlenCreateModalEl) muehlenCreateModalEl.hidden = true;
    showToast(_editingGrinder?.id
      ? t('toast.grinderSaved').replace('{name}', model)
      : t('toast.grinderAdded').replace('{name}', model));
    loadAndRenderGrinders();
  } catch (err) {
    if (saveBtn) saveBtn.textContent = t('action.save');
    showToast(t('toast.grinderSaveFailed') + ': ' + err.message);
  }
});

/* ── Phone Layout ─────────────────────────────────────── */

const _PHONE_MEDIA = typeof window.matchMedia === 'function'
  ? window.matchMedia('(max-width: 767px)')
  : null;

let _phoneGroupTemp = null;
let _phoneSteamTemp = null;
let _phoneActiveTab = 'home';

const _PHONE_STATE_LABELS = {
  sleeping: 'Sleeping', heating: 'Heating', preheating: 'Heating',
  espresso: 'Brewing', steam: 'Steaming', hotWater: 'Hot Water',
  flush: 'Flushing', needsWater: 'Needs Water', error: 'Error',
  cleaning: 'Cleaning', descaling: 'Descaling',
};

function _updatePhoneMachineCard() {
  if (!document.body.classList.contains('is-phone')) return;

  const groupEl = document.getElementById('phone-group-temp');
  if (groupEl) groupEl.textContent = _phoneGroupTemp != null ? `${Math.round(_phoneGroupTemp)}°` : '—°';

  const steamEl = document.getElementById('phone-steam-temp');
  if (steamEl) steamEl.textContent = _phoneSteamTemp != null ? `${Math.round(_phoneSteamTemp)}°` : '—°';

  const statusWrap = document.getElementById('phone-machine-status');
  const statusText = document.getElementById('phone-machine-status-text');
  if (statusWrap) statusWrap.dataset.state = currentMachineState;
  if (statusText) statusText.textContent = _PHONE_STATE_LABELS[currentMachineState] || 'Ready';
}

function _selectPhoneTab(tab) {
  _phoneActiveTab = tab;
  document.querySelectorAll('#phone-nav .phone-nav-btn').forEach(btn => {
    btn.classList.toggle('is-active', btn.dataset.tab === tab);
  });
  if (tab === 'home') window.NSXRouter?.setTab(0);
  if (tab === 'history') window.NSXRouter?.setTab(2);
}

function _applyPhoneLayout() {
  const isPhone = _PHONE_MEDIA?.matches === true;
  document.body.classList.toggle('is-phone', isPhone);
  const nav = document.getElementById('phone-nav');
  if (nav) nav.hidden = !isPhone;
  if (isPhone) _updatePhoneMachineCard();
}

document.getElementById('phone-nav')?.addEventListener('click', e => {
  const btn = e.target.closest('.phone-nav-btn');
  if (btn?.dataset.tab) _selectPhoneTab(btn.dataset.tab);
});

_PHONE_MEDIA?.addEventListener('change', _applyPhoneLayout);

/* ── Initialization ───────────────────────────────────── */

renderWorkflows([], selectedWorkflowIndex);
setMachineConnected(false);
setMachineStateText("idle");
setScaleConnected(false);
setBrewGroupTemperature(91.5);
setWaterLevel(0);
setSteamWidget(steamTemp, steamFlow, steamDuration);
setHotwaterWidget(NSXCore.getHotwaterTemp(), NSXCore.getHotwaterFlow(), NSXCore.getHotwaterVolume());
updateFlushDisplay();
renderScheduleUI();
applyPresetButtonStates();
_applyPhoneLayout();

setupPresenceTracking();
setupDisplayControl();

NSXCore.migrateLegacyStore()
  .catch(() => {})
  .finally(() => {
    hydrateUiSettingsFromStore();
    loadApiData();
  });

document.getElementById('btn-steam-overlay-stop')?.addEventListener('click', () => {
  setMachineState?.('idle').catch(() => {});
});

document.getElementById('btn-steam-overlay-back')?.addEventListener('click', () => {
  const overlayEl = document.getElementById('steam-overlay');
  const cornerEl  = document.getElementById('steam-corner');
  if (overlayEl) overlayEl.hidden = true;
  if (cornerEl && steamSession)  cornerEl.hidden  = false;
});

document.getElementById('btn-steam-corner-stop')?.addEventListener('click', () => {
  setMachineState?.('idle').catch(() => {});
});

document.getElementById('btn-steam-corner-graph')?.addEventListener('click', () => {
  const cornerEl  = document.getElementById('steam-corner');
  const overlayEl = document.getElementById('steam-overlay');
  const graphEl   = document.getElementById('steam-overlay-graph');
  const targetEl  = document.getElementById('steam-overlay-target');
  const progressEl= document.getElementById('steam-overlay-progress');
  if (cornerEl)  cornerEl.hidden  = true;
  if (targetEl && steamDuration > 0) targetEl.textContent = `/ ${steamDuration} s`;
  if (progressEl && steamDuration > 0) {
    const sec = steamSession ? Math.floor((Date.now() - steamSession.startTime) / 1000) : 0;
    progressEl.style.width = `${(Math.min(sec / steamDuration, 1) * 100).toFixed(1)}%`;
  }
  if (overlayEl) overlayEl.hidden = false;
  requestAnimationFrame(() => {
    if (graphEl) initSteamChart?.(graphEl);
    if (graphEl && steamSession) updateSteamChart?.(graphEl, steamSession);
  });
});

document.getElementById('btn-hotwater-overlay-stop')?.addEventListener('click', () => {
  setMachineState?.('idle').catch(() => {});
});

document.getElementById('btn-flush-overlay-stop')?.addEventListener('click', () => {
  setMachineState?.('idle').catch(() => {});
});

document.getElementById('btn-needswater-overlay-stop')?.addEventListener('click', () => {
  setMachineState?.('idle').catch(() => {});
});

document.getElementById('btn-espresso-fs-exit')?.addEventListener('click', () => {
  if (currentMachineState === 'espresso') {
    setMachineState?.('idle').catch(() => {});
    return;
  }
  _clearEspressoFullscreenCloseTimer();
  closeEspressoFullscreen();
  window.NSXRouter?.setTab(1);
});

document.getElementById('btn-espresso-fs-skip-step')?.addEventListener('click', () => {
  if (currentMachineState !== 'espresso') {
    showToast(t('toast.skipStepOnly'));
    return;
  }

  if (_skipStepInFlight) {
    return;
  }

  const now = Date.now();
  if (now - _skipStepLastSentAt < SKIP_STEP_MIN_INTERVAL_MS) {
    return;
  }

  const currentFrame = Number.isFinite(liveShot?.lastProfileFrame) ? liveShot.lastProfileFrame : null;
  if (currentFrame !== null && currentFrame === _skipStepGuardFrame) {
    showToast(t('toast.stepSkipped'));
    return;
  }

  _skipStepInFlight = true;

  setMachineState?.('skipStep')
    .then(() => {
      _skipStepLastSentAt = Date.now();
      if (currentFrame !== null) {
        _skipStepGuardFrame = currentFrame;
      }
    })
    .catch(() => showToast(t('toast.skipStepFailed')))
    .finally(() => {
      _skipStepInFlight = false;
    });
});

document.querySelector('.workflow-graph-area')?.addEventListener('click', (e) => {
  if (!e.target.closest('#btn-wf-skip-step')) return;
  if (currentMachineState !== 'espresso') {
    showToast(t('toast.skipPhaseOnly'));
    return;
  }
  if (_skipStepInFlight) return;
  const now = Date.now();
  if (now - _skipStepLastSentAt < SKIP_STEP_MIN_INTERVAL_MS) return;
  const currentFrame = Number.isFinite(liveShot?.lastProfileFrame) ? liveShot.lastProfileFrame : null;
  if (currentFrame !== null && currentFrame === _skipStepGuardFrame) {
    showToast(t('toast.phaseSkipped'));
    return;
  }
  _skipStepInFlight = true;
  setMachineState?.('skipStep')
    .then(() => {
      _skipStepLastSentAt = Date.now();
      if (currentFrame !== null) _skipStepGuardFrame = currentFrame;
    })
    .catch(() => showToast(t('toast.skipPhaseFailed')))
    .finally(() => { _skipStepInFlight = false; });
});

})();
