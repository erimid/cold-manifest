// The game event bus (DECISIONS D-003): the sim announces what happened, and
// anything may listen. The AI's line selector, crew memories, the run log,
// auto-pause, audio and the run summary are all listeners. Pure and DOM-free.

export function createEventBus() {
  const listeners = new Map(); // type -> Set of functions

  return {
    /**
     * Listen for one event type, or '*' for every event.
     * A '*' listener is called with (payload, type). Returns a function that stops listening.
     */
    on(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
      return () => listeners.get(type)?.delete(fn);
    },
    /** Tell every listener, in the order they subscribed. */
    emit(type, payload = {}) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn(payload, type);
      for (const fn of [...(listeners.get('*') ?? [])]) fn(payload, type);
    },
    /** How many listeners a type has (for tests and the debug panel). */
    count(type) {
      return listeners.get(type)?.size ?? 0;
    },
  };
}
