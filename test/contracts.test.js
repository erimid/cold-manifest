// Contracts (S3.4, D-113, D-115): the cargo, the advance, delivery, failure, standing, the inspection and the claim.
// A full contract of each type is completed, and failed, by flying crossings over the chart (H.6).

import { SHIP_HOUR } from '../src/sim/shipclock.js';
import assert from 'node:assert/strict';
import test from 'node:test';

import { hashState } from '../src/engine/hash.js';
import { validateContent } from '../src/engine/content-schema.js';
import { validateCondition, match } from '../src/narrative/conditions.js';
import { applyEffects, validateEffects } from '../src/narrative/effects.js';
import { eventView, situationViews } from '../src/narrative/events.js';
import { OPENED_SHARE, cargoCount, contractCrates, settlement, whyNoDeliver } from '../src/sim/contracts.js';
import { cheapestRoute, heldReason, nodeOf } from '../src/sim/sector.js';
import { checkInvariants, createSim } from '../src/sim/sim.js';
import { readContentFiles } from '../tools/lib/load-content.js';
import { CATALOG, CREW, EVENTS, SHIP, castOff, content, dealWith, dealWithAll, mendForRunIn, routeVia, standIn } from './helpers.js';

const REACH = content.require('sectors', 'the-reach');
const PORTS = content.all('ports');
const template = (id) => content.require('contracts', id);
const SMUGGLING = 'smuggling-cold-freight';
const COURIER = 'courier-cold-chain';
const SALVAGE = 'salvage-aphelion';

/** A run carrying a contract. `events` puts the transit events (the inspection and the claim among them) on the chart. */
const contractSim = (id, { seed = 'contract', events = false } = {}) =>
  createSim({ seed, ship: SHIP, crew: CREW, ...CATALOG, sector: REACH, run: { pursuit: false }, contract: template(id), ports: PORTS, events: events ? EVENTS : [] });

/** Fly on until `stop()` says so or the crossing is over, skipping along each lane and answering nothing. */
function flyUntil(sim, stop) {
  const run = sim.state.run;
  for (let i = 0; i < 20000 && run.crossing && !stop(); i++) {
    if (run.events.open) answer(sim, eventView(sim).choices.find((choice) => choice.available).id);
    else if (dealWithAll(sim)) continue;
    else if (run.crossing.phase === 'under way') sim.enqueue({ type: 'debug.run', skip: true });
    else if (!sim.whyNot({ type: 'route.jump' })) sim.enqueue({ type: 'route.jump' });
    else mendForRunIn(sim);
    sim.step();
  }
}

/**
 * Fly the cheapest way to `to`, port to port, with the tanks topped up, until we are at it (a port) or an event
 * about it is on the table or waiting aboard, or we have passed it (any other point). Returns once we are there.
 */
function flyTo(sim, to) {
  const run = sim.state.run;
  const there = () => run.at === to || run.events.open?.node === to || run.events.aboard.some((one) => one.node === to && !one.result);
  for (let i = 0; i < 12 && !there(); i++) {
    if (!run.crossing) {
      sim.state.run.fuel = run.fuelMax;
      castOff(sim, routeVia(run, to));
    }
    flyUntil(sim, there);
  }
  assert.ok(there(), `never got to ${to}`);
}

/** The salvage claim alongside, as its card shows it (H.7), or undefined. */
const claimAboard = (sim) => situationViews(sim).find((view) => view.id === 'claim.aphelion' && !view.result);

/** Answer the open event with a choice, and put it away. */
function answer(sim, choice) {
  sim.enqueue({ type: 'event.choose', choice });
  sim.step();
  sim.enqueue({ type: 'event.dismiss' });
  sim.step();
}

const give = (sim, command) => {
  assert.equal(sim.whyNot(command), null, `${command.type}: ${sim.whyNot(command)}`);
  sim.enqueue(command);
  sim.step();
};

test('taking a contract puts its sealed crates in the hold in place of the ship\'s manifest, keeps the ammo, and pays the advance', () => {
  const sim = contractSim(SMUGGLING);
  const crates = Object.values(sim.state.crates);
  const ours = contractCrates(sim);
  assert.equal(ours.length, 4);
  assert.ok(ours.every((crate) => crate.kind === 'cargo' && crate.sealed && crate.contraband && /Agricultural pumps/.test(crate.label)));
  assert.ok(crates.every((crate) => crate.kind === 'ammo' || crate.contract), 'the standing manifest crates are gone');
  assert.equal(crates.filter((crate) => crate.kind === 'ammo').length, 4);
  assert.equal(sim.state.money, 120 + 200);
  assert.equal(sim.state.run.contract.status, 'active');
  assert.equal(sim.state.run.contract.expected, cargoCount(template(SMUGGLING)));
  // A sandbox sim still has the ship's own manifest.
  const sandbox = createSim({ seed: 'contract', ship: SHIP, crew: CREW, ...CATALOG });
  assert.equal(Object.values(sandbox.state.crates).filter((crate) => crate.kind === 'cargo').length, 8);
  assert.throws(() => createSim({ seed: 'x', ship: SHIP, crew: CREW, ...CATALOG, contract: template(COURIER) }), /needs a sector/);
});

test('a smuggling contract delivered whole and on time pays the fee less the advance, raises the client\'s standing, and ends with no crates', () => {
  const sim = contractSim(SMUGGLING);
  const run = sim.state.run;
  assert.match(whyNoDeliver(sim), /at the drop/);
  flyTo(sim, run.map.delivery);
  assert.equal(run.late, false);
  assert.equal(whyNoDeliver(sim), null);
  const delivered = [];
  sim.events.on('contract.delivered', (event) => delivered.push(event));
  const before = sim.state.money;
  give(sim, { type: 'contract.deliver' });
  assert.equal(sim.state.money - before, 900 - 200);
  assert.equal(run.contract.status, 'delivered');
  assert.equal(run.contract.paid, 700);
  assert.equal(sim.state.reputation.confederation, 2);
  assert.equal(contractCrates(sim).length, 0);
  assert.deepEqual(delivered.map((e) => [e.earned, e.paid, e.clean]), [[900, 700, true]]);
  assert.match(whyNoDeliver(sim), /handed over/);
  assert.deepEqual(checkInvariants(sim), []);
});

test('late, opened or short cargo is paid for in part and moves no standing; a late courier fails the moment it is late', () => {
  const late = contractSim(SMUGGLING);
  late.state.run.at = late.state.run.map.delivery;
  late.state.run.late = true;
  assert.deepEqual([settlement(late).earned, settlement(late).standing], [450, 0]);

  const opened = contractSim(SMUGGLING);
  const [first, second] = contractCrates(opened);
  first.sealed = false;
  delete opened.state.crates[second.id];
  const result = settlement(opened);
  assert.equal(result.earned, Math.round(900 * (2 + OPENED_SHARE) / 4));
  assert.equal(result.standing, 0);
  assert.equal(result.clean, false);

  const courier = contractSim(COURIER);
  const run = courier.state.run;
  const failed = [];
  courier.events.on('contract.failed', (event) => failed.push(event.reason));
  // Cast off and dawdle off the port until the deadline is gone.
  run.deadline = 2;
  castOff(courier, routeVia(run, run.map.delivery));
  for (let i = 0; i < 20 * SHIP_HOUR * 4 && !run.late; i++) courier.step();
  assert.deepEqual(failed, ['late']);
  assert.equal(run.contract.status, 'failed');
  assert.equal(courier.state.reputation.collective, -2);
  assert.match(whyNoDeliver(courier), /failed: it arrived too late/);
});

test('every crate over the side fails the contract: standing drops, the client takes its penalty, and nothing can be handed over', () => {
  const sim = contractSim(SMUGGLING);
  const money = sim.state.money;
  const reasons = [];
  sim.events.on('contract.failed', (event) => reasons.push(event.reason));
  const crates = contractCrates(sim);
  for (const crate of crates.slice(0, -1)) {
    delete sim.state.crates[crate.id];
    sim.events.emit('crate.jettisoned', { crate: crate.id });
  }
  assert.equal(sim.state.run.contract.status, 'active', 'one crate is still aboard');
  delete sim.state.crates[crates.at(-1).id];
  sim.events.emit('crate.lost', { crate: crates.at(-1).id });
  assert.deepEqual(reasons, ['lost']);
  assert.equal(sim.state.reputation.confederation, -3);
  assert.equal(sim.state.money, money - 100);
  // Failing does not end the run: the ship still flies, and the port still serves.
  assert.equal(sim.whyNot({ type: 'contract.abandon' }), 'there is no contract in hand to walk away from');
  assert.deepEqual(checkInvariants(sim), []);
});

test('a crate jettisoned by the crew out of the airlock counts against the contract', () => {
  const sim = contractSim(COURIER);
  const [crate] = contractCrates(sim);
  give(sim, { type: 'crate.jettison', crate: crate.id, crew: 'dace' });
  for (let i = 0; i < 20 * 120 && sim.state.crates[crate.id]; i++) sim.step();
  assert.equal(sim.state.crates[crate.id], undefined, 'it went out');
  assert.equal(contractCrates(sim).length, 1);
  assert.equal(sim.state.run.contract.status, 'active');
  sim.state.run.at = sim.state.run.map.delivery;
  assert.equal(settlement(sim).earned, 300);
});

test('a salvage claim: no cargo at the start, a derelict on the chart, a deadline that allows for it, and the claim event until it is worked', () => {
  for (let i = 0; i < 6; i++) {
    const sim = contractSim(SALVAGE, { seed: `claim-${i}`, events: true });
    const run = sim.state.run;
    const claim = run.contract.claim;
    assert.equal(contractCrates(sim).length, 0);
    assert.equal(nodeOf(run.map, claim.node).kind, 'derelict');
    const via = cheapestRoute(run.map, run.map.start, claim.node).hours + cheapestRoute(run.map, claim.node, run.map.delivery).hours;
    assert.ok(run.deadline >= via, `seed ${i}: the deadline ${run.deadline} allows ${via} hours by the claim`);
    assert.equal(sim.state.money, 120 + 100);
    if (i > 0) continue;
    // Straight to the drop: nothing to hand over.
    const straight = contractSim(SALVAGE, { seed: 'claim-0' });
    straight.state.run.at = straight.state.run.map.delivery;
    assert.match(whyNoDeliver(straight), /the claim at .* was never worked/);
    // To the claim: its event opens, before anything the dice would bring.
    flyTo(sim, claim.node);
    assert.equal(claimAboard(sim)?.id, 'claim.aphelion', 'she is alongside: a situation at one of our locks');
    assert.equal(claimAboard(sim).mark, 'The claim');
    assert.equal(heldReason(sim), 'we are standing by something alongside');
    assert.equal(match({ fact: 'contract.claim' }, { sim }) !== null, true);
    dealWith(sim, claimAboard(sim).n, () => 'leave');
    assert.equal(claim.done, false);
    // Leave, fly on to the next port, and come back by it: it opens again.
    flyUntil(sim, () => false);
    assert.equal(run.crossing, null);
    flyTo(sim, claim.node);
    assert.equal(claimAboard(sim)?.id, 'claim.aphelion');
    dealWith(sim, claimAboard(sim).n, () => 'quick');
    assert.equal(claim.done, true);
    assert.equal(contractCrates(sim).length, 2);
    assert.ok(contractCrates(sim).every((crate) => crate.kind === 'salvage' && !crate.sealed));
    flyTo(sim, run.map.delivery);
    const before = sim.state.money;
    give(sim, { type: 'contract.deliver' });
    assert.equal(sim.state.money - before, (run.late ? Math.round(600 * 0.75) : 600) - 100, 'half the salvage, half the fee');
    assert.equal(run.contract.status, 'delivered');
  }
});

test('the engineer can cut the sealed bay: every crate of the claim comes aboard', () => {
  const sim = contractSim(SALVAGE, { seed: 'claim-0', events: true });
  flyTo(sim, sim.state.run.contract.claim.node);
  const claim = claimAboard(sim);
  assert.equal(claim.state, 'waiting');
  assert.deepEqual(claim.choices, [], 'nothing is offered until someone is at the lock');
  standIn(sim, 'pruitt', claim.room);
  sim.step();
  const cut = claimAboard(sim).choices.find((choice) => choice.id === 'cut');
  assert.equal(cut.available, true);
  assert.match(cut.tag, /Dace/);
  dealWith(sim, claim.n, () => 'cut');
  assert.equal(contractCrates(sim).length, 4);
});

test('carrying contraband through a checkpoint brings the inspection before any other event there; without it, the patrol line', () => {
  const findCheckpoint = (sim) => sim.state.run.map.nodes.find((node) => node.kind === 'checkpoint');
  const smuggler = contractSim(SMUGGLING, { seed: 'inspect', events: true });
  flyTo(smuggler, findCheckpoint(smuggler).id);
  assert.equal(smuggler.state.run.events.open?.id, 'checkpoint.inspection');
  // From H.2 the inspection is a boarding (boarders.js): standing by the lock is always open; the bribe is paid at the lock.
  assert.ok(eventView(smuggler).choices.some((choice) => choice.id === 'submit' && choice.available));

  const courier = contractSim(COURIER, { seed: 'inspect', events: true });
  flyTo(courier, findCheckpoint(courier).id);
  assert.notEqual(courier.state.run.events.open?.id, 'checkpoint.inspection');
});

test('an inspection that finds the contraband seizes it and fails the contract; a seizure leaves other cargo alone', () => {
  const sim = contractSim(SMUGGLING);
  const ctx = { sim, vars: {} };
  applyEffects([{ do: 'contract.seize' }, { do: 'reputation', faction: 'receivers', add: -2 }], ctx);
  assert.equal(contractCrates(sim).length, 0);
  assert.equal(sim.state.run.contract.status, 'failed');
  assert.equal(sim.state.run.contract.reason, 'seized');
  assert.equal(sim.state.run.contract.seized, 4);
  assert.equal(sim.state.reputation.receivers, -2);
  assert.equal(sim.state.reputation.confederation, -3);
  assert.deepEqual(sim.state.run.contract.standing, { confederation: -3, receivers: -2 });

  const courier = contractSim(COURIER);
  applyEffects([{ do: 'contract.seize' }], { sim: courier, vars: {} });
  assert.equal(contractCrates(courier).length, 2, 'nothing in the courier\'s coolers is contraband');
  assert.equal(courier.state.run.contract.status, 'active');
});

test('the contract words in the condition language: facts, effects, and the checker catching mistakes', () => {
  const sim = contractSim(SMUGGLING);
  const ctx = { sim, vars: {} };
  assert.ok(match({ fact: 'contract.type', eq: 'smuggling' }, ctx));
  assert.ok(match({ fact: 'contract.crates', eq: 4 }, ctx));
  assert.ok(match({ fact: 'contraband', gte: 1 }, ctx));
  assert.ok(match({ fact: 'reputation', faction: 'client', eq: 0 }, ctx));
  applyEffects([{ do: 'reputation', faction: 'client', add: 3 }, { do: 'reputation', faction: 'the-order', add: -20 }], ctx);
  assert.ok(match({ fact: 'reputation', faction: 'confederation', eq: 3 }, ctx));
  assert.equal(sim.state.reputation['the-order'], -10, 'standing stays within -10 to 10');
  applyEffects([{ do: 'contract.fail', reason: 'abandoned' }], ctx);
  assert.ok(match({ fact: 'contract.status', eq: 'failed' }, ctx));
  // Without a contract, the contract facts have no value.
  const sandbox = createSim({ seed: 'x', ship: SHIP, crew: CREW, ...CATALOG });
  assert.equal(match({ fact: 'contract.type', eq: 'smuggling' }, { sim: sandbox, vars: {} }), null);
  assert.ok(match({ fact: 'contraband', eq: 0 }, { sim: sandbox, vars: {} }));

  const refs = { factions: new Set(['receivers']) };
  assert.deepEqual(validateEffects([{ do: 'reputation', faction: 'client', add: 1 }, { do: 'reputation', faction: 'receivers', add: -1 }, { do: 'contract.load', count: 2 }, { do: 'contract.seize', all: true }, { do: 'contract.fail', reason: 'sold' }], { refs }), []);
  assert.match(validateEffects([{ do: 'reputation', faction: 'pirates', add: 1 }], { refs })[0], /no faction "pirates"/);
  assert.match(validateEffects([{ do: 'contract.fail', reason: 'bored' }], { refs })[0], /must be one of/);
  assert.match(validateCondition({ fact: 'reputation', faction: 'nobody', gte: 1 }, { refs }).problems[0], /no faction "nobody"/);
});

test('the content checker reads every contract, port and faction and catches a broken one', () => {
  const files = readContentFiles();
  assert.deepEqual(validateContent(files).errors, []);
  const broken = structuredClone(files);
  const file = broken.find((one) => one.path.startsWith('contracts/'));
  Object.assign(file.data.items[0], { type: 'piracy', client: 'nobody', advance: 99999, latePay: 2 });
  file.data.items[2].claim.event = 'claim.nowhere';
  file.data.items[1].cargo[0].kind = 'ammo';
  const errors = validateContent(broken).errors.join('\n');
  for (const pattern of [/type must be one of/, /no faction "nobody"/, /advance must be/, /latePay must be/, /no event "claim.nowhere"/, /kind must be cargo or salvage/, /"claim.aphelion": has no "at", no "jolt" and no other event leads on to it/]) assert.match(errors, pattern);
  const port = broken.find((one) => one.path.startsWith('ports/'));
  port.data.items[0].services.push('shipyard');
  port.data.items[0].fuel = -1;
  assert.match(validateContent(broken).errors.join('\n'), /no service "shipyard"[\s\S]*|fuel must be/);
});

test('a contract run replays from its seed and survives a snapshot', () => {
  const play = () => {
    const sim = contractSim(SALVAGE, { seed: 'replay', events: true });
    flyTo(sim, sim.state.run.contract.claim.node);
    if (claimAboard(sim)) dealWith(sim, claimAboard(sim).n, () => 'quick');
    return sim;
  };
  const a = play();
  const b = play();
  assert.equal(hashState(a.snapshot()), hashState(b.snapshot()));
  const copy = contractSim(SALVAGE, { seed: 'replay', events: true });
  copy.restore(a.snapshot());
  assert.deepEqual(copy.state.run.contract, a.state.run.contract);
  assert.deepEqual(checkInvariants(copy), []);
});
