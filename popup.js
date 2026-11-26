const defaults = {
  enabled: true,
  notifications: false,
  skipDelay: 0,
  // Same as --accent and --bg in popup.css.
  accentColor: "#ff3b30",
  baseColor: "#0f1115"
};


const enabled = document.getElementById("enabled");
const notifications = document.getElementById("notifications");
const skipDelay = document.getElementById("skipDelay");
const skipDelayValue = document.getElementById("skipDelayValue");
const accentColor = document.getElementById("accentColor");
const baseColor = document.getElementById("baseColor");
// Each picker's id is its settings key.
const colorInputs = [accentColor, baseColor];


async function loadSettings() {
  const settings = await chrome.storage.sync.get(defaults);

  enabled.checked = settings.enabled;
  notifications.checked = settings.notifications;
  skipDelay.value = settings.skipDelay;
  updateDelayDisplay();
  showColors(settings);
  cacheColors();
}

function showColors(colors) {
  // Storage can hold anything; only a #rrggbb colour is used.
  for (const input of colorInputs) {
    const value = colors?.[input.id];
    input.value = /^#[0-9a-f]{6}$/i.test(value) ? value : defaults[input.id];
    hexField(input).value = input.value;
  }
  applyColors();
}

// The text field next to each picker, for typing or pasting a hex code.
function hexField(input) {
  return document.getElementById(`${input.id}Hex`);
}

// "#FF3B30", "ff3b30", " #f3b " -> "#ff3b30" / "#ff33bb"; anything else -> null.
function parseHex(text) {
  const hex = text.trim().replace(/^#/, "").toLowerCase();
  if (/^[0-9a-f]{3}$/.test(hex)) return "#" + [...hex].map(c => c + c).join("");
  return /^[0-9a-f]{6}$/.test(hex) ? "#" + hex : null;
}

// storage.sync loads after the popup is first drawn, so the colours are also
// kept in localStorage, which reads instantly. Without it every opening flashes
// the default colours.
function cacheColors() {
  localStorage.setItem("colors", JSON.stringify({
    accentColor: accentColor.value,
    baseColor: baseColor.value
  }));
}

function showCachedColors() {
  try {
    showColors(JSON.parse(localStorage.getItem("colors")));
  } catch {
    showColors({});
  }
}

async function saveSettings() {
  await chrome.storage.sync.set({
    enabled: enabled.checked,
    notifications: notifications.checked,
    skipDelay: Number(skipDelay.value),
    accentColor: accentColor.value,
    baseColor: baseColor.value
  });
  cacheColors();
}

// Perceived brightness of a #rrggbb colour, from 0 (black) to 1 (white).
function brightness(hex) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function applyColors() {
  const root = document.documentElement.style;
  root.setProperty("--accent", accentColor.value);
  root.setProperty("--bg", baseColor.value);

  // Keep text readable: dark text on a light base, light text on a dark one.
  const lightBase = brightness(baseColor.value) > 0.6;
  root.setProperty("--text", lightBase ? "#15171c" : "#f5f7fa");
  root.setProperty("--text-muted", lightBase ? "#5b616d" : "#9299a6");
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

// Preview while picking, save once picked: storage.sync limits writes per minute.
for (const input of colorInputs) {
  const hex = hexField(input);

  input.addEventListener("input", () => {
    hex.value = input.value;
    applyColors();
  });
  input.addEventListener("change", saveSettings);

  // Typing or pasting a valid code previews it straight away.
  hex.addEventListener("input", () => {
    const color = parseHex(hex.value);
    if (!color) return;
    input.value = color;
    applyColors();
  });
  // Enter or leaving the field saves the last valid colour and tidies the text,
  // so what the field shows is always what is saved.
  hex.addEventListener("change", () => {
    input.value = parseHex(hex.value) ?? input.value;
    hex.value = input.value;
    applyColors();
    saveSettings();
  });

  document.getElementById(`reset-${input.id}`).addEventListener("click", () => {
    input.value = defaults[input.id];
    hex.value = input.value;
    applyColors();
    saveSettings();
  });
}

showCachedColors();
loadSettings();
