// Slips (F.7, D-242): what tiredness and hunger make a hand get wrong. DOM-free.
//
// A hand worn down by tiredness or hunger (watches.js `worn`) is slower at
// everything: on a station, at a job and on their feet. They also make
// mistakes. Once a second, a worn hand on a station or at a job (a fire, a
// hole, a repair, a jammed door) may fumble it, with a chance that grows with
// how worn they are. A fumble costs SLIP.seconds of nothing done: a station
// in their hands runs at nothing (the helm does not answer, the sensors go
// blind, the guns do not come ready), work stops, and a repair loses some of
// the progress made on the bar. A fresh, fed hand never slips.

import { operatorOf } from './stations.js';
import { HUNGER, TIRED, fed, tiredness, worn } from './watches.js';

const TICKS = 20;

/**
 * The chance a second of a fumble at the worst (times how worn they are: 1 - worn, at most about 0.55), how long
 * one lasts, the share of a bar's repair it undoes, and the least a worn hand's stride drops to.
 */
export const SLIP = Object.freeze({ rate: 0.03, seconds: 6, setback: 0.3, stride: 0.5 });
/** The jobs a hand can fumble. */
const JOBS = new Set(['extinguish', 'patch', 'repair', 'unjam']);

/** Is this crew member in the middle of a fumble? */
export const slipping = (member) => (member?.slip ?? 0) > 0;

/** Their walking pace for how worn they are: 1 fresh and fed, down towards SLIP.stride. */
export const stride = (member) => 1 - SLIP.stride * (1 - worn(member));

/** The chance a second that this hand fumbles what they are doing. */
export const slipChance = (member) => SLIP.rate * (1 - worn(member));

/** Why a worn hand fumbled: 'tired', 'hungry' or 'tired and hungry'. */
export function slipWhy(member) {
  const tired = (member.fatigue ?? 0) > TIRED.from && tiredness(member) < 1;
  const hungry = (member.hunger ?? 0) > HUNGER.from && fed(member) < 1;
  return tired && hungry ? 'tired and hungry' : hungry ? 'hungry' : 'tired';
}

/** Count down fumbles under way, and once a second give each worn hand at work their chance of one. */
export function stepSlips(sim) {
  const { tick } = sim.state;
  const dice = sim.rng.stream('slips');
  for (const key in sim.state.crew) {
    const member = sim.state.crew[key];
    if (member.slip > 0) {
      member.slip -= 1;
      continue;
    }
    if (!member.alive || member.owner !== 'player' || (tick + member.index * 3) % TICKS !== 0) continue;
    const chance = slipChance(member);
    if (chance <= 0) continue;
    const station = member.post && operatorOf(sim, member.post) === member ? member.post : null;
    const job = !station && JOBS.has(member.task) ? member.task : null;
    if (!station && !job) continue;
    if (!dice.chance(chance)) continue;
    member.slip = SLIP.seconds * TICKS;
    if (job === 'repair') {
      // A repair undoes some of the bar's progress: a dropped part, a wrong cable.
      const room = sim.layout.room(member.room);
      const system = room?.system ? sim.state.systems[room.system] : null;
      if (system && system.repair) system.repair = Math.max(0, system.repair - SLIP.setback);
    }
    sim.events.emit('crew.slipped', { crew: member.id, room: member.room, station, job, why: slipWhy(member), tick });
  }
}

/** Slip problems that should never happen. */
export function checkSlipInvariants(sim) {
  const problems = [];
  for (const member of Object.values(sim.state.crew)) {
    const slip = member.slip ?? 0;
    if (!(Number.isInteger(slip) && slip >= 0 && slip <= SLIP.seconds * TICKS)) problems.push(`crew ${member.id} slip is ${slip}`);
  }
  return problems;
}
