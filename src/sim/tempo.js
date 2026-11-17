// The tempo of a crossing (H.8, D-207): how fast ship time runs against real
// time. Nothing here changes the simulation: the clock (engine/clock.js) runs
// more fixed ticks a real second, and every tick is the same tick it would be
// at normal speed, so a seed plays out the same whatever the tempo was.
//
// Time runs at normal speed whenever something is going on: a ship that has
// noticed us or brushed us with its beam (F.1), a situation aboard, a decision on the table, a boarding, rounds or
// drones in the air, a fire or a hole we know about, bad space that strikes the
// hull, the run into port, or being in port at all. Once all of that has been
// quiet for TEMPO.settle real seconds it eases up to TEMPO.fast over
// TEMPO.ease seconds; the moment anything happens it drops straight back to
// normal. Pause is unchanged (D-020): a paused clock runs nothing at any tempo.
// Pure and DOM-free: the game and the autoplay both use it.

import { liveContacts } from './encounters.js';
import { laneNow, riskOf } from './sector.js';

/** Fast time: how many times normal speed, how long things must be quiet first, and how long it takes to get there (real seconds). */
export const TEMPO = Object.freeze({ fast: 4, settle: 3, ease: 2 });

/** Do we know of a fire or a hole in this room? What nobody can see is what they last saw. */
function known(sim, id) {
  const seen = sim.state.seen?.[id];
  const r = sim.state.rooms[id];
  if (r.jettisoned) return false;
  if (!seen || seen.live) return r.fire > 0 || r.breach > 0;
  return seen.fire > 0 || seen.breach > 0;
}

/**
 * Why time must run at normal speed right now, or null if it may run fast. In words, for the clock's
 * tooltip and the tests: the first thing that applies.
 */
export function busyReason(sim) {
  const run = sim.state.run;
  const c = run?.crossing;
  if (!c) return 'in port';
  if (c.phase !== 'under way') return 'off the port';
  if (c.stalled) return 'out of fuel';
  if (run.events?.open) return 'a decision is on the table';
  if (run.events?.aboard.length) return 'something is happening aboard';
  if (sim.state.boarding) return 'a ship is clamped to our airlock';
  // A ship that has not noticed us does not hold the clock (F.1, D-216): time slows the moment its beam brushes us.
  if (liveContacts(sim).some((contact) => (contact.track?.shown || contact.state === 'alongside') && (contact.state !== 'unseen' || contact.aware > 0))) return 'a ship is hunting us';
  if (sim.state.shots.some((shot) => shot.at === 'us') || sim.state.scope.drones.length || sim.state.scope.pods?.length) return 'we are under fire';
  if (sim.layout.rooms.some((room) => known(sim, room.id))) return 'fire or a hole aboard';
  if (riskOf(run, laneNow(run))?.strikes) return 'bad space';
  return null;
}

/**
 * A tempo for one clock. `step(sim, realSeconds, enabled)` is called once a frame with the real time since the
 * last; it returns the multiple of normal speed to run this frame at, 1 to TEMPO.fast. `enabled: false` (the
 * player's setting) holds it at normal speed.
 */
export function createTempo({ fast = TEMPO.fast, settle = TEMPO.settle, ease = TEMPO.ease } = {}) {
  let quiet = 0; // real seconds things have been quiet
  let rate = 1;
  let reason = 'in port';
  return {
    get rate() {
      return rate;
    },
    /** Why it is at normal speed, or null when it is quiet (and running fast, or getting there). */
    get reason() {
      return reason;
    },
    get fast() {
      return rate > 1;
    },
    step(sim, realSeconds, enabled = true) {
      reason = enabled ? busyReason(sim) : 'fast time is off';
      if (reason) {
        quiet = 0;
        rate = 1;
      } else {
        quiet += Math.max(0, realSeconds);
        rate = quiet <= settle ? 1 : 1 + (fast - 1) * Math.min(1, (quiet - settle) / Math.max(1e-9, ease));
      }
      return rate;
    },
    /** Back to normal speed at once, and the quiet starts over (a new run, the port, a pause). */
    reset() {
      quiet = 0;
      rate = 1;
    },
  };
}
