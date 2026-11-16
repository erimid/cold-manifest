// S2.4: boarding. Crossing between ships, hand-to-hand fights in rooms, and what happens to boarders when a fight ends.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BOARD_SECONDS, airlockRooms, nearestAirlock } from '../src/sim/boarding.js';
import { enemyOf, findCrew, hasPilot, ourCrew } from '../src/sim/combat.js';
import { MELEE_SECONDS, SABOTAGE_SECONDS, newCrewMember } from '../src/sim/crew.js';
import { TICK_RATE, checkInvariants, createSim } from '../src/sim/sim.js';
import { validateTactics } from '../src/sim/tactics.js';
import { CATALOG, SHIP, newCrewedSim } from './helpers.js';

const steps = (sim, n) => {
  for (let i = 0; i < n; i++) {
    sim.step();
    const problems = checkInvariants(sim);
    if (problems.length) throw new Error(`tick ${sim.state.tick}: ${problems.join('; ')}`);
  }
  return sim;
};
const seconds = (sim, s) => steps(sim, Math.round(s * TICK_RATE));
const until = (sim, done, limit = 120) => {
  for (let i = 0; i < limit * TICK_RATE && !done(); i++) steps(sim, 1);
  assert.ok(done(), `not done within ${limit} s`);
};
const go = (sim, command) => {
  sim.enqueue(command);
  sim.step();
};
function collect(sim, type) {
  const seen = [];
  sim.events.on(type, (event) => seen.push(event));
  return seen;
}
const SKIFF = 'salvager-skiff';

/** A fight under way with the skiff, its shields knocked out. */
function battle(seed = 'boarding') {
  const sim = newCrewedSim(seed);
  go(sim, { type: 'debug.fight', enemy: SKIFF });
  go(sim, { type: 'fight.engage' });
  const enemy = enemyOf(sim);
  dropShields(enemy);
  return { sim, enemy };
}
/** Knock a ship's shields out for good: no bars, no layers. */
function dropShields(ship) {
  const shields = ship.state.systems.shields;
  shields.damage = shields.level;
  shields.power = 0;
  ship.state.shield.charge = 0;
}
/** Stand one of the enemy's crew in a room of ours, as if they had boarded. */
function boarder(sim, id, room) {
  const member = newCrewMember(sim.layout, { id, name: id }, room, 5, 'enemy');
  sim.state.crew[id] = member;
  return member;
}

test('an enemy ship may say how many it sends to board, and only a crewed one can', () => {
  assert.deepEqual(validateTactics({ archetype: 'raider', board: { party: 2 } }, { crewed: true }), []);
  assert.ok(validateTactics({ archetype: 'raider', board: { party: 0 } }, { crewed: true }).some((p) => p.includes('party')));
  assert.ok(validateTactics({ archetype: 'drone', board: { party: 1 } }, { crewed: false }).some((p) => p.includes('needs crew')));
});

test('every ship has an airlock to board from, and crew find the nearest one on foot', () => {
  const sim = newCrewedSim();
  assert.deepEqual(airlockRooms(sim).sort(), ['cargo', 'engines', 'quarters', 'weapons']);
  assert.equal(nearestAirlock(sim, 'bridge'), 'quarters');
  assert.equal(nearestAirlock(sim, 'reactor'), 'engines');
});

test('nobody boards while they talk, or through shields that are up', () => {
  const sim = newCrewedSim();
  go(sim, { type: 'debug.fight', enemy: SKIFF });
  const move = { type: 'crew.move', crew: 'okoro', room: 'bridge', ship: 'them' };
  assert.match(sim.whyNot(move), /talking/);
  go(sim, { type: 'fight.engage' });
  seconds(sim, 1);
  assert.match(sim.whyNot(move), /shields are up/);
  dropShields(enemyOf(sim));
  assert.equal(sim.whyNot(move), null);
  assert.match(sim.whyNot({ ...move, room: 'galley' }), /no room/);
  assert.match(sim.whyNot({ ...move, ship: 'elsewhere' }), /ship must be/);
});

test('a boarder walks to an airlock, crosses, and comes out aboard them', () => {
  const { sim, enemy } = battle();
  const boarding = collect(sim, 'crew.boarding');
  const boarded = collect(sim, 'crew.boarded');
  go(sim, { type: 'crew.move', crew: 'okoro', room: 'bridge', ship: 'them' });
  assert.equal(boarding.length, 1);
  const okoro = sim.state.crew.okoro;
  assert.deepEqual(okoro.board, { room: 'bridge' }); // they stand by the dorsal hatch already
  until(sim, () => okoro.task === 'crossing', 10);
  const entered = sim.state.tick;
  until(sim, () => enemy.state.crew.okoro, BOARD_SECONDS + 1);
  assert.equal(sim.state.tick - entered, BOARD_SECONDS * TICK_RATE);
  assert.equal(sim.state.crew.okoro, undefined, 'they are no longer aboard us');
  assert.equal(boarded.length, 1);
  assert.equal(boarded[0].onto, 'enemy');
  assert.equal(findCrew(sim, 'okoro').ship, enemy);
  assert.deepEqual(ourCrew(sim).map(({ member }) => member.id), ['ilse', 'dace', 'okoro']);
  until(sim, () => okoro.room === 'bridge' || !okoro.alive, 20);
});

test('aboard them, our orders still reach them, and they can always come home', () => {
  const { sim, enemy } = battle();
  go(sim, { type: 'crew.move', crew: 'okoro', room: 'shields', ship: 'them' });
  until(sim, () => enemy.state.crew.okoro, 20);
  enemy.state.shield.charge = 0;
  enemy.state.systems.shields.damage = 0; // shields back up: no way in, but the way home is open
  enemy.state.shield.charge = 2;
  assert.equal(sim.whyNot({ type: 'crew.suit', crew: 'okoro', on: true }), null);
  assert.equal(sim.whyNot({ type: 'crew.move', crew: 'okoro', room: 'reactor', ship: 'them' }), null, 'moving about aboard them');
  go(sim, { type: 'crew.move', crew: 'okoro', room: 'medbay', ship: 'us' });
  until(sim, () => sim.state.crew.okoro?.room === 'medbay', 30);
  assert.equal(enemyOf(sim).state.crew.okoro, undefined);
});

test('crossing is refused while in the tube, and nobody can order their crew', () => {
  const { sim } = battle();
  go(sim, { type: 'crew.move', crew: 'okoro', room: 'bridge', ship: 'them' });
  until(sim, () => sim.state.crew.okoro.task === 'crossing', 10);
  assert.match(sim.whyNot({ type: 'crew.move', crew: 'okoro', room: 'bridge' }), /docking tube/);
  boarder(sim, 'raider', 'cargo');
  assert.match(sim.whyNot({ type: 'crew.move', crew: 'raider', room: 'bridge' }), /not one of ours/);
  assert.match(sim.whyNot({ type: 'crew.suit', crew: 'vask', on: true }), /not one of ours/);
});

test('hand to hand: fighters in a room wear each other down, two on one twice as fast', () => {
  const sim = newCrewedSim('melee');
  go(sim, { type: 'debug.fight', enemy: SKIFF });
  go(sim, { type: 'fight.engage' });
  const raider = boarder(sim, 'raider', 'quarters'); // okoro's room
  seconds(sim, 3);
  const okoro = sim.state.crew.okoro;
  assert.equal(okoro.task, 'fighting');
  const lost = 1 - okoro.health;
  // A healthy fighter alone takes 1 / MELEE_SECONDS a second, a little less as they tire.
  assert.ok(lost > (3 / MELEE_SECONDS) * 0.8 && lost <= 3 / MELEE_SECONDS + 1e-9, `okoro lost ${lost}`);
  assert.ok(Math.abs(1 - raider.health - lost) < 0.02, 'an even fight is even');

  // Two on one.
  const two = newCrewedSim('melee');
  go(two, { type: 'debug.fight', enemy: SKIFF });
  go(two, { type: 'fight.engage' });
  const lone = boarder(two, 'raider', 'quarters');
  two.state.crew.ilse.room = 'quarters'; // an extra pair of hands, there already
  Object.assign(two.state.crew.ilse, { x: okoro.x + 0.5, y: okoro.y });
  seconds(two, 3);
  assert.ok(Math.abs(1 - lone.health - 2 * lost) < 0.03, `two on one: ${1 - lone.health} against ${lost}`);
  // Each of ours took half as much: the raider can only hit one at a time.
  assert.ok(1 - two.state.crew.ilse.health + (1 - two.state.crew.okoro.health) < lost + 0.02);
});

test('a fight to the end is death by melee, mourned only if they were ours', () => {
  const sim = newCrewedSim('melee-end');
  go(sim, { type: 'debug.fight', enemy: SKIFF });
  go(sim, { type: 'fight.engage' });
  const ours = collect(sim, 'crew.died');
  const theirs = collect(sim, 'enemy.crew.died');
  const raider = boarder(sim, 'raider', 'quarters');
  raider.health = 0.4;
  until(sim, () => !raider.alive, MELEE_SECONDS);
  assert.equal(ours.length, 0);
  assert.equal(theirs.length, 1);
  assert.equal(theirs[0].cause, 'melee');
  assert.equal(theirs[0].aboard, 'player');
});

test('a boarder left alone wrecks the system they stand in and fixes nothing; the medbay heals only its own', () => {
  const sim = newCrewedSim('wreck');
  go(sim, { type: 'debug.fight', enemy: SKIFF });
  go(sim, { type: 'fight.engage' });
  const raider = boarder(sim, 'raider', 'medbay');
  raider.health = 0.6;
  sim.state.rooms.medbay.fire = 0.2;
  const before = sim.state.systems.medbay.damage;
  seconds(sim, SABOTAGE_SECONDS * 1.6);
  assert.ok(sim.state.systems.medbay.damage > before, 'medbay wrecked');
  assert.ok(raider.health <= 0.6, 'not healed by our medbay');
  assert.ok(sim.state.rooms.medbay.fire > 0, 'not putting out our fire');
});

test('a boarder at the helm flies nothing', () => {
  const sim = newCrewedSim('helm');
  go(sim, { type: 'debug.fight', enemy: SKIFF });
  go(sim, { type: 'crew.move', crew: 'ilse', room: 'medbay' });
  until(sim, () => sim.state.crew.ilse.room === 'medbay', 30);
  assert.equal(hasPilot(sim), false);
  boarder(sim, 'raider', 'bridge');
  assert.equal(hasPilot(sim), false);
});

test('the skiff sends a party of two when our shields are down, and keeps its pilot', () => {
  const sim = newCrewedSim('they-board');
  go(sim, { type: 'debug.fight', enemy: SKIFF });
  go(sim, { type: 'fight.engage' });
  const boarded = collect(sim, 'enemy.crew.boarded');
  dropShields(sim);
  until(sim, () => boarded.length === 2, 40);
  const enemy = enemyOf(sim);
  assert.equal(Object.values(sim.state.crew).filter((m) => m.owner === 'enemy').length, 2);
  assert.equal(Object.values(enemy.state.crew).length, 1);
  assert.ok(hasPilot(enemy), 'someone stayed at the helm');
  assert.ok(boarded.every((event) => event.onto === 'player'));
});

test('their boarders go home when hurt', () => {
  const sim = newCrewedSim('retreat');
  go(sim, { type: 'debug.fight', enemy: SKIFF });
  go(sim, { type: 'debug.combat', action: 'boardUs' });
  steps(sim, 2);
  const raiders = Object.values(sim.state.crew).filter((m) => m.owner === 'enemy');
  assert.equal(raiders.length, 2);
  raiders[0].health = 0.2;
  until(sim, () => enemyOf(sim).state.crew[raiders[0].id] || !raiders[0].alive, 40);
});

test('our boarders win the fight by killing everyone aboard them', () => {
  const { sim, enemy } = battle('crew-dead');
  for (const id of ['vask', 'moll', 'teague']) enemy.state.crew[id].health = 0.05;
  for (const id of ['ilse', 'okoro']) go(sim, { type: 'crew.move', crew: id, room: 'bridge', ship: 'them' });
  until(sim, () => sim.state.fight.over, 90);
  assert.equal(sim.state.fight.over.outcome, 'crew-dead');
  // And they come home with the fight decided.
  assert.ok(sim.state.crew.ilse && sim.state.crew.okoro);
  assert.equal(ourCrew(sim).filter(({ ship }) => ship !== sim).length, 0);
});

test('ours go down with a ship that is destroyed, and come home from one that is not', () => {
  const run = (end) => {
    const { sim, enemy } = battle(`end-${end}`);
    go(sim, { type: 'crew.move', crew: 'okoro', room: 'weapons', ship: 'them' });
    until(sim, () => enemy.state.crew.okoro, 20);
    const died = collect(sim, 'crew.died');
    if (end === 'destroyed') {
      go(sim, { type: 'debug.combat', action: 'cripple' });
      go(sim, { type: 'debug.hit', at: 'them', room: 'engines', weapon: 'pulse-laser', force: true });
    } else go(sim, { type: 'debug.combat', action: 'stalemate' });
    steps(sim, 2);
    assert.equal(sim.state.fight.over.outcome, end);
    return { sim, died };
  };
  const destroyed = run('destroyed');
  assert.equal(destroyed.sim.state.crew.okoro.alive, false);
  assert.equal(destroyed.died[0].cause, 'wreck');
  const parted = run('stalemate');
  assert.equal(parted.sim.state.crew.okoro.alive, true);
  assert.equal(parted.died.length, 0);
});

test('their boarders are captured if their ship cannot take them back, and go home if it can', () => {
  const run = (action, extra) => {
    const sim = newCrewedSim(`captured-${action}`);
    go(sim, { type: 'debug.fight', enemy: SKIFF });
    go(sim, { type: 'debug.combat', action: 'boardUs' });
    steps(sim, 2);
    const captured = collect(sim, 'crew.captured');
    go(sim, { type: 'debug.combat', action });
    if (extra) extra(sim);
    steps(sim, 2);
    return { sim, captured, enemy: enemyOf(sim) };
  };
  const killed = run('cripple', (sim) => go(sim, { type: 'debug.hit', at: 'them', room: 'engines', weapon: 'pulse-laser', force: true }));
  assert.equal(killed.sim.state.fight.over.outcome, 'destroyed');
  assert.equal(killed.captured.length, 2);
  assert.equal(Object.values(killed.sim.state.crew).filter((m) => m.owner === 'enemy').length, 0);
  const gaveUp = run('surrender', (sim) => go(sim, { type: 'fight.accept' }));
  assert.equal(gaveUp.sim.state.fight.over.outcome, 'surrendered');
  assert.equal(gaveUp.captured.length, 0);
  assert.equal(Object.values(gaveUp.enemy.state.crew).length, 3, 'all three back aboard their own ship');
});

test('we cannot jump away with one of ours still aboard them', () => {
  const { sim, enemy } = battle('jump');
  go(sim, { type: 'crew.move', crew: 'okoro', room: 'weapons', ship: 'them' });
  until(sim, () => enemy.state.crew.okoro, 20);
  go(sim, { type: 'debug.combat', action: 'chargeJump' });
  assert.match(sim.whyNot({ type: 'ship.jump' }), /Okoro is still aboard them/i);
});

test('their crew never share an id with ours', () => {
  const crew = [{ id: 'vask', name: 'Our Vask' }, { id: 'ilse', name: 'Ilse' }];
  const sim = createSim({ seed: 'ids', ship: SHIP, crew, ...CATALOG });
  go(sim, { type: 'debug.fight', enemy: SKIFF });
  const theirs = Object.keys(enemyOf(sim).state.crew);
  assert.deepEqual(theirs, ['foe-vask', 'moll', 'teague']);
  assert.equal(sim.state.crew.vask.name, 'Our Vask');
});

test('a boarding fight replays exactly from a snapshot taken mid-crossing', () => {
  const { sim } = battle('replay');
  dropShields(sim);
  go(sim, { type: 'crew.move', crew: 'okoro', room: 'bridge', ship: 'them' });
  until(sim, () => sim.state.crew.okoro?.task === 'crossing', 10);
  const snap = sim.snapshot();
  seconds(sim, 40);
  const after = JSON.stringify(sim.state);
  sim.restore(snap);
  seconds(sim, 40);
  assert.equal(JSON.stringify(sim.state), after);
});
