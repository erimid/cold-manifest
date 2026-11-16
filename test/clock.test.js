import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClock } from '../src/engine/clock.js';
import { createEventBus } from '../src/engine/events.js';
import { hashState } from '../src/engine/hash.js';
import { BAY, TICK_SECONDS, checkInvariants, createSim } from '../src/sim/sim.js';

const make = (seed = 'clock') => {
  const sim = createSim({ seed });
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
    sim.enqueue({ type: 'probe.move', probe: 'probe-1', x: 900, y: 500 });
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
  sim.enqueue({ type: 'probe.move', probe: 'probe-2', x: 800, y: 100 });
  for (let i = 0; i < 30; i++) clock.advance(FRAME); // get things moving first
  clock.pause();
  const before = hashState(sim.snapshot());
  const alpha = clock.alpha;
  for (let i = 0; i < 1000; i++) assert.equal(clock.advance(FRAME), 0);
  assert.equal(hashState(sim.snapshot()), before);
  assert.equal(clock.alpha, alpha, 'interpolation must freeze too');
});

test('orders given while paused wait, then start on the first tick after resume', () => {
  const { sim, clock } = make();
  clock.pause();
  sim.enqueue({ type: 'probe.move', probe: 'probe-1', x: 700, y: 300 });
  for (let i = 0; i < 200; i++) clock.advance(FRAME);
  const probe = sim.state.probes[0];
  assert.equal(sim.state.commands.length, 1);
  assert.equal(probe.moving, false);
  assert.equal(probe.x, 180);
  clock.resume();
  clock.advance(TICK_SECONDS);
  assert.equal(sim.state.commands.length, 0);
  assert.equal(probe.moving, true);
  assert.ok(probe.x > 180);
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
  sim.events.on('probe.arrived', () => clock.pause('arrived'));
  sim.enqueue({ type: 'probe.move', probe: 'probe-1', x: 180 + 22, y: 300 }); // two ticks away
  const ran = clock.advance(TICK_SECONDS * 5);
  assert.equal(ran, 2);
  assert.equal(clock.paused, true);
  assert.equal(sim.state.tick, 2);
});

test('orders apply in the order given, and the last one wins', () => {
  const { sim } = make();
  const first = sim.enqueue({ type: 'probe.move', probe: 'probe-1', x: 100, y: 100 });
  const second = sim.enqueue({ type: 'probe.move', probe: 'probe-1', x: 900, y: 500 });
  assert.equal(second, first + 1);
  const applied = [];
  sim.events.on('command.applied', ({ command }) => applied.push(command.id));
  sim.step();
  assert.deepEqual(applied, [first, second]);
  assert.deepEqual([sim.state.probes[0].tx, sim.state.probes[0].ty], [900, 500]);
});

test('bad orders are rejected when given', () => {
  const { sim } = make();
  assert.throws(() => sim.enqueue({ type: 'probe.dance' }), /Unknown command/);
  assert.throws(() => sim.enqueue({ type: 'probe.move', probe: 'probe-9', x: 1, y: 1 }), /no probe/);
  assert.throws(() => sim.enqueue({ type: 'probe.move', probe: 'probe-1', x: NaN, y: 1 }), /numeric/);
  assert.throws(() => sim.enqueue(undefined), /Unknown command/);
  assert.equal(sim.state.commands.length, 0);
});

test('probes arrive exactly, announce it, and stay inside the bay', () => {
  const { sim } = make();
  const arrived = [];
  sim.events.on('probe.arrived', (e) => arrived.push(e));
  sim.enqueue({ type: 'probe.move', probe: 'probe-3', x: 5000, y: -5000 });
  for (let i = 0; i < 400; i++) {
    sim.step();
    assert.deepEqual(checkInvariants(sim), []);
  }
  const probe = sim.state.probes[2];
  assert.deepEqual([probe.x, probe.y], [BAY.width - BAY.probeRadius, BAY.probeRadius]);
  assert.equal(probe.moving, false);
  assert.equal(arrived.length, 1);
  assert.equal(arrived[0].probe, 'probe-3');
});

test('queued orders are part of the save', () => {
  const { sim } = make('save-queue');
  sim.enqueue({ type: 'probe.move', probe: 'probe-1', x: 640, y: 480 });
  const saved = JSON.parse(JSON.stringify(sim.snapshot()));
  const loaded = createSim({ seed: 'save-queue' });
  loaded.restore(saved);
  for (let i = 0; i < 200; i++) {
    sim.step();
    loaded.step();
  }
  assert.equal(hashState(loaded.snapshot()), hashState(sim.snapshot()));
  assert.equal(loaded.state.probes[0].x, 640);
  assert.equal(loaded.enqueue({ type: 'probe.move', probe: 'probe-1', x: 1, y: 1 }), 2, 'command ids continue after a load');
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
