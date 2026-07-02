"use strict";
/**
 * NSXCore mapping domain — pure shot/workflow data transformations.
 *
 * Unlike the other domains, this one owns no state at all: every function is
 * a pure transformation of its arguments, with no DOM and no app-state reads
 * (live app state like the current `shots` array or the rating cache is
 * passed in explicitly by the caller, same pattern as
 * buildGatewayPayload's opts.scaleConnected in workflow.js). A future skin
 * needs byte-identical shot normalization, workflow↔shot mapping, and
 * formatting — this is the shared "domain model" layer, as opposed to the
 * UI-rendering code that stays in each skin.
 *
 * Registered on NSXCore:
 *   formatMmSs(ms), calcRatio(dose, yield_), resolveProfileTemp(profile),
 *   mapApiWorkflowToDisplay(wf), mapShotToWorkflow(shot),
 *   normalizeWorkflowKeyPart(value), getWorkflowKey(workflow),
 *   normalizeShotData(shot), getShotDurationSeconds(fullShot),
 *   buildShotDiffData(currentShot, latestShot, currentDurationSec, latestDurationSec),
 *   buildWorkflowItemsFromShots(shotItems, ratingCache),
 *   findShotsForWorkflow(workflow, source)
 */
(function () {
  const NSXCore = window.NSXCore;
  if (!NSXCore) {
    console.error("[NSXCore.mapping] core.js must load before domains/mapping.js");
    return;
  }

  function formatMmSs(ms) {
    const totalSec = Math.max(0, Math.ceil(ms / 1000));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  function calcRatio(dose, yield_) {
    return dose > 0 ? `1:${(yield_ / dose).toFixed(1)}` : "—";
  }

  function resolveProfileTemp(prof) {
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
    const resolvedTemp = resolveProfileTemp(prof);
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
    const shotTemp = resolveProfileTemp(shotProf);
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

      if (machine.state.substate !== "preinfusion" && machine.state.substate !== "pouring") {
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
      substates.push(machine.state?.substate || "");

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

  function getShotDurationSeconds(fullShot) {
    const normalized = normalizeShotData(fullShot);
    if (!normalized?.elapsed?.length) return null;
    const last = normalized.elapsed[normalized.elapsed.length - 1];
    return Number.isFinite(last) ? Math.max(0, last) : null;
  }

  function buildShotDiffData(currentShot, latestShot, currentDurationSec, latestDurationSec) {
    const t = window.NSXI18n?.t || ((k) => k);
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
      rows.push({ label: t("recipe.grindSize"), value: `${current.grinderSetting || "—"}${grindDelta}` });
    }

    const currentDose = Number(current.targetDoseWeight || 0);
    const latestDose = Number(latest.targetDoseWeight || 0);
    if (Math.abs(currentDose - latestDose) > 0.0001) {
      const doseDelta = formatSigned(currentDose - latestDose, 1, "g");
      rows.push({ label: t("recipeEdit.dose"), value: `${currentDose.toFixed(1)}g (${doseDelta})` });
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
        label: t("recipe.beverage"),
        value: `${currentYield.toFixed(1)}g (${currentRatio}) (${yieldDelta}, ${ratioDelta})`,
      });
    }

    const hasCurrentDuration = Number.isFinite(currentDurationSec);
    const hasLatestDuration = Number.isFinite(latestDurationSec);
    if (hasCurrentDuration && (!hasLatestDuration || Math.abs(currentDurationSec - latestDurationSec) > 0.049)) {
      const durationDelta = hasLatestDuration
        ? formatSigned(currentDurationSec - latestDurationSec, 1, "s")
        : "--";
      rows.push({ label: t("recipe.duration"), value: `${currentDurationSec.toFixed(1)}s (${durationDelta})` });
    }

    return rows;
  }

  // ratingCache: optional Map<workflowKey, {max, count}> — the caller's
  // (app.js) authoritative per-recipe rating cache, consulted so recipe cards
  // show fetched ratings instead of the shot-list approximation once loaded.
  function buildWorkflowItemsFromShots(shotItems, ratingCache) {
    const grouped = new Map();

    for (const shot of shotItems) {
      const mapped = mapShotToWorkflow(shot);
      const key = getWorkflowKey(mapped);

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
        const cached = ratingCache?.get(getWorkflowKey(item));
        item.maxRating = cached ? cached.max : (ratingMax ?? null);
        item.ratedCount = cached ? cached.count : (ratingCount || 0);
        return item;
      });
  }

  // source: the shot list to search (caller's live `shots` or a history
  // source array) — passed explicitly since this domain owns no shot state.
  function findShotsForWorkflow(workflow, source) {
    if (!workflow || !Array.isArray(source) || source.length === 0) {
      return [];
    }

    const key = getWorkflowKey(workflow);

    return source
      .filter((shot) => getWorkflowKey(mapShotToWorkflow(shot)) === key)
      .sort((a, b) => {
        const tsA = Date.parse(a?.timestamp || 0);
        const tsB = Date.parse(b?.timestamp || 0);
        return (Number.isFinite(tsB) ? tsB : 0) - (Number.isFinite(tsA) ? tsA : 0);
      });
  }

  NSXCore.register({
    formatMmSs,
    calcRatio,
    resolveProfileTemp,
    mapApiWorkflowToDisplay,
    mapShotToWorkflow,
    normalizeWorkflowKeyPart,
    getWorkflowKey,
    normalizeShotData,
    getShotDurationSeconds,
    buildShotDiffData,
    buildWorkflowItemsFromShots,
    findShotsForWorkflow,
  });
})();
