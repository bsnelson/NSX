/**
 * ui.js
 *
 * DOM update functions for rendering state changes:
 *   - Machine/Scale connection status
 *   - Temperature displays
 *   - Workflow rendering and selection
 *   - Water level gauge
 *   - Toast notifications
 *
 * Depends on: nothing (maps to existing HTML elements)
 */
"use strict";

(() => {

/* ── DOM Elements ─────────────────────────────────────── */
const clockEl = document.getElementById("clock");
const toastEl = document.getElementById("toast");
const machineStatusTextEl = document.getElementById("machine-status-text");
const machineStatusPillEl = document.getElementById("machine-status-pill");
const scaleStatusPillEl = document.getElementById("scale-status-pill");
const scaleTareButtonEl = document.getElementById("btn-scale-tare");
const homeWorkflowRoasterEl = document.getElementById("home-workflow-roaster");
const homeWorkflowBeanEl = document.getElementById("home-workflow-bean");
const homeWorkflowGrinderEl = document.getElementById("home-workflow-grinder");
const homeWorkflowSettingEl = document.getElementById("home-workflow-setting");
const homeWorkflowProfileEl = document.getElementById("home-workflow-profile");
const homeWorkflowDoseEl = document.getElementById("home-workflow-dose");
const homeWorkflowTempEl = document.getElementById("home-workflow-temp");
const homeWorkflowBeverageEl = document.getElementById("home-workflow-beverage");
const homeWorkflowLastShotDateEl = document.getElementById("home-workflow-last-shot-date");
const homeWorkflowLastShotDurationEl = document.getElementById("home-workflow-last-shot-duration");
const waterSectionEl = document.getElementById("water-section");
const waterLevelTextEl = document.getElementById("water-level-text");
const waterGaugeFillEl = document.getElementById("water-gauge-fill");
const waterRefillLabelEl = document.getElementById("water-refill-label");
const headerWaterGaugeFill = document.getElementById("header-water-gauge-fill");
const workflowScalePillEl = document.getElementById("workflow-scale-pill");
const headerWaterPctEl = document.getElementById("header-water-pct");
const headerWaterIndicator = document.querySelector(".header-water-indicator");
const brewTempValueEl = document.getElementById("brew-temp-value");
const temperatureOrbEl = document.getElementById("temperature-orb");
const steamTemperatureOrbEl = document.getElementById("steam-temperature-orb");

// ── Retro gauge setup ───────────────────────────────────────────────────────
const _gaugeMin = 20, _gaugeMid = 60, _gaugeMax = 100;
const _gaugeSplit = 0.22; // cold zone gets 22% of width, hot zone gets 78%

function _tempToGaugePct(temp) {
  const t = Math.max(_gaugeMin, Math.min(_gaugeMax, temp));
  if (t <= _gaugeMid) {
    return _gaugeSplit * (t - _gaugeMin) / (_gaugeMid - _gaugeMin);
  }
  return _gaugeSplit + (1 - _gaugeSplit) * (t - _gaugeMid) / (_gaugeMax - _gaugeMid);
}

function _buildGaugeTicks(ticksEl) {
  ticksEl.innerHTML = '';
  for (let t = _gaugeMin; t <= _gaugeMax; t++) {
    const isMajor = t % 10 === 0;
    const pct = _tempToGaugePct(t) * 100;
    for (const pos of ['top', 'bottom']) {
      const tick = document.createElement('div');
      tick.className = `temp-gauge-tick ${isMajor ? 'major' : 'minor'} ${pos}`;
      tick.style.left = `${pct}%`;
      ticksEl.appendChild(tick);
    }
  }
}

(function initGroupTempGauge() {
  const ticksEl = document.getElementById('group-temp-ticks');
  const redZoneEl = document.getElementById('group-temp-red-zone');
  if (ticksEl) _buildGaugeTicks(ticksEl);
  if (redZoneEl) {
    const left = _tempToGaugePct(85) * 100;
    redZoneEl.style.left = `${left}%`;
    redZoneEl.style.right = '0';
  }
})();
const steamOrbTempValueEl = document.getElementById("steam-orb-temp-value");
const steamTempEl = document.getElementById("steam-temp");
const steamFlowEl = document.getElementById("steam-flow");
const steamDurationEl = document.getElementById("steam-duration");
const hotwaterTempEl = document.getElementById("hotwater-temp");
const hotwaterFlowEl = document.getElementById("hotwater-flow");
const hotwaterVolumeEl = document.getElementById("hotwater-volume");
const recipeListShellEl = document.getElementById("recipe-list-shell");
const recipeListScrollEl = document.getElementById("recipe-list-scroll");
const workflowListEl = document.getElementById("workflow-list");
const machineInfoModelEl = document.getElementById("machine-info-model");
const machineInfoVersionEl = document.getElementById("machine-info-version");
const machineInfoSerialEl = document.getElementById("machine-info-serial");

/* ── State ────────────────────────────────────────────── */
let toastTimer;
const TARGET_BREW_TEMPERATURE = 80;
let currentSteamTarget = 135;
const WATER_TANK_MAX_MM = 43;
const ML_PER_MM = 1140 / 41;
let waterLevelMm = 0;
let waterRefillLevelMm = null;
let _waterDisplayUnit = 'pct';

// uPlot chart colors
const CHART_COLORS = {
  pressure: '#18b890',
  pressureGoal: '#5cd4a8',
  flow: '#4878e8',
  flowGoal: '#6e9af0',
  temperature: '#e8495a',
  temperatureGoal: '#e88a94',
  weightRate: '#c08840',
  textSecondary: 'rgba(255,255,255,0.32)',
  grid: 'rgba(255,255,255,0.07)',
};

function makeGradFill(r, g, b, alpha = 0.16) {
  return (u) => {
    const grad = u.ctx.createLinearGradient(0, u.bbox.top, 0, u.bbox.top + u.bbox.height);
    grad.addColorStop(0, `rgba(${r},${g},${b},${alpha})`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    return grad;
  };
}

// Faded ("ghost") variant of a #rrggbb colour, for the reference-shot overlay.
function _fadeHex(hex, alpha) {
  const h = String(hex).replace('#', '');
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// Linear-resample a reference series (refX→refY) onto targetX (the current shot's
// elapsed grid). Returns null outside the reference's time range so the line stops.
function _resampleSeries(refX, refY, targetX) {
  const n = refX?.length || 0;
  const out = new Array(targetX.length).fill(null);
  if (!n || !Array.isArray(refY)) return out;
  let j = 0;
  for (let i = 0; i < targetX.length; i++) {
    const t = targetX[i];
    if (!Number.isFinite(t) || t < refX[0] || t > refX[n - 1]) { out[i] = null; continue; }
    while (j < n - 1 && refX[j + 1] < t) j++;
    const k = Math.min(j + 1, n - 1);
    const x0 = refX[j], x1 = refX[k], y0 = refY[j], y1 = refY[k];
    if (!Number.isFinite(y0)) { out[i] = Number.isFinite(y1) ? y1 : null; continue; }
    out[i] = (x1 === x0 || !Number.isFinite(y1)) ? y0 : y0 + (y1 - y0) * ((t - x0) / (x1 - x0));
  }
  return out;
}

const DEFAULT_SERIES_VISIBILITY = {
  pressure: true,
  flow: true,
  scaleRate: true,
  temperature: true,
  steps: true,
  goals: true,
};

let WORKFLOW_SERIES_VISIBILITY = { ...DEFAULT_SERIES_VISIBILITY };
let LIVE_SERIES_VISIBILITY    = { ...DEFAULT_SERIES_VISIBILITY };
let HISTORY_SERIES_VISIBILITY = { ...DEFAULT_SERIES_VISIBILITY };

/* ── i18n shorthand ──────────────────────────────────── */
const t = k => window.NSXI18n?.t?.(k) ?? k;

function getSeriesVisibility(overrides, mode = 'workflow') {
  const base = mode === 'live' ? LIVE_SERIES_VISIBILITY
             : mode === 'history' ? HISTORY_SERIES_VISIBILITY
             : WORKFLOW_SERIES_VISIBILITY;
  return { ...base, ...(overrides || {}) };
}

function setSeriesVisibility(mode, visibility) {
  const resolved = getSeriesVisibility(visibility, mode);
  if (mode === 'live') {
    LIVE_SERIES_VISIBILITY = { ...resolved };
  } else if (mode === 'history') {
    HISTORY_SERIES_VISIBILITY = { ...resolved };
  } else {
    WORKFLOW_SERIES_VISIBILITY = { ...resolved };
  }
  window.dispatchEvent(new CustomEvent('ui:seriesVisibilityChanged', { detail: { mode, visibility: { ...resolved } } }));
}

function applyVisibilityToChart(chart, visibility) {
  if (!chart || typeof chart.setSeries !== 'function') return;
  chart.setSeries(1, { show: visibility.pressure !== false });
  chart.setSeries(2, { show: visibility.goals !== false && visibility.pressure !== false });
  chart.setSeries(3, { show: visibility.flow !== false });
  chart.setSeries(4, { show: visibility.goals !== false && visibility.flow !== false });
  chart.setSeries(5, { show: visibility.scaleRate !== false });
  chart.setSeries(6, { show: visibility.temperature !== false });
  chart.setSeries(7, { show: visibility.goals !== false && visibility.temperature !== false });
}

/* ── Toast ────────────────────────────────────────────── */

/**
 * Show a brief notification toast.
 * @param {string} msg       - Message to display
 * @param {number} [ms=3000] - Auto-hide delay in milliseconds
 */
function showToast(msg, ms = 3000) {
  clearTimeout(toastTimer);
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), ms);
}

const stateToastEl = document.getElementById('state-toast');
let stateToastTimer;

function showStateToast(msg, ms = 2500) {
  if (!stateToastEl) return;
  clearTimeout(stateToastTimer);
  stateToastEl.textContent = msg;
  stateToastEl.classList.add('show');
  stateToastTimer = setTimeout(() => stateToastEl.classList.remove('show'), ms);
}

/* ── Status Updates ───────────────────────────────────── */

function setMachineConnected(connected) {
  if (machineStatusPillEl) {
    machineStatusPillEl.textContent = connected ? t('status.connected') : t('status.disconnected');
    machineStatusPillEl.className = connected
      ? "status-pill status-pill-connected"
      : "status-pill status-pill-disconnected";
  }
  const iconArea = document.getElementById('machine-icon-area');
  if (iconArea) iconArea.classList.toggle('is-disconnected', !connected);
}

function setMachineStateText(state) {
  machineStatusTextEl.textContent = state;
}

/**
 * Populate static machine metadata from GET /api/v1/machine/info.
 * @param {{model?: string, version?: string, serialNumber?: string}} info
 */
function setMachineInfo(info) {
  if (machineInfoModelEl) {
    machineInfoModelEl.textContent = info?.model || "—";
  }
  if (machineInfoVersionEl) {
    machineInfoVersionEl.textContent = info?.version || "—";
  }
  if (machineInfoSerialEl) {
    machineInfoSerialEl.textContent = info?.serialNumber || "—";
  }
}

function setScaleConnected(connected) {
  scaleStatusPillEl.textContent = connected ? t('status.connected') : t('status.disconnected');
  scaleStatusPillEl.className = connected
    ? "status-pill status-pill-connected"
    : "status-pill status-pill-disconnected";
  if (scaleTareButtonEl) {
    scaleTareButtonEl.disabled = false;
    scaleTareButtonEl.classList.toggle('scale-plate-btn--offline', !connected);
  }
  if (workflowScalePillEl) {
    workflowScalePillEl.textContent = '';
    workflowScalePillEl.classList.toggle('is-connected', connected);
  }
}

function formatTemperature(value) {
  return value.toLocaleString("de-DE", {
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  });
}

function setBrewGroupTemperature(value, target = TARGET_BREW_TEMPERATURE) {
  const delta = target - value;
  const isReady = Math.abs(delta) <= 2.0;
  const isWarmup = delta > 2.0;
  const progress = isReady ? 100 : Math.max(0, Math.min(value / target, 1)) * 100;
  const orbStateClass = isReady
    ? "temperature-orb-ready"
    : isWarmup
      ? "temperature-orb-warmup"
      : "temperature-orb-cold";
  brewTempValueEl.textContent = formatTemperature(value);
  temperatureOrbEl.className = `temperature-orb ${orbStateClass}`;
  temperatureOrbEl.style.setProperty("--temperature-progress", `${progress.toFixed(1)}%`);

  // Retro gauge
  const needleEl = document.getElementById('group-temp-needle');
  const valueEl  = document.getElementById('group-temp-gauge-value');
  if (needleEl) {
    const pct = (_tempToGaugePct(value) * 100).toFixed(2);
    needleEl.style.setProperty('--needle-base', `${pct}%`);
    needleEl.style.left = `${pct}%`;
    needleEl.classList.toggle('is-jittering', isReady);
  }
  if (valueEl) valueEl.textContent = `${formatTemperature(value)} °C`;
}

/* ── Workflow Display ─────────────────────────────────── */

function renderWorkflows(workflows, selectedIndex) {
  if (!Array.isArray(workflows) || workflows.length === 0) {
    workflowListEl.innerHTML = "";
    return;
  }

  const editIconSvg = `<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <path d="M10.5 4H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2V8.5"/>
    <path d="M15.2 2.8a1.7 1.7 0 0 1 2.4 2.4L10 12.8 7.5 13.5l.7-2.5 7-8.2z"/>
  </svg>`;

  const deleteIconSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true">
    <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
  </svg>`;

  workflowListEl.innerHTML = workflows.map((workflow, index) => {
    const origIdx = workflow._origIdx ?? index;
    const isActive = origIdx === selectedIndex;
    const isPending = !!workflow.isPending;
    return `
    <li class="recipe-item workflow-card${isActive ? " workflow-card-active" : ""}${isPending ? " workflow-card-pending" : ""}" data-workflow-index="${origIdx}">
      <div class="workflow-delete-zone">
        <button type="button" class="workflow-delete-btn" data-delete-index="${origIdx}" aria-label="${t('history.deleteAria')}">${deleteIconSvg}</button>
      </div>
      <div class="workflow-swipe-layer">
        <div class="workflow-card-copy">
          <div class="workflow-compact-meta">
            <span class="workflow-compact-item">
              <span class="workflow-compact-label">${workflow.coffeeRoaster}</span>
              <span class="workflow-compact-value">${workflow.coffeeName}</span>
            </span>
            <span class="workflow-compact-item">
              <span class="workflow-compact-label">${t('recipe.grinder')}</span>
              <span class="workflow-compact-value">${workflow.grinderModel}</span>
            </span>
            <span class="workflow-compact-item">
              <span class="workflow-compact-label">${t('recipe.grindSize')}</span>
              <span class="workflow-compact-value"${isActive ? ' data-field="grinderSetting"' : ''}>${workflow.grinderSetting}</span>
            </span>
          </div>
          <div class="workflow-compact-meta workflow-compact-meta--duo">
            <span class="workflow-compact-item">
              <span class="workflow-compact-label">${t('recipe.beverage')}</span>
              <span class="workflow-compact-value"${isActive ? ' data-field="dose-yield"' : ''}>${workflow.targetDoseWeight}g:${workflow.targetYield}g</span>
            </span>
            <span class="workflow-compact-item">
              <span class="workflow-compact-label">${t('recipe.profile')}</span>
              <span class="workflow-compact-value">${workflow.profileTitle}</span>
            </span>
          </div>
          <div class="workflow-compact-ratio-tags">${workflow.ratio && workflow.ratio !== '—' ? `<span class="workflow-compact-ratio">(${workflow.ratio})</span>` : ''}${Array.isArray(workflow.tags) && workflow.tags.length ? workflow.tags.map(tag => `<span class="workflow-compact-tag">${tag}</span>`).join('') : ''}${_renderRecipeRating(_recipeKey(workflow), workflow.maxRating, workflow.ratedCount)}</div>
        </div>
      </div>
    </li>
  `;
  }).join("");

  updateRecipeListFade();
  _onRecipesRendered?.();
}

const _syncDotEl = document.getElementById('home-workflow-sync');
function setWorkflowSyncState(state) {
  const dots = [_syncDotEl, document.querySelector('.home-rr-sync-dot')].filter(Boolean);
  for (const dot of dots) {
    dot.classList.remove('is-synced', 'is-pending', 'is-error');
    if (state) dot.classList.add(`is-${state}`);
  }
}

function setCurrentWorkflow(workflow) {
  const widget = document.getElementById('btn-home-workflow-edit');
  if (!workflow) {
    widget?.classList.add('is-empty');
    return;
  }
  widget?.classList.remove('is-empty');
  if (homeWorkflowRoasterEl) homeWorkflowRoasterEl.textContent = workflow.coffeeRoaster;
  if (homeWorkflowBeanEl)    homeWorkflowBeanEl.textContent    = workflow.coffeeName;
  if (homeWorkflowGrinderEl) homeWorkflowGrinderEl.textContent = workflow.grinderModel;
  if (homeWorkflowSettingEl) homeWorkflowSettingEl.textContent = workflow.grinderSetting;
  if (homeWorkflowProfileEl) homeWorkflowProfileEl.textContent = workflow.profileTitle;
  if (homeWorkflowDoseEl)    homeWorkflowDoseEl.textContent    = workflow.targetDoseWeight > 0 ? `${workflow.targetDoseWeight}g` : "—";
  if (homeWorkflowTempEl) {
    const g = Number(workflow.groupTemp);
    homeWorkflowTempEl.textContent = workflow.profileTemp || (g > 0 ? `${g}°C` : "—");
  }
  if (homeWorkflowBeverageEl) {
    const yield_ = Number(workflow.targetYield);
    const weight = yield_ > 0 ? `${yield_}g` : null;
    const ratio  = workflow.ratio && workflow.ratio !== "—" ? `(${workflow.ratio})` : null;
    homeWorkflowBeverageEl.textContent = [weight, ratio].filter(Boolean).join(" ") || "—";
  }
}

/* ── Water Level ──────────────────────────────────────── */

function updateWaterWarningState() {
  const hasThreshold = Number.isFinite(waterRefillLevelMm);
  const isLow = hasThreshold && waterLevelMm <= waterRefillLevelMm;
  if (waterSectionEl) waterSectionEl.classList.toggle("is-low", isLow);
  if (waterGaugeFillEl) waterGaugeFillEl.classList.toggle("is-low", isLow);
  if (headerWaterIndicator) headerWaterIndicator.classList.toggle("is-low", isLow);
}

function setWaterRefillLevel(mm) {
  const value = Number(mm);
  waterRefillLevelMm = Number.isFinite(value) ? Math.max(5, Math.min(value, WATER_TANK_MAX_MM)) : null;
  if (waterRefillLabelEl) {
    waterRefillLabelEl.textContent = Number.isFinite(waterRefillLevelMm)
      ? `${waterRefillLevelMm} mm (${Math.round(waterRefillLevelMm * ML_PER_MM)} ml)`
      : '– mm';
  }
  updateWaterWarningState();
}

function setWaterLevel(mm) {
  waterLevelMm = Math.max(0, Number(mm));
  const smoothedMl = Math.round((waterLevelMm * ML_PER_MM) / 10) * 10;
  const fillPct = Math.min((smoothedMl / (WATER_TANK_MAX_MM * ML_PER_MM)) * 100, 100);
  if (waterGaugeFillEl) waterGaugeFillEl.style.height = `${fillPct}%`;
  if (headerWaterGaugeFill) headerWaterGaugeFill.style.height = `${fillPct}%`;
  if (headerWaterPctEl) headerWaterPctEl.textContent = _waterDisplayUnit === 'ml'
    ? `${smoothedMl} ml`
    : `${Math.round(fillPct)}%`;
  updateWaterWarningState();
  if (waterLevelTextEl) waterLevelTextEl.textContent = `${smoothedMl} ml`;
}

/* ── Steam & Hotwater ─────────────────────────────────── */

function setSteamWidget(temperature, flowRate, duration) {
  if (steamTempEl) steamTempEl.textContent = `${Number(temperature).toFixed(0)}°C`;
  if (steamFlowEl) steamFlowEl.textContent = `${Number(flowRate).toFixed(1)} ml/s`;
  if (steamDurationEl) steamDurationEl.textContent = `${Math.round(Number(duration))} s`;
  const t = Number(temperature);
  if (Number.isFinite(t)) currentSteamTarget = t;
}

function setSteamTemperatureOrb(value) {
  if (!steamTemperatureOrbEl || !steamOrbTempValueEl) return;
  const v = Number(value);
  if (!Number.isFinite(v)) {
    steamOrbTempValueEl.textContent = "—";
    steamTemperatureOrbEl.className = "temperature-orb temperature-orb-cold";
    steamTemperatureOrbEl.style.setProperty("--temperature-progress", "0%");
    return;
  }
  const delta = currentSteamTarget - v;
  const isReady = Math.abs(delta) <= 5.0;
  const isWarmup = delta > 5.0;
  const progress = isReady ? 100 : Math.max(0, Math.min(v / currentSteamTarget, 1)) * 100;
  const orbStateClass = isReady
    ? "temperature-orb-ready"
    : isWarmup
      ? "temperature-orb-warmup"
      : "temperature-orb-cold";
  steamOrbTempValueEl.textContent = formatTemperature(v);
  steamTemperatureOrbEl.className = `temperature-orb ${orbStateClass}`;
  steamTemperatureOrbEl.style.setProperty("--temperature-progress", `${progress.toFixed(1)}%`);
}

function setHotwaterWidget(temperature, flowRate, volume) {
  if (hotwaterTempEl) hotwaterTempEl.textContent = `${Number(temperature).toFixed(0)}°C`;
  if (hotwaterFlowEl) hotwaterFlowEl.textContent = `${Number(flowRate).toFixed(1)} ml/s`;
  if (hotwaterVolumeEl) hotwaterVolumeEl.textContent = `${Number(volume).toFixed(0)} ml`;
}


/* ── List Fade Effect ─────────────────────────────────── */

function updateRecipeListFade() {
  const maxScrollTop = recipeListScrollEl.scrollHeight - recipeListScrollEl.clientHeight;
  const showTopFade = recipeListScrollEl.scrollTop > 6;
  const showBottomFade = maxScrollTop > 6 && recipeListScrollEl.scrollTop < maxScrollTop - 6;

  recipeListShellEl.classList.toggle("recipe-fade-top", showTopFade);
  recipeListShellEl.classList.toggle("recipe-fade-bottom", showBottomFade);
}

/* ── Shot Graph Rendering ─────────────────────────────── */

function createLegendItem(key, label, color, isActive) {
  return `
    <button type="button" class="workflow-legend-item ${isActive ? 'is-active' : 'is-inactive'}" data-series-key="${key}">
      <span class="workflow-legend-swatch" style="--legend-color: ${color};"></span>
      <span class="workflow-legend-label">${label}</span>
    </button>
  `;
}

function createLegendControl(key, label, isActive) {
  return `
    <button type="button" class="workflow-legend-item ${isActive ? 'is-active' : 'is-inactive'}" data-series-key="${key}">
      <span class="workflow-legend-label">${label}</span>
    </button>
  `;
}

// The shot review renders its legend into a dedicated slot (flanked by the date
// picker and reference button) instead of inside the graph wrap.
function _legendHostFor(graphEl) {
  if (graphEl?.id === 'shot-review-graph') {
    return document.getElementById('shot-review-legend-host') || graphEl.parentElement || graphEl;
  }
  return graphEl?.parentElement || graphEl;
}

function renderShotLegend(graphEl, visibility, onToggle, navContext) {
  const host = _legendHostFor(graphEl);
  const existing = host.querySelector('.workflow-legend');
  if (existing) existing.remove();

  const legend = document.createElement('div');
  legend.className = 'workflow-legend';
  legend.innerHTML = [
    createLegendItem('pressure', t('legend.pressure'), CHART_COLORS.pressure, visibility.pressure),
    createLegendItem('flow', t('legend.flow'), CHART_COLORS.flow, visibility.flow),
    createLegendItem('scaleRate', t('legend.weightFlow'), CHART_COLORS.weightRate, visibility.scaleRate),
    createLegendItem('temperature', t('legend.temperature'), CHART_COLORS.temperature, visibility.temperature),
    '<span class="workflow-legend-divider"></span>',
    createLegendControl('goals', t('legend.goals'), visibility.goals !== false),
    createLegendControl('steps', t('legend.steps'), visibility.steps !== false),
  ].join('');

  legend.addEventListener('click', (event) => {
    const btn = event.target.closest('.workflow-legend-item');
    if (!btn || !legend.contains(btn)) return;
    event.preventDefault();
    event.stopPropagation();
    const seriesKey = btn.dataset.seriesKey;
    if (!seriesKey) return;
    onToggle(seriesKey);
  });

  if (graphEl.id === 'workflow-shot-graph') {
    const skipBtn = document.createElement('button');
    skipBtn.type = 'button';
    skipBtn.id = 'btn-wf-skip-step';
    skipBtn.className = 'workflow-legend-skip-btn';
    skipBtn.setAttribute('aria-label', t('recipe.skipPhaseAria'));
    skipBtn.textContent = t('recipe.skipPhase');
    legend.appendChild(skipBtn);
  }

  if (host.contains(graphEl)) host.insertBefore(legend, graphEl);
  else host.appendChild(legend);
}

function updateWorkflowLegendLive(graphEl, vals) {
  const legend = _legendHostFor(graphEl)?.querySelector('.workflow-legend');
  if (!legend) return;
  const fmt = {
    pressure:    Number.isFinite(vals.pressure)                         ? `${vals.pressure.toFixed(1)} bar`  : '— bar',
    flow:        Number.isFinite(vals.flow)                             ? `${vals.flow.toFixed(1)} ml/s`     : '— ml/s',
    scaleRate:   Number.isFinite(vals.scaleRate) && vals.scaleRate >= 0 ? `${vals.scaleRate.toFixed(1)} g/s` : '— g/s',
    temperature: Number.isFinite(vals.temperature) && vals.temperature > 0 ? `${vals.temperature.toFixed(1)}°C` : '—°C',
  };
  legend.querySelectorAll('.workflow-legend-item[data-series-key]').forEach(btn => {
    const lbl = btn.querySelector('.workflow-legend-label');
    const nextText = fmt[btn.dataset.seriesKey];
    if (lbl && nextText !== undefined && lbl.textContent !== nextText) {
      lbl.textContent = nextText;
    }
  });
}

const LIVE_PHASE_RENDER_INTERVAL_MS = 400;

function renderEspressoFullscreenLegend(graphEl, visibility, onToggle) {
  const legendHost = document.getElementById('espresso-fs-legend');
  if (!legendHost) return;

  const legend = document.createElement('div');
  legend.className = 'workflow-legend espresso-fs-legend';
  legend.innerHTML = [
    createLegendItem('pressure', t('legend.pressure'), CHART_COLORS.pressure, visibility.pressure),
    createLegendItem('flow', t('legend.flowShort'), CHART_COLORS.flow, visibility.flow),
    createLegendItem('scaleRate', t('legend.weightFlowShort'), CHART_COLORS.weightRate, visibility.scaleRate),
    createLegendItem('temperature', t('legend.temperature'), CHART_COLORS.temperature, visibility.temperature),
    '<span class="workflow-legend-divider"></span>',
    createLegendControl('goals', t('legend.goals'), visibility.goals !== false),
    createLegendControl('steps', t('legend.steps'), visibility.steps !== false),
  ].join('');

  legend.addEventListener('click', (event) => {
    const btn = event.target.closest('.workflow-legend-item');
    if (!btn || !legend.contains(btn)) return;
    event.preventDefault();
    event.stopPropagation();
    const seriesKey = btn.dataset.seriesKey;
    if (!seriesKey) return;
    onToggle(seriesKey);
  });

  legendHost.replaceChildren(legend);
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

function renderShotMeta(reserveEl, shot, normalized, navContext, workflow) {
  if (!reserveEl) return;

  reserveEl.querySelector('.shot-stats-bar')?.remove();
  reserveEl.querySelector('.workflow-shot-meta')?.remove();

  const shotDate = shot?.timestamp ? new Date(shot.timestamp) : null;
  const hasValidDate = shotDate instanceof Date && !Number.isNaN(shotDate.getTime());

  const day  = hasValidDate ? new Intl.DateTimeFormat('de-DE', { weekday: 'short' }).format(shotDate) : '--';
  const date = hasValidDate ? new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit' }).format(shotDate) : '--.--.';
  const time = hasValidDate ? new Intl.DateTimeFormat('de-DE', { hour: '2-digit', minute: '2-digit' }).format(shotDate) : '--:--';

  const totalDuration = Array.isArray(normalized?.elapsed) && normalized.elapsed.length
    ? normalized.elapsed[normalized.elapsed.length - 1] : null;
  const durationText = Number.isFinite(totalDuration) ? `${totalDuration.toFixed(1)}s` : '--.-s';

  // Historical data from the shot's own workflow context
  const ctx = shot?.workflow?.context || {};
  const grind = ctx.grinderSetting ?? null;
  const dose  = Number(shot?.annotations?.actualDoseWeight || ctx.targetDoseWeight || 0) || null;

  // Output: annotations.actualYield → snapshot.volume → last scale weight → integration
  let actualOut = null;
  let outUnit = 'g';
  let isEstimatedOut = false;
  const annYield = Number(shot?.annotations?.actualYield ?? shot?.annotations?.extras?.actualYield);
  if (Number.isFinite(annYield) && annYield > 0) {
    actualOut = annYield;
  } else {
    const snapVol = Number(shot?.snapshot?.volume);
    if (Number.isFinite(snapVol) && snapVol > 0) {
      actualOut = snapVol;
      outUnit = 'ml';
    } else {
      const meas = shot?.measurements;
      if (Array.isArray(meas)) {
        for (let i = meas.length - 1; i >= 0; i--) {
          const w = meas[i]?.scale?.weight ?? meas[i]?.scale?.weight_grams ?? null;
          if (Number.isFinite(w) && w > 0) { actualOut = w; break; }
        }
      }
      if (actualOut === null) actualOut = integrateScaleRate(normalized?.elapsed, normalized?.scaleRate);
      if (actualOut === null && shot.annotations?.extras?.virtualScale === true) {
        const estYield = shot.annotations.extras.actualYield ?? null;
        if (estYield != null) { actualOut = estYield; isEstimatedOut = true; }
      }
    }
  }

  // Row 2: grind · dose → out (ratio)
  const gearSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12" style="vertical-align:-1px"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;
  const grindStr = grind != null ? `${gearSvg} ${grind}` : null;
  const doseStr  = dose != null ? `${dose.toFixed(0)}g` : '—';
  const outStr   = actualOut != null ? `${isEstimatedOut ? '~' : ''}${isEstimatedOut ? Math.round(actualOut) : actualOut.toFixed(1)}${outUnit}` : '—';
  const ratioStr = dose != null && actualOut != null && dose > 0
    ? ` (1:${(actualOut / dose).toFixed(1)})` : '';
  const row2 = [grindStr, `${doseStr} → ${outStr}${ratioStr}`].filter(Boolean).join(' · ');

  const canGoOlder = Boolean(navContext?.canGoOlder);
  const canGoNewer = Boolean(navContext?.canGoNewer);

  const meta = document.createElement('div');
  meta.className = 'workflow-shot-meta';
  meta.innerHTML = `
    <button type="button" class="workflow-shot-nav-btn" data-nav="older" aria-label="${t('recipe.olderShot')}" ${canGoOlder ? '' : 'disabled'}>
      <span aria-hidden="true">&#x2039;</span>
    </button>
    <span class="workflow-shot-meta-text">
      <span class="workflow-shot-meta-row">${day} ${date} | ${time} | ${durationText}</span>
      <span class="workflow-shot-meta-row workflow-shot-meta-row--sub">${row2}</span>
    </span>
    <button type="button" class="workflow-shot-nav-btn" data-nav="newer" aria-label="${t('recipe.newerShot')}" ${canGoNewer ? '' : 'disabled'}>
      <span aria-hidden="true">&#x203A;</span>
    </button>
  `;

  meta.querySelector('[data-nav="older"]')?.addEventListener('click', navContext?.onOlder);
  meta.querySelector('[data-nav="newer"]')?.addEventListener('click', navContext?.onNewer);

  const reserveRow = reserveEl.querySelector('.workflow-reserve-row');
  if (reserveRow) {
    reserveRow.prepend(meta);
  } else {
    reserveEl.prepend(meta);
  }

}

function renderShotDiffCard(reserveEl, diffRows) {
  if (!reserveEl) return;
  const existing = reserveEl.querySelector('.workflow-shot-diff');
  if (existing) existing.remove();

  if (!Array.isArray(diffRows) || diffRows.length === 0) {
    return;
  }

  const card = document.createElement('div');
  card.className = 'workflow-shot-diff';

  const rows = (diffRows || [])
    .map((row) => `<div class="workflow-shot-diff-row"><span>${row.label}</span><strong>${row.value}</strong></div>`)
    .join('');

  card.innerHTML = `
    <div class="workflow-shot-diff-title">${t('recipe.comparison')}</div>
    ${rows}
  `;

  const historyBtn = reserveEl.querySelector('#btn-workflow-history-shortcut');
  if (historyBtn && historyBtn.parentElement === reserveEl) {
    reserveEl.insertBefore(card, historyBtn);
  } else {
    reserveEl.appendChild(card);
  }
}

function renderShotAnalysis(normalized) {
  const elapsed   = normalized?.elapsed   || [];
  const pressure  = normalized?.pressure  || [];
  const flow      = normalized?.flow      || [];
  const substates = normalized?.substates || [];
  if (!elapsed.length) return [];

  // Split samples into preinfusion vs extraction by substate
  const preinfusionIdx = new Set();
  for (let i = 0; i < substates.length; i++) {
    if (substates[i] === 'preinfusion') preinfusionIdx.add(i);
  }
  const hasPhases = preinfusionIdx.size > 0;

  function integFlow(fromIdx, toIdx) {
    let vol = 0;
    for (let i = Math.max(1, fromIdx); i <= toIdx && i < elapsed.length; i++) {
      const dt = elapsed[i] - elapsed[i - 1];
      const f  = ((flow[i] || 0) + (flow[i - 1] || 0)) / 2;
      vol += Math.max(0, f) * dt;
    }
    return vol;
  }

  function avgInSet(arr, idxSet, minVal = 0) {
    let sum = 0, n = 0;
    idxSet.forEach(i => {
      const v = arr[i];
      if (Number.isFinite(v) && v > minVal) { sum += v; n++; }
    });
    return n > 0 ? sum / n : null;
  }

  const lastIdx = elapsed.length - 1;
  const extractionIdx = new Set();
  for (let i = 0; i <= lastIdx; i++) {
    if (!preinfusionIdx.has(i)) extractionIdx.add(i);
  }

  // Preinfusion end index (for integration boundary)
  let preEndIdx = -1;
  for (let i = lastIdx; i >= 0; i--) {
    if (preinfusionIdx.has(i)) { preEndIdx = i; break; }
  }
  let exStartIdx = preEndIdx + 1;

  const rows = [];

  if (hasPhases) {
    const volPre = integFlow(0, preEndIdx);
    const volEx  = integFlow(exStartIdx, lastIdx);
    rows.push({ label: t('analysis.preinfusionWater'), value: `${volPre.toFixed(1)} ml` });
    rows.push({ label: t('analysis.extractionWater'),  value: `${volEx.toFixed(1)} ml` });

    const avgP = avgInSet(pressure, extractionIdx, 0.5);
    const avgF = avgInSet(flow,     extractionIdx, 0.1);
    if (avgP != null) rows.push({ label: t('analysis.avgPressure'), value: `${avgP.toFixed(1)} bar` });
    if (avgF != null) rows.push({ label: t('analysis.avgFlow'),     value: `${avgF.toFixed(1)} ml/s` });
  } else {
    const volTotal = integFlow(0, lastIdx);
    const allIdx   = new Set(Array.from({ length: elapsed.length }, (_, i) => i));
    const avgP = avgInSet(pressure, allIdx, 0.5);
    const avgF = avgInSet(flow,     allIdx, 0.1);
    rows.push({ label: t('analysis.totalWater'), value: `${volTotal.toFixed(1)} ml` });
    if (avgP != null) rows.push({ label: t('analysis.avgPressure'), value: `${avgP.toFixed(1)} bar` });
    if (avgF != null) rows.push({ label: t('analysis.avgFlow'),     value: `${avgF.toFixed(1)} ml/s` });
  }

  return rows;
}

function _extractProfileFramesForShot(shot) {
  const profile = shot?.workflow?.profile || shot?.profile || null;
  if (!profile) return [];
  const frames = profile.steps ?? profile.frames ?? [];
  return Array.isArray(frames) ? frames : [];
}

function _buildPhaseSegments(shot, normalized) {
  const elapsed = Array.isArray(normalized?.elapsed) ? normalized.elapsed : [];
  if (!elapsed.length) return [];

  const duration = elapsed[elapsed.length - 1];
  if (!Number.isFinite(duration) || duration <= 0) return [];

  const phaseMarkers = Array.isArray(normalized?.phaseMarkers) ? normalized.phaseMarkers : [];
  if (phaseMarkers.length >= 1) {
    return phaseMarkers
      .filter((marker) => marker && Number.isFinite(Number(marker.time)))
      .map((marker, idx, arr) => ({
        label: String(marker.label || `Step ${idx + 1}`),
        start: Math.max(0, Number(marker.time) || 0),
        end: idx + 1 < arr.length
          ? Math.max(0, Number(arr[idx + 1]?.time) || duration)
          : duration,
      }));
  }

  const frames = _extractProfileFramesForShot(shot);
  if (frames.length) {
    let t = 0;
    return frames.map((f, idx) => {
      const seg = Math.max(0.1, Number(f?.seconds || 0));
      const start = t;
      const end = t + seg;
      t += seg;
      return {
        label: String(f?.name || `Step ${idx + 1}`),
        start,
        end,
      };
    });
  }

  const substates = Array.isArray(normalized?.substates) ? normalized.substates : [];
  if (!substates.length || substates.length !== elapsed.length) return [];

  const out = [];
  let runStart = 0;
  for (let i = 1; i <= substates.length; i++) {
    const changed = i === substates.length || substates[i] !== substates[runStart];
    if (!changed) continue;
    const rawLabel = substates[runStart] || 'phase';
    const label = rawLabel === 'preinfusion'
      ? 'Fill'
      : rawLabel === 'pouring'
        ? 'Pressurize'
        : rawLabel;
    out.push({
      label,
      start: elapsed[runStart] ?? 0,
      end: elapsed[Math.max(runStart + 1, i - 1)] ?? elapsed[elapsed.length - 1],
    });
    runStart = i;
  }
  return out;
}

function renderShotPhases(graphEl, shot, normalized, chart) {
  graphEl.querySelector('.workflow-shot-phase-markers')?.remove();

  const segments = _buildPhaseSegments(shot, normalized);
  if (!segments.length || !chart?.bbox) return;

  const dpr = window.devicePixelRatio || 1;
  const bbox = chart.bbox;
  const left   = Number(bbox.left) / dpr;
  const top    = Number(bbox.top) / dpr;
  const width  = Number(bbox.width) / dpr;
  const height = Number(bbox.height) / dpr;

  if (!Number.isFinite(left) || !Number.isFinite(top) || !Number.isFinite(width) || !Number.isFinite(height)) {
    return;
  }
  if (width <= 0 || height <= 0) return;

  const xScale = chart.scales?.x;
  const xMin = Number(xScale?.min ?? 0);
  const xMax = Number(xScale?.max ?? 1);
  if (!Number.isFinite(xMin) || !Number.isFinite(xMax) || xMax <= xMin) return;

  const layer = document.createElement('div');
  layer.className = 'workflow-shot-phase-markers';
  layer.style.cssText = `left:${left.toFixed(2)}px; top:${top.toFixed(2)}px; width:${width.toFixed(2)}px; height:${height.toFixed(2)}px;`;

  let visibleCount = 0;
  layer.innerHTML = segments.map((seg, idx) => {
    const start = Math.max(0, Number(seg.start) || 0);
    const pct = (start - xMin) / (xMax - xMin) * 100;
    if (!Number.isFinite(pct) || pct < 0 || pct > 100) return '';
    const safeLabel = String(seg.label || `Step ${idx + 1}`)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');

    const noLine = pct === 0;
    const labelTop = visibleCount % 2 === 1 ? 26 : 6;
    visibleCount++;
    return `
      <div class="workflow-shot-phase-marker${noLine ? ' workflow-shot-phase-marker--no-line' : ''}" style="left:${pct.toFixed(4)}%;">
        <span class="workflow-shot-phase-marker-label" style="top:${labelTop}px;">${safeLabel}</span>
      </div>`;
  }).join('');

  graphEl.appendChild(layer);
}

function createChartOpts(width, height, visibility, tempRange = { min: 80, max: 100 }) {
  const spline = uPlot.paths.spline?.();
  const formatSecondsTick = (value) => {
    if (!Number.isFinite(value)) return '';
    const rounded = Math.round(value);
    return Math.abs(value - rounded) < 0.001 ? `${rounded}s` : '';
  };
  return {
    width,
    height,
    padding: [12, 16, 0, 0],
    cursor: { show: false },
    legend: { show: false },
    axes: [
      {
        stroke: CHART_COLORS.textSecondary,
        grid: { stroke: CHART_COLORS.grid, width: 0.5 },
        ticks: { stroke: CHART_COLORS.grid, width: 0.5 },
        values: (u, vals) => vals.map(formatSecondsTick),
        font: '11px system-ui',
        gap: 6,
      },
      {
        stroke: CHART_COLORS.textSecondary,
        grid: { stroke: CHART_COLORS.grid, width: 0.5 },
        ticks: { stroke: CHART_COLORS.grid, width: 0.5 },
        values: (u, vals) => vals.map(v => v.toFixed(0)),
        font: '11px system-ui',
        gap: 6,
        scale: 'pressure',
      },
      {
        side: 1,
        stroke: CHART_COLORS.temperature,
        grid: { show: false },
        ticks: { stroke: CHART_COLORS.grid, width: 0.5 },
        values: (u, vals) => vals.map(v => v.toFixed(0) + '°'),
        font: '11px system-ui',
        gap: 6,
        scale: 'temp',
        show: true,
      },
    ],
    scales: {
      x: {
        time: false,
        range: (u, min, max) => {
          const safeMax = Number.isFinite(max) ? max : 0;
          return [0, Math.max(safeMax, 10)];
        },
      },
      pressure: { min: 0, max: 12, auto: false },
      temp: { min: tempRange.min, max: tempRange.max, auto: false },
    },
    series: [
      {},
      {
        label: 'Pressure',
        stroke: CHART_COLORS.pressure,
        fill: makeGradFill(24, 184, 144),
        width: 2,
        paths: spline,
        scale: 'pressure',
        points: { show: false },
        show: visibility.pressure !== false,
      },
      {
        label: 'P Goal',
        stroke: CHART_COLORS.pressureGoal,
        width: 1.5,
        dash: [3, 3],
        paths: spline,
        scale: 'pressure',
        points: { show: false },
        show: visibility.goals !== false && visibility.pressure !== false,
      },
      {
        label: 'Flow',
        stroke: CHART_COLORS.flow,
        fill: makeGradFill(72, 120, 232),
        width: 2,
        paths: spline,
        scale: 'pressure',
        points: { show: false },
        show: visibility.flow !== false,
      },
      {
        label: 'F Goal',
        stroke: CHART_COLORS.flowGoal,
        width: 1.5,
        dash: [3, 3],
        paths: spline,
        scale: 'pressure',
        points: { show: false },
        show: visibility.goals !== false && visibility.flow !== false,
      },
      {
        label: 'Scale Rate',
        stroke: CHART_COLORS.weightRate,
        fill: makeGradFill(192, 136, 64),
        width: 2,
        paths: spline,
        scale: 'pressure',
        points: { show: false },
        show: visibility.scaleRate !== false,
      },
      {
        label: 'Temp',
        stroke: CHART_COLORS.temperature,
        width: 2,
        paths: spline,
        scale: 'temp',
        points: { show: false },
        show: visibility.temperature !== false,
      },
      {
        label: 'T Goal',
        stroke: CHART_COLORS.temperatureGoal,
        width: 1.5,
        dash: [3, 3],
        paths: spline,
        scale: 'temp',
        points: { show: false },
        show: visibility.goals !== false && visibility.temperature !== false,
      },
    ],
  };
}

function avgFinite(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return null;
  const vals = arr.filter(v => Number.isFinite(v) && v > 0);
  if (vals.length === 0) return null;
  return vals.reduce((s, v) => s + v, 0) / vals.length;
}

function integrateScaleRate(elapsed, scaleRate) {
  if (!elapsed?.length || !scaleRate?.length) return null;
  let total = 0;
  for (let i = 1; i < elapsed.length; i++) {
    const dt = elapsed[i] - elapsed[i - 1];
    total += ((scaleRate[i] + scaleRate[i - 1]) / 2) * dt;
  }
  return total > 0 ? total : null;
}

function renderShotStats(reserveEl, normalized, workflow) {
  if (!reserveEl) return;
  reserveEl.innerHTML = '';
  reserveEl.removeAttribute('aria-hidden');

  const duration = normalized?.elapsed?.length
    ? normalized.elapsed[normalized.elapsed.length - 1]
    : null;

  const fmt = (val, digits) => val != null ? val.toFixed(digits) : '—';

  const stats = [
    { label: t('chart.time'),  value: duration != null ? duration.toFixed(1) + ' s' : '—', color: '#ffffff' },
    { label: t('chart.bar'),   value: fmt(avgFinite(normalized?.pressure), 1),    color: CHART_COLORS.pressure },
    { label: t('chart.mlps'),  value: fmt(avgFinite(normalized?.flow), 1),        color: CHART_COLORS.flow },
    { label: t('chart.gps'),   value: fmt(avgFinite(normalized?.scaleRate), 1),   color: CHART_COLORS.weightRate },
    { label: t('chart.temp'),  value: fmt(avgFinite(normalized?.temperature), 1), color: CHART_COLORS.temperature },
  ];

  const actualWeight = integrateScaleRate(normalized?.elapsed, normalized?.scaleRate);
  const targetWeight = Number(workflow?.targetYield || 0) || null;

  const R = 52;
  const CX = 60, CY = 60, DIAM = R * 2;
  const progress = (actualWeight != null && targetWeight != null && targetWeight > 0)
    ? Math.min(actualWeight / targetWeight, 1)
    : 0;
  const fillHeight = (progress * DIAM).toFixed(2);
  const fillY = (CY + R - progress * DIAM).toFixed(2);
  const uid = `wring-${Math.random().toString(36).slice(2, 8)}`;

  const ringHtml = `
    <div class="shot-stat-divider"></div>
    <div class="shot-stat-ring-wrap">
      <svg class="shot-stat-ring" viewBox="0 0 120 120" width="120" height="120" aria-hidden="true">
        <defs>
          <clipPath id="${uid}">
            <circle cx="${CX}" cy="${CY}" r="${R}"/>
          </clipPath>
        </defs>
        <circle cx="${CX}" cy="${CY}" r="${R}" class="shot-stat-ring-bg"/>
        <rect x="${CX - R}" y="${fillY}" width="${DIAM}" height="${fillHeight}"
          fill="${CHART_COLORS.weightRate}" opacity="0.55" clip-path="url(#${uid})"/>
        <circle cx="${CX}" cy="${CY}" r="${R}" class="shot-stat-ring-border"/>
      </svg>
      <div class="shot-stat-ring-inner">
        <span class="shot-stat-ring-actual" style="color:${CHART_COLORS.weightRate}">${actualWeight != null ? actualWeight.toFixed(1) : '—'}</span>
        <span class="shot-stat-ring-sep">/</span>
        <span class="shot-stat-ring-target">${targetWeight != null ? targetWeight.toFixed(1) : '—'}</span>
        <span class="shot-stat-ring-unit">g</span>
      </div>
    </div>
  `;

  const bar = document.createElement('div');
  bar.className = 'shot-stats-bar';
  bar.innerHTML = stats.map(s => `
    <div class="shot-stat">
      <span class="shot-stat-value" style="color:${s.color}">${s.value}</span>
      <span class="shot-stat-label">${s.label}</span>
    </div>
  `).join('') + ringHtml;
  reserveEl.appendChild(bar);
}

/* ── Live Shot Chart ──────────────────────────────────── */

function initLiveShotChart(graphEl) {
  if (graphEl._chart) {
    graphEl._chart.destroy();
    graphEl._chart = null;
  }
  graphEl.innerHTML = '';

  const width = graphEl.offsetWidth || 400;
  const height = graphEl.offsetHeight || 300;

  const visibility = getSeriesVisibility(graphEl?._seriesVisibility, 'live');
  setSeriesVisibility('live', visibility);
  const opts = createChartOpts(width, height, visibility);

  try {
    const chart = new uPlot(opts, [[], [], [], [], [], [], [], []], graphEl);
    graphEl._chart = chart;
    graphEl._seriesVisibility = visibility;
    graphEl._liveMode = true;

    const handleLiveLegendToggle = (seriesKey) => {
      const currentVisibility = getSeriesVisibility(graphEl._seriesVisibility, 'live');
      const nextVisibility = {
        ...currentVisibility,
        [seriesKey]: currentVisibility[seriesKey] === false,
      };
      setSeriesVisibility('live', nextVisibility);
      graphEl._seriesVisibility = { ...nextVisibility };
      const currentLive = graphEl._latestLiveShot || null;
      initLiveShotChart(graphEl);
      if (currentLive) {
        graphEl._latestLiveShot = currentLive;
        updateLiveShotChart(graphEl, currentLive);
      }
    };

    if (graphEl.id === 'espresso-fs-graph') {
      renderEspressoFullscreenLegend(graphEl, visibility, handleLiveLegendToggle);
    } else if (graphEl.id === 'workflow-shot-graph') {
      const host = graphEl.parentElement || graphEl;
      host.querySelector('.workflow-legend')?.remove();
      renderShotLegend(graphEl, visibility, handleLiveLegendToggle, null);
    }
  } catch (err) {
    console.error('initLiveShotChart: uPlot error:', err);
  }
}

function updateLiveShotChart(graphEl, liveShot) {
  if (!graphEl?._chart || !graphEl._liveMode) return;
  try {
    graphEl._latestLiveShot = liveShot;
    graphEl._chart.setData([
      liveShot.elapsed,
      liveShot.pressure,
      liveShot.targetPressure,
      liveShot.flow,
      liveShot.targetFlow,
      liveShot.scaleRate,
      liveShot.temperature,
      liveShot.targetTemperature,
    ]);
    if (graphEl._seriesVisibility?.steps !== false) {
      const now = Date.now();
      const phaseCount = Array.isArray(liveShot?.phaseMarkers) ? liveShot.phaseMarkers.length : 0;
      const shouldRenderPhases =
        graphEl._lastPhaseCount !== phaseCount
        || !Number.isFinite(graphEl._lastPhaseRenderAt)
        || (now - graphEl._lastPhaseRenderAt) >= LIVE_PHASE_RENDER_INTERVAL_MS;

      if (shouldRenderPhases) {
        renderShotPhases(graphEl, liveShot, liveShot, graphEl._chart);
        graphEl._lastPhaseRenderAt = now;
        graphEl._lastPhaseCount = phaseCount;
      }
    } else {
      graphEl.querySelector('.workflow-shot-phase-markers')?.remove();
      graphEl._lastPhaseRenderAt = null;
      graphEl._lastPhaseCount = null;
    }
  } catch (err) {
    console.warn('updateLiveShotChart error:', err);
  }
}

function initSteamChart(graphEl) {
  if (graphEl._chart) {
    graphEl._chart.destroy();
    graphEl._chart = null;
  }
  graphEl.innerHTML = '';

  const width = graphEl.offsetWidth || 400;
  const height = graphEl.offsetHeight || 300;

  const visibility = { ...DEFAULT_SERIES_VISIBILITY, scaleRate: false };
  const opts = createChartOpts(width, height, visibility, { min: 130, max: 170 });

  try {
    const chart = new uPlot(opts, [[], [], [], [], [], [], [], []], graphEl);
    graphEl._chart = chart;
    graphEl._seriesVisibility = visibility;
    graphEl._liveMode = true;
  } catch (err) {
    console.error('initSteamChart: uPlot error:', err);
  }
}

function updateSteamChart(graphEl, steamSession) {
  if (!graphEl?._chart || !graphEl._liveMode) return;
  try {
    graphEl._chart.setData([
      steamSession.elapsed,
      steamSession.pressure,
      steamSession.targetPressure,
      steamSession.flow,
      steamSession.targetFlow,
      steamSession.scaleRate,
      steamSession.temperature,
      steamSession.targetTemperature,
    ]);
  } catch (err) {
    console.warn('updateSteamChart error:', err);
  }
}

function renderLiveShotStats(reserveEl, liveShot, weight, workflow) {
  if (!reserveEl) return;
  reserveEl.innerHTML = '';
  reserveEl.removeAttribute('aria-hidden');

  const snap    = liveShot?.lastSnap;
  const elapsed = liveShot?.elapsed?.length
    ? liveShot.elapsed[liveShot.elapsed.length - 1]
    : null;

  const pressure    = snap?.pressure         ?? null;
  const flow        = snap?.flow             ?? null;
  const temperature = snap?.groupTemperature ?? null;
  const targetYield = Number(workflow?.targetYield || 0) || null;

  const fmt = (val, digits) =>
    val != null && Number.isFinite(val) ? val.toFixed(digits) : '—';

  const scaleRateArr = liveShot?.scaleRate;
  const currentScaleRate = scaleRateArr?.length
    ? scaleRateArr[scaleRateArr.length - 1]
    : null;

  const stats = [
    { label: t('chart.time'),  value: elapsed != null ? elapsed.toFixed(1) + ' s' : '—', color: '#ffffff' },
    { label: t('chart.bar'),   value: fmt(pressure, 1),                                   color: CHART_COLORS.pressure },
    { label: t('chart.mlps'),  value: fmt(flow, 1),                                       color: CHART_COLORS.flow },
    { label: t('chart.gps'),   value: currentScaleRate != null ? fmt(currentScaleRate, 1) : '—', color: CHART_COLORS.weightRate },
    { label: t('chart.temp'),  value: fmt(temperature, 1),                                 color: CHART_COLORS.temperature },
  ];

  const R = 52;
  const CX = 60, CY = 60, DIAM = R * 2;
  const progress = weight > 0 && targetYield != null && targetYield > 0
    ? Math.min(weight / targetYield, 1)
    : 0;
  const fillHeight = (progress * DIAM).toFixed(2);
  const fillY      = (CY + R - progress * DIAM).toFixed(2);
  const uid        = `wlive-${Math.random().toString(36).slice(2, 8)}`;

  const ringHtml = `
    <div class="shot-stat-divider"></div>
    <div class="shot-stat-ring-wrap">
      <svg class="shot-stat-ring" viewBox="0 0 120 120" width="120" height="120" aria-hidden="true">
        <defs>
          <clipPath id="${uid}">
            <circle cx="${CX}" cy="${CY}" r="${R}"/>
          </clipPath>
        </defs>
        <circle cx="${CX}" cy="${CY}" r="${R}" class="shot-stat-ring-bg"/>
        <rect x="${CX - R}" y="${fillY}" width="${DIAM}" height="${fillHeight}"
          fill="${CHART_COLORS.weightRate}" opacity="0.55" clip-path="url(#${uid})"/>
        <circle cx="${CX}" cy="${CY}" r="${R}" class="shot-stat-ring-border"/>
      </svg>
      <div class="shot-stat-ring-inner">
        <span class="shot-stat-ring-actual" style="color:${CHART_COLORS.weightRate}">${weight > 0 ? weight.toFixed(1) : '—'}</span>
        <span class="shot-stat-ring-sep">/</span>
        <span class="shot-stat-ring-target">${targetYield != null ? targetYield.toFixed(1) : '—'}</span>
        <span class="shot-stat-ring-unit">g</span>
      </div>
    </div>
  `;

  const bar = document.createElement('div');
  bar.className = 'shot-stats-bar';
  bar.innerHTML = stats.map(s => `
    <div class="shot-stat">
      <span class="shot-stat-value" style="color:${s.color}">${s.value}</span>
      <span class="shot-stat-label">${s.label}</span>
    </div>
  `).join('') + ringHtml;
  reserveEl.appendChild(bar);
}

function renderShotGraph(graphEl, shot, workflow, seriesVisibility, navContext, diffRows, normalizeShotData, mode = 'workflow') {
  graphEl._liveMode = false;
  const normalized = normalizeShotData(shot);
  if (!normalized || !normalized.elapsed?.length) {
    if (graphEl._chart) {
      graphEl._chart.destroy();
      graphEl._chart = null;
    }
    graphEl._resizeObserver?.disconnect();
    graphEl._resizeObserver = null;
    graphEl.innerHTML = `<div style="display: flex; align-items: center; justify-content: center; height: 100%; color: var(--c-label-3);">${t('chart.noData')}</div>`;
    return;
  }

  const data = [
    normalized.elapsed,
    normalized.pressure,
    normalized.targetPressure,
    normalized.flow,
    normalized.targetFlow,
    normalized.scaleRate,
    normalized.temperature,
    normalized.targetTemperature,
  ];

  if (graphEl._chart) {
    graphEl._chart.destroy();
    graphEl._chart = null;
  }
  graphEl._resizeObserver?.disconnect();
  graphEl._resizeObserver = null;

  graphEl.innerHTML = '';

  const width  = graphEl.offsetWidth  || 400;
  const height = graphEl.offsetHeight || 300;

  const visibility = getSeriesVisibility(seriesVisibility || graphEl._seriesVisibility, mode);
  setSeriesVisibility(mode, visibility);
  const opts = createChartOpts(width, height, visibility);

  // Reference-shot overlay: same per-metric colours, ghosted (faded, thinner, no
  // fill, solid) so it reads as background behind the current shot. Resampled onto
  // the current shot's elapsed grid because uPlot needs one shared x-axis.
  const ref = graphEl._referenceNormalized;
  if (ref && Array.isArray(ref.elapsed) && ref.elapsed.length) {
    const tx = normalized.elapsed;
    const refSpline = uPlot.paths.spline?.();
    const A = 0.4;
    data.push(
      _resampleSeries(ref.elapsed, ref.pressure,    tx),
      _resampleSeries(ref.elapsed, ref.flow,        tx),
      _resampleSeries(ref.elapsed, ref.scaleRate,   tx),
      _resampleSeries(ref.elapsed, ref.temperature, tx),
    );
    opts.series.push(
      { label: 'Ref Pressure', stroke: _fadeHex(CHART_COLORS.pressure, A),   width: 1.5, paths: refSpline, scale: 'pressure', points: { show: false }, show: visibility.pressure    !== false },
      { label: 'Ref Flow',     stroke: _fadeHex(CHART_COLORS.flow, A),       width: 1.5, paths: refSpline, scale: 'pressure', points: { show: false }, show: visibility.flow        !== false },
      { label: 'Ref Scale',    stroke: _fadeHex(CHART_COLORS.weightRate, A), width: 1.5, paths: refSpline, scale: 'pressure', points: { show: false }, show: visibility.scaleRate   !== false },
      { label: 'Ref Temp',     stroke: _fadeHex(CHART_COLORS.temperature, A),width: 1.5, paths: refSpline, scale: 'temp',     points: { show: false }, show: visibility.temperature !== false },
    );
  }

  try {
    const chart = new uPlot(opts, data, graphEl);
    graphEl._chart = chart;
    graphEl._seriesVisibility = visibility;

    const reserveEl = document.getElementById('workflow-graph-reserve');
    renderShotMeta(reserveEl, shot, normalized, navContext, workflow);
    const renderPhases = () => {
      if ((graphEl._seriesVisibility?.steps ?? visibility.steps) !== false) {
        renderShotPhases(graphEl, shot, normalized, chart);
      } else {
        graphEl.querySelector('.workflow-shot-phase-markers')?.remove();
      }
    };
    renderPhases();
    requestAnimationFrame(renderPhases);

    const handleLegendToggle = (seriesKey) => {
      const currentVisibility = getSeriesVisibility(graphEl._seriesVisibility || visibility, mode);
      const currentValue = currentVisibility[seriesKey] !== false;
      const nextVisibility = {
        ...currentVisibility,
        [seriesKey]: !currentValue,
      };

      setSeriesVisibility(mode, nextVisibility);
      renderShotGraph(graphEl, shot, workflow, nextVisibility, navContext, diffRows, normalizeShotData, mode);
    };

    renderShotLegend(graphEl, visibility, handleLegendToggle, navContext);

    // Remove any cursor listeners from a previous renderShotGraph call on this element
    graphEl._removeCursorListeners?.();

    const _legendHost = _legendHostFor(graphEl);
    const _origLabels = {};
    let _origCaptured = false;

    function _captureOrig() {
      if (_origCaptured) return;
      _origCaptured = true;
      _legendHost.querySelector('.workflow-legend')
        ?.querySelectorAll('.workflow-legend-item[data-series-key]').forEach(btn => {
          const lbl = btn.querySelector('.workflow-legend-label');
          if (lbl) _origLabels[btn.dataset.seriesKey] = lbl.textContent;
        });
    }

    function _resetLegend() {
      cursorLine.style.display = 'none';
      _legendHost.querySelector('.workflow-legend')
        ?.querySelectorAll('.workflow-legend-item[data-series-key]').forEach(btn => {
          const lbl = btn.querySelector('.workflow-legend-label');
          const orig = _origLabels[btn.dataset.seriesKey];
          if (lbl && orig != null) lbl.textContent = orig;
        });
    }

    // Own cursor line — uPlot's cursor is disabled so it can't fight us with a stale
    // cached bounding rect (computed once at chart init, wrong after CSS transitions).
    const over = graphEl.querySelector('.u-over');
    const cursorLine = document.createElement('div');
    cursorLine.style.cssText = 'position:absolute;left:0;top:0;height:100%;border-right:1px dashed var(--c-label-3,#607D8B);pointer-events:none;display:none;will-change:transform;';
    over?.appendChild(cursorLine);

    function _showAtClientX(clientX) {
      if (!over) return;
      // Fresh rect every call — avoids stale-cache offset from CSS transitions at init.
      const rect = over.getBoundingClientRect();
      // scaleX converts from viewport pixels to the element's own CSS coordinate space,
      // correcting for any ancestor transform: scale() that getBoundingClientRect accounts
      // for but translateX does not.
      const scaleX = rect.width / (over.offsetWidth || rect.width);
      const px = Math.max(0, Math.min((clientX - rect.left) / scaleX, over.offsetWidth));
      cursorLine.style.transform = `translateX(${px}px)`;
      cursorLine.style.display = 'block';
      const timeVal = chart.posToVal(px, 'x');
      const elapsed = data[0];
      if (!elapsed?.length || !Number.isFinite(timeVal)) return;
      let idx = 0, minDiff = Infinity;
      for (let i = 0; i < elapsed.length; i++) {
        const d = Math.abs(elapsed[i] - timeVal);
        if (d < minDiff) { minDiff = d; idx = i; }
        else if (elapsed[i] > timeVal + 1) break;
      }
      _captureOrig();
      updateWorkflowLegendLive(graphEl, {
        pressure:    data[1]?.[idx],
        flow:        data[3]?.[idx],
        scaleRate:   data[5]?.[idx],
        temperature: data[6]?.[idx],
      });
    }

    const _onPointerMove  = e => _showAtClientX(e.clientX);
    const _onPointerLeave = () => _resetLegend();
    // Decide per gesture: a horizontal drag scrubs the crosshair (preventDefault),
    // a vertical drag is left alone so the surrounding container can scroll.
    let _touchStartX = 0, _touchStartY = 0, _touchMode = null; // null | 'scrub' | 'scroll'
    const _onTouchStart = e => {
      const t0 = e.touches[0];
      _touchStartX = t0.clientX;
      _touchStartY = t0.clientY;
      _touchMode = null;
    };
    const _onTouchMove = e => {
      const t0 = e.touches[0];
      if (_touchMode === null) {
        const dx = Math.abs(t0.clientX - _touchStartX);
        const dy = Math.abs(t0.clientY - _touchStartY);
        if (dx < 6 && dy < 6) return; // too small to classify yet
        _touchMode = dx > dy ? 'scrub' : 'scroll';
      }
      if (_touchMode === 'scrub') {
        e.preventDefault();
        _showAtClientX(t0.clientX);
      }
    };
    const _onTouchEnd     = () => { _touchMode = null; _resetLegend(); };

    graphEl.addEventListener('pointermove',  _onPointerMove);
    graphEl.addEventListener('pointerleave', _onPointerLeave);
    graphEl.addEventListener('touchstart',   _onTouchStart, { passive: true });
    graphEl.addEventListener('touchmove',    _onTouchMove, { passive: false });
    graphEl.addEventListener('touchend',     _onTouchEnd,  { passive: true });

    graphEl._removeCursorListeners = () => {
      graphEl.removeEventListener('pointermove',  _onPointerMove);
      graphEl.removeEventListener('pointerleave', _onPointerLeave);
      graphEl.removeEventListener('touchstart',   _onTouchStart);
      graphEl.removeEventListener('touchmove',    _onTouchMove);
      graphEl.removeEventListener('touchend',     _onTouchEnd);
      delete graphEl._removeCursorListeners;
    };

    // Keep chart sized to its container. Only respond to width changes — responding
    // to height changes too causes an infinite grow loop because setSize itself
    // alters the container height, re-triggering the observer.
    const ro = new ResizeObserver(() => {
      if (!graphEl._chart) return;
      const w = graphEl.offsetWidth;
      const h = graphEl.offsetHeight;
      if (w > 0 && h > 0 && w !== graphEl._chart.width) {
        graphEl._chart.setSize({ width: w, height: h });
      }
    });
    ro.observe(graphEl);
    graphEl._resizeObserver = ro;
  } catch (err) {
    console.error("renderShotGraph: uPlot error:", err);
    graphEl.innerHTML = `<div style="display: flex; align-items: center; justify-content: center; height: 100%; color: var(--c-label-3);">${t('chart.error')}</div>`;
  }
}

function updateActiveWorkflowCardHistoricalValues(shotWorkflow) {
  if (!workflowListEl || !shotWorkflow) return;
  const activeCard = workflowListEl.querySelector('.workflow-card-active');
  if (!activeCard) return;

  const grinderEl   = activeCard.querySelector('[data-field="grinderSetting"]');
  const doseYieldEl = activeCard.querySelector('[data-field="dose-yield"]');

  if (grinderEl) grinderEl.textContent = shotWorkflow.grinderSetting ?? '—';
  if (doseYieldEl) {
    const d = shotWorkflow.targetDoseWeight ?? '—';
    const y = shotWorkflow.targetYield ?? '—';
    doseYieldEl.textContent = `${d}g:${y}g`;
  }
}

/* ── History Accordion ───────────────────────────────── */

const _chevronSvg = `<svg class="history-accordion-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>`;
const _xSvg = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;

function _historyFormatDate(timestamp) {
  if (!timestamp) return '—';
  const d = new Date(timestamp);
  return isNaN(d.getTime()) ? '—' : d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

const _starFilledSvg = `<svg class="history-shot-fav" viewBox="0 0 24 24" fill="#FF3B30" stroke="#FF3B30" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-label="Favorit"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>`;

function _esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function _recipeKey(w) {
  return [w.coffeeRoaster, w.coffeeName, w.grinderModel, w.profileTitle]
    .map(v => String(v || '—').trim().toLocaleLowerCase('de-DE')).join('||');
}

// Render a 0–100 enjoyment value as 5 half-fillable stars (each star = 20).
function _starRatingHtml(val) {
  const fill = Math.round((Number(val) || 0) / 10) * 10; // nearest half-star (10% per half)
  return `<span class="rating-stars" style="--fill:${fill}%"><span class="rating-stars-bg">★★★★★</span><span class="rating-stars-fg">★★★★★</span></span>`;
}

function _renderRecipeRating(key, max, count) {
  if (!Number.isFinite(max) || !count) {
    return `<span class="recipe-rating is-empty" data-recipe-key="${_esc(key)}"></span>`;
  }
  const fill = Math.round(max / 10) * 10; // nearest half-star (10% per half)
  return `<span class="recipe-rating" data-recipe-key="${_esc(key)}" aria-label="${t('recipe.bestRating')}: ${(max/20).toFixed(1)}/5 (${count})">
    <span class="rating-stars" style="--fill:${fill}%"><span class="rating-stars-bg">★★★★★</span><span class="rating-stars-fg">★★★★★</span></span>
    <span class="rating-count">(${count})</span>
  </span>`;
}

function updateRecipeRating(key, max, count) {
  document.querySelectorAll('.recipe-rating').forEach(el => {
    if (el.dataset.recipeKey === key) el.outerHTML = _renderRecipeRating(key, max, count);
  });
}

let _onRecipesRendered = null;
function setOnRecipesRendered(fn) { _onRecipesRendered = fn; }

function _renderShotRows(shots, { showRecipe = false } = {}) {
  if (!Array.isArray(shots) || shots.length === 0) {
    return `<li class="history-shot-empty">${t('history.noShots')}</li>`;
  }
  return shots.map(shot => {
    const ctx    = shot?.workflow?.context || {};
    const grind  = ctx.grinderSetting ?? '—';
    const ann    = shot.annotations ?? {};
    // Recipe context — only shown in the flat shots-by-date view (the accordion
    // already carries roaster/bean/grinder/profile in its header).
    const roaster = ctx.coffeeRoaster || '—';
    const bean    = ctx.coffeeName || '—';
    const grinder = ctx.grinderModel || '—';
    const profile = shot?.workflow?.profile?.title || shot?.workflow?.profileTitle
                 || shot?.profileTitle || shot?.workflow?.name || '—';
    const recipeCells = showRecipe ? `
      <span class="history-shot-cell history-shot-cell--recipe">
        <span class="history-shot-label">${t('filter.roaster')}</span>
        <span class="history-shot-value">${_esc(roaster)}</span>
      </span>
      <span class="history-shot-cell history-shot-cell--recipe">
        <span class="history-shot-label">${t('filter.bean')}</span>
        <span class="history-shot-value">${_esc(bean)}</span>
      </span>
      <span class="history-shot-cell history-shot-cell--recipe">
        <span class="history-shot-label">${t('recipe.grinder')}</span>
        <span class="history-shot-value">${_esc(grinder)}</span>
      </span>` : '';
    const profileCell = showRecipe ? `
      <span class="history-shot-cell history-shot-cell--recipe">
        <span class="history-shot-label">${t('recipe.profile')}</span>
        <span class="history-shot-value">${_esc(profile)}</span>
      </span>` : '';
    // Actual shot values: actual dose / actual yield from annotations, recipe target as fallback.
    const dose   = Number(ann.actualDoseWeight ?? ctx.targetDoseWeight ?? 0);
    const annYield = Number(ann.actualYield ?? ann.extras?.actualYield);
    const hasActualYield = Number.isFinite(annYield) && annYield > 0;
    const isEstYield = hasActualYield && ann.extras?.virtualScale === true && !(Number(ann.actualYield) > 0);
    const yield_ = hasActualYield ? annYield : Number(ctx.targetYield || 0);
    const yieldLabel = isEstYield ? `~${Math.round(yield_)}g` : `${yield_}g`;
    const doseYield = dose > 0 && yield_ > 0
      ? `${dose}g → ${yieldLabel} (1:${(yield_ / dose).toFixed(1)})`
      : '—';
    const rating = ann.enjoyment ?? shot.metadata?.rating ?? (shot.rating != null ? shot.rating : null);
    const ratingDisplay = rating != null ? _starRatingHtml(rating) : '<span class="history-shot-value">—</span>';
    const isFav  = ann.extras?.favorite ?? shot.metadata?.favorite === true;
    const date   = _historyFormatDate(shot.timestamp);
    const tags   = Array.isArray(ann.extras?.tags) ? ann.extras.tags
                 : Array.isArray(shot.metadata?.tags) ? shot.metadata.tags : [];
    const tagsHtml = tags.length > 0
      ? `<span class="history-shot-tags">${tags.map(tag => `<span class="history-shot-tag">${_esc(tag)}</span>`).join('')}</span>`
      : '';
    return `
    <li class="history-shot-row${showRecipe ? ' history-shot-row--flat' : ''}" data-shot-id="${shot.id}">
      <span class="history-shot-date">${date}</span>
      ${recipeCells}
      <span class="history-shot-cell history-shot-cell--grind">
        <span class="history-shot-label">${t('history.grindSize')}</span>
        <span class="history-shot-value">${_esc(grind)}</span>
      </span>
      ${profileCell}
      <span class="history-shot-cell history-shot-cell--dose">
        <span class="history-shot-label">${t('history.doseYield')}</span>
        <span class="history-shot-value">${doseYield}</span>
      </span>
      <span class="history-shot-cell history-shot-cell--time">
        <span class="history-shot-label">${t('history.time')}</span>
        <span class="history-shot-value history-shot-duration" data-shot-id="${shot.id}">…</span>
      </span>
      <span class="history-shot-divider" aria-hidden="true"></span>
      <span class="history-shot-rating-cell">
        <span class="history-shot-label">${t('history.rating')}</span>
        <span class="history-shot-rating-row">
          ${ratingDisplay}
          ${isFav ? _starFilledSvg : ''}
        </span>
      </span>
      ${tagsHtml}
      <button type="button" class="history-shot-delete-btn" data-shot-id="${shot.id}" aria-label="${t('history.shotDeleteAria')}">
        ${_xSvg}
      </button>
    </li>`;
  }).join('');
}

function renderHistoryAccordion(recipes, selectedIndex, selectedShots) {
  const listEl = document.getElementById('history-accordion-list');
  if (!listEl) return;

  if (!Array.isArray(recipes) || recipes.length === 0) {
    listEl.innerHTML = `<li class="history-accordion-empty">${t('history.empty')}</li>`;
    return;
  }

  listEl.innerHTML = recipes.map((r, i) => {
    const isOpen = i === selectedIndex;
    const shotsSection = isOpen
      ? `<div class="history-accordion-shots"><ul class="history-shots-list">${_renderShotRows(selectedShots)}</ul></div>`
      : '';
    return `
    <li class="history-accordion-item${isOpen ? ' is-open' : ''}" data-history-recipe-index="${i}">
      <div class="history-delete-zone">
        <button type="button" class="history-delete-all-btn" data-history-recipe-index="${i}" aria-label="${t('history.deleteAllAria')}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </div>
      <div class="history-swipe-layer">
        <div class="history-accordion-header">
          <div class="history-accordion-meta">
            <div class="workflow-compact-meta">
              <span class="workflow-compact-item">
                <span class="workflow-compact-label">${r.coffeeRoaster}</span>
                <span class="workflow-compact-value">${r.coffeeName}</span>
              </span>
              <span class="workflow-compact-item">
                <span class="workflow-compact-label">${t('recipe.grinder')}</span>
                <span class="workflow-compact-value">${r.grinderModel}</span>
              </span>
              <span class="workflow-compact-item">
                <span class="workflow-compact-label">${t('recipe.profile')}</span>
                <span class="workflow-compact-value">${r.profileTitle}</span>
              </span>
            </div>
          </div>
          ${_renderRecipeRating(_recipeKey(r), r.maxRating, r.ratedCount)}
          ${_chevronSvg}
        </div>
        ${shotsSection}
      </div>
    </li>`;
  }).join('');
}

function renderHistoryShotList(shots) {
  const listEl = document.getElementById('history-accordion-list');
  if (!listEl) return;
  if (!Array.isArray(shots) || shots.length === 0) {
    listEl.innerHTML = `<li class="history-accordion-empty">${t('history.empty')}</li>`;
    return;
  }
  listEl.innerHTML = `<li class="history-shots-flat"><ul class="history-shots-list">${_renderShotRows(shots, { showRecipe: true })}</ul></li>`;
}

function updateHistoryShotDuration(shotId, seconds) {
  const el = document.querySelector(`#history-accordion-list .history-shot-duration[data-shot-id="${shotId}"]`);
  if (el) el.textContent = Number.isFinite(seconds) ? `${seconds.toFixed(0)}s` : '—';
}

window.NSXUI = {
  renderShotGraph,
  renderWorkflows,
  setBrewGroupTemperature,
  setCurrentWorkflow,
  setHotwaterWidget,
  initLiveShotChart,
  updateLiveShotChart,
  initSteamChart,
  updateSteamChart,
  renderLiveShotStats,
  setMachineConnected,
  setMachineInfo,
  setMachineStateText,
  setScaleConnected,
  setSteamWidget,
  setSteamTemperatureOrb,
  setWaterLevel,
  setWaterRefillLevel,
  setWaterDisplayUnit: (unit) => { _waterDisplayUnit = unit; setWaterLevel(waterLevelMm); },
  showToast,
  showStateToast,
  updateWorkflowLegendLive,
  updateRecipeListFade,
  updateActiveWorkflowCardHistoricalValues,
  renderHistoryAccordion,
  renderHistoryShotList,
  updateHistoryShotDuration,
  updateRecipeRating,
  setOnRecipesRendered,
  setSeriesVisibility,
  renderShotAnalysis,
  setWorkflowSyncState,
};
})();
