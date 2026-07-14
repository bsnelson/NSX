"use strict";

(() => {
  // Inject styles directly so they are never served from CSS cache
  const _style = document.createElement('style');
  _style.textContent = `
    #stg-inner { width:100%; height:100%; display:flex; flex-direction:column; }
    .stg-main { display:flex; flex-direction:column; flex:1; overflow:hidden; position:relative; }
    .stg-page-title {
      font-size: 26px; font-weight: 700; letter-spacing: -0.3px;
      color: var(--c-label); padding: 20px 20px 4px; flex-shrink: 0;
    }
    .stg-content { flex:1; overflow-y:auto; padding-bottom:40px; background:var(--c-bg); }
    .stg-rows { border: 1px solid var(--c-separator) !important; }
    .stg-nav-btn.active { background:var(--c-blue) !important; color:#fff !important; font-weight:500; }
    .stg-section { padding: 16px 20px 0; }
    .stg-section:first-of-type { padding-top: 12px; }
    .stg-row-nav { cursor:pointer; }
    .stg-row-nav:active { opacity:0.7; }
    .stg-row-nav .stg-badge { min-width: 36px; text-align: center; }
    .stg-row-chevron { color:var(--c-label-2); flex-shrink:0; width:16px; height:16px; }
    .stg-detail-panel {
      position:absolute; inset:0; background:var(--c-bg);
      display:flex; flex-direction:column; z-index:10;
      transform:translateX(100%);
      transition:transform 0.28s cubic-bezier(0.25,0.46,0.45,0.94);
    }
    .stg-detail-panel.open { transform:translateX(0); }
    .stg-detail-header {
      display:flex; align-items:center; gap:10px;
      padding: 16px 20px 12px; flex-shrink:0;
      border-bottom:1px solid var(--c-separator);
    }
    .stg-detail-back {
      display:flex; align-items:center; gap:2px;
      background:none; border:none; cursor:pointer;
      color:var(--c-blue); font-size:var(--fs-caption); font-weight:500; padding:0;
    }
    .stg-detail-back svg { width:18px; height:18px; }
    .stg-detail-name {
      font-size:18px; font-weight:700; color:var(--c-label); margin-left:4px;
    }
    .stg-detail-content { flex:1; overflow-y:auto; padding-bottom:40px; background:var(--c-bg); }
    .stg-dropdown { position:relative; min-width:120px; }
    .stg-dropdown-btn {
      display:flex; align-items:center; justify-content:space-between; gap:6px;
      background:var(--c-fill-2); border:1px solid var(--c-separator); border-radius:8px;
      color:var(--c-label); font-size:var(--fs-caption); padding:6px 8px;
      cursor:pointer; width:100%; text-align:left;
    }
    .stg-dropdown-btn svg { flex-shrink:0; opacity:0.6; }
    .stg-dropdown-list {
      position:fixed; z-index:9999;
      background:var(--c-bg-2); border:1px solid var(--c-separator);
      border-radius:10px; overflow:hidden;
      box-shadow:0 8px 32px rgba(0,0,0,0.4);
      min-width:140px;
    }
    .stg-dropdown-item {
      display:block; width:100%; padding:11px 14px;
      background:none; border:none; border-bottom:1px solid var(--c-separator);
      color:var(--c-label); font-size:var(--fs-caption); text-align:left; cursor:pointer;
    }
    .stg-dropdown-item:last-child { border-bottom:none; }
    .stg-dropdown-item.selected { color:var(--c-blue,#0a84ff); font-weight:600; }
    .stg-dropdown-item:active { background:var(--c-fill-2); }
  `;
  document.head.appendChild(_style);

  const API = `${window.NSXConfig?.GATEWAY ?? `http://${location.hostname}:8080`}/api/v1`;

  // ── HTTP helpers ──────────────────────────────────────────────────────────────
  async function get(path) {
    const r = await fetch(`${API}${path}`);
    if (!r.ok) throw new Error(`${r.status} ${path}`);
    return r.json();
  }
  async function post(path, body) {
    const r = await fetch(`${API}${path}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${r.status} ${path}`);
    return r.json().catch(() => null);
  }
  async function put(path, body) {
    const r = await fetch(`${API}${path}`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${r.status} ${path}`);
    return r.json().catch(() => null);
  }
  async function del(path) {
    const r = await fetch(`${API}${path}`, { method: 'DELETE' });
    if (!r.ok) throw new Error(`${r.status} ${path}`);
    return r.json().catch(() => null);
  }

  // ── Cached settings data ──────────────────────────────────────────────────────
  let _rea = null, _de1 = null, _de1Adv = null, _workflow = null;

  async function refreshCache() {
    [_rea, _de1, _de1Adv, _workflow] = await Promise.all([
      get('/settings').catch(() => ({})),
      get('/machine/settings').catch(() => ({})),
      get('/machine/settings/advanced').catch(() => ({})),
      get('/workflow').catch(() => ({})),
    ]);
    if (_rea?.scalePowerMode) {
      window.NSXScreensaver?.setScalePowerMode(_rea.scalePowerMode);
    }
  }

  // ── Immediate save helpers ────────────────────────────────────────────────────
  const _err = e => console.error('[NSXSettings]', e);

  function saveRea(key, val) {
    if (_rea) _rea[key] = val;
    post('/settings', { [key]: val }).catch(_err);
  }
  function saveDe1(key, val) {
    if (_de1) _de1[key] = val;
    post('/machine/settings', { [key]: val }).catch(_err);
  }
  function saveDe1Adv(key, val) {
    if (_de1Adv) _de1Adv[key] = val;
    post('/machine/settings/advanced', { [key]: val }).catch(_err);
  }
  function savePluginEnabled(id, enabled) {
    post(`/plugins/${encodeURIComponent(id)}/${enabled ? 'enable' : 'disable'}`, {}).catch(_err);
  }
  function savePluginSetting(id, key, val) {
    post(`/plugins/${encodeURIComponent(id)}/settings`, { [key]: val }).catch(_err);
  }

  // ── DOM refs ──────────────────────────────────────────────────────────────────
  const overlayEl = document.getElementById('app-settings');
  const sidebarEl = document.getElementById('stg-sidebar');
  const contentEl = document.getElementById('stg-content');
  let activeCategory = 'connections';

  function ensureSidebarScrollEffect() {
    if (!overlayEl || !sidebarEl) return;
    const sidebarHeight = Math.max(0, sidebarEl.clientHeight || 0);
    const minPad = 260;
    const maxPad = 720;
    const pad = Math.min(maxPad, Math.max(minPad, Math.round(sidebarHeight * 0.82)));
    sidebarEl.style.setProperty('--stg-sidebar-scroll-pad', `${pad}px`);
  }

  // ── Categories ────────────────────────────────────────────────────────────────
  const CATEGORIES = [
    { id: 'connections',  label: 'Connections'  },
    { id: 'machine',      label: 'Machine'      },
    { id: 'interface',    label: 'Interface'    },
    { id: 'plugins',      label: 'Plugins'      },
    { id: 'maintenance',  label: 'Maintenance'  },
    { id: 'misc',         label: 'Advanced'     },
  ];

  // ── UI builder helpers ────────────────────────────────────────────────────────
  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls)          e.className   = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function section(title) {
    const wrap = h('div', 'stg-section');
    if (title) wrap.appendChild(h('div', 'stg-section-title', title));
    const rows = h('div', 'stg-rows');
    wrap.appendChild(rows);
    return { wrap, rows };
  }

  function row(labelText, sublabel, control) {
    const r = h('div', 'stg-row');
    const labelWrap = h('div', 'stg-row-label-wrap');
    if (labelText) labelWrap.appendChild(h('div', 'stg-row-label', labelText));
    if (sublabel)  labelWrap.appendChild(h('div', 'stg-row-sublabel', sublabel));
    r.appendChild(labelWrap);
    if (control) r.appendChild(control);
    return r;
  }

  function colRow(labelText, sublabel, control) {
    const r = h('div', 'stg-row stg-row-col');
    const labelWrap = h('div', 'stg-row-label-wrap');
    if (labelText) labelWrap.appendChild(h('div', 'stg-row-label', labelText));
    if (sublabel)  labelWrap.appendChild(h('div', 'stg-row-sublabel', sublabel));
    r.appendChild(labelWrap);
    if (control) r.appendChild(control);
    return r;
  }

  function numWheelPicker(value, min, max, step, onChange, decimals = 0) {
    let current = value;
    const wrap    = h('div', 'stg-stepper');
    const minus   = h('button', 'stg-step-btn', '−');
    const display = h('button', 'stg-step-display');
    const plus    = h('button', 'stg-step-btn', '+');
    display.textContent = current.toFixed(decimals);
    function update(v) {
      current = parseFloat(Math.min(max, Math.max(min, Math.round(v / step) * step)).toFixed(decimals));
      display.textContent = current.toFixed(decimals);
      onChange(current);
    }
    display.addEventListener('click', () => {
      const vals = [];
      for (let v = min; v <= max + 1e-9; v = parseFloat((v + step).toFixed(decimals + 3))) vals.push(parseFloat(v.toFixed(decimals)));
      window.openNumberPicker(vals, current, v => { current = v; display.textContent = v.toFixed(decimals); onChange(v); }, decimals);
    });
    minus.addEventListener('click', () => update(current - step));
    plus.addEventListener('click',  () => update(current + step));
    wrap.append(minus, display, plus);
    return wrap;
  }

  function timePicker(minuteValue, onChange) {
    let current = minuteValue;
    const wrap    = h('div', 'stg-stepper');
    const minus   = h('button', 'stg-step-btn', '−');
    const display = h('button', 'stg-step-display');
    const plus    = h('button', 'stg-step-btn', '+');
    function fmt(m) {
      return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    }
    function update(v) {
      current = ((v % 1440) + 1440) % 1440;
      display.textContent = fmt(current);
      onChange(current);
    }
    display.textContent = fmt(current);
    display.addEventListener('click', () => {
      const hourVals = Array.from({length: 24}, (_, i) => i * 60);
      window.openNumberPicker(hourVals, current, v => update(v), 0, m => fmt(m));
    });
    minus.addEventListener('click', () => update(current - 15));
    plus.addEventListener('click',  () => update(current + 15));
    wrap.append(minus, display, plus);
    return wrap;
  }

  function toggle(checked, onChange) {
    const label = h('label', 'power-toggle');
    const input = h('input');
    input.type = 'checkbox';
    input.className = 'power-toggle-input';
    input.checked = checked;
    const track = h('span', 'power-toggle-track');
    track.appendChild(h('span', 'power-toggle-thumb'));
    input.addEventListener('change', () => onChange(input.checked));
    label.append(input, track);
    return label;
  }

  function select(options, value, onChange) {
    const wrap = h('div', 'stg-dropdown');
    let current = value;

    const btn = h('button', 'stg-dropdown-btn');
    btn.type = 'button';
    const btnLabel = h('span');
    btn.append(btnLabel);
    btn.insertAdjacentHTML('beforeend', `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`);
    wrap.appendChild(btn);

    function getLabel(v) {
      return (options.find(([ov]) => String(ov) === String(v)) ?? options[0])?.[1] ?? String(v);
    }

    function updateBtn() { btnLabel.textContent = getLabel(current); }
    updateBtn();

    function openList() {
      const existing = document.getElementById('stg-dropdown-open');
      if (existing) existing.remove();

      const list = h('div', 'stg-dropdown-list');
      list.id = 'stg-dropdown-open';

      options.forEach(([v, label]) => {
        const item = h('button', 'stg-dropdown-item' + (String(v) === String(current) ? ' selected' : ''), label);
        item.type = 'button';
        item.addEventListener('click', () => {
          current = v;
          updateBtn();
          list.remove();
          onChange(v);
        });
        list.appendChild(item);
      });

      document.body.appendChild(list);

      const rect = btn.getBoundingClientRect();
      const top    = rect.top;
      const left   = rect.left;
      const bottom = rect.bottom;
      const width  = rect.width;
      const spaceBelow = window.innerHeight - bottom;
      list.style.minWidth = width + 'px';
      if (spaceBelow >= list.offsetHeight + 8) {
        list.style.top  = (bottom + 4) + 'px';
        list.style.left = left + 'px';
      } else {
        list.style.top  = (top - list.offsetHeight - 4) + 'px';
        list.style.left = left + 'px';
      }

      setTimeout(() => {
        document.addEventListener('click', function dismiss(e) {
          if (!list.contains(e.target)) { list.remove(); document.removeEventListener('click', dismiss); }
        });
      }, 0);
    }

    btn.addEventListener('click', e => { e.stopPropagation(); openList(); });
    return wrap;
  }

  function textInput(value, placeholder, onChange) {
    const inp = h('input', 'stg-text-input');
    inp.type = 'text';
    inp.value = value ?? '';
    inp.placeholder = placeholder ?? '';
    inp.addEventListener('change', () => onChange(inp.value));
    return inp;
  }

  function slider(value, min, max, onChange) {
    const wrap = h('div', 'stg-slider-wrap');
    const inp  = h('input', 'stg-slider');
    const lbl  = h('span', 'stg-slider-val', String(value));
    inp.type  = 'range';
    inp.min   = min;
    inp.max   = max;
    inp.value = value;
    inp.addEventListener('input',  () => { lbl.textContent = inp.value; });
    inp.addEventListener('change', () => onChange(parseInt(inp.value, 10)));
    wrap.append(inp, lbl);
    return wrap;
  }

  function btn(label, cls, onClick) {
    const b = h('button', `stg-btn${cls ? ' ' + cls : ''}`, label);
    b.addEventListener('click', onClick);
    return b;
  }

  function badge(text, color) {
    return h('span', `stg-badge stg-badge-${color}`, text);
  }

  function showLoading(target) { target.innerHTML = '<div class="stg-loading">Loading…</div>'; }
  function showError(target, msg) { target.innerHTML = `<div class="stg-error">Error: ${msg}</div>`; }

  function safe(fn) {
    return async (...args) => { try { await fn(...args); } catch (e) { console.error('[NSXSettings]', e); } };
  }

  // ── Category: Connections ─────────────────────────────────────────────────────
  async function renderConnections(target) {
    showLoading(target);
    try {
      const [devices] = await Promise.all([
        get('/devices').catch(() => []),
        refreshCache(),
      ]);
      target.innerHTML = '';
      const list = Array.isArray(devices) ? devices : [];
      const machine = list.filter(d => d.type !== 'scale');
      const scales  = list.filter(d => d.type === 'scale');

      function deviceRows(items, sectionTitle) {
        const s = section(sectionTitle);
        if (items.length === 0) {
          s.rows.appendChild(row('No device found', null, null));
        } else {
          items.forEach(d => {
            const connectBtn = d.connected
              ? btn('Disconnect', 'stg-btn-danger stg-btn-sm', safe(async () => {
                  await del(`/devices/${encodeURIComponent(d.id)}`);
                  selectCategory('connections');
                }))
              : btn('Connect', 'stg-btn-primary stg-btn-sm', safe(async () => {
                  await put(`/devices/connect?deviceId=${encodeURIComponent(d.id)}`, {});
                  selectCategory('connections');
                }));
            const nameWrap = h('div');
            nameWrap.appendChild(h('div', 'stg-device-name', d.name ?? d.id));
            nameWrap.appendChild(h('div', 'stg-device-id', d.id));
            const r = h('div', 'stg-row');
            r.append(nameWrap);
            if (d.connected) r.appendChild(badge('Connected', 'green'));
            r.appendChild(connectBtn);
            s.rows.appendChild(r);
          });
        }
        const scanBtn = btn('Scan', 'stg-btn', safe(async () => {
          scanBtn.textContent = 'Scanning…';
          scanBtn.disabled = true;
          await get('/devices/scan').catch(() => null);
          setTimeout(() => selectCategory('connections'), 3000);
        }));
        const scanRow = h('div', 'stg-row stg-row-action');
        scanRow.appendChild(scanBtn);
        s.rows.appendChild(scanRow);
        return s.wrap;
      }

      target.appendChild(deviceRows(machine, 'Machine'));
      target.appendChild(deviceRows(scales,  'Scale'));

      const machineOpts = [['', '— None —'], ...list.filter(d => d.type !== 'scale').map(d => [d.id, d.name ?? d.id])];
      const scaleOpts   = [['', '— None —'], ...list.filter(d => d.type === 'scale').map(d => [d.id, d.name ?? d.id])];
      const sPreferred = section('Auto-Connect');
      sPreferred.rows.append(
        row('Preferred Machine', 'Auto-connect on startup',
          select(machineOpts, _rea?.preferredMachineId ?? '', v => saveRea('preferredMachineId', v || null))),
        row('Preferred Scale', 'Auto-connect on startup',
          select(scaleOpts, _rea?.preferredScaleId ?? '', v => saveRea('preferredScaleId', v || null))),
      );
      target.appendChild(sPreferred.wrap);

      const sPower = section('Scale Power Management');
      sPower.rows.append(
        row('Scale Power Mode', 'Behavior when machine goes to sleep',
          select(
            [['disabled', 'Disabled'], ['displayOff', 'Display Off'], ['disconnect', 'Disconnect']],
            _rea?.scalePowerMode ?? 'disabled',
            v => { saveRea('scalePowerMode', v); window.NSXScreensaver?.setScalePowerMode(v); }
          )),
      );
      target.appendChild(sPower.wrap);

    } catch (e) { showError(target, e.message); }
  }

  // ── Category: Machine ─────────────────────────────────────────────────────────
  async function renderMachine(target) {
    showLoading(target);
    try {
      await refreshCache();
      target.innerHTML = '';
      const ctrl = window.NSXSkinControls;
      const rea  = _rea ?? {};

      let nightSleepRow, nightWakeRow, autoSleepTimeoutRow;

      const s1 = section('Machine');
      s1.rows.append(
        row('Charging Mode', null, select(
          [['disabled', 'Disabled'], ['longevity', 'Longevity'], ['balanced', 'Balanced'], ['highAvailability', 'High Availability']],
          rea.chargingMode ?? 'disabled',
          v => saveRea('chargingMode', v))),
        (() => {
          const r = row('Night Mode', 'Pause charging overnight',
            toggle(rea.nightModeEnabled ?? false, v => {
              saveRea('nightModeEnabled', v);
              nightSleepRow.hidden = !v;
              nightWakeRow.hidden  = !v;
              r.classList.toggle('stg-row--no-bottom-divider', v);
            }));
          if (rea.nightModeEnabled ?? false) r.classList.add('stg-row--no-bottom-divider');
          return r;
        })(),
        (() => { nightSleepRow = row('Night Mode Sleep', 'Time to start sleep (e.g. 22:00)',
          timePicker(rea.nightModeSleepTime ?? 1320, v => saveRea('nightModeSleepTime', v)));
          nightSleepRow.hidden = !(rea.nightModeEnabled ?? false);
          nightSleepRow.classList.add('stg-row--no-divider', 'stg-row--no-bottom-divider');
          return nightSleepRow; })(),
        (() => { nightWakeRow = row('Night Mode Wake', 'Time to wake up (e.g. 07:00)',
          timePicker(rea.nightModeMorningTime ?? 420, v => saveRea('nightModeMorningTime', v)));
          nightWakeRow.hidden = !(rea.nightModeEnabled ?? false);
          nightWakeRow.classList.add('stg-row--no-divider');
          return nightWakeRow; })(),
      );
      if (ctrl?.getPresenceEnabled) {
        const autoSleepEnabled = ctrl.getPresenceEnabled();
        const autoSleepToggleRow = row('Auto Sleep', null,
          toggle(autoSleepEnabled, v => {
            ctrl.setPresenceEnabled(v);
            autoSleepTimeoutRow.hidden = !v;
          }));
        autoSleepTimeoutRow = row('Timeout (min)', null,
          numWheelPicker(ctrl.getPresenceTimeout(), 15, 120, 15, v => ctrl.setPresenceTimeout(v)));
        autoSleepTimeoutRow.hidden = !autoSleepEnabled;
        autoSleepToggleRow.classList.add('stg-row--no-bottom-divider');
        autoSleepTimeoutRow.classList.add('stg-row--no-divider');
        s1.rows.append(autoSleepToggleRow, autoSleepTimeoutRow);
      }
      target.appendChild(s1.wrap);

      const sWater = section('Water Tank');
      const ML_PER_MM = 1140 / 41;
      const fmtRefill = mm => `${mm} mm (${Math.round(mm * ML_PER_MM)} ml)`;
      let _refillMm = ctrl?.getRefillLevelMm?.() ?? 30;
      const refillWrap    = h('div', 'stg-stepper');
      const refillMinus   = h('button', 'stg-step-btn', '−');
      const refillDisplay = h('button', 'stg-step-display');
      const refillPlus    = h('button', 'stg-step-btn', '+');
      refillDisplay.textContent = fmtRefill(_refillMm);
      function updateRefill(v) {
        _refillMm = Math.min(43, Math.max(5, Math.round(v)));
        refillDisplay.textContent = fmtRefill(_refillMm);
        ctrl?.setRefillLevelMm?.(_refillMm);
      }
      refillMinus.addEventListener('click', () => updateRefill(_refillMm - 1));
      refillPlus.addEventListener('click',  () => updateRefill(_refillMm + 1));
      refillWrap.append(refillMinus, refillDisplay, refillPlus);
      sWater.rows.append(
        row('Refill Alert', 'Minimum level before warning', refillWrap),
        row('Display Unit', 'Show level in header as', select(
          [['pct', 'Percent (%)'], ['ml', 'Millilitres (ml)']],
          ctrl?.getWaterUnit?.() ?? 'pct',
          v => ctrl?.setWaterUnit?.(v)
        )),
      );
      target.appendChild(sWater.wrap);

      const s2 = section(null);
      const calibRow = h('div', 'stg-row stg-row-nav');
      const calibLabel = h('div', 'stg-row-label-wrap');
      calibLabel.appendChild(h('div', 'stg-row-label', 'Calibration'));
      calibRow.append(calibLabel);
      calibRow.insertAdjacentHTML('beforeend', `<svg class="stg-row-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`);
      calibRow.addEventListener('click', () => showDetailPanel('Calibration', 'Machine', contentEl => {
        const de1Adv = _de1Adv ?? {};

        const s1 = section('Flow');
        s1.rows.append(
          row('Flow Estimation Multiplier', null, numWheelPicker(rea.flowEstimationMultiplier ?? 1.0, 0, 5, 0.1,
            v => saveRea('flowEstimationMultiplier', v), 1)),
          row('Weight Flow Multiplier', null, numWheelPicker(rea.weightFlowMultiplier ?? 1.0, 0, 5, 0.1,
            v => saveRea('weightFlowMultiplier', v), 1)),
          row('Volume Flow Multiplier', null, numWheelPicker(rea.volumeFlowMultiplier ?? 0.3, 0, 2, 0.05,
            v => saveRea('volumeFlowMultiplier', v), 2)),
        );
        contentEl.appendChild(s1.wrap);

        const s2 = section('Heater');
        s2.rows.append(
          row('Fan Threshold (°C)', null, numWheelPicker(_de1?.fan ?? 0, 0, 100, 1,
            v => saveDe1('fan', v))),
          row('Idle Temperature (°C)', null, numWheelPicker(de1Adv.heaterIdleTemp ?? 0, 0, 100, 0.5,
            v => saveDe1Adv('heaterIdleTemp', v), 1)),
          row('Phase 1 Flow (ml/s)', null, numWheelPicker(de1Adv.heaterPh1Flow ?? 6.0, 0, 10, 0.1,
            v => saveDe1Adv('heaterPh1Flow', v), 1)),
          row('Phase 2 Flow (ml/s)', null, numWheelPicker(de1Adv.heaterPh2Flow ?? 6.0, 0, 10, 0.1,
            v => saveDe1Adv('heaterPh2Flow', v), 1)),
          row('Phase 2 Timeout (s)', null, numWheelPicker(de1Adv.heaterPh2Timeout ?? 0, 0, 120, 5,
            v => saveDe1Adv('heaterPh2Timeout', v))),
        );
        contentEl.appendChild(s2.wrap);
      }));
      s2.rows.appendChild(calibRow);
      target.appendChild(s2.wrap);

      if (ctrl) {
        const s3 = section('Display');
        s3.rows.append(
          colRow('Brightness', null, slider(ctrl.getBrightness(), 0, 100,
            v => ctrl.setBrightness(v))),
          row('Low Battery Brightness Limit', 'Cap brightness at 20 when battery < 30%',
            toggle(rea.lowBatteryBrightnessLimit ?? false,
              v => saveRea('lowBatteryBrightnessLimit', v))),
        );
        target.appendChild(s3.wrap);

      }

      try {
        const info = await get('/machine/info');
        const s5 = section('Machine Info');
        [['Model', info.model], ['Serial', info.serial],
         ['Firmware', info.firmwareVersion], ['Board', info.boardVersion]]
          .filter(([, v]) => v)
          .forEach(([label, value]) => s5.rows.appendChild(row(label, null, h('span', 'stg-row-value', value))));
        target.appendChild(s5.wrap);
      } catch (_) {}

    } catch (e) { showError(target, e.message); }
  }

  // ── Category: Maintenance ─────────────────────────────────────────────────────
  function renderMaintenance(target) {
    target.innerHTML = '';
    const s1 = section('Descaling');
    s1.rows.appendChild(h('div', 'stg-info', 'Start a descaling cycle from the machine controls. Ensure the water tank is filled with descaling solution.'));
    target.appendChild(s1.wrap);

    const s2 = section('Transport Mode');
    s2.rows.appendChild(h('div', 'stg-info', "Transport mode is available via the machine's on-device menu or Streamline-Bridge settings."));
    target.appendChild(s2.wrap);
  }

  // ── Category: Interface ───────────────────────────────────────────────────────
  function renderInterface(target) {
    target.innerHTML = '';
    const ctrl = window.NSXSkinControls;
    if (!ctrl) { showError(target, 'Skin controls not available'); return; }

    const s1 = section('General');
    s1.rows.append(
      row('Language', null, select(
        [['de', 'Deutsch'], ['en', 'English']],
        ctrl.getLang(),
        v => ctrl.setLang(v))),
      row('Theme', null, select(
        [['dark', 'Dark']],
        ctrl.getTheme(),
        v => ctrl.setTheme(v))),
      row('Home Title', null, textInput(ctrl.getHomeLabel(), 'Home',
        v => ctrl.setHomeLabel(v))),
      row('Start Page', 'Where to land after unlocking', select(
        [['home', 'Home'], ['recipe', 'Recipes']],
        ctrl.getStartTab(),
        v => ctrl.setStartTab(v))),
      row('Show Refresh Button', 'Adds a manual refresh button to the header', toggle(
        ctrl.getShowRefreshButton(),
        v => ctrl.setShowRefreshButton(v))),
    );
    target.appendChild(s1.wrap);

    const presets = ctrl.SCALE_PRESETS ?? {};
    const currentKey = ctrl.getScaleKey();
    const presetValues = Object.values(presets);
    let isManual = currentKey !== 'auto' && !presetValues.includes(currentKey);

    function resolvedPct(key) {
      if (key === 'auto') return Math.round(Number(ctrl.getCurrentScale?.() ?? 100));
      return Math.max(90, Math.min(110, Math.round(Number(presets[key] ?? key) || 100)));
    }

    const scaleSlider = h('input', 'stg-slider');
    scaleSlider.type  = 'range';
    scaleSlider.min   = '90';
    scaleSlider.max   = '110';
    scaleSlider.step  = '1';

    const scaleNumInput = h('input', 'stg-step-input');
    scaleNumInput.type      = 'number';
    scaleNumInput.min       = '90';
    scaleNumInput.max       = '110';
    scaleNumInput.step      = '1';
    scaleNumInput.style.width = '60px';

    const pctLabel = h('span', 'stg-slider-val', '%');

    function syncSlider(key) {
      const pct = resolvedPct(key);
      scaleSlider.value   = String(pct);
      scaleNumInput.value = String(pct);
      scaleSlider.disabled    = !isManual;
      scaleNumInput.disabled  = !isManual;
      scaleSlider.style.opacity    = isManual ? '' : '0.35';
      scaleNumInput.style.opacity  = isManual ? '' : '0.35';
      autoBtn.classList.toggle('is-active', key === 'auto');
      manualBtn.classList.toggle('is-active', isManual);
      Object.keys(presets).forEach(k => {
        const btn = presetBtns.get(k);
        if (btn) btn.classList.toggle('is-active', !isManual && key !== 'auto' && k === key);
      });
    }

    const autoBtn = btn('Auto', 'stg-mode-btn', () => {
      isManual = false;
      ctrl.setScale('auto');
      syncSlider('auto');
    });

    const manualBtn = btn('Manual', 'stg-mode-btn', () => {
      isManual = true;
      syncSlider(currentKey === 'auto' ? String(resolvedPct('auto')) : currentKey);
    });

    const modeBtns = h('div', 'stg-mode-btns');
    modeBtns.append(autoBtn, manualBtn);

    const presetBtns = new Map();
    const presetWrap = h('div', 'stg-scale-presets');
    Object.entries(presets).forEach(([k, v]) => {
      const b = btn(`${k}`, 'stg-scale-preset-btn', () => {
        isManual = false;
        ctrl.setScale(k);
        syncSlider(k);
      });
      presetBtns.set(k, b);
      presetWrap.appendChild(b);
    });

    scaleSlider.addEventListener('input',  () => { if (isManual) scaleNumInput.value = scaleSlider.value; });
    scaleSlider.addEventListener('change', () => {
      if (!isManual) return;
      const pct = Math.max(90, Math.min(110, Math.round(Number(scaleSlider.value))));
      scaleNumInput.value = String(pct);
      ctrl.setScale(String(pct));
    });
    scaleNumInput.addEventListener('change', () => {
      if (!isManual) return;
      const pct = Math.max(90, Math.min(110, Math.round(Number(scaleNumInput.value))));
      scaleSlider.value = String(pct);
      ctrl.setScale(String(pct));
    });

    const sliderWrap = h('div', 'stg-slider-wrap');
    sliderWrap.append(scaleSlider, scaleNumInput, pctLabel);

    const s2 = section('Display Scale');
    s2.rows.append(
      row('Mode',    null, modeBtns),
      row('Presets', null, presetWrap),
      colRow('Value (%)', null, sliderWrap),
    );
    target.appendChild(s2.wrap);

    syncSlider(isManual ? currentKey : currentKey);

    const sRecipes = section('Recipes');
    sRecipes.rows.append(
      row('Open Recipe Page', 'Automatically navigate to the recipe page when tapping a recent recipe on the home screen',
        toggle(ctrl.getRecentRecipeNav?.() === true, v => ctrl.setRecentRecipeNav?.(v))),
      row('Show Rating on Recipe Card', 'Show the best rating stars on recipe cards on the recipe screen',
        toggle(ctrl.getShowRecipeCardRating?.() !== false, v => ctrl.setShowRecipeCardRating?.(v))),
      row('Freeze Batches', 'Show freeze button on bean batch entries',
        toggle(ctrl.getBatchFreezeEnabled?.() === true, v => ctrl.setBatchFreezeEnabled?.(v))),
    );
    target.appendChild(sRecipes.wrap);

    const sScale = section('Scale');
    sScale.rows.append(
      row('Ratio Dose', 'Show button on recipe page to temporarily scale dose & yield from live scale weight',
        toggle(ctrl.getRatioDoseEnabled?.() === true, v => ctrl.setRatioDoseEnabled?.(v))),
    );
    const cupVal = h('span', 'stg-row-value');
    const setCupLabel = (w) => { cupVal.textContent = `${w} g`; };
    setCupLabel(ctrl.getDosingCupWeight?.() || 0);
    const cupControl = h('div');
    cupControl.style.cssText = 'display:flex; align-items:center; gap:8px;';
    cupControl.append(
      cupVal,
      btn('Measure', null, () => { const w = ctrl.measureDosingCup?.(); if (w != null) setCupLabel(w); }),
      btn('Clear', null, () => { ctrl.setDosingCupWeight?.(0); setCupLabel(0); }),
      btn('Tare', null, () => ctrl.tare?.()),
    );
    sScale.rows.append(
      row('Dosing Cup Weight', '0 g = tare the cup first, then dose. Or set the cup weight to dose without taring — it is subtracted from the total. (Place empty cup, tap Measure.)', cupControl),
      row('Tare on Negative', 'Automatically tare the scale when it reads negative (e.g. after removing a cup)',
        toggle(ctrl.getTareOnNegative?.() !== false, v => ctrl.setTareOnNegative?.(v))),
    );
    target.appendChild(sScale.wrap);

    const sLock = section('Lockscreen');

    const wakeUnlockRow = row('Wake on Unlock', 'Automatically turn the machine on when unlocking the lockscreen',
      toggle(ctrl.getWakeOnUnlock?.() !== false, v => ctrl.setWakeOnUnlock?.(v)));
    const dimLevelRow = colRow('Dim Level', null,
      slider(ctrl.getScreensaverBrightness?.() ?? 50, 0, 100, v => ctrl.setScreensaverBrightness?.(v)));
    const dimRow = row('Dim While Locked', 'Lower brightness while the lockscreen is showing',
      toggle(ctrl.getScreensaverDimEnabled?.() !== false, v => { ctrl.setScreensaverDimEnabled?.(v); dimLevelRow.hidden = !v; }));
    const keepLockedRow = row('Keep Screen On While Locked', 'Keep the screen awake showing the clock instead of letting the tablet sleep',
      toggle(ctrl.getWakeLockLocked?.() === true, v => ctrl.setWakeLockLocked?.(v)));

    const fileInput = h('input');
    fileInput.type = 'file';
    fileInput.accept = 'image/*';
    fileInput.multiple = true;
    fileInput.hidden = true;

    const thumbStrip = h('div', 'stg-ss-thumbs');
    const imgControl = h('div');
    imgControl.style.cssText = 'display:flex; align-items:center; gap:8px;';
    const addBtn = btn('Add Images', null, () => fileInput.click());
    const clearBtn = btn('Clear', null, async () => {
      await ctrl.clearScreensaverImages?.();
      renderThumbs();
    });
    imgControl.append(addBtn, clearBtn, fileInput);

    const customOnlyRow = row('Only Own Images', 'Hide the built-in Decent photos and rotate only your own',
      toggle(ctrl.getScreensaverCustomOnly?.() === true, v => ctrl.setScreensaverCustomOnly?.(v)));

    const imgRow = colRow('Own Background Images', 'Stored on this device only — tap an image to remove it', thumbStrip);

    function renderThumbs() {
      const images = ctrl.getScreensaverImages?.() || [];
      const max = ctrl.getScreensaverMaxImages?.() ?? 20;
      thumbStrip.textContent = '';
      images.forEach((src, i) => {
        const t = h('button', 'stg-ss-thumb');
        t.style.backgroundImage = `url("${src}")`;
        t.title = 'Remove';
        t.addEventListener('click', async () => {
          await ctrl.removeScreensaverImage?.(i);
          renderThumbs();
        });
        thumbStrip.appendChild(t);
      });
      if (!images.length) thumbStrip.appendChild(h('div', 'stg-row-sublabel', 'No images added'));
      addBtn.disabled = images.length >= max;
      clearBtn.hidden = !images.length;
      customOnlyRow.hidden = !images.length;
    }

    fileInput.addEventListener('change', async () => {
      try {
        await ctrl.addScreensaverImages?.(fileInput.files);
      } catch {
        /* keep the panel usable if a file can't be decoded or stored */
      }
      fileInput.value = '';
      renderThumbs();
    });

    const applyLockVisibility = (on) => {
      wakeUnlockRow.hidden = !on;
      dimRow.hidden = !on;
      dimLevelRow.hidden = !on || ctrl.getScreensaverDimEnabled?.() === false;
      keepLockedRow.hidden = !on;
      imgRow.hidden = !on;
      imgControlRow.hidden = !on;
      if (on) renderThumbs();
      else customOnlyRow.hidden = true;
    };

    const imgControlRow = row(null, null, imgControl);
    imgControlRow.style.justifyContent = 'flex-end';

    sLock.rows.append(
      row('Enable Lockscreen', 'Disable if using the device\'s own lock screen',
        toggle(ctrl.getLockscreenEnabled?.() !== false, v => { ctrl.setLockscreenEnabled?.(v); applyLockVisibility(v); })),
      wakeUnlockRow,
      dimRow,
      dimLevelRow,
      keepLockedRow,
      imgRow,
      imgControlRow,
      customOnlyRow,
      row('Keep Screen Awake (normal use)', 'When off, the tablet can sleep on its own — needed if you disable the lockscreen',
        toggle(ctrl.getWakeLockNormal?.() !== false, v => ctrl.setWakeLockNormal?.(v))),
    );
    applyLockVisibility(ctrl.getLockscreenEnabled?.() !== false);
    target.appendChild(sLock.wrap);

    const sReset = section('Reset');
    const resetBtn = btn('Reset to Factory Defaults', 'stg-btn-danger', async () => {
      const modal = document.getElementById('confirm-modal');
      const msgEl = document.getElementById('confirm-message');
      const okBtn = document.getElementById('btn-confirm-ok');
      const cancelBtn = document.getElementById('btn-confirm-cancel');
      if (!modal || !msgEl || !okBtn || !cancelBtn) return;
      msgEl.textContent = 'All skin settings and recipes will be reset to factory defaults. This cannot be undone.';
      okBtn.textContent = 'Reset';
      modal.hidden = false;
      function cleanup(result) {
        modal.hidden = true;
        okBtn.replaceWith(okBtn.cloneNode(true));
        cancelBtn.replaceWith(cancelBtn.cloneNode(true));
        if (!result) return;
        const storeDelete = key => fetch(`${API}/store/${key}`, { method: 'DELETE' }).catch(() => {});
        Promise.all([
          storeDelete('NSX/ui-settings'),
          storeDelete('NSX/recipes'),
          storeDelete('skin/lang'),
          storeDelete('skin/theme'),
        ]).then(() => location.reload());
      }
      document.getElementById('btn-confirm-ok').addEventListener('click', () => cleanup(true));
      document.getElementById('btn-confirm-cancel').addEventListener('click', () => cleanup(false));
    });
    const resetRow = h('div', 'stg-row stg-row-action');
    resetRow.appendChild(resetBtn);
    sReset.rows.appendChild(resetRow);
    target.appendChild(sReset.wrap);
  }

  // ── Category: Integrations ────────────────────────────────────────────────────
  // ── Plugin detail slide-in panel ─────────────────────────────────────────────
  function showDetailPanel(title, backLabel, fillFn) {
    const mainEl = document.querySelector('.stg-main');
    if (!mainEl) return;

    const panel = h('div', 'stg-detail-panel');
    const header = h('div', 'stg-detail-header');
    const backBtn = h('button', 'stg-detail-back');
    backBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
      stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>${backLabel}`;
    backBtn.addEventListener('click', () => {
      panel.classList.remove('open');
      setTimeout(() => panel.remove(), 300);
    });
    header.append(backBtn, h('span', 'stg-detail-name', title));
    panel.appendChild(header);

    const content = h('div', 'stg-detail-content');
    panel.appendChild(content);

    mainEl.appendChild(panel);
    requestAnimationFrame(() => requestAnimationFrame(() => panel.classList.add('open')));

    fillFn(content);
  }

  function showPluginDetail(plugin) {
    const id = plugin.id ?? plugin.pluginId;
    showDetailPanel(plugin.name ?? id, 'Plugins', content => loadPluginDetail(content, plugin, id));
  }

  async function loadPluginDetail(target, plugin, id) {
    showLoading(target);
    try {
      const isViz = /visualizer/i.test(id ?? '');
      const settings = isViz
        ? await get(`/plugins/${encodeURIComponent(id)}/settings`).catch(() => ({}))
        : {};

      target.innerHTML = '';

      const s1 = section(null);
      s1.rows.append(
        row('Enabled', null, toggle(plugin?.loaded ?? false,
          v => savePluginEnabled(id, v))),
      );
      target.appendChild(s1.wrap);

      if (isViz) {
        const s2 = section('Account');
        const pwdInp = h('input', 'stg-text-input');
        pwdInp.type = 'password';
        pwdInp.value = settings.Password ?? '';
        pwdInp.placeholder = 'Password…';
        pwdInp.addEventListener('change', () => savePluginSetting(id, 'Password', pwdInp.value));
        s2.rows.append(
          row('Username', null, textInput(settings.Username ?? '', 'Username…',
            v => savePluginSetting(id, 'Username', v))),
          row('Password', null, pwdInp),
        );
        target.appendChild(s2.wrap);

        const s3 = section('Upload');
        s3.rows.append(
          row('Auto Upload', null, toggle(settings.AutoUpload ?? true,
            v => savePluginSetting(id, 'AutoUpload', v))),
          row('Min. Shot Duration (s)', null, numWheelPicker(settings.LengthThreshold ?? 5, 0, 120, 5,
            v => savePluginSetting(id, 'LengthThreshold', v))),
        );
        target.appendChild(s3.wrap);

        const s4 = section('Back Sync');
        s4.rows.append(
          row('Enable Back Sync', null, toggle(settings.BackSync ?? false,
            v => savePluginSetting(id, 'BackSync', v))),
          row('Interval (s)', null, numWheelPicker(settings.BackSyncIntervalSeconds ?? 300, 60, 3600, 60,
            v => savePluginSetting(id, 'BackSyncIntervalSeconds', v))),
        );
        target.appendChild(s4.wrap);
      }
    } catch (e) { showError(target, e.message); }
  }

  // ── Category: Plugins ─────────────────────────────────────────────────────────
  async function renderPlugins(target) {
    showLoading(target);
    try {
      const plugins = await get('/plugins').catch(() => []);
      target.innerHTML = '';
      const list = Array.isArray(plugins) ? plugins : [];

      const chevronSvg = `<svg class="stg-row-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`;

      const s1 = section(null);
      if (list.length === 0) {
        s1.rows.appendChild(row('No plugins found', null, null));
      } else {
        list.forEach(p => {
          const id = p.id ?? p.pluginId;
          const nameWrap = h('div', 'stg-row-label-wrap');
          nameWrap.appendChild(h('div', 'stg-device-name', p.name ?? id));
          if (p.description) nameWrap.appendChild(h('div', 'stg-device-id', p.description));
          const statusBadge = badge(p.loaded ? 'On' : 'Off', p.loaded ? 'green' : 'gray');
          const r = h('div', 'stg-row stg-row-nav');
          r.innerHTML = '';
          r.append(nameWrap, statusBadge);
          r.insertAdjacentHTML('beforeend', chevronSvg);
          r.addEventListener('click', () => showPluginDetail(p));
          s1.rows.appendChild(r);
        });
      }
      target.appendChild(s1.wrap);
    } catch (e) { showError(target, e.message); }
  }

  // ── Category: Advanced ────────────────────────────────────────────────────────
  async function renderMisc(target) {
    showLoading(target);
    try {
      await refreshCache();
      target.innerHTML = '';
      const rea    = _rea    ?? {};
      const de1Adv = _de1Adv ?? {};

      const s1 = section('Advanced App Settings');
      s1.rows.append(
        row('Gateway Mode', null, select(
          [['disabled', 'Disabled'], ['tracking', 'Tracking'], ['full', 'Full']],
          rea.gatewayMode ?? 'tracking', v => saveRea('gatewayMode', v))),
        row('Log Level', null, select(
          [['INFO','INFO'],['WARNING','WARNING'],['SEVERE','SEVERE'],['FINE','FINE'],
           ['FINER','FINER'],['FINEST','FINEST'],['ALL','ALL'],['OFF','OFF']],
          rea.logLevel ?? 'INFO', v => saveRea('logLevel', v))),
        row('Automatic Update Checks', null,
          toggle(rea.automaticUpdateCheck !== false, v => saveRea('automaticUpdateCheck', v))),
      );
      target.appendChild(s1.wrap);

      const sMachine = section('Machine');
      sMachine.rows.append(
        row('USB Charger Mode', 'Powers tablet while machine is on',
          toggle(_de1?.usb === true, v => saveDe1('usb', v ? 'enable' : 'disable'))),
      );
      target.appendChild(sMachine.wrap);

      const s2 = section('Streamline-Bridge');
      const openWebBtn = btn('Open Settings Web UI', 'stg-btn-primary', () => {
        const base = window.NSXConfig?.GATEWAY ?? `http://${location.hostname}:8080`;
        window.open(`${base}/api/v1/plugins/settings.reaplugin/ui`, '_blank');
      });
      const webRow = h('div', 'stg-row stg-row-action');
      webRow.appendChild(openWebBtn);
      s2.rows.appendChild(webRow);
      target.appendChild(s2.wrap);

    } catch (e) { showError(target, e.message); }
  }


  // ── Category dispatcher ───────────────────────────────────────────────────────
  const RENDERERS = {
    connections:  renderConnections,
    machine:      renderMachine,
    interface:    renderInterface,
    plugins:      renderPlugins,
    maintenance:  renderMaintenance,
    misc:         renderMisc,
  };

  // ── Navigation ────────────────────────────────────────────────────────────────
  function buildSidebar() {
    sidebarEl.innerHTML = '';
    CATEGORIES.forEach(({ id, label }) => {
      const b = h('button', 'stg-nav-btn' + (id === activeCategory ? ' active' : ''), label);
      b.addEventListener('click', () => selectCategory(id));
      sidebarEl.appendChild(b);
    });
  }

  function selectCategory(id) {
    activeCategory = id;
    const label = CATEGORIES.find(c => c.id === id)?.label ?? '';
    sidebarEl.querySelectorAll('.stg-nav-btn').forEach(b => {
      b.classList.toggle('active', b.textContent === label);
    });
    const pageTitleEl = document.getElementById('stg-page-title');
    if (pageTitleEl) pageTitleEl.textContent = label;
    contentEl.innerHTML = '';
    RENDERERS[id]?.(contentEl);
  }

  // ── Open / Close ──────────────────────────────────────────────────────────────
  function open() {
    if (!overlayEl) { console.error('[NSXSettings] #app-settings not found'); return; }
    overlayEl.classList.add('stg-comfort');
    overlayEl.hidden = false;
    ensureSidebarScrollEffect();
    buildSidebar();
    selectCategory(activeCategory);
    requestAnimationFrame(ensureSidebarScrollEffect);
  }

  function close() {
    if (overlayEl) overlayEl.hidden = true;
  }

  document.getElementById('btn-settings-close')?.addEventListener('click', close);

  window.addEventListener('resize', ensureSidebarScrollEffect, { passive: true });

  overlayEl?.classList.add('stg-comfort');
  ensureSidebarScrollEffect();

  window.NSXSettings = { open, close };
})();
