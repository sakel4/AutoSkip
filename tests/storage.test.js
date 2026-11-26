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
    style: { setProperty() {} },
    addEventListener: (type, fn) => (listeners[type] = fn),
    fire: type => listeners[type]()
  };
}

async function loadPopup(stored) {
  const chrome = fakeChrome(stored);
  const controls = {
    enabled: fakeInput({ checked: false }),
    notifications: fakeInput({ checked: false }),
    skipDelay: fakeInput({ value: "0", min: "0", max: "3000" }),
    skipDelayValue: fakeInput({ textContent: "" })
  };
  vm.runInNewContext(popupSource, { chrome, document: { getElementById: id => controls[id] } });
  await flush();
  return { chrome, ...controls };
}

test("popup: empty storage shows the defaults", async () => {
  const popup = await loadPopup({});
  assert.equal(popup.enabled.checked, true);
  assert.equal(popup.notifications.checked, false);
  assert.equal(Number(popup.skipDelay.value), 0);
  assert.equal(popup.skipDelayValue.textContent, "Instant");
});

test("popup: stored settings are shown", async () => {
  const popup = await loadPopup({ enabled: false, notifications: true, skipDelay: 1500 });
  assert.equal(popup.enabled.checked, false);
  assert.equal(popup.notifications.checked, true);
  assert.equal(Number(popup.skipDelay.value), 1500);
  assert.equal(popup.skipDelayValue.textContent, "1.5s");
});

test("popup: changes save all settings, with the delay as a number", async () => {
  const popup = await loadPopup({});

  // Spread into a plain object: objects built inside the vm sandbox have another Object prototype.
  popup.notifications.checked = true;
  await popup.notifications.fire("change");
  assert.deepEqual({ ...popup.chrome.saved.at(-1) }, { enabled: true, notifications: true, skipDelay: 0 });

  popup.skipDelay.value = "750"; // range inputs report strings
  await popup.skipDelay.fire("change");
  assert.deepEqual({ ...popup.chrome.saved.at(-1) }, { enabled: true, notifications: true, skipDelay: 750 });
});
