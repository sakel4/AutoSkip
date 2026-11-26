// A small colour picker drawn inside the page: a saturation/brightness square
// and a hue slider. Used instead of <input type="color">, because in Firefox its
// system colour dialog closes the extension popup before a colour can be picked.
//
// Usage: ColorPicker.create(panel, { onInput, onChange }) -> { setColor }
//   panel     holds the markup from popup.html (.color-picker-area,
//             .color-picker-thumb, .color-picker-hue)
//   onInput   called with "#rrggbb" while dragging or sliding (preview)
//   onChange  called with "#rrggbb" when the user lets go (save)
const ColorPicker = (() => {
  "use strict";

  // --- Colour maths (HSV: h 0-360, s and v 0-1) ------------------------------

  const clamp = value => Math.min(1, Math.max(0, value));

  function hexToHsv(hex) {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b);
    const range = max - Math.min(r, g, b);

    let h = 0;
    if (range) {
      if (max === r) h = ((g - b) / range) % 6;
      else if (max === g) h = (b - r) / range + 2;
      else h = (r - g) / range + 4;
    }
    return { h: (h * 60 + 360) % 360, s: max ? range / max : 0, v: max };
  }

  function hsvToHex({ h, s, v }) {
    const channel = n => {
      const k = (n + h / 60) % 6;
      return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
    };
    return "#" + [5, 3, 1]
      .map(n => Math.round(channel(n) * 255).toString(16).padStart(2, "0"))
      .join("");
  }

  // --- The picker ------------------------------------------------------------

  function create(panel, { onInput, onChange }) {
    const area = panel.querySelector(".color-picker-area");
    const thumb = panel.querySelector(".color-picker-thumb");
    const hue = panel.querySelector(".color-picker-hue");

    let hsv = { h: 0, s: 0, v: 0 };
    let hex = null;

    function render() {
      panel.style.setProperty("--hue", hsv.h);
      thumb.style.left = `${hsv.s * 100}%`;
      thumb.style.top = `${(1 - hsv.v) * 100}%`;
      hue.value = hsv.h;
      // What a screen reader announces for the square (role="slider" in popup.html).
      area.setAttribute("aria-valuetext",
        `Saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`);
    }

    function update(changes) {
      hsv = { ...hsv, ...changes };
      hex = hsvToHex(hsv);
      render();
      onInput(hex);
    }

    // Square: click or drag with a mouse or finger...
    function pickAt(event) {
      const rect = area.getBoundingClientRect();
      update({
        s: clamp((event.clientX - rect.left) / rect.width),
        v: 1 - clamp((event.clientY - rect.top) / rect.height)
      });
    }
    area.addEventListener("pointerdown", event => {
      if (event.button !== 0) return; // only the main button; a right-click opens the menu
      area.setPointerCapture(event.pointerId);
      pickAt(event);
    });
    area.addEventListener("pointermove", event => {
      if (area.hasPointerCapture(event.pointerId)) pickAt(event);
    });
    area.addEventListener("pointerup", () => onChange(hex));

    // ...or move with the arrow keys, Shift for bigger steps.
    const arrowKeys = { ArrowLeft: ["s", -1], ArrowRight: ["s", 1], ArrowDown: ["v", -1], ArrowUp: ["v", 1] };
    area.addEventListener("keydown", event => {
      if (!arrowKeys[event.key]) return;
      event.preventDefault();
      const [key, direction] = arrowKeys[event.key];
      update({ [key]: clamp(hsv[key] + direction * (event.shiftKey ? 0.1 : 0.01)) });
    });
    // Save on key release, not on every repeat, to stay under storage write limits.
    area.addEventListener("keyup", event => {
      if (arrowKeys[event.key]) onChange(hex);
    });

    hue.addEventListener("input", () => update({ h: Number(hue.value) }));
    hue.addEventListener("change", () => onChange(hex));

    return {
      // Shows a colour set elsewhere (hex field, Reset, loading). The colour the
      // picker just produced itself is skipped, so dragging into grey keeps its hue.
      setColor(color) {
        if (color === hex) return;
        hex = color;
        hsv = hexToHsv(color);
        render();
      }
    };
  }

  return { create, hexToHsv, hsvToHex };
})();
