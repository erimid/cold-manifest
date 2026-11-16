// The top-level screen state machine (title, hub, map, ship view, ...).
// Pure logic: states are plain objects with optional enter/exit/update hooks.

export function createStateMachine(states, { onChange } = {}) {
  let current = null;
  let currentName = null;

  const machine = {
    get state() {
      return currentName;
    },
    has(name) {
      return Object.prototype.hasOwnProperty.call(states, name);
    },
    /** Leave the current state and enter `name`. `params` is passed to enter(). */
    go(name, params = {}) {
      if (!machine.has(name)) throw new Error(`Unknown state "${name}"`);
      const from = currentName;
      current?.exit?.({ to: name });
      currentName = name;
      current = states[name];
      current.enter?.({ from, params, machine });
      onChange?.({ from, to: name, params });
    },
    /** Called once per rendered frame with the frame time in seconds. */
    update(dt) {
      current?.update?.(dt);
    },
  };
  return machine;
}
