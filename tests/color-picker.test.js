// Run with: node --test tests/
// color-picker.js: the colour maths, and the picker's square, hue slider and keys.
const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { read, fakePickerPanel } = require("./fake-page");

// The script's last expression returns its ColorPicker constant.
const ColorPicker = vm.runInContext(`${read("color-picker.js")}\nColorPicker`, vm.createContext({}));
const { hexToHsv, hsvToHex } = ColorPicker;

// A picker on a fake panel that records what it reports.
function makePicker(color = "#ff0000") {
  const panel = fakePickerPanel();
  const inputs = [];
  const changes = [];
  const picker = ColorPicker.create(panel, {
    onInput: hex => inputs.push(hex),
    onChange: hex => changes.push(hex)
  });
  picker.setColor(color);
  return { picker, panel, ...panel.parts, inputs, changes };
}

// --- Colour maths ----------------------------------------------------------------

test("hexToHsv gives the expected hue, saturation and brightness", () => {
  const close = (actual, expected) =>
    Object.keys(expected).forEach(k => assert.ok(Math.abs(actual[k] - expected[k]) < 0.005, `${k}: ${actual[k]}`));

  close(hexToHsv("#ff0000"), { h: 0, s: 1, v: 1 });
  close(hexToHsv("#00ff00"), { h: 120, s: 1, v: 1 });
  close(hexToHsv("#0000ff"), { h: 240, s: 1, v: 1 });
  close(hexToHsv("#ff00ff"), { h: 300, s: 1, v: 1 });
  close(hexToHsv("#ffffff"), { h: 0, s: 0, v: 1 });
  close(hexToHsv("#000000"), { h: 0, s: 0, v: 0 });
  close(hexToHsv("#808080"), { h: 0, s: 0, v: 0.502 });
});

test("hsvToHex turns every hex colour back into itself", () => {
  const samples = ["#ff3b30", "#0f1115", "#f4f1ea", "#00aa55", "#123456", "#fedcba", "#010101", "#fefefe"];
  // Plus a spread of colours across the whole range.
  for (let i = 0; i < 4096; i += 7) samples.push("#" + (i * 4099).toString(16).padStart(6, "0").slice(-6));
  for (const hex of samples) assert.equal(hsvToHex(hexToHsv(hex)), hex);
});

// --- The picker --------------------------------------------------------------------

test("setColor places the thumb and hue slider for that colour", () => {
  const { panel, area, thumb, hue, inputs } = makePicker("#00ff00");
  assert.equal(thumb.style.left, "100%");
  assert.equal(thumb.style.top, "0%");
  assert.equal(Number(hue.value), 120);
  assert.equal(panel.style.props["--hue"], 120);
  assert.deepEqual(inputs, [], "setColor doesn't report back");
  assert.equal(area.attributes["aria-valuetext"], "Saturation 100%, brightness 100%");
});

test("screen readers hear the square's new value after each move", () => {
  const { area } = makePicker("#ff0000");
  area.fire("keydown", { key: "ArrowDown", shiftKey: true });
  assert.equal(area.attributes["aria-valuetext"], "Saturation 100%, brightness 90%");
  area.fire("pointerdown", { button: 0, pointerId: 1, clientX: 50, clientY: 25 });
  assert.equal(area.attributes["aria-valuetext"], "Saturation 25%, brightness 75%");
});

test("a right-click or middle-click on the square changes nothing", () => {
  const { area, inputs, changes } = makePicker("#ff0000");
  for (const button of [1, 2]) {
    area.fire("pointerdown", { button, pointerId: 1, clientX: 0, clientY: 0 });
    area.fire("pointermove", { pointerId: 1, clientX: 10, clientY: 10 });
  }
  assert.deepEqual(inputs, []);
  assert.deepEqual(changes, []);
});

test("dragging in the square previews colours and saves when let go", () => {
  const { area, inputs, changes } = makePicker("#ff0000");

  area.fire("pointerdown", { button: 0, pointerId: 1, clientX: 200, clientY: 50 });
  area.fire("pointermove", { pointerId: 1, clientX: 0, clientY: 0 });
  assert.deepEqual(inputs, ["#800000", "#ffffff"]);
  assert.deepEqual(changes, []);

  area.fire("pointerup", { pointerId: 1 });
  assert.deepEqual(changes, ["#ffffff"]);
});

test("moving over the square without pressing does nothing", () => {
  const { area, inputs } = makePicker();
  area.fire("pointermove", { pointerId: 1, clientX: 10, clientY: 10 });
  assert.deepEqual(inputs, []);
});

test("dragging past the edges stays inside the square", () => {
  const { area, thumb, inputs } = makePicker("#ff0000");
  area.fire("pointerdown", { button: 0, pointerId: 1, clientX: -50, clientY: 500 });
  assert.deepEqual(inputs, ["#000000"]);
  assert.equal(thumb.style.left, "0%");
  assert.equal(thumb.style.top, "100%");
});

test("the hue slider previews while sliding and saves on release", () => {
  const { hue, inputs, changes } = makePicker("#ff0000");
  hue.value = "240";
  hue.fire("input");
  assert.deepEqual(inputs, ["#0000ff"]);
  hue.fire("change");
  assert.deepEqual(changes, ["#0000ff"]);
});

test("arrow keys move the colour, Shift in bigger steps, and key release saves", () => {
  const { area, inputs, changes } = makePicker("#ff0000");
  let prevented = 0;
  const key = (type, k, shiftKey = false) =>
    area.fire(type, { key: k, shiftKey, preventDefault: () => prevented++ });

  key("keydown", "ArrowDown");             // brightness 1 -> 0.99
  key("keydown", "ArrowLeft", true);       // saturation 1 -> 0.9
  assert.deepEqual(inputs, ["#fc0000", "#fc1919"]);
  assert.equal(prevented, 2, "arrows don't scroll the popup");
  assert.deepEqual(changes, []);

  key("keyup", "ArrowLeft");
  assert.deepEqual(changes, ["#fc1919"]);

  key("keydown", "Tab");
  key("keyup", "Tab");
  assert.equal(inputs.length, 2, "other keys are ignored");
  assert.equal(changes.length, 1);
  assert.equal(prevented, 2, "Tab still moves focus");
});

test("dragging into grey keeps the chosen hue when the popup echoes the colour back", () => {
  const { picker, area, hue, inputs } = makePicker("#ff0000");
  hue.value = "200";
  hue.fire("input");

  area.fire("pointerdown", { button: 0, pointerId: 1, clientX: 0, clientY: 50 }); // no saturation: grey
  picker.setColor(inputs.at(-1)); // what popup.js does after every preview
  assert.equal(Number(hue.value), 200);
});

test("a colour set from outside moves the thumb and hue", () => {
  const { picker, thumb, hue } = makePicker("#ff0000");
  picker.setColor("#000080");
  assert.equal(Number(hue.value), 240);
  assert.equal(thumb.style.left, "100%");
  assert.equal(thumb.style.top, `${(1 - 128 / 255) * 100}%`);
});
