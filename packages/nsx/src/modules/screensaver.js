"use strict";

(() => {
  const {
    setDisplayBrightness,
    requestWakeLockOverride,
    releaseWakeLockOverride,
    initiateScaleConnect,
    disconnectScale,
  } = window.NSXApi || {};

  const SS_DEFAULT_IMAGES = [1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 13, 14, 15]
    .map(n => `ui/screensaver/Screen_saver_Decent_${n}.jpg`);

  // Custom backgrounds are device-local: they live in IndexedDB, not in the
  // gateway store, so a phone photo doesn't get base64'd into every device's
  // settings payload. Each device therefore has its own set.
  const SS_DB_NAME = "nsx";
  const SS_DB_STORE = "screensaver";
  const SS_DB_KEY = "images";
  const SS_MAX_IMAGES = 20;
  const SS_MAX_EDGE = 1600;      // downscale before storing — phone photos are huge
  const SS_JPEG_QUALITY = 0.82;

  let ssCustomImages = [];
  let ssCustomOnly = false;

  function ssOpenDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(SS_DB_NAME, 1);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(SS_DB_STORE)) req.result.createObjectStore(SS_DB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function ssDbRequest(mode, run) {
    return ssOpenDb().then(db => new Promise((resolve, reject) => {
      const req = run(db.transaction(SS_DB_STORE, mode).objectStore(SS_DB_STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }));
  }

  /** Read a picked file and re-encode it to a bounded JPEG data URL. */
  function ssFileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error);
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error("decode failed"));
        img.onload = () => {
          const scale = Math.min(1, SS_MAX_EDGE / Math.max(img.width, img.height));
          const canvas = document.createElement("canvas");
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL("image/jpeg", SS_JPEG_QUALITY));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  /** The rotation actually shown: custom-only, or the built-ins plus any custom. */
  function ssImages() {
    if (!ssCustomImages.length) return SS_DEFAULT_IMAGES;
    return ssCustomOnly ? ssCustomImages : SS_DEFAULT_IMAGES.concat(ssCustomImages);
  }

  async function loadCustomImages() {
    try {
      const stored = await ssDbRequest("readonly", s => s.get(SS_DB_KEY));
      ssCustomImages = Array.isArray(stored) ? stored : [];
    } catch {
      ssCustomImages = [];
    }
    return ssCustomImages;
  }

  async function ssPersistCustomImages() {
    await ssDbRequest("readwrite", s => s.put(ssCustomImages, SS_DB_KEY));
    if (ssActive) {
      ssImgIndex = 0;
      ssCrossfade(ssImages()[0]);
    }
  }

  /** Add picked files; returns the new total. Throws if storing fails. */
  async function addCustomImages(files) {
    const list = Array.from(files || []);
    if (!list.length) return ssCustomImages.length;
    const room = Math.max(0, SS_MAX_IMAGES - ssCustomImages.length);
    const urls = await Promise.all(list.slice(0, room).map(ssFileToDataUrl));
    ssCustomImages = ssCustomImages.concat(urls);
    await ssPersistCustomImages();
    return ssCustomImages.length;
  }

  async function removeCustomImage(index) {
    ssCustomImages = ssCustomImages.filter((_, i) => i !== index);
    await ssPersistCustomImages();
    return ssCustomImages.length;
  }

  async function clearCustomImages() {
    ssCustomImages = [];
    await ssPersistCustomImages();
  }

  let ssActive = false;
  let ssImgIndex = 0;
  let ssActiveLayer = "a";
  let ssClockTimer = null;
  let ssImageTimer = null;
  let ssSlideActive = false;
  let ssSlideX = 0;
  let ssSlideStartX = 0;
  let ssSlideStartPos = 0;
  let scalePowerMode = "displayOff";
  let ssEnabled = true;
  let ssDimEnabled = true;
  let ssDimLevel = 50;
  let ssWakeLockNormal = true;
  let ssWakeLockLocked = false;
  let ssRestoreBrightness = 100;

  let suppressSleepScreensaver = false;
  let suppressSleepScreensaverUntilWake = false;
  let lastMachineState = null;
  let ssUnlockCallback = null;
  const ssSheetAnimMs = 380;
  const ssSheetAnimEase = "cubic-bezier(0.32,0,0.67,0)";

  const ssEl = document.getElementById("screensaver");
  const ssBgA = document.getElementById("ss-bg-a");
  const ssBgB = document.getElementById("ss-bg-b");
  const ssTimeEl = document.getElementById("ss-time");
  const ssDateEl = document.getElementById("ss-date");
  const ssThumbEl = document.getElementById("ss-slide-thumb");
  const ssFillEl = document.getElementById("ss-slide-fill");
  const ssTrackEl = document.getElementById("ss-slide-track");
  const ssDimEl = document.getElementById("ss-dim");

  function ssUpdateClock() {
    const now = new Date();
    const locale = window.NSXI18n?.getLang?.() === "en" ? "en-US" : "de-DE";
    if (ssTimeEl) ssTimeEl.textContent = now.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
    if (ssDateEl) ssDateEl.textContent = now.toLocaleDateString(locale, { weekday: "long", day: "numeric", month: "long" });
  }

  function ssCrossfade(url) {
    const next = ssActiveLayer === "a" ? ssBgB : ssBgA;
    const curr = ssActiveLayer === "a" ? ssBgA : ssBgB;
    if (!next || !curr) return;
    next.style.backgroundImage = `url(${url})`;
    next.style.opacity = "1";
    curr.style.opacity = "0";
    ssActiveLayer = ssActiveLayer === "a" ? "b" : "a";
  }

  function applyDim(active) {
    if (!ssDimEl) return;
    const o = (active && ssDimEnabled) ? Math.min(0.9, Math.max(0, (100 - ssDimLevel) / 100)) : 0;
    ssDimEl.style.opacity = String(o);
  }

  let _wakeLockHeld = null; // null = unknown; only POST/DELETE when the desired state changes
  function syncWakeLock() {
    const wantLock = ssActive ? ssWakeLockLocked : ssWakeLockNormal;
    if (wantLock === _wakeLockHeld) return;       // dedupe: avoid redundant wakelock requests
    _wakeLockHeld = wantLock;
    const onErr = () => { _wakeLockHeld = null; }; // allow retry if the request failed
    if (wantLock) requestWakeLockOverride?.().catch(onErr);
    else releaseWakeLockOverride?.().catch(onErr);
  }

  // The gateway auto-releases a held wake-lock override when the ws/v1/display
  // connection that requested it closes (Reaprime best practice, prevents
  // orphaned locks from a disconnected skin). If that socket reconnects, the
  // gateway has already forgotten the override, but our dedup cache above
  // still thinks it's held — so a later syncWakeLock() call with an unchanged
  // desired state would silently no-op instead of re-asserting it. Call this
  // right after a display-WS reconnect (before syncWakeLock()) to force the
  // next call through.
  function invalidateWakeLock() {
    _wakeLockHeld = null;
  }

  function show(animateSlideReset = false, animateOverlay = false) {
    if (!ssEnabled || ssActive || !ssEl) return;
    ssActive = true;

    if (ssDimEnabled) setDisplayBrightness?.(ssDimLevel).catch(() => {});
    applyDim(true);
    syncWakeLock();
    if (scalePowerMode === "disconnect") disconnectScale?.();

    const images = ssImages();
    ssImgIndex = Math.floor(Math.random() * images.length);
    const initUrl = images[ssImgIndex];
    if (ssBgA) {
      ssBgA.style.backgroundImage = `url(${initUrl})`;
      ssBgA.style.opacity = "1";
    }
    if (ssBgB) {
      ssBgB.style.opacity = "0";
    }
    ssActiveLayer = "a";

    ssUpdateClock();
    ssSlideReset(animateSlideReset);

    if (animateOverlay) {
      ssEl.style.transition = "none";
      ssEl.style.transform = "translateY(-105%)";
      ssEl.style.opacity = "0";
      ssEl.hidden = false;
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!ssActive) return;
          ssEl.style.transition = `transform ${ssSheetAnimMs}ms ${ssSheetAnimEase}, opacity ${ssSheetAnimMs}ms ease`;
          ssEl.style.transform = "translateY(0)";
          ssEl.style.opacity = "1";
          setTimeout(() => {
            if (!ssActive) return;
            ssEl.style.transition = "";
            ssEl.style.transform = "";
            ssEl.style.opacity = "";
          }, ssSheetAnimMs + 30);
        });
      });
    } else {
      ssEl.style.transition = "";
      ssEl.style.transform = "";
      ssEl.style.opacity = "";
      ssEl.hidden = false;
    }

    ssClockTimer = setInterval(ssUpdateClock, 1000);
    ssImageTimer = setInterval(() => {
      const list = ssImages();
      ssImgIndex = (ssImgIndex + 1) % list.length;
      ssCrossfade(list[ssImgIndex]);
    }, 30000);
  }

  function hide(animate = true) {
    if (!ssActive || !ssEl) return;
    ssActive = false;
    clearInterval(ssClockTimer);
    clearInterval(ssImageTimer);

    setDisplayBrightness?.(ssRestoreBrightness).catch(() => {});
    applyDim(false);
    syncWakeLock();
    if (scalePowerMode === "disconnect") initiateScaleConnect?.().catch(() => {});
    ssUnlockCallback?.();

    if (animate) {
      ssEl.style.transition = `transform ${ssSheetAnimMs}ms ${ssSheetAnimEase}, opacity ${ssSheetAnimMs}ms ease`;
      ssEl.style.transform = "translateY(-105%)";
      ssEl.style.opacity = "0";
      setTimeout(() => {
        ssEl.hidden = true;
        ssEl.style.transition = "";
        ssEl.style.transform = "";
        ssEl.style.opacity = "";
      }, ssSheetAnimMs + 20);
    } else {
      ssEl.hidden = true;
    }
  }

  function ssSlideReset(animate) {
    const labelEl = ssTrackEl?.querySelector(".ss-slide-label");
    const dur = animate ? "0.35s" : "0s";
    if (ssThumbEl) {
      ssThumbEl.style.transition = `transform ${dur} cubic-bezier(0.34,1.56,0.64,1)`;
      ssThumbEl.style.transform = "translateX(0)";
    }
    if (ssFillEl) {
      ssFillEl.style.transition = `width ${dur} cubic-bezier(0.34,1.56,0.64,1)`;
      ssFillEl.style.width = "0";
    }
    if (labelEl) {
      labelEl.style.transition = `opacity ${animate ? "0.25s" : "0s"} ease`;
      labelEl.style.opacity = "";
    }
    ssSlideX = 0;
    setTimeout(() => {
      if (ssThumbEl) ssThumbEl.style.transition = "";
      if (ssFillEl) ssFillEl.style.transition = "";
      if (labelEl) labelEl.style.transition = "";
    }, animate ? 380 : 0);
  }

  function ssSlideApply(dx) {
    if (!ssTrackEl || !ssThumbEl) return;
    const thumbSize = ssThumbEl.offsetWidth || 52;
    const maxX = ssTrackEl.offsetWidth - thumbSize - 12;
    const clamped = Math.max(0, Math.min(maxX, dx));
    ssSlideX = clamped;
    ssThumbEl.style.transform = `translateX(${clamped}px)`;
    if (ssFillEl) ssFillEl.style.width = `${6 + clamped + thumbSize}px`;
    const labelEl = ssTrackEl.querySelector(".ss-slide-label");
    if (labelEl) labelEl.style.opacity = String(Math.max(0, 1 - (clamped / maxX) * 1.8));
  }

  function ssSlideStart(clientX) {
    if (!ssActive) return;
    ssSlideActive = true;
    ssSlideStartX = clientX;
    ssSlideStartPos = ssSlideX;
    if (ssThumbEl) ssThumbEl.style.transition = "none";
    if (ssFillEl) ssFillEl.style.transition = "none";
  }

  function ssSlideMove(clientX) {
    if (!ssSlideActive) return;
    ssSlideApply(ssSlideStartPos + (clientX - ssSlideStartX));
  }

  function ssSlideEnd() {
    if (!ssSlideActive) return;
    ssSlideActive = false;
    const thumbSize = ssThumbEl?.offsetWidth || 52;
    const maxX = (ssTrackEl?.offsetWidth || 0) - thumbSize - 12;
    const pct = maxX > 0 ? ssSlideX / maxX : 0;
    if (pct >= 0.82) {
      hide(true);
      setTimeout(() => ssSlideReset(false), 420);
    } else {
      ssSlideReset(true);
    }
  }

  function handleMachineState(state) {
    const prevState = lastMachineState;
    lastMachineState = state;

    if (state === "sleeping") {
      if (prevState === "sleeping") return;
      if (suppressSleepScreensaverUntilWake) return;
      if (suppressSleepScreensaver) {
        suppressSleepScreensaver = false;
        return;
      }
      show(false);
      return;
    }

    suppressSleepScreensaverUntilWake = false;
    if (prevState === "sleeping" || prevState === null) {
      syncWakeLock();
    }
  }

  function suppressForToggleSleep() {
    suppressSleepScreensaver = true;
    suppressSleepScreensaverUntilWake = true;
  }

  function clearSuppressions() {
    suppressSleepScreensaver = false;
    suppressSleepScreensaverUntilWake = false;
  }

  ssEl?.addEventListener("touchstart", e => ssSlideStart(e.touches[0].clientX), { passive: true });
  ssEl?.addEventListener("touchmove", e => ssSlideMove(e.touches[0].clientX), { passive: true });
  ssEl?.addEventListener("touchend", () => ssSlideEnd(), { passive: true });
  ssEl?.addEventListener("mousedown", e => ssSlideStart(e.clientX));
  window.addEventListener("mousemove", e => {
    if (ssSlideActive) ssSlideMove(e.clientX);
  });
  window.addEventListener("mouseup", () => {
    if (ssSlideActive) ssSlideEnd();
  });

  window.addEventListener("scale:status", () => {
    if (ssActive && scalePowerMode === "disconnect") {
      disconnectScale?.();
    }
  });

  window.NSXScreensaver = {
    show,
    hide,
    handleMachineState,
    suppressForToggleSleep,
    clearSuppressions,
    syncWakeLock,
    invalidateWakeLock,
    setScalePowerMode(mode) { scalePowerMode = mode || 'disabled'; },
    setEnabled(v) {
      ssEnabled = Boolean(v);
      if (!ssEnabled && ssActive) hide(false);
    },
    loadCustomImages,
    getCustomImages: () => ssCustomImages.slice(),
    addCustomImages,
    removeCustomImage,
    clearCustomImages,
    maxCustomImages: SS_MAX_IMAGES,
    setConfig(cfg = {}) {
      if (typeof cfg.customOnly === 'boolean') ssCustomOnly = cfg.customOnly;
      if (typeof cfg.dimEnabled === 'boolean') ssDimEnabled = cfg.dimEnabled;
      if (Number.isFinite(cfg.dimLevel)) ssDimLevel = cfg.dimLevel;
      if (typeof cfg.wakeLockNormal === 'boolean') ssWakeLockNormal = cfg.wakeLockNormal;
      if (typeof cfg.wakeLockLocked === 'boolean') ssWakeLockLocked = cfg.wakeLockLocked;
      if (Number.isFinite(cfg.restoreBrightness)) ssRestoreBrightness = cfg.restoreBrightness;
      applyDim(ssActive);
      syncWakeLock();
    },
    setUnlockCallback(fn) {
      ssUnlockCallback = typeof fn === 'function' ? fn : null;
    },
  };
})();
