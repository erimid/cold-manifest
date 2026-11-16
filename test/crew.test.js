import assert from 'node:assert/strict';
import { test } from 'node:test';

import { WALKABLE, describeTask, findRoute } from '../src/sim/crew.js';
import { TICK_RATE, checkInvariants } from '../src/sim/sim.js';
import { newCrewedSim, newSim, putCrew } from './helpers.js';

const seconds = (sim, s) => {
  for (let i = 0; i < Math.round(s * TICK_RATE); i++) {
    sim.step();
    const problems = checkInvariants(sim);
    if (problems.length) assert.fail(`tick ${sim.state.tick}: ${problems.join('; ')}`);
  }
};
const give = (sim, ...commands) => {
  for (const command of commands) sim.enqueue(command);
  sim.step();
};
const listen = (sim, type) => {
  const heard = [];
  sim.events.on(type, (e) => heard.push(e));
  return heard;
};
const doors = (route) => route.map((step) => step.door);

test('a run starts with six crew, one for each role, standing in the rooms the ship names', () => {
  const sim = newCrewedSim();
  const crew = Object.values(sim.state.crew);
  assert.deepEqual(
    crew.map((c) => [c.name, c.role, c.room]),
    [
      ['Ilse', 'pilot', 'bridge'],
      ['Dace', 'engineer', 'reactor'],
      ['Okoro', 'medic', 'quarters'],
      ['Pruitt', 'gunner', 'weapons'],
      ['Halloran', 'security', 'shields'],
      ['Vesna', 'quartermaster', 'hold'],
    ],
  );
  for (const c of crew) assert.deepEqual([c.health, c.suit, c.alive, c.task, c.path.length], [1, false, true, 'idle', 0]);
  assert.deepEqual(checkInvariants(sim), []);
});

test('routes follow the door graph and respect locked and jammed doors', () => {
  const sim = newSim();
  assert.deepEqual(findRoute(sim, 'cargo', 'cargo'), []);
  assert.deepEqual(doors(findRoute(sim, 'reactor', 'cargo')), ['d_engines_reactor', 'd_engines_cargo']);
  assert.deepEqual(doors(findRoute(sim, 'bridge', 'weapons')), ['d_bridge', 'd_weapons']);

  // Lock the direct way from the reactor: the route bends round, down the deck lifts through the corridor.
  give(sim, { type: 'door.set', door: 'd_engines_reactor', state: 'locked' });
  assert.deepEqual(doors(findRoute(sim, 'reactor', 'cargo')), ['d_reactor', 'd_cargo']);
  give(sim, { type: 'debug.door', door: 'd_reactor', jammed: true });
  assert.equal(findRoute(sim, 'reactor', 'cargo'), null, 'locked one way, jammed shut the other');
  assert.match(sim.whyNot({ type: 'crew.move', crew: 'nobody', room: 'cargo' }), /no crew member/);

  // A door jammed open is still a way through; an airlock never is.
  give(sim, { type: 'debug.door', door: 'd_reactor', jammed: false });
  give(sim, { type: 'door.set', door: 'd_reactor', state: 'open' });
  seconds(sim, 1);
  give(sim, { type: 'debug.door', door: 'd_reactor', jammed: true });
  assert.ok(sim.state.doors.d_reactor.openness >= WALKABLE);
  assert.deepEqual(doors(findRoute(sim, 'reactor', 'cargo')), ['d_reactor', 'd_cargo']);
});

test('a move order walks someone there, opening doors and shutting them behind', () => {
  const sim = newCrewedSim();
  const arrived = listen(sim, 'crew.arrived');
  const doorEvents = listen(sim, 'door.changed');
  give(sim, { type: 'crew.move', crew: 'ilse', room: 'weapons' });
  const ilse = sim.state.crew.ilse;
  assert.equal(ilse.goal, 'weapons');
  assert.equal(describeTask(sim, ilse), 'Walking to Weapons');
  seconds(sim, 12);
  assert.equal(ilse.room, 'weapons');
  assert.equal(ilse.task, 'idle');
  assert.deepEqual(arrived.map((e) => [e.crew, e.room]), [['ilse', 'weapons']]);
  assert.deepEqual(doorEvents.map((e) => [e.door, e.to, e.by]), [
    ['d_bridge', 'open', 'ilse'],
    ['d_bridge', 'closed', 'ilse'],
    ['d_weapons', 'open', 'ilse'],
    ['d_weapons', 'closed', 'ilse'],
  ]);
  const room = sim.layout.room('weapons');
  assert.ok(ilse.x > room.x && ilse.x < room.x + room.w && ilse.y > room.y && ilse.y < room.y + room.h);
});

test('a door the player left open is left open', () => {
  const sim = newCrewedSim();
  give(sim, { type: 'door.set', door: 'd_bridge', state: 'open' });
  seconds(sim, 1);
  give(sim, { type: 'crew.move', crew: 'ilse', room: 'fore_corridor' });
  seconds(sim, 5);
  assert.equal(sim.state.crew.ilse.room, 'fore_corridor');
  assert.equal(sim.state.doors.d_bridge.state, 'open');
});

test('orders given while paused start on resume', () => {
  const sim = newCrewedSim();
  const before = { ...sim.state.crew.dace };
  sim.enqueue({ type: 'crew.move', crew: 'dace', room: 'cargo' });
  sim.enqueue({ type: 'crew.suit', crew: 'dace', on: true });
  // Paused means the clock simply does not call step: nothing has happened yet.
  assert.deepEqual({ ...sim.state.crew.dace }, before);
  sim.step();
  assert.equal(sim.state.crew.dace.goal, 'cargo');
  assert.equal(sim.state.crew.dace.suit, true);
});

test('move orders are refused when there is no way, and for the dead and the gone', () => {
  const sim = newCrewedSim();
  give(sim, { type: 'door.set', door: 'd_brig', state: 'locked' });
  assert.match(sim.whyNot({ type: 'crew.move', crew: 'ilse', room: 'brig' }), /no way through/);
  give(sim, { type: 'room.jettison', room: 'sensors' });
  assert.match(sim.whyNot({ type: 'crew.move', crew: 'ilse', room: 'sensors' }), /gone/);
  assert.match(sim.whyNot({ type: 'crew.move', crew: 'ilse', room: 'attic' }), /no room/);
  sim.state.crew.okoro.alive = false;
  assert.match(sim.whyNot({ type: 'crew.move', crew: 'okoro', room: 'bridge' }), /Okoro is dead/);
  assert.match(sim.whyNot({ type: 'crew.suit', crew: 'okoro', on: true }), /dead/);
});

test('a door locked in their face: they go round, or stop and say so', () => {
  const sim = newCrewedSim();
  const blocked = listen(sim, 'crew.blocked');
  sim.state.crew.dace.engineer = false; // or she would simply take a crawlway
  // Dace leaves the reactor for the cargo hold by the engine room; lock that way once she is moving.
  give(sim, { type: 'crew.move', crew: 'dace', room: 'cargo' }, { type: 'door.set', door: 'd_engines_reactor', state: 'locked' });
  seconds(sim, 15);
  assert.equal(sim.state.crew.dace.room, 'cargo', 'she went round by the corridor');
  assert.equal(blocked.length, 0);

  // Now seal her in and send her out: the order is refused, and one already under way is abandoned.
  give(sim, { type: 'crew.move', crew: 'dace', room: 'bridge' }, { type: 'door.set', door: 'd_cargo', state: 'locked' }, { type: 'door.set', door: 'd_engines_cargo', state: 'locked' }, { type: 'door.set', door: 'd_hold', state: 'locked' });
  seconds(sim, 5);
  const dace = sim.state.crew.dace;
  assert.equal(dace.room, 'cargo');
  assert.deepEqual([dace.goal, dace.path.length, dace.task], [null, 0, 'idle']);
  assert.deepEqual(blocked.map((e) => [e.crew, e.reason]), [['dace', 'door']]);
});

test('with door control dark, crew still get through by hand, slowly', () => {
  const quick = newCrewedSim();
  const slow = newCrewedSim();
  give(slow, { type: 'power.add', system: 'doors', delta: -1 });
  for (const sim of [quick, slow]) give(sim, { type: 'crew.move', crew: 'ilse', room: 'weapons' });
  let quickAt = 0;
  let slowAt = 0;
  for (let i = 0; i < 30 * TICK_RATE && !slowAt; i++) {
    quick.step();
    slow.step();
    if (!quickAt && quick.state.crew.ilse.room === 'weapons' && !quick.state.crew.ilse.path.length) quickAt = quick.state.tick;
    if (slow.state.crew.ilse.room === 'weapons' && !slow.state.crew.ilse.path.length) slowAt = slow.state.tick;
  }
  assert.ok(quickAt > 0 && slowAt > quickAt + TICK_RATE, `powered ${quickAt} ticks, by hand ${slowAt}`);
});

test('a suit slows the walk', () => {
  const light = newCrewedSim();
  const heavy = newCrewedSim();
  give(heavy, { type: 'crew.suit', crew: 'okoro', on: true });
  for (const sim of [light, heavy]) give(sim, { type: 'crew.move', crew: 'okoro', room: 'engines' });
  const arrivedAt = (sim) => {
    for (let i = 0; i < 60 * TICK_RATE; i++) {
      sim.step();
      if (sim.state.crew.okoro.room === 'engines' && !sim.state.crew.okoro.path.length) return sim.state.tick;
    }
    return Infinity;
  };
  const quick = arrivedAt(light);
  const slow = arrivedAt(heavy);
  assert.ok(Number.isFinite(slow) && slow > quick + 2 * TICK_RATE, `unsuited ${quick} ticks, suited ${slow}`);
});

test('the lifts are quick while door control has power, and cranked slowly by hand without it', () => {
  const sim = newSim();
  // Bridge to the main hold: by the lift, two decks down.
  assert.deepEqual(doors(findRoute(sim, 'bridge', 'hold')), ['d_lift_bridge', 'd_lift_hold']);
  const timeTo = (dark) => {
    const s = newCrewedSim();
    if (dark) give(s, { type: 'power.add', system: 'doors', delta: -s.state.systems.doors.power });
    give(s, { type: 'crew.move', crew: 'ilse', room: 'hold' });
    let cranked = false;
    for (let i = 0; i < 90 * TICK_RATE; i++) {
      s.step();
      if (/Cranking the lift/.test(describeTask(s, s.state.crew.ilse))) cranked = true;
      if (s.state.crew.ilse.room === 'hold' && !s.state.crew.ilse.path.length) return { tick: s.state.tick, cranked };
    }
    return { tick: Infinity, cranked };
  };
  const lit = timeTo(false);
  const dark = timeTo(true);
  assert.ok(Number.isFinite(lit.tick) && Number.isFinite(dark.tick), `lit ${lit.tick}, dark ${dark.tick}`);
  assert.ok(dark.tick > lit.tick + 2 * TICK_RATE, `the dark way round is slower: lit ${lit.tick}, dark ${dark.tick}`);
  assert.deepEqual([lit.cranked, dark.cranked], [false, true], 'only a dark lift is cranked by hand');
});

test('engineers take the service crawlways; nobody else can', () => {
  const sim = newSim();
  const engineer = { engineer: true };
  // Cargo to the brig: up and down the deck lifts on foot. With door control dark the
  // lifts are cranked by hand, and an engineer goes through the wall instead.
  assert.deepEqual(doors(findRoute(sim, 'cargo', 'brig', engineer)), ['d_cargo', 'd_brig']);
  give(sim, { type: 'power.add', system: 'doors', delta: -sim.state.systems.doors.power });
  assert.ok(doors(findRoute(sim, 'cargo', 'brig')).every(Boolean), 'nobody else can crawl');
  assert.deepEqual(findRoute(sim, 'cargo', 'brig', engineer).map((s) => s.crawlway ?? s.door), ['c_cargo_brig']);
  // The creature's ducts are never theirs.
  assert.ok(!(findRoute(sim, 'brig', 'hold', engineer) ?? []).some((s) => s.crawlway === 'c_brig_hold'));

  // Dace is the engineer: seal the cargo hold's doors and she crawls out anyway.
  const crewed = newCrewedSim();
  const dace = crewed.state.crew.dace;
  assert.equal(dace.engineer, true);
  give(crewed, { type: 'crew.move', crew: 'dace', room: 'cargo' });
  seconds(crewed, 15);
  assert.equal(dace.room, 'cargo');
  for (const door of ['d_cargo', 'd_engines_cargo', 'd_hold']) give(crewed, { type: 'door.set', door, state: 'locked' });
  assert.equal(crewed.whyNot({ type: 'crew.move', crew: 'dace', room: 'brig' }), null);
  give(crewed, { type: 'crew.move', crew: 'dace', room: 'brig' });
  let crawled = false;
  for (let i = 0; i < 20 * TICK_RATE && dace.room !== 'brig'; i++) {
    crewed.step();
    if (dace.task === 'crawling') crawled = true;
  }
  assert.ok(crawled, 'she went by the crawlway');
  assert.equal(describeTask(crewed, { ...dace, task: 'crawling' }), 'In a service crawlway');
  seconds(crewed, 3);
  assert.equal(dace.room, 'brig');
  assert.deepEqual(checkInvariants(crewed), []);
});

test('you can fight a fire and patch a breach with three crew', () => {
  const sim = newCrewedSim();
  const out = listen(sim, 'fire.out');
  const sealed = listen(sim, 'breach.sealed');
  give(sim, { type: 'debug.room', room: 'shields', set: { fire: 0.6 } }, { type: 'debug.room', room: 'cargo', set: { breach: 0.5 } });
  give(
    sim,
    { type: 'crew.move', crew: 'ilse', room: 'shields' },
    { type: 'crew.move', crew: 'okoro', room: 'shields' },
    { type: 'crew.suit', crew: 'dace', on: true },
    { type: 'crew.move', crew: 'dace', room: 'cargo' },
  );
  seconds(sim, 45);
  assert.equal(sim.state.rooms.shields.fire, 0);
  assert.equal(sim.state.rooms.cargo.breach, 0);
  const shieldsOut = out.filter((e) => e.room === 'shields');
  // It may flare up again from the corridor while they work; each time, one of them puts it out.
  assert.ok(shieldsOut.length >= 1);
  for (const e of shieldsOut) assert.ok(['ilse', 'okoro'].includes(e.by));
  assert.deepEqual(sealed.map((e) => [e.room, e.by]), [['cargo', 'dace']]);
  const { ilse, okoro, dace } = sim.state.crew;
  assert.ok(ilse.alive && okoro.alive && dace.alive);
  assert.ok(ilse.health < 1 && okoro.health < 1, 'the fire team got singed');
  assert.equal(dace.health, 1, 'the suit kept Dace breathing in the thin air');
});

test('two put a fire out faster than one', () => {
  const time = (team) => {
    const sim = newSim();
    for (const id of team) putCrew(sim, id, 'brig');
    give(sim, { type: 'debug.room', room: 'brig', set: { fire: 0.5 } });
    while (sim.state.rooms.brig.fire > 0 && sim.state.tick < 2000) sim.step();
    return sim.state.tick;
  };
  const one = time(['a']);
  const two = time(['a', 'b']);
  assert.ok(two < one * 0.65 && one < 2000, `one took ${one} ticks, two took ${two}`);
});

test('patching a big breach in a small room needs a suit', () => {
  const patch = (suit) => {
    const sim = newSim();
    const member = putCrew(sim, 'm', 'brig', { suit });
    give(sim, { type: 'debug.room', room: 'brig', set: { breach: 1 } });
    seconds(sim, 40);
    return { member, breach: sim.state.rooms.brig.breach };
  };
  const bare = patch(false);
  const suited = patch(true);
  assert.equal(bare.member.alive, false, 'the air was gone long before the patch was on');
  assert.ok(bare.breach > 0);
  assert.equal(suited.member.health, 1);
  assert.equal(suited.breach, 0);
});

test('crew repair the system in their room, one bar at a time, slower in the dark', () => {
  const lit = newSim();
  const dark = newSim();
  give(dark, { type: 'room.lights', room: 'weapons', on: false });
  for (const sim of [lit, dark]) {
    putCrew(sim, 'fixer', 'weapons');
    give(sim, { type: 'debug.system', system: 'weapons', damage: 2 });
  }
  const repaired = listen(lit, 'system.repaired');
  assert.equal(describeTask(lit, lit.state.crew.fixer), 'Repairing weapons');
  seconds(lit, 9);
  seconds(dark, 9);
  assert.equal(lit.state.systems.weapons.damage, 1);
  assert.equal(dark.state.systems.weapons.damage, 2);
  seconds(lit, 9);
  seconds(dark, 9);
  assert.equal(lit.state.systems.weapons.damage, 0);
  assert.equal(dark.state.systems.weapons.damage, 1);
  assert.deepEqual(repaired.map((e) => [e.system, e.damage, e.by]), [['weapons', 1, 'fixer'], ['weapons', 0, 'fixer']]);
  assert.equal(lit.state.crew.fixer.task, 'idle');
});

test('fire comes before the breach, the breach before the repair, and a jammed door last', () => {
  const sim = newSim();
  const m = putCrew(sim, 'm', 'shields');
  give(sim, { type: 'debug.room', room: 'shields', set: { fire: 0.2, breach: 0.1 } }, { type: 'debug.system', system: 'shields', damage: 1 }, { type: 'debug.door', door: 'd_shields', jammed: true });
  const seen = [];
  for (let i = 0; i < 60 * TICK_RATE; i++) {
    sim.step();
    if (seen.at(-1) !== m.task) seen.push(m.task);
  }
  assert.deepEqual(seen, ['extinguish', 'patch', 'repair', 'unjam', 'idle']);
  assert.equal(sim.state.doors.d_shields.state, 'closed');
  assert.ok(m.alive);
});

test('a powered medbay heals whoever is resting in it', () => {
  const sim = newSim();
  const hurt = putCrew(sim, 'hurt', 'medbay', { health: 0.4 });
  seconds(sim, 10);
  assert.equal(hurt.health, 0.4, 'the medbay starts unpowered');
  give(sim, { type: 'power.add', system: 'sensors', delta: -1 });
  give(sim, { type: 'power.add', system: 'medbay', delta: 1 });
  assert.equal(describeTask(sim, hurt), 'Being patched up');
  seconds(sim, 30);
  assert.equal(hurt.health, 1);
});

test('the dead stay where they fell and take no orders', () => {
  const sim = newCrewedSim();
  // The whole ship loses its air while Okoro is on his way to the bridge.
  give(sim, { type: 'crew.move', crew: 'okoro', room: 'bridge' }, { type: 'power.add', system: 'life_support', delta: -1 }, ...sim.layout.rooms.map((room) => ({ type: 'debug.room', room: room.id, set: { oxygen: 0 } })));
  seconds(sim, 9);
  const okoro = sim.state.crew.okoro;
  assert.equal(okoro.alive, false);
  assert.deepEqual([okoro.goal, okoro.path.length, describeTask(sim, okoro)], [null, 0, 'Dead']);
  const at = [okoro.x, okoro.y];
  seconds(sim, 5);
  assert.deepEqual([okoro.x, okoro.y], at);
});

test('crew state survives a snapshot mid-walk and replays exactly', () => {
  const a = newCrewedSim('walk');
  give(a, { type: 'crew.move', crew: 'ilse', room: 'engines' }, { type: 'crew.move', crew: 'dace', room: 'bridge' }, { type: 'debug.room', room: 'aft_corridor', set: { fire: 0.4 } });
  seconds(a, 3);
  const b = newCrewedSim('walk');
  b.restore(JSON.parse(JSON.stringify(a.snapshot())));
  seconds(a, 30);
  seconds(b, 30);
  assert.deepEqual(a.snapshot(), b.snapshot());
  assert.equal(a.state.crew.ilse.room, 'engines');
});
