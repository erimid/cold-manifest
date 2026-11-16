// The run loop around the sim: the board, arrival screens, endings, the summary and the port screen (S3.2, D-108; S3.4).

import assert from 'node:assert/strict';
import test from 'node:test';

import { BOARD_SIZE, ENDINGS, boardOffers, lostEnding, portView, screenForArrival, summarize } from '../src/sim/runflow.js';
import { whyNoRefuel } from '../src/sim/port.js';
import { NODE_KINDS } from '../src/sim/sector.js';
import { createSim } from '../src/sim/sim.js';
import { CATALOG, CREW, SHIP, content } from './helpers.js';

const CONTRACTS = content.all('contracts');
const FACTIONS = content.all('factions');
const PORTS = content.all('ports');
const contractSim = (id, seed = 'flow') => createSim({ seed, ship: SHIP, crew: CREW, ...CATALOG, sector: content.require('sectors', 'the-reach'), run: { pursuit: false }, contract: content.require('contracts', id), ports: PORTS });

const REACH = content.require('sectors', 'the-reach');
const runSim = (seed = 'flow') => createSim({ seed, ship: SHIP, crew: CREW, ...CATALOG, sector: REACH, run: { pursuit: false } });

test('a port opens the port screen; everywhere else it is the sim that decides whether an event opens', () => {
  assert.equal(screenForArrival('port'), 'port');
  for (const kind of Object.keys(NODE_KINDS)) if (kind !== 'port') assert.equal(screenForArrival(kind), null);
});

test('the board offers one contract of each of the first three types, the same for the same seed', () => {
  const offers = boardOffers(CONTRACTS, { seed: 'board-1', factions: FACTIONS });
  assert.equal(offers.length, BOARD_SIZE);
  assert.deepEqual(offers.map((offer) => offer.type), ['smuggling', 'courier', 'salvage']);
  assert.deepEqual(offers.map((offer) => offer.typeName), ['Smuggling', 'Courier', 'Salvage claim']);
  for (const offer of offers) {
    assert.equal(typeof offer.followed, 'boolean');
    assert.ok(offer.pay > 0 && offer.advance < offer.pay);
    assert.ok(!/^[a-z-]+$/.test(offer.client), `the client is named, not an id: ${offer.client}`);
    assert.match(offer.cargo, /crate/);
  }
  assert.deepEqual(boardOffers(CONTRACTS, { seed: 'board-1', factions: FACTIONS }).map((o) => [o.id, o.followed]), offers.map((o) => [o.id, o.followed]));
  const followed = new Set();
  for (let i = 0; i < 40; i++) for (const offer of boardOffers(CONTRACTS, { seed: `board-${i}` })) followed.add(`${offer.type}:${offer.followed}`);
  assert.ok(followed.has('smuggling:true') && followed.has('courier:false'), 'whether a contract is followed is rolled');
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

test('the summary names the ending, the contract and what became of it, the money, standing, jumps and who died', () => {
  const sim = contractSim('courier-cold-chain');
  Object.values(sim.state.crew)[0].alive = false;
  sim.enqueue({ type: 'contract.abandon' });
  sim.step();
  const summary = summarize(sim, 'retired', { factions: FACTIONS });
  assert.equal(summary.title, ENDINGS.retired);
  const rows = Object.fromEntries(summary.rows);
  assert.match(rows.Contract, /^Courier: /);
  assert.equal(rows.Result, 'Failed: we walked away from it');
  assert.equal(rows.Paid, '150 advance');
  assert.equal(rows.Standing, 'Reach Medical Cooperative -2');
  assert.equal(rows.Money, String(120 + 150 - 60));
  assert.match(rows.Jumps, /^0 of \d+ allowed$/);
  assert.equal(rows.Crew, '5 of 6 alive');
  assert.equal(summary.dead.length, 1);
  for (const kind of Object.keys(ENDINGS)) assert.ok(summarize(runSim(), kind).headline, kind);
  assert.equal(Object.fromEntries(summarize(runSim(), 'retired').rows).Contract, 'None');
});

test('refuelling works at a port with room in the tanks, and nowhere else (free with no port content)', () => {
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

test('the port screen offers every service with its price or the reason it cannot be had, and the drop offers the hand-over', () => {
  const sim = contractSim('smuggling-cold-freight');
  const run = sim.state.run;
  run.fuel = 6;
  sim.state.hull.points -= 3;
  let view = portView(sim);
  assert.equal(view.isDrop, false);
  const by = Object.fromEntries(view.services.map((service) => [service.id, service]));
  assert.deepEqual(Object.keys(by), ['refuel', 'repair-hull', 'repair-systems', 'sell-salvage', 'sell-contract', 'abandon']);
  assert.equal(by.refuel.why, null);
  assert.match(by.refuel.detail, /6 units, 72 credits/);
  assert.match(by['repair-hull'].detail, /3 points, 30 credits/);
  assert.match(by['repair-systems'].why, /nothing aboard is damaged/);
  assert.match(by['sell-salvage'].why, /no salvage/);
  assert.match(by['sell-contract'].detail, /4 crates for 640\. The contract fails/);
  assert.equal(by['sell-contract'].danger, true);
  assert.equal(view.deliver, null);
  assert.equal(view.canRetire, true);
  assert.deepEqual(view.facts.map(([label]) => label), ['Money', 'Fuel', 'Hull', 'Contract']);
  assert.match(Object.fromEntries(view.facts).Contract, /Smuggling: 4 of 4 crates aboard/);
  // Money short: as much fuel as it buys.
  sim.state.money = 30;
  assert.match(portView(sim).services[0].detail, /All we can pay for: 2 of 6, 24 credits/);
  // At the drop: the hand-over, with what it pays, and no selling or walking away.
  run.at = run.map.delivery;
  view = portView(sim);
  assert.equal(view.isDrop, true);
  assert.equal(view.deliver.why, null);
  assert.match(view.deliver.detail, /900 earned, 200 advanced: 700 to collect/);
  assert.equal(view.canRetire, false);
  assert.ok(!view.services.some((service) => service.id === 'sell-contract' || service.id === 'abandon'));
});
