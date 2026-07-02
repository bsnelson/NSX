# `@nsx/core` — the shared, DOM-free core

`packages/core/src` is the **source of truth** for all logic shared between skins.
It is **headless**: no DOM access, no skin-specific rendering, no reads of a skin's
mutable UI state. A second skin (e.g. a future Vue skin) consumes the exact same
core.

**Editing:** edit only here, then run **`npm run sync-core`** from the repo root
(copies `packages/core/src` → `packages/nsx/src/core/`, a git-ignored generated
copy that the Decent-served web root loads at `core/…`). Never edit
`packages/nsx/src/core/` directly — it is overwritten.

Everything attaches to a single global, **`window.NSXCore`**.

---

## The facade — `core.js`

Loaded first (after `config`/`translations`/`api`). Provides:

- `NSXCore.on(name, cb)` → returns an unsubscribe fn; `NSXCore.off(name, cb)`
- `NSXCore.emit(name, payload)` — publish a semantic event to subscribers
- `NSXCore.register(impl)` — a domain calls this to attach its selectors/commands
  as `NSXCore.<name>(...)`

It also **bridges** api.js's low-level `window` CustomEvents into semantic
`NSXCore` events, so presentation code subscribes to stable names instead of api
internals:

| window event (api.js)   | → NSXCore event    |
|-------------------------|--------------------|
| `gateway:status`        | `machineConnected` (bool) |
| `scale:status`          | `scaleConnected` (bool)   |
| `scale:weight`          | `scaleWeight`      |
| `gateway:machineState`  | `machineState`     |
| `water:level`           | `waterLevel`       |
| `gateway:devices`       | `devices`          |
| `gateway:snapshot`      | `liveShot`         |
| `gateway:timeToReady`   | `timeToReady`      |

## Non-domain modules

- **`config.js`** — constants (`window.NSXConfig`: `GATEWAY`, `WS_BASE`, …).
- **`api.js`** — REST + WebSocket gateway client (`window.NSXApi`). All raw
  `fetch`/WS lives here; domains call `window.NSXApi.<fn>`.
- **`translations.js`** — i18n strings (`window.NSXI18n`, `t(key)`). Domains that
  need a translated string use `window.NSXI18n?.t` with a fallback.
- **`store.js`** — the settings store. Owns the single **stable** `storeSettings`
  object (mutated **in place**, never reassigned), so app.js can hold
  `const storeSettings = NSXCore.getStore()` and ~80 reads stay valid.
  API: `getStore`, `patchStore`, `replaceStore`, `saveActivePresetName`,
  `migrateLegacyStore`, `loadStore`.
- **`push.js`** — `NSXCore.push(payload)` (calls `NSXApi.pushWorkflow`; on error
  `emit('toast', msg)`) and `NSXCore.debounced(key, fn, ms)`.

---

## Domains (`core/src/domains/*.js`)

Each domain is an IIFE that grabs `window.NSXCore`, guards it exists, then
`NSXCore.register({...})`. **Load order matters** — a domain must load after any
core module it depends on (all are listed after `store.js`/`push.js` in
`index.html`). A domain owns state + logic; the **skin keeps the DOM** and calls
these via thin same-named delegates so app.js call sites stay unchanged. Live skin
state a domain needs is **passed in as a parameter**, never read from an app.js
global (keeps core app-state-free).

### Preset / machine-function domains (own values + presets, emit a `*Changed` event)

- **`steam.js`** — `getSteamTemp/Flow/Duration`, `getSteamPresets`,
  `getActiveSteamPreset`, `isSteamEnabled`, `getSteamCalibration`,
  `getPitcherPresets`, `getActivePitcherIndex`, `getSbwCalibFactor`;
  `selectSteamPreset`, `deactivateSteamPreset`, `setSteamTemp/Flow/Duration`,
  `setSteamDurationRaw`, `setSteamEnabled`, `setSteamPresets`,
  `setSteamCalibration`, `setPitcherPresets`, `setActivePitcher`,
  `saveSteamSnapshot`, `applySteamSnapshot`, `hydrateSteam`; defaults
  `STEAM_PRESET_DEFAULTS`, `STEAM_CALIB_DEFAULTS`, `PITCHER_PRESET_DEFAULTS`.
  Emits `steamChanged`, `pitcherChanged`.
- **`hotwater.js`** — `getHotwaterTemp/Flow/Volume`, `getHotwaterPresets`,
  `getActiveHotwaterPreset`; `selectHotwaterPreset`, `setHotwaterTemp/Flow/Volume`,
  `deactivateHotwaterPreset`, `setHotwaterPresets`, `hydrateHotwater`.
  Emits `hotwaterChanged`.
- **`flush.js`** — `getFlushFlow/Duration`, `getFlushPresets`,
  `getActiveFlushPreset`; `selectFlushPreset`, `setFlushFlow/Duration`,
  `deactivateFlushPreset`, `setFlushPresets`, `hydrateFlush`. Emits `flushChanged`.
- **`schedule.js`** — `getScheduleState`; `applySchedule`, `setScheduleId`,
  `hydrateSchedule`, `syncScheduleToApi`. Emits `scheduleChanged`. Persists via
  the store and syncs to the gateway schedule API.

### List / CRUD cache domains (fetch + cache a list, thin CRUD wrappers that throw)

- **`grinder.js`** — `getGrinders`, `setGrindersCache`, `loadGrinders`,
  `createGrinder`, `updateGrinder`, `deleteGrinder`. Emits `grindersLoaded`.
- **`bean.js`** — `getBeans`, `setBeansCache`, `loadBeans(includeArchived?)`,
  `createBean`, `updateBean`, `deleteBean`. Emits `beansLoaded`.
- **`shot.js`** — per-shot-id detail cache (a `Map`, no single canonical list):
  `getCachedShotDetails(id)` (sync, cache-only), `getShotDetails(id)`
  (fetch-or-cache), `invalidateShotDetails`, `deleteShot`, `updateShot`,
  `updateShotMeta`. CRUD wrappers invalidate the cache entry on success.
- **`profile.js`** — three independent caches (visible / visible+hidden /
  deleted), each `null` until loaded, never cached empty (gateway can transiently
  return none right after wake): `getProfiles`, `getProfilesAll`,
  `getDeletedProfiles`, `invalidateProfiles`, `invalidateProfilesAll`,
  `invalidateDeletedProfiles`, `normalizeProfileRecord`, `loadProfiles(force?)`,
  `loadProfilesWithHidden(force?)`, `loadDeletedProfiles(force?)`.

### Workflow / recipe

- **`workflow.js`** — recipe-store I/O + the gateway-payload builders:
  `loadRecipes`, `saveRecipes`, `makeRecipeId`, `workflowToGatewayPayload`
  (simple fallback builder), and `buildGatewayPayload(workflow, opts)` — the real
  push-time builder (opts.scaleConnected passed in). Selection state
  (`workflowItems`/`selectedWorkflowIndex`/`selectWorkflow`) intentionally stays
  in app.js (DOM-fused).

### Machine state

- **`machine.js`** — a **passive** value holder for the current machine state (NOT
  an auto-listener — app.js's `machineState` handler reads-then-writes it
  synchronously; see the file header for the load-order race this avoids):
  `getMachineState`, `setMachineState`, `isEspressoLikeState(state)`, and the
  Reaprime op guard `canExecuteOperation(operation, state?)` (+ its
  `ALLOWED_OPERATIONS` table).

### Pure transformations — `mapping.js` (owns **no state at all**)

Every function is a pure transform of its arguments; live app state is passed in
explicitly. This is the shared shot/workflow "domain model": `formatMmSs`,
`calcRatio`, `resolveProfileTemp`, `mapApiWorkflowToDisplay`, `mapShotToWorkflow`,
`normalizeWorkflowKeyPart`, `getWorkflowKey`, `normalizeShotData`,
`getShotDurationSeconds`, `buildShotDiffData`,
`buildWorkflowItemsFromShots(shotItems, ratingCache)`, `computeMaxRating`,
`findShotsForWorkflow(workflow, source)`.

---

## What deliberately stays in the skin (`packages/nsx/src/modules/app.js`)

Not everything belongs in core. Left in app.js on purpose because it is DOM-fused
with no clean seam (a second skin reimplements it in its own idiom):

- **`selectWorkflow()`** and workflow **selection state** — mixes DOM render +
  gateway push + persistence in one call.
- **Live shot session** (`liveShot`, the `liveShot` event handler,
  `startLiveShotSession`/`endLiveShotSession`) — real-time data accumulation
  interleaved with immediate chart-DOM updates; the app's most timing-sensitive
  path.
- All **rendering / modals / gestures**: profile picker & editor, bean / grinder /
  batch managers, shot review UI, number & field pickers, swipe gestures.

**Rule of thumb for "can X move to core?":** yes if X is a **pure data
transformation or business rule** (like `mapping.js` or `canExecuteOperation`);
no if X is **DOM-fused** or owns UI-shaped state. Not "is it shot-related" or "is
it big." When unsure, prefer leaving it until a concrete second-skin need appears.
