import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClock } from '../src/engine/clock.js';
import { createEventBus } from '../src/engine/events.js';
import { hashState } from '../src/engine/hash.js';
import { TICK_SECONDS } from '../src/sim/sim.js';
import { newSim } from './helpers.js';

const make = (seed = 'clock') => {
  const sim = newSim(seed);
  return { sim, clock: createClock({ sim, tickSeconds: TICK_SECONDS }) };
};
const FRAME = 1 / 60;

test('the clock steps the sim in whole fixed ticks', () => {
  const { sim, clock } = make();
  assert.equal(clock.advance(TICK_SECONDS * 0.6), 0);
  assert.equal(sim.state.tick, 0);
  assert.equal(clock.advance(TICK_SECONDS * 0.6), 1);
  assert.equal(sim.state.tick, 1);
  assert.ok(Math.abs(clock.alpha - 0.2) < 1e-9);
});

test('one second of 60 fps frames is 20 ticks', () => {
  const { sim, clock } = make();
  for (let i = 0; i < 60; i++) clock.advance(FRAME);
  assert.ok(sim.state.tick === 20 || sim.state.tick === 19, `got ${sim.state.tick}`);
  for (let i = 0; i < 600; i++) clock.advance(FRAME);
  assert.ok(Math.abs(sim.state.tick - 220) <= 1);
});

test('frame rate does not change the result, only how often we draw', () => {
  const run = (frameSeconds, frames) => {
    const { sim, clock } = make('rate');
    sim.enqueue({ type: 'door.set', door: 'd_bulkhead', state: 'open' });
    for (let i = 0; i < frames; i++) clock.advance(frameSeconds);
    return sim;
  };
  const slow = run(1 / 20, 100); // exactly one tick per frame
  const fast = run(1 / 100, 500); // five frames per tick
  assert.equal(slow.state.tick, 100);
  assert.ok(Math.abs(fast.state.tick - 100) <= 1);
  while (fast.state.tick < 100) fast.step();
  assert.equal(hashState(slow.snapshot()), hashState(fast.snapshot()));
});

test('1,000 frames while paused leave the sim state untouched', () => {
  const { sim, clock } = make();
  sim.enqueue({ type: 'door.set', door: 'd_cargo', state: 'open' });
  for (let i = 0; i < 6; i++) clock.advance(FRAME); // stop with the door half open
  clock.pause();
  const before = hashState(sim.snapshot());
  const alpha = clock.alpha;
  for (let i = 0; i < 1000; i++) assert.equal(clock.advance(FRAME), 0);
  assert.equal(hashState(sim.snapshot()), before);
  assert.ok(sim.state.doors.d_cargo.openness > 0 && sim.state.doors.d_cargo.openness < 1, 'the door froze mid-slide');
  assert.equal(clock.alpha, alpha, 'interpolation must freeze too');
});

test('orders given while paused wait, then start on the first tick after resume', () => {
  const { sim, clock } = make();
  clock.pause();
  sim.enqueue({ type: 'door.set', door: 'd_reactor', state: 'open' });
  for (let i = 0; i < 200; i++) clock.advance(FRAME);
  const door = sim.state.doors.d_reactor;
  assert.equal(sim.state.commands.length, 1);
  assert.deepEqual(door, { state: 'closed', openness: 0 });
  clock.resume();
  clock.advance(TICK_SECONDS);
  assert.equal(sim.state.commands.length, 0);
  assert.equal(door.state, 'open');
  assert.ok(door.openness > 0);
});

test('pause listeners hear each change once, with the reason', () => {
  const { clock } = make();
  const heard = [];
  const stop = clock.onChange((change) => heard.push(change));
  clock.pause('fire');
  clock.pause('fire again');
  clock.toggle();
  stop();
  clock.toggle();
  assert.deepEqual(heard, [
    { paused: true, reason: 'fire' },
    { paused: false, reason: 'player' },
  ]);
});

test('a long stall is capped instead of racing to catch up', () => {
  const { sim, clock } = make();
  assert.equal(clock.advance(10), 5);
  assert.equal(sim.state.tick, 5);
  assert.ok(clock.alpha < 1);
  assert.equal(clock.advance(-1), 0);
  assert.equal(clock.advance(NaN), 0);
});

test('fast-forward runs more ticks per frame', () => {
  const { sim, clock } = make();
  clock.speed = 4;
  for (let i = 0; i < 60; i++) clock.advance(FRAME);
  assert.ok(Math.abs(sim.state.tick - 80) <= 1, `got ${sim.state.tick}`);
  assert.throws(() => (clock.speed = 0), RangeError);
});

test('a pause requested during a tick stops the clock at once (auto-pause)', () => {
  const { sim, clock } = make();
  sim.events.on('door.changed', () => clock.pause('door'));
  sim.enqueue({ type: 'door.set', door: 'd_brig', state: 'open' });
  const ran = clock.advance(TICK_SECONDS * 5);
  assert.equal(ran, 1);
  assert.equal(clock.paused, true);
  assert.equal(sim.state.tick, 1);
});

test('event bus: listeners, wildcard, unsubscribe', () => {
  const bus = createEventBus();
  const heard = [];
  const stop = bus.on('fire.started', (p) => heard.push(['fire', p.room]));
  bus.on('*', (p, type) => heard.push(['any', type]));
  bus.emit('fire.started', { room: 'reactor' });
  bus.emit('crew.died');
  stop();
  bus.emit('fire.started', { room: 'medbay' });
  assert.deepEqual(heard, [
    ['fire', 'reactor'],
    ['any', 'fire.started'],
    ['any', 'crew.died'],
    ['any', 'fire.started'],
  ]);
  assert.equal(bus.count('fire.started'), 0);
  assert.equal(bus.count('*'), 1);
});

test('a listener may unsubscribe itself while being called', () => {
  const bus = createEventBus();
  let calls = 0;
  const stop = bus.on('x', () => {
    calls += 1;
    stop();
  });
  bus.on('x', () => (calls += 10));
  bus.emit('x');
  bus.emit('x');
  assert.equal(calls, 21);
});

test('stepOnce runs exactly one tick, and only while paused', () => {
  let ticks = 0;
  const clock = createClock({ sim: { step: () => (ticks += 1) }, tickSeconds: 0.05 });
  assert.equal(clock.stepOnce(), 0, 'not while running');
  clock.pause();
  assert.equal(clock.stepOnce(), 1);
  assert.equal(clock.stepOnce(), 1);
  assert.equal(ticks, 2);
  assert.equal(clock.advance(1), 0, 'still paused');
});
