// The input layer (brief §4). This is the only file in the game that listens
// to raw pointer or keyboard events. Everything else asks it what happened.
//
// It is built on Pointer Events, so mouse, touch and pen all arrive the same
// way. What it does with a press depends on where the press started:
//
//   On a DOM control   The control gets it, and only the control. A tap on a
//                      panel can never also hit a room underneath, because
//                      the canvas is told nothing about it.
//   On other DOM UI    Swallowed (a panel's background is not the ship).
//   On the canvas      Turned into canvas events: tap, drag, info, hover.
//
// Events, via on(type, fn):
//   tap        { x, y, pointerType }                  a quick press and release
//   dragstart  { x, y, startX, startY, dx, dy, ... }  the pointer moved past the tap threshold
//   drag       (same)                                 each move while dragging
//   dragend    (same, plus cancelled)
//   info       { x, y, pointerType, source }          long-press, or right-click: the touch
//                                                     stand-in for right-click and hover info
//   hover      { x, y }                               mouse only; nothing may depend on it
//   gesture    {}                                     any touch, click or key: the moment sound may start
//   press      { control }                            a DOM control was pressed
//   key        { action, code, shift }                     a mapped key from keymap.js
// Canvas coordinates are CSS pixels from the canvas's top-left corner.

import { createGestureTracker, TAP_SLOP } from './gesture.js';
import { KEYMAP } from './keymap.js';

export function createInput({ canvas, keymap = KEYMAP, root = window } = {}) {
  const listeners = new Map();
  const pressHandlers = new WeakMap(); // DOM control -> function
  const tracker = createGestureTracker();
  let press = null; // the press in progress: { zone, pointerId, ... }
  let longPressTimer = null;

  function emit(type, payload) {
    for (const fn of [...(listeners.get(type) ?? [])]) fn(payload);
  }

  function canvasPoint(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  /** The nearest DOM control (an element given to press()) at or above `node`. */
  function controlAt(node) {
    for (let el = node; el && el !== document; el = el.parentNode) {
      if (pressHandlers.has(el)) return el;
    }
    return null;
  }

  function clearLongPress() {
    if (longPressTimer !== null) clearTimeout(longPressTimer);
    longPressTimer = null;
  }

  function forward(events) {
    for (const event of events) {
      if (event.type === 'longpress') emit('info', { x: event.x, y: event.y, pointerType: event.pointerType, source: 'long-press' });
      else emit(event.type, event);
    }
  }

  function endPress() {
    press?.control?.classList.remove('is-pressed');
    press = null;
    clearLongPress();
  }

  /** Drop the press in progress without firing anything. */
  function abandon() {
    const wasCanvas = press?.zone === 'canvas';
    const pointerId = press?.pointerId;
    endPress();
    if (wasCanvas) forward(tracker.cancel(pointerId));
  }

  function onPointerDown(event) {
    if (press) {
      // One pointer at a time. A second mouse press means the first release was lost
      // (it happened outside the window), so start over rather than stay stuck.
      if (event.pointerType !== 'mouse' || press.pointerType === 'touch') return;
      abandon();
    }
    const control = controlAt(event.target);

    if (control) {
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      press = { zone: 'ui', pointerId: event.pointerId, pointerType: event.pointerType, control, startX: event.clientX, startY: event.clientY };
      if (!control.disabled) control.classList.add('is-pressed');
      return;
    }

    if (event.target !== canvas) {
      // Some other part of the DOM UI. Track it so the release is swallowed too.
      press = { zone: 'none', pointerId: event.pointerId, pointerType: event.pointerType };
      return;
    }

    const point = canvasPoint(event);
    if (event.pointerType === 'mouse' && event.button === 2) {
      emit('info', { ...point, pointerType: 'mouse', source: 'right-click' });
      return;
    }
    if (event.pointerType === 'mouse' && event.button !== 0) return;

    press = { zone: 'canvas', pointerId: event.pointerId, pointerType: event.pointerType };
    tracker.down({ pointerId: event.pointerId, pointerType: event.pointerType || 'mouse', ...point, t: event.timeStamp });
    const wait = tracker.longPressDue - event.timeStamp;
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      forward(tracker.poll(Infinity));
    }, wait);
  }

  function onPointerMove(event) {
    if (!press) {
      if (event.pointerType === 'mouse' && event.target === canvas) emit('hover', canvasPoint(event));
      return;
    }
    if (press.pointerId !== event.pointerId || press.zone !== 'canvas') return;
    const events = tracker.move({ pointerId: event.pointerId, ...canvasPoint(event) });
    if (events.length) clearLongPress();
    forward(events);
  }

  function onPointerUp(event) {
    if (!press || press.pointerId !== event.pointerId) return;
    const current = press;

    if (current.zone === 'canvas') {
      clearLongPress();
      const events = tracker.up({ pointerId: event.pointerId, ...canvasPoint(event), t: event.timeStamp });
      endPress();
      forward(events);
      return;
    }

    endPress();
    if (current.zone !== 'ui' || current.control.disabled) return;
    // A control fires only if the pointer barely moved and was released on the same control.
    const moved = Math.hypot(event.clientX - current.startX, event.clientY - current.startY);
    const slop = (TAP_SLOP[current.pointerType] ?? TAP_SLOP.mouse) * 2;
    const releasedOn = controlAt(document.elementFromPoint(event.clientX, event.clientY));
    if (moved <= slop && releasedOn === current.control) {
      emit('press', { control: current.control });
      pressHandlers.get(current.control)?.({ pointerType: current.pointerType, control: current.control });
    }
  }

  function onPointerCancel(event) {
    if (press && press.pointerId === event.pointerId) abandon();
  }

  function onKeyDown(event) {
    emit('gesture', {});
    if (event.repeat || event.ctrlKey || event.metaKey || event.altKey) return;
    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;

    // Enter presses the focused control, for keyboard-only play.
    if (event.code === 'Enter' || event.code === 'NumpadEnter') {
      const control = controlAt(el);
      if (control && !control.disabled) {
        event.preventDefault();
        emit('press', { control });
        pressHandlers.get(control)({ pointerType: 'keyboard', control });
      }
      return;
    }

    const action = keymap[event.code];
    if (!action) return;
    event.preventDefault(); // Space must pause, never scroll the page or re-press a focused button
    emit('key', { action, code: event.code, shift: event.shiftKey });
  }

  function onContextMenu(event) {
    // Right-click and long-press are ours (they show info); keep the browser's menu out of the game.
    if (event.target === canvas || controlAt(event.target)) event.preventDefault();
  }

  const options = { passive: false };
  // Browsers differ on which events count as the player's permission to start sound; offer them all.
  const onGesture = () => emit('gesture', {});
  for (const type of ['pointerdown', 'pointerup', 'touchend', 'click']) root.addEventListener(type, onGesture, { capture: true, passive: true });
  root.addEventListener('pointerdown', onPointerDown, options);
  root.addEventListener('pointermove', onPointerMove, options);
  root.addEventListener('pointerup', onPointerUp, options);
  root.addEventListener('pointercancel', onPointerCancel, options);
  root.addEventListener('keydown', onKeyDown, options);
  root.addEventListener('contextmenu', onContextMenu, options);
  root.addEventListener('blur', abandon);

  return {
    /** Listen for an input event. Returns a function that stops listening. */
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type)?.delete(fn);
    },
    /**
     * Make a DOM element a control: `fn` runs when it is tapped or clicked, or
     * when it has focus and Enter is pressed. Use this instead of click listeners.
     */
    press(element, fn) {
      pressHandlers.set(element, fn);
      return element;
    },
    /** Stop listening to everything (for tests and hot reload). */
    destroy() {
      endPress();
      tracker.cancel();
      for (const type of ['pointerdown', 'pointerup', 'touchend', 'click']) root.removeEventListener(type, onGesture, { capture: true });
      root.removeEventListener('pointerdown', onPointerDown, options);
      root.removeEventListener('pointermove', onPointerMove, options);
      root.removeEventListener('pointerup', onPointerUp, options);
      root.removeEventListener('pointercancel', onPointerCancel, options);
      root.removeEventListener('keydown', onKeyDown, options);
      root.removeEventListener('contextmenu', onContextMenu, options);
      root.removeEventListener('blur', abandon);
    },
  };
}
