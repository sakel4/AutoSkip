// Run with: node --test tests/
// Settings storage, read by content.js (the popup side is in popup.test.js).
// Chrome and Firefox both run this through the same promise-based `chrome.storage`
// API (MV3), so one fake covers both browsers.
const test = require("node:test");
const assert = require("node:assert/strict");
const { loadContent } = require("./fake-page");

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
