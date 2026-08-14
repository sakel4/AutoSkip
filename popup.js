const defaults = {
  enabled: true,
  notifications: false,
  skipDelay: 0
};


const enabled = document.getElementById("enabled");
const notifications = document.getElementById("notifications");
const skipDelayValue = document.getElementById("skipDelayValue");


async function loadSettings() {
  const settings = await chrome.storage.sync.get(defaults);

  enabled.checked = settings.enabled;
  notifications.checked = settings.notifications;
  skipDelay.value = settings.skipDelay;
  updateDelayDisplay();
}

async function saveSettings() {
  await chrome.storage.sync.set({
    enabled: enabled.checked,
    notifications: notifications.checked,
    skipDelay: Number(skipDelay.value)
  });
}

function updateDelayDisplay() {
  const value = Number(skipDelay.value);
  const min = Number(skipDelay.min);
  const max = Number(skipDelay.max);

  if (value === 0) {
    skipDelayValue.textContent = "Instant";
  } else {
    const seconds = value / 1000;

    skipDelayValue.textContent =
      Number.isInteger(seconds)
        ? `${seconds}s`
        : `${seconds.toFixed(2).replace(/0$/, "")}s`;
  }

  const progress =
    ((value - min) / (max - min)) * 100;

  skipDelay.style.setProperty(
    "--progress",
    `${progress}%`
  );
}

enabled.addEventListener("change", saveSettings);
notifications.addEventListener("change", saveSettings);
skipDelay.addEventListener("input", () => {
  updateDelayDisplay();
});

skipDelay.addEventListener("change", saveSettings);

loadSettings();
