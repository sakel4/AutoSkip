//const buttonIds = ["skip-button:i", "skip-button:2"];
const defaultSettings = {
  enabled: true,
  notifications: false,
  skipDelay: 0
};

console.log("[Skip Extension] content script loaded");

console.log({
  chromeExists: typeof chrome !== "undefined",
  runtimeExists: typeof chrome?.runtime !== "undefined",
  sendMessageExists: typeof chrome?.runtime?.sendMessage !== "undefined",
  extensionId: chrome?.runtime?.id
});

let clickInProgress = false;
let lastClickTime = 0;

function showVideoNotification(message, duration = 1000) {
  const player = document.querySelector("#movie_player") ||
                 document.querySelector("#song-media-window")

  console.log("[Skip Extension] showVideoNotification", {
    message, duration
  });

  if (!player) {
    console.log("[Skip Extension] Player not found");
    return;
  }

  // Remove previous notification.
  document.querySelector("#yt-auto-skip-notification")?.remove();

  const playerRect = player.getBoundingClientRect();

  const notification = document.createElement("div");

  notification.id = "yt-auto-skip-notification";
  notification.textContent = message;

  notification.style.cssText = `
    position: fixed;

    top: ${playerRect.top + 20}px;
    left: ${playerRect.left + playerRect.width / 2}px;

    transform: translateX(-50%);

    padding: 10px 16px;

    background: rgba(20, 20, 20, 0.9);
    color: white;

    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 8px;

    font-family: Arial, sans-serif;
    font-size: 14px;
    font-weight: 500;

    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);

    z-index: 2147483647;

    pointer-events: none;

    opacity: 0;

    transition: opacity 150ms ease;
  `;

  document.body.appendChild(notification);

  requestAnimationFrame(() => {
    notification.style.opacity = "1";
  });

  setTimeout(() => {
    notification.style.opacity = "0";

    setTimeout(() => {
      notification.remove();
    }, 150);
  }, duration);
}

function findVisibleSkipButton() {
  const button = document.querySelector(".ytp-skip-ad-button") ||
                 document.querySelector(".ytp-ad-skip-button-modern");

  if (!button) {
    return null;
  }

  const style = getComputedStyle(button);
  const rect = button.getBoundingClientRect();

  const visible =
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    rect.width > 0 &&
    rect.height > 0;

  if (visible) {
    return button;
  }

  return null;
}

async function trySkipAd() {
  const settings = await chrome.storage.sync.get(defaultSettings);
  if (!settings.enabled) {
    return;
  }
  if (clickInProgress) {
    return;
  }
  // Prevent a MutationObserver storm from repeatedly clicking.
  if (Date.now() - lastClickTime < 1500) {
    return;
  }
  const button = findVisibleSkipButton();
  if (!button) {
    return;
  }
  console.log("[Skip Extension] Skip button detected", { button });

  // Lock immediately so the MutationObserver can't queue up duplicate
  // attempts while we wait out the configured delay.
  clickInProgress = true;
  lastClickTime = Date.now();

  const delay = Number(settings.skipDelay) || 0;

  try {
    if (delay > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));

      // The button may have disappeared or moved during the delay
      // (ad ended, layout shifted, etc.), so re-resolve it right
      // before clicking instead of reusing stale coordinates.
      const stillThere = findVisibleSkipButton();
      if (!stillThere) {
        return;
      }
    }

    const target = findVisibleSkipButton();
    if (!target) {
      return;
    }
    const rect = target.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    const response = await chrome.runtime.sendMessage({
      type: "CLICK_SKIP_BUTTON",
      x,
      y
    });
    console.log("[Skip Extension] Result:", response);
    if (response?.success && settings.notifications) {
      showVideoNotification("Ad skipped");
    }
  } catch (error) {
    console.error("[Skip Extension] Error:", error);
  } finally {
    clickInProgress = false;
  }
}

// Check immediately.
trySkipAd();

// Watch YouTube's dynamically changing DOM.
const observer = new MutationObserver(() => {
  trySkipAd();
});

observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: [
    "style",
    "class",
    "disabled"
  ]
});
