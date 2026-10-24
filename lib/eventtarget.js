"use strict";

/**
 * @author mrdoob / http://mrdoob.com/
 * @author Jesús Leganés Combarro "Piranna" <piranna@gmail.com>
 */

function EventTarget() {
  this._listeners = {};
}

// Listeners per type, in registration order: listener -> { once }. Options
// follow the DOM: `once` removes the listener after its first call, `signal`
// removes it on abort (and an already aborted signal adds nothing), and the
// same listener is registered only once per type.
function listenersOf(target, type) {
  const all = (target._listeners = target._listeners || {});
  if (!(all[type] instanceof Map)) {
    all[type] = new Map();
  }
  return all[type];
}

EventTarget.prototype.addEventListener = function addEventListener(
  type,
  listener,
  options,
) {
  if (!listener) {
    return;
  }
  const opts = typeof options === "object" && options !== null ? options : {};
  const once = !!opts.once;
  const signal = opts.signal;
  if (signal && signal.aborted) {
    return;
  }
  const listeners = listenersOf(this, type);
  if (listeners.has(listener)) {
    return;
  }
  listeners.set(listener, { once });
  if (signal) {
    signal.addEventListener(
      "abort",
      () => this.removeEventListener(type, listener),
      { once: true },
    );
  }
};

EventTarget.prototype.dispatchEvent = function dispatchEvent(event) {
  process.nextTick(() => {
    const listeners = listenersOf(this, event.type);
    const snapshot = [...listeners];

    const dummyListener = this["on" + event.type];
    if (typeof dummyListener === "function") {
      snapshot.push([dummyListener, { once: false }]);
    }

    snapshot.forEach(([listener, { once }]) => {
      // A listener removed by an earlier one in this dispatch is skipped.
      if (listener !== dummyListener && !listeners.has(listener)) {
        return;
      }
      if (once) {
        listeners.delete(listener);
      }
      if (
        typeof listener === "object" &&
        typeof listener.handleEvent === "function"
      ) {
        listener.handleEvent(event);
      } else {
        listener.call(this, event);
      }
    });
  });
};

EventTarget.prototype.removeEventListener = function removeEventListener(
  type,
  listener,
) {
  listenersOf(this, type).delete(listener);
};

module.exports = EventTarget;
