// Guns as deterrents (Stage H, H.3; D-172 to D-178): the slug thrower is laid on a contact, never a room;
// point defence takes down drones and boarding pods; a bulwark calls a toll, a gunnery drone calls in a
// cutter, and the six old enemies are kinds of encounter. Nothing here aims at a room of another ship.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { GUN, gunChance, gunSlot } from '../src/sim/combat.js';
import { ENDINGS, findContact, whyNoPay } from '../src/sim/encounters.js';
import { TICK_RATE, checkInvariants, createSim } from '../src/sim/sim.js';
import { CATALOG, CREW, SHIP, content } from './helpers.js';

const ENCOUNTERS = content.all('encounters');
const def = (id) => ENCOUNTERS.find((item) => item.id === id);
const newSim = (seed = 'guns', extra = {}) => createSim({ seed, ship: SHIP, crew: CREW, ...CATALOG, encounters: ENCOUNTERS, ...extra });

function go(sim, command) {
  sim.enqueue(command);
  sim.step();
}
function seconds(sim, n) {
  for (let i = 0; i < n * TICK_RATE; i++) {
    sim.step();
    assert.deepEqual(checkInvariants(sim), [], `tick ${sim.state.tick}`);
  }
}
/** Lamps off for the bars, then point defence and the gun (two bars), and the shields (one). */
function armUp(sim, { gun = true, shields = true } = {}) {
  go(sim, { type: 'lights.all', on: false });
  go(sim, { type: 'power.add', system: 'weapons', delta: 1 });
  if (gun) go(sim, { type: 'power.add', system: 'weapons', delta: 1 });
  if (shields) go(sim, { type: 'power.add', system: 'shields', delta: 1 });
}
const spawn = (sim, encounter, options = {}) => go(sim, { type: 'debug.contact', encounter, ...options });
const first = (sim) => sim.state.scope.contacts[0];
/** Run until the encounter ends (or `limit` seconds), calling `each` every tick. */
function play(sim, limit = 600, each = null) {
  let ended = null;
  const off = sim.events.on('encounter.ended', (event) => (ended ??= event));
  const start = sim.state.tick;
  while (!ended && sim.state.tick - start < limit * TICK_RATE) {
    each?.(sim);
    sim.step();
    assert.deepEqual(checkInvariants(sim), [], `tick ${sim.state.tick}`);
  }
  off?.();
  return ended;
}
/** A sim with a contact on the scope, made out, closing from `range`. */
function closing(encounter, range = 25, seed = encounter, extra = {}) {
  const sim = newSim(seed, extra);
  seconds(sim, 1);
  spawn(sim, encounter, { range, bearing: 90, state: 'closing' });
  seconds(sim, 3); // the return firms up
  return sim;
}

test('no order aims at a room of another ship: the gun takes a contact, and the duel\'s orders are gone', () => {
  const sim = closing('raider-skiff');
  const commands = Object.keys(sim.commands ?? {});
  for (const gone of ['weapon.target', 'fight.talk', 'fight.bribe', 'fight.engage', 'fight.accept', 'fight.refuse', 'fight.dismiss', 'ship.jump', 'debug.fight', 'debug.combat']) {
    assert.ok(!commands.includes(gone), `${gone} should be gone`);
    assert.throws(() => sim.enqueue({ type: gone, slot: 0, room: 'reactor' }), /unknown|no such|command/i, gone);
  }
  assert.match(sim.whyNot({ type: 'crew.move', crew: CREW[0].id, room: 'reactor', ship: 'them' }), /no other ship/, 'crew cannot be sent to another ship');
  assert.match(sim.whyNot({ type: 'gun.target', contact: 99 }), /no contact "99"/);
  assert.equal(sim.whyNot({ type: 'gun.target', contact: first(sim).id }), null);
  go(sim, { type: 'gun.target', contact: first(sim).id });
  assert.equal(sim.state.weapons[gunSlot(sim)].target, first(sim).id, 'what the gun is laid on is a contact id');
  assert.equal(typeof sim.state.weapons[gunSlot(sim)].target, 'number');
});

test('the gun drives off a raider: hits and near misses scare it until its nerve goes', () => {
  const outcomes = [];
  for (const seed of ['deter-1', 'deter-2', 'deter-3', 'deter-4', 'deter-5', 'deter-6']) {
    const sim = closing('raider-skiff', 28, seed);
    armUp(sim);
    go(sim, { type: 'debug.gun', charge: true }); // charged and waiting when it comes into reach
    const heard = [];
    for (const type of ['weapon.fired', 'contact.struck', 'contact.deterred']) sim.events.on(type, () => heard.push(type));
    go(sim, { type: 'gun.target', contact: first(sim).id });
    const ended = play(sim, 120);
    outcomes.push(ended?.outcome);
    if (ended?.outcome !== 'deterred') continue;
    assert.ok(heard.filter((type) => type === 'weapon.fired').length >= 1);
    assert.ok(heard.filter((type) => type === 'contact.struck').length >= 2, 'it takes more than one round');
    assert.equal(heard.at(-1), 'contact.deterred');
    sim.step();
    assert.equal(sim.state.weapons[gunSlot(sim)].target, null, 'the gun comes off a contact that has broken off');
  }
  assert.ok(outcomes.filter((outcome) => outcome === 'deterred').length >= 3, `three slugs and a raider's nerve: usually enough (${outcomes.join(', ')})`);
  assert.ok(outcomes.every((outcome) => outcome === 'deterred' || outcome === 'docked'), outcomes.join(', '));
  assert.equal(ENDINGS.deterred, 'Driven off by the gun');
});

test('firing gives us away: the contact is certain of us, comes for us, and its faction marks it down', () => {
  const sim = newSim('flare');
  seconds(sim, 1);
  spawn(sim, 'patrol-cutter', { range: 25, bearing: 0, state: 'shadowing' });
  seconds(sim, 3);
  armUp(sim);
  const contact = first(sim);
  const faction = def('patrol-cutter').party.faction;
  const before = sim.state.reputation?.[faction] ?? 0;
  const flare = sim.state.flare;
  let fired = false;
  sim.events.on('weapon.fired', () => (fired = true));
  go(sim, { type: 'gun.target', contact: contact.id });
  while (!fired) sim.step();
  assert.equal(contact.aware, 1);
  assert.equal(contact.wary, true, 'and stops listening to hails');
  assert.equal(contact.state, 'closing');
  assert.ok(sim.state.flare > flare, 'a gun going off lights us up for everything out there');
  if (faction && sim.state.reputation) assert.equal(sim.state.reputation[faction], before + GUN.standing);
});

test('the gun holds fire out of reach, and hits less often from far off or on a poor return', () => {
  const sim = closing('scrap-hauler', 60, 'reach');
  armUp(sim);
  const contact = first(sim);
  go(sim, { type: 'gun.target', contact: contact.id });
  let fired = 0;
  sim.events.on('weapon.fired', () => (fired += 1));
  seconds(sim, 20);
  if (Math.hypot(contact.x, contact.y) > content.require('weapons', 'slug-thrower').range) assert.equal(fired, 0);
  assert.equal(gunChance(sim, { ...contact, x: 0, y: 100 }), 0, 'beyond its range it cannot hit at all');
  const near = gunChance(sim, { ...contact, x: 0, y: 5, track: { ...contact.track, q: 1 } });
  const far = gunChance(sim, { ...contact, x: 0, y: 25, track: { ...contact.track, q: 1 } });
  const blurry = gunChance(sim, { ...contact, x: 0, y: 5, track: { ...contact.track, q: 0.2 } });
  assert.ok(near > far && near > blurry, `${near} ${far} ${blurry}`);
});

test('a contact\'s gun answers ours: a patrol cutter holds fire until we run or shoot, and warns us first', () => {
  const sim = closing('patrol-cutter', 28, 'warn');
  const shots = [];
  sim.events.on('contact.fired', (event) => shots.push(event.warn));
  seconds(sim, 8);
  assert.deepEqual(shots, [], 'a patrol cutter does not fire on a ship that is not running and has not shot at it');
  armUp(sim);
  go(sim, { type: 'debug.gun', charge: true });
  go(sim, { type: 'gun.target', contact: first(sim).id });
  play(sim, 60, (s) => s.state.tick % 20 === 0 && s.state.weapons[gunSlot(s)].target !== null && s.state.weapons[gunSlot(s)].rounds < 1 && s.enqueue({ type: 'debug.gun', load: true }));
  assert.ok(shots.length >= 1, 'shot at, it fires back');
  assert.equal(shots[0], true, 'its first round is a warning across our bow');
});

test('point defence takes down drones before they reach the hull; without it they zap us', () => {
  const run = (pd) => {
    const sim = closing('drone-carrier', 18, 'drones');
    if (pd) armUp(sim, { gun: false, shields: false });
    const lost = { pd: 0, spent: 0 };
    sim.events.on('drone.lost', ({ cause }) => (lost[cause] = (lost[cause] ?? 0) + 1));
    const hull = sim.state.hull.points;
    const ended = play(sim, 400);
    return { ended, lost, hullLost: hull - sim.state.hull.points };
  };
  const bare = run(false);
  const guarded = run(true);
  assert.equal(bare.ended?.outcome, 'swarmed', 'it spends every drone it carries and goes');
  assert.equal(bare.lost.pd, 0);
  assert.ok(bare.hullLost > 0, 'unguarded, its drones hole the hull');
  assert.ok(guarded.lost.pd > 0, 'point defence downs some');
  assert.ok(guarded.hullLost < bare.hullLost, `${guarded.hullLost} < ${bare.hullLost}`);
});

test('a brace burns out a drone that zaps into it', () => {
  const sim = closing('drone-carrier', 18, 'drone-brace');
  armUp(sim, { gun: false });
  go(sim, { type: 'power.add', system: 'weapons', delta: -1 }); // no point defence: only the brace
  const lost = [];
  sim.events.on('drone.lost', ({ cause }) => lost.push(cause));
  play(sim, 400, (s) => {
    if (s.state.shots.some((shot) => shot.drone !== null) && !s.whyNot({ type: 'ship.brace' })) s.enqueue({ type: 'ship.brace' });
  });
  assert.ok(lost.includes('brace'), lost.join(','));
});

test('a grapple tender puts its party across in pods; point defence downs some, and the party is what landed', () => {
  let sawShort = false;
  for (const seed of ['pods-1', 'pods-2', 'pods-3', 'pods-4', 'pods-5', 'pods-6']) {
    const sim = closing('bounty-tender', 20, seed);
    armUp(sim, { gun: false, shields: false });
    let launched = 0;
    let downed = 0;
    sim.events.on('pods.launched', ({ pods }) => (launched += pods));
    sim.events.on('pod.downed', () => (downed += 1));
    const ended = play(sim, 300);
    assert.ok(launched > 0, `${seed}: it sends pods`);
    if (downed === launched) assert.equal(ended.outcome, 'deterred', 'every pod down: its party is gone, and so is it');
    else {
      assert.equal(ended.outcome, 'docked');
      assert.equal(sim.state.boarding.size, launched - downed, 'the party at the lock is the pods that landed');
      if (downed > 0) sawShort = true;
    }
  }
  assert.ok(sawShort, 'on some seeds point defence thins the party');
});

test('a bulwark calls a toll inside its zone: pay it and it lets us by; sit in its zone past the grace and its gun clears', () => {
  const paying = closing('bulwark', 20, 'toll');
  const contact = first(paying);
  assert.equal(contact.tolled, true, 'inside its zone, it calls a toll');
  paying.state.money = def('bulwark').toll.cost - 1;
  assert.match(whyNoPay(paying, contact.id), /./, 'not enough money');
  paying.state.money = 200;
  assert.equal(whyNoPay(paying, contact.id), null);
  go(paying, { type: 'contact.pay', contact: contact.id });
  assert.equal(paying.state.money, 200 - def('bulwark').toll.cost);
  assert.equal(paying.state.scope.record.at(-1)?.outcome, 'paid');

  const holding = closing('bulwark', 20, 'toll');
  const fired = [];
  holding.events.on('contact.fired', (event) => fired.push(event.tick));
  seconds(holding, def('bulwark').toll.grace + 25);
  assert.ok(fired.length > 0, 'unpaid, its gun clears');
  assert.ok(fired[0] >= first(holding).tollEnds, 'but not before its grace is up');
  assert.match(holding.whyNot({ type: 'contact.pay', contact: 99 }), /no contact/);
});

test('a gunnery drone that finishes its scan calls a patrol cutter in, closing', () => {
  const sim = closing('gunnery-drone', 10, 'scan');
  const ended = play(sim, 120);
  assert.equal(ended?.outcome, 'scanned');
  const caller = sim.state.scope.contacts.find((contact) => contact.encounter === def('gunnery-drone').scan.calls);
  assert.ok(caller, 'the ship it called is on its way');
  assert.equal(caller.state, 'closing');
  // A drone has nobody to lie to.
  const other = closing('gunnery-drone', 10, 'scan-hail');
  seconds(other, 5);
  if (first(other).track.known) assert.match(other.whyNot({ type: 'contact.hail', contact: first(other).id, bluff: 'manifest' }), /nobody aboard/);
});

test('the six enemies of Stage 2 are kinds of encounter now', () => {
  const wants = Object.fromEntries(ENCOUNTERS.map((item) => [item.id, item.wants]));
  assert.deepEqual(
    { patrol: wants['patrol-cutter'], raider: wants['raider-skiff'], tender: wants['bounty-tender'], bulwark: wants.bulwark, carrier: wants['drone-carrier'], drone: wants['gunnery-drone'] },
    { patrol: 'inspect', raider: 'cargo', tender: 'crew', bulwark: 'toll', carrier: 'hull', drone: 'scan' },
  );
  assert.ok(def('bounty-tender').pods, 'the tender takes crew by pod');
  assert.ok(def('drone-carrier').drones, 'the carrier swarms the hull');
});

test('every kind of contact, against a bot that does nothing or fights it with the gun, ends in a named way', () => {
  for (const item of ENCOUNTERS) {
    for (const answer of ['nothing', 'gun']) {
      const sim = closing(item.id, 30, `end-${item.id}-${answer}`);
      if (answer === 'gun') armUp(sim);
      const ended = play(sim, 900, (s) => {
        if (answer !== 'gun' || s.state.tick % 10) return;
        const contact = s.state.scope.contacts.find((c) => c.state !== 'lost' && c.track.shown);
        if (contact && s.state.weapons[gunSlot(s)].target !== contact.id && !s.whyNot({ type: 'gun.target', contact: contact.id })) s.enqueue({ type: 'gun.target', contact: contact.id });
        if (s.state.shots.some((shot) => shot.at === 'us') && !s.whyNot({ type: 'ship.brace' })) s.enqueue({ type: 'ship.brace' });
      });
      assert.ok(ended, `${item.id} (${answer}) never ended`);
      assert.ok(ENDINGS[ended.outcome], `${item.id} ended as "${ended.outcome}"`);
    }
  }
});

test('a fight with the gun replays from its seed and survives a snapshot', () => {
  const run = (seed) => {
    const sim = closing('raider-skiff', 22, seed);
    armUp(sim);
    go(sim, { type: 'gun.target', contact: first(sim).id });
    seconds(sim, 6);
    return sim;
  };
  const a = run('replay');
  const saved = JSON.parse(JSON.stringify(a.snapshot()));
  seconds(a, 60);
  const b = run('replay');
  b.restore(saved);
  seconds(b, 60);
  assert.deepEqual(b.snapshot(), a.snapshot());
  assert.equal(findContact(a, 1)?.id ?? null, findContact(b, 1)?.id ?? null);
});
