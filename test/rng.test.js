import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STREAMS, createRng, createRngSet, newRunSeed } from '../src/engine/rng.js';

const take = (rng, n) => Array.from({ length: n }, () => rng.next());

test('same seed gives the same sequence', () => {
  assert.deepEqual(take(createRng('margin'), 50), take(createRng('margin'), 50));
});

test('different seeds give different sequences', () => {
  assert.notDeepEqual(take(createRng('margin-1'), 10), take(createRng('margin-2'), 10));
});

test('next() stays in [0, 1) and is roughly uniform', () => {
  const rng = createRng('uniform');
  const buckets = new Array(10).fill(0);
  for (let i = 0; i < 100000; i++) {
    const v = rng.next();
    assert.ok(v >= 0 && v < 1);
    buckets[Math.floor(v * 10)]++;
  }
  for (const count of buckets) assert.ok(count > 9500 && count < 10500, `bucket count ${count}`);
});

test('int and between respect their bounds', () => {
  const rng = createRng('bounds');
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const a = rng.int(6);
    assert.ok(Number.isInteger(a) && a >= 0 && a < 6);
    seen.add(rng.between(3, 5));
  }
  assert.deepEqual([...seen].sort(), [3, 4, 5]);
  assert.throws(() => rng.int(0), RangeError);
});

test('weighted follows weights and never picks zero weight', () => {
  const rng = createRng('weights');
  const items = [
    { id: 'never', weight: 0 },
    { id: 'rare', weight: 1 },
    { id: 'common', weight: 9 },
  ];
  const counts = { never: 0, rare: 0, common: 0 };
  for (let i = 0; i < 20000; i++) counts[rng.weighted(items).id]++;
  assert.equal(counts.never, 0);
  assert.ok(counts.common > counts.rare * 7 && counts.common < counts.rare * 11);
  assert.throws(() => rng.weighted([{ weight: 0 }]), RangeError);
});

test('shuffle keeps every element and does not change its input', () => {
  const rng = createRng('shuffle');
  const input = [1, 2, 3, 4, 5, 6, 7, 8];
  const out = rng.shuffle(input);
  assert.deepEqual(input, [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual([...out].sort(), input);
});

test('state can be saved and restored mid-sequence', () => {
  const rng = createRng('save');
  take(rng, 17);
  const saved = rng.getState();
  const expected = take(rng, 20);
  const other = createRng('something else');
  other.setState(saved);
  assert.deepEqual(take(other, 20), expected);
});

test('substreams are independent of each other', () => {
  const a = createRngSet('run-1');
  const b = createRngSet('run-1');
  // Draw heavily from another stream in one set only.
  take(a.stream('combat'), 500);
  assert.deepEqual(take(a.stream('map'), 20), take(b.stream('map'), 20));
});

test('substreams differ from each other and across run seeds', () => {
  const set = createRngSet('run-1');
  assert.notDeepEqual(take(set.stream('map'), 5), take(set.stream('crew'), 5));
  assert.notDeepEqual(take(createRngSet('run-1').stream('ai'), 5), take(createRngSet('run-2').stream('ai'), 5));
});

test('unknown stream names are rejected', () => {
  assert.throws(() => createRngSet('x').stream('mapp'), /Unknown RNG stream/);
});

test('a whole set saves and restores', () => {
  const set = createRngSet('run-9');
  take(set.stream('map'), 3);
  take(set.stream('threat'), 8);
  const saved = JSON.parse(JSON.stringify(set.getState()));
  const expected = [take(set.stream('map'), 5), take(set.stream('threat'), 5), take(set.stream('ai'), 5)];
  const restored = createRngSet('run-9');
  restored.setState(saved);
  assert.deepEqual([take(restored.stream('map'), 5), take(restored.stream('threat'), 5), take(restored.stream('ai'), 5)], expected);
  assert.throws(() => createRngSet('other').setState(saved), /seed/);
});

test('every listed stream can be created', () => {
  const set = createRngSet('all');
  for (const name of STREAMS) assert.equal(typeof set.stream(name).next(), 'number');
});

test('run seeds are typable and depend on the time given', () => {
  assert.match(newRunSeed(1), /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(newRunSeed(42), newRunSeed(42));
  assert.notEqual(newRunSeed(42), newRunSeed(43));
});
