// The signature and visibility model (S2.7, D-074): what a room gives off, what
// Margo can see of her own ship, what each ship can make of the other, and what
// that does to gunnery.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NOISE, hiddenRooms, roomView, sense, sensorGain, signature, watched } from '../src/sim/senses.js';
import { TICK_RATE, checkInvariants } from '../src/sim/sim.js';
import { newCrewedSim, newSim, newTalkingSim } from './helpers.js';

const seconds = (sim, s) => {
  for (let i = 0; i < Math.round(s * TICK_RATE); i++) sim.step();
};
const go = (sim, command) => {
  sim.enqueue(command);
  sim.step();
};
function collect(sim, type) {
  const seen = [];
  sim.events.on(type, (event) => seen.push(event));
  return seen;
}
/** Every lamp off, and the systems that give us away: what a player does to run dark. */
function goDark(sim, { sensors = true } = {}) {
  if (!sim.whyNot({ type: 'lights.all', on: false })) go(sim, { type: 'lights.all', on: false });
  for (const system of ['engines', 'doors', ...(sensors ? [] : ['sensors'])]) {
    while (sim.state.systems[system].power > 0) go(sim, { type: 'power.add', system, delta: -1 });
  }
}
function emptyRooms(sim) {
  for (const member of Object.values(sim.state.crew)) if (member.room === 'hold') delete sim.state.crew[member.id];
}

// ---------- what a room gives off ----------

test('a room gives off light, noise, heat and movement, and the creature will read the same numbers', () => {
  const sim = newCrewedSim('senses');
  emptyRooms(sim); // the hold, where Vesna starts
  seconds(sim, 1);
  const quiet = sense(sim, 'hold');
  assert.deepEqual(quiet, { light: 1, noise: 0, heat: 0, movement: 0 }, 'an empty lit hold: light and nothing else');

  // Lamps off: no light. A fire: its own glow, heat, and noise.
  go(sim, { type: 'room.lights', room: 'hold', on: false });
  seconds(sim, 1);
  assert.equal(sense(sim, 'hold').light, 0);
  go(sim, { type: 'debug.room', room: 'hold', set: { fire: 0.6 } });
  seconds(sim, 3);
  const burning = sense(sim, 'hold');
  assert.ok(burning.light > 0.5, `a fire lights a dark room: ${burning.light}`);
  assert.ok(burning.noise >= NOISE.fire * 0.6 - 0.01, `and is heard: ${burning.noise}`);
  assert.ok(burning.heat > 0.2, `and felt: ${burning.heat}`);

  // Machinery hums while it has power; the drive is loud and hot when it burns (the helm lights it, H.1).
  sim.state.helm.burn = true;
  seconds(sim, 1);
  const drive = sense(sim, 'engines');
  assert.ok(drive.noise > 0.2 && drive.heat > 0.3, JSON.stringify(drive));
  go(sim, { type: 'power.add', system: 'engines', delta: -1 });
  seconds(sim, 3);
  assert.equal(sense(sim, 'engines').noise, 0, 'a cold drive is silent');

  // People: warm, and seen moving while they walk.
  assert.ok(sense(sim, 'bridge').heat >= 0.15, 'a body is warm');
  go(sim, { type: 'crew.move', crew: 'ilse', room: 'sensors' });
  seconds(sim, 0.5);
  const walked = ['bridge', 'sensors', 'fore_corridor'].map((id) => sense(sim, id)).find((s) => s.movement > 0);
  assert.ok(walked && walked.noise >= NOISE.walking, 'someone walking is movement, and footsteps');
});

test('a bang rings and fades: a hit is loud where it lands, a gun where it is fired', () => {
  const sim = newCrewedSim('bang');
  emptyRooms(sim); // the hold, where Vesna starts
  seconds(sim, 1);
  go(sim, { type: 'debug.hit', at: 'us', room: 'brig', weapon: 'pulse-laser', force: true });
  assert.ok(sim.state.rooms.brig.noise > 0.9, `the hit: ${sim.state.rooms.brig.noise}`);
  seconds(sim, 1);
  const fading = sim.state.rooms.brig.noise;
  assert.ok(fading < 0.6 && fading > 0.3, `fading: ${fading}`);
  seconds(sim, 3);
  assert.equal(sim.state.rooms.brig.noise, 0, 'and the brig is quiet again');
  assert.deepEqual(checkInvariants(sim), []);
});

// ---------- the ship's signature ----------

test('the signature adds the ship up: lamps, noise, reactor load and drive burn', () => {
  const sim = newCrewedSim('signature');
  seconds(sim, 2);
  assert.equal(signature(sim).burn, 0, 'powered engines give off no burn until the helm lights the drive (H.1)');
  sim.state.helm.burn = true;
  const lit = signature(sim);
  assert.equal(lit.light, 1);
  assert.equal(lit.heat, 1, 'the reactor starts fully loaded');
  assert.equal(lit.burn, 0.5, 'one bar of two on the drive');
  assert.ok(lit.total > 0.6, `lit and running: ${lit.total}`);

  go(sim, { type: 'lights.all', on: false });
  seconds(sim, 2);
  const unlit = signature(sim);
  assert.equal(unlit.light, 0);
  assert.ok(unlit.heat < lit.heat, 'lamps are load on the reactor too');
  assert.ok(unlit.total < lit.total - 0.2, `lamps off: ${unlit.total}`);

  goDark(sim, { sensors: false });
  seconds(sim, 3);
  const dark = signature(sim);
  assert.equal(dark.burn, 0);
  assert.ok(dark.total < 0.15, `running dark: ${dark.total}`);
  assert.ok(dark.total > 0, 'a ship with air and an AI is never quite invisible');
});

test('lights.all turns every lamp off, and back on as far as the power goes', () => {
  const sim = newSim('lamps');
  sim.step();
  assert.match(sim.whyNot({ type: 'lights.all', on: true }), /already on/);
  const heard = collect(sim, 'lights.all');
  go(sim, { type: 'lights.all', on: false });
  assert.ok(Object.values(sim.state.rooms).every((room) => !room.lightsOn));
  assert.equal(heard[0].rooms, sim.layout.rooms.length);
  assert.match(sim.whyNot({ type: 'lights.all', on: false }), /already dark/);
  // Spend the power the lamps were using, bar one: only six rooms can come back.
  for (const system of ['shields', 'shields']) go(sim, { type: 'power.add', system, delta: 1 });
  go(sim, { type: 'lights.all', on: true });
  assert.equal(Object.values(sim.state.rooms).filter((room) => room.lightsOn).length, sim.layout.power.lightsPerBar);
  assert.deepEqual(checkInvariants(sim), []);
});

// ---------- fog on our own ship ----------

test('a dark, empty room out of sensor cover hides its state: Margo shows what she last saw', () => {
  const sim = newTalkingSim('fog');
  seconds(sim, 8); // past her greeting
  assert.deepEqual(hiddenRooms(sim), [], 'sensors cover the whole ship');
  go(sim, { type: 'room.lights', room: 'cargo', on: false });
  seconds(sim, 1);
  assert.equal(watched(sim, 'cargo'), true, 'dark, but the sensors still see in');

  const hidden = collect(sim, 'rooms.hidden');
  go(sim, { type: 'power.add', system: 'sensors', delta: -1 });
  assert.deepEqual(hiddenRooms(sim), ['cargo'], 'sensors down: only the lit and the manned rooms are seen');
  assert.deepEqual(hidden[0].rooms, ['cargo']);

  // The hull is holed in there. Nobody knows.
  const opened = collect(sim, 'breach.opened');
  const lines = collect(sim, 'ai.line');
  const lost = sim.state.tick;
  go(sim, { type: 'debug.room', room: 'cargo', set: { breach: 0.6 } });
  seconds(sim, 6);
  assert.equal(opened.length, 1, 'it happened');
  assert.ok(sim.state.rooms.cargo.oxygen < 0.9, 'and the air is going');
  const view = roomView(sim, 'cargo');
  assert.equal(view.live, false);
  assert.equal(view.breach, 0, 'but the screen shows the room as it was');
  assert.equal(view.oxygen, 1);
  assert.ok(view.age >= 6 * TICK_RATE && view.age <= sim.state.tick - lost + 2, `last seen ${view.age} ticks ago`);
  assert.ok(!lines.some((line) => line.trigger === 'breach.opened'), 'and Margo says nothing about a hole she cannot see');

  // Lamps on: the cameras see it, and now it is news.
  const found = collect(sim, 'breach.found');
  go(sim, { type: 'room.lights', room: 'cargo', on: true });
  seconds(sim, 1);
  assert.equal(found.length, 1);
  assert.equal(found[0].room, 'cargo');
  const now = roomView(sim, 'cargo');
  assert.equal(now.live, true);
  assert.equal(now.breach, sim.state.rooms.cargo.breach);
  seconds(sim, 6);
  assert.ok(lines.some((line) => line.trigger === 'breach.found'), lines.map((l) => l.trigger).join(', '));
  assert.deepEqual(checkInvariants(sim), []);
});

test('someone standing in a dark room is eyes on it; a fire in the dark is found once it is big enough to see by', () => {
  const sim = newCrewedSim('eyes');
  emptyRooms(sim); // the hold, where Vesna starts
  seconds(sim, 1);
  go(sim, { type: 'power.add', system: 'sensors', delta: -1 });
  go(sim, { type: 'lights.all', on: false });
  seconds(sim, 1);
  assert.equal(roomView(sim, 'bridge').live, true, 'Ilse is on the bridge');
  assert.equal(roomView(sim, 'hold').live, false);
  // Dace walks into the hold: seen while she is there, lost again when she leaves.
  const dace = Object.values(sim.state.crew).find((member) => member.name === 'Dace');
  go(sim, { type: 'crew.move', crew: dace.id, room: 'hold' });
  for (let i = 0; i < 60 * TICK_RATE && dace.room !== 'hold'; i++) sim.step();
  sim.step();
  assert.equal(roomView(sim, 'hold').live, true);

  // A small fire far from anyone is not seen; it grows until its own light gives it away.
  const started = collect(sim, 'fire.started');
  const found = collect(sim, 'fire.found');
  go(sim, { type: 'debug.room', room: 'brig', set: { fire: 0.1 } });
  seconds(sim, 1);
  assert.equal(started.length, 1);
  assert.equal(roomView(sim, 'brig').fire, 0, 'too small to see by');
  assert.equal(found.length, 0);
  for (let i = 0; i < 60 * TICK_RATE && !found.length; i++) sim.step();
  assert.equal(found.length, 1, 'the glow shows on the cameras');
  assert.ok(roomView(sim, 'brig').fire > 0.2);
});

// ---------- the sensor return ----------
