// Choices come back (F.5, D-230 to D-234): every flag an event sets is read by something later, ports take
// notice of what a crossing left behind, and losses bite: spoiled cargo, injured hands off their stations.

import assert from 'node:assert/strict';
import test from 'node:test';

import { flagsIn, validateContent } from '../src/engine/content-schema.js';
import { readContentFiles } from '../tools/lib/load-content.js';
import { contractCrates, settlement, spoilCargo } from '../src/sim/contracts.js';
import { describeTask } from '../src/sim/crew.js';
import { SPOIL } from '../src/sim/hold.js';
import { checkNotices, portHere, takeNotice } from '../src/sim/port.js';
import { portView } from '../src/sim/runflow.js';
import { INJURED, holderOf, operatorOf } from '../src/sim/stations.js';
import { TICK_RATE, checkInvariants, createSim } from '../src/sim/sim.js';
import { CATALOG, CREW, EVENTS, SHIP, content, fly, nearestPort } from './helpers.js';

const REACH = content.require('sectors', 'the-reach');
const PORTS = content.all('ports');
const portSim = (seed = 'stakes', contract = 'courier-cold-chain') => createSim({ seed, ship: SHIP, crew: CREW, ...CATALOG, sector: REACH, run: { pursuit: false }, contract: content.require('contracts', contract), ports: PORTS });
const flag = (sim, name, value = true) => (sim.state.run.flags[name] = value);

test('every flag the content sets is read by something, and every flag read is set by something', () => {
  const set = new Set();
  const read = new Set();
  for (const type of ['events', 'ai-lines', 'ports', 'refusals', 'risks', 'memories', 'contracts']) {
    for (const item of content.all(type)) for (const [name, how] of flagsIn(item)) (how === 'set' ? set : read).add(name);
  }
  assert.ok(set.size >= 10, `${set.size} flags set`);
  for (const name of set) assert.ok(read.has(name), `${name} is set and read`);
  for (const name of read) assert.ok(set.has(name), `${name} is read and set`);
});

test('the checker refuses a flag nothing reads and a flag nothing sets', () => {
  const files = readContentFiles();
  const transit = files.find((file) => file.path.endsWith('events/transit.json'));
  const event = structuredClone(transit.data.items.find((item) => item.id === 'mess.fight'));
  event.id = 'test.flags';
  event.choices[0].outcomes[0].effects = [{ do: 'flag', name: 'never_read' }];
  event.when = { fact: 'flag', name: 'never_set' };
  const extra = { path: 'events/test.json', data: { items: [event] } };
  const { errors } = validateContent([...files, extra]);
  assert.ok(errors.some((error) => /sets the flag "never_read", which nothing reads/.test(error)), errors.join('\n'));
  assert.ok(errors.some((error) => /reads the flag "never_set", which nothing sets/.test(error)), errors.join('\n'));
  assert.deepEqual(validateContent(files).errors, []);
});

test('a port takes notice once a run: the Receivers pay for the boy in the brig, and the port screen says so', () => {
  const sim = portSim();
  assert.ok(portHere(sim));
  flag(sim, 'stowaway_brig');
  const money = sim.state.money;
  const given = takeNotice(sim);
  assert.deepEqual(given.map((note) => note.id), ['receivers-bounty']);
  assert.equal(sim.state.money, money + 150);
  assert.equal(sim.state.run.flags.stowaway_brig, 0, 'he is off the ship');
  assert.match(portView(sim).notes[0], /Receivers clerk/);
  flag(sim, 'stowaway_brig');
  assert.deepEqual(takeNotice(sim), [], 'given once a run');
  assert.deepEqual(portView(sim).notes, []);
});

test('docking at a port gives its notices: a wedged load costs the dock gang', () => {
  const sim = portSim('stakes dock');
  flag(sim, 'hold_wedged');
  sim.state.money = 500;
  const notices = [];
  sim.events.on('port.notice', (event) => notices.push(event.notice));
  fly(sim, nearestPort(sim));
  assert.deepEqual(notices, ['dock-gang-wedge']);
  assert.equal(sim.state.money, 500 - 40);
  assert.equal(sim.state.run.flags.hold_wedged, 0);
  assert.deepEqual(checkInvariants(sim), []);
});

test('the checker reads a port notice like an event: a when, some words and effects that exist', () => {
  assert.deepEqual(checkNotices([{ id: 'a', when: { fact: 'flag', name: 'x' }, text: 'Words.', effects: [{ do: 'money', add: 5 }] }]), []);
  assert.match(checkNotices([{ id: 'a', text: 'Words.' }]).join('\n'), /needs a "when"/);
  assert.match(checkNotices([{ id: 'a', when: { fact: 'flag', name: 'x' }, text: 'W.', effects: [{ do: 'explode' }] }]).join('\n'), /explode/);
  assert.match(checkNotices([{ id: 'a', when: { fact: 'flag', name: 'x' }, text: 'W.' }, { id: 'a', when: { fact: 'flag', name: 'x' }, text: 'W.' }]).join('\n'), /used twice/);
});

test('a crate left in a fire is spoiled, and the drop pays nothing for it', () => {
  const sim = portSim('spoil');
  const crates = contractCrates(sim);
  assert.ok(crates.length >= 2);
  const before = settlement(sim);
  const crate = crates[0];
  sim.enqueue({ type: 'debug.room', room: crate.room, set: { fire: 0.8 } });
  for (let i = 0; i < (SPOIL.seconds + 2) * TICK_RATE && !crate.spoiled; i++) {
    sim.state.rooms[crate.room].fire = 0.8;
    sim.step();
  }
  assert.ok(crate.spoiled, 'spoiled by the fire');
  const after = settlement(sim);
  assert.equal(after.spoiled, crates.filter((one) => one.room === crate.room).length);
  assert.ok(after.earned < before.earned);
  assert.equal(after.clean, false);
});

test('the contract.spoil effect spoils the crates in its room first', () => {
  const sim = portSim('spoil effect');
  const crates = contractCrates(sim);
  const room = crates.at(-1).room;
  assert.equal(spoilCargo(sim, { count: 1, room }), 1);
  assert.ok(crates.find((crate) => crate.spoiled).room === room);
  assert.equal(settlement(sim).spoiled, 1);
});

test('a badly hurt hand cannot stand a station: it falls to Margo until they mend', () => {
  const sim = createSim({ seed: 'hurt', ship: SHIP, crew: CREW, ...CATALOG });
  sim.step();
  const station = Object.keys(sim.state.stations).find((id) => operatorOf(sim, id));
  const member = operatorOf(sim, station);
  assert.ok(member, 'someone is on a station');
  member.health = INJURED - 0.05;
  sim.step();
  assert.equal(operatorOf(sim, station), null);
  assert.equal(holderOf(sim, station), 'margo');
  assert.equal(describeTask(sim, member), 'Too badly hurt to stand a station');
  member.health = 0.9;
  sim.step();
  assert.equal(operatorOf(sim, station)?.id, member.id);
});

test('a load wedged stays put; unwedged, it can come adrift again', () => {
  const shifted = EVENTS.find((event) => event.id === 'hold.shifted');
  assert.equal(shifted.once, false);
  assert.deepEqual(shifted.when, { not: { fact: 'flag', name: 'hold_wedged' } });
  for (const id of ['airplant.choking', 'galley.raided', 'checkpoint.head-count', 'mess.grudge', 'hold.rations', 'sensors.jumpy']) {
    const event = EVENTS.find((one) => one.id === id);
    assert.ok(event, id);
    assert.ok(JSON.stringify(event.when).includes('"flag"') || JSON.stringify(event.when).includes('event.met'), `${id} follows a choice`);
  }
});
