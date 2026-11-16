// The simulation root. DOM-free (DECISIONS D-001): this file and everything it
// imports must run in plain Node, because tools/autoplay.js runs it headless.
//
// Two rules hold for everything that is ever added here (DECISIONS D-003):
//   1. The sim changes only inside step(). Nothing else may touch `state`.
//   2. The outside world talks to the sim only through enqueue(command), and
//      hears back only through the event bus.
// Together these make pause exact (the clock simply stops calling step) and
// let the autoplay bot use the same interface as a player.
//
// S1.2: the clock, command queue and event bus are real. The "probes" are a
// stand-in for crew: movable markers in an empty test bay, so that orders,
// pause and interpolation can be proven before the ship exists. They are
// replaced by rooms (S1.3) and crew (S1.6).

import { createEventBus } from '../engine/events.js';
import { createRngSet } from '../engine/rng.js';

/** Sim ticks per second (DECISIONS D-002). */
export const TICK_RATE = 20;
/** Seconds of game time per tick. */
export const TICK_SECONDS = 1 / TICK_RATE;

/** The test bay's size in world units, and how fast a probe moves. */
export const BAY = Object.freeze({ width: 1000, height: 600, probeRadius: 24, probeSpeed: 220 });

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/**
 * Every order the sim accepts. `check` returns a reason string when the order
 * makes no sense (and it is then rejected at enqueue time); `apply` carries it
 * out at the start of a tick.
 */
const COMMANDS = {
  'probe.move': {
    check(state, cmd) {
      if (!state.probes.some((p) => p.id === cmd.probe)) return `no probe "${cmd.probe}"`;
      if (!Number.isFinite(cmd.x) || !Number.isFinite(cmd.y)) return 'needs a numeric x and y';
      return null;
    },
    apply(sim, cmd) {
      const probe = sim.state.probes.find((p) => p.id === cmd.probe);
      probe.tx = clamp(cmd.x, BAY.probeRadius, BAY.width - BAY.probeRadius);
      probe.ty = clamp(cmd.y, BAY.probeRadius, BAY.height - BAY.probeRadius);
      probe.moving = true;
    },
  },
};

function stepProbes(sim) {
  const stride = BAY.probeSpeed * TICK_SECONDS;
  for (const probe of sim.state.probes) {
    // Remember where it was, so the renderer can draw between ticks.
    probe.px = probe.x;
    probe.py = probe.y;
    if (!probe.moving) continue;
    const dx = probe.tx - probe.x;
    const dy = probe.ty - probe.y;
    const distance = Math.hypot(dx, dy);
    if (distance <= stride) {
      probe.x = probe.tx;
      probe.y = probe.ty;
      probe.moving = false;
      sim.events.emit('probe.arrived', { probe: probe.id, x: probe.x, y: probe.y, tick: sim.state.tick });
    } else {
      probe.x += (dx / distance) * stride;
      probe.y += (dy / distance) * stride;
    }
  }
}

function stepDrift(sim) {
  // A seeded value that must stay in bounds: proves replay. Goes when the reactor exists (S1.4).
  const roll = sim.rng.stream('events').range(-1, 1);
  sim.state.reactorDrift = clamp(sim.state.reactorDrift + roll, -10, 10);
}

/** Everything that happens each tick, in order. Later sessions add systems here. */
const SYSTEMS = [stepProbes, stepDrift];

function startingProbes() {
  return [1, 2, 3].map((n) => {
    const x = 180 + (n - 1) * 130;
    const y = 300;
    return { id: `probe-${n}`, x, y, px: x, py: y, tx: x, ty: y, moving: false };
  });
}

export function createSim({ seed }) {
  const sim = {
    state: {
      seed: String(seed),
      tick: 0,
      nextCommandId: 1,
      commands: [], // orders waiting for the next tick
      reactorDrift: 0,
      probes: startingProbes(),
    },
    rng: createRngSet(seed),
    events: createEventBus(),

    /**
     * Give an order. It is carried out at the start of the next tick, so an
     * order given while paused simply waits. Returns the order's id.
     * Throws if the order is unknown or makes no sense.
     */
    enqueue(command) {
      const handler = COMMANDS[command?.type];
      if (!handler) throw new Error(`Unknown command "${command?.type}"`);
      const problem = handler.check(sim.state, command);
      if (problem) throw new Error(`Bad ${command.type} command: ${problem}`);
      const id = sim.state.nextCommandId++;
      sim.state.commands.push({ ...command, id });
      return id;
    },

    /** Advance the simulation by exactly one tick. Only the clock (or a headless tool) calls this. */
    step() {
      const { state } = sim;
      state.tick += 1;
      const orders = state.commands;
      state.commands = [];
      for (const command of orders) {
        // The world may have changed since the order was given; skip orders that no longer make sense.
        const problem = COMMANDS[command.type].check(state, command);
        if (problem) {
          sim.events.emit('command.dropped', { command, reason: problem, tick: state.tick });
          continue;
        }
        COMMANDS[command.type].apply(sim, command);
        sim.events.emit('command.applied', { command, tick: state.tick });
      }
      for (const system of SYSTEMS) system(sim);
    },

    /** Game time in seconds. */
    get time() {
      return sim.state.tick * TICK_SECONDS;
    },

    /** Everything needed to restore this exact moment (DECISIONS D-011). */
    snapshot() {
      return { state: structuredClone(sim.state), rng: sim.rng.getState() };
    },
    restore(snap) {
      for (const key of Object.keys(sim.state)) delete sim.state[key];
      Object.assign(sim.state, structuredClone(snap.state));
      sim.rng.setState(snap.rng);
    },
  };
  return sim;
}

/** Problems with a sim state that should never happen. Empty means healthy. */
export function checkInvariants(sim) {
  const problems = [];
  const { state } = sim;
  if (!Number.isInteger(state.tick) || state.tick < 0) problems.push(`tick is ${state.tick}`);
  if (!(state.reactorDrift >= -10 && state.reactorDrift <= 10)) problems.push(`reactorDrift out of bounds: ${state.reactorDrift}`);
  for (const probe of state.probes) {
    const inX = probe.x >= BAY.probeRadius && probe.x <= BAY.width - BAY.probeRadius;
    const inY = probe.y >= BAY.probeRadius && probe.y <= BAY.height - BAY.probeRadius;
    if (!inX || !inY) problems.push(`${probe.id} is outside the bay at ${probe.x}, ${probe.y}`);
  }
  return problems;
}
