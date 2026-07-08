"use strict";
/**
 * NSXCore workflow domain — recipe-store I/O + gateway-payload builders.
 *
 * `workflowItems`/`selectedWorkflowIndex` (selection state) and
 * `selectWorkflow()` stay in app.js — that function mixes DOM rendering,
 * gateway push, and persistence in one call, and there's no clean way to
 * split it without breaking the "core has no DOM" invariant.
 *
 * buildGatewayPayload(workflow, opts) is the REAL push-time payload builder
 * (was app.js's _buildRecipeGatewayPayload). It now depends only on
 * NSXCore.loadProfiles() (profile domain, already extracted) and the
 * already-core steam/hotwater/flush selectors — the one remaining live-state
 * input (scale connection) is passed in via `opts.scaleConnected` rather than
 * read from an app.js global, so this domain stays app-state-free. It carries
 * its own small private copies of isUserOwnedProfile/extractFrames/
 * profileEditorGroupTemp (pure, ~15 lines total) instead of depending on
 * app.js's versions of those — avoids touching the ~10 other call sites in
 * app.js that still use them for profile-editor/picker display purposes.
 *
 * Registered on NSXCore:
 *   Commands: loadRecipes(), saveRecipes(recipes), makeRecipeId(),
 *             workflowToGatewayPayload(workflow) — simple fallback builder
 *             buildGatewayPayload(workflow, opts) — real push-time builder
 */
(function () {
  const NSXCore = window.NSXCore;
  if (!NSXCore) {
    console.error("[NSXCore.workflow] core.js must load before domains/workflow.js");
    return;
  }

  const RECIPE_NS  = "NSX";
  const RECIPE_KEY = "recipes";

  async function loadRecipes() {
    const { getStoreValue } = window.NSXApi || {};
    try {
      const data = await getStoreValue?.(RECIPE_NS, RECIPE_KEY);
      return Array.isArray(data) ? data : [];
    } catch {
      return [];
    }
  }

  async function saveRecipes(recipes) {
    const { setStoreValue } = window.NSXApi || {};
    try {
      await setStoreValue?.(RECIPE_NS, RECIPE_KEY, recipes);
    } catch (err) {
      console.warn("Recipes could not be saved:", err?.message);
    }
  }

  function makeRecipeId() {
    return `recipe-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  }

  // Fallback payload for contexts without a resolved profile/gateway workflow
  // (e.g. building a shot-diff comparison from a past shot's recipe fields).
  // The real push path uses app.js's _buildRecipeGatewayPayload instead.
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

  // Private copies of the pure profile-record helpers _buildRecipeGatewayPayload
  // needs — see file header for why these are duplicated rather than shared.
  function _isUserOwnedProfile(record) {
    if (record?.isDefault) return false;
    const src = String(record?.metadata?.source || "").trim().toLowerCase();
    return !src || src === "user";
  }

  function _extractFrames(profile) {
    const frames = profile?.steps ?? profile?.frames ?? [];
    return Array.isArray(frames) ? frames : [];
  }

  function _profileEditorGroupTemp(profile) {
    const directTemp = Number(profile?.groupTemp);
    if (Number.isFinite(directTemp) && directTemp > 0) return directTemp;
    const firstFrameTemp = _extractFrames(profile)
      .map((frame) => Number(frame?.temperature))
      .find((temperature) => Number.isFinite(temperature) && temperature > 0);
    return Number.isFinite(firstFrameTemp) ? firstFrameTemp : null;
  }

  // The real push-time payload builder (was app.js's _buildRecipeGatewayPayload).
  // opts.scaleConnected: current scale connection state (app.js tracks this
  // live from the gateway WS bridge; passed in rather than read from a global).
  async function buildGatewayPayload(workflow, opts = {}) {
    const scaleConnected = Boolean(opts.scaleConnected);
    const title = String(workflow?.profileTitle || "").trim();
    const storedProfileId = String(workflow?.selectedProfileId || "").trim();
    const expectedProfile = Boolean(storedProfileId || (title && title !== "—"));
    let profileObj = null;
    let profileId = null;

    const matchFrom = (records) => {
      const match =
        (storedProfileId && records.find(r => String(r.id || "") === storedProfileId)) ||
        (title && title !== "—" && (
          records.find(r => _isUserOwnedProfile(r) && String(r.profile?.title || "").trim() === title) ||
          records.find(r => String(r.profile?.title || "").trim() === title)
        ));
      if (!match) return false;
      // Prefer the user-owned copy with the same title and the highest version number.
      const matchTitle = String(match.profile?.title || "").trim();
      const userCopies = matchTitle
        ? records.filter(r => _isUserOwnedProfile(r) && String(r.profile?.title || "").trim() === matchTitle)
        : [];
      const bestUserCopy = userCopies.length
        ? userCopies.reduce((best, r) => (Number(r.profile?.version) || 0) > (Number(best.profile?.version) || 0) ? r : best)
        : null;
      const effective = bestUserCopy || match;
      profileObj = effective.profile;
      profileId = effective.id ?? null;
      return true;
    };

    if (expectedProfile) {
      // Resolve against the visible+hidden set: a recipe can legitimately reference a
      // profile that was later hidden, and for resolving a concrete id/title "hidden"
      // is irrelevant (only deleted profiles must be excluded). The visible-only cache
      // would return null for a hidden profile and refuse the push.
      try { matchFrom(await NSXCore.loadProfilesWithHidden()); } catch { /* fall through */ }
      // If the cache was empty/stale (e.g. right after wake), force a fresh load and retry once.
      if (!profileObj) {
        try { matchFrom(await NSXCore.loadProfilesWithHidden(true)); } catch { /* fall through */ }
      }
      // Refuse to push a frameless profile — it would start the shot then immediately
      // stop it (and the gateway records nothing). Signal failure to the caller instead.
      if (!profileObj) return null;
    }

    let resolvedProfile;
    if (profileObj) {
      const desiredTemp = Number(workflow.groupTemp);
      const baseline = _profileEditorGroupTemp(profileObj);
      const delta = Number.isFinite(desiredTemp) && desiredTemp > 0 && Number.isFinite(baseline) && baseline > 0
        ? desiredTemp - baseline
        : 0;
      const stepsKey = Array.isArray(profileObj.steps) ? "steps" : "frames";
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
      .map(v => String(v || "").trim())
      .filter(v => v && v !== "—")
      .join(" · ") || "—";
    const payload = {
      name: workflowName,
      profile: resolvedProfile,
      profileId,
      context: {
        coffeeRoaster: workflow.coffeeRoaster || "—",
        coffeeName: workflow.coffeeName || "—",
        grinderModel: workflow.grinderModel || "—",
        grinderSetting: workflow.grinderSetting || "—",
        targetDoseWeight: Number(workflow.targetDoseWeight || 0),
        targetYield: Number(workflow.targetYield || 0),
        ...(workflow.grinderId ? { grinderId: workflow.grinderId } : {}),
        ...(workflow.beanBatchId ? { beanBatchId: workflow.beanBatchId } : {}),
        extras: tags.length > 0 ? { tags } : null,
      },
      // Bundle the machine-function settings into the same atomic workflow update so the
      // gateway applies them in ONE PUT (instead of 4 racing PUTs that get "Queue Cancelled").
      steamSettings: { targetTemperature: NSXCore.isSteamEnabled() ? NSXCore.getSteamTemp() : 0, flow: NSXCore.isSteamEnabled() ? NSXCore.getSteamFlow() : 0, duration: NSXCore.getSteamDuration() },
      hotWaterData: { targetTemperature: NSXCore.getHotwaterTemp(), volume: NSXCore.getHotwaterVolume() },
      rinseData: { flow: NSXCore.getFlushFlow(), duration: NSXCore.getFlushDuration() },
    };

    workflow._resolvedPayload = payload;
    return payload;
  }

  NSXCore.register({
    loadRecipes,
    saveRecipes,
    makeRecipeId,
    workflowToGatewayPayload,
    buildGatewayPayload,
  });
})();
