import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createRng } from '../src/engine/rng.js';
import { POWERED, SHED_ORDER, aiCoreStatus, free, lightsDraw, litRooms, routed, supply, used, validatePower } from '../src/sim/power.js';
import { validateLayout } from '../src/sim/ship.js';
import { DOOR_SECONDS, MANUAL_DOOR_SECONDS, TICK_RATE, checkInvariants } from '../src/sim/sim.js';
import { newSim, putCrew, shipCopy } from './helpers.js';

const run = (sim, ticks = 1) => {
  for (let i = 0; i < ticks; i++) sim.step();
};
const give = (sim, command) => {
  sim.enqueue(command);
  sim.step();
};
const power = (sim, id) => sim.state.systems[id].power;

test('the ship starts within its reactor output, with every powered system present', () => {
  const sim = newSim();
  assert.equal(supply(sim), 8);
  assert.equal(lightsDraw(sim), 3);
  assert.ok(used(sim) <= supply(sim));
  for (const id of POWERED) assert.ok(sim.state.systems[id].level >= 1, id);
  assert.equal(sim.state.systems.reactor.power, 0);
  assert.deepEqual(checkInvariants(sim), []);
});

test('routing moves one bar at a time and refuses what cannot work', () => {
  const sim = newSim();
  assert.equal(free(sim), 0);
  assert.match(sim.whyNot({ type: 'power.add', system: 'shields', delta: 1 }), /no spare power/);
  give(sim, { type: 'power.add', system: 'sensors', delta: -1 });
  assert.equal(power(sim, 'sensors'), 0);
  assert.equal(free(sim), 1);
  give(sim, { type: 'power.add', system: 'shields', delta: 1 });
  assert.equal(power(sim, 'shields'), 1);
  assert.match(sim.whyNot({ type: 'power.add', system: 'sensors', delta: -1 }), /no power to take back/);
  assert.match(sim.whyNot({ type: 'power.add', system: 'life_support', delta: 1 }), /full power/);
  assert.match(sim.whyNot({ type: 'power.add', system: 'cargo', delta: 1 }), /does not take power/);
  assert.match(sim.whyNot({ type: 'power.add', system: 'shields', delta: 2 }), /delta/);
});

test('two orders for the last free bar: the second is dropped, not overdrawn', () => {
  const sim = newSim();
  give(sim, { type: 'power.add', system: 'sensors', delta: -1 });
  const dropped = [];
  sim.events.on('command.dropped', (e) => dropped.push(e.reason));
  sim.enqueue({ type: 'power.add', system: 'shields', delta: 1 });
  sim.enqueue({ type: 'power.add', system: 'weapons', delta: 1 });
  sim.step();
  assert.equal(power(sim, 'shields'), 1);
  assert.equal(power(sim, 'weapons'), 0);
  assert.deepEqual(dropped, ['no spare power']);
});

test('routing works while paused orders wait: nothing changes until a tick runs', () => {
  const sim = newSim();
  sim.enqueue({ type: 'power.add', system: 'engines', delta: -1 });
  assert.equal(power(sim, 'engines'), 1);
  sim.step();
  assert.equal(power(sim, 'engines'), 0);
});

test('lights draw power: dark rooms free a bar, and relighting needs one', () => {
  const sim = newSim();
  const rooms = sim.layout.rooms.map((r) => r.id);
  for (const room of rooms.slice(0, 5)) sim.enqueue({ type: 'room.lights', room, on: false });
  sim.step();
  assert.equal(litRooms(sim), 12);
  assert.equal(lightsDraw(sim), 2);
  assert.equal(free(sim), 1);
  // A room can come back on while the lights' own bar has room for it...
  give(sim, { type: 'room.lights', room: rooms[0], on: true });
  assert.equal(lightsDraw(sim), 3);
  assert.equal(free(sim), 0);
  give(sim, { type: 'room.lights', room: rooms[1], on: true });
  assert.equal(litRooms(sim), 14);
  // ...but not once that would take a bar that is spent elsewhere.
  for (const room of rooms.slice(0, 5)) sim.enqueue({ type: 'room.lights', room, on: false });
  sim.step();
  give(sim, { type: 'power.add', system: 'shields', delta: 1 });
  assert.equal(free(sim), 0);
  assert.match(sim.whyNot({ type: 'room.lights', room: rooms[0], on: true }), /no spare power/);
});

test('damage caps a system and unplugs the broken bars', () => {
  const sim = newSim();
  give(sim, { type: 'debug.system', system: 'engines', damage: 2 });
  assert.equal(power(sim, 'engines'), 0);
  assert.match(sim.whyNot({ type: 'power.add', system: 'engines', delta: 1 }), /damaged/);
  give(sim, { type: 'debug.system', system: 'engines', damage: 1 });
  assert.equal(power(sim, 'engines'), 0, 'power does not come back by itself');
  give(sim, { type: 'power.add', system: 'engines', delta: 1 });
  assert.equal(power(sim, 'engines'), 1);
  assert.match(sim.whyNot({ type: 'debug.system', system: 'engines', damage: 3 }), /between 0 and 2/);
});

test('reactor damage browns the ship out in shed order, life support last', () => {
  const sim = newSim();
  const events = [];
  sim.events.on('power.changed', (e) => events.push(`${e.system}:${e.reason}`));
  give(sim, { type: 'debug.system', system: 'reactor', damage: 2 });
  assert.equal(supply(sim), 6);
  assert.ok(used(sim) <= 6);
  assert.deepEqual(events, ['sensors:brownout', 'engines:brownout']);
  give(sim, { type: 'debug.system', system: 'reactor', damage: 7 });
  assert.equal(supply(sim), 1);
  assert.equal(litRooms(sim), 0, 'the lights went');
  assert.equal(power(sim, 'life_support'), 1, 'life support is the last thing standing');
  assert.equal(routed(sim), 1);
  give(sim, { type: 'debug.system', system: 'reactor', damage: 8 });
  assert.equal(used(sim), 0);
  assert.deepEqual(checkInvariants(sim), []);
  assert.equal(SHED_ORDER.at(-1), 'life_support');
});

test('power never exceeds supply, whatever is thrown at it', () => {
  const sim = newSim('fuzz');
  const dice = createRng('power-fuzz');
  const rooms = sim.layout.rooms.map((r) => r.id);
  const systems = Object.keys(sim.state.systems);
  let accepted = 0;
  for (let i = 0; i < 4000; i++) {
    const roll = dice.next();
    let command;
    if (roll < 0.5) command = { type: 'power.add', system: dice.pick(POWERED), delta: dice.chance(0.6) ? 1 : -1 };
    else if (roll < 0.8) command = { type: 'room.lights', room: dice.pick(rooms), on: dice.chance(0.6) };
    else {
      const system = dice.pick(systems);
      command = { type: 'debug.system', system, damage: dice.int(sim.state.systems[system].level + 1) };
    }
    if (!sim.whyNot(command)) {
      sim.enqueue(command);
      accepted += 1;
    }
    if (dice.chance(0.5)) {
      sim.step();
      assert.ok(used(sim) <= supply(sim), `tick ${sim.state.tick}: ${used(sim)} used of ${supply(sim)}`);
      assert.deepEqual(checkInvariants(sim), []);
    }
  }
  assert.ok(accepted > 1000);
});

test('unpowered doors need a crew member present', () => {
  const sim = newSim();
  const door = 'd_engines_reactor';
  give(sim, { type: 'power.add', system: 'doors', delta: -1 });
  assert.match(sim.whyNot({ type: 'door.set', door, state: 'open' }), /by hand/);
  assert.throws(() => sim.enqueue({ type: 'door.set', door, state: 'open' }), /by hand/);
  // Someone in the room next to it can haul it open, slowly.
  putCrew(sim, 'test', 'reactor');
  assert.equal(sim.whyNot({ type: 'door.set', door, state: 'open' }), null);
  assert.match(sim.whyNot({ type: 'door.set', door: 'd_bulkhead', state: 'open' }), /by hand/, 'but only a door they can reach');
  give(sim, { type: 'door.set', door, state: 'open' });
  run(sim, Math.ceil(DOOR_SECONDS * TICK_RATE) + 1);
  assert.ok(sim.state.doors[door].openness < 1, 'a hand-worked door is slower than a powered one');
  run(sim, Math.ceil(MANUAL_DOOR_SECONDS * TICK_RATE));
  assert.equal(sim.state.doors[door].openness, 1);
  // Locks are electric: no power, no locking or unlocking, hands or not.
  assert.match(sim.whyNot({ type: 'door.set', door, state: 'locked' }), /lock needs door control power/);
  // The dead cannot open doors.
  sim.state.crew.test.alive = false;
  assert.match(sim.whyNot({ type: 'door.set', door, state: 'closed' }), /by hand/);
});

test('a locked door stays locked when door control loses power', () => {
  const sim = newSim();
  give(sim, { type: 'door.set', door: 'd_brig', state: 'locked' });
  give(sim, { type: 'power.add', system: 'doors', delta: -1 });
  putCrew(sim, 'test', 'brig');
  assert.equal(sim.state.doors.d_brig.state, 'locked');
  assert.match(sim.whyNot({ type: 'door.set', door: 'd_brig', state: 'open' }), /lock needs door control power/);
  give(sim, { type: 'power.add', system: 'doors', delta: 1 });
  assert.equal(sim.whyNot({ type: 'door.set', door: 'd_brig', state: 'open' }), null);
});

test('an order given with power is dropped if the power is gone when it starts', () => {
  const sim = newSim();
  const dropped = [];
  sim.events.on('command.dropped', (e) => dropped.push(e.command.type));
  sim.enqueue({ type: 'power.add', system: 'doors', delta: -1 });
  sim.enqueue({ type: 'door.set', door: 'd_bulkhead', state: 'open' });
  sim.step();
  assert.deepEqual(dropped, ['door.set']);
  assert.equal(sim.state.doors.d_bulkhead.state, 'closed');
});

test('life support holds the air up, and the air goes stale without it', () => {
  const sim = newSim();
  give(sim, { type: 'debug.room', room: 'cargo', set: { oxygen: 0.5 } });
  run(sim, 10 * TICK_RATE);
  const refilled = sim.state.rooms.cargo.oxygen;
  assert.ok(refilled > 0.6 && refilled < 0.75, `refilled to ${refilled}`);
  give(sim, { type: 'power.add', system: 'life_support', delta: -1 });
  run(sim, 60 * TICK_RATE);
  assert.ok(sim.state.rooms.cargo.oxygen < refilled);
  assert.ok(sim.state.rooms.bridge.oxygen < 0.9 && sim.state.rooms.bridge.oxygen > 0.8);
  run(sim, 600 * TICK_RATE);
  assert.equal(sim.state.rooms.bridge.oxygen, 0);
  assert.deepEqual(checkInvariants(sim), []);
});

test('AI core status follows its power and damage', () => {
  const sim = newSim();
  assert.deepEqual(aiCoreStatus(sim), { state: 'nominal', degradation: 0 });
  give(sim, { type: 'power.add', system: 'ai_core', delta: -1 });
  assert.equal(aiCoreStatus(sim).state, 'offline');
  give(sim, { type: 'debug.system', system: 'ai_core', damage: 1 });
  assert.deepEqual(aiCoreStatus(sim), { state: 'offline', degradation: 1 });
});

test('power state survives a snapshot and replays exactly', () => {
  const a = newSim('p');
  give(a, { type: 'debug.system', system: 'reactor', damage: 3 });
  const snap = JSON.parse(JSON.stringify(a.snapshot()));
  const b = newSim('p');
  b.restore(snap);
  for (const sim of [a, b]) {
    give(sim, { type: 'debug.system', system: 'reactor', damage: 0 });
    give(sim, { type: 'power.add', system: 'weapons', delta: 1 });
    run(sim, 50);
  }
  assert.deepEqual(a.snapshot(), b.snapshot());
});

test('the layout checker rejects bad power data', () => {
  const noPower = shipCopy();
  delete noPower.power;
  assert.match(validateLayout(noPower).join('\n'), /needs a "power" block/);

  const greedy = shipCopy();
  greedy.power.systems.weapons.power = 3;
  assert.match(validatePower(greedy).join('\n'), /starts using 11 bars/);

  const broken = shipCopy();
  delete broken.power.systems.shields;
  broken.power.systems.cargo = { level: 1, power: 0 };
  broken.power.systems.engines.power = 5;
  broken.power.lightsPerBar = 0;
  const problems = validatePower(broken).join('\n');
  assert.match(problems, /missing "shields"/);
  assert.match(problems, /"cargo" is not a system that takes power/);
  assert.match(problems, /engines\.power/);
  assert.match(problems, /lightsPerBar/);
});
