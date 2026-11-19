// The people-first screen (H.9): what the crew cards and the head of Margo's channel say.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createSim } from '../src/sim/sim.js';
import { CARD_TASKS, crewCardView, heldStations, roomStation, stationCode } from '../src/ui/people.js';
import { CATALOG, CREW, SHIP, newCrewedSim } from './helpers.js';

const step = (sim, n = 1) => {
  for (let i = 0; i < n; i++) sim.step();
};

test('a crew card names them, their role and post, and says what they are doing and how they are', () => {
  const sim = newCrewedSim('people');
  step(sim);
  for (const id of Object.keys(sim.state.crew)) {
    const card = crewCardView(sim, id);
    assert.equal(card.alive, true);
    assert.equal(card.taken, false);
    assert.equal(card.name, sim.state.crew[id].name);
    assert.ok(card.role.length > 1, `${id} has a role`);
    assert.ok(card.post.length > 1, `${id} has a post or "No post"`);
    assert.ok(card.doing.length > 1, `${id} is doing something`);
    assert.equal(card.mood, 'steady', 'a fresh crew is steady');
    assert.equal(card.alarm, false);
    assert.equal(card.health, 1);
  }
});

test('a crew card puts the worst of how they feel first, and marks it', () => {
  const sim = newCrewedSim('people-mood');
  step(sim);
  const [id] = Object.keys(sim.state.crew);
  const member = sim.state.crew[id];
  member.dread = 0.9;
  member.fatigue = 0.95;
  assert.equal(crewCardView(sim, id).mood, 'shaking, exhausted');
  assert.equal(crewCardView(sim, id).alarm, true);
  member.health = 0.2;
  assert.match(crewCardView(sim, id).mood, /^badly hurt/);
  assert.equal(crewCardView(sim, id).flags.hurt, true);
  member.alive = false;
  const dead = crewCardView(sim, id);
  assert.equal(dead.doing, 'Dead');
  assert.equal(dead.alive, false);
  assert.equal(dead.health, 0);
});

test('asleep, eating and at their post read as such; the watch is named only when one is kept', () => {
  const sim = createSim({ seed: 'people-watch', ship: SHIP, crew: CREW, watches: 2, ...CATALOG });
  step(sim);
  const ids = Object.keys(sim.state.crew);
  const member = sim.state.crew[ids[0]];
  assert.match(crewCardView(sim, member.id).watch, /^(First|Second)( · below)?$/);
  assert.match(crewCardView(sim, member.id).watchTag, /^(1st|2nd)$/);
  member.asleep = true;
  assert.equal(crewCardView(sim, member.id).doing, 'Asleep');
  member.asleep = false;
  member.eating = true;
  assert.equal(crewCardView(sim, member.id).doing, 'Eating');
  const bare = newCrewedSim('people-bare');
  step(bare);
  assert.equal(crewCardView(bare, Object.keys(bare.state.crew)[0]).watch, '');
  assert.ok(Object.values(CARD_TASKS).includes('Standing by'));
});

test('a crew member taken off the ship has a card that says so', () => {
  const sim = newCrewedSim('people-taken');
  step(sim);
  const [id] = Object.keys(sim.state.crew);
  delete sim.state.crew[id];
  const card = crewCardView(sim, id);
  assert.equal(card.taken, true);
  assert.equal(card.doing, 'Taken');
  assert.equal(card.alive, false);
});

test("the head of Margo's channel lists the stations she holds, and each opens its room", () => {
  const sim = newCrewedSim('people-held');
  step(sim);
  const { held } = heldStations(sim);
  assert.ok(held.length > 0, 'she holds something with nobody posted');
  for (const item of held) {
    assert.equal(item.code, stationCode(item.id));
    assert.equal(roomStation(sim, item.room), item.id, `${item.id}'s room carries its switches`);
    assert.notEqual(item.id, 'ai_core', 'her own core is not listed');
  }
  sim.enqueue({ type: 'station.stand', station: held[0].id, down: true });
  step(sim);
  assert.ok(!heldStations(sim).held.some((item) => item.id === held[0].id), 'a station stood down is not hers to hold');
});

test('only a room with a station in it carries station switches', () => {
  const sim = newCrewedSim('people-rooms');
  const carrying = sim.layout.rooms.filter((room) => roomStation(sim, room.id)).map((room) => roomStation(sim, room.id));
  assert.ok(carrying.includes('reactor'));
  assert.ok(carrying.includes('helm'));
  assert.ok(carrying.includes('sensors'));
  assert.equal(new Set(carrying).size, carrying.length, 'one room per station');
  const corridor = sim.layout.rooms.find((room) => room.kind === 'corridor');
  if (corridor) assert.equal(roomStation(sim, corridor.id), null);
});
