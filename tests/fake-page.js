// Shared fakes for the tests: a storage.sync stand-in and a minimal YouTube page
// to run content.js against. Not a test file itself.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const read = file => fs.readFileSync(path.join(__dirname, "..", file), "utf8");
const contentSource = read("content.js");

// Runs after every pending microtask, e.g. the awaited storage read.
const flush = () => new Promise(resolve => setImmediate(resolve));

// Behaves like storage.sync: get(defaults) fills in missing keys, onChanged reports changes.
function fakeChrome(stored = {}, { failGet = false } = {}) {
  const listeners = [];
  const saved = [];
  return {
    storage: {
      sync: {
        async get(defaults) {
          if (failGet) throw new Error("storage unavailable");
          return { ...defaults, ...stored };
        },
        async set(values) {
          Object.assign(stored, values);
          saved.push(values);
        }
      },
      onChanged: { addListener: fn => listeners.push(fn) }
    },
    change(changes, areaName = "sync") {
      for (const fn of listeners) fn(changes, areaName);
    },
    saved
  };
}

class Element {
  constructor(inner = null) {
    this.inner = inner;
  }
  // Wrappers such as id="skip-button:2" hold the real button inside.
  querySelector() {
    return this.inner;
  }
}

// A visible, enabled button. Tests flip these fields to hide or disable it.
class HTMLButtonElement extends Element {
  isConnected = true;
  disabled = false;
  hidden = false;
  rendered = true;
  attributes = {};
  style = { display: "block", visibility: "visible" };
  getAttribute(name) {
    return this.attributes[name] ?? null;
  }
  getClientRects() {
    return this.rendered ? [{}] : [];
  }
}

// Loads content.js and counts the skip requests it sends to the bridge.
// `page.candidates` is what the skip-button selector matches; change it and call
// `page.mutate()` to simulate YouTube changing the DOM. The page has no DOM for
// notifications, so a notification shown by mistake throws and fails the test.
async function loadContent(t, stored = {}, { failGet, candidates } = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });

  const chrome = fakeChrome(stored, { failGet });
  const window = new EventTarget();
  let onMutation = null;
  let requests = 0;
  window.addEventListener("__yt_auto_skip_request__", () => requests++);

  const page = {
    chrome,
    candidates: candidates ?? [new HTMLButtonElement()],
    get requests() {
      return requests;
    },
    tick: ms => t.mock.timers.tick(ms),
    async change(changes, areaName) {
      chrome.change(changes, areaName);
      await flush();
    },
    async mutate() {
      onMutation?.();
      await flush();
    },
    async navigate(type) {
      window.dispatchEvent(new Event(type));
      await flush();
    }
  };

  vm.runInNewContext(contentSource, {
    chrome,
    window,
    document: { querySelectorAll: () => page.candidates },
    Element,
    HTMLButtonElement,
    Event,
    MutationObserver: class {
      constructor(callback) {
        onMutation = callback;
      }
      observe() {}
    },
    getComputedStyle: button => button.style,
    queueMicrotask,
    setTimeout: (...args) => setTimeout(...args),
    clearTimeout: id => clearTimeout(id),
    console: { warn() {}, error: console.error }
  });
  await flush();

  return page;
}

// --- Popup fakes ---------------------------------------------------------------

// A stand-in DOM element that records styles, attributes and listeners.
// fire(type, event) runs the listener and returns what it returns.
function fakeElement(props = {}) {
  const listeners = {};
  const attributes = {};
  return {
    ...props,
    attributes,
    setAttribute: (name, value) => (attributes[name] = value),
    style: { props: {}, setProperty(name, value) { this.props[name] = value; } },
    addEventListener: (type, fn) => (listeners[type] = fn),
    fire: (type, event = {}) => listeners[type]({ preventDefault() {}, ...event })
  };
}

// One colour picker panel as written in popup.html, with a 200x100 square at 0,0.
// `parts` gives the test direct access to the square, thumb and hue slider.
function fakePickerPanel() {
  const captured = new Set();
  const parts = {
    area: fakeElement({
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 200, height: 100 }),
      setPointerCapture: id => captured.add(id),
      hasPointerCapture: id => captured.has(id)
    }),
    thumb: fakeElement(),
    hue: fakeElement({ value: "0" })
  };
  const bySelector = {
    ".color-picker-area": parts.area,
    ".color-picker-thumb": parts.thumb,
    ".color-picker-hue": parts.hue
  };
  return fakeElement({ hidden: true, parts, querySelector: selector => bySelector[selector] });
}

module.exports = {
  read, flush, fakeChrome, loadContent, Element, HTMLButtonElement, fakeElement, fakePickerPanel
};
