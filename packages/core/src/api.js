/**
 * api.js
 *
 * All communication with the Streamline-Bridge gateway:
 *   - Scale WebSocket — live weight updates
 *   - Water Levels WebSocket — tank level updates
 *   - REST helpers    — machine state commands
 *
 * Depends on: config.js (GATEWAY, WS_BASE)
 */
"use strict";

(() => {
const { GATEWAY, WS_BASE } = window.NSXConfig || {};

// api.js is DOM-free: the live scale weight is published via the "scale:weight"
// and "scale:status" events; each skin renders its own weight display from those.

let scaleWs;
let waterWs;
let machineSnapshotWs;
let devicesWs;
let reconnectDelay = 1000;
let waterReconnectDelay = 1000;
let machineReconnectDelay = 1000;
let devicesReconnectDelay = 1000;
const MAX_DELAY = 30_000;

function pathWithId(prefix, id) {
  return `${prefix}/${encodeURIComponent(String(id))}`;
}

async function request(endpoint, method = "GET", body = null, { allowNoContent = true } = {}) {
  const options = { method };
  if (body != null) {
    options.headers = { "Content-Type": "application/json" };
    options.body = JSON.stringify(body);
  }

  const res = await fetch(`${GATEWAY}${endpoint}`, options);

  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const err = await res.json();
      message = err?.message || err?.e || message;
    } catch {
      // keep HTTP fallback
    }
    throw new Error(message);
  }

  if (res.status === 204 && allowNoContent) return null;
  return res.json().catch(() => null);
}

async function requestTryMethods(endpoint, methods, body = null) {
  let lastError = null;
  for (const method of methods) {
    try {
      return await request(endpoint, method, body);
    } catch (err) {
      const msg = String(err?.message || "");
      if (msg.includes("404") || msg.includes("405")) {
        lastError = err;
        continue;
      }
      throw err;
    }
  }
  throw lastError || new Error("Endpoint nicht verfuegbar");
}

// ETag-conditional GET layer (mirrors the Passione skin's approach).
// Backs the list fetches that get re-requested on view-open / tab-resume to
// pick up changes made on ANOTHER device. Keeps a per-URL { etag, payload }.
// On a 304 we return the *same* payload reference we returned before — callers
// (and the domain caches) can therefore detect "unchanged" via `===` identity
// and skip re-rendering. Feature-detected: a 200 without an ETag header skips
// the cache write and behaves like a plain GET next time.
const _etagCache = new Map(); // url -> { etag, payload }

async function getWithEtag(endpoint) {
  const url = `${GATEWAY}${endpoint}`;
  const cached = _etagCache.get(url);

  const res = await fetch(url, {
    headers: cached?.etag ? { "If-None-Match": cached.etag } : {},
  });

  if (res.status === 304 && cached) return cached.payload;

  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const err = await res.json();
      message = err?.message || err?.e || message;
    } catch {
      // keep HTTP fallback
    }
    throw new Error(message);
  }

  if (res.status === 204) return null;
  const payload = await res.json().catch(() => null);
  const etag = res.headers.get("ETag");
  if (etag) _etagCache.set(url, { etag, payload });
  else _etagCache.delete(url);
  return payload;
}

function emitGatewayStatus(connected) {
  window.dispatchEvent(new CustomEvent("gateway:status", {
    detail: { connected },
  }));
}

function emitScaleStatus(connected) {
  window.dispatchEvent(new CustomEvent("scale:status", {
    detail: { connected },
  }));
}

function emitWaterLevel(level, refillLevel) {
  window.dispatchEvent(new CustomEvent("water:level", {
    detail: {
      currentLevel: level,
      refillLevel,
    },
  }));
}

function emitMachineState(state, substate) {
  window.dispatchEvent(new CustomEvent("gateway:machineState", {
    detail: { state, substate },
  }));
}

function emitDevicesStatus(data) {
  window.dispatchEvent(new CustomEvent("gateway:devices", {
    detail: data,
  }));
}

/* ── Scale WebSocket ──────────────────────────────────── */

let scaleAutoReconnect = true;

function connectScale() {
  scaleWs = new WebSocket(`${WS_BASE}/ws/v1/scale/snapshot`);

  scaleWs.onopen = () => {
    reconnectDelay = 1000;
    // scale stream can open while no scale is connected
  };

  scaleWs.onmessage = (e) => {
    try {
      const d = JSON.parse(e.data);

      if (d?.status === "connected") {
        emitScaleStatus(true);
        return;
      }

      if (d?.status === "disconnected") {
        emitScaleStatus(false);
        return;
      }

      if (Number.isFinite(d.weight)) {
        emitScaleStatus(true);
        window.dispatchEvent(new CustomEvent("scale:weight", {
          detail: { weight: d.weight, weightFlow: d.weightFlow ?? null },
        }));
      }
    } catch (err) {
      console.warn("Scale WS parse error:", err);
    }
  };

  scaleWs.onclose = () => {
    emitScaleStatus(false);
    if (scaleAutoReconnect) {
      setTimeout(connectScale, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_DELAY);
    }
  };
}

async function initiateScaleConnect() {
  scaleAutoReconnect = true;
  reconnectDelay = 1000;
  try {
    await request("/api/v1/devices/scan?connect=true");
  } catch {
    // connection may still come up via current device state
  }
  if (!scaleWs || scaleWs.readyState === WebSocket.CLOSED) {
    connectScale();
  }
}

async function initiateDE1Connect() {
  try {
    await request("/api/v1/devices/scan?connect=true");
  } catch {
    // gateway will retry via its own reconnect loop
  }
}

function disconnectScale() {
  scaleAutoReconnect = false;
  if (scaleWs) scaleWs.close();
}

async function setDisplayBrightness(level) {
  return request('/api/v1/display/brightness', 'PUT', { brightness: level });
}

async function fetchDisplayState() {
  return request('/api/v1/display');
}

async function fetchPresenceSettings() {
  return request('/api/v1/presence/settings');
}

async function updatePresenceSettings(settings) {
  return request('/api/v1/presence/settings', 'POST', settings);
}

async function signalUserPresenceHeartbeat() {
  return request('/api/v1/machine/heartbeat', 'POST');
}

async function requestWakeLockOverride() {
  return request('/api/v1/display/wakelock', 'POST');
}

async function releaseWakeLockOverride() {
  return request('/api/v1/display/wakelock', 'DELETE');
}

async function updateReaSettings(payload) {
  return request('/api/v1/settings', 'POST', payload);
}

function connectWaterLevels() {
  waterWs = new WebSocket(`${WS_BASE}/ws/v1/machine/waterLevels`);

  waterWs.onopen = () => {
    waterReconnectDelay = 1000;
  };

  waterWs.onmessage = (e) => {
    try {
      const d = JSON.parse(e.data);
      if (Number.isFinite(d.currentLevel)) {
        emitWaterLevel(d.currentLevel, d.refillLevel);
      }
    } catch (err) {
      console.warn("WaterLevels WS parse error:", err);
    }
  };

  waterWs.onclose = () => {
    setTimeout(connectWaterLevels, waterReconnectDelay);
    waterReconnectDelay = Math.min(waterReconnectDelay * 2, MAX_DELAY);
  };
}

/* ── Machine Snapshot WebSocket ──────────────────────── */
function connectMachineSnapshot() {
  machineSnapshotWs = new WebSocket(`${WS_BASE}/ws/v1/machine/snapshot`);

  machineSnapshotWs.onopen = () => {
    machineReconnectDelay = 1000;
    emitGatewayStatus(true);
  };

  machineSnapshotWs.onmessage = (e) => {
    try {
      const d = JSON.parse(e.data);
      if (d.state) {
        emitMachineState(d.state.state, d.state.substate);
      }
      // Emit full snapshot so subscribers (e.g. temperature display) can react
      window.dispatchEvent(new CustomEvent("gateway:snapshot", { detail: d }));
    } catch (err) {
      console.warn("Machine snapshot WS parse error:", err);
    }
  };

  machineSnapshotWs.onerror = () => {
    console.debug("Machine snapshot WS error");
  };

  machineSnapshotWs.onclose = () => {
    emitGatewayStatus(false);
    setTimeout(connectMachineSnapshot, machineReconnectDelay);
    machineReconnectDelay = Math.min(machineReconnectDelay * 2, MAX_DELAY);
  };
}

/* ── Devices WebSocket ───────────────────────────────── */
function connectDevices() {
  devicesWs = new WebSocket(`${WS_BASE}/ws/v1/devices`);

  devicesWs.onopen = () => {
    devicesReconnectDelay = 1000;
  };

  devicesWs.onmessage = (e) => {
    try {
      const d = JSON.parse(e.data);
      const devices = Array.isArray(d?.devices)
        ? d.devices
        : Array.isArray(d)
          ? d
          : [];

      const machineConnected = devices.some((x) => x?.type === "machine" && x?.state === "connected");
      const scaleConnected = devices.some((x) => x?.type === "scale" && x?.state === "connected");

      emitDevicesStatus({
        devices,
        machineConnected,
        scaleConnected,
        connectionStatus: d?.connectionStatus ?? null,
      });
    } catch (err) {
      console.warn("Devices WS parse error:", err);
    }
  };

  devicesWs.onclose = () => {
    setTimeout(connectDevices, devicesReconnectDelay);
    devicesReconnectDelay = Math.min(devicesReconnectDelay * 2, MAX_DELAY);
  };
}

/* ── Time-to-Ready Plugin WebSocket ──────────────────── */
let ttrWs = null;
let ttrReconnectDelay = 1000;

function connectTimeToReady() {
  ttrWs = new WebSocket(`${WS_BASE}/ws/v1/plugins/time-to-ready.reaplugin/timeToReady`);

  ttrWs.onopen = () => {
    ttrReconnectDelay = 1000;
  };

  ttrWs.onmessage = (e) => {
    try {
      const d = JSON.parse(e.data);
      const remainingMs = typeof d.remainingTimeMs === 'number' ? d.remainingTimeMs : null;
      window.dispatchEvent(new CustomEvent("gateway:timeToReady", { detail: { remainingMs } }));
    } catch (_) {}
  };

  ttrWs.onerror = () => {};

  ttrWs.onclose = () => {
    setTimeout(connectTimeToReady, ttrReconnectDelay);
    ttrReconnectDelay = Math.min(ttrReconnectDelay * 2, MAX_DELAY);
  };
}

/* ── Logs WebSocket (opt-in, diagnostic only) ─────────── */
// Unlike the streams above, nothing subscribes to this by default — it's REA's
// raw internal log feed (state machine transitions, BLE chatter, etc.), useful
// for a debug/diagnostics panel, not for driving UI features. Call
// NSXApi.startLogStream() to open it; NSXApi.stopLogStream() to close it.
let logsWs = null;
let logsReconnectDelay = 1000;
let logsAutoReconnect = false;

function connectLogs() {
  logsWs = new WebSocket(`${WS_BASE}/ws/v1/logs`);

  logsWs.onopen = () => {
    logsReconnectDelay = 1000;
  };

  logsWs.onmessage = (e) => {
    try {
      const d = JSON.parse(e.data);
      window.dispatchEvent(new CustomEvent("gateway:log", {
        detail: { timestamp: d?.timestamp ?? null, level: d?.level ?? null, message: d?.message ?? "" },
      }));
    } catch (_) {}
  };

  logsWs.onerror = () => {};

  logsWs.onclose = () => {
    if (logsAutoReconnect) {
      setTimeout(connectLogs, logsReconnectDelay);
      logsReconnectDelay = Math.min(logsReconnectDelay * 2, MAX_DELAY);
    }
  };
}

function startLogStream() {
  logsAutoReconnect = true;
  logsReconnectDelay = 1000;
  if (!logsWs || logsWs.readyState === WebSocket.CLOSED) {
    connectLogs();
  }
}

function stopLogStream() {
  logsAutoReconnect = false;
  if (logsWs) logsWs.close();
}

/* ── REST helpers ─────────────────────────────────────── */

/**
 * PUT /api/v1/machine/state/{state}
 * @param {string} state - e.g. "sleeping", "idle", "espresso"
 * @throws {Error} on non-OK HTTP response
 */
async function setMachineState(state) {
  await request(pathWithId("/api/v1/machine/state", state), "PUT");
}

/**
 * GET /api/v1/workflow
 * Returns the current workflow including profile and context.
 * @returns {Promise<object>}
 */
async function fetchCurrentWorkflow() {
  return request("/api/v1/workflow");
}

/**
 * PUT/POST/PATCH /api/v1/workflow
 * Pushes a workflow to the machine as active workflow.
 * @param {object} workflow
 * @throws {Error} when no endpoint/method combination succeeds
 */
async function pushWorkflow(workflow) {
  if (!workflow || typeof workflow !== "object") {
    throw new Error("Ungueltiger Workflow");
  }

  const endpoints = [
    "/api/v1/workflow",
    "/api/v1/workflow/current",
  ];
  const methods = ["PUT", "POST"];
  let lastError = null;

  for (const endpoint of endpoints) {
    for (const method of methods) {
      try {
        await request(endpoint, method, workflow);
        return;
      } catch (err) {
        const msg = String(err?.message || "");
        if (msg.includes("404") || msg.includes("405")) {
          lastError = err;
          continue;
        }
        throw err;
      }
      if (lastError) {
        continue;
      }
    }
  }

  throw lastError || new Error("Workflow-Endpoint nicht verfuegbar");
}

/**
 * GET /api/v1/shots?limit={limit}&offset={offset}&search={search}&coffeeName={coffeeName}...
 * Returns paginated shot history. Supports both positional and filter object parameters.
 * @param {number|object} limit - limit or filter object
 * @param {number} offset
 * @param {string} search
 * @returns {Promise<{items: object[], total: number}>}
 */
async function fetchShots(limit = 20, offset = 0, search = '') {
  let queryParams = new URLSearchParams();

  if (typeof limit === 'object' && limit !== null) {
    const filters = limit;
    queryParams.append('limit', filters.limit || 20);
    queryParams.append('offset', filters.offset || 0);
    if (filters.search) queryParams.append('search', filters.search);
    if (filters.coffeeName) queryParams.append('coffeeName', filters.coffeeName);
    if (filters.coffeeRoaster) queryParams.append('coffeeRoaster', filters.coffeeRoaster);
    if (filters.grinderModel) queryParams.append('grinderModel', filters.grinderModel);
    if (filters.profileTitle) queryParams.append('profileTitle', filters.profileTitle);
    if (filters.grinderId) queryParams.append('grinderId', filters.grinderId);
    if (filters.beanBatchId) queryParams.append('beanBatchId', filters.beanBatchId);
  } else {
    queryParams.append('limit', limit);
    queryParams.append('offset', offset);
    if (search) queryParams.append('search', search);
  }

  const url = `/api/v1/shots?${queryParams.toString()}`;
  // ETag-backed: lets the history view revalidate cheaply (304) on tab-resume.
  return getWithEtag(url);
}

/**
 * GET /api/v1/shots/{id}
 * Fetch single shot with full measurements
 * @param {string} shotId - shot ID
 * @returns {Promise<object>} shot object with measurements
 * @throws {Error} on non-OK HTTP response
 */
async function fetchShotDetails(shotId) {
  try {
    return await request(pathWithId('/api/v1/shots', shotId));
  } catch {
    const result = await request(`/api/v1/shots?ids=${encodeURIComponent(String(shotId))}`);
    const items = Array.isArray(result) ? result : (result?.items ?? result?.shots ?? []);
    return items?.[0] ?? null;
  }
}

/**
 * GET /api/v1/machine/info
 * Returns machine hardware info: version, model, serialNumber, GHC.
 * @returns {Promise<{version: string, model: string, serialNumber: string, GHC: boolean}>}
 */
async function fetchMachineInfo() {
  return request("/api/v1/machine/info");
}

/**
 * PUT/POST /api/v1/scale/tare
 * Some bridge versions expose either PUT or POST.
 * @throws {Error} on non-OK HTTP response for both methods
 */
async function tareScale() {
  await requestTryMethods("/api/v1/scale/tare", ["PUT", "POST"]);
}

/* ── Init ─────────────────────────────────────────────── */
connectScale();
connectWaterLevels();
connectMachineSnapshot();
connectDevices();
connectTimeToReady();

/**
 * PUT /api/v1/workflow  (machineSettings only)
 * Sends steam temperature and flow rate to the DE1.
 * @param {number} temperature  °C
 * @param {number} flowRate     ml/s
 */
async function pushSteamSettings(temperature, flowRate) {
  await pushWorkflow({
    steamSettings: {
      targetTemperature: Number(temperature),
      flow: Number(flowRate),
    },
  });
}

/**
 * PUT /api/v1/workflow  (machineSettings only)
 * Sends hot water temperature and volume to the DE1.
 * @param {number} temperature  °C
 * @param {number} volume       ml
 */
async function pushHotwaterSettings(temperature, volume) {
  await pushWorkflow({
    hotWaterData: {
      targetTemperature: Number(temperature),
      volume: Number(volume),
    },
  });
}

/**
 * PUT /api/v1/workflow  (machineSettings only)
 * Sends flush flow rate and duration to the DE1.
 * @param {number} flowRate   ml/s
 * @param {number} duration   seconds
 */
async function pushFlushSettings(flowRate, duration) {
  await pushWorkflow({
    rinseData: {
      flow: Number(flowRate),
      duration: Number(duration),
    },
  });
}

/** GET /api/v1/steams/latest */
async function fetchLatestSteam() {
  return request('/api/v1/steams/latest');
}

/** GET /api/v1/steams/:id */
async function fetchSteamById(id) {
  return request(`/api/v1/steams/${encodeURIComponent(id)}`);
}

/** GET /api/v1/machine/settings */
async function fetchMachineSettings() {
  return request('/api/v1/machine/settings');
}

/** POST /api/v1/machine/settings */
async function updateMachineSettings(payload) {
  return request('/api/v1/machine/settings', 'POST', payload);
}

/** GET /api/v1/presence/schedules */
async function fetchSchedules() {
  return request("/api/v1/presence/schedules");
}

/** POST /api/v1/presence/schedules */
async function createSchedule(schedule) {
  return request("/api/v1/presence/schedules", "POST", schedule);
}

/** PUT /api/v1/presence/schedules/{id} */
async function updateSchedule(id, schedule) {
  await request(pathWithId("/api/v1/presence/schedules", id), "PUT", schedule);
}

/** POST /api/v1/machine/waterLevels — set refill threshold (mm) */
async function pushRefillLevel(mm) {
  await request("/api/v1/machine/waterLevels", "POST", { refillLevel: Math.round(Number(mm)) });
}

/** DELETE /api/v1/presence/schedules/{id} */
async function deleteSchedule(id) {
  try {
    await request(pathWithId("/api/v1/presence/schedules", id), "DELETE");
  } catch (err) {
    if (!String(err?.message || "").includes("404")) throw err;
  }
}

/** DELETE /api/v1/shots/{id} */
async function deleteShotById(id) {
  try {
    await request(pathWithId("/api/v1/shots", id), "DELETE");
  } catch (err) {
    if (!String(err?.message || "").includes("404")) throw err;
  }
}

/** PUT /api/v1/shots/{id} — update arbitrary shot fields (partial) */
async function updateShotRecord(id, patch) {
  return request(pathWithId("/api/v1/shots", id), "PUT", patch);
}

/** PUT /api/v1/shots/{id} — update shot annotations */
async function updateShotMetadata(id, { rating, favorite, notes, tags, actualYield, virtualScale } = {}) {
  const extras = { favorite: favorite ?? false, tags: tags ?? [] };
  if (actualYield != null) extras.actualYield = actualYield;
  if (virtualScale != null) extras.virtualScale = virtualScale;
  return request(pathWithId("/api/v1/shots", id), "PUT", {
    annotations: {
      enjoyment:     rating,
      espressoNotes: notes ?? null,
      extras,
    },
  });
}

/** GET /api/v1/profiles */
async function fetchProfiles() {
  return getWithEtag("/api/v1/profiles");
}

/** GET /api/v1/profiles?includeHidden=true */
async function fetchProfilesIncludingHidden() {
  return getWithEtag("/api/v1/profiles?includeHidden=true");
}

/** GET /api/v1/profiles?visibility=deleted */
async function fetchDeletedProfiles() {
  return request("/api/v1/profiles?visibility=deleted");
}

/** GET /api/v1/profiles/{id} */
async function fetchProfileById(id) {
  return request(pathWithId("/api/v1/profiles", id));
}

/** POST /api/v1/profiles */
async function createProfile(profile) {
  const body = (profile && typeof profile === "object" && "profile" in profile)
    ? profile
    : { profile };
  return request("/api/v1/profiles", "POST", body);
}

/** PUT /api/v1/profiles/{id} — falls back to POST if not supported */
async function saveProfile(id, profile) {
  const body = (profile && typeof profile === "object" && "profile" in profile)
    ? profile
    : { profile };
  if (id) {
    try { return await request(pathWithId("/api/v1/profiles", id), "PUT", body); } catch (err) {
      if (!String(err?.message || "").includes("404") && !String(err?.message || "").includes("405")) throw err;
    }
  }
  return createProfile(body);
}

/** DELETE /api/v1/profiles/{id} */
async function deleteProfile(id) {
  return request(pathWithId("/api/v1/profiles", id), "DELETE");
}

/** PUT /api/v1/profiles/{id}/visibility */
async function setProfileVisibility(id, visibility) {
  return request(`${pathWithId("/api/v1/profiles", id)}/visibility`, "PUT", { visibility });
}

/** DELETE /api/v1/profiles/{id}/purge — permanent delete (non-default profiles only) */
async function purgeProfile(id) {
  return request(`${pathWithId("/api/v1/profiles", id)}/purge`, "DELETE");
}

/** PUT /api/v1/profiles/{id}/visibility — restore a soft-deleted profile */
async function restoreProfile(id) {
  return setProfileVisibility(id, 'visible');
}

/** GET /api/v1/beans */
async function fetchBeans(includeArchived = false) {
  // No _t cache-buster: the ETag layer handles freshness (a stale copy would
  // otherwise defeat conditional GETs by making every URL unique).
  return getWithEtag(`/api/v1/beans?includeArchived=${includeArchived}`);
}

/** POST /api/v1/beans */
async function createBean(bean) {
  return request("/api/v1/beans", "POST", bean);
}

/** GET /api/v1/beans/{beanId}/batches */
async function fetchBatches(beanId, includeArchived = false) {
  return request(`${pathWithId("/api/v1/beans", beanId)}/batches?includeArchived=${encodeURIComponent(includeArchived)}`);
}

/** POST /api/v1/beans/{beanId}/batches */
async function createBatch(beanId, batch) {
  return request(`${pathWithId("/api/v1/beans", beanId)}/batches`, "POST", batch);
}

/** GET /api/v1/bean-batches/{id} */
async function fetchBatch(id) {
  return request(pathWithId("/api/v1/bean-batches", id));
}

/** PUT /api/v1/bean-batches/{id} */
async function updateBatch(id, batch) {
  return request(pathWithId("/api/v1/bean-batches", id), "PUT", batch);
}

/** DELETE /api/v1/bean-batches/{id} */
async function deleteBatch(id) {
  try {
    await request(pathWithId("/api/v1/bean-batches", id), "DELETE");
  } catch (err) {
    if (!String(err?.message || "").includes("404")) throw err;
  }
}

/** PUT /api/v1/beans/{id} */
async function updateBean(id, bean) {
  return request(pathWithId("/api/v1/beans", id), "PUT", bean);
}

/** DELETE /api/v1/beans/{id} */
async function deleteBean(id) {
  try {
    await request(pathWithId("/api/v1/beans", id), "DELETE");
  } catch (err) {
    if (!String(err?.message || "").includes("404")) throw err;
  }
}

/** PUT /api/v1/beans/{id} — archive */
async function archiveBean(id, bean) {
  return request(pathWithId("/api/v1/beans", id), "PUT", { ...bean, archived: true });
}

/** PUT /api/v1/beans/{id} — unarchive */
async function unarchiveBean(id, bean) {
  return request(pathWithId("/api/v1/beans", id), "PUT", { ...bean, archived: false });
}

/** GET /api/v1/grinders */
async function fetchGrinders(includeArchived = false) {
  return getWithEtag(`/api/v1/grinders?includeArchived=${encodeURIComponent(includeArchived)}`);
}

/** POST /api/v1/grinders */
async function createGrinder(grinder) {
  return request("/api/v1/grinders", "POST", grinder);
}

/** PUT /api/v1/grinders/{id} */
async function updateGrinder(id, grinder) {
  return request(pathWithId("/api/v1/grinders", id), "PUT", grinder);
}

/** DELETE /api/v1/grinders/{id} */
async function deleteGrinder(id) {
  try {
    await request(pathWithId("/api/v1/grinders", id), "DELETE");
  } catch (err) {
    if (!String(err?.message || "").includes("404")) throw err;
  }
}

/** GET /api/v1/store/{namespace}/{key} */
async function getStoreValue(namespace, key) {
  return request(pathWithId(`/api/v1/store/${encodeURIComponent(namespace)}`, key));
}

/**
 * GET /api/v1/store/{namespace}?full=1 — every key in the namespace at once.
 * Unlike the single-key GET (which deliberately omits ETags), this endpoint
 * IS ETag-backed, so it powers cheap cross-device revalidation. Returns a
 * dict keyed by store key, e.g. { recipes: [...], "profile-favorites": [...] }.
 */
async function getStoreNamespace(namespace) {
  return getWithEtag(`/api/v1/store/${encodeURIComponent(namespace)}?full=1`);
}

/** POST /api/v1/store/{namespace}/{key} */
async function setStoreValue(namespace, key, value) {
  return request(pathWithId(`/api/v1/store/${encodeURIComponent(namespace)}`, key), "POST", value);
}

window.NSXApi = {
  setMachineState,
  fetchCurrentWorkflow,
  fetchMachineInfo,
  pushWorkflow,
  pushSteamSettings,
  pushHotwaterSettings,
  pushFlushSettings,
  fetchSchedules,
  createSchedule,
  updateSchedule,
  deleteSchedule,
  fetchShots,
  fetchShotDetails,
  tareScale,
  pushRefillLevel,
  initiateScaleConnect,
  initiateDE1Connect,
  disconnectScale,
  startLogStream,
  stopLogStream,
  setDisplayBrightness,
  fetchDisplayState,
  fetchPresenceSettings,
  updatePresenceSettings,
  signalUserPresenceHeartbeat,
  requestWakeLockOverride,
  releaseWakeLockOverride,
  updateReaSettings,
  deleteShotById,
  updateShotRecord,
  updateShotMetadata,
  fetchProfiles,
  fetchProfilesIncludingHidden,
  fetchProfileById,
  createProfile,
  saveProfile,
  deleteProfile,
  setProfileVisibility,
  fetchDeletedProfiles,
  purgeProfile,
  restoreProfile,
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
  fetchGrinders,
  createGrinder,
  updateGrinder,
  deleteGrinder,
  getStoreValue,
  setStoreValue,
  getStoreNamespace,
  fetchLatestSteam,
  fetchSteamById,
  fetchMachineSettings,
  updateMachineSettings,
};
})();
