import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findBadNumbers, hashState, stableStringify } from '../src/engine/hash.js';
import { createStateMachine } from '../src/engine/state-machine.js';
import { TICK_RATE, checkInvariants, createSim } from '../src/sim/sim.js';

const run = (seed, ticks) => {
  const sim = createSim({ seed });
  for (let i = 0; i < ticks; i++) sim.step();
  return sim;
};

test('the sim runs with no DOM', () => {
  assert.equal(typeof globalThis.window, 'undefined');
  assert.equal(typeof globalThis.document, 'undefined');
  assert.equal(run('no-dom', 10).state.tick, 10);
});

test('same seed and same steps give the same state', () => {
  assert.equal(hashState(run('seed-a', 500).snapshot()), hashState(run('seed-a', 500).snapshot()));
  assert.notEqual(hashState(run('seed-a', 500).snapshot()), hashState(run('seed-b', 500).snapshot()));
});

test('time follows the fixed tick rate', () => {
  assert.equal(TICK_RATE, 20);
  assert.equal(run('time', 200).time, 10);
});

test('a snapshot restores the exact moment and survives JSON', () => {
  const sim = run('snap', 123);
  const saved = JSON.parse(JSON.stringify(sim.snapshot()));
  for (let i = 0; i < 300; i++) sim.step();
  const expected = hashState(sim.snapshot());

  const loaded = createSim({ seed: 'snap' });
  loaded.restore(saved);
  assert.equal(loaded.state.tick, 123);
  for (let i = 0; i < 300; i++) loaded.step();
  assert.equal(hashState(loaded.snapshot()), expected);
});

test('invariants hold over a long run and catch broken state', () => {
  const sim = run('long', 20000);
  assert.deepEqual(checkInvariants(sim), []);
  sim.state.reactorDrift = NaN;
  sim.state.probes[0].x = -50;
  assert.equal(checkInvariants(sim).length, 2);
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
