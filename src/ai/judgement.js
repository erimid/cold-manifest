// Margo's judgement (S2.10, D-070; brief §9): her trust in the captain, the
// risk check she runs on every order, and what happens when she objects.
// DOM-free.
//
// Every order passes her on its way to being carried out. Most she lets by.
// A risky one she argues with; a monstrous one she refuses, a few times a
// run. Either way the order is held, not dropped: the captain overrides with
// one tap (`captain.override`), which costs trust, or stands down
// (`captain.standDown`), which earns a little. A held order nobody answers
// lapses after OBJECTION_SECONDS.
//
// She only objects to what she can see and say. With no power to her core
// she is silent, and the order goes through. With high trust she lets a
// risky order by without a word; she still refuses a monstrous one.
//
// The risks are hard-coded here until S3.3 gives them to the condition
// language; S5.3 adds her opinions of the crew, withholding and lying.

import { BREATHABLE_O2 } from '../sim/atmosphere.js';
import { aiCoreStatus } from '../sim/power.js';
import { roomView } from '../sim/senses.js';
import { SPACE } from '../sim/systems.js';

const TICKS = 20; // per second (DECISIONS D-002)

/** Trust runs 0 to 100. What moves it, and where she stops arguing. */
export const TRUST = Object.freeze({
  start: 50,
  goesAlong: 70, // at or above this she lets a risky order by without a word
  overrideArgument: -4,
  overrideRefusal: -15,
  heardArgument: 1, // standing down when she argued
  heardRefusal: 3, // standing down when she refused
  deathAfterOverride: -8, // someone she warned about died of it
  fightWon: 2,
});
/** How many orders she will flatly refuse in one run (brief §9: "a few"). After that she only argues. */
export const REFUSALS_PER_RUN = 3;
/** How long a held order waits for the captain before it lapses. */
export const OBJECTION_SECONDS = 20;
/** Once overridden, she does not raise the same thing again for this long. */
export const WAIVE_SECONDS = 30;
/** A death this soon after an override, of someone she named, is laid at the captain's door. */
export const BLAME_SECONDS = 90;
/** A fire this big is one she will not see anyone walk into without a suit. */
export const BIG_FIRE = 0.7;
/** Air this thin, or a hole in the hull, makes cutting life support a risk to anyone standing in it. */
export const THIN_AIR = 0.5;

/** The risks she knows, and whether each is monstrous (refused) or only risky (argued). */
export const RISKS = Object.freeze({
  jettison_crew: { grave: true },
  vent_crew: { grave: true },
  vent_near: { grave: false },
  air_cut: { grave: false },
  into_fire: { grave: false },
  into_vacuum: { grave: false },
});

export function newJudgementState() {
  return {
    trust: TRUST.start,
    refusals: 0, // orders flatly refused this run
    objections: 0, // orders held this run, argued or refused
    objection: null, // the order being held: { n, kind, risk, room, crew, key, command, tick, expires }
    waived: {}, // risk key -> tick until which she will not raise it again
    overrides: [], // recent overrides, for blame: { tick, crew: [ids] }
  };
}

const oursIn = (sim, roomId) => Object.values(sim.state.crew).filter((member) => member.alive && member.owner === 'player' && member.room === roomId && member.task !== 'crossing');
const ids = (crew) => crew.map((member) => member.id);

/**
 * What is wrong with this order, as she sees it: { id, grave, room, crew } with
 * the crew it endangers, or null if she sees nothing wrong.
 */
export function riskOf(sim, cmd) {
  const { state, layout } = sim;
  const found = (id, room, crew) => ({ id, grave: RISKS[id].grave, room, crew: ids(crew) });
  if (cmd.type === 'room.jettison') {
    const inside = oursIn(sim, cmd.room);
    return inside.length ? found('jettison_crew', cmd.room, inside) : null;
  }
  if (cmd.type === 'door.set') {
    const door = layout.door(cmd.door);
    if (cmd.state !== 'open' || !door?.airlock || state.doors[cmd.door].state === 'open') return null;
    const bare = (roomId) => oursIn(sim, roomId).filter((member) => !member.suit);
    const inside = bare(door.a);
    if (inside.length) return found('vent_crew', door.a, inside);
    // Nobody in the room itself: but an open door lets the next room empty with it.
    for (const exit of layout.exits(door.a)) {
      if (exit.to === SPACE || !(state.doors[exit.door].openness > 0)) continue;
      const beside = bare(exit.to);
      if (beside.length) return found('vent_near', exit.to, beside);
    }
    return null;
  }
  if (cmd.type === 'power.add') {
    if (cmd.system !== 'life_support' || cmd.delta !== -1 || state.systems.life_support.power !== 1) return null;
    for (const room of layout.rooms) {
      const r = state.rooms[room.id];
      if (r.jettisoned || !(r.breach > 0 || r.oxygen < THIN_AIR)) continue;
      const gasping = oursIn(sim, room.id).filter((member) => !member.suit);
      if (gasping.length) return found('air_cut', room.id, gasping);
    }
    return null;
  }
  if (cmd.type === 'crew.move') {
    const member = state.crew[cmd.crew];
    if (cmd.ship === 'them' || !member?.alive || member.owner !== 'player' || member.suit || member.room === cmd.room) return null;
    if (!state.rooms[cmd.room]) return null;
    const view = roomView(sim, cmd.room);
    if (!view.live) return null; // she cannot see in, so she has nothing to say
    if (view.fire >= BIG_FIRE) return found('into_fire', cmd.room, [member]);
    if (view.oxygen < BREATHABLE_O2) return found('into_vacuum', cmd.room, [member]);
    return null;
  }
  return null;
}

function changeTrust(sim, by, reason) {
  const ai = sim.state.ai;
  const from = ai.trust;
  ai.trust = Math.max(0, Math.min(100, from + by));
  if (ai.trust !== from) sim.events.emit('ai.trust', { from, to: ai.trust, reason, tick: sim.state.tick });
}

/**
 * An order on its way to being carried out. Returns true if she is holding
 * it: the caller must then not apply it.
 */
export function considerOrder(sim, cmd) {
  // She objects in words: with no line library (a bare test sim) or no power to her core there is nobody to object.
  if (cmd.type.startsWith('debug.') || !sim.lines.length || aiCoreStatus(sim).state === 'offline') return false;
  const risk = riskOf(sim, cmd);
  if (!risk) return false;
  const ai = sim.state.ai;
  const { tick } = sim.state;
  const key = `${risk.id}:${risk.room}:${cmd.crew ?? ''}`;
  if ((ai.waived[key] ?? 0) > tick) return false;
  const expires = tick + OBJECTION_SECONDS * TICKS;
  if (ai.objection?.key === key) {
    // The same order again while she is still holding it: she has said her piece once.
    ai.objection.expires = expires;
    return true;
  }
  let kind;
  if (risk.grave && ai.refusals < REFUSALS_PER_RUN) kind = 'refuse';
  else if (risk.grave || ai.trust < TRUST.goesAlong) kind = 'argue';
  else return false;
  if (kind === 'refuse') ai.refusals += 1;
  ai.objections += 1;
  const { id: _id, ...command } = cmd;
  ai.objection = { n: ai.objections, kind, risk: risk.id, room: risk.room, crew: risk.crew, key, command, tick, expires };
  const news = { n: ai.objection.n, kind, risk: risk.id, room: risk.room, crew: risk.crew[0], crewAll: risk.crew, order: cmd.type, tick };
  sim.events.emit('ai.objected', news);
  sim.events.emit(kind === 'refuse' ? 'ai.refused' : 'ai.argued', news);
  return true;
}

/** The captain overrides: hand back the held order to be carried out. Null if she is holding nothing. */
export function takeObjection(sim) {
  const held = sim.state.ai.objection;
  sim.state.ai.objection = null;
  return held;
}

/** The held order has been carried out over her objection. */
export function overrode(sim, held) {
  const ai = sim.state.ai;
  const { tick } = sim.state;
  ai.waived[held.key] = tick + WAIVE_SECONDS * TICKS;
  for (const key of Object.keys(ai.waived)) if (ai.waived[key] <= tick) delete ai.waived[key];
  ai.overrides = ai.overrides.filter((entry) => tick - entry.tick < BLAME_SECONDS * TICKS);
  ai.overrides.push({ tick, crew: held.crew });
  changeTrust(sim, held.kind === 'refuse' ? TRUST.overrideRefusal : TRUST.overrideArgument, 'override');
  sim.events.emit('captain.overrode', { n: held.n, kind: held.kind, risk: held.risk, grave: RISKS[held.risk].grave, room: held.room, crew: held.crew[0], crewAll: held.crew, tick });
}

/** The captain thinks better of it. */
export function standDown(sim) {
  const held = takeObjection(sim);
  if (!held) return;
  changeTrust(sim, held.kind === 'refuse' ? TRUST.heardRefusal : TRUST.heardArgument, 'heard');
  sim.events.emit('captain.stood_down', { n: held.n, kind: held.kind, risk: held.risk, room: held.room, crew: held.crew[0], crewAll: held.crew, tick: sim.state.tick });
}

/** One tick: an objection nobody answered lapses, and the order with it. */
export function stepJudgement(sim) {
  const held = sim.state.ai.objection;
  if (!held || sim.state.tick < held.expires) return;
  sim.state.ai.objection = null;
  sim.events.emit('ai.objection.lapsed', { n: held.n, kind: held.kind, risk: held.risk, tick: sim.state.tick });
}

/** What happens elsewhere that moves her trust. Called once when the sim is created. */
export function attachJudgement(sim) {
  sim.events.on('fight.won', () => changeTrust(sim, TRUST.fightWon, 'fight'));
  sim.events.on('crew.died', (event) => {
    const { overrides } = sim.state.ai;
    const at = overrides.findIndex((entry) => entry.crew.includes(event.crew) && sim.state.tick - entry.tick < BLAME_SECONDS * TICKS);
    if (at < 0) return;
    overrides.splice(at, 1);
    changeTrust(sim, TRUST.deathAfterOverride, 'death');
  });
}

/** A word for how far she trusts the captain, for the debug panel and later the UI. */
export function trustWord(trust) {
  return trust >= TRUST.goesAlong ? 'goes along' : trust >= 40 ? 'wary' : trust >= 20 ? 'curt' : 'cold';
}

/** Judgement problems that should never happen. */
export function checkJudgementInvariants(sim) {
  const problems = [];
  const ai = sim.state.ai;
  if (!(ai.trust >= 0 && ai.trust <= 100)) problems.push(`AI trust is ${ai.trust}`);
  if (!(ai.refusals >= 0 && ai.refusals <= REFUSALS_PER_RUN)) problems.push(`the AI has refused ${ai.refusals} orders`);
  if (ai.objection && !RISKS[ai.objection.risk]) problems.push(`the AI is holding an order over "${ai.objection.risk}"`);
  if (ai.objection && ai.objection.expires - sim.state.tick > OBJECTION_SECONDS * TICKS) problems.push('a held order expires too far ahead');
  return problems;
}
