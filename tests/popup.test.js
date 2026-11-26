// Run with: node --test tests/
// popup.js and color-picker.js together: loading and saving settings, the colour
// pickers, hex fields, Reset, text contrast and the colour cache.
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { read, flush, fakeChrome, fakeElement, fakePickerPanel } = require("./fake-page");

const popupSource = read("popup.js");
const colorPickerSource = read("color-picker.js");
// The picker's colour maths, to work out where its thumb should be.
const { hexToHsv } = vm.runInContext(`${colorPickerSource}\nColorPicker`, vm.createContext({}));

// `cache` is the popup's localStorage. `firstPaint` holds the colours set before
// storage.sync has loaded, i.e. what the popup shows when it opens.
async function loadPopup(stored, cache = {}) {
  const chrome = fakeChrome(stored);
  const localStorage = {
    getItem: key => cache[key] ?? null,
    setItem: (key, value) => (cache[key] = String(value))
  };
  const controls = {
    enabled: fakeElement({ checked: false }),
    notifications: fakeElement({ checked: false }),
    skipDelay: fakeElement({ value: "0", min: "0", max: "3000" }),
    skipDelayValue: fakeElement({ textContent: "" }),
    "reset-accentColor": fakeElement(),
    "reset-baseColor": fakeElement()
  };
  for (const [key, value] of [["accentColor", "#ff3b30"], ["baseColor", "#0f1115"]]) {
    controls[key] = fakeElement({ id: key, value });
    controls[`${key}Hex`] = fakeElement({ value: "" });
    controls[`${key}Swatch`] = fakeElement();
    controls[`${key}Picker`] = fakePickerPanel();
  }
  const documentElement = fakeElement();
  // Both scripts share one page, like the two <script> tags in popup.html.
  const page = vm.createContext({
    chrome,
    localStorage,
    document: { documentElement, getElementById: id => controls[id] }
  });
  vm.runInContext(colorPickerSource, page);
  vm.runInContext(popupSource, page);
  const firstPaint = { ...documentElement.style.props };
  await flush();
  return {
    chrome, cache, firstPaint, ...controls,
    css: name => documentElement.style.props[name],
    // Drag the picker's square to (x, y) of its 200x100 area and let go.
    async drag(key, x, y) {
      const { area } = controls[`${key}Picker`].parts;
      area.fire("pointerdown", { button: 0, pointerId: 1, clientX: x, clientY: y });
      await area.fire("pointerup", { pointerId: 1 });
    }
  };
}

const defaults = { enabled: true, notifications: false, skipDelay: 0, accentColor: "#ff3b30", baseColor: "#0f1115" };

// Each colour setting (its hidden input id), and the CSS variable it drives.
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
  assert.equal(popup.accentColorHex.value, "#3366ff");
  assert.equal(popup.baseColorHex.value, "#202840");
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

  test(`popup: picking a ${key} previews it live and saves only once let go`, async () => {
    const popup = await loadPopup({});
    const { area } = popup[`${key}Picker`].parts;

    area.fire("pointerdown", { button: 0, pointerId: 1, clientX: 0, clientY: 0 }); // top-left: white
    assert.equal(popup.css(cssVar), "#ffffff");
    assert.equal(popup[`${key}Hex`].value, "#ffffff");
    assert.equal(popup[`${key}Swatch`].style.props["background-color"], "#ffffff");
    assert.equal(popup.chrome.saved.length, 0);

    await area.fire("pointerup", { pointerId: 1 });
    assert.equal(popup.chrome.saved.at(-1)[key], "#ffffff");
  });

  test(`popup: the ${key} swatch shows the colour and opens its picker, closing the other`, async () => {
    const popup = await loadPopup({ [key]: custom });
    const other = colors.find(c => c.key !== key).key;
    const swatch = popup[`${key}Swatch`];
    assert.equal(swatch.style.props["background-color"], custom);

    popup[`${other}Swatch`].fire("click");
    swatch.fire("click");
    assert.equal(popup[`${key}Picker`].hidden, false);
    assert.equal(swatch.attributes["aria-expanded"], "true");
    assert.equal(popup[`${other}Picker`].hidden, true, "only one picker open at a time");
    assert.equal(popup[`${other}Swatch`].attributes["aria-expanded"], "false");

    swatch.fire("click");
    assert.equal(popup[`${key}Picker`].hidden, true, "a second click closes it");
    assert.equal(swatch.attributes["aria-expanded"], "false");
  });

  test(`popup: the ${key} picker follows the hex field and Reset`, async () => {
    const popup = await loadPopup({ [key]: custom });
    const { hue, thumb } = popup[`${key}Picker`].parts;
    const hex = popup[`${key}Hex`];

    hex.value = "#0000ff";
    hex.fire("input");
    assert.equal(Number(hue.value), 240);
    assert.equal(thumb.style.left, "100%");
    assert.equal(thumb.style.top, "0%");

    await popup[`reset-${key}`].fire("click");
    const { h, s, v } = hexToHsv(defaults[key]);
    assert.equal(Number(hue.value), h);
    assert.equal(thumb.style.left, `${s * 100}%`);
    assert.equal(thumb.style.top, `${(1 - v) * 100}%`);
  });

  test(`popup: reset restores and saves the default ${key}, leaving the other colour alone`, async () => {
    const stored = Object.fromEntries(colors.map(c => [c.key, c.custom]));
    const popup = await loadPopup(stored);

    await popup[`reset-${key}`].fire("click");
    assert.equal(popup[key].value, defaults[key]);
    assert.equal(popup.css(cssVar), defaults[key]);
    assert.equal(popup[`${key}Hex`].value, defaults[key]);
    for (const other of colors.filter(c => c.key !== key)) {
      assert.equal(popup.chrome.saved.at(-1)[other.key], other.custom);
    }
    assert.equal(popup.chrome.saved.at(-1)[key], defaults[key]);
  });
}

for (const { key, cssVar, custom } of colors) {
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

  popup.baseColorHex.value = "#1a1a2e";
  popup.baseColorHex.fire("input");
  assert.equal(popup.css("--text"), "#f5f7fa");
  assert.equal(popup.css("--text-muted"), "#9299a6");
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
  await popup.drag("baseColor", 0, 0); // top-left: white
  assert.equal(JSON.parse(popup.cache.colors).baseColor, "#ffffff");
});

test("popup: a missing, corrupt or invalid cache falls back to the defaults", async () => {
  for (const colors of [undefined, "{not json", "42", JSON.stringify({ baseColor: "url(x)" })]) {
    const popup = await loadPopup({}, colors === undefined ? {} : { colors });
    assert.equal(popup.firstPaint["--accent"], "#ff3b30", String(colors));
    assert.equal(popup.firstPaint["--bg"], "#0f1115", String(colors));
  }
});
