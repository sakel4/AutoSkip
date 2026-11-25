// Run with: node --test tests/
// Loads youtube-bridge.js against a minimal fake DOM built on Node's EventTarget.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class Element extends EventTarget {
  constructor(parentNode = null) {
    super();
    this.parentNode = parentNode;
    this.isConnected = true;
    this.disabled = false;
    this.hidden = false;
  }
  getAttribute() { return null; }
  getClientRects() { return [{}]; }
  querySelector() { return null; }
}
class HTMLButtonElement extends Element {}

let currentButton = null;
const win = new EventTarget();
const doc = new EventTarget();
doc.parentNode = null;
doc.querySelectorAll = () => (currentButton ? [currentButton] : []);

Object.assign(globalThis, {
  window: win,
  document: doc,
  Element,
  HTMLButtonElement,
  ShadowRoot: class ShadowRoot {},
  MouseEvent: class MouseEvent extends Event {},
  getComputedStyle: () => ({ display: "block", visibility: "visible" })
});

vm.runInThisContext(fs.readFileSync(path.join(__dirname, "..", "youtube-bridge.js"), "utf8"));

const requestSkip = () => win.dispatchEvent(new Event("__yt_auto_skip_request__"));

function setup() {
  const container = new Element(doc);
  const button = new HTMLButtonElement(container);
  currentButton = button;
  return { container, button };
}

test("replays capture -> target -> bubble with a trusted-looking event", () => {
  const { container, button } = setup();
  const calls = [];
  const log = name => event => calls.push([name, event.currentTarget, event.target, event.isTrusted]);

  win.addEventListener("click", log("win-capture"), true);
  doc.addEventListener("click", log("doc-capture"), { capture: true });
  container.addEventListener("click", log("container-capture"), true);
  button.addEventListener("click", log("button-bubble"));
  button.addEventListener("click", log("button-capture"), true);
  container.addEventListener("click", log("container-bubble"));
  doc.addEventListener("click", log("doc-bubble"));
  win.addEventListener("click", log("win-bubble"));

  requestSkip();

  assert.deepEqual(calls.map(c => c[0]), [
    "win-capture", "doc-capture", "container-capture",
    "button-capture", "button-bubble",
    "container-bubble", "doc-bubble", "win-bubble"
  ]);
  assert.deepEqual(calls.map(c => c[1]), [win, doc, container, button, button, container, doc, win]);
  assert.ok(calls.every(c => c[2] === button && c[3] === true));
});

test("stopPropagation at the target still runs that target's listeners, then stops", () => {
  const { container, button } = setup();
  const calls = [];
  button.addEventListener("click", e => { calls.push("a"); e.stopPropagation(); });
  button.addEventListener("click", () => calls.push("b"));
  container.addEventListener("click", () => calls.push("container"));

  requestSkip();
  assert.deepEqual(calls, ["a", "b"]);
});

test("stopImmediatePropagation skips the remaining listeners on the same target", () => {
  const { button } = setup();
  const calls = [];
  button.addEventListener("click", e => { calls.push("a"); e.stopImmediatePropagation(); });
  button.addEventListener("click", () => calls.push("b"));

  requestSkip();
  assert.deepEqual(calls, ["a"]);
});

test("duplicate adds are ignored, like native addEventListener", () => {
  const { button } = setup();
  let count = 0;
  const listener = () => count++;
  button.addEventListener("click", listener);
  button.addEventListener("click", listener);

  requestSkip();
  button.dispatchEvent(new Event("click"));
  assert.equal(count, 2);
});

test("removed and aborted listeners are not replayed", () => {
  const { button } = setup();
  let count = 0;
  const removed = () => count++;
  const controller = new AbortController();
  button.addEventListener("click", removed, true);
  button.addEventListener("click", () => count++, { signal: controller.signal });

  button.removeEventListener("click", removed, { capture: true });
  controller.abort();

  requestSkip();
  button.dispatchEvent(new Event("click"));
  assert.equal(count, 0);
});

test("a once listener runs once, whether consumed by a replay or a native click", () => {
  const { button } = setup();
  let replayed = 0;
  let native = 0;
  button.addEventListener("click", () => replayed++, { once: true });
  requestSkip();
  requestSkip();
  button.dispatchEvent(new Event("click"));
  assert.equal(replayed, 1);

  const other = setup().button;
  other.addEventListener("click", () => native++, { once: true });
  other.dispatchEvent(new Event("click"));
  requestSkip();
  assert.equal(native, 1);
});

test("handleEvent objects are called with the object as this", () => {
  const { button } = setup();
  const handler = { calls: 0, handleEvent() { this.calls++; } };
  button.addEventListener("click", handler);

  requestSkip();
  assert.equal(handler.calls, 1);
});

test("does nothing when there is no skip button", () => {
  const { button } = setup();
  let count = 0;
  button.addEventListener("click", () => count++);
  currentButton = null;

  requestSkip();
  assert.equal(count, 0);
});
