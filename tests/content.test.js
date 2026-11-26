// Run with: node --test tests/
// content.js: retries, which buttons count as a skip button, and YouTube page switches.
const test = require("node:test");
const assert = require("node:assert/strict");
const { read, loadContent, Element, HTMLButtonElement } = require("./fake-page");

// --- Retries -----------------------------------------------------------------

test("retries are 750 ms apart, at most 4 per button, even while the page keeps changing", async t => {
  const page = await loadContent(t);
  page.tick(1);
  assert.equal(page.requests, 1);

  for (let i = 0; i < 5; i++) await page.mutate();
  page.tick(749);
  assert.equal(page.requests, 1);

  page.tick(1);
  assert.equal(page.requests, 2);
  page.tick(750);
  assert.equal(page.requests, 3);
  page.tick(750);
  assert.equal(page.requests, 4);

  for (let i = 0; i < 3; i++) page.tick(750);
  await page.mutate();
  page.tick(1);
  assert.equal(page.requests, 4);
});

test("page changes during the skip delay don't start extra countdowns", async t => {
  const page = await loadContent(t, { skipDelay: 500 });
  for (let i = 0; i < 5; i++) {
    page.tick(50);
    await page.mutate();
  }
  // Run past where extra countdowns would fire (550-750 ms), but before the first retry (1250 ms).
  page.tick(600);
  assert.equal(page.requests, 1);
});

test("retries stop once the button is gone", async t => {
  const page = await loadContent(t);
  page.tick(1);
  page.candidates = [];
  await page.mutate();
  page.tick(5000);
  assert.equal(page.requests, 1);
});

test("the next ad's new button is skipped after the first one goes away", async t => {
  const page = await loadContent(t);
  page.tick(1);

  page.candidates = [];
  await page.mutate();
  page.candidates = [new HTMLButtonElement()];
  await page.mutate();
  page.tick(1);
  assert.equal(page.requests, 2);
});

test("a button reused for the next ad in a pod is skipped again after it was hidden", async t => {
  const button = new HTMLButtonElement();
  const page = await loadContent(t, {}, { candidates: [button] });
  page.tick(1);

  button.rendered = false;
  await page.mutate();
  button.rendered = true;
  await page.mutate();
  page.tick(1);
  assert.equal(page.requests, 2);
});

// --- Finding the skip button -------------------------------------------------

const unusable = {
  disabled: b => (b.disabled = true),
  'aria-disabled="true"': b => (b.attributes["aria-disabled"] = "true"),
  hidden: b => (b.hidden = true),
  'aria-hidden="true"': b => (b.attributes["aria-hidden"] = "true"),
  "display: none": b => (b.style.display = "none"),
  "visibility: hidden": b => (b.style.visibility = "hidden"),
  "not rendered (no layout boxes)": b => (b.rendered = false),
  "removed from the page": b => (b.isConnected = false)
};

test("buttons that can't be clicked are ignored", async t => {
  for (const [name, makeUnusable] of Object.entries(unusable)) {
    await t.test(name, async t => {
      const button = new HTMLButtonElement();
      makeUnusable(button);
      const page = await loadContent(t, {}, { candidates: [button] });
      page.tick(5000);
      assert.equal(page.requests, 0);
    });
  }
});

test("an unusable match doesn't hide a usable one after it", async t => {
  const hidden = new HTMLButtonElement();
  hidden.hidden = true;
  const page = await loadContent(t, {}, { candidates: [hidden, new HTMLButtonElement()] });
  page.tick(1);
  assert.equal(page.requests, 1);
});

test('a wrapper like id="skip-button:2" is resolved to the button inside it', async t => {
  await t.test("with a button inside", async t => {
    const page = await loadContent(t, {}, { candidates: [new Element(new HTMLButtonElement())] });
    page.tick(1);
    assert.equal(page.requests, 1);
  });

  await t.test("with nothing inside", async t => {
    const page = await loadContent(t, {}, { candidates: [new Element(null)] });
    page.tick(5000);
    assert.equal(page.requests, 0);
  });
});

test("content.js and youtube-bridge.js share the exact same button-finding code", () => {
  // The two files must find the same button, but can't share a helper file.
  const extract = file => {
    const source = read(file).replace(/\r\n/g, "\n");
    const start = source.indexOf("const SKIP_BUTTON_SELECTORS");
    const end = source.indexOf("return null;\n  }", source.indexOf("function findSkipButton"));
    assert.ok(start !== -1 && end !== -1, `button-finding code not found in ${file}`);
    return source.slice(start, end);
  };
  assert.equal(extract("content.js"), extract("youtube-bridge.js"));
});

// --- YouTube page switches ---------------------------------------------------

test("switching page during the skip delay cancels the skip", async t => {
  const page = await loadContent(t, { skipDelay: 500 });
  page.tick(200);
  await page.navigate("yt-navigate-start");
  page.tick(5000);
  assert.equal(page.requests, 0);
});

test("the new page is scanned once the switch finishes", async t => {
  const page = await loadContent(t, { skipDelay: 500 });
  page.tick(200);
  await page.navigate("yt-navigate-start");
  await page.navigate("yt-navigate-finish");
  page.tick(499);
  assert.equal(page.requests, 0);
  page.tick(1);
  assert.equal(page.requests, 1);
});

test("a page switch resets the retry limit", async t => {
  const page = await loadContent(t);
  page.tick(1);
  for (let i = 0; i < 6; i++) page.tick(750);
  assert.equal(page.requests, 4);

  await page.navigate("yt-navigate-start");
  await page.navigate("yt-navigate-finish");
  page.tick(1);
  assert.equal(page.requests, 5);
});

test("a page switch while disabled doesn't skip", async t => {
  const page = await loadContent(t, { enabled: false });
  await page.navigate("yt-navigate-start");
  await page.navigate("yt-navigate-finish");
  page.tick(5000);
  assert.equal(page.requests, 0);
});
