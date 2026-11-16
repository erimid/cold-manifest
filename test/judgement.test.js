// Margo's judgement (S2.10): her risk check, holding an order, the captain's
// override, standing down, trust, and the limits on all of it.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { OBJECTION_SECONDS, REFUSALS_PER_RUN, TRUST, WAIVE_SECONDS, riskOf } from '../src/ai/judgement.js';
import { TICK_RATE, checkInvariants } from '../src/sim/sim.js';
import { content, newCrewedSim, newTalkingSim } from './helpers.js';

/** The fire she will not see anyone walk into unsuited, as her rule in content/ has it. */
const BIG_FIRE = content.require('risks', 'into_fire').when.find((cond) => cond.fact === 'seen.fire').gte;

const seconds = (sim, s) => {
  for (let i = 0; i < Math.round(s * TICK_RATE); i++) sim.step();
};
const give = (sim, ...commands) => {
  for (const command of commands) sim.enqueue(command);
  sim.step();
};
/** A talking sim a tick in, with Ilse on the bridge, Dace in the reactor and Okoro in quarters. */
const started = (seed) => {
  const sim = newTalkingSim(seed);
  sim.step();
  return sim;
};
const OPEN_DORSAL = { type: 'door.set', door: 'airlock_dorsal', state: 'open' }; // the hatch out of quarters, where Okoro stands
const lastLine = (sim) => sim.state.ai.log.at(-1);

test('she refuses to open a room to space with someone in it, and says who and where', () => {
  const sim = started();
  const heard = [];
  for (const type of ['ai.objected', 'ai.refused', 'ai.argued', 'command.held']) sim.events.on(type, (event) => heard.push([type, event]));
  give(sim, OPEN_DORSAL);
  assert.equal(sim.state.doors.airlock_dorsal.state, 'closed', 'the order was not carried out');
  assert.deepEqual(heard.map(([type]) => type), ['ai.objected', 'ai.refused', 'command.held']);
  const held = sim.state.ai.objection;
  assert.equal(held.kind, 'refuse');
  assert.equal(held.risk, 'vent_crew');
  assert.deepEqual(held.crew, ['okoro']);
  assert.equal(sim.state.ai.refusals, 1);
  // She cuts across her own greeting to say it, in a line that names the person and the room.
  seconds(sim, 0.2);
  assert.equal(lastLine(sim).category, 'refusal');
  assert.match(lastLine(sim).text, /Okoro/);
  assert.match(lastLine(sim).text, /Quarters and mess/);
  assert.deepEqual(checkInvariants(sim), []);
});

test('the captain overrides with one order: it is carried out, trust drops, and she says so', () => {
  const sim = started();
  give(sim, OPEN_DORSAL);
  const events = [];
  sim.events.on('captain.overrode', (event) => events.push(event));
  give(sim, { type: 'captain.override' });
  assert.equal(sim.state.doors.airlock_dorsal.state, 'open');
  assert.equal(sim.state.ai.objection, null);
  assert.equal(sim.state.ai.trust, TRUST.start + TRUST.overrideRefusal);
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'refuse');
  seconds(sim, 0.2);
  assert.equal(lastLine(sim).category, 'override');
  assert.equal(sim.whyNot({ type: 'captain.override' }), 'Margo is not holding any order of yours');
  // Okoro dies of it, and that is laid at the captain's door as well.
  seconds(sim, 40);
  assert.equal(sim.state.crew.okoro.alive, false);
  assert.equal(sim.state.ai.trust, TRUST.start + TRUST.overrideRefusal + TRUST.deathAfterOverride);
  assert.deepEqual(checkInvariants(sim), []);
});

test('standing down drops the order and earns a little trust', () => {
  const sim = started();
  give(sim, OPEN_DORSAL);
  give(sim, { type: 'captain.standDown' });
  assert.equal(sim.state.doors.airlock_dorsal.state, 'closed');
  assert.equal(sim.state.ai.objection, null);
  assert.equal(sim.state.ai.trust, TRUST.start + TRUST.heardRefusal);
  seconds(sim, 0.2);
  assert.equal(lastLine(sim).category, 'order_confirm', 'she stops mid-refusal to acknowledge it');
});

test('a held order nobody answers lapses, and the same order asked twice is refused once', () => {
  const sim = started();
  give(sim, OPEN_DORSAL);
  seconds(sim, 5);
  give(sim, OPEN_DORSAL);
  assert.equal(sim.state.ai.refusals, 1, 'asking again while she holds it does not use up another refusal');
  assert.equal(sim.state.ai.objections, 1);
  let lapsed = 0;
  sim.events.on('ai.objection.lapsed', () => (lapsed += 1));
  seconds(sim, OBJECTION_SECONDS + 1);
  assert.equal(lapsed, 1);
  assert.equal(sim.state.ai.objection, null);
  assert.equal(sim.state.doors.airlock_dorsal.state, 'closed');
  assert.equal(sim.state.ai.trust, TRUST.start, 'letting it lapse costs and earns nothing');
});

test('she refuses a few times a run, and after that can only argue', () => {
  const sim = started();
  for (let i = 0; i < REFUSALS_PER_RUN; i++) {
    give(sim, OPEN_DORSAL);
    assert.equal(sim.state.ai.objection.kind, 'refuse');
    give(sim, { type: 'captain.standDown' });
  }
  give(sim, OPEN_DORSAL);
  assert.equal(sim.state.ai.objection.kind, 'argue');
  assert.equal(sim.state.ai.refusals, REFUSALS_PER_RUN);
  seconds(sim, 0.2);
  assert.equal(lastLine(sim).category, 'argument');
  give(sim, { type: 'captain.override' });
  assert.equal(sim.state.ai.trust, TRUST.start + REFUSALS_PER_RUN * TRUST.heardRefusal + TRUST.overrideArgument);
});

test('she argues before sending someone into a big fire without a suit, and not otherwise', () => {
  const sim = started();
  sim.state.rooms.medbay.fire = BIG_FIRE + 0.2;
  sim.step();
  const move = { type: 'crew.move', crew: 'okoro', room: 'medbay' };
  assert.equal(riskOf(sim, move).id, 'into_fire');
  give(sim, move);
  assert.equal(sim.state.ai.objection.kind, 'argue');
  assert.equal(sim.state.crew.okoro.goal, null, 'he has not been sent');
  // Overridden, he goes; and she does not raise the same thing again straight away.
  give(sim, { type: 'captain.override' });
  assert.equal(sim.state.crew.okoro.goal, 'medbay');
  assert.equal(sim.state.ai.trust, TRUST.start + TRUST.overrideArgument);
  give(sim, { type: 'crew.move', crew: 'okoro', room: 'quarters' }, move);
  assert.equal(sim.state.ai.objection, null);
  assert.ok(WAIVE_SECONDS > 0);

  // In a suit there is nothing to argue about.
  const suited = started('suit');
  suited.state.rooms.medbay.fire = BIG_FIRE + 0.2;
  suited.state.crew.okoro.suit = true;
  suited.step();
  give(suited, move);
  assert.equal(suited.state.ai.objection, null);
  assert.equal(suited.state.crew.okoro.goal, 'medbay');

  // A small fire is the crew's job.
  const small = started('small');
  small.state.rooms.medbay.fire = 0.2;
  small.step();
  assert.equal(riskOf(small, move), null);
});

test('with high trust she lets a risky order by, but still refuses a monstrous one', () => {
  const sim = started();
  sim.state.rooms.medbay.fire = BIG_FIRE + 0.2;
  give(sim, { type: 'debug.ai', trust: TRUST.goesAlong });
  give(sim, { type: 'crew.move', crew: 'okoro', room: 'medbay' });
  assert.equal(sim.state.ai.objection, null);
  assert.equal(sim.state.crew.okoro.goal, 'medbay');
  give(sim, { type: 'room.jettison', room: 'sensors' }); // nobody in it: nothing to say
  assert.equal(sim.state.rooms.sensors.jettisoned, true);
  give(sim, { type: 'crew.move', crew: 'ilse', room: 'bridge' });
  assert.equal(sim.state.ai.objection, null);
});

test('jettisoning an occupied room is refused; cutting the air on someone in a breach and venting next to an open door are argued', () => {
  const sim = started();
  // Okoro is in quarters, which can be cut loose.
  assert.deepEqual(riskOf(sim, { type: 'room.jettison', room: 'quarters' }), { id: 'jettison_crew', grave: true, room: 'quarters', crew: ['okoro'] });
  give(sim, { type: 'room.jettison', room: 'quarters' });
  assert.equal(sim.state.ai.objection.kind, 'refuse');
  assert.equal(sim.state.rooms.quarters.jettisoned, false);
  give(sim, { type: 'captain.standDown' });

  // The air plant about to be stood down, and Dace standing in a holed room.
  sim.state.rooms.reactor.breach = 0.5;
  const cut = { type: 'station.stand', station: 'life_support', down: true };
  assert.equal(riskOf(sim, cut).id, 'air_cut');
  assert.deepEqual(riskOf(sim, cut).crew, ['dace']);
  sim.state.crew.dace.suit = true;
  assert.equal(riskOf(sim, cut), null, 'suited, Dace has air of his own');

  // The aft airlock opens the engines; with the door to the reactor open, the reactor empties too.
  sim.state.crew.dace.suit = false;
  const door = sim.layout.doors.find((d) => [d.a, d.b].includes('engines') && [d.a, d.b].includes('reactor'));
  assert.ok(door, 'engines and reactor share a door');
  const vent = { type: 'door.set', door: 'airlock_aft', state: 'open' };
  assert.equal(riskOf(sim, vent), null);
  sim.state.doors[door.id].openness = 1;
  assert.deepEqual(riskOf(sim, vent), { id: 'vent_near', grave: false, room: 'reactor', crew: ['dace'] });
});

test('she cannot object to what she cannot see, or with her core dark, or with no voice at all', () => {
  // An airless room nobody can see into: she has nothing to say about walking into it. (A big fire lights its own room.)
  const blind = started();
  blind.state.stations.sensors.down = true;
  blind.state.rooms.medbay.lightsOn = false;
  seconds(blind, 2);
  blind.state.rooms.medbay.oxygen = 0;
  blind.step();
  assert.equal(blind.state.seen.medbay.live, false);
  const move = { type: 'crew.move', crew: 'okoro', room: 'medbay' };
  assert.equal(riskOf(blind, move), null);
  blind.state.rooms.medbay.lightsOn = true;
  seconds(blind, 1);
  blind.state.rooms.medbay.oxygen = 0;
  blind.step();
  assert.equal(riskOf(blind, move).id, 'into_vacuum');

  // The AI core stood down: the order goes straight through.
  const dark = started();
  dark.state.stations.ai_core.down = true;
  give(dark, OPEN_DORSAL);
  assert.equal(dark.state.ai.objection, null);
  assert.equal(dark.state.doors.airlock_dorsal.state, 'open');

  // A sim built with no line library has no Margo to argue: every older test relies on this.
  const mute = newCrewedSim();
  mute.step();
  give(mute, OPEN_DORSAL);
  assert.equal(mute.state.doors.airlock_dorsal.state, 'open');
});

test('an override whose order no longer makes sense is dropped, and holding an order survives a snapshot', () => {
  const sim = started();
  give(sim, { type: 'room.jettison', room: 'quarters' });
  const snap = sim.snapshot();
  const twin = started();
  twin.restore(snap);
  assert.deepEqual(twin.state.ai.objection, sim.state.ai.objection);
  // The quarters door is opened while they argue: the room is no longer sealed.
  const door = sim.layout.exits('quarters').find((exit) => exit.to !== 'space');
  sim.state.doors[door.door].openness = 1;
  const dropped = [];
  sim.events.on('command.dropped', (event) => dropped.push(event.reason));
  give(sim, { type: 'captain.override' });
  assert.equal(sim.state.rooms.quarters.jettisoned, false);
  assert.equal(dropped.length, 1);
  assert.equal(sim.state.ai.trust, TRUST.start, 'nothing was done, so nothing is held against the captain');
});
