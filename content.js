(() => {
  "use strict";

  // --- Constants -------------------------------------------------------------

  // Kept in sync with the copy in youtube-bridge.js. Chrome injects a script
  // file only once per frame, so the two worlds can't share a helper file.
  const SKIP_BUTTON_SELECTORS = [
    "button.ytp-skip-ad-button",
    "button.ytp-ad-skip-button",
    "button.ytp-ad-skip-button-modern",
    '[id^="skip-button:"]'
  ].join(",");

  const BRIDGE_EVENT = "__yt_auto_skip_request__";

  function resolveButton(element) {
    if (!(element instanceof Element)) return null;
    // Handles dynamic YouTube wrappers such as id="skip-button:2".
    return element instanceof HTMLButtonElement ? element : element.querySelector("button");
  }

  function isUsableButton(button) {
    if (!(button instanceof HTMLButtonElement) || !button.isConnected) return false;
    if (button.disabled || button.getAttribute("aria-disabled") === "true") return false;
    if (button.hidden || button.getAttribute("aria-hidden") === "true") return false;

    const style = getComputedStyle(button);
    if (style.display === "none" || style.visibility === "hidden") return false;

    return button.getClientRects().length > 0;
  }

  function findSkipButton() {
    const seen = new Set();

    for (const candidate of document.querySelectorAll(SKIP_BUTTON_SELECTORS)) {
      const button = resolveButton(candidate);
      if (!button || seen.has(button)) continue;

      seen.add(button);
      if (isUsableButton(button)) return button;
    }

    return null;
  }
  const RETRY_DELAY_MS = 750;
  const MAX_REQUESTS_PER_BUTTON = 4;

  const defaultSettings = {
    enabled: true,
    notifications: false,
    skipDelay: 0
  };

  let settings = { ...defaultSettings };
  let pendingTimer = null;
  let scanQueued = false;
  let requestCounts = new WeakMap();

  // --- Storage -----------------------------------------------------------

  // `browser` only exists in Firefox (or with a polyfill); Chrome/Edge/Brave
  // expose the same-shaped API as `chrome`. Resolve whichever is present once.
  function getStorageApi() {
    if (typeof browser !== "undefined" && browser.storage?.sync) return browser.storage;
    if (typeof chrome !== "undefined" && chrome.storage?.sync) return chrome.storage;
    return null;
  }

  const storageApi = getStorageApi();

  function isValidDelay(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0;
  }

  function normalizeSettings(values = {}) {
    return {
      enabled: typeof values.enabled === "boolean" ? values.enabled : defaultSettings.enabled,
      notifications:
        typeof values.notifications === "boolean"
          ? values.notifications
          : defaultSettings.notifications,
      skipDelay: isValidDelay(values.skipDelay) ? values.skipDelay : defaultSettings.skipDelay
    };
  }

  async function loadSettings() {
    if (!storageApi) {
      console.warn("[YT Auto Skip] storage API is unavailable. Using defaults.");
      settings = { ...defaultSettings };
      return;
    }

    try {
      // The popup writes to storage.sync, so both browser types read from the same area.
      const stored = await storageApi.sync.get(defaultSettings);
      settings = normalizeSettings(stored);
    } catch (error) {
      console.warn("[YT Auto Skip] Failed to load settings. Using defaults.", error);
      settings = { ...defaultSettings };
    }
  }

  function installStorageListener() {
    if (!storageApi?.onChanged) return;

    storageApi.onChanged.addListener((changes, areaName) => {
      if (areaName !== "sync") return;

      let rescanRequired = false;

      if ("enabled" in changes) {
        settings.enabled =
          typeof changes.enabled.newValue === "boolean"
            ? changes.enabled.newValue
            : defaultSettings.enabled;

        if (!settings.enabled) {
          cancelPendingSkip();
          requestCounts = new WeakMap();
        } else {
          rescanRequired = true;
        }
      }

      if ("notifications" in changes) {
        settings.notifications =
          typeof changes.notifications.newValue === "boolean"
            ? changes.notifications.newValue
            : defaultSettings.notifications;
      }

      if ("skipDelay" in changes) {
        settings.skipDelay = isValidDelay(changes.skipDelay.newValue)
          ? changes.skipDelay.newValue
          : defaultSettings.skipDelay;

        // If a skip countdown is already active, restart it with the new delay.
        cancelPendingSkip();
        rescanRequired = true;
      }

      if (rescanRequired && settings.enabled) queueScan();
    });
  }

  // --- Optional notification ------------------------------------------------

  const NOTIFICATION_DURATION_MS = 1000;
  const NOTIFICATION_FADE_MS = 150;

  function showNotification(message) {
    if (!settings.notifications) return;

    // YouTube player, or the YouTube Music player.
    const player =
      document.querySelector("#movie_player") || document.querySelector("#song-media-window");

    document.getElementById("__yt_auto_skip_notification__")?.remove();

    const notification = document.createElement("div");
    notification.id = "__yt_auto_skip_notification__";
    notification.textContent = message;

    // Inline styles so this doesn't require an additional CSS file.
    Object.assign(notification.style, {
      // Inside the player so it stays over the video, including in fullscreen,
      // where elements outside the fullscreen player aren't rendered.
      position: player ? "absolute" : "fixed",
      top: "20px",
      left: "50%",
      transform: "translateX(-50%)",
      zIndex: "2147483647",
      padding: "10px 16px",
      background: "rgba(20, 20, 20, 0.9)",
      color: "#fff",
      border: "1px solid rgba(255, 255, 255, 0.15)",
      borderRadius: "8px",
      fontFamily: "Arial, sans-serif",
      fontSize: "14px",
      fontWeight: "500",
      lineHeight: "1.4",
      boxShadow: "0 4px 12px rgba(0, 0, 0, 0.35)",
      pointerEvents: "none",
      opacity: "0",
      transition: `opacity ${NOTIFICATION_FADE_MS}ms ease`
    });

    (player || document.body || document.documentElement).appendChild(notification);

    // Flush the initial opacity so the change below transitions. Avoids
    // requestAnimationFrame, which is paused while the tab isn't rendering.
    void notification.offsetWidth;
    notification.style.opacity = "1";

    setTimeout(() => {
      notification.style.opacity = "0";
      setTimeout(() => notification.remove(), NOTIFICATION_FADE_MS);
    }, NOTIFICATION_DURATION_MS);
  }

  // --- Bridge request ----------------------------------------------------

  function requestBridgeSkip(button) {
    if (!settings.enabled || !button?.isConnected) return;

    const requestCount = requestCounts.get(button) ?? 0;
    if (requestCount >= MAX_REQUESTS_PER_BUTTON) return;

    requestCounts.set(button, requestCount + 1);

    window.dispatchEvent(new Event(BRIDGE_EVENT));
    // Only notify once per ad, not on every retry.
    if (requestCount === 0) showNotification("Ad skipped");

    // YouTube may leave the button in the DOM briefly after the bridge
    // request. If it's still the same button, retry a limited number of times.
    setTimeout(() => {
      if (!settings.enabled) return;
      if (findSkipButton() === button) queueScan();
    }, RETRY_DELAY_MS);
  }

  // --- Scheduling ----------------------------------------------------------

  function cancelPendingSkip() {
    if (pendingTimer !== null) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
  }

  function scan() {
    if (!settings.enabled) {
      cancelPendingSkip();
      return;
    }

    const button = findSkipButton();

    if (!button) {
      cancelPendingSkip();
      // Previous ad has disappeared - reset tracking for the next one.
      requestCounts = new WeakMap();
      return;
    }

    // Already waiting for this detection cycle.
    if (pendingTimer !== null) return;

    const requestCount = requestCounts.get(button) ?? 0;
    if (requestCount >= MAX_REQUESTS_PER_BUTTON) return;

    const delay = Math.max(0, Number(settings.skipDelay) || 0);

    // Even with delay === 0, setTimeout ensures the request happens after
    // this mutation cycle.
    pendingTimer = setTimeout(() => {
      pendingTimer = null;
      if (!settings.enabled) return;

      // YouTube changes its DOM frequently - re-find the current button
      // after the configured delay.
      const currentButton = findSkipButton();
      if (currentButton) requestBridgeSkip(currentButton);
    }, delay);
  }

  function queueScan() {
    if (scanQueued) return;

    scanQueued = true;
    queueMicrotask(() => {
      scanQueued = false;
      scan();
    });
  }

  // --- DOM observer ----------------------------------------------------------

  function startObserver() {
    new MutationObserver(() => {
      if (settings.enabled) queueScan();
    }).observe(document, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["id", "class", "style", "hidden", "disabled", "aria-hidden", "aria-disabled"]
    });
  }

  // --- YouTube SPA navigation -------------------------------------------------

  window.addEventListener(
    "yt-navigate-start",
    () => {
      cancelPendingSkip();
      requestCounts = new WeakMap();
    },
    true
  );

  window.addEventListener(
    "yt-navigate-finish",
    () => {
      if (settings.enabled) queueScan();
    },
    true
  );

  // --- Initialization ----------------------------------------------------

  async function initialize() {
    // Load settings before observing, so a disabled extension or a configured
    // delay is respected from the very first skip button.
    await loadSettings();
    installStorageListener();
    startObserver();

    if (settings.enabled) queueScan();
  }

  initialize().catch(error => {
    console.error("[YT Auto Skip] Initialization failed:", error);
    settings = { ...defaultSettings };
    startObserver();
    if (settings.enabled) queueScan();
  });
})();
