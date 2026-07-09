"use strict";
/**
 * NSXCore profile domain — headless caches + fetch/normalize for profiles.
 *
 * Owns three independent caches (mirrors the three distinct gateway views):
 *   _cache        — visible (non-hidden) profiles
 *   _cacheAll     — visible + hidden profiles
 *   _deletedCache — trashed profiles
 * Each cache is `null` until first loaded (never cached as an empty array —
 * the gateway can transiently return no profiles right after wake, and
 * caching [] would persist that broken state).
 *
 * The skin layer (profile picker/editor UI, ~9000 lines of app.js) owns all
 * filtering, search, rendering, and the pure per-record helpers
 * (_isUserOwnedProfile, _extractFrames, _profileEditorGroupTemp, etc.) —
 * those have no shared mutable state, so there's no correctness reason to
 * move them; only the caches themselves (and normalizeProfileRecord, which
 * both the loaders and several app.js call sites need) live here.
 *
 * Registered on NSXCore:
 *   Selectors: getProfiles(), getProfilesAll(), getDeletedProfiles()
 *              — sync, cache-only reads (null if not yet loaded)
 *   Commands:  loadProfiles(force?), loadProfilesWithHidden(force?),
 *              loadDeletedProfiles(force?)
 *              invalidateProfiles(), invalidateProfilesAll(),
 *              invalidateDeletedProfiles()
 *              normalizeProfileRecord(raw)
 */
(function () {
  const NSXCore = window.NSXCore;
  if (!NSXCore) {
    console.error("[NSXCore.profile] core.js must load before domains/profile.js");
    return;
  }

  let _cache = null;
  let _cacheAll = null;
  let _deletedCache = null;

  // Last raw payload returned by the ETag-backed fetchers. On a 304 the fetcher
  // hands back the same reference, so we can keep the normalized _cache stable
  // (same array reference) instead of rebuilding it — lets the skin detect
  // "unchanged" via `getProfiles() === before` and skip re-rendering.
  let _rawProfiles = null;
  let _rawProfilesAll = null;

  function getProfiles()        { return _cache; }
  function getProfilesAll()     { return _cacheAll; }
  function getDeletedProfiles() { return _deletedCache; }

  function invalidateProfiles()        { _cache = null; }
  function invalidateProfilesAll()     { _cacheAll = null; }
  function invalidateDeletedProfiles() { _deletedCache = null; }

  function normalizeProfileRecord(raw) {
    if (!raw || typeof raw !== "object") return null;
    if (raw.profile && typeof raw.profile === "object") return raw;
    const profile = raw.steps || raw.frames || raw.title ? raw : null;
    if (!profile) return null;
    return {
      id: raw.id || null,
      profile,
      metadata: raw.metadata || null,
      isDefault: raw.isDefault === true,
    };
  }

  async function loadProfiles(force = false) {
    const { fetchProfiles } = window.NSXApi || {};
    if (typeof fetchProfiles !== "function") return [];
    if (_cache?.length && !force) return _cache;
    const data = await fetchProfiles();
    // 304 → same payload reference → nothing changed, keep the existing cache.
    if (data && data === _rawProfiles && _cache?.length) return _cache;
    _rawProfiles = data;
    const list = Array.isArray(data) ? data : (data?.items ?? data?.records ?? []);
    const records = list.map(normalizeProfileRecord).filter(Boolean).filter(r => r.profile);
    // Never cache an empty result: the gateway can transiently return no profiles
    // (e.g. just after wake while it re-initializes). Caching [] would persist a
    // broken state — every recipe push would then send a frameless profile.
    if (records.length) _cache = records;
    return records;
  }

  async function loadProfilesWithHidden(force = false) {
    const { fetchProfilesIncludingHidden } = window.NSXApi || {};
    if (typeof fetchProfilesIncludingHidden !== "function") return [];
    if (_cacheAll?.length && !force) return _cacheAll;
    const data = await fetchProfilesIncludingHidden();
    if (data && data === _rawProfilesAll && _cacheAll?.length) return _cacheAll;
    _rawProfilesAll = data;
    const list = Array.isArray(data) ? data : (data?.items ?? data?.records ?? []);
    const records = list.map(normalizeProfileRecord).filter(Boolean).filter(r => r.profile);
    if (records.length) _cacheAll = records;
    return records;
  }

  async function loadDeletedProfiles(force = false) {
    const { fetchDeletedProfiles } = window.NSXApi || {};
    if (typeof fetchDeletedProfiles !== "function") return [];
    if (_deletedCache && !force) return _deletedCache;
    const data = await fetchDeletedProfiles();
    const list = Array.isArray(data) ? data : (data?.items ?? data?.records ?? []);
    _deletedCache = list.map(normalizeProfileRecord).filter(Boolean).filter(r => r.profile);
    return _deletedCache;
  }

  NSXCore.register({
    getProfiles,
    getProfilesAll,
    getDeletedProfiles,
    invalidateProfiles,
    invalidateProfilesAll,
    invalidateDeletedProfiles,
    normalizeProfileRecord,
    loadProfiles,
    loadProfilesWithHidden,
    loadDeletedProfiles,
  });
})();
