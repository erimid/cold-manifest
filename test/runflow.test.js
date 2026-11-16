// The run loop around the sim: arrival screens, endings, the summary and refuelling (S3.2, D-108).

import assert from 'node:assert/strict';
import test from 'node:test';

import { ENDINGS, STUB_CONTRACTS, lostEnding, payFor, screenForArrival, summarize } from '../src/sim/runflow.js';
import { NODE_KINDS, whyNoRefuel } from '../src/sim/sector.js';
import { createSim } from '../src/sim/sim.js';
import { CATALOG, CREW, SHIP, content } from './helpers.js';

const REACH = content.require('sectors', 'the-reach');
const runSim = (seed = 'flow') => createSim({ seed, ship: SHIP, crew: CREW, ...CATALOG, sector: REACH, run: { pursuit: false } });

test('a port opens the port screen; everywhere else it is the sim that decides whether an event opens', () => {
  assert.equal(screenForArrival('port'), 'port');
  for (const kind of Object.keys(NODE_KINDS)) if (kind !== 'port') assert.equal(screenForArrival(kind), null);
});

test('the stub contracts cover the three first types, and each says whether it is followed', () => {
  assert.deepEqual(STUB_CONTRACTS.map((c) => c.type), ['Smuggling', 'Courier', 'Salvage claim']);
  assert.equal(new Set(STUB_CONTRACTS.map((c) => c.id)).size, STUB_CONTRACTS.length);
  for (const contract of STUB_CONTRACTS) assert.equal(typeof contract.followed, 'boolean');
});

test('pay is whole on time, half late, and nothing for any other ending', () => {
  const contract = { pay: 900 };
  assert.equal(payFor(contract, 'delivered'), 900);
  assert.equal(payFor(contract, 'late'), 450);
  for (const kind of ['retired', 'destroyed', 'crew-dead', 'stranded']) assert.equal(payFor(contract, kind), 0);
  assert.equal(payFor(null, 'delivered'), 0);
});

test('a run is lost when every crew member is dead, and not before', () => {
  const sim = runSim();
  assert.equal(lostEnding(sim), null);
  const members = Object.values(sim.state.crew);
  members.slice(1).forEach((m) => (m.alive = false));
  assert.equal(lostEnding(sim), null, 'one is still alive');
  members[0].alive = false;
  assert.equal(lostEnding(sim), 'crew-dead');
});

test('the summary names the ending, the contract, the jumps and who died', () => {
  const sim = runSim();
  Object.values(sim.state.crew)[0].alive = false;
  const summary = summarize(sim, 'late', STUB_CONTRACTS[1]);
  assert.equal(summary.title, ENDINGS.late);
  const rows = Object.fromEntries(summary.rows);
  assert.match(rows.Contract, /Courier/);
  assert.match(rows.Jumps, /^0 of \d+ allowed$/);
  assert.equal(rows.Crew, '2 of 3 alive');
  assert.equal(rows.Pay, '300 of 600');
  assert.equal(summary.dead.length, 1);
  for (const kind of Object.keys(ENDINGS)) assert.ok(summarize(sim, kind, null).headline, kind);
});

test('refuelling works at a port with room in the tanks, and nowhere else', () => {
  const sim = runSim();
  const run = sim.state.run;
  run.fuel = run.fuelMax;
  assert.match(whyNoRefuel(sim), /full/, 'a full tank takes nothing');
  run.fuel = 4;
  assert.equal(whyNoRefuel(sim), null, 'the origin is a port');
  const seen = [];
  sim.events.on('port.refueled', (event) => seen.push(event));
  sim.enqueue({ type: 'port.refuel' });
  sim.step();
  assert.equal(run.fuel, run.fuelMax);
  assert.equal(seen[0].bought, run.fuelMax - 4);
  assert.match(whyNoRefuel(sim), /full/);
  const open = run.map.nodes.find((node) => node.kind !== 'port');
  run.at = open.id;
  run.fuel = 2;
  assert.match(whyNoRefuel(sim), /only a port/);
});
