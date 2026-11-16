import assert from 'node:assert/strict';
import { test } from 'node:test';
import { hashState } from '../src/engine/hash.js';
import { whyNotCross } from '../src/sim/boarding.js';
import { brace, enemyOf } from '../src/sim/combat.js';
import { JOB_SECONDS, cratesIn, pickHand, roundsInHold } from '../src/sim/hold.js';
import { validateLayout } from '../src/sim/ship.js';
import { TICK_RATE, checkInvariants } from '../src/sim/sim.js';
import { content, newCrewedSim, shipCopy } from './helpers.js';

const steps = (sim, n) => {
  for (let i = 0; i < n; i++) sim.step();
  return sim;
};
const seconds = (sim, s) => steps(sim, Math.round(s * TICK_RATE));
const SLUGS = content.require('weapons', 'slug-thrower');
const go = (sim, command) => {
  sim.enqueue(command);
  sim.step();
};
function collect(sim, type) {
  const seen = [];
  sim.events.on(type, (e) => seen.push(e));
  return seen;
}
/** Step until `done()` or `limit` seconds, checking the invariants every tick. Returns the seconds taken. */
function until(sim, done, limit = 120) {
  for (let i = 0; i < limit * TICK_RATE; i++) {
    if (done()) return i / TICK_RATE;
    sim.step();
    const problems = checkInvariants(sim);
    assert.deepEqual(problems, [], `tick ${sim.state.tick}`);
  }
  assert.fail(`not done in ${limit} seconds`);
}
const ammoCrate = (sim) => Object.values(sim.state.crates).find((crate) => crate.kind === 'ammo' && crate.room === 'cargo');
const sealedCrate = (sim) => Object.values(sim.state.crates).find((crate) => crate.sealed);

test('the Margin of Error starts with ordnance in the cargo hold and manifest crates in both holds', () => {
  const sim = newCrewedSim();
  const crates = Object.values(sim.state.crates);
  assert.equal(crates.filter((c) => c.kind === 'ammo').length, 4);
  assert.equal(roundsInHold(sim), 16);
  assert.ok(crates.filter((c) => c.kind === 'cargo').every((c) => c.sealed && c.contents), 'manifest crates are sealed, with something inside');
  assert.ok(cratesIn(sim, 'hold').length >= 4 && cratesIn(sim, 'cargo').length >= 4);
  assert.ok(crates.every((c) => c.by === null));
  assert.deepEqual(checkInvariants(sim), []);
});

test('a ship file that stows crates badly is caught', () => {
  const data = { ...shipCopy(), crates: [{ kind: 'ammo', room: 'nowhere' }, { kind: 'gold', room: 'hold' }, { kind: 'cargo', room: 'hold' }, { kind: 'salvage', room: 'hold', rounds: 3 }] };
  const problems = validateLayout(data);
  assert.ok(problems.some((p) => /no room "nowhere"/.test(p)), problems.join('\n'));
  assert.ok(problems.some((p) => /kind must be one of/.test(p)));
  assert.ok(problems.some((p) => /needs "contents"/.test(p)));
  assert.ok(problems.some((p) => /only an ammo crate holds rounds/.test(p)));
});

test('an ammo run: down to the hold, up to the guns, and the slug thrower is loaded', () => {
  const sim = newCrewedSim('ammo-run');
  sim.state.weapons[1].rounds = 0;
  const crate = ammoCrate(sim);
  const loaded = collect(sim, 'weapon.loaded');
  const dace = Object.values(sim.state.crew).find((m) => m.engineer);
  assert.match(sim.whyNot({ type: 'weapon.load', crew: dace.id, slot: 0 }), /needs no rounds/);
  go(sim, { type: 'weapon.load', crew: dace.id, slot: 1 });
  assert.equal(dace.job.kind, 'load');
  assert.equal(dace.job.crate, crate.id, 'the nearest crate of rounds');
  let crawledCarrying = false;
  const taken = until(sim, () => {
    if (dace.carry && dace.task === 'crawling') crawledCarrying = true;
    return loaded.length > 0;
  });
  assert.equal(crawledCarrying, false, 'nobody carries a crate through a crawlway');
  assert.ok(taken > 10, `it is a real trip across the ship: ${taken}s`);
  assert.equal(sim.state.weapons[1].rounds, SLUGS.ammo.magazine);
  assert.equal(crate.rounds, 4 - SLUGS.ammo.magazine, 'the rest stays in the crate');
  assert.equal(crate.room, 'weapons', 'set down by the guns for next time');
  assert.equal(dace.job, null);
  assert.equal(dace.carry, null);
  assert.match(sim.whyNot({ type: 'weapon.load', crew: dace.id, slot: 1 }), /fully loaded/);
  // Next time it is a short trip, and an emptied crate is broken down.
  sim.state.weapons[1].rounds = 0;
  go(sim, { type: 'weapon.load', crew: dace.id, slot: 1 });
  assert.equal(dace.job.crate, crate.id);
  until(sim, () => loaded.length > 1, 30);
  assert.equal(sim.state.weapons[1].rounds, 1);
  assert.equal(sim.state.crates[crate.id], undefined);
});

test('a sealed crate is opened where it stands, and an ordnance crate has nothing to open', () => {
  const sim = newCrewedSim('open');
  const crate = sealedCrate(sim);
  const opened = collect(sim, 'crate.opened');
  const who = pickHand(sim, crate.room);
  assert.ok(who);
  assert.notEqual(sim.state.crew[who].room, 'bridge', 'whoever is flying the ship is asked last');
  assert.match(sim.whyNot({ type: 'crate.open', crew: who, crate: ammoCrate(sim).id }), /stencilled/);
  go(sim, { type: 'crate.open', crew: who, crate: crate.id });
  until(sim, () => opened.length > 0);
  assert.equal(crate.sealed, false);
  assert.equal(opened[0].contents, crate.contents);
  assert.match(sim.whyNot({ type: 'crate.open', crew: who, crate: crate.id }), /already open/);
});

test('a crate can be carried to another room, and jettisoned through the nearest airlock', () => {
  const sim = newCrewedSim('move');
  const crate = sealedCrate(sim);
  const who = pickHand(sim, crate.room);
  go(sim, { type: 'crate.move', crew: who, crate: crate.id, room: 'quarters' });
  until(sim, () => crate.room === 'quarters');
  assert.equal(crate.by, null);
  const gone = collect(sim, 'crate.jettisoned');
  go(sim, { type: 'crate.jettison', crew: who, crate: crate.id });
  assert.equal(sim.state.crew[who].job.to, 'quarters', 'the dorsal hatch is right there');
  until(sim, () => gone.length > 0);
  assert.equal(sim.state.crates[crate.id], undefined);
  assert.equal(gone[0].label, crate.label);
});

test('any other order, or death, puts the crate down where they stand', () => {
  const sim = newCrewedSim('drop');
  const crate = ammoCrate(sim);
  const who = pickHand(sim, crate.room);
  const member = sim.state.crew[who];
  go(sim, { type: 'crate.move', crew: who, crate: crate.id, room: 'bridge' });
  until(sim, () => member.carry === crate.id);
  seconds(sim, 2);
  go(sim, { type: 'crew.move', crew: who, room: 'medbay' });
  assert.equal(member.carry, null);
  assert.equal(member.job, null);
  assert.equal(crate.room, member.room);
  // Again, and this time they die with it.
  go(sim, { type: 'crate.move', crew: who, crate: crate.id, room: 'bridge' });
  until(sim, () => member.carry === crate.id);
  member.health = 0.01;
  sim.state.rooms[member.room].oxygen = 0;
  until(sim, () => !member.alive && crate.by === null, 60);
  assert.equal(crate.room, member.room);
  assert.deepEqual(checkInvariants(sim), []);
});

test('a job that cannot go on is given up, and none runs past its limit', () => {
  const sim = newCrewedSim('stuck');
  const crate = sealedCrate(sim);
  const who = pickHand(sim, crate.room);
  const member = sim.state.crew[who];
  const blocked = collect(sim, 'crew.blocked');
  go(sim, { type: 'crate.move', crew: who, crate: crate.id, room: 'bridge' });
  member.job.since -= JOB_SECONDS * TICK_RATE; // pretend it has gone on for ever
  steps(sim, 2);
  assert.equal(member.job, null);
  assert.equal(blocked.at(-1).reason, 'slow');
  // Someone else's crate is theirs.
  const other = Object.values(sim.state.crew).find((m) => m.id !== who && m.room !== 'bridge') ?? Object.values(sim.state.crew).find((m) => m.id !== who);
  go(sim, { type: 'crate.move', crew: who, crate: crate.id, room: 'bridge' });
  until(sim, () => member.carry === crate.id);
  assert.match(sim.whyNot({ type: 'crate.open', crew: other.id, crate: crate.id }), /is carrying that/);
});

test('cutting a room loose takes its crates with it', () => {
  const sim = newCrewedSim('cut');
  const lost = collect(sim, 'crate.lost');
  const count = cratesIn(sim, 'hold').length;
  for (const exit of sim.layout.exits('hold')) if (!sim.layout.door(exit.door).airlock) sim.state.doors[exit.door].state = 'closed';
  seconds(sim, 1);
  go(sim, { type: 'room.jettison', room: 'hold' });
  seconds(sim, 0.1);
  assert.equal(lost.length, count);
  assert.equal(cratesIn(sim, 'hold').length, 0);
});

test('their captain sends someone for rounds when a heavy gun runs dry', () => {
  const sim = newCrewedSim('their-ammo');
  go(sim, { type: 'debug.fight', enemy: 'salvager-skiff' });
  const enemy = enemyOf(sim);
  const loaded = collect(sim, 'enemy.weapon.loaded');
  enemy.state.weapons[1].rounds = 0;
  until(sim, () => loaded.length > 0, 28); // inside the hail: nobody boards or fires
  assert.equal(enemy.state.weapons[1].rounds, 3);
  assert.equal(roundsInHold(enemy), 3);
});

test('a charged capacitor keeps the docking clamp off; a brace spends it and opens the way', () => {
  const sim = newCrewedSim('clamp');
  go(sim, { type: 'debug.fight', enemy: 'salvager-skiff' });
  go(sim, { type: 'fight.engage' });
  const enemy = enemyOf(sim);
  enemy.state.shield.charge = 1;
  const ours = Object.values(sim.state.crew)[1];
  assert.match(whyNotCross(sim, enemy, ours), /capacitor/);
  brace(enemy);
  assert.match(whyNotCross(sim, enemy, ours), /capacitor/, 'nor through a brace');
  seconds(sim, 3);
  assert.equal(whyNotCross(sim, enemy, ours), null, 'spent, it leaves them open until it charges again');
});

test('a surrender of cargo comes aboard as salvage crates at the airlock by the hold', () => {
  const sim = newCrewedSim('salvage');
  go(sim, { type: 'debug.fight', enemy: 'salvager-skiff' });
  go(sim, { type: 'debug.combat', action: 'surrender' });
  sim.state.fight.offer = { kind: 'cargo', name: 'Crate of machine parts', qty: 2, expires: sim.state.tick + 200 };
  const before = Object.keys(sim.state.crates).length;
  go(sim, { type: 'fight.accept' });
  const added = Object.values(sim.state.crates).slice(before);
  assert.equal(added.length, 2);
  assert.ok(added.every((c) => c.kind === 'salvage' && c.label === 'Crate of machine parts' && ['cargo', 'hold'].includes(c.room)));
});

test('a save in the middle of an ammo run loads and plays out the same', () => {
  const play = (sim) => {
    sim.state.weapons[1].rounds = 0;
    sim.enqueue({ type: 'weapon.load', crew: pickHand(sim, 'cargo'), slot: 1 });
    return seconds(sim, 9);
  };
  const sim = play(newCrewedSim('save-ammo'));
  assert.ok(Object.values(sim.state.crew).some((m) => m.job), 'someone is on the run');
  const saved = JSON.parse(JSON.stringify(sim.snapshot()));
  seconds(sim, 40);
  const loaded = newCrewedSim('save-ammo');
  loaded.restore(saved);
  seconds(loaded, 40);
  assert.equal(hashState(loaded.snapshot()), hashState(sim.snapshot()));
  assert.equal(sim.state.weapons[1].rounds, SLUGS.ammo.magazine);
});
