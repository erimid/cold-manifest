import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BREATHABLE_O2, FIRE_MIN_O2, isExposed, whyNotJettison } from '../src/sim/atmosphere.js';
import { litRooms } from '../src/sim/power.js';
import { running } from '../src/sim/stations.js';
import { validateLayout } from '../src/sim/ship.js';
import { TICK_RATE, checkInvariants } from '../src/sim/sim.js';
import { newSim, putCrew, shipCopy } from './helpers.js';

const seconds = (sim, s) => {
  for (let i = 0; i < Math.round(s * TICK_RATE); i++) sim.step();
};
const give = (sim, ...commands) => {
  for (const command of commands) sim.enqueue(command);
  sim.step();
};
const o2 = (sim, room) => sim.state.rooms[room].oxygen;
const noLifeSupport = (sim) => give(sim, { type: 'station.stand', station: 'life_support', down: true });
const listen = (sim, type) => {
  const heard = [];
  sim.events.on(type, (e) => heard.push(e));
  return heard;
};

test('air evens out through an open door and stays put behind a closed one', () => {
  const sim = newSim();
  noLifeSupport(sim);
  give(sim, { type: 'debug.room', room: 'medbay', set: { oxygen: 0 } });
  seconds(sim, 5);
  assert.ok(o2(sim, 'medbay') === 0, 'sealed: nothing gets in');
  const before = o2(sim, 'quarters');
  give(sim, { type: 'door.set', door: 'd_medbay_quarters', state: 'open' });
  seconds(sim, 20);
  // Medbay is 16 tiles and quarters 20, so they settle near 20/36 of what quarters had.
  assert.ok(Math.abs(o2(sim, 'medbay') - o2(sim, 'quarters')) < 0.01, 'the two rooms are level');
  assert.ok(Math.abs(o2(sim, 'medbay') - (before * 20) / 36) < 0.06, `settled at ${o2(sim, 'medbay')}`);
  assert.ok(o2(sim, 'bridge') > 0.9, 'rooms behind closed doors are untouched');
});

test('a breach drains a room until it is patched, faster the bigger it is', () => {
  const small = newSim();
  const big = newSim();
  give(small, { type: 'debug.room', room: 'cargo', set: { breach: 0.2 } });
  give(big, { type: 'debug.room', room: 'cargo', set: { breach: 1 } });
  assert.equal(isExposed(big, 'cargo'), true);
  seconds(small, 10);
  seconds(big, 10);
  assert.ok(o2(big, 'cargo') < o2(small, 'cargo') && o2(small, 'cargo') < 0.95);
  seconds(big, 60);
  assert.ok(o2(big, 'cargo') < BREATHABLE_O2, 'life support cannot keep up with a full breach');
  assert.ok(big.state.rooms.cargo.temperature < 0, 'and the room freezes');
  give(big, { type: 'debug.room', room: 'cargo', set: { breach: 0 } });
  seconds(big, 90);
  assert.ok(o2(big, 'cargo') > 0.95, 'patched, it refills');
  assert.ok(big.state.rooms.cargo.temperature > 15);
});

test('fire grows in good air, burns oxygen, heats the room and cooks its system', () => {
  const sim = newSim();
  const started = listen(sim, 'fire.started');
  const damage = listen(sim, 'system.damage');
  give(sim, { type: 'debug.room', room: 'shields', set: { fire: 0.3 } });
  seconds(sim, 20);
  const r = sim.state.rooms.shields;
  assert.ok(r.fire > 0.3, `fire grew to ${r.fire}`);
  assert.ok(r.oxygen < 1);
  assert.ok(r.temperature > 100);
  assert.ok(r.noise > 0);
  assert.deepEqual(started.map((e) => [e.room, e.cause]), [['shields', 'ignition']]);
  seconds(sim, 40);
  assert.ok(sim.state.systems.shields.damage >= 1, 'the shield system took damage');
  assert.equal(damage[0].cause, 'fire');
  assert.deepEqual(checkInvariants(sim), []);
});

test('fire dies at zero O2', () => {
  const sim = newSim();
  const out = listen(sim, 'fire.out');
  give(sim, { type: 'debug.room', room: 'brig', set: { fire: 1, oxygen: 0 } });
  assert.equal(sim.state.rooms.brig.fire, 0, 'no air, no fire, at once');

  // Starved rather than emptied: it shrinks fast below the minimum.
  give(sim, { type: 'debug.room', room: 'brig', set: { fire: 1, oxygen: FIRE_MIN_O2 / 2 } }, { type: 'station.stand', station: 'life_support', down: true });
  seconds(sim, 5);
  assert.equal(sim.state.rooms.brig.fire, 0);
  assert.equal(out.length, 2);
});

test('a fire in a closed room burns itself out', () => {
  const sim = newSim();
  noLifeSupport(sim);
  give(sim, { type: 'debug.room', room: 'brig', set: { fire: 0.5 } });
  seconds(sim, 240);
  assert.equal(sim.state.rooms.brig.fire, 0);
  assert.ok(o2(sim, 'brig') < FIRE_MIN_O2 + 0.02);
});

test('venting through an outer door puts a fire out', () => {
  const sim = newSim();
  give(sim, { type: 'debug.room', room: 'cargo', set: { fire: 0.9 } });
  seconds(sim, 1);
  give(sim, { type: 'door.set', door: 'airlock_cargo', state: 'open' });
  seconds(sim, 30); // the hold is the biggest room aboard (D-071)
  assert.equal(sim.state.rooms.cargo.fire, 0);
  assert.ok(o2(sim, 'cargo') < 0.05, 'life support cannot keep up with an open airlock');
  assert.equal(isExposed(sim, 'cargo'), true);
  give(sim, { type: 'door.set', door: 'airlock_cargo', state: 'closed' });
  seconds(sim, 90);
  assert.ok(o2(sim, 'cargo') > 0.9, 'shut the airlock and the air comes back');
});

test('venting kills unsuited crew', () => {
  const sim = newSim();
  const deaths = listen(sim, 'crew.died');
  putCrew(sim, 'bare', 'cargo');
  putCrew(sim, 'suited', 'cargo', { suit: true });
  putCrew(sim, 'elsewhere', 'bridge');
  give(sim, { type: 'door.set', door: 'airlock_cargo', state: 'open' });
  seconds(sim, 20);
  assert.equal(sim.state.crew.bare.alive, false);
  assert.equal(sim.state.crew.suited.alive, true);
  assert.equal(sim.state.crew.suited.health, 1);
  assert.equal(sim.state.crew.elsewhere.health, 1);
  assert.deepEqual(deaths.map((e) => [e.crew, e.room, e.cause]), [['bare', 'cargo', 'suffocation']]);
  assert.deepEqual(checkInvariants(sim), []);
});

test('fire hurts everyone in the room, a suit only halves it', () => {
  const sim = newSim();
  putCrew(sim, 'bare', 'weapons');
  putCrew(sim, 'suited', 'weapons', { suit: true });
  give(sim, { type: 'debug.room', room: 'weapons', set: { fire: 0.8 } });
  seconds(sim, 5);
  const { bare, suited } = sim.state.crew;
  assert.ok(bare.health < suited.health && suited.health < 1);
  assert.ok(Math.abs((1 - bare.health) - 2 * (1 - suited.health)) < 1e-9);
});

test('fire spreads to the next room, readily through an open door and rarely through a shut one', () => {
  let open = 0;
  let shut = 0;
  for (let i = 0; i < 40; i++) {
    for (const doorOpen of [true, false]) {
      const sim = newSim(`spread-${i}`);
      if (doorOpen) give(sim, { type: 'door.set', door: 'd_medbay_quarters', state: 'open' });
      give(sim, { type: 'debug.room', room: 'medbay', set: { fire: 1 } });
      seconds(sim, 20);
      const reached = sim.state.rooms.quarters.fire > 0;
      if (doorOpen) open += reached;
      else shut += reached;
    }
  }
  assert.ok(open >= 15, `spread through an open door in ${open} of 40 runs`);
  assert.ok(shut <= 6, `spread through a shut door in ${shut} of 40 runs`);
  assert.ok(open > shut * 3);
});

test('fire spread is seeded: the same seed burns the same way', () => {
  const burn = (seed) => {
    const sim = newSim(seed);
    give(sim, { type: 'door.set', door: 'd_bulkhead', state: 'open' }, { type: 'door.set', door: 'd_cargo', state: 'open' }, { type: 'debug.room', room: 'cargo', set: { fire: 1 } });
    seconds(sim, 120);
    return sim.snapshot();
  };
  assert.deepEqual(burn('same'), burn('same'));
  assert.notDeepEqual(burn('same').state.rooms, burn('other').state.rooms);
});

test('jettison needs a sealed section that can be cut loose', () => {
  const sim = newSim();
  assert.match(whyNotJettison(sim, 'reactor'), /spine of the ship/);
  assert.match(whyNotJettison(sim, 'aft_corridor'), /spine of the ship/);
  assert.equal(whyNotJettison(sim, 'cargo'), null);
  give(sim, { type: 'door.set', door: 'd_cargo', state: 'open' });
  assert.match(sim.whyNot({ type: 'room.jettison', room: 'cargo' }), /seal it first/);
  seconds(sim, 1);
  give(sim, { type: 'door.set', door: 'd_cargo', state: 'closed' });
  assert.match(sim.whyNot({ type: 'room.jettison', room: 'cargo' }), /seal it first/, 'not until the door has finished closing');
  seconds(sim, 1);
  assert.equal(sim.whyNot({ type: 'room.jettison', room: 'cargo' }), null);
  assert.match(sim.whyNot({ type: 'room.jettison', room: 'nowhere' }), /no room/);
});

test('jettison removes the section and everything in it', () => {
  const sim = newSim();
  const gone = listen(sim, 'room.jettisoned');
  const deaths = listen(sim, 'crew.died');
  putCrew(sim, 'inside', 'shields', { suit: true });
  putCrew(sim, 'outside', 'fore_corridor');
  give(sim, { type: 'station.stand', station: 'shields', down: false }, { type: 'debug.room', room: 'shields', set: { fire: 0.8, breach: 0.5 } });
  give(sim, { type: 'room.jettison', room: 'shields' });

  const r = sim.state.rooms.shields;
  assert.equal(r.jettisoned, true);
  assert.deepEqual([r.oxygen, r.fire, r.breach, r.lightsOn, r.hull], [0, 0, 0, false, 0]);
  assert.deepEqual(sim.state.systems.shields, { level: 2, damage: 2, lost: true });
  assert.equal(running(sim, 'shields'), false, 'its station is dark for good');
  assert.equal(litRooms(sim), 16);
  assert.equal(sim.state.crew.inside.alive, false, 'a suit does not help');
  assert.equal(sim.state.crew.outside.alive, true);
  assert.deepEqual(deaths.map((e) => [e.crew, e.cause]), [['inside', 'jettison']]);
  assert.deepEqual(gone.map((e) => [e.room, e.system, e.crew]), [['shields', 'shields', ['inside']]]);

  // Nothing about it can be worked again.
  assert.deepEqual(sim.state.doors.d_shields, { state: 'locked', openness: 0, sealed: true });
  for (const command of [
    { type: 'door.set', door: 'd_shields', state: 'open' },
    { type: 'debug.door', door: 'd_shields', jammed: true },
    { type: 'room.lights', room: 'shields', on: true },
    { type: 'debug.room', room: 'shields', set: { fire: 1 } },
    { type: 'room.jettison', room: 'shields' },
  ]) {
    assert.match(sim.whyNot(command), /gone/, command.type);
  }
  assert.match(sim.whyNot({ type: 'debug.system', system: 'shields', damage: 0 }), /went with its room/);
  assert.match(sim.whyNot({ type: 'station.stand', station: 'shields', down: true }), /went with its room/);

  // And the ship carries on without it: no air in, no fire across.
  give(sim, { type: 'debug.room', room: 'fore_corridor', set: { fire: 1 } });
  seconds(sim, 60);
  assert.equal(r.fire, 0);
  assert.equal(r.oxygen, 0);
  assert.deepEqual(checkInvariants(sim), []);
});

test('a jettisoned ship state survives a snapshot', () => {
  const a = newSim('j');
  give(a, { type: 'room.jettison', room: 'brig' }, { type: 'debug.room', room: 'cargo', set: { fire: 0.6 } });
  seconds(a, 3);
  const b = newSim('j');
  b.restore(JSON.parse(JSON.stringify(a.snapshot())));
  seconds(a, 30);
  seconds(b, 30);
  assert.deepEqual(a.snapshot(), b.snapshot());
});

test('the layout checker rejects a bad jettison flag', () => {
  const ship = shipCopy();
  ship.rooms[0].jettison = 'yes';
  assert.match(validateLayout(ship).join('\n'), /"jettison" must be true or false/);
});

test('a system broken by fire goes dark in the same tick', () => {
  const sim = newSim();
  give(sim, { type: 'debug.room', room: 'reactor', set: { fire: 1 } }, { type: 'debug.room', room: 'ai_core', set: { fire: 1 } });
  for (let i = 0; i < 120 * TICK_RATE; i++) {
    sim.step();
    assert.deepEqual(checkInvariants(sim), [], `tick ${sim.state.tick}`);
  }
  assert.equal(running(sim, 'ai_core'), false);
  assert.ok(sim.state.systems.reactor.damage >= 1, 'the reactor fire cut the supply');
  // With Margo's core burnt out and nobody aboard, nothing runs the air plant: the fires starve sooner than they used to.
  assert.equal(running(sim, 'life_support'), false);
});
