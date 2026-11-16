import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateContent } from '../src/engine/content-schema.js';
import { hashState } from '../src/engine/hash.js';
import { BRACE, CAPACITOR, braced, chargeOf, enemyOf, weaponsPowered } from '../src/sim/combat.js';
import { buildLayout, validateLayout } from '../src/sim/ship.js';
import { TICK_RATE, checkInvariants } from '../src/sim/sim.js';
import { content, newCrewedSim, newSim, newTalkingSim, shipCopy } from './helpers.js';

const steps = (sim, n) => {
  for (let i = 0; i < n; i++) sim.step();
  return sim;
};
const seconds = (sim, s) => steps(sim, Math.round(s * TICK_RATE));
const DRONE = 'target-drone';
const LASER = content.require('weapons', 'pulse-laser');
const SLUGS = content.require('weapons', 'slug-thrower');

/** Move bars around so the weapons system has `bars` (dropping sensors, doors and engines as needed). */
function powerWeapons(sim, bars) {
  for (const system of ['sensors', 'doors', 'engines'].slice(0, bars)) sim.enqueue({ type: 'power.add', system, delta: -1 });
  sim.step();
  for (let i = 0; i < bars; i++) sim.enqueue({ type: 'power.add', system: 'weapons', delta: 1 });
  sim.step();
  assert.equal(sim.state.systems.weapons.power, bars);
}

function fight(sim, enemy = DRONE) {
  sim.enqueue({ type: 'debug.fight', enemy });
  sim.step();
  // A perfect lock and a full scan, so these tests are about the guns (senses.test.js covers the sensors).
  sim.enqueue({ type: 'debug.combat', action: 'scan' });
  sim.step();
  return enemyOf(sim);
}

/** Take the drone's shields and engines away, so every shot is a plain hit. */
function strip(sim) {
  const enemy = enemyOf(sim).state;
  enemy.systems.shields.power = 0;
  enemy.systems.engines.power = 0;
  enemy.shield.charge = 0;
}

test('weapons are content: three to mount and a drone\'s zap, each sound', () => {
  assert.equal(content.count('weapons'), 4);
  assert.deepEqual(content.all('weapons').filter((w) => w.mount === false).map((w) => w.id), ['drone-zap']);
  const broken = { ...LASER, id: 'broken', power: 0, charge: -1, effects: { fire: 2 } };
  const { errors } = validateContent([{ path: 'weapons/x.json', data: { items: [broken] } }]);
  assert.equal(errors.length, 3, errors.join('\n'));
});

test('a ship that fits a weapon no ship can mount is caught by the content check', () => {
  const data = { ...shipCopy(), weapons: ['pulse-laser', 'drone-zap'] };
  const { errors } = validateContent([
    { path: 'ships/x.json', data: { items: [data] } },
    { path: 'weapons/x.json', data: { items: [LASER, { ...LASER, id: 'drone-zap', mount: false }] } },
  ]);
  assert.ok(errors.some((e) => /which no ship can mount/.test(e)), errors.join('\n'));
});

test('a ship that fits a weapon nobody made is caught by the content check', () => {
  const data = { ...shipCopy(), weapons: ['pulse-laser', 'death-ray'] };
  const { errors } = validateContent([
    { path: 'ships/x.json', data: { items: [data] } },
    { path: 'weapons/x.json', data: { items: [LASER] } },
  ]);
  assert.ok(errors.some((e) => /fits a weapon that does not exist: "death-ray"/.test(e)), errors.join('\n'));
});

test('a player ship needs hull points and 2 to 4 hardpoints; an enemy may be much less of a ship', () => {
  const data = shipCopy();
  delete data.hullPoints;
  data.hardpoints = data.hardpoints.slice(0, 1);
  const problems = validateLayout(data);
  assert.ok(problems.some((p) => /hullPoints/.test(p)));
  assert.ok(problems.some((p) => /2 to 4 hardpoints/.test(p)));
  assert.ok(validateLayout({ ...shipCopy(), weapons: ['a', 'b', 'c', 'd'] }).some((p) => /4 weapons fitted but only 3 hardpoints/.test(p)));

  const drone = content.require('ships', DRONE);
  assert.deepEqual(validateLayout(drone), []);
  const layout = buildLayout(drone);
  assert.equal(layout.enemy, true);
  assert.equal(layout.facing, 'left');
  assert.equal(layout.hasSystem('medbay'), false);
  const { enemy, ...asPlayer } = drone;
  assert.ok(validateLayout(asPlayer).some((p) => /no room holds the medbay system/.test(p)), 'only an enemy may leave systems out');
});

test('the Margin of Error starts with two weapons, a whole hull, and no fight', () => {
  const sim = newSim();
  assert.deepEqual(sim.state.hull, { points: 20, max: 20 });
  assert.deepEqual(sim.state.weapons.map((w) => w.id), ['pulse-laser', 'slug-thrower']);
  assert.equal(sim.state.fight, null);
  assert.equal(enemyOf(sim), null);
  assert.deepEqual(sim.state.shield, { charge: 0, field: 0, until: 0 });
  assert.deepEqual(sim.state.weapons.map((w) => w.rounds), [null, SLUGS.ammo.magazine], 'the laser needs no rounds; the slug thrower starts loaded');
});

test('weapons take the system\'s bars in hardpoint order, charge with power and drain without', () => {
  const sim = newSim();
  assert.deepEqual(weaponsPowered(sim), [false, false]);
  powerWeapons(sim, 1);
  assert.deepEqual(weaponsPowered(sim), [true, false], 'one bar runs the laser but not the two-bar slug thrower');
  seconds(sim, LASER.charge / 2);
  assert.ok(Math.abs(chargeOf(sim, 0) - 0.5) < 0.02);
  assert.equal(chargeOf(sim, 1), 0);
  const ready = [];
  sim.events.on('weapon.ready', (e) => ready.push(e.slot));
  seconds(sim, LASER.charge);
  assert.equal(chargeOf(sim, 0), 1, 'a charged weapon with no target holds its charge');
  assert.deepEqual(ready, [0]);
  sim.enqueue({ type: 'power.add', system: 'weapons', delta: -1 });
  seconds(sim, LASER.charge / 4);
  assert.ok(chargeOf(sim, 0) < 0.6 && chargeOf(sim, 0) > 0.4, 'charge drains twice as fast as it built');
  seconds(sim, LASER.charge);
  assert.equal(chargeOf(sim, 0), 0);
  assert.deepEqual(checkInvariants(sim), []);
});

test('the shield capacitor charges from its bars, a unit a bar, and holds no more than they give', () => {
  const sim = newSim();
  sim.enqueue({ type: 'power.add', system: 'sensors', delta: -1 });
  sim.enqueue({ type: 'power.add', system: 'doors', delta: -1 });
  sim.step();
  sim.enqueue({ type: 'power.add', system: 'shields', delta: 1 });
  sim.enqueue({ type: 'power.add', system: 'shields', delta: 1 });
  sim.step();
  assert.ok(sim.state.shield.charge < 0.1);
  seconds(sim, CAPACITOR.seconds / 2);
  assert.ok(Math.abs(sim.state.shield.charge - 1) < 0.05, `two bars put in a unit in half the time: ${sim.state.shield.charge}`);
  seconds(sim, CAPACITOR.seconds * 3);
  assert.equal(sim.state.shield.charge, 2, 'never more than the power routed');
  assert.equal(braced(sim), false, 'charge alone stops nothing');
  sim.enqueue({ type: 'power.add', system: 'shields', delta: -1 });
  steps(sim, 2);
  assert.equal(sim.state.shield.charge, 1, 'losing a bar loses what it held at once');
});

test('a fight brings a whole second ship alongside, and it runs on the same clock', () => {
  const sim = newSim();
  assert.equal(sim.whyNot({ type: 'weapon.target', slot: 0, room: 'reactor' }), 'there is nothing to shoot at');
  assert.throws(() => sim.enqueue({ type: 'debug.fight', enemy: 'margin-of-error' }), /no enemy ship/);
  const heard = [];
  sim.events.on('*', (e, type) => (type.startsWith('fight.') || type.startsWith('enemy.')) && heard.push(type));
  const enemy = fight(sim);
  assert.deepEqual(heard, ['fight.started']);
  assert.equal(enemy.layout.name, 'Gunnery drone');
  assert.equal(Object.keys(enemy.state.rooms).length, 5);
  assert.deepEqual(enemy.state.hull, { points: 8, max: 8 });
  assert.equal(enemy.state.shield.charge, 1, 'its capacitor starts charged');
  assert.equal(enemy.state.systems.medbay.absent, true);
  assert.throws(() => sim.enqueue({ type: 'debug.fight', enemy: DRONE }), /already in a fight/);

  // The Stage 1 hazard code runs aboard the enemy, announced apart from the player's ship.
  enemy.state.rooms.reactor.fire = 0.5;
  seconds(sim, 3);
  assert.equal(enemy.state.tick, sim.state.tick);
  assert.ok(enemy.state.rooms.reactor.fire > 0.5, 'fire grows there as it does here');
  assert.ok(heard.includes('enemy.fire.started'));
  assert.ok(!heard.includes('fire.started'));
  assert.deepEqual(checkInvariants(sim), []);

  sim.enqueue({ type: 'debug.fight', enemy: null });
  sim.step();
  assert.equal(sim.state.fight, null);
  assert.equal(heard.at(-1), 'fight.ended');
});

test('a charged weapon with a target fires, the shot flies, and a brace stops it', () => {
  const sim = newSim();
  powerWeapons(sim, 1);
  const enemy = fight(sim);
  enemy.state.systems.engines.power = 0; // hold still
  const log = [];
  sim.events.on('weapon.fired', (e) => log.push(`fired ${e.weapon} at ${e.room}`));
  sim.events.on('shot.resolved', (e) => log.push(`${e.result} ${e.damage}`));
  sim.events.on('enemy.ship.braced', (e) => log.push(`braced ${e.field}`));
  assert.throws(() => sim.enqueue({ type: 'weapon.target', slot: 0, room: 'bridge' }), /no room "bridge" on their ship/);
  assert.throws(() => sim.enqueue({ type: 'weapon.target', slot: 5, room: 'reactor' }), /no weapon in slot 5/);
  sim.enqueue({ type: 'weapon.target', slot: 0, room: 'reactor' });
  seconds(sim, LASER.charge + 0.1);
  assert.equal(log[0], 'fired pulse-laser at reactor');
  assert.equal(sim.state.fight.shots.length, 1);
  assert.equal(sim.state.weapons[0].charge < 1, true, 'it starts charging again at once');
  seconds(sim, LASER.flight + 0.1);
  // The drone's point defence braces on a coin toss: either it braced and the shot was stopped, or it was hit.
  const braced = log.includes('braced 1');
  assert.deepEqual(log.slice(1), braced ? ['braced 1', 'shield 0'] : ['hit 1']);
  assert.equal(enemy.state.hull.points, braced ? 8 : 7);
  assert.equal(enemy.state.shield.charge, braced ? 0 : 1, 'a brace dumps the whole capacitor');
  assert.deepEqual(checkInvariants(sim), []);
});

test('a brace soaks a volley for a few seconds, costs more against a gun that pierces, and lights the ship up', () => {
  const sim = newSim();
  const enemy = fight(sim);
  enemy.state.systems.engines.power = 0;
  assert.match(sim.whyNot({ type: 'ship.brace' }), /no power/);
  sim.enqueue({ type: 'power.add', system: 'sensors', delta: -1 });
  sim.enqueue({ type: 'power.add', system: 'doors', delta: -1 });
  sim.step();
  sim.enqueue({ type: 'power.add', system: 'shields', delta: 1 });
  sim.enqueue({ type: 'power.add', system: 'shields', delta: 1 });
  sim.step();
  sim.state.shield.charge = 0.6;
  assert.match(sim.whyNot({ type: 'ship.brace' }), /capacitor is at 30%/);
  sim.state.shield.charge = 2;
  Object.assign(enemy.state.contact, { lock: 1, locked: true, pinned: true }); // their gunners cannot miss
  const flare = sim.state.flare;
  const resolved = [];
  sim.events.on('shot.resolved', (e) => resolved.push(e.result));
  sim.enqueue({ type: 'ship.brace' });
  sim.step();
  assert.equal(braced(sim), true);
  assert.equal(sim.state.shield.field, 2);
  assert.equal(sim.state.shield.charge, 0);
  assert.ok(sim.state.flare >= flare + BRACE.flare - 0.01, 'the field going up shows for a long way');
  assert.ok(sim.state.rooms.shields.noise >= BRACE.noise - 0.05, 'and it is loud');
  assert.match(sim.whyNot({ type: 'ship.brace' }), /already braced/);
  // A lance (pierce 1) costs two units: the whole field.
  sim.enqueue({ type: 'debug.hit', at: 'us', room: 'cargo', weapon: 'breaching-lance' });
  sim.step();
  sim.enqueue({ type: 'debug.hit', at: 'us', room: 'cargo', weapon: 'pulse-laser' });
  sim.step();
  assert.deepEqual(resolved, ['shield', 'hit'], 'the lance took it all, and the next shot got through');
  // A fresh brace runs out after its time, whatever is left in it.
  sim.state.shield.charge = 2;
  sim.enqueue({ type: 'ship.brace' });
  seconds(sim, BRACE.seconds + 0.2);
  assert.equal(braced(sim), false);
  assert.ok(sim.state.shield.charge > 0, 'and the capacitor charges again');
  assert.deepEqual(checkInvariants(sim), []);
});

test('a heavy gun fires its magazine, then waits charged until someone loads it', () => {
  const sim = newSim();
  powerWeapons(sim, 3);
  const enemy = fight(sim);
  strip(sim);
  enemy.state.hull.points = 99;
  enemy.state.hull.max = 99;
  const empty = [];
  sim.events.on('weapon.empty', (e) => empty.push(e.slot));
  sim.enqueue({ type: 'weapon.target', slot: 1, room: 'engines' });
  seconds(sim, SLUGS.charge * SLUGS.ammo.magazine + 2);
  assert.equal(sim.state.weapons[1].rounds, 0);
  seconds(sim, SLUGS.charge + 1);
  assert.deepEqual(empty, [1], 'it says so once');
  assert.equal(chargeOf(sim, 1), 1, 'charged and waiting');
  assert.equal(enemy.state.hull.points, 99 - SLUGS.damage * SLUGS.ammo.magazine);
  sim.state.weapons[1].rounds = 1;
  seconds(sim, 0.2);
  assert.equal(sim.state.weapons[1].rounds, 0, 'a round in the breech goes at once');
  assert.deepEqual(checkInvariants(sim), []);
});

test('with shields down a hit takes hull points and marks the room; at zero the fight is decided', () => {
  const sim = newSim();
  powerWeapons(sim, 3);
  fight(sim);
  strip(sim);
  const results = [];
  let over = null;
  sim.events.on('shot.resolved', (e) => results.push(`${e.weapon} ${e.result}`));
  sim.events.on('fight.over', (e) => (over = e));
  sim.enqueue({ type: 'weapon.target', slot: 0, room: 'weapons' });
  sim.enqueue({ type: 'weapon.target', slot: 1, room: 'engines' });
  seconds(sim, SLUGS.charge + SLUGS.flight + 0.2);
  const enemy = enemyOf(sim).state;
  assert.deepEqual(results, ['pulse-laser hit', 'slug-thrower hit']);
  assert.equal(enemy.hull.points, 8 - LASER.damage - SLUGS.damage);
  assert.ok(enemy.rooms.engines.hull < enemy.rooms.weapons.hull && enemy.rooms.weapons.hull < 1);
  seconds(sim, 60);
  assert.equal(enemy.hull.points, 0);
  assert.equal(over.outcome, 'destroyed');
  assert.equal(sim.state.fight.over.outcome, 'destroyed');
  assert.deepEqual(sim.state.fight.shots, []);
  assert.deepEqual(sim.state.weapons.map((w) => w.target), [null, null], 'the guns stop when there is nothing left to shoot');
  assert.equal(sim.whyNot({ type: 'weapon.target', slot: 0, room: 'reactor' }), 'there is nothing to shoot at');
  const shots = results.length;
  seconds(sim, 30);
  assert.equal(results.length, shots);
  assert.deepEqual(checkInvariants(sim), []);
});

test('nothing in a fight moves while the clock is stopped, and orders given then wait', () => {
  const sim = newSim();
  powerWeapons(sim, 1);
  fight(sim);
  seconds(sim, 2);
  const before = hashState(sim.snapshot().state.fight);
  const charge = sim.state.weapons[0].charge;
  sim.enqueue({ type: 'weapon.target', slot: 0, room: 'shields' }); // "paused": no step is taken
  assert.equal(hashState(sim.snapshot().state.fight), before);
  assert.equal(sim.state.weapons[0].charge, charge);
  assert.equal(sim.state.weapons[0].target, null);
  sim.step();
  assert.equal(sim.state.weapons[0].target, 'shields');
});

test('a fight saves and loads mid-shot and plays out the same', () => {
  const play = (sim) => {
    powerWeapons(sim, 3);
    fight(sim);
    sim.enqueue({ type: 'weapon.target', slot: 0, room: 'shields' });
    sim.enqueue({ type: 'weapon.target', slot: 1, room: 'reactor' });
    return seconds(sim, LASER.charge + 0.2);
  };
  const sim = play(newSim('save-fight'));
  assert.equal(sim.state.fight.shots.length, 1, 'a shot is in the air');
  const saved = JSON.parse(JSON.stringify(sim.snapshot()));
  seconds(sim, 90);
  const loaded = newSim('save-fight');
  loaded.restore(saved);
  assert.equal(enemyOf(loaded).layout.id, DRONE);
  seconds(loaded, 90);
  assert.equal(hashState(loaded.snapshot()), hashState(sim.snapshot()));
  assert.equal(sim.state.fight.over?.outcome, 'destroyed');
});

test('Margo remarks when a fight starts and when it is over', () => {
  const sim = newTalkingSim('fight-talk');
  seconds(sim, 12); // let the greeting finish
  powerWeapons(sim, 3);
  fight(sim);
  strip(sim);
  sim.enqueue({ type: 'weapon.target', slot: 0, room: 'core' });
  sim.enqueue({ type: 'weapon.target', slot: 1, room: 'core' });
  seconds(sim, 90);
  const said = sim.state.ai.log.map((line) => line.category);
  assert.ok(said.includes('combat_start'), said.join(','));
  assert.ok(said.includes('combat_end'), said.join(','));
});
