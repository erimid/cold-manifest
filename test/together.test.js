// Trouble at the same time (F.4, D-226 to D-229): situations aboard give us away to a hunting ship, a hunting ship
// sets things off aboard, and the lane's dice lean towards the two together.

import assert from 'node:assert/strict';
import test from 'node:test';

import { JOLTS, checkEvent, joltEvent, openEvent } from '../src/narrative/events.js';
import { readingOf } from '../src/sim/encounters.js';
import { TOGETHER, hunting } from '../src/sim/sector.js';
import { SIGNATURE, sense, signature, troubleAboard } from '../src/sim/senses.js';
import { checkInvariants, createSim } from '../src/sim/sim.js';
import { CATALOG, CREW, EVENTS, SHIP, castOff, content, dealWith, nearestPort } from './helpers.js';

const REACH = content.require('sectors', 'the-reach');

/** A sim under way on a quiet lane: no ships, no lane dice, no follower. */
function underWay(seed = 'together') {
  const sim = createSim({ seed, ship: SHIP, crew: CREW, ...CATALOG, sector: REACH, events: EVENTS, encounters: content.all('encounters'), run: { pursuit: false } });
  for (const [id, risk] of Object.entries(sim.state.run.risks)) sim.state.run.risks[id] = { ...risk, contacts: 0, aboard: 0, strikes: undefined };
  sim.state.run.events.rolled.push(...sim.state.run.map.nodes.map((node) => node.id));
  castOff(sim, nearestPort(sim));
  return sim;
}
const placedId = (sim) => sim.state.run.events.aboard.at(-1);

test('the six F.4 situations are in content: each set off by a ping or a shot, loud, and passing its own check', () => {
  const jolted = EVENTS.filter((event) => event.jolt);
  assert.ok(jolted.length >= 6, `${jolted.length} situations a hunting ship can set off`);
  for (const kind of JOLTS) assert.ok(jolted.some((event) => event.jolt.includes(kind)), `something is set off by a ${kind}`);
  for (const event of jolted) assert.ok(event.loud, `${event.id} gives something off`);
  for (const id of ['cargo.leak', 'mess.fight', 'hold.stowaway']) assert.ok(EVENTS.find((event) => event.id === id).loud, `${id} gives something off`);
});

test('the checker reads loud and jolt, and refuses them where they cannot be', () => {
  const base = { id: 'test.loud', title: 'T', text: 'T.', sign: 'S.', place: { room: 'cargo' }, choices: [{ id: 'go', label: 'Go', outcomes: [{ text: 'Done.' }] }] };
  assert.deepEqual(checkEvent({ ...base, loud: { noise: 0.5, heat: 0.2 }, jolt: ['ping'] }), []);
  assert.match(checkEvent({ ...base, loud: { noise: 2 } }).join('\n'), /loud.noise must be a number from 0 to 1/);
  assert.match(checkEvent({ ...base, loud: { smell: 1 } }).join('\n'), /unknown key "smell"|smell/);
  assert.match(checkEvent({ ...base, jolt: ['cough'] }).join('\n'), /jolt: unknown "cough"/);
  assert.match(checkEvent({ ...base, place: 'radio', sign: undefined, jolt: ['ping'] }).join('\n'), /loud and jolt are for a situation aboard/);
});

test('trouble nobody has seen to gives us away: its room is louder, and a hunting ship reads us better, until it is dealt with', () => {
  const sim = underWay('loud');
  for (let i = 0; i < 40; i++) sim.step();
  const quiet = signature(sim);
  assert.equal(quiet.trouble, 0);
  assert.ok(openEvent(sim, 'mess.fight', { force: true }));
  const one = placedId(sim);
  for (let i = 0; i < 5; i++) sim.step();
  assert.equal(troubleAboard(sim).noise, 0.8);
  assert.ok(sim.state.rooms[one.room].noise >= 0.8 - 1e-9, `the fight is heard in ${one.room}`);
  assert.ok(sense(sim, one.room).noise >= 0.8 - 1e-9);
  const loud = signature(sim);
  assert.ok(loud.total >= quiet.total + SIGNATURE.trouble * 0.8 - 0.02, `${quiet.total.toFixed(3)} to ${loud.total.toFixed(3)}`);
  sim.enqueue({ type: 'debug.contact', encounter: 'patrol-cutter', range: 40, bearing: 0 });
  sim.step();
  const contact = sim.state.scope.contacts[0];
  assert.ok(readingOf(sim, contact, loud.total) > readingOf(sim, contact, quiet.total), 'a hunting ship reads us better');
  dealWith(sim, one.n);
  assert.equal(signature(sim).trouble, 0, 'dealt with, it gives nothing off');
  assert.deepEqual(checkInvariants(sim), []);
});

test('a ping sets off what a ping sets off, a shot what a shot does; never off a lane, never one already met, and the brig only with somebody in it', () => {
  const sim = underWay('jolt');
  const pinged = joltEvent(sim, 'ping');
  assert.ok(pinged, 'a ping set something off');
  assert.ok(EVENTS.find((event) => event.id === pinged).jolt.includes('ping'));
  assert.notEqual(pinged, 'brig.hammering', 'nobody is in the brig');
  dealWith(sim, placedId(sim).n);
  const shot = joltEvent(sim, 'shot');
  assert.ok(EVENTS.find((event) => event.id === shot).jolt.includes('shot'));
  dealWith(sim, placedId(sim).n);
  // Everything a ping can set off but the brig is met now; with the stowaway locked up, it is the brig's turn.
  for (let i = 0; i < 6; i++) {
    const id = joltEvent(sim, 'ping');
    if (!id) break;
    assert.notEqual(id, 'brig.hammering');
    dealWith(sim, placedId(sim).n);
  }
  sim.state.run.flags = { ...(sim.state.run.flags ?? {}), stowaway_brig: 1 };
  assert.equal(joltEvent(sim, 'ping'), 'brig.hammering');
  // In port nothing is set off.
  const port = createSim({ seed: 'port', ship: SHIP, crew: CREW, ...CATALOG, sector: REACH, events: EVENTS, run: { pursuit: false } });
  assert.equal(joltEvent(port, 'ping'), null);
});

test('a ship that pings us under way can set trouble off aboard, through the bus', () => {
  let opened = 0;
  for (let seed = 0; seed < 30 && !opened; seed++) {
    const sim = underWay(`ping ${seed}`);
    const seen = [];
    sim.events.on('situation.jolted', (event) => seen.push(event));
    for (let i = 0; i < 20; i++) sim.events.emit('contact.pinged', { contact: 1, found: true, tick: sim.state.tick });
    opened += seen.length;
    if (seen.length) assert.equal(seen[0].by, 'ping');
  }
  assert.ok(opened > 0);
  assert.ok(TOGETHER.ping > 0 && TOGETHER.ping < 1 && TOGETHER.shot > 0 && TOGETHER.shot < 1);
});

test('hunting: a ship whose beam has brushed us, or that has noticed us, counts; one that has not does not', () => {
  const sim = underWay('hunting');
  assert.equal(hunting(sim), false);
  sim.enqueue({ type: 'debug.contact', encounter: 'raider-skiff', range: 50, bearing: 10, miss: 30 });
  sim.step();
  const contact = sim.state.scope.contacts[0];
  contact.state = 'unseen';
  contact.aware = 0;
  assert.equal(hunting(sim), false, 'on its own course');
  contact.aware = 0.1;
  assert.equal(hunting(sim), true, 'brushed');
  assert.ok(TOGETHER.aboard > 1 && TOGETHER.contacts > 1, 'the lane leans both ways');
});
