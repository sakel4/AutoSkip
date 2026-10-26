(() => {
  "use strict";

  // --- Constants -------------------------------------------------------------

  const SKIP_BUTTON_SELECTORS = [
    "button.ytp-skip-ad-button",
    "button.ytp-ad-skip-button",
    "button.ytp-ad-skip-button-modern",
    '[id^="skip-button:"]'
  ].join(",");

  const BRIDGE_EVENT = "__yt_auto_skip_request__";
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
    if (typeof browser !== "undefined" && browser.storage?.local) return browser.storage;
    if (typeof chrome !== "undefined" && chrome.storage?.local) return chrome.storage;
    return null;
  }

  const storageApi = getStorageApi();

  function hasStorageAPI() {
    return storageApi !== null;
  }

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
    if (!hasStorageAPI()) {
      console.warn("[YT Auto Skip] browser.storage is unavailable. Using defaults.");
      settings = { ...defaultSettings };
      return;
    }

    try {
      const stored = await browser.storage.local.get(defaultSettings);
      console.log("[YT Auto Skip - In func] Stored settings:", stored);

      settings = normalizeSettings(stored);
      console.debug("[YT Auto Skip - In func] Settings loaded:", settings);
    } catch (error) {
      console.warn("[YT Auto Skip] Failed to load settings. Using defaults.", error);
      settings = { ...defaultSettings };
    }
  }

  function installStorageListener() {
    if (typeof browser === "undefined" || !browser.storage?.onChanged) return;

    browser.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;

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

      console.debug("[YT Auto Skip] Settings changed:", settings);

      if (rescanRequired && settings.enabled) queueScan();
    });
  }

  // --- Optional notification ------------------------------------------------

  function showNotification(message) {
    if (!settings.notifications) return;

    document.getElementById("__yt_auto_skip_notification__")?.remove();

    const notification = document.createElement("div");
    notification.id = "__yt_auto_skip_notification__";
    notification.textContent = message;

    // Inline styles so this doesn't require an additional CSS file.
    Object.assign(notification.style, {
      position: "fixed",
      top: "16px",
      right: "16px",
      zIndex: "2147483647",
      padding: "10px 14px",
      background: "rgba(20, 20, 20, 0.92)",
      color: "#fff",
      fontFamily: "Arial, sans-serif",
      fontSize: "13px",
      lineHeight: "1.4",
      borderRadius: "6px",
      boxShadow: "0 2px 10px rgba(0, 0, 0, 0.35)",
      pointerEvents: "none"
    });

    (document.body || document.documentElement).appendChild(notification);
    setTimeout(() => notification.remove(), 1800);
  }

  // --- Skip button detection -----------------------------------------------

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

  // --- Bridge request ----------------------------------------------------

  function requestBridgeSkip(button) {
    if (!settings.enabled || !button?.isConnected) return;

    const requestCount = requestCounts.get(button) ?? 0;
    if (requestCount >= MAX_REQUESTS_PER_BUTTON) return;

    requestCounts.set(button, requestCount + 1);
    console.debug("[YT Auto Skip] Sending skip request.");

    window.dispatchEvent(new Event(BRIDGE_EVENT));
    showNotification("Skipping YouTube ad");

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
    loadSettings();

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
    console.debug(`[YT Auto Skip] Skip button found. Delay: ${delay}ms`);

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

  new MutationObserver(() => {
    if (settings.enabled) queueScan();
  }).observe(document, {
    subtree: true,
    childList: true,
    attributes: true,
    attributeFilter: ["id", "class", "style", "hidden", "disabled", "aria-hidden", "aria-disabled"]
  });

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
    console.debug("[YT Auto Skip] Initializing...");
    console.debug("[YT Auto Skip] Default settings, before load:", defaultSettings);

    await loadSettings();
    console.log("[YT Auto Skip] Settings after load:", settings);

    installStorageListener();
    console.debug("[YT Auto Skip] Initialized:", settings);

    if (settings.enabled) queueScan();
  }

  initialize().catch(error => {
    console.error("[YT Auto Skip] Initialization failed:", error);
    settings = { ...defaultSettings };
    if (settings.enabled) queueScan();
  });
})();
