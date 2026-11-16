// The sector chart and the run across it (S3.1, D-104 to D-107).

import assert from 'node:assert/strict';
import test from 'node:test';

import { createRng } from '../src/engine/rng.js';
import { hashState } from '../src/engine/hash.js';
import { struck } from '../src/sim/encounters.js';
import { NODE_KINDS, checkSector, cheapestRoute, distance, fewestJumps, generateSector, laneBetween, neighbours, nodeOf, whyNoCourseJump } from '../src/sim/sector.js';
import { checkInvariants, createSim } from '../src/sim/sim.js';
import { CATALOG, CREW, LINES, SHIP, content } from './helpers.js';

const REACH = content.require('sectors', 'the-reach');
const ENCOUNTERS = content.all('encounters');
const runSim = (seed = 'chart', run = { pursuit: false }) => createSim({ seed, ship: SHIP, crew: CREW, ...CATALOG, sector: REACH, encounters: ENCOUNTERS, run });
/** The ship that followed us, on the scope. */
const pursuer = (sim) => sim.state.scope.contacts.find((contact) => contact.pursuer) ?? null;

/** Plot a course to `to`, wait for the fix, and jump. Returns the events seen on the way. */
function fly(sim, to) {
  const seen = [];
  const stop = sim.events.on('*', (_, type) => seen.push(type));
  sim.enqueue({ type: 'course.plot', to });
  for (let i = 0; i < 4000 && whyNoCourseJump(sim); i++) sim.step();
  assert.equal(whyNoCourseJump(sim), null, `no fix for the jump to ${to}`);
  sim.enqueue({ type: 'course.jump' });
  sim.step();
  stop();
  return seen;
}

test('every seeded chart is sound: 15 to 25 points, all reachable, and a delivery we can afford to reach', () => {
  const kinds = new Set();
  for (let i = 0; i < 500; i++) {
    const sector = generateSector(REACH, createRng(`sound:${i}`));
    assert.deepEqual(checkSector(sector, REACH), [], `seed ${i}`);
    assert.ok(sector.nodes.length >= 15 && sector.nodes.length <= 25);
    const route = cheapestRoute(sector, sector.start, sector.delivery);
    assert.ok(route.fuel <= REACH.fuel.start, `seed ${i}: the way across costs ${route.fuel}`);
    // Brief §5: a run spans 6 to 10 jumps.
    assert.ok(route.jumps >= 6 && route.jumps <= 10, `seed ${i}: ${route.jumps} jumps across`);
    for (const node of sector.nodes) kinds.add(node.kind);
  }
  assert.deepEqual([...kinds].sort(), Object.keys(NODE_KINDS).sort(), 'every kind of point turns up');
});

test('a chart is drawn from the seed alone, and only from the map stream', () => {
  const a = runSim('same');
  const b = runSim('same');
  assert.deepEqual(a.state.run.map, b.state.run.map);
  assert.notDeepEqual(runSim('other').state.run.map, a.state.run.map);
  // Drawing the chart takes nothing from any other stream.
  const bare = createSim({ seed: 'same', ship: SHIP, crew: CREW, ...CATALOG });
  for (const stream of ['combat', 'hazard', 'tactics', 'crew', 'events']) assert.equal(a.rng.stream(stream).next(), bare.rng.stream(stream).next(), stream);
  assert.equal(bare.state.run, null, 'no sector, no run');
});

test('the deadline leaves a couple of spare jumps over the cheapest way across', () => {
  for (let i = 0; i < 50; i++) {
    const { run } = runSim(`deadline:${i}`).state;
    const route = cheapestRoute(run.map, run.map.start, run.map.delivery);
    assert.ok(run.deadline >= route.jumps + REACH.slack[0] && run.deadline <= route.jumps + REACH.slack[1]);
    assert.ok(distance(run.map, run.map.start, run.map.delivery) <= run.deadline);
  }
});

test('a course goes one lane at a time, and the fuel has to cover it', () => {
  const sim = runSim();
  const { run } = sim.state;
  const far = run.map.nodes.find((node) => node.id !== run.at && !laneBetween(run.map, run.at, node.id));
  assert.match(sim.whyNot({ type: 'course.plot', to: far.id }), /no lane/);
  assert.match(sim.whyNot({ type: 'course.plot', to: run.at }), /already here/);
  assert.match(sim.whyNot({ type: 'course.jump' }), /no course/);
  const next = neighbours(run.map, run.at)[0];
  sim.enqueue({ type: 'debug.run', fuel: 0 });
  sim.step();
  assert.match(sim.whyNot({ type: 'course.plot', to: next }), /fuel/);
});

test('a jump needs the sensor fix, someone at the helm and the engines, then spends fuel and a jump', () => {
  const sim = runSim();
  const { run } = sim.state;
  const from = run.at;
  const next = cheapestRoute(run.map, run.at, run.map.delivery).path[1];
  sim.enqueue({ type: 'course.plot', to: next });
  sim.step();
  assert.match(whyNoCourseJump(sim), /sensor fix/);
  const fuel = run.fuel;
  const events = fly(sim, next);
  assert.ok(events.includes('course.ready'));
  assert.ok(events.includes('sector.jumped') && events.includes('sector.arrived'));
  assert.equal(run.at, next);
  assert.equal(run.fuel, fuel - laneBetween(run.map, from, next).fuel);
  assert.equal(run.jumps, 1);
  assert.equal(run.plot, null);
  assert.equal(sim.state.fix, 0, 'the fix was for where we were');
  assert.deepEqual(checkInvariants(sim), []);

  // No power to the drive, no jump.
  sim.enqueue({ type: 'course.plot', to: neighbours(run.map, run.at)[0] });
  for (let i = 0; i < 4000 && sim.state.fix < 1; i++) sim.step();
  sim.state.systems.engines.power = 0;
  assert.match(whyNoCourseJump(sim), /engines/);
});

test('with nobody at the helm the fix never comes', () => {
  const sim = runSim();
  const { run } = sim.state;
  for (const member of Object.values(sim.state.crew)) if (member.room === 'bridge') sim.enqueue({ type: 'crew.move', crew: member.id, room: 'quarters' });
  sim.enqueue({ type: 'course.plot', to: neighbours(run.map, run.at)[0] });
  for (let i = 0; i < 2000; i++) sim.step();
  assert.ok(sim.state.fix < 1, `fix at ${sim.state.fix}`);
  assert.match(whyNoCourseJump(sim), /fix/);
});

test('the cheapest way across reaches the delivery inside the deadline, and late is late', () => {
  const sim = runSim();
  const { run } = sim.state;
  const route = cheapestRoute(run.map, run.at, run.map.delivery).path;
  const seen = [];
  for (const to of route.slice(1)) seen.push(...fly(sim, to));
  assert.equal(run.at, run.map.delivery);
  assert.ok(run.delivered);
  assert.ok(!run.late);
  assert.ok(seen.includes('sector.delivered'));
  assert.ok(!seen.includes('contract.late'));

  // Back and forth past the deadline.
  const other = runSim('late');
  const r = other.state.run;
  const next = neighbours(r.map, r.at)[0];
  const late = [];
  other.enqueue({ type: 'debug.run', fuel: r.fuelMax });
  other.step();
  for (let i = 0; i <= r.deadline; i++) {
    if (r.fuel < 2) {
      other.enqueue({ type: 'debug.run', fuel: r.fuelMax });
      other.step();
    }
    late.push(...fly(other, r.at === next ? r.map.start : next));
  }
  assert.ok(r.late);
  assert.equal(late.filter((type) => type === 'contract.late').length, 1, 'said once');
});

test('a pursuer kept at a distance never catches us on the straight way across', () => {
  for (let i = 0; i < 20; i++) {
    const sim = runSim(`straight:${i}`, { pursuit: true });
    const { run } = sim.state;
    const route = fewestJumps(run.map, run.at, run.map.delivery);
    for (const to of route.slice(1)) {
      if (run.fuel < laneBetween(run.map, run.at, to).fuel) sim.state.run.fuel = run.fuelMax;
      fly(sim, to);
      assert.equal(run.pursuit.caught, 0, `seed ${i}: caught at ${run.at}`);
      assert.ok(distance(run.map, run.pursuit.at, run.at) >= 1);
    }
    assert.ok(run.delivered);
  }
});

test('dawdling lets the pursuer catch up: the ship that followed us comes in on the scope, closing; the gun can end the chase', () => {
  const sim = runSim('dawdle', { pursuit: true });
  const { run } = sim.state;
  const start = run.at;
  const next = neighbours(run.map, start)[0];
  let caught = null;
  sim.events.on('pursuit.caught', (event) => (caught = event));
  for (let i = 0; i < 12 && !caught; i++) {
    if (run.fuel < 2) run.fuel = run.fuelMax;
    fly(sim, run.at === start ? next : start);
  }
  assert.ok(caught, 'caught');
  const contact = pursuer(sim);
  assert.equal(contact.encounter, REACH.pursuit.encounter);
  assert.equal(contact.state, 'closing');
  assert.equal(run.pursuit.caught, 1);
  assert.deepEqual(checkInvariants(sim), []);
  // Driven off by the gun, it gives up the chase for good.
  const ended = [];
  sim.events.on('pursuit.ended', (event) => ended.push(event.outcome));
  while (contact.state !== 'lost') struck(sim, contact, true);
  assert.equal(run.pursuit.done, true);
  assert.deepEqual(ended, ['deterred']);
});

test('Margo sees the pursuer only within sight and with the sensors running', () => {
  const sim = runSim('sight', { pursuit: true });
  const { run } = sim.state;
  const route = fewestJumps(run.map, run.at, run.map.delivery);
  let sighted = 0;
  sim.events.on('pursuit.sighted', () => (sighted += 1));
  fly(sim, route[1]);
  fly(sim, route[2]);
  fly(sim, route[3]); // it sets out now, two lanes back
  assert.equal(distance(run.map, run.pursuit.at, run.at), 2);
  assert.ok(run.pursuit.seen);
  assert.equal(sighted, 1);
  assert.deepEqual(run.pursuit.lastSeen, { node: run.pursuit.at, jump: 3 });
});

test('the debug panel can bring the pursuer in on the scope', () => {
  const sim = runSim('debug');
  sim.enqueue({ type: 'debug.run', pursuit: 'catch' });
  sim.step();
  assert.equal(pursuer(sim)?.encounter, REACH.pursuit.encounter);
  sim.enqueue({ type: 'debug.run', pursuit: 'off' });
  sim.step();
  assert.equal(sim.state.run.pursuit, null);
});

test('the run saves and restores with the rest of the sim, and replays from the seed', () => {
  const play = () => {
    const sim = createSim({ seed: 'replay', ship: SHIP, crew: CREW, lines: LINES, ...CATALOG, sector: REACH, run: { pursuit: true } });
    const { run } = sim.state;
    for (const to of cheapestRoute(run.map, run.at, run.map.delivery).path.slice(1, 4)) fly(sim, to);
    return sim;
  };
  const a = play();
  const b = play();
  assert.equal(hashState(a.state), hashState(b.state));
  const snap = a.snapshot();
  const c = createSim({ seed: 'replay', ship: SHIP, crew: CREW, lines: LINES, ...CATALOG, sector: REACH });
  c.restore(snap);
  assert.deepEqual(c.state.run, a.state.run);
  assert.equal(nodeOf(c.state.run.map, c.state.run.at).id, a.state.run.at);
});
