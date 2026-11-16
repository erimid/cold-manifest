// S2.2: what a hit does. Shot resolution, system damage, fire and breaches through the Stage 1 hazard code, crew injury.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FIRE_START } from '../src/sim/atmosphere.js';
import { HIT, ROOM_HULL_PER_DAMAGE, applyHit, enemyOf } from '../src/sim/combat.js';
import { supply, used } from '../src/sim/power.js';
import { TICK_RATE, checkInvariants } from '../src/sim/sim.js';
import { content, newCrewedSim, newSim, newTalkingSim, putCrew } from './helpers.js';

const steps = (sim, n) => {
  for (let i = 0; i < n; i++) sim.step();
  return sim;
};
const seconds = (sim, s) => steps(sim, Math.round(s * TICK_RATE));
const SLUGS = content.require('weapons', 'slug-thrower');
const LASER = content.require('weapons', 'pulse-laser');
/** A made-up weapon with sure effects, so a test does not hang on the dice. */
const sure = (effects, damage = 1) => ({ id: 'test-gun', damage, pierce: 0, effects: { fire: 0, breach: 0, crew: 0, ...effects } });

function collect(sim, type) {
  const seen = [];
  sim.events.on(type, (event) => seen.push(event));
  return seen;
}

function fight(sim) {
  sim.enqueue({ type: 'debug.fight', enemy: 'target-drone' });
  sim.step();
  sim.enqueue({ type: 'debug.combat', action: 'scan' }); // a perfect lock: these tests are about what a hit does
  sim.step();
  return enemyOf(sim);
}

test('a hit breaks a bar of the room\'s system per point of damage, and the power lets go at once', () => {
  const sim = newSim();
  sim.state.systems.engines.power = 2;
  sim.state.systems.sensors.power = 0;
  const damage = collect(sim, 'system.damage');
  const effects = applyHit(sim, sim, 'engines', SLUGS);
  assert.equal(effects.system, 2);
  assert.equal(sim.state.systems.engines.damage, 2);
  assert.equal(sim.state.systems.engines.power, 0, 'no bar is left on a broken system');
  assert.deepEqual(checkInvariants(sim), []);
  assert.deepEqual(damage.map((e) => [e.system, e.from, e.to, e.cause]), [['engines', 0, 2, 'hit']]);
  // A system that is already broken takes no more.
  assert.equal(applyHit(sim, sim, 'engines', SLUGS).system, 0);
  assert.equal(sim.state.systems.engines.damage, 2);
});

test('a hit on the reactor cuts supply and browns the ship out in the same tick', () => {
  const sim = newSim();
  assert.equal(used(sim), supply(sim), 'the ship starts with every bar in use');
  const brownouts = collect(sim, 'power.brownout');
  applyHit(sim, sim, 'reactor', SLUGS);
  assert.equal(supply(sim), 6);
  assert.ok(used(sim) <= supply(sim));
  assert.equal(brownouts.length, 1);
  assert.deepEqual(checkInvariants(sim), []);
});

test('a hit takes hull points and wears the room; a room with no system loses nothing else', () => {
  const sim = newSim();
  const effects = applyHit(sim, sim, 'aft_corridor', sure({}, 2));
  assert.equal(sim.state.hull.points, sim.state.hull.max - 2);
  assert.equal(sim.state.rooms.aft_corridor.hull, 1 - ROOM_HULL_PER_DAMAGE * 2);
  assert.deepEqual(effects, { system: 0, fire: false, breach: false, crew: [] });
});

test('fire from a hit is run by the exact Stage 1 fire code: it plays out the same as a fire lit by hand', () => {
  // Two ships from one seed. One is hit; the other has the same fire set through the debug panel. Their air,
  // fire and hazard dice are the same streams, so everything that follows must match exactly.
  const hit = newCrewedSim('same');
  const lit = newCrewedSim('same');
  steps(hit, 5);
  steps(lit, 5);
  const started = [collect(hit, 'fire.started'), collect(lit, 'fire.started')];
  const effects = applyHit(hit, hit, 'fore_corridor', sure({ fire: 1 }));
  assert.equal(effects.fire, true);
  assert.equal(hit.state.rooms.fore_corridor.fire, FIRE_START);
  lit.enqueue({ type: 'debug.room', room: 'fore_corridor', set: { fire: FIRE_START } });
  seconds(hit, 40);
  seconds(lit, 40);
  const without = (rooms) => Object.fromEntries(Object.entries(rooms).map(([id, r]) => [id, { ...r, hull: 0 }]));
  assert.deepEqual(without(hit.state.rooms), without(lit.state.rooms));
  assert.deepEqual(hit.state.crew, lit.state.crew);
  assert.deepEqual(started[0], started[1]);
  assert.ok(started[0].length >= 1, 'the fire was announced by the hazard code');
});

test('a breach from a hit is run by the exact Stage 1 breach code too', () => {
  const hit = newCrewedSim('holed');
  const cut = newCrewedSim('holed');
  const opened = [collect(hit, 'breach.opened'), collect(cut, 'breach.opened')];
  const effects = applyHit(hit, hit, 'aft_corridor', sure({ breach: 1 }));
  assert.equal(effects.breach, true);
  assert.equal(hit.state.rooms.aft_corridor.breach, HIT.breachPerDamage);
  cut.enqueue({ type: 'debug.room', room: 'aft_corridor', set: { breach: HIT.breachPerDamage } });
  seconds(hit, 30);
  seconds(cut, 30);
  const without = (rooms) => Object.fromEntries(Object.entries(rooms).map(([id, r]) => [id, { ...r, hull: 0 }]));
  assert.deepEqual(without(hit.state.rooms), without(cut.state.rooms));
  assert.deepEqual(hit.state.crew, cut.state.crew);
  assert.deepEqual(opened[0], opened[1]);
  assert.equal(opened[0].length, 1);
});

test('fire needs air: a hit on an airless room does not light it', () => {
  const sim = newSim();
  sim.state.rooms.cargo.oxygen = 0.1;
  assert.equal(applyHit(sim, sim, 'cargo', sure({ fire: 1 })).fire, false);
  assert.equal(sim.state.rooms.cargo.fire, 0);
});

test('a hit on a fire feeds it; a hit on a hole makes it bigger', () => {
  const sim = newSim();
  sim.state.rooms.cargo.fire = 0.5;
  sim.state.rooms.brig.breach = 0.5;
  applyHit(sim, sim, 'cargo', sure({ fire: 1 }));
  applyHit(sim, sim, 'brig', sure({ breach: 1 }, 2));
  assert.equal(sim.state.rooms.cargo.fire, 0.5 + FIRE_START);
  assert.equal(sim.state.rooms.brig.breach, Math.min(1, 0.5 + HIT.breachPerDamage * 2));
});

test('a worn room gives way: lasers never hole a sound hull, but often hole a battered one', () => {
  const holes = (wear) => {
    let n = 0;
    for (let i = 0; i < 200; i++) {
      const sim = newSim(`wear-${i}`);
      sim.state.rooms.cargo.hull = 1 - wear;
      if (applyHit(sim, sim, 'cargo', { ...LASER, damage: 0 }).breach) n += 1;
    }
    return n;
  };
  assert.equal(holes(0), 0);
  const battered = holes(1);
  assert.ok(battered > 90 && battered < 150, `${battered} of 200 at full wear (expected about ${200 * HIT.wearBreach})`);
});

test('crew caught in the room are hurt, warned about at half health, and can be killed by it', () => {
  const sim = newCrewedSim();
  const member = putCrew(sim, 'test-crew', 'cargo');
  const bystander = putCrew(sim, 'elsewhere', 'brig');
  const hurt = collect(sim, 'crew.hurt');
  const died = collect(sim, 'crew.died');
  const gun = sure({ crew: 1 }, 2);
  assert.deepEqual(applyHit(sim, sim, 'cargo', gun).crew, ['test-crew']);
  assert.equal(member.health, 1 - HIT.crewHarmPerDamage * 2);
  assert.equal(hurt.length, 0);
  applyHit(sim, sim, 'cargo', gun);
  assert.deepEqual(hurt.map((e) => [e.crew, e.cause]), [['test-crew', 'hit']]);
  applyHit(sim, sim, 'cargo', gun);
  assert.equal(member.alive, false);
  assert.deepEqual(died.map((e) => [e.crew, e.cause]), [['test-crew', 'hit']]);
  assert.equal(bystander.health, 1, 'nobody outside the room is touched');
  // The dead are not hit again.
  assert.deepEqual(applyHit(sim, sim, 'cargo', gun).crew, []);
});

test('the dice are rolled the same whatever the room holds, so one change does not reshuffle the fight', () => {
  const a = newSim('dice');
  const b = newSim('dice');
  b.state.rooms.cargo.oxygen = 0; // no fire can catch here
  applyHit(a, a, 'cargo', SLUGS);
  applyHit(b, b, 'cargo', SLUGS);
  assert.equal(a.rng.stream('combat').next(), b.rng.stream('combat').next());
});

test('shots on the drone: what happens aboard it is announced as theirs, not ours', () => {
  const sim = newCrewedSim('drone-fire');
  const enemy = fight(sim);
  const ours = collect(sim, 'fire.started');
  const theirs = collect(sim, 'enemy.fire.started');
  const hits = collect(sim, 'enemy.hull.hit');
  const damage = collect(sim, 'enemy.system.damage');
  applyHit(sim, enemy, 'shields', sure({ fire: 1 }));
  sim.step();
  assert.equal(ours.length, 0);
  assert.equal(theirs.length, 1);
  assert.equal(hits.length, 1);
  assert.deepEqual(damage.map((e) => e.system), ['shields']);
  assert.equal(enemy.state.systems.shields.power, 0, 'their shield lost its bar');
  assert.deepEqual(checkInvariants(sim), []);
});

test('debug.hit lands a shot at once on either ship; force makes it a hit through shields', () => {
  const sim = newCrewedSim('debug-hit');
  assert.match(sim.whyNot({ type: 'debug.hit', at: 'them', room: null, weapon: 'slug-thrower' }), /no enemy ship/);
  assert.match(sim.whyNot({ type: 'debug.hit', at: 'us', room: 'nowhere', weapon: 'slug-thrower' }), /no room/);
  assert.match(sim.whyNot({ type: 'debug.hit', at: 'us', room: null, weapon: 'ray-gun' }), /no weapon/);
  assert.match(sim.whyNot({ type: 'debug.hit', at: 'sideways', room: null, weapon: 'slug-thrower' }), /at must be/);
  const resolved = collect(sim, 'shot.resolved');
  sim.state.systems.shields.power = 2;
  sim.state.systems.sensors.power = 0;
  sim.state.systems.doors.power = 0;
  sim.state.shield.charge = 2;
  sim.enqueue({ type: 'debug.hit', at: 'us', room: 'weapons', weapon: 'slug-thrower', force: true });
  sim.step();
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].result, 'hit');
  assert.equal(resolved[0].side, 'enemy', 'a shot at us is theirs');
  assert.equal(resolved[0].damage, 2);
  assert.equal(resolved[0].effects.system, 2);
  assert.equal(sim.state.shield.charge, 2, 'a forced hit leaves the shield alone');
  assert.equal(sim.state.hull.points, sim.state.hull.max - 2);
  // Unforced, the shield takes it, and nothing else happens.
  sim.enqueue({ type: 'debug.hit', at: 'us', room: 'weapons', weapon: 'slug-thrower' });
  sim.step();
  assert.ok(['shield', 'miss'].includes(resolved[1].result));
  assert.equal(resolved[1].effects, null);
  // With no room named, it picks one.
  sim.enqueue({ type: 'debug.hit', at: 'us', room: null, weapon: 'pulse-laser', force: true });
  sim.step();
  assert.ok(sim.state.rooms[resolved[2].room]);
  assert.deepEqual(checkInvariants(sim), []);
});

test('a hit that takes the last hull point decides the fight', () => {
  const sim = newCrewedSim('last');
  const enemy = fight(sim);
  enemy.state.hull.points = 2;
  sim.enqueue({ type: 'debug.hit', at: 'them', room: 'reactor', weapon: 'slug-thrower', force: true });
  sim.step();
  assert.deepEqual({ ...sim.state.fight.over, tick: 0 }, { outcome: 'destroyed', tick: 0 });
  assert.match(sim.whyNot({ type: 'debug.hit', at: 'them', room: null, weapon: 'slug-thrower' }), /over/);
});

test('real shots: a stripped drone under fire burns, breaks and holes through the same code', () => {
  const sim = newCrewedSim('range');
  const enemy = fight(sim);
  Object.assign(enemy.state.systems.shields, { power: 0 });
  Object.assign(enemy.state.systems.engines, { power: 0 });
  enemy.state.shield.charge = 0;
  enemy.state.hull.points = enemy.state.hull.max = 400; // let it soak up a long fight
  for (const system of ['sensors', 'doors', 'engines']) sim.enqueue({ type: 'power.add', system, delta: -1 });
  sim.step();
  for (let i = 0; i < 3; i++) sim.enqueue({ type: 'power.add', system: 'weapons', delta: 1 });
  sim.enqueue({ type: 'weapon.target', slot: 0, room: 'weapons' });
  sim.enqueue({ type: 'weapon.target', slot: 1, room: 'reactor' });
  const fires = collect(sim, 'enemy.fire.started');
  const breaches = collect(sim, 'enemy.breach.opened');
  const broken = collect(sim, 'enemy.system.damage');
  for (let i = 0; i < 240 * TICK_RATE; i++) {
    sim.step();
    const problems = checkInvariants(sim);
    assert.deepEqual(problems, [], `tick ${sim.state.tick}`);
  }
  assert.ok(fires.length > 0, 'something caught fire');
  assert.ok(breaches.length > 0, 'something was holed');
  assert.ok(broken.some((e) => e.cause === 'hit'), 'something was broken by a hit');
  assert.equal(enemy.state.systems.reactor.damage, enemy.state.systems.reactor.level, 'their reactor is wrecked');
});

test('Margo says something when we are hit', () => {
  const sim = newTalkingSim('ouch');
  seconds(sim, 8); // past her greeting
  const lines = collect(sim, 'ai.line');
  applyHit(sim, sim, 'aft_corridor', sure({}));
  seconds(sim, 5);
  assert.ok(lines.some((line) => line.trigger === 'hull.hit' && line.category === 'hazard'), lines.map((l) => l.trigger).join(', '));
});
