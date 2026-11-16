import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateContent } from '../src/engine/content-schema.js';
import { hashState } from '../src/engine/hash.js';
import { EVASION, SHIELD_RECHARGE_SECONDS, chargeOf, enemyOf, evasion, shieldLayers, weaponsPowered } from '../src/sim/combat.js';
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
  return enemyOf(sim);
}

/** Take the drone's shields and engines away, so every shot is a plain hit. */
function strip(sim) {
  const enemy = enemyOf(sim).state;
  enemy.systems.shields.power = 0;
  enemy.systems.engines.power = 0;
  enemy.shield.charge = 0;
}

test('weapons are content: three of them, each sound', () => {
  assert.equal(content.count('weapons'), 3);
  const broken = { ...LASER, id: 'broken', power: 0, charge: -1, effects: { fire: 2 } };
  const { errors } = validateContent([{ path: 'weapons/x.json', data: { items: [broken] } }]);
  assert.equal(errors.length, 3, errors.join('\n'));
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
  assert.equal(shieldLayers(sim), 0);
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

test('shields come up one layer at a time, as many as the bars routed to them', () => {
  const sim = newSim();
  sim.enqueue({ type: 'power.add', system: 'sensors', delta: -1 });
  sim.enqueue({ type: 'power.add', system: 'doors', delta: -1 });
  sim.step();
  sim.enqueue({ type: 'power.add', system: 'shields', delta: 1 });
  sim.enqueue({ type: 'power.add', system: 'shields', delta: 1 });
  sim.step();
  assert.equal(shieldLayers(sim), 0);
  seconds(sim, SHIELD_RECHARGE_SECONDS + 0.2);
  assert.equal(shieldLayers(sim), 1);
  seconds(sim, SHIELD_RECHARGE_SECONDS * 3);
  assert.equal(shieldLayers(sim), 2, 'never more than the power routed');
  sim.enqueue({ type: 'power.add', system: 'shields', delta: -1 });
  steps(sim, 2);
  assert.equal(shieldLayers(sim), 1, 'losing power drops the layer at once');
});

test('evasion needs engines, and is better with someone at the helm', () => {
  const sim = newCrewedSim();
  sim.step();
  const piloted = evasion(sim); // Ilse starts on the bridge; engines have one bar
  assert.ok(Math.abs(piloted - (EVASION.base + EVASION.perBar + EVASION.pilot)) < 1e-9);
  assert.ok(Math.abs(evasion(newSim()) - (EVASION.base + EVASION.perBar)) < 1e-9, 'nobody aboard, nobody flying');
  sim.enqueue({ type: 'power.add', system: 'engines', delta: -1 });
  steps(sim, 2);
  assert.equal(evasion(sim), 0, 'a ship that cannot move cannot dodge');
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
  assert.equal(shieldLayers(enemy), 1, 'its shields start up');
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

test('a charged weapon with a target fires, the shot flies, and a shield layer stops it', () => {
  const sim = newSim();
  powerWeapons(sim, 1);
  const enemy = fight(sim);
  enemy.state.systems.engines.power = 0; // hold still
  const log = [];
  sim.events.on('weapon.fired', (e) => log.push(`fired ${e.weapon} at ${e.room}`));
  sim.events.on('shot.resolved', (e) => log.push(`${e.result} ${e.damage}`));
  assert.throws(() => sim.enqueue({ type: 'weapon.target', slot: 0, room: 'bridge' }), /no room "bridge" on their ship/);
  assert.throws(() => sim.enqueue({ type: 'weapon.target', slot: 5, room: 'reactor' }), /no weapon in slot 5/);
  sim.enqueue({ type: 'weapon.target', slot: 0, room: 'reactor' });
  seconds(sim, LASER.charge + 0.1);
  assert.deepEqual(log, ['fired pulse-laser at reactor']);
  assert.equal(sim.state.fight.shots.length, 1);
  assert.equal(sim.state.weapons[0].charge < 1, true, 'it starts charging again at once');
  seconds(sim, LASER.flight + 0.1);
  assert.deepEqual(log, ['fired pulse-laser at reactor', 'shield 0']);
  assert.equal(shieldLayers(enemy), 0);
  assert.equal(enemy.state.hull.points, 8);
  // The next shot arrives before the layer is back? No: the laser takes longer than the shield. It is stopped again.
  seconds(sim, LASER.charge + LASER.flight);
  assert.equal(log.at(-1), 'shield 0');
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

test('a moving target is missed about as often as its evasion says', () => {
  const sim = newSim('dodge');
  powerWeapons(sim, 1);
  const enemy = fight(sim);
  enemy.state.systems.shields.power = 0;
  enemy.state.shield.charge = 0;
  enemy.state.hull.points = enemy.state.hull.max = 100000;
  const chance = evasion(enemy);
  assert.ok(Math.abs(chance - (EVASION.base + EVASION.perBar)) < 1e-9);
  let hits = 0;
  let misses = 0;
  sim.events.on('shot.resolved', (e) => (e.result === 'miss' ? misses++ : hits++));
  sim.enqueue({ type: 'weapon.target', slot: 0, room: 'core' });
  seconds(sim, LASER.charge * 400);
  const rate = misses / (hits + misses);
  assert.ok(hits + misses >= 395);
  assert.ok(Math.abs(rate - chance) < 0.05, `missed ${rate}, expected about ${chance}`);
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
