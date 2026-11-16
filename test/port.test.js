// Ports (S3.4, D-114): refuelling, repairs and selling cost and pay credits; the money never goes below 0.

import assert from 'node:assert/strict';
import test from 'node:test';

import { contractCrates } from '../src/sim/contracts.js';
import { addCrate } from '../src/sim/hold.js';
import { portHere, refuelQuote, repairQuote, whyNoRefuel, whyNoRepair, whyNoSell } from '../src/sim/port.js';
import { checkInvariants, createSim } from '../src/sim/sim.js';
import { CATALOG, CREW, SHIP, content } from './helpers.js';

const PORTS = content.all('ports');
const DOCK = PORTS[0];
const portSim = (contract = 'smuggling-cold-freight') => createSim({ seed: 'port', ship: SHIP, crew: CREW, ...CATALOG, sector: content.require('sectors', 'the-reach'), run: { pursuit: false }, contract: contract ? content.require('contracts', contract) : null, ports: PORTS });

const give = (sim, command) => {
  assert.equal(sim.whyNot(command), null, `${command.type}: ${sim.whyNot(command)}`);
  sim.enqueue(command);
  sim.step();
};

test('every port is the company dock until S3.5 names them, and only a port serves', () => {
  const sim = portSim();
  assert.equal(portHere(sim).id, DOCK.id);
  const run = sim.state.run;
  run.at = run.map.nodes.find((node) => node.kind !== 'port').id;
  assert.equal(portHere(sim), null);
  run.fuel = 2;
  assert.match(whyNoRefuel(sim), /only a port/);
  assert.match(whyNoRepair(sim, 'hull'), /only a port/);
  assert.match(whyNoSell(sim, 'salvage'), /only a port/);
});

test('fuel is bought by the unit, as much as the money will pay for', () => {
  const sim = portSim();
  const run = sim.state.run;
  run.fuel = 4;
  sim.state.money = 1000;
  give(sim, { type: 'port.refuel' });
  assert.equal(run.fuel, run.fuelMax);
  assert.equal(sim.state.money, 1000 - (run.fuelMax - 4) * DOCK.fuel);
  run.fuel = 0;
  sim.state.money = DOCK.fuel * 3 + 5;
  assert.deepEqual(refuelQuote(sim), { want: run.fuelMax, units: 3, cost: DOCK.fuel * 3, price: DOCK.fuel });
  give(sim, { type: 'port.refuel' });
  assert.equal(run.fuel, 3);
  assert.equal(sim.state.money, 5);
  assert.match(whyNoRefuel(sim), /fuel is 12 credits a unit and we have 5/);
});

test('the yard mends the hull and damaged systems for credits, as far as the money goes, and leaves lost systems alone', () => {
  const sim = portSim();
  sim.state.hull.points = sim.state.hull.max - 5;
  sim.state.money = DOCK.hull * 2;
  assert.deepEqual(repairQuote(sim, 'hull'), { want: 5, units: 2, cost: DOCK.hull * 2, price: DOCK.hull });
  give(sim, { type: 'port.repair', what: 'hull' });
  assert.equal(sim.state.hull.points, sim.state.hull.max - 3);
  assert.equal(sim.state.money, 0);
  assert.match(whyNoRepair(sim, 'hull'), /credits a point and we have 0/);

  sim.state.systems.sensors.damage = 1;
  sim.state.systems.engines.damage = 2;
  sim.state.money = 1000;
  assert.equal(repairQuote(sim, 'systems').want, 3);
  const mended = [];
  sim.events.on('system.repaired', (event) => mended.push(event.system));
  give(sim, { type: 'port.repair', what: 'systems' });
  assert.equal(sim.state.systems.sensors.damage, 0);
  assert.equal(sim.state.systems.engines.damage, 0);
  assert.equal(sim.state.money, 1000 - 3 * DOCK.system);
  assert.deepEqual(mended.sort(), ['engines', 'sensors']);
  assert.match(whyNoRepair(sim, 'systems'), /nothing aboard is damaged/);
  assert.match(whyNoRepair(sim, 'paint'), /repairs are for/);
  assert.deepEqual(checkInvariants(sim), []);
});

test('loose salvage sells at the yard price; selling the contract cargo pays its value and fails the contract', () => {
  const sim = portSim();
  const money = sim.state.money;
  addCrate(sim, { kind: 'salvage', room: 'hold' });
  addCrate(sim, { kind: 'salvage', room: 'hold' });
  give(sim, { type: 'port.sell', what: 'salvage' });
  assert.equal(sim.state.money, money + 2 * DOCK.salvage);
  assert.match(whyNoSell(sim, 'salvage'), /no salvage/);

  const before = sim.state.money;
  give(sim, { type: 'port.sell', what: 'contract' });
  assert.equal(contractCrates(sim).length, 0);
  assert.equal(sim.state.run.contract.status, 'failed');
  assert.equal(sim.state.run.contract.reason, 'sold');
  assert.equal(sim.state.run.contract.sold, 4);
  assert.equal(sim.state.money, before + 4 * 160 - 100, 'the value of the crates, less the penalty the client takes back');
  assert.match(whyNoSell(sim, 'contract'), /no contract cargo/);
  // At the drop the contract is handed over, not sold.
  const other = portSim();
  other.state.run.at = other.state.run.map.delivery;
  assert.match(whyNoSell(other, 'contract'), /hand it over instead/);
});

test('a sim with no port content has ports that charge nothing', () => {
  const sim = createSim({ seed: 'free', ship: SHIP, crew: CREW, ...CATALOG, sector: content.require('sectors', 'the-reach'), run: { pursuit: false } });
  sim.state.run.fuel = 1;
  sim.state.money = 0;
  give(sim, { type: 'port.refuel' });
  assert.equal(sim.state.run.fuel, sim.state.run.fuelMax);
  sim.state.hull.points -= 4;
  give(sim, { type: 'port.repair', what: 'hull' });
  assert.equal(sim.state.hull.points, sim.state.hull.max);
});
