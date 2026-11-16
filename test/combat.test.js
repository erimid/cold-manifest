// The hauler's two mounts, the brace and the hull (S2.1, S2.2, S2.8; H.3 retired the duel and the enemy ship).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateContent } from '../src/engine/content-schema.js';
import { hashState } from '../src/engine/hash.js';
import { BRACE, CAPACITOR, DARK_STATION, FIX, braced, chargeOf, fixOf, gunSlot, pdSlot, roleOf, stationPace, weaponsPowered, whyNoJump } from '../src/sim/combat.js';
import { DARK_WALK } from '../src/sim/crew.js';
import { airlockRooms, nearestAirlock } from '../src/sim/boarding.js';
import { validateLayout } from '../src/sim/ship.js';
import { TICK_RATE, checkInvariants } from '../src/sim/sim.js';
import { content, newCrewedSim, newSim, shipCopy } from './helpers.js';

const steps = (sim, n) => {
  for (let i = 0; i < n; i++) sim.step();
  return sim;
};
const seconds = (sim, s) => steps(sim, Math.round(s * TICK_RATE));
const PD = content.require('weapons', 'point-defence');
const SLUGS = content.require('weapons', 'slug-thrower');
const LASER = content.require('weapons', 'pulse-laser');

/** Move bars around so the weapons system has `bars` (dropping sensors, doors and engines as needed). */
function powerWeapons(sim, bars) {
  for (const system of ['sensors', 'doors', 'engines'].slice(0, bars)) sim.enqueue({ type: 'power.add', system, delta: -1 });
  sim.step();
  for (let i = 0; i < bars; i++) sim.enqueue({ type: 'power.add', system: 'weapons', delta: 1 });
  sim.step();
  assert.equal(sim.state.systems.weapons.power, bars);
}

/** Two bars on the shields, from the sensors and the doors. */
function powerShields(sim) {
  sim.enqueue({ type: 'power.add', system: 'sensors', delta: -1 });
  sim.enqueue({ type: 'power.add', system: 'doors', delta: -1 });
  sim.step();
  sim.enqueue({ type: 'power.add', system: 'shields', delta: 1 });
  sim.enqueue({ type: 'power.add', system: 'shields', delta: 1 });
  sim.step();
}

test('weapons are content: a hauler mounts point defence and one deterrent gun; the rest are what other ships fire', () => {
  assert.deepEqual(content.all('weapons').filter((w) => w.mount !== false).map((w) => [w.id, w.role]), [['point-defence', 'pd'], ['slug-thrower', 'gun']]);
  assert.deepEqual(content.all('weapons').filter((w) => w.mount === false).map((w) => w.id), ['pulse-laser', 'breaching-lance', 'drone-zap']);
  assert.equal(SLUGS.range > 0, true, 'a gun says how far it reaches');
  const broken = { ...LASER, id: 'broken', power: 0, charge: -1, effects: { fire: 2 }, role: 'cannon' };
  const { errors } = validateContent([{ path: 'weapons/x.json', data: { items: [broken] } }]);
  assert.equal(errors.length, 4, errors.join('\n'));
  const { errors: noRange } = validateContent([{ path: 'weapons/x.json', data: { items: [{ ...SLUGS, id: 'x', range: undefined }] } }]);
  assert.ok(noRange.some((e) => /a gun needs a range/.test(e)), noRange.join('\n'));
});

test('a ship that fits a weapon no ship can mount, or one nobody made, is caught by the content check', () => {
  const mounted = validateContent([
    { path: 'ships/x.json', data: { items: [{ ...shipCopy(), weapons: ['point-defence', 'drone-zap'] }] } },
    { path: 'weapons/x.json', data: { items: [PD, { ...LASER, id: 'drone-zap', mount: false }] } },
  ]);
  assert.ok(mounted.errors.some((e) => /which no ship can mount/.test(e)), mounted.errors.join('\n'));
  const missing = validateContent([
    { path: 'ships/x.json', data: { items: [{ ...shipCopy(), weapons: ['point-defence', 'death-ray'] }] } },
    { path: 'weapons/x.json', data: { items: [PD] } },
  ]);
  assert.ok(missing.errors.some((e) => /fits a weapon that does not exist: "death-ray"/.test(e)), missing.errors.join('\n'));
});

test('a ship needs hull points, 2 to 4 hardpoints and every system; enemy ships are no longer a kind of layout', () => {
  const data = shipCopy();
  delete data.hullPoints;
  data.hardpoints = data.hardpoints.slice(0, 1);
  const problems = validateLayout(data);
  assert.ok(problems.some((p) => /hullPoints/.test(p)));
  assert.ok(problems.some((p) => /2 to 4 hardpoints/.test(p)));
  assert.ok(validateLayout({ ...shipCopy(), weapons: ['a', 'b', 'c', 'd'] }).some((p) => /4 weapons fitted but only 3 hardpoints/.test(p)));
  assert.ok(validateLayout({ ...shipCopy(), enemy: true }).length > 0, 'the enemy flag is gone with the duel (H.3)');
  assert.equal(content.all('ships').length, 1, 'the only ship drawn as a ship is ours');
});

test('the Margin of Error starts with point defence and the slug thrower, a whole hull, and the gun loaded', () => {
  const sim = newSim();
  assert.deepEqual(sim.state.hull, { points: 20, max: 20 });
  assert.deepEqual(sim.state.weapons.map((w) => w.id), ['point-defence', 'slug-thrower']);
  assert.deepEqual([pdSlot(sim), gunSlot(sim), roleOf(sim, 0), roleOf(sim, 1)], [0, 1, 'pd', 'gun']);
  assert.equal(sim.state.fight, undefined, 'there is no fight state any more');
  assert.deepEqual(sim.state.shield, { charge: 0, field: 0, until: 0 });
  assert.deepEqual(sim.state.weapons.map((w) => w.rounds), [null, SLUGS.ammo.magazine], 'point defence needs no rounds; the slug thrower starts loaded');
  assert.deepEqual(sim.state.shots, []);
});

test('weapons take the system\'s bars in hardpoint order, charge with power and drain without', () => {
  const sim = newSim();
  assert.deepEqual(weaponsPowered(sim), [false, false]);
  powerWeapons(sim, 1);
  assert.deepEqual(weaponsPowered(sim), [true, false], 'one bar runs point defence, which is first on the hardpoints');
  sim.enqueue({ type: 'power.add', system: 'doors', delta: -1 });
  sim.step();
  sim.enqueue({ type: 'power.add', system: 'weapons', delta: 1 });
  sim.step();
  assert.deepEqual(weaponsPowered(sim), [true, true]);
  const ready = [];
  sim.events.on('weapon.ready', (e) => ready.push(e.slot));
  seconds(sim, SLUGS.charge / 2);
  assert.ok(Math.abs(chargeOf(sim, 1) - 0.5) < 0.03, `${chargeOf(sim, 1)}`);
  seconds(sim, SLUGS.charge);
  assert.equal(chargeOf(sim, 1), 1, 'a charged gun with nothing to lay on holds its charge');
  assert.equal(chargeOf(sim, 0), 1, 'and so does point defence with nothing coming');
  assert.deepEqual(ready, [1], 'only the gun says it is ready');
  sim.enqueue({ type: 'power.add', system: 'weapons', delta: -1 });
  seconds(sim, SLUGS.charge / 4);
  assert.ok(chargeOf(sim, 1) < 0.6 && chargeOf(sim, 1) > 0.4, 'charge drains twice as fast as it built');
  assert.deepEqual(checkInvariants(sim), []);
});

test('the shield capacitor charges from its bars, a unit a bar, and holds no more than they give', () => {
  const sim = newSim();
  powerShields(sim);
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

test('a brace works any time, soaks what lands for a few seconds, costs more against a gun that pierces, and lights the ship up', () => {
  const sim = newSim();
  assert.match(sim.whyNot({ type: 'ship.brace' }), /no power/);
  powerShields(sim);
  sim.state.shield.charge = 0.6;
  assert.match(sim.whyNot({ type: 'ship.brace' }), /capacitor is at 30%/);
  sim.state.shield.charge = 2;
  const flare = sim.state.flare;
  const resolved = [];
  sim.events.on('shot.resolved', (e) => resolved.push(e.result));
  sim.enqueue({ type: 'ship.brace' });
  sim.step();
  assert.equal(braced(sim), true, 'no fight needed: the brace is ours to use whenever');
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

test('debug.hit lands only on us: there is no other ship to hit', () => {
  const sim = newSim();
  assert.match(sim.whyNot({ type: 'debug.hit', at: 'them', room: null, weapon: 'pulse-laser' }), /no other ship/);
  assert.match(sim.whyNot({ type: 'debug.hit', at: 'us', room: 'nowhere', weapon: 'pulse-laser' }), /no room/);
  assert.equal(sim.whyNot({ type: 'debug.hit', room: null, weapon: 'pulse-laser' }), null);
});

test('a hit that takes the last hull point wrecks the ship, and the run ends with it', () => {
  const sim = newSim();
  sim.state.hull.points = 1;
  let wrecked = 0;
  sim.events.on('ship.wrecked', () => (wrecked += 1));
  sim.enqueue({ type: 'debug.hit', at: 'us', room: 'cargo', weapon: 'pulse-laser', force: true });
  sim.step();
  assert.equal(sim.state.hull.points, 0);
  assert.equal(wrecked, 1);
  seconds(sim, 1);
  assert.deepEqual(sim.state.weapons.map((w) => w.powered), [false, false], 'a wreck fires nothing');
  assert.equal(sim.whyNot({ type: 'ship.brace' }), 'the shields have no power');
});

test('nothing in the guns moves while the clock is stopped, and orders given then wait', () => {
  const sim = newSim();
  powerWeapons(sim, 2);
  seconds(sim, 2);
  const before = hashState({ weapons: sim.state.weapons, shield: sim.state.shield, shots: sim.state.shots });
  sim.enqueue({ type: 'power.add', system: 'weapons', delta: -1 }); // "paused": no step is taken
  assert.equal(hashState({ weapons: sim.state.weapons, shield: sim.state.shield, shots: sim.state.shots }), before);
  sim.step();
  assert.equal(sim.state.systems.weapons.power, 1);
});

test('a jump needs a sensor fix, a pilot at the helm and a bar on the engines; a hit shakes the fix', () => {
  // The fix itself builds while a course is plotted (sector.test.js); here, what a jump asks of the ship.
  const sim = newCrewedSim('fix');
  const go = (command) => {
    sim.enqueue(command);
    sim.step();
  };
  assert.match(whyNoJump(sim), /sensor fix is at 0%/);
  sim.state.fix = 1;
  assert.equal(whyNoJump(sim), null);
  const pilot = Object.values(sim.state.crew).find((m) => m.room === 'bridge');
  go({ type: 'crew.move', crew: pilot.id, room: 'medbay' });
  seconds(sim, 6);
  assert.match(whyNoJump(sim), /nobody is at the helm/);
  go({ type: 'crew.move', crew: pilot.id, room: 'bridge' });
  seconds(sim, 10);
  go({ type: 'power.add', system: 'engines', delta: -1 });
  assert.match(whyNoJump(sim), /engines have no power/);
  go({ type: 'power.add', system: 'engines', delta: 1 });
  go({ type: 'debug.hit', at: 'us', room: 'cargo', weapon: 'pulse-laser', force: true });
  assert.ok(Math.abs(fixOf(sim) - (1 - FIX.hit)) < 0.01, 'a hit on us costs a quarter of it');
  sim.state.fix = 0;
  go({ type: 'power.add', system: 'sensors', delta: -1 });
  assert.match(whyNoJump(sim), /sensors have no power to take a fix/);
});

test('running dark costs: a gun on a dark gun deck charges slower, and crew feel their way through an unlit room', () => {
  const charged = (dark) => {
    const sim = newCrewedSim('dark-gun');
    for (const system of ['sensors', 'doors']) sim.enqueue({ type: 'power.add', system, delta: -1 });
    sim.step();
    sim.enqueue({ type: 'power.add', system: 'weapons', delta: 1 });
    sim.enqueue({ type: 'power.add', system: 'weapons', delta: 1 });
    if (dark) sim.enqueue({ type: 'lights.all', on: false });
    seconds(sim, 2);
    assert.equal(stationPace(sim, sim.layout.roomOfSystem('weapons')), dark ? DARK_STATION : 1);
    seconds(sim, 4);
    return chargeOf(sim, gunSlot(sim));
  };
  const lit = charged(false);
  const dark = charged(true);
  assert.ok(dark < lit * 0.8, `lit ${lit}, dark ${dark}`);
  const walk = (dark) => {
    const sim = newCrewedSim('dark-walk');
    if (dark) sim.enqueue({ type: 'lights.all', on: false });
    seconds(sim, 2);
    sim.enqueue({ type: 'crew.move', crew: 'okoro', room: 'fore_corridor' });
    for (let i = 0; i < 60 * TICK_RATE; i++) {
      sim.step();
      if (sim.state.crew.okoro.room === 'fore_corridor' && !sim.state.crew.okoro.path.length) return i;
    }
    return Infinity;
  };
  const litWalk = walk(false);
  const darkWalk = walk(true);
  assert.ok(Number.isFinite(darkWalk) && darkWalk > litWalk * (1 + (1 - DARK_WALK) * 0.5), `lit ${litWalk} ticks, dark ${darkWalk}`);
});

test('every ship has an airlock, and the nearest one is found on foot (where a party comes aboard)', () => {
  const sim = newCrewedSim();
  assert.deepEqual(airlockRooms(sim).sort(), ['cargo', 'engines', 'hold', 'quarters']);
  assert.equal(nearestAirlock(sim, 'bridge'), 'quarters');
  assert.equal(nearestAirlock(sim, 'reactor'), 'engines');
});
