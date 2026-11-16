// The sector chart, its lanes, and crossings over it (S3.1, D-104; H.6, D-193 to D-199).

import assert from 'node:assert/strict';
import test from 'node:test';

import { createRng } from '../src/engine/rng.js';
import { hashState } from '../src/engine/hash.js';
import { struck } from '../src/sim/encounters.js';
import { COAST, NODE_KINDS, bestRoute, checkSector, cheapestRoute, generateSector, hoursLeft, laneBetween, nodeOf, paceOf, routeTotals, whyNoRunIn } from '../src/sim/sector.js';
import { checkInvariants, createSim } from '../src/sim/sim.js';
import { CATALOG, CREW, LINES, SHIP, castOff, content, fly, flyCrossing } from './helpers.js';

const REACH = content.require('sectors', 'the-reach');
const ENCOUNTERS = content.all('encounters');
const runSim = (seed = 'chart', run = { pursuit: false }, extra = {}) => createSim({ seed, ship: SHIP, crew: CREW, ...CATALOG, sector: REACH, encounters: ENCOUNTERS, run, ...extra });
/** A sim with a chart and nobody else on it: no crew, no ships on the lanes. Margo flies her by the book. */
const quietSim = (seed = 'quiet', run = { pursuit: false }) => createSim({ seed, ship: SHIP, ...CATALOG, sector: REACH, run });
/** The ship that followed us, on the scope. */
const pursuer = (sim) => sim.state.scope.contacts.find((contact) => contact.pursuer) ?? null;
/** The quickest way from where we are to the nearest port, never through another port. */
function nearestPort(sim) {
  const { run } = sim.state;
  const routes = run.map.nodes.filter((node) => node.kind === 'port' && node.id !== run.at).map((node) => bestRoute(run.map, run.at, node.id, { by: 'hours', ports: false }));
  return routes.filter((route) => route.path && route.fuel <= run.fuel).sort((a, b) => a.hours - b.hours)[0].path;
}
const step = (sim, n = 1) => {
  for (let i = 0; i < n; i++) sim.step();
};
/** Ticks in one ship hour. */
const HOUR = REACH.hour * 20;

test('every seeded chart is sound: 15 to 25 points, all reachable, every lane with hours and a risk, a delivery we can afford', () => {
  const kinds = new Set();
  const risks = new Set();
  for (let i = 0; i < 500; i++) {
    const sector = generateSector(REACH, createRng(`sound:${i}`));
    assert.deepEqual(checkSector(sector, REACH), [], `seed ${i}`);
    assert.ok(sector.nodes.length >= 15 && sector.nodes.length <= 25);
    const route = cheapestRoute(sector, sector.start, sector.delivery);
    assert.ok(route.fuel <= REACH.fuel.start, `seed ${i}: the way across costs ${route.fuel}`);
    // Brief §5: a run spans 6 to 10 lanes.
    assert.ok(route.legs >= 6 && route.legs <= 10, `seed ${i}: ${route.legs} lanes across`);
    assert.ok(route.hours >= 15 && route.hours <= 70, `seed ${i}: ${route.hours} hours across`);
    for (const node of sector.nodes) kinds.add(node.kind);
    for (const lane of sector.lanes) {
      risks.add(lane.risk);
      assert.ok(lane.hours >= 1 && lane.hours <= REACH.hours.max, `seed ${i}: a ${lane.hours} hour lane`);
      if (lane.risk === 'hazard') assert.ok(REACH.hazards.includes(lane.hazard), 'a hazard lane is named for its hazard');
    }
    assert.ok(sector.nodes.filter((node) => node.beacon).length <= 1, 'one beacon at most');
  }
  assert.deepEqual([...kinds].sort(), Object.keys(NODE_KINDS).sort(), 'every kind of point turns up');
  assert.deepEqual([...risks].sort(), REACH.risks.map((risk) => risk.id).sort(), 'every kind of lane turns up');
});

test('the risk a lane holds follows the points it joins: patrols by checkpoints, wrecks by derelicts, the beacon\'s line is quick', () => {
  for (let i = 0; i < 50; i++) {
    const sector = generateSector(REACH, createRng(`risk:${i}`));
    for (const lane of sector.lanes) {
      const ends = [nodeOf(sector, lane.a), nodeOf(sector, lane.b)];
      if (ends.some((end) => end.kind === 'checkpoint')) assert.equal(lane.risk, 'patrol');
      else if (ends.some((end) => end.kind === 'derelict')) assert.equal(lane.risk, 'wreck');
      else if (ends.some((end) => end.kind === 'hazard')) assert.equal(lane.risk, 'hazard');
      else if (ends.some((end) => end.beacon)) assert.equal(lane.risk, 'beacon');
    }
  }
});

test('a chart is drawn from the seed alone, and only from the map stream', () => {
  const a = runSim('same');
  const b = runSim('same');
  assert.deepEqual(a.state.run.map, b.state.run.map);
  assert.notDeepEqual(runSim('other').state.run.map, a.state.run.map);
  // Drawing the chart takes nothing from any other stream.
  const bare = createSim({ seed: 'same', ship: SHIP, crew: CREW, ...CATALOG });
  for (const stream of ['combat', 'hazard', 'tactics', 'crew', 'events', 'voyage']) assert.equal(a.rng.stream(stream).next(), bare.rng.stream(stream).next(), stream);
  assert.equal(bare.state.run, null, 'no sector, no run');
});

test('the deadline is the cheapest way across in hours, and a share more', () => {
  for (let i = 0; i < 50; i++) {
    const { run } = runSim(`deadline:${i}`).state;
    const route = cheapestRoute(run.map, run.map.start, run.map.delivery);
    assert.ok(run.deadline >= Math.round(route.hours * (1 + REACH.slack[0])) && run.deadline <= Math.round(route.hours * (1 + REACH.slack[1])), `${run.deadline} for ${route.hours} hours`);
  }
});

test('a route is plotted at a port: from here, lane by lane, to the first port, on the fuel we have', () => {
  const sim = quietSim();
  const { run } = sim.state;
  const path = nearestPort(sim);
  const far = run.map.nodes.find((node) => node.id !== run.at && !laneBetween(run.map, run.at, node.id));
  assert.match(sim.whyNot({ type: 'route.plot', path: [run.at, far.id] }), /no lane/);
  assert.match(sim.whyNot({ type: 'route.plot', path: [path[1], path[0]] }), /starts where we are/);
  const open = run.map.nodes.find((node) => node.kind !== 'port' && laneBetween(run.map, run.at, node.id));
  assert.match(sim.whyNot({ type: 'route.plot', path: [run.at, open.id] }), /ends at a port/);
  assert.match(sim.whyNot({ type: 'route.plot', path: [run.at] }), /at least one lane/);
  assert.match(sim.whyNot({ type: 'route.sail' }), /no route/);
  const through = cheapestRoute(run.map, run.at, run.map.delivery).path;
  const firstPort = through.findIndex((id, i) => i > 0 && nodeOf(run.map, id).kind === 'port');
  if (firstPort < through.length - 1) assert.match(sim.whyNot({ type: 'route.plot', path: through }), /first port/);
  sim.enqueue({ type: 'debug.run', fuel: 0 });
  step(sim);
  assert.match(sim.whyNot({ type: 'route.plot', path }), /fuel/);
  sim.enqueue({ type: 'debug.run', fuel: run.fuelMax });
  step(sim);
  sim.enqueue({ type: 'route.plot', path });
  step(sim);
  assert.deepEqual(run.route, path);
  sim.enqueue({ type: 'route.plot', path: null });
  step(sim);
  assert.equal(run.route, null);
});

test('a crossing is one continuous stretch of ship time: points are passed, not arrived at, and only the port is jumped into', () => {
  const sim = quietSim('continuous');
  const { run } = sim.state;
  const path = nearestPort(sim);
  const totals = routeTotals(run.map, path);
  const seen = [];
  sim.events.on('*', (event, type) => seen.push({ type, event }));
  castOff(sim, path);
  assert.equal(run.route, null);
  assert.equal(run.crossing.phase, 'under way');
  assert.equal(run.fuel, REACH.fuel.start - laneBetween(run.map, path[0], path[1]).fuel, 'the first lane\'s fuel is spent as it begins');
  // Fly it in ship time, never skipping: how far along we are only ever grows.
  let along = 0;
  for (let i = 0; i < totals.hours * HOUR * 2 && run.crossing.phase === 'under way'; i++) {
    sim.step();
    if (!run.crossing) break;
    const now = routeTotals(run.map, path.slice(0, run.crossing.leg + 1)).hours + run.crossing.t;
    assert.ok(now >= along - 1e-9, 'never jumps back');
    along = now;
  }
  assert.equal(run.crossing.phase, 'off port');
  // Margo by the book makes the lane's own pace: the hours on the chart are the hours it took.
  assert.ok(Math.abs(run.hours - totals.hours) < 0.2, `${run.hours} hours for a ${totals.hours} hour route`);
  const passed = seen.filter(({ type }) => type === 'route.passed').map(({ event }) => event.node);
  assert.deepEqual(passed, path.slice(1, -1));
  assert.ok(!seen.some(({ type }) => type === 'sector.arrived' || type === 'sector.jumped'), 'nothing is arrived at on the way');
  assert.deepEqual(checkInvariants(sim), []);
  // Off the port: the run in needs a fix with the helm held and the drive up.
  assert.match(whyNoRunIn(sim), /sensor fix/);
  for (let i = 0; i < 4000 && whyNoRunIn(sim); i++) sim.step();
  assert.equal(whyNoRunIn(sim), null);
  assert.ok(seen.some(({ type }) => type === 'course.ready'));
  sim.enqueue({ type: 'route.jump' });
  step(sim);
  assert.equal(run.crossing, null);
  assert.equal(run.at, path.at(-1));
  assert.equal(run.legs, totals.legs);
  assert.equal(run.fuel, REACH.fuel.start - totals.fuel);
  assert.equal(sim.state.fix, 0, 'the fix was for where we were');
  assert.deepEqual(seen.filter(({ type }) => type === 'sector.arrived').map(({ event }) => event.node), [path.at(-1)]);
  assert.deepEqual(checkInvariants(sim), []);
});

test('the pace: the drive and the helm carry her along; stood down she coasts, and she heaves to while a decision is on the table', () => {
  const sim = quietSim('pace');
  const { run } = sim.state;
  castOff(sim, nearestPort(sim));
  assert.equal(paceOf(sim), 1, 'Margo by the book makes the lane\'s pace');
  const t0 = run.crossing.t;
  step(sim, HOUR);
  assert.ok(Math.abs(run.crossing.t - t0 - 1) < 0.01);
  sim.enqueue({ type: 'station.stand', station: 'engines', down: true });
  step(sim);
  assert.equal(paceOf(sim), COAST, 'running quiet costs time');
  const t1 = run.crossing.t;
  step(sim, HOUR);
  assert.ok(Math.abs(run.crossing.t - t1 - COAST) < 0.01);
  // A decision on the table: she holds where she is, and the clock still runs.
  run.events.open = { id: 'x', node: run.crossing.path[1], cast: {}, result: null };
  const t2 = run.crossing.t;
  const h2 = run.hours;
  step(sim, HOUR);
  assert.equal(run.crossing.t, t2);
  assert.ok(run.hours > h2 + 0.99);
  assert.ok(hoursLeft(run) > 0);
});

test('late is late: past the deadline in hours under way, said once', () => {
  const sim = quietSim('late');
  const { run } = sim.state;
  run.deadline = 1;
  const late = [];
  sim.events.on('contract.late', (event) => late.push(event));
  castOff(sim, nearestPort(sim));
  step(sim, 3 * HOUR);
  assert.ok(run.late);
  assert.equal(late.length, 1);
});

test('the cheapest way across reaches the delivery, port to port, and is delivered', () => {
  const sim = quietSim('across');
  const { run } = sim.state;
  const seen = [];
  for (let i = 0; i < 12 && !run.delivered; i++) {
    const way = cheapestRoute(run.map, run.at, run.map.delivery).path;
    const stop = way.findIndex((id, n) => n > 0 && nodeOf(run.map, id).kind === 'port');
    run.fuel = run.fuelMax;
    seen.push(...fly(sim, way.slice(0, stop + 1)));
  }
  assert.equal(run.at, run.map.delivery);
  assert.ok(run.delivered);
  assert.ok(seen.includes('sector.delivered'));
});

/** Put the sim on a lane of the given risk for as long as it takes, and count what turns up there. */
function sitOn(risk, hours, seed = 'sit') {
  const sim = createSim({ seed, ship: SHIP, ...CATALOG, sector: REACH, encounters: ENCOUNTERS, run: { pursuit: false } });
  const { run } = sim.state;
  const lane = run.map.lanes.find((one) => one.risk === risk) ?? null;
  if (!lane) return null;
  run.at = lane.a;
  run.crossing = { path: [lane.a, lane.b], leg: 0, t: 0, length: 1e6, eventAt: null, phase: 'under way', stalled: false, hours: 0 };
  const met = {};
  let hits = 0;
  sim.events.on('contact.spawned', (event) => (met[event.encounter] = (met[event.encounter] ?? 0) + 1));
  sim.events.on('shot.resolved', (event) => event.weapon === 'debris' && (hits += 1));
  for (let i = 0; i < hours * HOUR; i++) {
    sim.step();
    sim.state.scope.contacts = []; // seen and gone, so the lane can bring the next
  }
  return { met, hits };
}

test('risks along the route change what turns up: each lane brings its own ships, and hazard lanes strike the hull', () => {
  const hours = 60;
  for (const risk of REACH.risks) {
    const seen = [0, 1, 2].map((i) => sitOn(risk.id, hours, `sit:${risk.id}:${i}`)).filter(Boolean);
    assert.ok(seen.length, `a chart with a ${risk.id} lane`);
    const met = {};
    for (const one of seen) for (const [id, n] of Object.entries(one.met)) met[id] = (met[id] ?? 0) + n;
    const total = Object.values(met).reduce((a, b) => a + b, 0);
    const expected = risk.contacts * hours * seen.length;
    assert.ok(total >= expected * 0.4 && total <= expected * 2 + 3, `${risk.id}: ${total} contacts in ${hours * seen.length} hours, about ${expected} expected`);
    for (const id of Object.keys(met)) assert.ok(risk.encounters[id] > 0, `${risk.id} brought a ${id}, which it does not hold`);
    const hits = seen.reduce((sum, one) => sum + one.hits, 0);
    if (risk.strikes) assert.ok(hits > 0, `${risk.id}: no strikes`);
    else assert.equal(hits, 0, `${risk.id}: strikes on a lane without any`);
  }
});

test('a follower finds us some hours out, coming up from astern; driven off by the gun the chase is over', () => {
  const sim = runSim('follow', { pursuit: true }, { encounters: ENCOUNTERS.filter((def) => def.id === REACH.pursuit.encounter) });
  const { run } = sim.state;
  for (const risk of Object.values(run.risks)) risk.contacts = 0; // nobody else on the lanes
  let caught = null;
  let sighted = 0;
  sim.events.on('pursuit.caught', (event) => (caught = event));
  sim.events.on('pursuit.sighted', () => (sighted += 1));
  castOff(sim, nearestPort(sim));
  run.crossing.length = 1e6; // a long lane, so there is time
  // Not within its lead.
  step(sim, Math.floor(REACH.pursuit.lead * HOUR * 0.9));
  assert.equal(caught, null);
  for (let i = 0; i < 40 * HOUR && !caught && run.crossing; i++) {
    if (run.crossing.phase !== 'under way') break;
    sim.step();
  }
  assert.ok(caught, 'found us');
  const contact = pursuer(sim);
  assert.equal(contact.encounter, REACH.pursuit.encounter);
  assert.equal(contact.state, 'shadowing');
  assert.equal(run.pursuit.contact, contact.id);
  for (let i = 0; i < 60 * 20 && !sighted; i++) sim.step();
  assert.equal(sighted, 1, 'Margo sees it on the scope');
  assert.deepEqual(checkInvariants(sim), []);
  const ended = [];
  sim.events.on('pursuit.ended', (event) => ended.push(event.outcome));
  while (contact.state !== 'lost') struck(sim, contact, true);
  assert.equal(run.pursuit.done, true);
  assert.deepEqual(ended, ['deterred']);
});

test('a follower slipped any other way picks the trail up again after its lead', () => {
  const sim = runSim('slip', { pursuit: true });
  const { run } = sim.state;
  castOff(sim, nearestPort(sim));
  sim.enqueue({ type: 'debug.run', pursuit: 'catch' });
  step(sim);
  const contact = pursuer(sim);
  assert.ok(contact);
  // It docks with us, or the run in leaves it behind: either way it will be back.
  run.crossing.phase = 'off port';
  sim.state.fix = 1;
  sim.enqueue({ type: 'route.jump' });
  step(sim);
  assert.equal(pursuer(sim), null);
  assert.equal(run.pursuit.done, false);
  assert.equal(run.pursuit.contact, null);
  assert.equal(run.pursuit.wait, REACH.pursuit.lead);
});

test('the debug panel brings the follower in under way, and sends it home', () => {
  const sim = runSim('debug');
  assert.match(sim.whyNot({ type: 'debug.run', pursuit: 'catch' }), /under way/);
  castOff(sim, nearestPort(sim));
  sim.enqueue({ type: 'debug.run', pursuit: 'catch' });
  step(sim);
  assert.equal(pursuer(sim)?.encounter, REACH.pursuit.encounter);
  sim.enqueue({ type: 'debug.run', pursuit: 'off' });
  step(sim);
  assert.equal(sim.state.run.pursuit, null);
});

test('the run saves and restores with the rest of the sim, under way or in port, and replays from the seed', () => {
  const play = () => {
    const sim = createSim({ seed: 'replay', ship: SHIP, crew: CREW, lines: LINES, ...CATALOG, sector: REACH, encounters: ENCOUNTERS, run: { pursuit: true } });
    castOff(sim, nearestPort(sim));
    step(sim, 3 * HOUR);
    return sim;
  };
  const a = play();
  const b = play();
  assert.equal(hashState(a.state), hashState(b.state));
  const snap = a.snapshot();
  const c = createSim({ seed: 'replay', ship: SHIP, crew: CREW, lines: LINES, ...CATALOG, sector: REACH, encounters: ENCOUNTERS });
  c.restore(snap);
  assert.deepEqual(c.state.run, a.state.run);
  flyCrossing(a);
  flyCrossing(c);
  assert.equal(hashState(a.state), hashState(c.state));
});
