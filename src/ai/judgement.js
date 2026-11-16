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
// The risks themselves are content (content/risks/; S3.3, D-110),
// written in the condition language: this file asks them about each order.
// A sim given no rules has a Margo with nothing to object to. S5.3 adds her
// opinions of the crew, withholding and lying.

import { crewMatching, match, vars } from '../narrative/conditions.js';
import { RISK_ROOMS } from '../narrative/rules.js';
import { aiCoreStatus } from '../sim/power.js';

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
  slipped: 2, // a ship that was after us went away without getting what it came for
});
/** Ways an encounter ends that count as getting away with it (encounters.js ENDINGS): the ship was after us and left with nothing. */
const SLIPPED = new Set(['quiet', 'outrun', 'decoy', 'bluff', 'deterred']);
/** How many orders she will flatly refuse in one run (brief §9: "a few"). After that she only argues. */
export const REFUSALS_PER_RUN = 3;
/** How long a held order waits for the captain before it lapses. */
export const OBJECTION_SECONDS = 20;
/** Once overridden, she does not raise the same thing again for this long. */
export const WAIVE_SECONDS = 30;
/** A death this soon after an override, of someone she named, is laid at the captain's door. */
export const BLAME_SECONDS = 90;
export function newJudgementState() {
  return {
    trust: TRUST.start,
    refusals: 0, // orders flatly refused this run
    objections: 0, // orders held this run, argued or refused
    objection: null, // the order being held: { n, kind, risk, grave, room, crew, key, command, tick, expires }
    waived: {}, // risk key -> tick until which she will not raise it again
    overrides: [], // recent overrides, for blame: { tick, crew: [ids] }
  };
}

/**
 * What is wrong with this order, as she sees it: { id, grave, room, crew } with
 * the crew it endangers, or null if she sees nothing wrong. Each risk rule looks
 * at the rooms it names, in turn, for one where its condition holds and someone
 * fits its `crew`; the first rule to find anyone is the risk.
 */
export function riskOf(sim, cmd) {
  for (const rule of sim.rules?.risks ?? []) {
    if (rule.on !== cmd.type) continue;
    for (const room of RISK_ROOMS[rule.rooms](sim, cmd)) {
      const ctx = { sim, vars: vars({ order: ['data', cmd], room: ['room', room] }) };
      if (!match(rule.when, ctx)) continue;
      const crew = crewMatching(rule.crew, ctx);
      if (crew.length) return { id: rule.id, grave: rule.grave, room, crew: crew.map((member) => member.id) };
    }
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
  ai.objection = { n: ai.objections, kind, risk: risk.id, grave: risk.grave, room: risk.room, crew: risk.crew, key, command, tick, expires };
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
  sim.events.emit('captain.overrode', { n: held.n, kind: held.kind, risk: held.risk, grave: held.grave, room: held.room, crew: held.crew[0], crewAll: held.crew, tick });
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
  sim.events.on('encounter.ended', (event) => SLIPPED.has(event.outcome) && changeTrust(sim, TRUST.slipped, 'slipped'));
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
  if (ai.objection && !sim.rules?.risk[ai.objection.risk]) problems.push(`the AI is holding an order over "${ai.objection.risk}"`);
  if (ai.objection && ai.objection.expires - sim.state.tick > OBJECTION_SECONDS * TICKS) problems.push('a held order expires too far ahead');
  return problems;
}
