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
  assert.equal(tempo.step(sim, TEMPO.settle / 2), 1, 'not at once');
  tempo.step(sim, TEMPO.settle);
  assert.ok(tempo.rate > 1 && tempo.rate < TEMPO.fast, 'easing up');
  tempo.step(sim, TEMPO.ease);
  assert.equal(tempo.rate, TEMPO.fast);
  assert.equal(tempo.step(sim, 1, false), 1, 'the setting holds it at normal speed');
  for (let i = 0; i < 10; i++) tempo.step(sim, 1);
  sim.enqueue({ type: 'debug.contact', encounter: 'raider-skiff', state: 'closing', range: 40 });
  // Fast until its return shows on the scope: what nobody has seen does not slow the clock.
  for (let i = 0; i < 20 * TICK_RATE && !busyReason(sim); i++) sim.step();
  assert.match(busyReason(sim) ?? 'quiet', /hunting/);
  assert.equal(tempo.step(sim, 0.016), 1, 'straight back to normal');
  assert.equal(tempo.reason, 'a ship is hunting us');
});

test('a ship that has not noticed us does not hold the clock; the moment its beam brushes us it does (F.1)', () => {
  const sim = quietCrossing('unnoticed');
  sim.enqueue({ type: 'lights.all', on: false });
  for (const station of ['sensors', 'engines']) sim.enqueue({ type: 'station.stand', station, down: true });
  sim.step();
  sim.enqueue({ type: 'debug.contact', encounter: 'raider-skiff', range: 50, bearing: 10, miss: 30 });
  for (let i = 0; i < 6 * TICK_RATE; i++) sim.step();
  const contact = sim.state.scope.contacts[0];
  assert.equal(contact.state, 'unseen');
  assert.equal(contact.track.shown, true, 'it is on our scope');
  assert.equal(busyReason(sim), null, 'and time may still run fast');
  contact.aware = 0.1;
  assert.equal(busyReason(sim), 'a ship is hunting us', 'brushed: time slows');
});

test('time runs at normal speed in port, with something aboard, on a fire, and off the port only when there is something to do (F.3)', () => {
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
  sim.state.fix = 0.3;
  assert.equal(busyReason(sim), null, 'the sensors working on the fix is only waiting');
  sim.state.fix = 1;
  assert.equal(busyReason(sim), 'the jump is ready', 'a fix in hand waits for the captain');
  sim.state.fix = 0.3;
  sim.enqueue({ type: 'station.stand', station: 'sensors', down: true });
  sim.step();
  assert.equal(busyReason(sim), 'nobody can take a fix', 'and so does a fix nobody can take');
});

test('bad space no longer holds the clock; a hit does, for a few real seconds (F.3)', () => {
  const sim = quietCrossing('bad space');
  const { run } = sim.state;
  for (const id of Object.keys(run.risks)) run.risks[id] = { ...run.risks[id], strikes: { perHour: 0, weapon: 'slug-thrower' } };
  assert.equal(busyReason(sim), null, 'a hazard lane with nothing hitting us is quiet');
  const tempo = createTempo();
  for (let i = 0; i < 5; i++) tempo.step(sim, 1);
  assert.equal(tempo.rate, TEMPO.fast);
  sim.state.hull.points -= 1;
  assert.equal(tempo.step(sim, 0.016), 1, 'struck: straight back to normal');
  assert.equal(tempo.reason, 'we have been hit');
  tempo.step(sim, TEMPO.struck / 2);
  assert.equal(tempo.reason, 'we have been hit', 'still holding');
  tempo.step(sim, TEMPO.struck);
  assert.equal(tempo.reason, null, 'and then quiet again');
});

test('fast time runs up to 8x, and "on to the next thing" skips ahead until a new sighting (F.3)', () => {
  assert.equal(TEMPO.fast, 8);
  assert.ok(TEMPO.skip > TEMPO.fast);
  const sim = quietCrossing('skip');
  const tempo = createTempo();
  assert.equal(tempo.canSkip(sim), true);
  assert.equal(tempo.skip(sim), true);
  assert.equal(tempo.step(sim, 0.016), TEMPO.skip, 'at once, no easing');
  assert.equal(tempo.skipping, true);
  // The setting holds fast time off, but not a skip the captain asked for.
  assert.equal(tempo.step(sim, 0.016, false), TEMPO.skip);
  sim.enqueue({ type: 'debug.contact', encounter: 'raider-skiff', range: 50, bearing: 10, miss: 30 });
  let frames = 0;
  while (tempo.skipping && frames < 2000) {
    tempo.step(sim, 0.016);
    for (let i = 0; i < 5; i++) sim.step();
    frames += 1;
  }
  assert.equal(tempo.skipping, false, 'it stopped');
  assert.ok(sim.state.scope.contacts.some((contact) => contact.track.shown), 'at the sighting');
  assert.ok(['a ship on the scope', 'a ship is hunting us'].includes(tempo.skipped), tempo.skipped);
  assert.ok(tempo.rate <= TEMPO.fast);
});

test('a skip stops for anything that holds the clock, and cannot start while something does (F.3)', () => {
  const sim = quietCrossing('skip aboard');
  const tempo = createTempo();
  tempo.skip(sim);
  tempo.step(sim, 0.016);
  sim.state.run.events.aboard.push({ n: 1 });
  assert.equal(tempo.step(sim, 0.016), 1, 'something aboard: normal speed at once');
  assert.equal(tempo.skipped, 'something is happening aboard');
  assert.equal(tempo.canSkip(sim), false);
  assert.equal(tempo.skip(sim), false);
  sim.state.run.events.aboard.length = 0;
  assert.equal(tempo.canSkip(sim), true);
  tempo.skip(sim);
  tempo.stopSkip();
  assert.equal(tempo.skipping, false, 'the captain can stop it');
  tempo.skip(sim);
  tempo.reset();
  assert.equal(tempo.skipping, false, 'a pause or a new run stops it');
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
