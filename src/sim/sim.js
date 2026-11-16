// The simulation root. DOM-free (DECISIONS D-001): this file and everything it
// imports must run in plain Node, because tools/autoplay.js runs it headless.
//
// S1.1 STUB. This is only enough of a sim to prove the pipeline: a seeded,
// deterministic, serializable state that steps on a fixed tick. S1.2 replaces
// the stepping with the real clock, pause and command queue, and later
// sessions add the ship, crew and hazards.

import { createRngSet } from '../engine/rng.js';

/** Sim ticks per second (DECISIONS D-002). */
export const TICK_RATE = 20;
/** Seconds of game time per tick. */
export const TICK_SECONDS = 1 / TICK_RATE;

export function createSim({ seed }) {
  const rng = createRngSet(seed);
  const state = {
    seed: String(seed),
    tick: 0,
    // Stand-in for real ship state: a value that drifts by seeded rolls and
    // must stay inside its bounds. Removed when the reactor exists (S1.4).
    reactorDrift: 0,
  };

  return {
    state,
    rng,
    /** Advance the simulation by exactly one tick. */
    step() {
      state.tick += 1;
      const roll = rng.stream('events').range(-1, 1);
      state.reactorDrift = Math.max(-10, Math.min(10, state.reactorDrift + roll));
    },
    /** Game time in seconds. */
    get time() {
      return state.tick * TICK_SECONDS;
    },
    /** Everything needed to restore this exact moment (DECISIONS D-011). */
    snapshot() {
      return { state: structuredClone(state), rng: rng.getState() };
    },
    restore(snap) {
      Object.assign(state, structuredClone(snap.state));
      rng.setState(snap.rng);
    },
  };
}

/** Problems with a sim state that should never happen. Empty means healthy. */
export function checkInvariants(sim) {
  const problems = [];
  const { state } = sim;
  if (!Number.isInteger(state.tick) || state.tick < 0) problems.push(`tick is ${state.tick}`);
  if (!(state.reactorDrift >= -10 && state.reactorDrift <= 10)) problems.push(`reactorDrift out of bounds: ${state.reactorDrift}`);
  return problems;
}
