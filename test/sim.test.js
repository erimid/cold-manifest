import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findBadNumbers, hashState, stableStringify } from '../src/engine/hash.js';
import { createStateMachine } from '../src/engine/state-machine.js';
import { DOOR_SECONDS, TICK_RATE, checkInvariants } from '../src/sim/sim.js';
import { newSim } from './helpers.js';

const steps = (sim, n) => {
  for (let i = 0; i < n; i++) sim.step();
  return sim;
};
const DOOR_TICKS = Math.ceil(DOOR_SECONDS * TICK_RATE) + 1;

test('the sim runs with no DOM', () => {
  assert.equal(typeof globalThis.window, 'undefined');
  assert.equal(typeof globalThis.document, 'undefined');
  assert.equal(steps(newSim(), 10).state.tick, 10);
});

test('a new ship is whole, lit, breathable and shut', () => {
  const sim = newSim();
  assert.equal(Object.keys(sim.state.rooms).length, 17);
  assert.equal(Object.keys(sim.state.doors).length, 24);
  for (const room of Object.values(sim.state.rooms)) {
    assert.deepEqual(room, { oxygen: 1, temperature: 20, light: 1, lightsOn: true, noise: 0, hull: 1, fire: 0, breach: 0, breached: false, scorch: 0, burning: false, jettisoned: false });
  }
  for (const door of Object.values(sim.state.doors)) assert.deepEqual(door, { state: 'closed', openness: 0 });
  assert.deepEqual(checkInvariants(sim), []);
});

test('time follows the fixed tick rate', () => {
  assert.equal(TICK_RATE, 20);
  assert.equal(steps(newSim(), 200).time, 10);
});

test('a door slides open over time, says so, and closes again', () => {
  const sim = newSim();
  const heard = [];
  sim.events.on('*', (payload, type) => type.startsWith('door.') && heard.push(type));
  sim.enqueue({ type: 'door.set', door: 'd_reactor', state: 'open' });
  sim.step();
  const door = sim.state.doors.d_reactor;
  assert.equal(door.state, 'open');
  assert.ok(door.openness > 0 && door.openness < 1, 'a door does not snap open');
  steps(sim, DOOR_TICKS);
  assert.equal(door.openness, 1);
  sim.enqueue({ type: 'door.set', door: 'd_reactor', state: 'closed' });
  steps(sim, DOOR_TICKS + 1);
  assert.equal(door.openness, 0);
  assert.deepEqual(heard, ['door.changed', 'door.opened', 'door.changed', 'door.closed']);
});

test('locking a door shuts it', () => {
  const sim = newSim();
  sim.enqueue({ type: 'door.set', door: 'd_brig', state: 'open' });
  steps(sim, DOOR_TICKS + 1);
  sim.enqueue({ type: 'door.set', door: 'd_brig', state: 'locked' });
  steps(sim, DOOR_TICKS + 1);
  assert.deepEqual(sim.state.doors.d_brig, { state: 'locked', openness: 0 });
});

test('a jammed door stays exactly where it is and refuses orders', () => {
  const sim = newSim();
  sim.enqueue({ type: 'door.set', door: 'd_cargo', state: 'open' });
  steps(sim, 3);
  const partly = sim.state.doors.d_cargo.openness;
  assert.ok(partly > 0 && partly < 1);
  sim.enqueue({ type: 'debug.door', door: 'd_cargo', jammed: true });
  steps(sim, 40);
  assert.deepEqual(sim.state.doors.d_cargo, { state: 'jammed', openness: partly });
  assert.throws(() => sim.enqueue({ type: 'door.set', door: 'd_cargo', state: 'closed' }), /jammed/);
  assert.equal(sim.whyNot({ type: 'door.set', door: 'd_cargo', state: 'closed' }), 'the door is jammed');
  sim.enqueue({ type: 'debug.door', door: 'd_cargo', jammed: false });
  steps(sim, DOOR_TICKS + 1);
  assert.equal(sim.state.doors.d_cargo.state, partly >= 0.5 ? 'open' : 'closed');
});

test('an order is dropped, with a reason, if the door jams before it starts', () => {
  const sim = newSim();
  const dropped = [];
  sim.events.on('command.dropped', (e) => dropped.push(e.reason));
  sim.enqueue({ type: 'debug.door', door: 'd_medbay', jammed: true });
  sim.enqueue({ type: 'door.set', door: 'd_medbay', state: 'open' }); // accepted: not jammed yet
  sim.step();
  assert.deepEqual(dropped, ['the door is jammed']);
  assert.equal(sim.state.doors.d_medbay.state, 'jammed');
});

test('lights fade down and up, room by room', () => {
  const sim = newSim();
  sim.enqueue({ type: 'room.lights', room: 'medbay', on: false });
  sim.step();
  assert.ok(sim.state.rooms.medbay.light < 1 && sim.state.rooms.medbay.light > 0);
  steps(sim, 10);
  assert.equal(sim.state.rooms.medbay.light, 0);
  assert.equal(sim.state.rooms.quarters.light, 1, 'other rooms are untouched');
  sim.enqueue({ type: 'room.lights', room: 'medbay', on: true });
  steps(sim, 10);
  assert.equal(sim.state.rooms.medbay.light, 1);
});

test('bad orders are rejected when given', () => {
  const sim = newSim();
  assert.throws(() => sim.enqueue({ type: 'door.dance' }), /Unknown command/);
  assert.throws(() => sim.enqueue(undefined), /Unknown command/);
  assert.throws(() => sim.enqueue({ type: 'door.set', door: 'd_nowhere', state: 'open' }), /no door/);
  assert.throws(() => sim.enqueue({ type: 'door.set', door: 'd_brig', state: 'jammed' }), /cannot be set/);
  assert.throws(() => sim.enqueue({ type: 'room.lights', room: 'attic', on: true }), /no room/);
  assert.throws(() => sim.enqueue({ type: 'room.lights', room: 'brig', on: 'yes' }), /true or false/);
  assert.throws(() => sim.enqueue({ type: 'debug.room', room: 'brig', set: { fire: 2 } }), /between 0 and 1/);
  assert.throws(() => sim.enqueue({ type: 'debug.room', room: 'brig', set: { light: 0 } }), /cannot set/);
  assert.equal(sim.state.commands.length, 0);
});

test('orders apply in the order given', () => {
  const sim = newSim();
  const a = sim.enqueue({ type: 'door.set', door: 'd_brig', state: 'open' });
  const b = sim.enqueue({ type: 'door.set', door: 'd_brig', state: 'locked' });
  assert.equal(b, a + 1);
  const applied = [];
  sim.events.on('command.applied', ({ command }) => applied.push(command.id));
  sim.step();
  assert.deepEqual(applied, [a, b]);
  assert.equal(sim.state.doors.d_brig.state, 'locked');
});

test('same seed and same orders give the same state', () => {
  const play = (seed) => {
    const sim = newSim(seed);
    sim.enqueue({ type: 'door.set', door: 'd_bulkhead', state: 'open' });
    steps(sim, 5);
    sim.enqueue({ type: 'room.lights', room: 'bridge', on: false });
    return hashState(steps(sim, 300).snapshot());
  };
  assert.equal(play('seed-a'), play('seed-a'));
  assert.notEqual(play('seed-a'), play('seed-b'), 'the seed is part of the state');
});

test('a snapshot restores the exact moment, queue included, and survives JSON', () => {
  const sim = newSim('snap');
  sim.enqueue({ type: 'door.set', door: 'd_ai_core', state: 'open' });
  steps(sim, 3);
  sim.enqueue({ type: 'room.lights', room: 'ai_core', on: false }); // still queued at save time
  const saved = JSON.parse(JSON.stringify(sim.snapshot()));
  steps(sim, 100);

  const loaded = newSim('snap');
  loaded.restore(saved);
  assert.equal(loaded.state.tick, 3);
  assert.equal(loaded.state.commands.length, 1);
  steps(loaded, 100);
  assert.equal(hashState(loaded.snapshot()), hashState(sim.snapshot()));
  assert.equal(loaded.state.rooms.ai_core.light, 0);
  assert.equal(loaded.enqueue({ type: 'room.lights', room: 'brig', on: false }), 3, 'command ids continue after a load');
  assert.throws(() => loaded.restore({ ...saved, state: { ...saved.state, ship: 'other-ship' } }), /Save is for ship/);
});

test('invariants catch broken state', () => {
  const sim = steps(newSim(), 50);
  assert.deepEqual(checkInvariants(sim), []);
  sim.state.rooms.reactor.oxygen = NaN;
  sim.state.doors.d_brig.openness = 1.5;
  sim.state.doors.d_cargo.state = 'ajar';
  assert.equal(checkInvariants(sim).length, 3);
});

test('hashing ignores key order and flags bad numbers', () => {
  assert.equal(hashState({ a: 1, b: [1, 2] }), hashState({ b: [1, 2], a: 1 }));
  assert.notEqual(hashState({ a: 1 }), hashState({ a: 2 }));
  assert.equal(stableStringify({ b: 1, a: undefined }), '{"a":null,"b":1}');
  assert.deepEqual(findBadNumbers({ a: 1, b: { c: [0, NaN] }, d: Infinity }), ['state.b.c[1]', 'state.d']);
});

test('state machine enters, exits and rejects unknown states', () => {
  const log = [];
  const machine = createStateMachine(
    {
      title: { enter: ({ from }) => log.push(`enter title from ${from}`), exit: ({ to }) => log.push(`exit title to ${to}`) },
      hub: { enter: ({ params }) => log.push(`enter hub ${params.note}`), update: (dt) => log.push(`update ${dt}`) },
    },
    { onChange: ({ from, to }) => log.push(`${from} -> ${to}`) },
  );
  assert.equal(machine.state, null);
  machine.go('title');
  machine.go('hub', { note: 'hi' });
  machine.update(0.5);
  assert.equal(machine.state, 'hub');
  assert.deepEqual(log, ['enter title from null', 'null -> title', 'exit title to hub', 'enter hub hi', 'title -> hub', 'update 0.5']);
  assert.throws(() => machine.go('nowhere'), /Unknown state/);
});
