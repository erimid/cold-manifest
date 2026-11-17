// The tempo of a crossing (H.8, D-207): how fast ship time runs against real
// time. Nothing here changes the simulation: the clock (engine/clock.js) runs
// more fixed ticks a real second, and every tick is the same tick it would be
// at normal speed, so a seed plays out the same whatever the tempo was.
//
// Time runs at normal speed whenever something has noticed us or waits for an
// answer (F.3, D-223): a ship that has noticed us or brushed us with its beam
// (F.1), a situation aboard, a decision on the table, a boarding, rounds or
// drones in the air, a fire or a hole we know about, a hit a moment ago, a fix
// nobody can take or a jump that is ready, or being in port at all. Bad space and
// the sensors working on a fix no longer hold it: nothing in them asks the
// captain anything until something hits. Once all of that has been quiet for
// TEMPO.settle real seconds it eases up to TEMPO.fast over TEMPO.ease seconds;
// the moment anything happens it drops straight back to normal.
//
// "On to the next thing" (F.3): while it is quiet the captain can skip ahead at
// TEMPO.skip until the next sighting on the scope or anything that holds the
// clock. Pause is unchanged (D-020): a paused clock runs nothing at any tempo.
// Pure and DOM-free: the game and the autoplay both use it.

import { canFix } from './combat.js';
import { liveContacts } from './encounters.js';

/**
 * Fast time: how many times normal speed, how long things must be quiet first, and how long it takes to get there
 * (real seconds); how fast "on to the next thing" runs; and how long a hit holds the clock (real seconds).
 */
export const TEMPO = Object.freeze({ fast: 8, settle: 1, ease: 1, skip: 40, struck: 4 });

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
  if (c.stalled) return 'out of fuel';
  if (run.events?.open) return 'a decision is on the table';
  if (run.events?.aboard.length) return 'something is happening aboard';
  if (sim.state.boarding) return 'a ship is clamped to our airlock';
  // A ship that has not noticed us does not hold the clock (F.1, D-216): time slows the moment its beam brushes us.
  if (liveContacts(sim).some((contact) => (contact.track?.shown || contact.state === 'alongside') && (contact.state !== 'unseen' || contact.aware > 0))) return 'a ship is hunting us';
  if (sim.state.shots.some((shot) => shot.at === 'us') || sim.state.scope.drones.length || sim.state.scope.pods?.length) return 'we are under fire';
  if (sim.layout.rooms.some((room) => known(sim, room.id))) return 'fire or a hole aboard';
  // Off the port (F.3): the sensors working on the fix is waiting, not a question. A fix nobody can take, or one
  // that is ready, is: the captain has to put someone at the helm or make the jump.
  if (c.phase === 'off port') {
    if (sim.state.fix >= 1) return 'the jump is ready';
    if (!canFix(sim)) return 'nobody can take a fix';
  }
  return null;
}

/** The contacts showing on the scope, by id: a new one is a sighting, and ends a skip. */
const shownIds = (sim) => new Set(sim.state.scope.contacts.filter((contact) => contact.track?.shown && contact.state !== 'lost').map((contact) => contact.id));

/**
 * A tempo for one clock. `step(sim, realSeconds, enabled)` is called once a frame with the real time since the
 * last; it returns the multiple of normal speed to run this frame at, 1 to TEMPO.fast (TEMPO.skip while skipping).
 * `enabled: false` (the player's setting) holds it at normal speed, but a skip the captain asks for still runs.
 */
export function createTempo({ fast = TEMPO.fast, settle = TEMPO.settle, ease = TEMPO.ease, skipRate = TEMPO.skip, struck = TEMPO.struck } = {}) {
  let quiet = 0; // real seconds things have been quiet
  let rate = 1;
  let reason = 'in port';
  let hull = null; // the hull's points last frame: a drop is a hit
  let hit = 0; // real seconds a hit still holds the clock
  let skipping = null; // while skipping: the contacts that were already on the scope
  let skipped = null; // why the last skip stopped
  /** Why it must be normal speed, or null: the sim's reasons, then a hit a moment ago. */
  function why(sim, realSeconds) {
    const points = sim.state.hull.points;
    if (hull !== null && points < hull) hit = struck;
    else hit = Math.max(0, hit - Math.max(0, realSeconds));
    hull = points;
    return busyReason(sim) ?? (hit > 0 ? 'we have been hit' : null);
  }
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
    /** Skipping on to the next thing right now? */
    get skipping() {
      return skipping !== null;
    },
    /** Why the last skip stopped (what came up), or null. */
    get skipped() {
      return skipped;
    },
    /** Can the captain skip on to the next thing right now? Only on a quiet crossing. */
    canSkip(sim) {
      return skipping === null && why(sim, 0) === null;
    },
    /**
     * On to the next thing (F.3): run at TEMPO.skip until a new return shows on the scope or anything holds the
     * clock. Returns false (and does nothing) when something already does.
     */
    skip(sim) {
      if (why(sim, 0) !== null) return false;
      skipping = shownIds(sim);
      skipped = null;
      return true;
    },
    /** Stop skipping (the captain pressed it again, or paused). */
    stopSkip() {
      skipping = null;
    },
    step(sim, realSeconds, enabled = true) {
      const busy = why(sim, realSeconds);
      if (skipping !== null) {
        // A return we had not seen when the skip began; one that fades and comes back is not new.
        const sighted = [...shownIds(sim)].some((id) => !skipping.has(id));
        if (busy || sighted) {
          skipped = busy ?? 'a ship on the scope';
          skipping = null;
        }
      }
      if (skipping !== null) {
        reason = null;
        quiet = settle + ease;
        rate = skipRate;
        return rate;
      }
      reason = enabled ? busy : 'fast time is off';
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
      skipping = null;
    },
  };
}
