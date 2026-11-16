// The signature and visibility model (S2.7, D-074): what a room gives off, what
// Margo can see of her own ship, what each ship can make of the other, and what
// that does to gunnery.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enemyOf } from '../src/sim/combat.js';
import { LOCK, MISS, NOISE, contactView, hiddenRooms, lockQuality, missChance, resolvedRooms, roomView, sense, sensorGain, signature, watched } from '../src/sim/senses.js';
import { TICK_RATE, checkInvariants } from '../src/sim/sim.js';
import { newCrewedSim, newSim, newTalkingSim } from './helpers.js';

const DRONE = 'target-drone';
const SKIFF = 'salvager-skiff';
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
function fight(sim, enemy, { engage = true } = {}) {
  go(sim, { type: 'debug.fight', enemy });
  if (engage && sim.state.fight.phase === 'hail') go(sim, { type: 'fight.engage' });
  return enemyOf(sim);
}

// ---------- what a room gives off ----------

test('a room gives off light, noise, heat and movement, and the creature will read the same numbers', () => {
  const sim = newCrewedSim('senses');
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

  // Machinery hums while it has power; the drive is loud and hot when it burns.
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

test('their ship resolves room by room: nothing at first, bright and hot rooms soonest, slower without sensor power', () => {
  const sim = newCrewedSim('scan');
  seconds(sim, 1);
  const enemy = fight(sim, DRONE);
  assert.deepEqual(resolvedRooms(sim), [], 'a fresh contact is all static');
  assert.match(sim.whyNot({ type: 'weapon.target', slot: 0, room: 'reactor' }), /sensors have not made that part of them out/);
  // Put out the lamps in their weapons room: it is the last to resolve.
  enemy.state.rooms.weapons.lightsOn = false;
  const news = collect(sim, 'scan.resolved');
  const order = [];
  for (let i = 0; i < 40 * TICK_RATE && order.length < 5; i++) {
    sim.step();
    for (const id of resolvedRooms(sim)) if (!order.includes(id)) order.push(id);
  }
  assert.equal(order.length, 5, 'in the end every room is made out');
  assert.equal(order.at(-1), 'weapons', `the dark room last: ${order.join(', ')}`);
  assert.equal(news.at(-1).resolved, 5);
  assert.equal(sim.whyNot({ type: 'weapon.target', slot: 0, room: 'reactor' }), null);
  const withSensors = sim.state.tick;

  // The same contact with our sensors unpowered: eyes and optics get there, in about twice the time.
  const blind = newCrewedSim('scan');
  seconds(blind, 1);
  go(blind, { type: 'power.add', system: 'sensors', delta: -1 });
  const start = blind.state.tick;
  fight(blind, DRONE).state.rooms.weapons.lightsOn = false;
  assert.ok(sensorGain(blind) < sensorGain(sim));
  for (let i = 0; i < 120 * TICK_RATE && resolvedRooms(blind).length < 5; i++) blind.step();
  assert.equal(resolvedRooms(blind).length, 5);
  assert.ok(blind.state.tick - start > (withSensors - TICK_RATE) * 1.5, `passive scanning is slow: ${blind.state.tick - start} ticks against ${withSensors}`);
  assert.deepEqual(checkInvariants(sim), []);
});

test('with our sensors dark the return goes stale: resolved rooms stay, but show the last scan', () => {
  const sim = newCrewedSim('stale');
  seconds(sim, 1);
  const enemy = fight(sim, DRONE);
  seconds(sim, 15);
  assert.equal(contactView(sim, 'reactor').live, true);
  go(sim, { type: 'power.add', system: 'sensors', delta: -1 });
  enemy.state.rooms.reactor.fire = 0.5;
  seconds(sim, 3);
  const stale = contactView(sim, 'reactor', enemy);
  assert.equal(stale.resolved, true, 'the map of them is not forgotten');
  assert.equal(stale.live, false);
  assert.equal(stale.fire, 0, 'but the fire that started since is not on it');
  assert.ok(stale.age >= 3 * TICK_RATE);
  go(sim, { type: 'power.add', system: 'sensors', delta: 1 });
  sim.step();
  assert.ok(contactView(sim, 'reactor', enemy).fire > 0, 'sensors back: the picture is fresh');
});

// ---------- running dark ----------

test('a lock follows the signature: it comes slowly, goes when we run dark, and a lost lock is announced', () => {
  const sim = newCrewedSim('lock');
  seconds(sim, 1);
  const enemy = fight(sim, SKIFF);
  assert.ok(enemy.state.contact.lock < 0.1, 'a fresh contact: no lock yet');
  assert.ok(missChance(enemy) > MISS.span - 0.1, 'no lock: most shots go wide');
  const gained = collect(sim, 'enemy.lock.gained');
  const lostIt = collect(sim, 'enemy.lock.lost');
  seconds(sim, 10);
  const bright = enemy.state.contact.lock;
  assert.ok(bright > 0.8, `lit up, they have us: ${bright}`);
  assert.equal(gained.length, 1);
  assert.ok(Math.abs(bright - lockQuality(enemy, sim)) < 0.05, 'the lock settles to what the signature allows');
  assert.ok(missChance(enemy) < 0.2);

  goDark(sim, { sensors: false });
  seconds(sim, 8);
  assert.ok(enemy.state.contact.lock < LOCK.min, `dark, they lose us: ${enemy.state.contact.lock}`);
  assert.equal(enemy.state.contact.locked, false);
  assert.equal(lostIt.length, 1);
  assert.ok(missChance(enemy) > 0.7);
  assert.deepEqual(checkInvariants(sim), []);
});

/** Stand off against the skiff for five minutes and count what its guns do. `dark` runs dark first. */
function underFire(seed, dark) {
  const sim = newCrewedSim(seed);
  seconds(sim, 1);
  const enemy = fight(sim, SKIFF);
  enemy.layout.tactics.board && (enemy.state.crew = Object.fromEntries(Object.entries(enemy.state.crew).slice(0, 1))); // only the pilot: nobody to board us
  sim.state.hull.points = sim.state.hull.max = 100000;
  if (dark) goDark(sim);
  const tally = { shots: 0, hits: 0, blind: 0 };
  sim.events.on('shot.resolved', (event) => {
    if (event.side !== 'enemy') return;
    tally.shots += 1;
    if (event.result === 'hit') tally.hits += 1;
    if (event.blind) tally.blind += 1;
  });
  for (let i = 0; i < 300 * TICK_RATE; i++) {
    sim.step();
    sim.state.fight.lastHarm = sim.state.tick; // no stalemate: we are here to be shot at
    // Keep the ship as it was put: mend what they break, and hold the power where it is.
    for (const room of Object.values(sim.state.rooms)) Object.assign(room, { fire: 0, breach: 0, oxygen: 1, hull: 1 });
    for (const system of Object.values(sim.state.systems)) system.damage = 0;
  }
  assert.deepEqual(checkInvariants(sim), []);
  return tally;
}

test('running dark changes hit rates: the same guns hit a lit ship far more often than a dark one', () => {
  const lit = { shots: 0, hits: 0, blind: 0 };
  const dark = { shots: 0, hits: 0, blind: 0 };
  for (const seed of ['dark-1', 'dark-2', 'dark-3']) {
    for (const [total, run] of [[lit, underFire(seed, false)], [dark, underFire(seed, true)]]) for (const key of Object.keys(total)) total[key] += run[key];
  }
  const rate = (t) => t.hits / t.shots;
  assert.ok(lit.shots > 60 && dark.shots > 30, `${lit.shots} and ${dark.shots} shots`);
  assert.ok(rate(lit) > 0.6, `lit: ${lit.hits} of ${lit.shots} hit`);
  assert.ok(rate(dark) < 0.3, `dark: ${dark.hits} of ${dark.shots} hit`);
  assert.ok(dark.blind > dark.shots * 0.5, `and most of their shots at a dark ship are fired blind: ${dark.blind} of ${dark.shots}`);
  assert.equal(lit.blind, 0, 'a lit ship is never fired on blind once they have it');
});

test('their captain aims only at rooms its sensors have resolved, so a dark room is shot at last', () => {
  const sim = newCrewedSim('aim');
  seconds(sim, 1);
  go(sim, { type: 'lights.all', on: false });
  go(sim, { type: 'room.lights', room: 'bridge', on: true });
  const enemy = fight(sim, SKIFF);
  const aimed = collect(sim, 'weapon.fired').filter(() => false);
  sim.events.on('weapon.fired', (event) => event.side === 'enemy' && !event.blind && aimed.push(event));
  for (let i = 0; i < 40 * TICK_RATE && aimed.length < 2; i++) sim.step();
  assert.ok(aimed.length >= 1, 'they fired');
  const known = resolvedRooms(enemy);
  assert.ok(known.includes('bridge'), 'the lit bridge is what they can see');
  assert.ok(known.length < sim.layout.rooms.length, 'the dark rooms take them longer');
  for (const shot of aimed) assert.ok(known.includes(shot.room), `aimed at ${shot.room}, which they had resolved`);
});
