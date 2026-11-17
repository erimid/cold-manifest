// The ship clock and the tempo of a crossing (H.8, D-206, D-207).

import assert from 'node:assert/strict';
import test from 'node:test';

import { createClock } from '../src/engine/clock.js';
import { hashState } from '../src/engine/hash.js';
import { bestRoute } from '../src/sim/sector.js';
import { SHIP_HOUR, WATCH_HOURS, clockText, hoursText, shipTime } from '../src/sim/shipclock.js';
import { TICK_RATE, TICK_SECONDS, createSim } from '../src/sim/sim.js';
import { TEMPO, busyReason, createTempo } from '../src/sim/tempo.js';
import { WATCH } from '../src/sim/watches.js';
import { CATALOG, CREW, SHIP, castOff, content } from './helpers.js';

const REACH = content.require('sectors', 'the-reach');
const HOUR = SHIP_HOUR * TICK_RATE;

/** A sim on a quiet crossing: nobody else on the lanes, no events, no follower. */
function quietCrossing(seed = 'tempo') {
  const sim = createSim({ seed, ship: SHIP, crew: CREW, ...CATALOG, sector: REACH, encounters: content.all('encounters'), run: { pursuit: false } });
  const { run } = sim.state;
  for (const [id, risk] of Object.entries(run.risks)) run.risks[id] = { ...risk, contacts: 0, aboard: 0, strikes: undefined };
  const port = run.map.nodes.filter((node) => node.kind === 'port' && node.id !== run.at).map((node) => bestRoute(run.map, run.at, node.id, { by: 'hours', ports: false })).filter((route) => route.path).sort((a, b) => a.hours - b.hours)[0];
  castOff(sim, port.path);
  return sim;
}

test('the ship clock reads days, hours and watches off the tick: three eight-hour watches a day, the first at 0800', () => {
  assert.equal(SHIP_HOUR, 30);
  assert.equal(WATCH.seconds, WATCH_HOURS * SHIP_HOUR, 'a watch is eight hours on the clock');
  assert.equal(clockText(0), 'Day 1 0800');
  assert.deepEqual(shipTime(HOUR * 2.5), { day: 1, hour: 10, minute: 30, hours: 10.5 });
  assert.equal(clockText(HOUR * 16), 'Day 2 0000', 'two watches on, it is midnight');
  assert.equal(clockText(HOUR * 30 + 1), 'Day 2 1400');
  assert.equal(hoursText(0.5), '30 min');
  assert.equal(hoursText(3), '3 h');
  assert.equal(hoursText(2.25), '2 h 15 min');
});

test('a quiet crossing runs fast after a few quiet seconds, and drops to normal at once when a ship turns up', () => {
  const sim = quietCrossing();
  const tempo = createTempo();
  assert.equal(busyReason(sim), null, 'nothing is happening');
  assert.equal(tempo.step(sim, 1), 1, 'not at once');
  tempo.step(sim, TEMPO.settle);
  assert.ok(tempo.rate > 1 && tempo.rate < TEMPO.fast, 'easing up');
  tempo.step(sim, TEMPO.ease);
  assert.equal(tempo.rate, TEMPO.fast);
  assert.equal(tempo.step(sim, 1, false), 1, 'the setting holds it at normal speed');
  for (let i = 0; i < 10; i++) tempo.step(sim, 1);
  sim.enqueue({ type: 'debug.contact', encounter: 'raider-skiff', state: 'closing', range: 40 });
  // Fast until its return shows on the scope: what nobody has seen does not slow the clock.
  for (let i = 0; i < 20 * TICK_RATE && !busyReason(sim); i++) sim.step();
  assert.match(busyReason(sim) ?? 'quiet', /scope/);
  assert.equal(tempo.step(sim, 0.016), 1, 'straight back to normal');
  assert.equal(tempo.reason, 'a ship is on the scope');
});

test('time runs at normal speed in port, off the port, with something aboard and on a decision', () => {
  const port = createSim({ seed: 'port', ship: SHIP, crew: CREW, ...CATALOG, sector: REACH, run: { pursuit: false } });
  assert.equal(busyReason(port), 'in port');
  const sim = quietCrossing('aboard');
  sim.state.run.events.aboard.push({ n: 1 });
  assert.equal(busyReason(sim), 'something is happening aboard');
  sim.state.run.events.aboard.length = 0;
  sim.state.rooms.cargo.fire = 0.4;
  assert.equal(busyReason(sim), 'fire or a hole aboard');
  sim.state.rooms.cargo.fire = 0;
  sim.state.run.crossing.phase = 'off port';
  assert.equal(busyReason(sim), 'off the port');
});

test('fast time changes nothing that happens: the same ticks, the same ship, only sooner', () => {
  const slow = quietCrossing('same');
  const fast = quietCrossing('same');
  const a = createClock({ sim: slow, tickSeconds: TICK_SECONDS });
  const b = createClock({ sim: fast, tickSeconds: TICK_SECONDS });
  b.tempo = TEMPO.fast;
  let real = 0;
  while (fast.state.tick < 400) {
    b.advance(1 / 60);
    real += 1 / 60;
  }
  while (slow.state.tick < fast.state.tick) a.advance(1 / 60);
  assert.equal(slow.state.tick, fast.state.tick);
  assert.ok(real < (400 * TICK_SECONDS) / (TEMPO.fast - 0.5), `${real.toFixed(1)} s of real time for 20 s of ship time`);
  assert.equal(hashState(slow.snapshot()), hashState(fast.snapshot()));
  b.pause();
  assert.equal(b.advance(1), 0, 'paused is paused at any tempo');
  assert.throws(() => (b.tempo = 0.5), /tempo/);
});
