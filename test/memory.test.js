// Crew memory, nerve in the dark, and the orders they refuse (S2.10).

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { killCrew, harmCrew } from '../src/sim/atmosphere.js';
import { DREAD, MEMORY_MAX, darkMemory, recall, refusalOf, remember, topMemory } from '../src/sim/memory.js';
import { TICK_RATE, checkInvariants } from '../src/sim/sim.js';
import { createIntercom, replyKind } from '../src/ui/intercom.js';
import { CATALOG, CREW, SHIP, content, newCrewedSim, newTalkingSim } from './helpers.js';

/** How long each kind of memory lasts, from content/. */
const MEMORY_SECONDS = Object.fromEntries(content.all('memories').map((rule) => [rule.id, rule.seconds]));

const seconds = (sim, s) => {
  for (let i = 0; i < Math.round(s * TICK_RATE); i++) sim.step();
};
const give = (sim, ...commands) => {
  for (const command of commands) sim.enqueue(command);
  sim.step();
};
/** Ilse on the bridge, Dace in the reactor, Okoro in quarters. */
const started = () => {
  const sim = newCrewedSim();
  sim.step();
  return sim;
};
const refusals = (sim) => {
  const heard = [];
  sim.events.on('crew.refused', (event) => heard.push(event));
  return heard;
};

test('a death is remembered by everyone left, and keeps them out of that room while it is still bad', () => {
  const sim = started();
  const heard = refusals(sim);
  sim.state.rooms.medbay.fire = 0.3;
  sim.state.crew.okoro.room = 'medbay';
  killCrew(sim, 'okoro', 'fire');
  for (const id of ['ilse', 'dace']) {
    const memory = recall(sim, sim.state.crew[id], 'death');
    assert.deepEqual({ type: memory.type, room: memory.room, who: memory.who }, { type: 'death', room: 'medbay', who: 'Okoro' });
  }
  assert.equal(sim.state.crew.okoro.memories.length, 0, 'the dead remember nothing');
  assert.equal(topMemory(sim, sim.state.crew.dace), 'Okoro dying in Medbay');

  give(sim, { type: 'crew.move', crew: 'dace', room: 'medbay' });
  assert.equal(heard.length, 1);
  assert.equal(heard[0].rule, 'grave');
  assert.equal(heard[0].reason, "Dace won't go back into Medbay. Not after what happened to Okoro.");
  assert.equal(sim.state.crew.dace.goal, null, 'he has not moved');
  assert.equal(sim.state.crew.dace.task, 'idle');

  // The fire is out and the lamps are on: it is only a room again.
  sim.state.rooms.medbay.fire = 0;
  give(sim, { type: 'crew.move', crew: 'dace', room: 'medbay' });
  assert.equal(heard.length, 1);
  assert.equal(sim.state.crew.dace.goal, 'medbay');
  assert.deepEqual(checkInvariants(sim), []);
});

test('someone burned will not walk into a fire without a suit; someone who ran out of air will not go where it is thin', () => {
  const sim = started();
  const heard = refusals(sim);
  sim.state.rooms.reactor.fire = 0.4;
  harmCrew(sim, 'dace', 0.6, 'fire'); // drops him below half: that is what gets remembered
  assert.equal(recall(sim, sim.state.crew.dace, 'burn').room, 'reactor');
  sim.state.rooms.reactor.fire = 0;
  sim.state.rooms.life_support.fire = 0.3;
  give(sim, { type: 'crew.move', crew: 'dace', room: 'life_support' });
  assert.equal(heard.at(-1).reason, "Dace won't walk into the fire in Life support without a suit. Not after the burns from Reactor.");
  // Ilse has no such memory, and goes. Dace goes too, once he has a suit on.
  give(sim, { type: 'crew.move', crew: 'ilse', room: 'life_support' });
  assert.equal(sim.state.crew.ilse.goal, 'life_support');
  give(sim, { type: 'crew.suit', crew: 'dace', on: true }, { type: 'crew.move', crew: 'dace', room: 'life_support' });
  assert.equal(sim.state.crew.dace.goal, 'life_support');
  assert.equal(heard.length, 1);

  const thin = started();
  const said = refusals(thin);
  harmCrew(thin, 'okoro', 0.6, 'suffocation');
  thin.state.rooms.medbay.oxygen = 0.3;
  give(thin, { type: 'crew.move', crew: 'okoro', room: 'medbay' });
  assert.equal(said[0].rule, 'choke');
  assert.match(said[0].reason, /^Okoro won't go into Medbay without a suit\. Not after running out of air in Quarters and mess\.$/);
});

test('alone in the dark, nerves go: they put the lamp on, remember it, and will not have it off again for a while', () => {
  const sim = started();
  const events = [];
  for (const type of ['crew.spooked', 'crew.lit', 'room.lights']) sim.events.on(type, (event) => events.push([type, event]));
  give(sim, { type: 'room.lights', room: 'quarters', on: false });
  seconds(sim, DREAD.seconds - 5);
  assert.ok(sim.state.crew.okoro.dread > 0.8, `dread ${sim.state.crew.okoro.dread}`);
  assert.equal(sim.state.rooms.quarters.lightsOn, false);
  seconds(sim, 7);
  assert.equal(sim.state.rooms.quarters.lightsOn, true, 'Okoro put the lamp on');
  assert.deepEqual(events.slice(-3).map(([type]) => type), ['room.lights', 'crew.lit', 'crew.spooked']);
  assert.equal(events.at(-1)[1].lit, true);
  assert.equal(recall(sim, sim.state.crew.okoro, 'scare').room, 'quarters');
  assert.equal(sim.state.crew.okoro.dread, 0);

  // The captain cannot simply switch it off again, alone or with every other lamp.
  assert.equal(sim.whyNot({ type: 'room.lights', room: 'quarters', on: false }), 'Okoro wants the lamp on. Not after the dark in Quarters and mess');
  give(sim, { type: 'lights.all', on: false });
  assert.equal(sim.state.rooms.quarters.lightsOn, true);
  assert.equal(sim.state.rooms.bridge.lightsOn, false);
  assert.equal(sim.whyNot({ type: 'lights.all', on: false }), 'the only lamps left are ones the crew will not sit without');
  seconds(sim, DREAD.hold + 1);
  assert.equal(sim.whyNot({ type: 'room.lights', room: 'quarters', on: false }), null, 'after a while he will stand it again');
  assert.deepEqual(checkInvariants(sim), []);

  // Nobody else was in the dark for long enough... except Ilse and Dace, who have been since the lamps went: they are on the way too.
  assert.ok(sim.state.crew.ilse.dread > 0.5);
});

test('company steadies nerves, light drains dread, and a bad memory of the dark doubles it', () => {
  const sim = started();
  give(sim, { type: 'crew.move', crew: 'dace', room: 'quarters' });
  seconds(sim, 30);
  assert.equal(sim.state.crew.dace.room, 'quarters');
  give(sim, { type: 'room.lights', room: 'quarters', on: false });
  seconds(sim, 30);
  const together = sim.state.crew.okoro.dread;
  assert.ok(Math.abs(together - (30 / DREAD.seconds) * DREAD.company) < 0.02, `dread with company ${together}`);
  give(sim, { type: 'room.lights', room: 'quarters', on: true });
  seconds(sim, DREAD.calm + 1);
  assert.equal(sim.state.crew.okoro.dread, 0);

  const alone = started();
  remember(alone, alone.state.crew.okoro, 'scare', { room: 'cargo' });
  give(alone, { type: 'room.lights', room: 'quarters', on: false });
  seconds(alone, 20);
  assert.ok(Math.abs(alone.state.crew.okoro.dread - (20 / DREAD.seconds) * DREAD.remembered) < 0.03, `dread remembered ${alone.state.crew.okoro.dread}`);
});

test('after a scare they will not go into an unlit room alone, and the refusal names the scare', () => {
  const sim = started();
  const heard = refusals(sim);
  give(sim, { type: 'debug.memory', crew: 'ilse', memory: 'scare', room: 'cargo' });
  assert.equal(darkMemory(sim, sim.state.crew.ilse).room, 'cargo');
  give(sim, { type: 'room.lights', room: 'sensors', on: false });
  seconds(sim, 1);
  give(sim, { type: 'crew.move', crew: 'ilse', room: 'sensors' });
  assert.equal(heard[0].rule, 'dark');
  assert.equal(heard[0].reason, "Ilse won't go into Sensors alone in the dark. Not after the dark in Cargo hold.");
  // With a crewmate already in there, or the lamp on, she goes.
  sim.state.crew.okoro.room = 'sensors';
  assert.equal(refusalOf(sim, sim.state.crew.ilse, 'sensors'), null);
  sim.state.crew.okoro.room = 'quarters';
  give(sim, { type: 'room.lights', room: 'sensors', on: true });
  seconds(sim, 1);
  give(sim, { type: 'crew.move', crew: 'ilse', room: 'sensors' });
  assert.equal(sim.state.crew.ilse.goal, 'sensors');
  assert.equal(heard.length, 1);
});

test('when the captain overrides Margo, the crew remember, and will not walk into danger on the captain\'s word', () => {
  const sim = newTalkingSim();
  sim.step();
  const heard = refusals(sim);
  give(sim, { type: 'room.jettison', room: 'quarters' });
  give(sim, { type: 'captain.override' });
  assert.equal(sim.state.crew.okoro.alive, false);
  // Both survivors remember the death and the override.
  for (const id of ['ilse', 'dace']) assert.deepEqual(sim.state.crew[id].memories.map((entry) => entry.type), ['death', 'override']);
  sim.state.rooms.medbay.fire = 0.7;
  give(sim, { type: 'debug.ai', trust: 100 }); // so Margo lets the order through and it is the crew's turn
  give(sim, { type: 'crew.move', crew: 'ilse', room: 'medbay' });
  assert.equal(heard[0].rule, 'override');
  assert.equal(heard[0].reason, "Ilse won't walk into Medbay on the captain's word. Not after the captain overrode Margo over Quarters and mess.");
});

test('memories fade, the log is short, and a snapshot keeps them', () => {
  const sim = started();
  const ilse = sim.state.crew.ilse;
  remember(sim, ilse, 'burn', { room: 'reactor' });
  seconds(sim, MEMORY_SECONDS.burn - 1);
  assert.ok(recall(sim, ilse, 'burn'));
  const twin = started();
  twin.restore(sim.snapshot());
  assert.deepEqual(twin.state.crew.ilse.memories, ilse.memories);
  seconds(sim, 2);
  assert.equal(recall(sim, ilse, 'burn'), null);
  assert.equal(topMemory(sim, ilse), null);
  for (let i = 0; i < MEMORY_MAX + 5; i++) remember(sim, ilse, 'wound', { room: 'bridge' });
  assert.equal(ilse.memories.length, MEMORY_MAX);
  assert.throws(() => remember(sim, ilse, 'birthday'), /Unknown memory type/);
  assert.deepEqual(checkInvariants(sim), []);
});

test('their crews have no memory and never refuse: only ours do', () => {
  const sim = started();
  give(sim, { type: 'debug.fight', enemy: 'salvager-skiff' });
  const enemy = sim.state.fight.enemy;
  const theirs = Object.values(enemy.crew)[0];
  assert.ok(theirs, 'the skiff has crew');
  theirs.memories.push({ type: 'scare', tick: sim.state.tick, room: theirs.room, who: null, dark: true });
  for (const room of Object.values(enemy.rooms)) Object.assign(room, { lightsOn: false, light: 0 });
  const heard = [];
  sim.events.on('enemy.crew.refused', (event) => heard.push(event));
  seconds(sim, 120);
  assert.equal(heard.length, 0);
  assert.equal(theirs.dread, 0, 'and the dark does not wear on them');
});

test('the intercom carries a refusal and a lamp in their own words', () => {
  assert.equal(replyKind({ crew: 'dace', room: 'cargo', rule: 'grave' }), 'refuse');
  assert.equal(replyKind({ crew: 'dace', room: 'cargo', lamp: true }), 'lamp');
  const replies = Object.fromEntries(content.all('crew').map(({ id, replies: r }) => [id, r]));
  const intercom = createIntercom(replies);
  assert.equal(intercom.reply({ crew: 'dace', room: 'cargo', rule: 'grave' }, 'Cargo hold').text, 'No. Not a chance.');
  assert.equal(intercom.reply({ crew: 'okoro', room: 'cargo', lamp: true }, 'Cargo hold').text, "I've put the light on. I had to.");
  assert.equal(createIntercom({}).reply({ crew: 'x', rule: 'dark' }).text, 'No. Not in there.');
  assert.ok(CREW.length && SHIP && CATALOG);
});
