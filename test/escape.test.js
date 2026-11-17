// Every escape costs (fun pass F.2; D-218 to D-222): no answer to a ship on the scope is free or sure. A radar finds
// a dark hull, going dark turns the ship cold and the crew slow, running drinks fuel and leaves a wake for the next
// lane, a lie leaves a mark with the liar's faction, flares are bought at a port, and the scope says what beats what.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { COLD, chillOf } from '../src/sim/cold.js';
import { BLUFF_COST, HELM, contactView, readingOf, tellsOf, validateEncounter } from '../src/sim/encounters.js';
import { RUNNING } from '../src/sim/sector.js';
import { rating } from '../src/sim/stations.js';
import { TICK_RATE, checkInvariants, createSim } from '../src/sim/sim.js';
import { CATALOG, CREW, SHIP, content, flyCrossing, nearestPort, castOff } from './helpers.js';

const ENCOUNTERS = content.all('encounters');
const SECTOR = content.require('sectors', 'the-reach');
const PORTS = content.all('ports');
const defOf = (id) => ENCOUNTERS.find((def) => def.id === id);
const newSim = (seed = 'escape', extra = {}) => createSim({ seed, ship: SHIP, crew: CREW, ...CATALOG, ships: [], encounters: ENCOUNTERS, ...extra });
function go(sim, command) {
  const why = sim.whyNot(command);
  assert.equal(why, null, `${command.type}: ${why}`);
  sim.enqueue(command);
  sim.step();
}
function seconds(sim, n) {
  for (let i = 0; i < n * TICK_RATE; i++) {
    sim.step();
    if (i % TICK_RATE === 0) assert.deepEqual(checkInvariants(sim), [], `tick ${sim.state.tick}`);
  }
}
/** Lamps off and everything that shows stood down, the air plant too: as quiet as she gets. */
function goDark(sim, air = true) {
  go(sim, { type: 'lights.all', on: false });
  for (const station of ['sensors', 'engines', ...(air ? ['life_support'] : [])]) if (!sim.state.stations[station].down) go(sim, { type: 'station.stand', station, down: true });
}
const first = (sim) => sim.state.scope.contacts[0];

test('a radar finds a dark hull close in, however quiet it runs, and nothing far off', () => {
  const sim = newSim('radar');
  goDark(sim);
  seconds(sim, 5);
  const reads = (id, range) => {
    go(sim, { type: 'debug.contact', clear: true });
    go(sim, { type: 'debug.contact', encounter: id, range, bearing: 0, miss: 0 });
    return readingOf(sim, first(sim));
  };
  const hauler = defOf('scrap-hauler');
  assert.ok(hauler.radar, 'a scrap hauler hunts dead hulls by radar');
  assert.ok(reads('scrap-hauler', 20) > hauler.sure, 'close in, it is sure of a dark ship');
  assert.ok(reads('scrap-hauler', hauler.radar.reach * 0.9) < hauler.notice, 'at the edge of its radar, it is not');
  // A ship with no radar reads nothing of a ship that dark at the same range.
  assert.ok(reads('drone-carrier', 20) < defOf('drone-carrier').notice);
});

test('a radar is checked like the rest of an encounter', () => {
  const base = { ...defOf('scrap-hauler') };
  assert.deepEqual(validateEncounter(base), []);
  assert.match(validateEncounter({ ...base, radar: { reach: 0, strength: 0.5 } }).join(), /radar must be/);
  assert.match(validateEncounter({ ...base, radar: { reach: 40, strength: 2 } }).join(), /radar must be/);
  assert.match(validateEncounter({ ...base, radar: { reach: 40, strength: 0.5, range: 3 } }).join(), /radar must be/);
});

test('once Margo has made a ship out, the scope says what beats it; before that, nothing', () => {
  const sim = newSim('tells');
  go(sim, { type: 'debug.contact', encounter: 'patrol-cutter', range: 100, bearing: 0, miss: 30 });
  const contact = first(sim);
  contact.track.known = false;
  contact.track.shown = true;
  assert.deepEqual(contactView(sim, contact).tells, []);
  contact.track.known = true;
  const keys = (id) => tellsOf(defOf(id)).map((tell) => tell.key);
  assert.deepEqual(contactView(sim, contact).tells.map((tell) => tell.key), keys('patrol-cutter'));
  // Every kind of ship differs in what beats it, and each tell is a few words.
  assert.ok(keys('patrol-cutter').includes('radar') && keys('patrol-cutter').includes('fast') && keys('patrol-cutter').includes('talks'));
  assert.ok(keys('raider-skiff').includes('cargo') && keys('raider-skiff').includes('fast'));
  assert.ok(keys('scrap-hauler').includes('radar') && keys('scrap-hauler').includes('slow'));
  assert.ok(keys('bulwark').includes('toll') && keys('bulwark').includes('steady'));
  assert.ok(keys('gunnery-drone').includes('deaf') && keys('gunnery-drone').includes('nerve'));
  assert.ok(keys('drone-carrier').includes('flare') && !keys('drone-carrier').includes('radar'));
  const sets = new Set(ENCOUNTERS.map((def) => keys(def.id).sort().join()));
  assert.equal(sets.size, ENCOUNTERS.length, 'no two kinds read the same');
  for (const def of ENCOUNTERS) for (const tell of tellsOf(def)) assert.ok(tell.text.length <= 60, tell.text);
});

test('a lie they see through costs standing at once; one they swallow can be found out, and the word waits at the next port', () => {
  const faction = defOf('patrol-cutter').party.faction;
  const hail = (seed, chance) => {
    const encounters = ENCOUNTERS.map((def) => (def.id === 'patrol-cutter' ? { ...def, bluffs: { manifest: chance } } : def));
    const sim = newSim(seed, { encounters });
    go(sim, { type: 'debug.contact', encounter: 'patrol-cutter', range: 30, bearing: 0, state: 'shadowing' });
    first(sim).track.shown = true;
    const before = sim.state.reputation[faction] ?? 0;
    go(sim, { type: 'contact.hail', contact: first(sim).id, bluff: 'manifest' });
    return { sim, before };
  };
  const caught = hail('lie-caught', 0);
  assert.equal(caught.sim.state.reputation[faction], caught.before + BLUFF_COST.caught);
  // Believed: no cost now, but now and then it is found out.
  const believed = [];
  for (let i = 0; i < 20; i++) believed.push(hail(`lie-${i}`, 1));
  const found = believed.filter(({ sim }) => sim.state.scope.marks.length);
  assert.ok(found.length > 0 && found.length < believed.length, `${found.length} of ${believed.length} found out`);
  for (const { sim, before } of believed) assert.equal(sim.state.reputation[faction] ?? 0, before, 'nothing yet');
  const { sim, before } = found[0];
  const heard = [];
  sim.events.on('bluff.found', (event) => heard.push(event));
  sim.events.emit('sector.jumped', { kind: 'checkpoint' });
  assert.equal(sim.state.scope.marks.length, 1, 'not at a checkpoint');
  sim.events.emit('sector.jumped', { kind: 'port' });
  assert.equal(sim.state.reputation[faction], before + BLUFF_COST.found, 'at the port the word is waiting');
  assert.equal(sim.state.scope.marks.length, 0);
  assert.deepEqual(heard[0].factions, [faction]);
});

test('going dark with the air plant down turns the ship cold, and a cold hand walks, works and keeps a station slower', () => {
  assert.equal(chillOf(20), 1);
  assert.equal(chillOf(COLD.below + 0.1), 1);
  assert.ok(chillOf(0) < 1 && chillOf(0) > COLD.pace);
  assert.equal(chillOf(-40), COLD.pace);
  const sim = newSim('cold');
  seconds(sim, 3);
  const warm = rating(sim, 'helm');
  goDark(sim, false);
  seconds(sim, 60);
  assert.ok(Object.values(sim.state.rooms).every((r) => r.jettisoned || r.temperature > 15), 'with the air plant up she stays warm in the dark');
  go(sim, { type: 'station.stand', station: 'life_support', down: true });
  seconds(sim, 30);
  assert.ok(sim.state.rooms.bridge.temperature > COLD.below, 'it takes a while');
  seconds(sim, 90);
  assert.ok(sim.state.rooms.bridge.temperature < COLD.below, `cold after two minutes: ${sim.state.rooms.bridge.temperature.toFixed(1)}`);
  assert.ok(rating(sim, 'helm') < warm, 'the pilot is slower at the helm');
  assert.ok(sim.state.rooms.bridge.oxygen < 1, 'and the air goes stale');
  go(sim, { type: 'station.stand', station: 'life_support', down: false });
  seconds(sim, 60);
  assert.ok(sim.state.rooms.bridge.temperature > COLD.below, 'the air plant warms her back');
  assert.ok(Math.abs(rating(sim, 'helm') - warm) < 1e-9);
});

test('running drinks fuel and leaves a wake: the next lane brings ships that already have a sniff of us', () => {
  const sim = newSim('wake', { sector: SECTOR, ports: PORTS, run: { pursuit: false } });
  const run = sim.state.run;
  for (const risk of Object.values(run.risks)) risk.contacts = 0;
  castOff(sim, nearestPort(sim));
  // On to the last lane of the way, so the next lane is the first one out of the port.
  for (let i = 0; i < 400 && run.crossing.leg < run.crossing.path.length - 2; i++) {
    if (!sim.whyNot({ type: 'debug.run', skip: true })) sim.enqueue({ type: 'debug.run', skip: true });
    sim.step();
  }
  assert.equal(run.crossing.leg, run.crossing.path.length - 2);
  const fuel = run.fuel;
  go(sim, { type: 'helm.burn', on: true });
  seconds(sim, RUNNING.wake);
  assert.ok(run.wake > 0.5, `a wake: ${run.wake}`);
  seconds(sim, RUNNING.fuel * 1.5);
  assert.equal(run.wake, 1);
  assert.ok(run.fuel < fuel, 'a minute and a half of hard burn costs fuel');
  go(sim, { type: 'helm.burn', on: false });
  const burned = run.burned;
  seconds(sim, 30);
  assert.equal(run.burned, burned, 'drifting costs nothing');
  // Into port, and out again: the wake is what the first lane out sees of us.
  go(sim, { type: 'debug.contact', clear: true });
  go(sim, { type: 'debug.run', fuel: run.fuelMax });
  flyCrossing(sim);
  assert.equal(run.crossing, null);
  assert.equal(run.wake, 1, 'the wake waits for the next lane');
  for (const risk of Object.values(run.risks)) risk.contacts = 400;
  castOff(sim, nearestPort(sim));
  assert.equal(run.wake, 0);
  assert.equal(run.crossing.wake, 1);
  for (let i = 0; i < 10 * TICK_RATE && !sim.state.scope.contacts.length; i++) sim.step();
  const contact = first(sim);
  assert.ok(contact?.wake, 'a ship turns up on our wake');
  assert.ok(contact.aware >= RUNNING.aware - 0.05, `with a sniff of us already: ${contact.aware}`);
});

test('a flare costs what it is: the port sells them where it sells fuel', () => {
  const sim = newSim('flares', { sector: SECTOR, ports: PORTS, run: { pursuit: false } });
  assert.equal(sim.whyNot({ type: 'port.flares' }), 'the flare rack is full');
  sim.state.helm.flares = 0;
  sim.state.money = 30;
  const price = PORTS[0].flare;
  go(sim, { type: 'port.flares' });
  assert.equal(sim.state.helm.flares, Math.min(HELM.flares, Math.floor(30 / price)));
  assert.equal(sim.state.money, 30 - price * sim.state.helm.flares);
  sim.state.money = 0;
  if (sim.state.helm.flares < HELM.flares) assert.match(sim.whyNot({ type: 'port.flares' }), /credits each/);
  castOff(sim, nearestPort(sim));
  assert.match(sim.whyNot({ type: 'port.flares' }), /only a port/);
});
