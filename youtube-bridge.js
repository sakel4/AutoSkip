(() => {
  "use strict";

  // Kept in sync with the copy in content.js. Chrome injects a script
  // file only once per frame, so the two worlds can't share a helper file.
  const SKIP_BUTTON_SELECTORS = [
    "button.ytp-skip-ad-button",
    "button.ytp-ad-skip-button",
    "button.ytp-ad-skip-button-modern",
    '[id^="skip-button:"]'
  ].join(",");

  const BRIDGE_EVENT = "__yt_auto_skip_request__";

  function resolveButton(element) {
    if (!(element instanceof Element)) return null;
    // Handles dynamic YouTube wrappers such as id="skip-button:2".
    return element instanceof HTMLButtonElement ? element : element.querySelector("button");
  }

  function isUsableButton(button) {
    if (!(button instanceof HTMLButtonElement) || !button.isConnected) return false;
    if (button.disabled || button.getAttribute("aria-disabled") === "true") return false;
    if (button.hidden || button.getAttribute("aria-hidden") === "true") return false;

    const style = getComputedStyle(button);
    if (style.display === "none" || style.visibility === "hidden") return false;

    return button.getClientRects().length > 0;
  }

  function findSkipButton() {
    const seen = new Set();

    for (const candidate of document.querySelectorAll(SKIP_BUTTON_SELECTORS)) {
      const button = resolveButton(candidate);
      if (!button || seen.has(button)) continue;

      seen.add(button);
      if (isUsableButton(button)) return button;
    }

    return null;
  }

  const listenerMap = new WeakMap();
  const nativeAdd = EventTarget.prototype.addEventListener;
  const nativeRemove = EventTarget.prototype.removeEventListener;

  let replaying = false;

  // --- Listener tracking ---------------------------------------------------

  function normalize(options) {
    if (typeof options === "boolean") {
      return { capture: options, once: false, signal: null };
    }
    return {
      capture: Boolean(options?.capture),
      once: Boolean(options?.once),
      signal: options?.signal ?? null
    };
  }

  function findRecord(target, listener, capture) {
    return listenerMap.get(target)?.find(r => r.listener === listener && r.capture === capture);
  }

  // Drop a record entirely, so per-element arrays don't grow forever.
  function forget(target, record) {
    record.removed = true;

    const records = listenerMap.get(target);
    if (!records) return;

    const index = records.indexOf(record);
    if (index !== -1) records.splice(index, 1);
    if (records.length === 0) listenerMap.delete(target);
  }

  function callListener(listener, currentTarget, event) {
    if (typeof listener === "function") return listener.call(currentTarget, event);
    return listener?.handleEvent?.(event);
  }

  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (type !== "click" || listener == null) {
      return nativeAdd.call(this, type, listener, options);
    }

    const { capture, once, signal } = normalize(options);

    // addEventListener de-duplicates using listener + capture for a given type.
    // The native registration may be a wrapper (see below), so de-duplicate here.
    if (findRecord(this, listener, capture)) return;
    if (signal?.aborted) return;

    const target = this;
    const record = { listener, capture, once, removed: false, native: listener };

    // A native click consumes a {once:true} listener; wrap it so the record
    // is forgotten too, otherwise a later replay would invoke it again.
    if (once) {
      record.native = function (event) {
        forget(target, record);
        return callListener(listener, this, event);
      };
    }

    nativeAdd.call(this, type, record.native, options);

    let records = listenerMap.get(this);
    if (!records) {
      records = [];
      listenerMap.set(this, records);
    }
    records.push(record);

    if (signal) {
      nativeAdd.call(signal, "abort", () => forget(target, record), { once: true });
    }
  };

  EventTarget.prototype.removeEventListener = function (type, listener, options) {
    if (type === "click" && listener != null) {
      const record = findRecord(this, listener, normalize(options).capture);
      if (record) {
        forget(this, record);
        return nativeRemove.call(this, type, record.native, options);
      }
    }

    return nativeRemove.call(this, type, listener, options);
  };

  // --- Synthesizing a trusted-looking click ---------------------------------

  function buildPath(target) {
    const path = [target];
    let node = target;

    while (node) {
      if (node.parentNode) {
        node = node.parentNode;
      } else if (node instanceof ShadowRoot && node.host) {
        // Continue out through Shadow DOM.
        node = node.host;
      } else {
        break;
      }
      path.push(node);
    }

    if (!path.includes(document)) path.push(document);
    if (!path.includes(window)) path.push(window);

    return path;
  }

  function makeEventFacade(button, path) {
    // Never dispatched natively - just used as a data/behavior source.
    const base = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      button: 0,
      buttons: 1,
      detail: 1
    });

    const state = {
      currentTarget: null,
      eventPhase: Event.NONE,
      propagationStopped: false,
      immediatePropagationStopped: false
    };

    // Each entry returns the *value* (or getter function, for methods)
    // that should be exposed for that property.
    const overrides = {
      isTrusted: () => true,
      target: () => button,
      srcElement: () => button,
      currentTarget: () => state.currentTarget,
      eventPhase: () => state.eventPhase,
      composedPath: () => () => path.slice(),
      stopPropagation: () => () => {
        state.propagationStopped = true;
      },
      stopImmediatePropagation: () => () => {
        state.propagationStopped = true;
        state.immediatePropagationStopped = true;
      },
      cancelBubble: () => state.propagationStopped,
      preventDefault: () => () => base.preventDefault(),
      returnValue: () => !base.defaultPrevented
    };

    const proxy = new Proxy(base, {
      get(target, prop) {
        if (prop in overrides) return overrides[prop]();

        // Firefox: native WebIDL getters often require the underlying
        // MouseEvent as their receiver, rather than the Proxy.
        const value = Reflect.get(target, prop, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
      set(target, prop, value) {
        if (prop === "cancelBubble") {
          if (value) state.propagationStopped = true;
          return true;
        }
        if (prop === "returnValue") {
          if (value === false) base.preventDefault();
          return true;
        }
        return Reflect.set(target, prop, value, target);
      }
    });

    return { proxy, state };
  }

  function invokeRecord(currentTarget, record, event) {
    if (record.removed) return;

    // Direct invocation (not native dispatch), so the browser won't
    // auto-consume a {once:true} listener for us - remove it ourselves.
    if (record.once) {
      forget(currentTarget, record);
      nativeRemove.call(currentTarget, "click", record.native, record.capture);
    }

    try {
      callListener(record.listener, currentTarget, event);
    } catch (error) {
      // Real event dispatch doesn't stop just because one listener throws.
      console.error("[YT auto skip] captured click listener threw", error);
    }
  }

  function invokeAtTarget(currentTarget, capture, event, state, phase) {
    const records = listenerMap.get(currentTarget);
    if (!records) return;

    state.currentTarget = currentTarget;
    state.eventPhase = phase;

    for (const record of records.slice()) {
      if (state.immediatePropagationStopped) break;
      if (record.capture === capture) invokeRecord(currentTarget, record, event);
    }
  }

  function replayCapturedClick(button) {
    const path = buildPath(button);
    const { proxy: event, state } = makeEventFacade(button, path);

    // CAPTURE: window -> document -> ancestors -> target
    for (let i = path.length - 1; i >= 1; i--) {
      invokeAtTarget(path[i], true, event, state, Event.CAPTURING_PHASE);
      if (state.propagationStopped) {
        state.currentTarget = null;
        state.eventPhase = Event.NONE;
        return;
      }
    }

    // TARGET: capture listeners first, then normal listeners; both AT_TARGET
    invokeAtTarget(button, true, event, state, Event.AT_TARGET);
    if (!state.immediatePropagationStopped) {
      invokeAtTarget(button, false, event, state, Event.AT_TARGET);
    }

    // BUBBLE: parent -> ancestors -> document -> window
    if (!state.propagationStopped && !state.immediatePropagationStopped) {
      for (let i = 1; i < path.length; i++) {
        invokeAtTarget(path[i], false, event, state, Event.BUBBLING_PHASE);
        if (state.propagationStopped) break;
      }
    }

    state.currentTarget = null;
    state.eventPhase = Event.NONE;
  }

  // Use the saved native addEventListener (not our override) for the
  // bridge control event, so this listener itself is never captured/replayed.
  nativeAdd.call(
    window,
    BRIDGE_EVENT,
    () => {
      if (replaying) return;

      const button = findSkipButton();
      if (!button) return;

      replaying = true;
      try {
        replayCapturedClick(button);
      } finally {
        replaying = false;
      }
    },
    true
  );
})();
