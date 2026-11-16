import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DARK_STATION, DRONE_WEAPON, chargeOf, enemyOf, stationPace } from '../src/sim/combat.js';
import { DARK_WALK } from '../src/sim/crew.js';
import { TICK_RATE, checkInvariants } from '../src/sim/sim.js';
import { ARCHETYPES, planOf, validateTactics } from '../src/sim/tactics.js';
import { content, newCrewedSim } from './helpers.js';

const steps = (sim, n) => {
  for (let i = 0; i < n; i++) sim.step();
  return sim;
};
const seconds = (sim, s) => steps(sim, Math.round(s * TICK_RATE));
const listen = (sim, type) => {
  const heard = [];
  sim.events.on(type, (event) => heard.push(event));
  return heard;
};

/** Start a fight, past any hail, with a perfect lock both ways. */
function fight(sim, enemy) {
  sim.enqueue({ type: 'debug.fight', enemy });
  sim.step();
  sim.enqueue({ type: 'debug.combat', action: 'scan' });
  sim.step();
  if (sim.state.fight.phase === 'hail') {
    sim.enqueue({ type: 'fight.engage' });
    sim.step();
  }
  // Let them make us out as well, so their guns and drones have somewhere to aim.
  const foe = enemyOf(sim);
  for (const room of Object.values(foe.state.contact.rooms)) Object.assign(room, { resolve: 1, live: true });
  Object.assign(foe.state.contact, { lock: 1, locked: true, pinned: true });
  return foe;
}

const ENEMIES = content.all('ships').filter((ship) => ship.enemy === true);

test('four enemy types beyond the skiff and the drone, one of each archetype the brief names', () => {
  const kinds = ENEMIES.map((ship) => ship.tactics?.archetype ?? 'drone');
  for (const archetype of ['gunner', 'boarder', 'tank', 'carrier']) assert.ok(kinds.includes(archetype), `no ${ARCHETYPES[archetype]?.label ?? archetype}`);
  assert.ok(ENEMIES.length >= 6);
});

test('every enemy can be fought for a minute with nothing going wrong', () => {
  for (const ship of ENEMIES) {
    const sim = newCrewedSim(`enemy-${ship.id}`);
    fight(sim, ship.id);
    for (let i = 0; i < 60 * TICK_RATE && !sim.state.fight.over; i++) {
      sim.step();
      if (i % TICK_RATE === 0) assert.deepEqual(checkInvariants(sim), [], `${ship.id} at tick ${sim.state.tick}`);
    }
  }
});

test('a glass cannon fires each gun the moment it is charged; the others wait to fire together', () => {
  const sim = newCrewedSim('cutter');
  fight(sim, 'knife-cutter');
  assert.equal(planOf(enemyOf(sim).layout).volley, false);
  const fired = listen(sim, 'weapon.fired');
  seconds(sim, 14); // a laser charges in 8 s, the lance in 18
  const theirs = fired.filter((shot) => shot.side === 'enemy');
  assert.ok(theirs.some((shot) => shot.weapon === 'pulse-laser'), 'the lasers did not wait for the lance');
  assert.ok(!theirs.some((shot) => shot.weapon === 'breaching-lance'));
});

test('a carrier launches drones up to its limit, and each drone zaps us', () => {
  const sim = newCrewedSim('carrier');
  fight(sim, 'drone-carrier');
  const spec = planOf(enemyOf(sim).layout).drones;
  const launched = listen(sim, 'drone.launched');
  const zaps = listen(sim, 'drone.fired');
  seconds(sim, spec.every * (spec.max + 1) + spec.fire);
  assert.equal(launched.length, spec.max, 'no more than the limit');
  assert.equal(sim.state.fight.drones.length, spec.max);
  assert.ok(zaps.length >= spec.max);
  assert.ok(zaps.every((shot) => shot.weapon === DRONE_WEAPON && shot.side === 'enemy'));
  assert.deepEqual(checkInvariants(sim), []);
});

test('a drone that zaps into a brace burns out; the rest fall dead when the bay loses power', () => {
  const sim = newCrewedSim('carrier-brace');
  const foe = fight(sim, 'drone-carrier');
  const spec = planOf(foe.layout).drones;
  // A brace needs a capacitor: a bar on the shields.
  sim.enqueue({ type: 'power.add', system: 'sensors', delta: -1 });
  sim.step();
  sim.enqueue({ type: 'power.add', system: 'shields', delta: 1 });
  seconds(sim, spec.every * 2 + 1);
  assert.equal(sim.state.fight.drones.length, 2);
  const lost = listen(sim, 'drone.lost');
  // Hold a big field up until a zap meets it.
  for (let i = 0; i < spec.fire * 2 * TICK_RATE && !lost.length; i++) {
    Object.assign(sim.state.shield, { field: 5, until: sim.state.tick + 40 });
    sim.step();
  }
  assert.equal(lost[0]?.cause, 'brace');
  assert.equal(sim.state.fight.drones.length, 1);
  sim.state.shield.field = 0;
  foe.state.systems.weapons.power = 0;
  sim.step();
  assert.equal(sim.state.fight.drones.length, 0);
  assert.equal(lost.at(-1).cause, 'bay');
});

test('the content check knows what a drone bay needs', () => {
  const problems = validateTactics({ archetype: 'carrier', drones: { every: 0, max: 1.5, fire: -1 } }, { crewed: true });
  assert.equal(problems.length, 3, problems.join('\n'));
  assert.deepEqual(validateTactics({ archetype: 'carrier', drones: { every: 9, max: 3, fire: 5 } }, { crewed: true }), []);
});

test('running dark costs: a gun on a dark gun deck charges slower', () => {
  const charged = (dark) => {
    const sim = newCrewedSim('dark-gun');
    fight(sim, 'target-drone');
    for (const system of ['sensors', 'doors', 'engines']) sim.enqueue({ type: 'power.add', system, delta: -1 });
    sim.step();
    sim.enqueue({ type: 'power.add', system: 'weapons', delta: 1 });
    if (dark) sim.enqueue({ type: 'lights.all', on: false });
    seconds(sim, 2);
    assert.equal(stationPace(sim, sim.layout.roomOfSystem('weapons')), dark ? DARK_STATION : 1);
    seconds(sim, 4);
    return chargeOf(sim, 0);
  };
  const lit = charged(false);
  const dark = charged(true);
  assert.ok(dark < lit * 0.8, `lit ${lit}, dark ${dark}`);
  // A ship with nobody aboard does not care.
  const sim = newCrewedSim('dark-drone');
  const drone = fight(sim, 'target-drone');
  for (const room of Object.values(drone.state.rooms)) room.light = 0;
  assert.equal(stationPace(drone, drone.layout.roomOfSystem('shields')), 1);
});

test('running dark costs: crew feel their way through an unlit room', () => {
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
  const lit = walk(false);
  const dark = walk(true);
  assert.ok(Number.isFinite(dark) && dark > lit * (1 + (1 - DARK_WALK) * 0.5), `lit ${lit} ticks, dark ${dark}`);
});
