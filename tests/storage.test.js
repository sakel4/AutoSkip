// Run with: node --test tests/
// Settings storage, from both sides: the popup writes storage.sync, content.js reads it.
// Chrome and Firefox both run this through the same promise-based `chrome.storage`
// API (MV3), so one fake covers both browsers.
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { read, flush, fakeChrome, loadContent } = require("./fake-page");

const popupSource = read("popup.js");

// --- content.js ------------------------------------------------------------

test("content: empty storage uses the defaults (enabled, instant skip)", async t => {
  const page = await loadContent(t, {});
  page.tick(1);
  assert.equal(page.requests, 1);
});

test("content: a stored 'disabled' is respected from the first button", async t => {
  const page = await loadContent(t, { enabled: false });
  page.tick(5000);
  assert.equal(page.requests, 0);
});

test("content: a stored skip delay is waited out", async t => {
  const page = await loadContent(t, { skipDelay: 500 });
  page.tick(499);
  assert.equal(page.requests, 0);
  page.tick(1);
  assert.equal(page.requests, 1);
});

test("content: invalid stored values fall back to the defaults", async t => {
  const page = await loadContent(t, { enabled: "yes", notifications: "yes", skipDelay: -5 });
  page.tick(1);
  assert.equal(page.requests, 1);
});

test("content: a failing storage read falls back to the defaults", async t => {
  const page = await loadContent(t, { enabled: false }, { failGet: true });
  page.tick(1);
  assert.equal(page.requests, 1);
});

test("content: disabling during a countdown cancels the skip", async t => {
  const page = await loadContent(t, { skipDelay: 500 });
  page.tick(200);
  await page.change({ enabled: { oldValue: true, newValue: false } });
  page.tick(5000);
  assert.equal(page.requests, 0);
});

test("content: enabling again skips the button already on screen", async t => {
  const page = await loadContent(t, { enabled: false });
  await page.change({ enabled: { oldValue: false, newValue: true } });
  page.tick(1);
  assert.equal(page.requests, 1);
});

test("content: a new skip delay restarts the countdown", async t => {
  const page = await loadContent(t, { skipDelay: 500 });
  page.tick(300);
  await page.change({ skipDelay: { oldValue: 500, newValue: 1000 } });
  page.tick(999);
  assert.equal(page.requests, 0);
  page.tick(1);
  assert.equal(page.requests, 1);
});

test("content: removed or invalid changed values fall back to the defaults", async t => {
  const page = await loadContent(t, { enabled: false, skipDelay: 1000 });
  await page.change({ enabled: { oldValue: false } });
  await page.change({ skipDelay: { oldValue: 1000, newValue: "fast" } });
  page.tick(1);
  assert.equal(page.requests, 1);
});

test("content: changes from other storage areas are ignored", async t => {
  const page = await loadContent(t, { skipDelay: 500 });
  await page.change({ enabled: { newValue: false } }, "local");
  page.tick(500);
  assert.equal(page.requests, 1);
});

// --- popup.js --------------------------------------------------------------

function fakeInput(props) {
  const listeners = {};
  return {
    ...props,
    style: { props: {}, setProperty(name, value) { this.props[name] = value; } },
    addEventListener: (type, fn) => (listeners[type] = fn),
    fire: type => listeners[type]()
  };
}

// `cache` is the popup's localStorage. `firstPaint` holds the colours set before
// storage.sync has loaded, i.e. what the popup shows when it opens.
async function loadPopup(stored, cache = {}) {
  const chrome = fakeChrome(stored);
  const localStorage = {
    getItem: key => cache[key] ?? null,
    setItem: (key, value) => (cache[key] = String(value))
  };
  const controls = {
    enabled: fakeInput({ checked: false }),
    notifications: fakeInput({ checked: false }),
    skipDelay: fakeInput({ value: "0", min: "0", max: "3000" }),
    skipDelayValue: fakeInput({ textContent: "" }),
    accentColor: fakeInput({ id: "accentColor", value: "#ff3b30" }),
    baseColor: fakeInput({ id: "baseColor", value: "#0f1115" }),
    accentColorHex: fakeInput({ value: "" }),
    baseColorHex: fakeInput({ value: "" }),
    "reset-accentColor": fakeInput({}),
    "reset-baseColor": fakeInput({})
  };
  const documentElement = fakeInput({});
  vm.runInNewContext(popupSource, {
    chrome,
    localStorage,
    document: { documentElement, getElementById: id => controls[id] }
  });
  const firstPaint = { ...documentElement.style.props };
  await flush();
  return { chrome, cache, firstPaint, ...controls, css: name => documentElement.style.props[name] };
}

const defaults = { enabled: true, notifications: false, skipDelay: 0, accentColor: "#ff3b30", baseColor: "#0f1115" };

// Each colour setting, its picker id, and the CSS variable it drives.
const colors = [
  { key: "accentColor", cssVar: "--accent", custom: "#00aa55" },
  { key: "baseColor", cssVar: "--bg", custom: "#202840" }
];

test("popup: empty storage shows the defaults", async () => {
  const popup = await loadPopup({});
  assert.equal(popup.enabled.checked, true);
  assert.equal(popup.notifications.checked, false);
  assert.equal(Number(popup.skipDelay.value), 0);
  assert.equal(popup.skipDelayValue.textContent, "Instant");
  for (const { key, cssVar } of colors) {
    assert.equal(popup[key].value, defaults[key]);
    assert.equal(popup.css(cssVar), defaults[key]);
  }
});

test("popup: stored settings are shown", async () => {
  const popup = await loadPopup({
    enabled: false, notifications: true, skipDelay: 1500, accentColor: "#3366ff", baseColor: "#202840"
  });
  assert.equal(popup.enabled.checked, false);
  assert.equal(popup.notifications.checked, true);
  assert.equal(Number(popup.skipDelay.value), 1500);
  assert.equal(popup.skipDelayValue.textContent, "1.5s");
  assert.equal(popup.css("--accent"), "#3366ff");
  assert.equal(popup.css("--bg"), "#202840");
});

test("popup: changes save all settings, with the delay as a number", async () => {
  const popup = await loadPopup({});

  // Spread into a plain object: objects built inside the vm sandbox have another Object prototype.
  popup.notifications.checked = true;
  await popup.notifications.fire("change");
  assert.deepEqual({ ...popup.chrome.saved.at(-1) }, { ...defaults, notifications: true });

  popup.skipDelay.value = "750"; // range inputs report strings
  await popup.skipDelay.fire("change");
  assert.deepEqual({ ...popup.chrome.saved.at(-1) }, { ...defaults, notifications: true, skipDelay: 750 });
});

for (const { key, cssVar, custom } of colors) {
  test(`popup: an invalid stored ${key} falls back to the default`, async () => {
    for (const value of ["red", "#fff", "#12345g", 42, `${custom}; background: url(x)`]) {
      const popup = await loadPopup({ [key]: value });
      assert.equal(popup[key].value, defaults[key], String(value));
      assert.equal(popup.css(cssVar), defaults[key]);
    }
  });

  test(`popup: picking a ${key} previews it live and saves only once picked`, async () => {
    const popup = await loadPopup({});

    popup[key].value = custom;
    popup[key].fire("input");
    assert.equal(popup.css(cssVar), custom);
    assert.equal(popup.chrome.saved.length, 0);

    await popup[key].fire("change");
    assert.equal(popup.chrome.saved.at(-1)[key], custom);
  });

  test(`popup: reset restores and saves the default ${key}, leaving the other colour alone`, async () => {
    const stored = Object.fromEntries(colors.map(c => [c.key, c.custom]));
    const popup = await loadPopup(stored);

    await popup[`reset-${key}`].fire("click");
    assert.equal(popup[key].value, defaults[key]);
    assert.equal(popup.css(cssVar), defaults[key]);
    for (const other of colors.filter(c => c.key !== key)) {
      assert.equal(popup.chrome.saved.at(-1)[other.key], other.custom);
    }
    assert.equal(popup.chrome.saved.at(-1)[key], defaults[key]);
  });
}

for (const { key, cssVar, custom } of colors) {
  test(`popup: the ${key} hex field shows the saved colour and follows the picker and reset`, async () => {
    const popup = await loadPopup({ [key]: custom });
    const hex = popup[`${key}Hex`];
    assert.equal(hex.value, custom);

    popup[key].value = "#123456";
    popup[key].fire("input");
    assert.equal(hex.value, "#123456");

    await popup[`reset-${key}`].fire("click");
    assert.equal(hex.value, defaults[key]);
  });

  test(`popup: a pasted ${key} hex code previews at once and saves on Enter, tidied`, async () => {
    for (const [pasted, color] of [["#00AA55", "#00aa55"], ["00aa55", "#00aa55"], ["  #0a5 ", "#00aa55"]]) {
      const popup = await loadPopup({});
      const hex = popup[`${key}Hex`];

      hex.value = pasted;
      hex.fire("input");
      assert.equal(popup.css(cssVar), color, pasted);
      assert.equal(popup.chrome.saved.length, 0);

      await hex.fire("change");
      assert.equal(hex.value, color);
      assert.equal(popup[key].value, color);
      assert.equal(popup.chrome.saved.at(-1)[key], color);
    }
  });

  test(`popup: an invalid ${key} hex code is undone and the colour kept`, async () => {
    for (const typed of ["red", "#12345", "#1234567", "#ggg", ""]) {
      const popup = await loadPopup({ [key]: custom });
      const hex = popup[`${key}Hex`];

      hex.value = typed;
      hex.fire("input");
      assert.equal(popup.css(cssVar), custom, typed);

      await hex.fire("change");
      assert.equal(hex.value, custom);
      assert.equal(popup[key].value, custom);
    }
  });
}

test("popup: leaving a half-edited hex code saves the last valid colour it showed", async () => {
  const popup = await loadPopup({});
  const hex = popup.accentColorHex;

  for (const typed of ["#", "#f", "#ff", "#fff", "#fff0"]) {
    hex.value = typed;
    hex.fire("input");
  }
  await hex.fire("change");
  assert.equal(hex.value, "#ffffff");
  assert.equal(popup.css("--accent"), "#ffffff");
  assert.equal(popup.chrome.saved.at(-1).accentColor, "#ffffff");
});

test("popup: text switches to dark on a light base colour, and back", async () => {
  const popup = await loadPopup({ baseColor: "#f4f4f0" });
  assert.equal(popup.css("--text"), "#15171c");
  assert.equal(popup.css("--text-muted"), "#5b616d");

  popup.baseColor.value = "#1a1a2e";
  popup.baseColor.fire("input");
  assert.equal(popup.css("--text"), "#f5f7fa");
  assert.equal(popup.css("--text-muted"), "#9299a6");
});

test("popup: the default base colour keeps the original light text", async () => {
  const popup = await loadPopup({});
  assert.equal(popup.css("--text"), "#f5f7fa");
});

test("popup: opens in the cached colours before storage has loaded", async () => {
  const cache = { colors: JSON.stringify({ accentColor: "#3a86ff", baseColor: "#f4f1ea" }) };
  const popup = await loadPopup({ accentColor: "#3a86ff", baseColor: "#f4f1ea" }, cache);
  assert.equal(popup.firstPaint["--accent"], "#3a86ff");
  assert.equal(popup.firstPaint["--bg"], "#f4f1ea");
  assert.equal(popup.firstPaint["--text"], "#15171c");
});

test("popup: synced colours win over a stale cache, and refresh it", async () => {
  const cache = { colors: JSON.stringify({ accentColor: "#111111", baseColor: "#222222" }) };
  const popup = await loadPopup({ accentColor: "#3a86ff", baseColor: "#f4f1ea" }, cache);
  assert.equal(popup.css("--accent"), "#3a86ff");
  assert.equal(popup.css("--bg"), "#f4f1ea");
  assert.deepEqual(JSON.parse(popup.cache.colors), { accentColor: "#3a86ff", baseColor: "#f4f1ea" });
});

test("popup: saving a colour updates the cache", async () => {
  const popup = await loadPopup({});
  popup.baseColor.value = "#f4f1ea";
  await popup.baseColor.fire("change");
  assert.equal(JSON.parse(popup.cache.colors).baseColor, "#f4f1ea");
});

test("popup: a missing, corrupt or invalid cache falls back to the defaults", async () => {
  for (const colors of [undefined, "{not json", "42", JSON.stringify({ baseColor: "url(x)" })]) {
    const popup = await loadPopup({}, colors === undefined ? {} : { colors });
    assert.equal(popup.firstPaint["--accent"], "#ff3b30", String(colors));
    assert.equal(popup.firstPaint["--bg"], "#0f1115", String(colors));
  }
});

test("content: colour changes don't affect skipping", async t => {
  const page = await loadContent(t, { skipDelay: 500 });
  page.tick(300);
  await page.change({
    accentColor: { oldValue: "#ff3b30", newValue: "#00aa55" },
    baseColor: { oldValue: "#0f1115", newValue: "#f4f4f0" }
  });
  page.tick(200);
  assert.equal(page.requests, 1);
});
