# NSX — Claude Code Guide

## What This Project Is

NSX is a UI skin for the [Decent DE1](https://decentespresso.com/) espresso machine, built on top of the **Decent.app** gateway. It runs as a single-page web app (vanilla JS, no build step at runtime) served locally to the machine's web interface. The repo is an npm-workspaces monorepo (`packages/*`), but npm is only used for monorepo management — the NSX skin itself has no build step.

## Tech Stack

- **Vanilla JS (ES6+)** — no frameworks, no bundler
- **HTML5 + CSS3** — single entry point: `index.html`
- **WebSocket** — real-time updates from the Decent gateway (`packages/core/src/api.js`)
- **uPlot** — charting library for shot graphs (bundled)
- **PWA** — manifest.json enables mobile web app install

## Project Structure

This repo is an **npm-workspaces monorepo** (`packages/*`). The shared, DOM-free
core lives in `packages/core`; each skin is its own package. NSX stays vanilla JS
with no build step — `index.html` loads the core via relative `../../core/src/`
paths in dev, and the release workflow flattens core into the ZIP at `core/`.

```
espresso-skins/                     # repo root (npm workspaces)
├── package.json                    # workspaces: ["packages/*"]
├── packages/
│   ├── core/                       # shared, DOM-FREE package
│   │   ├── package.json
│   │   └── src/
│   │       ├── config.js           # Constants
│   │       ├── api.js              # REST + WebSocket gateway communication
│   │       └── translations.js     # i18n strings (DE + others)
│   └── nsx/                         # NSX skin (vanilla JS, no build)
│       ├── package.json
│       ├── manifest.json           # PWA manifest (id: "NSX-skin")
│       └── src/
│           ├── index.html          # SPA shell — loads core (../../core/src) + nsx modules
│           ├── css/                # app.css, phone.css
│           ├── ui/                 # graphics/, screensaver/ images
│           └── modules/
│               ├── app.js          # Orchestrator — global state, event wiring, post-shot actions
│               ├── ui.js           # DOM rendering
│               ├── settings.js     # Settings panel logic
│               ├── router.js       # Client-side panel navigation
│               ├── screensaver.js  # Screensaver
│               ├── workflow.js     # Workflow stub (not loaded)
│               ├── history.js      # Shot history stub (not loaded)
│               └── liveshot.js     # Live shot data stub (not loaded)
└── .github/workflows/
    └── release-nsx.yml             # Per-skin release (tag: nsx-v*) — assembles a self-contained ZIP
```

> Function-index line numbers below refer to `packages/nsx/src/modules/app.js`.

## app.js Function Index

`app.js` (~11,200 lines) is the orchestrator. No section headers exist — use this table to navigate.

| Area | Key Functions | Lines |
|------|--------------|-------|
| **Dialogs / Formatters** | `showConfirm`, `showAlert`, `formatMmSs`, `formatShotDateShort` | 107–580 |
| **Machine state guards** | `canExecuteOperation`, `_isEspressoLikeState`, `updateMachineStateBanner` | 203–280 |
| **Workflow filters** | `getDisplayWorkflows`, `openFilterModal`, `buildFilterChips`, `updateFilterButtonState` | 284–385 |
| **History filters** | `_openHistoryFilterModal`, `_handleHistoryChipClick`, `_updateHistoryFilterBtn` | 390–480 |
| **Shot data helpers** | `normalizeShotData`, `getShotDetailsCached`, `getShotDurationSeconds`, `calcRatio`, `buildShotDiffData` | 486–830 |
| **Workflow ↔ shot mapping** | `mapApiWorkflowToDisplay`, `mapShotToWorkflow`, `getWorkflowKey`, `buildWorkflowItemsFromShots`, `findShotsForWorkflow` | 505–880 |
| **Recipe store** | `_loadRecipesFromStore`, `_saveRecipesToStore`, `_makeRecipeId` | 882–905 |
| **Gateway payload** | `workflowToGatewayPayload`, `_buildRecipeGatewayPayload`, `pushSelectedWorkflowToMachine`, `_pushCurrentSkinStateToMachine` | 920–1082 |
| **Workflow selection** | `selectWorkflow`, `plotWorkflowShot` | 1083–1245 |
| **Espresso fullscreen** | `openEspressoFullscreen`, `closeEspressoFullscreen`, `updateEspressoFullscreen`, `_updateReserveWidget` | 1246–1383 |
| **Live shot session** | `startLiveShotSession`, `endLiveShotSession`, `_runPostShotActions` (1469), `pollForNewShot` (1576) | 1384–1604 |
| **Steam session** | `startSteamSession`, `endSteamSession` | 1605–1658 |
| **Hot water session** | `startHotWaterSession`, `endHotWaterSession` | 1660–1683 |
| **Flush session** | `startFlushSession`, `endFlushSession` | 1685–1728 |
| **Water overlay** | `showNeedsWaterOverlay`, `hideNeedsWaterOverlay` | 1730–1740 |
| **App init** | `loadApiData`, `tick`, `signalUserPresence`, `setupPresenceTracking`, `setupDisplayControl` | 1742–1865 |
| **Machine/scale events** | WebSocket event handlers, `setMachineConnected`, `setScaleConnected` (imported from ui.js) | 1866–2200 |
| **Skin settings UI** | `_applyTheme`, `_applySkinBrightness`, `_applyScale`, `_renderScaleControls`, `_renderPresenceSettingsUI` | 2281–2550 |
| **Refill / viewport** | `applyRefillLevel`, `_setRealVh` | 3197–3290 |
| **Settings persistence** | `patchStoreSettings`, `scheduleStorePersist`, `migrateLegacyLocalSettingsToStore` | 3287–3390 |
| **Steam presets** | `loadSteamPresets`, `selectSteamPreset`, `_openSteamSettingsModal`, `_fetchAndShowLastSteam` | 3387–3795 |
| **Hot water presets** | `loadHotwaterPresets`, `selectHotwaterPreset`, `_openHotwaterSettingsModal` | 3796–3970 |
| **Flush presets** | `loadFlushPresets`, `selectFlushPreset`, `_openFlushSettingsModal` | 3971–4185 |
| **Gateway push helpers** | `push`, `debounced`, `pushSteamTemp/Flow/Duration`, `pushHotwater`, `pushFlush` | 4187–4215 |
| **Schedule** | `loadScheduleState`, `renderScheduleUI`, `syncScheduleToApi`, `applyScheduleState` | 4224–4545 |
| **Swipe gestures** | `getSwipeLayer`, `closeAllSwipes`, `getHistorySwipeLayer`, `closeAllHistorySwipes` | 4545–4695 |
| **History list** | `renderHistory`, `_loadMoreHistory`, `_filterShotsByFavAndRating`, `deleteWorkflowShots`, `_deleteHistoryShot` | 4694–4950 |
| **Scale-based weighing** | `_applySbwEnabled`, `_sbwCalibFactor`, `_applyDoseScale`, `_updateSbwWidget`, `_updateScaleIndicatorVisibility` | 4949–5220 |
| **Shot review** | `openShotReview`, `closeShotReview`, `_setShotReviewFav`, `_setShotReviewRating`, `_renderReviewTags` | 5221–5590 |
| **Profile picker** | `openProfilePickerModal`, `_renderProfilePickerList`, `_setProfilePickerMode`, `_ensureProfilesLoaded` | 5588–7596 |
| **Profile editor** | `openProfileEditorModal`, `_peditorSave`, `_peditorRenderFrames`, `_peditorBuildProfile`, `_profileSparkSvg` | 7596–8395 |
| **Workflow edit/create** | `openWorkflowEditModal`, `openWorkflowCreateModal`, `_syncProfileDisplay`, `_importFromVisualizer` | 8395–9040 |
| **Number / field pickers** | `openNumberPicker`, `closeNumberPicker`, `openFieldPicker`, `openSearchInputModal` | 9529–9905 |
| **Bean manager** | `openBeanManagerModal`, `_beanManagerRenderDetail`, `_beanManagerSaveField`, `_beanManagerLoad` | 9146–10935 |
| **Batch management** | `openBatchModal`, `loadAndRenderBatches`, `openBatchDatePickerModal` | 10018–10930 |
| **Grinder manager** | `renderGrinderTiles`, `loadAndRenderGrinders`, `openMuehlenModal`, `openGrinderDetailModal` | 10936–11182 |
| **Phone layout** | `_updatePhoneMachineCard`, `_selectPhoneTab`, `_applyPhoneLayout` | 11183–11207 |

---

## Key Conventions

- **Post-shot actions** go in `_runPostShotActions()` in `app.js`
- **Shot API**: only write `annotations`, not `metadata`/`shotNotes` (deprecated). The `extras` field merges at field level.
- **UI language**: German labels, vanilla JS DOM manipulation (no virtual DOM)
- **No build step**: edits to source files take effect immediately on reload

## How the App Starts

1. `index.html` loads all module scripts in order
2. `app.js` initializes last, wires up modules, opens WebSocket to gateway
3. `router.js` handles panel switching; `api.js` drives all live data

---

## Working With Claude on This Project

### Ground Rules

1. **Ask, don't assume.** If something is unclear, ask before writing a single line. Never make silent assumptions about intent, architecture, or requirements.

2. **Simplest solution first.** Always implement the simplest thing that could work. Do not add abstractions or flexibility that weren't explicitly requested.

3. **Don't touch unrelated code.** If a file or function is not directly part of the current task, do not modify it — even if it could be improved.

4. **Flag uncertainty explicitly.** If you are not confident about an approach or technical detail, say so before proceeding. Confidence without certainty causes more damage than admitting a gap.

5. **Suggest better approaches.** Always open to ideas on better ways to do things — don't hesitate to suggest an approach with longer-lasting impact over a tactical change.
