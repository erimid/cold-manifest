// Turns a stream of pointer down/move/up into taps, drags and long-presses
// (brief §4). Pure and DOM-free so it can be unit tested; input.js feeds it
// real Pointer Events.
//
// One pointer at a time: a second finger is ignored until the first lifts.

/** How far a pointer may wander, in CSS pixels, and still count as a tap. */
export const TAP_SLOP = Object.freeze({ mouse: 6, pen: 8, touch: 12 });
/** Hold this long without moving and it is a long-press (touch's right-click and hover). */
export const LONG_PRESS_MS = 450;

export function createGestureTracker({ slop = TAP_SLOP, longPressMs = LONG_PRESS_MS } = {}) {
  let active = null;

  function base(extra) {
    return {
      pointerType: active.pointerType,
      x: active.x,
      y: active.y,
      startX: active.startX,
      startY: active.startY,
      dx: active.x - active.startX,
      dy: active.y - active.startY,
      ...extra,
    };
  }

  return {
    /** True while a pointer is down and being tracked. */
    get active() {
      return active !== null;
    },
    /** The time at which the current press becomes a long-press, or null. */
    get longPressDue() {
      return active && !active.dragging && !active.longPressed ? active.startT + longPressMs : null;
    },
    /** A pointer went down. Returns false if another pointer is already being tracked. */
    down({ pointerId, pointerType = 'mouse', x, y, t }) {
      if (active) return false;
      active = { pointerId, pointerType, x, y, startX: x, startY: y, startT: t, dragging: false, longPressed: false };
      return true;
    },
    /** The tracked pointer moved. Returns the events this causes. */
    move({ pointerId, x, y }) {
      if (!active || active.pointerId !== pointerId) return [];
      active.x = x;
      active.y = y;
      const events = [];
      if (!active.dragging && !active.longPressed) {
        const limit = slop[active.pointerType] ?? slop.mouse;
        if (Math.hypot(x - active.startX, y - active.startY) > limit) {
          active.dragging = true;
          events.push(base({ type: 'dragstart' }));
        }
      }
      if (active.dragging) events.push(base({ type: 'drag' }));
      return events;
    },
    /** Time passed with the pointer held down. Returns a long-press event when one is due. */
    poll(t) {
      if (!active || active.dragging || active.longPressed) return [];
      if (t - active.startT < longPressMs) return [];
      active.longPressed = true;
      return [base({ type: 'longpress' })];
    },
    /** The tracked pointer lifted. Returns a tap, a dragend, or nothing after a long-press. */
    up({ pointerId, x, y, t }) {
      if (!active || active.pointerId !== pointerId) return [];
      const events = [];
      if (!active.dragging && !active.longPressed && t - active.startT >= longPressMs) {
        // The long-press timer never got a chance to fire; honour it now.
        active.longPressed = true;
        events.push(base({ type: 'longpress' }));
      }
      active.x = x;
      active.y = y;
      if (active.dragging) events.push(base({ type: 'dragend', cancelled: false }));
      else if (!active.longPressed) events.push(base({ type: 'tap', x: active.startX, y: active.startY, dx: 0, dy: 0 }));
      active = null;
      return events;
    },
    /** The system took the pointer away (a call came in, the page scrolled). No tap. */
    cancel(pointerId) {
      if (!active || (pointerId !== undefined && active.pointerId !== pointerId)) return [];
      const events = active.dragging ? [base({ type: 'dragend', cancelled: true })] : [];
      active = null;
      return events;
    },
  };
}
