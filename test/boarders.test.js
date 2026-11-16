// Boarded (Stage H, H.2; D-165 to D-171): a docked contact's party walks our decks with a goal, and each
// goal can be foiled, bought off at the lock, or lost. A party never gets stuck, and the S3.4 checkpoint
// inspection runs as a boarding.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyEffects } from '../src/narrative/effects.js';
import { BOARD, GOALS, OUTCOMES, REASONS, bribeChance, validateParty } from '../src/sim/boarders.js';
import { FIND, SEARCH, compartmentsFree, hidingSpot, searchSeconds } from '../src/sim/agents.js';
import { FORCE_SECONDS, STUN_FLOOR } from '../src/sim/crew.js';
import { validateEncounter } from '../src/sim/encounters.js';
import { validateLayout } from '../src/sim/ship.js';
import { TICK_RATE, checkInvariants, createSim } from '../src/sim/sim.js';
import { CATALOG, CREW, SHIP, content, offPort, shipCopy } from './helpers.js';

const ENCOUNTERS = content.all('encounters');
/** The kinds of ship that come aboard (H.2); the rest keep their distance (H.3). */
const BOARDERS = ENCOUNTERS.filter((item) => item.party);
const SECTOR = content.require('sectors', 'the-reach');

const newSim = (seed = 'boarded', extra = {}) => createSim({ seed, ship: SHIP, crew: CREW, ...CATALOG, encounters: ENCOUNTERS, ...extra });

function go(sim, command) {
  assert.equal(sim.whyNot(command), null, `${command.type}: ${sim.whyNot(command)}`);
  sim.enqueue(command);
  sim.step();
}
function seconds(sim, n) {
  for (let i = 0; i < n * TICK_RATE; i++) {
    sim.step();
    if (i % TICK_RATE === 0) assert.deepEqual(checkInvariants(sim), [], `tick ${sim.state.tick}`);
  }
}
/** Step until `done` or `limit` seconds, checking the invariants every second. */
function until(sim, done, limit = 120) {
  for (let i = 0; i < limit * TICK_RATE; i++) {
    if (done(sim)) return true;
    sim.step();
    if (i % TICK_RATE === 0) assert.deepEqual(checkInvariants(sim), [], `tick ${sim.state.tick}`);
  }
  return done(sim);
}
/** Run the boarding on to its end (or `limit` seconds) and say how: the boarding.ended event, plus what was heard. */
function play(sim, limit = 700) {
  let ended = null;
  const heard = [];
  for (const type of ['boarding.aboard', 'boarding.leaving', 'boarding.hostile', 'cargo.seized', 'crate.taken', 'crew.taken', 'crew.found', 'crate.found', 'system.stripped', 'door.forced', 'enemy.crew.fled', 'crew.died']) sim.events.on(type, () => heard.push(type));
  sim.events.on('boarding.ended', (event) => (ended ??= event));
  until(sim, () => ended !== null, limit);
  return { ...ended, heard };
}
const board = (sim, encounter, extra = {}) => go(sim, { type: 'debug.boarding', encounter, ...extra });
/** Mark one of the hold's manifest crates as contraband and return it. */
function contraband(sim) {
  const crate = Object.values(sim.state.crates).find((item) => item.label.includes('7731-D'));
  crate.contraband = true;
  return crate;
}
/** Send someone to a room and wait until they are standing in it. */
function walk(sim, crew, room) {
  go(sim, { type: 'crew.move', crew, room });
  assert.ok(until(sim, (s) => s.state.crew[crew].room === room && !s.state.crew[crew].path.length, 60), `${crew} reaches ${room}`);
}
const party = (sim) => (sim.state.boarding?.party ?? []).map((id) => sim.state.crew[id]).filter(Boolean);

// ---------- content ----------

test('every ship that boards sends a party aboard, the rest send none, and the checker says what is wrong with a bad one', () => {
  assert.deepEqual(Object.keys(GOALS).sort(), ['cargo', 'crew', 'inspect', 'salvage']);
  for (const def of ENCOUNTERS.filter((item) => !GOALS[item.wants])) assert.equal(def.party, undefined, `${def.id} never docks (H.3)`);
  for (const def of BOARDERS) {
    assert.ok(def.party, `${def.id} has a party`);
    assert.deepEqual(validateParty(def.party, def.wants), [], def.id);
    assert.ok(def.party.bribe, `${def.id} can be bought off at the lock`);
  }
  const good = ENCOUNTERS.find((def) => def.wants === 'inspect').party;
  const bad = (change, wants = 'inspect') => validateParty({ ...good, ...change }, wants).join('; ');
  assert.match(bad({ size: 0 }), /party.size/);
  assert.match(bad({ rooms: undefined }), /party.rooms/);
  assert.match(bad({ take: undefined }, 'cargo'), /party.take/);
  assert.match(bad({ strip: ['teapot'] }, 'salvage'), /party.strip/);
  assert.match(bad({ bribe: { cost: -5, chance: 2 } }), /party.bribe/);
  assert.match(bad({ colour: 'red' }), /unknown key "colour"/);
  const { _file, party: _, ...partyless } = ENCOUNTERS[0];
  assert.match(validateEncounter({ ...partyless, alongside: { seconds: 5, hail: 'Hold.' } }).join('; '), /needs a party/);
  assert.match(validateEncounter({ ...ENCOUNTERS[0], party: { ...good, faction: 'pirates' } }, { factions: new Set(['receivers']) }).join('; '), /no faction "pirates"/);

  // The ship says where people and crates can hide.
  const ship = shipCopy();
  assert.ok(ship.rooms.some((room) => room.hide > 0) && ship.rooms.some((room) => room.compartment > 0));
  ship.rooms.find((room) => room.kind === 'lift').hide = 2;
  ship.rooms[0].compartment = 0;
  const problems = validateLayout(ship).join('; ');
  assert.match(problems, /nothing hides in a lift/);
  assert.match(problems, /"compartment" must be a whole number/);
});

// ---------- at the lock ----------

test('a party waits at the lock while the captain decides, then comes through; a party at the lock blocks the run into port', () => {
  const sim = newSim('lock', { sector: SECTOR, run: { pursuit: false } });
  offPort(sim); // off a port, ready for the run in, when they clamp on
  const demands = [];
  sim.events.on('boarding.demand', (event) => demands.push(event));
  board(sim, 'raider-skiff', { at: 'quarters' });
  assert.equal(sim.state.boarding.phase, 'demand');
  assert.equal(demands[0].room, 'quarters');
  assert.match(demands[0].text, /crates/);
  assert.equal(party(sim).length, 0, 'nobody aboard yet');
  go(sim, { type: 'debug.run', fix: true });
  assert.match(sim.whyNot({ type: 'route.jump' }), /clamped to our airlock/);
  seconds(sim, BOARD.demand);
  assert.equal(sim.state.boarding.phase, 'aboard');
  assert.equal(party(sim).length, 3);
  assert.ok(party(sim).every((member) => member.owner === 'enemy' && member.room === 'quarters'));
  assert.match(sim.whyNot({ type: 'boarding.bribe' }), /already aboard/);
});

test('admit opens the lock at once; the demand names the one a bounty is for', () => {
  const sim = newSim('admit');
  const demands = [];
  sim.events.on('boarding.demand', (event) => demands.push(event));
  board(sim, 'bounty-tender', { target: 'okoro' });
  // The warrant is drawn when the clamp goes on; the debug command then points it at Okoro.
  assert.equal(sim.state.boarding.target, 'okoro');
  go(sim, { type: 'boarding.admit' });
  seconds(sim, 1);
  assert.equal(sim.state.boarding.phase, 'aboard');
  assert.match(demands[0].text, /warrant is for/);
});

// ---------- inspection ----------

test('inspection lost: they go over the holds, find the contraband, seize it and write a fine', () => {
  const sim = newSim('inspect-lost');
  const crate = contraband(sim);
  const money = sim.state.money;
  board(sim, 'patrol-cutter', { aboard: true });
  const result = play(sim);
  assert.equal(result.outcome, 'lost');
  assert.equal(result.reason, 'seized');
  assert.equal(sim.state.crates[crate.id], undefined, 'the crate went with them');
  assert.equal(sim.state.money, money - ENCOUNTERS.find((def) => def.id === 'patrol-cutter').party.fine);
  assert.equal(sim.state.reputation.receivers, -2);
  assert.ok(!result.heard.includes('crew.died'), 'an inspection hurts nobody');
  assert.equal(sim.state.boarding, null);
  assert.equal(Object.values(sim.state.crew).filter((member) => member.party).length, 0, 'and nobody of theirs is left aboard');
});

test('inspection foiled: a crate stashed in the compartment is found far less often than one left in the hold', () => {
  let open = 0;
  let stashed = 0;
  for (let i = 0; i < 10; i++) {
    for (const stash of [false, true]) {
      const sim = newSim(`inspect-${i}`);
      const crate = contraband(sim);
      if (stash) {
        go(sim, { type: 'crate.stash', crew: 'dace', crate: crate.id });
        assert.ok(until(sim, () => crate.hidden, 60), 'stashed under the deck plates');
        assert.equal(crate.room, 'engines');
        assert.equal(compartmentsFree(sim, 'engines'), 0);
      }
      board(sim, 'patrol-cutter', { aboard: true });
      const result = play(sim);
      if (result.seized) stash ? (stashed += 1) : (open += 1);
      if (!result.seized) assert.deepEqual([result.outcome, result.reason], ['foiled', 'clean']);
    }
  }
  assert.equal(open, 10, 'contraband in the open is always found');
  assert.ok(stashed <= 4, `found in the compartment ${stashed} times in 10`);
});

test('inspection bought: a bribe at the lock usually sends them away, and when it does not they keep the money and come aboard', () => {
  const results = { ok: 0, no: 0 };
  for (let i = 0; i < 16; i++) {
    const sim = newSim(`bribe-${i}`);
    sim.state.money = 1000;
    contraband(sim);
    board(sim, 'patrol-cutter');
    const money = sim.state.money;
    const cost = ENCOUNTERS.find((def) => def.id === 'patrol-cutter').party.bribe.cost;
    assert.ok(bribeChance(sim) >= 0.75);
    let said = null;
    sim.events.on('boarding.bribed', (event) => (said = event));
    go(sim, { type: 'boarding.bribe' });
    assert.equal(sim.state.money, money - cost);
    if (said.ok) {
      results.ok += 1;
      assert.equal(sim.state.boarding, null);
      assert.equal(sim.state.boardings.record.at(-1).outcome, 'bought');
    } else {
      results.no += 1;
      seconds(sim, 1);
      assert.equal(sim.state.boarding.phase, 'aboard');
      assert.match(sim.whyNot({ type: 'boarding.bribe' }), /already aboard/);
    }
  }
  assert.ok(results.ok > results.no && results.no > 0, JSON.stringify(results));
});

test('turning on an inspection is a fight they did not come for, and it costs standing with them', () => {
  const sim = newSim('inspect-fight');
  board(sim, 'patrol-cutter', { aboard: true });
  assert.match(sim.whyNot({ type: 'boarding.fight' }) ?? '', /^$/);
  // Peaceful: someone of ours in the same room is not fought.
  walk(sim, 'halloran', sim.state.boarding.dock);
  seconds(sim, 2);
  assert.ok(party(sim).every((member) => member.task !== 'fighting'));
  go(sim, { type: 'boarding.fight' });
  assert.equal(sim.state.boarding.hostile, true);
  assert.equal(sim.state.reputation.receivers, -3);
  assert.match(sim.whyNot({ type: 'boarding.fight' }), /already a fight/);
});

// ---------- raid ----------

test('raid lost: they carry crates out through the lock', () => {
  const sim = newSim('raid-lost');
  const before = Object.keys(sim.state.crates).length;
  board(sim, 'raider-skiff', { aboard: true, at: 'cargo' });
  const result = play(sim);
  assert.equal(result.outcome, 'lost');
  assert.equal(result.reason, 'took');
  assert.equal(result.took, 2);
  assert.equal(Object.keys(sim.state.crates).length, before - 2);
  assert.ok(result.heard.filter((type) => type === 'crate.taken').length === 2);
});

test('raid foiled: vent the room they come through and, with no suits, they fall back to their own ship', () => {
  const sim = newSim('raid-vent');
  const before = Object.keys(sim.state.crates).length;
  board(sim, 'raider-skiff', { at: 'quarters' });
  walk(sim, 'okoro', 'medbay'); // the medic was in quarters
  go(sim, { type: 'door.set', door: 'd_medbay_quarters', state: 'closed' });
  go(sim, { type: 'room.vent', room: 'quarters', open: true });
  seconds(sim, 8);
  assert.ok(sim.state.rooms.quarters.oxygen < 0.3, 'the air is going');
  const result = play(sim);
  assert.equal(result.outcome, 'foiled');
  assert.equal(result.reason, 'driven');
  assert.equal(result.took, 0);
  assert.equal(Object.keys(sim.state.crates).length, before);
  assert.ok(result.heard.includes('enemy.crew.fled'));
});

test('raid: handing over what they ask for at the lock is a loss that keeps them off the decks', () => {
  const sim = newSim('raid-yield');
  const before = Object.keys(sim.state.crates).length;
  board(sim, 'raider-skiff');
  go(sim, { type: 'boarding.yield' });
  assert.equal(sim.state.boarding, null);
  assert.equal(Object.keys(sim.state.crates).length, before - 2);
  assert.deepEqual([sim.state.boardings.record.at(-1).outcome, sim.state.boardings.record.at(-1).reason], ['lost', 'yielded']);
  assert.match(newSim().whyNot({ type: 'boarding.yield' }), /nobody is docked/);
});

test('a locked door does not stop a party: they cut it, loudly, and it hangs open after', () => {
  const sim = newSim('force');
  board(sim, 'raider-skiff', { at: 'quarters', aboard: true });
  // Shut quarters off: the only ways out are the medbay door and the hatch to the fore corridor.
  go(sim, { type: 'door.set', door: 'd_quarters', state: 'locked' });
  go(sim, { type: 'door.set', door: 'd_medbay_quarters', state: 'locked' });
  const forced = [];
  sim.events.on('door.forced', (event) => forced.push(event.door));
  assert.ok(until(sim, () => forced.length > 0, FORCE_SECONDS.locked * 3), 'a door is forced');
  const door = sim.state.doors[forced[0]];
  assert.equal(door.state, 'jammed');
  assert.equal(door.openness, 1);
  assert.ok(sim.state.rooms.quarters.noise >= 0.5, 'and it was loud');
});

// ---------- bounty ----------

test('bounty lost: found alone, the one on the warrant is dragged off, and nobody is killed doing it', () => {
  const sim = newSim('bounty-lost');
  board(sim, 'bounty-tender', { at: 'quarters', aboard: true, target: 'okoro' });
  assert.equal(sim.state.crew.okoro.room, 'quarters');
  const result = play(sim);
  assert.equal(result.outcome, 'lost');
  assert.equal(result.reason, 'taken');
  assert.equal(sim.state.crew.okoro, undefined, 'Okoro is gone');
  assert.ok(result.heard.includes('crew.taken'));
  assert.ok(!result.heard.includes('crew.died'));
  for (const member of Object.values(sim.state.crew)) assert.ok(member.alive);
});

test('bounty foiled: an engineer hidden in a crawlway in a dark room is rarely found, and they give up', () => {
  const outcomes = {};
  for (let i = 0; i < 8; i++) {
    const sim = newSim(`hide-${i}`);
    board(sim, 'bounty-tender', { target: 'dace', at: 'quarters' });
    walk(sim, 'dace', 'life_support');
    go(sim, { type: 'room.lights', room: 'life_support', on: false });
    assert.equal(hidingSpot(sim, sim.state.crew.dace), 'crawlway');
    go(sim, { type: 'crew.hide', crew: 'dace', on: true });
    assert.equal(sim.state.crew.dace.hidden, 'crawlway');
    // Everyone else keeps out of the way in the medbay with the door shut.
    for (const id of ['ilse', 'okoro', 'pruitt', 'halloran', 'vesna']) go(sim, { type: 'crew.move', crew: id, room: 'medbay' });
    const result = play(sim);
    outcomes[result.outcome] = (outcomes[result.outcome] ?? 0) + 1;
  }
  assert.ok((outcomes.foiled ?? 0) >= 6, JSON.stringify(outcomes));
});

test('bounty foiled by force: the one they want, with four of ours around them, is not taken', () => {
  const sim = newSim('bounty-fight');
  board(sim, 'bounty-tender', { target: 'vesna', at: 'quarters' });
  for (const id of ['halloran', 'pruitt', 'ilse', 'dace']) go(sim, { type: 'crew.move', crew: id, room: sim.state.crew.vesna.room });
  assert.ok(until(sim, (s) => ['halloran', 'pruitt', 'ilse', 'dace'].every((id) => s.state.crew[id].room === s.state.crew.vesna.room && !s.state.crew[id].path.length), 60));
  const result = play(sim);
  assert.equal(result.outcome, 'foiled');
  assert.ok(sim.state.crew.vesna?.alive, 'Vesna is still aboard');
  // A stunner knocks people down and no further.
  for (const member of Object.values(sim.state.crew)) if (member.owner === 'player') assert.ok(member.alive && member.health >= STUN_FLOOR - 1e-9);
});

test('bounty: a hidden crew member does not fight and is not fought; found, they are pulled out', () => {
  const sim = newSim('found');
  go(sim, { type: 'crew.hide', crew: 'okoro', on: true });
  assert.equal(sim.state.crew.okoro.hidden, 'locker');
  assert.match(sim.whyNot({ type: 'crew.hide', crew: 'okoro', on: true }), /already hidden/);
  board(sim, 'bounty-tender', { at: 'quarters', aboard: true, target: 'okoro' });
  seconds(sim, 2);
  assert.ok(party(sim).every((member) => member.task !== 'fighting' && member.task !== 'grabbing'), 'they cannot see her');
  // Sooner or later a thorough search of a lit room turns her up.
  const found = until(sim, (s) => !s.state.crew.okoro || !s.state.crew.okoro.hidden, 200);
  assert.ok(found);
  go(sim, { type: 'crew.move', crew: 'pruitt', room: 'quarters' });
  assert.match(sim.whyNot({ type: 'crew.hide', crew: 'pruitt', on: true }), /has to stop somewhere first/);
});

// ---------- salvage ----------

test('salvage lost: they strip a system, which nobody aboard can mend, and a port can', () => {
  const sim = newSim('strip');
  board(sim, 'scrap-hauler', { at: 'quarters', aboard: true });
  const target = sim.state.boarding.strip;
  assert.equal(target, 'sensors');
  // Nobody in the way: the sensors room is empty at the start.
  const result = play(sim);
  assert.deepEqual([result.outcome, result.reason], ['lost', 'stripped']);
  const system = sim.state.systems[target];
  assert.equal(system.stripped, true);
  assert.equal(system.damage, system.level);
  walk(sim, 'dace', 'sensors');
  seconds(sim, 15);
  assert.equal(system.damage, system.level, 'no tape fixes that');
});

test('salvage foiled: crew standing in the room they came for are witnesses, the wreckers turn on them and are beaten off', () => {
  const sim = newSim('salvage-fight');
  board(sim, 'scrap-hauler', { at: 'quarters' });
  for (const id of ['halloran', 'pruitt', 'vesna']) walk(sim, id, 'sensors');
  const result = play(sim);
  assert.equal(result.outcome, 'foiled');
  assert.ok(result.heard.includes('boarding.hostile'));
  assert.ok(!sim.state.systems.sensors.stripped);
});

test('salvage bought: wreckers take a smaller payment to go and find a deader ship', () => {
  for (let i = 0; i < 6; i++) {
    const sim = newSim(`wreck-${i}`);
    board(sim, 'scrap-hauler');
    let said = null;
    sim.events.on('boarding.bribed', (event) => (said = event));
    go(sim, { type: 'boarding.bribe' });
    if (said.ok) {
      assert.equal(sim.state.boardings.record.at(-1).outcome, 'bought');
      return;
    }
  }
  assert.fail('no bribe took in six tries at 80%');
});

// ---------- our other answers ----------

test('deck lights, the vent and hiding say no when they should', () => {
  const sim = newSim('orders');
  go(sim, { type: 'deck.lights', deck: 'hold', on: false });
  for (const id of ['hold', 'cargo', 'lift']) assert.equal(sim.state.rooms[id].lightsOn, false, id);
  assert.equal(sim.state.rooms.reactor.lightsOn, true);
  assert.match(sim.whyNot({ type: 'deck.lights', deck: 'hold', on: false }), /already dark/);
  assert.match(sim.whyNot({ type: 'deck.lights', deck: 'bilge', on: false }), /no deck/);
  assert.match(sim.whyNot({ type: 'room.vent', room: 'lift', open: true }), /no vent/);
  go(sim, { type: 'station.stand', station: 'doors', down: true });
  assert.match(sim.whyNot({ type: 'room.vent', room: 'aft_corridor', open: true }), /door control/);
  // The reactor room has no lockers, and the gunner is no engineer.
  walk(sim, 'pruitt', 'reactor');
  assert.match(sim.whyNot({ type: 'crew.hide', crew: 'pruitt', on: true }), /nowhere to hide/);
  // The quarters have three lockers: a fourth person cannot hide there.
  for (const id of ['ilse', 'vesna', 'halloran', 'okoro']) walk(sim, id, 'quarters');
  for (const id of ['ilse', 'vesna', 'halloran']) go(sim, { type: 'crew.hide', crew: id, on: true });
  assert.match(sim.whyNot({ type: 'crew.hide', crew: 'okoro', on: true }), /every hiding place/);
  go(sim, { type: 'crew.hide', crew: 'ilse', on: false });
  assert.equal(sim.state.crew.ilse.hidden, null);
  // Sending someone hidden somewhere brings them out.
  go(sim, { type: 'crew.move', crew: 'vesna', room: 'medbay' });
  seconds(sim, 1);
  assert.equal(sim.state.crew.vesna.hidden, null);
});

test('a search takes longer in the dark and finds less there', () => {
  const sim = newSim('dark');
  const lit = searchSeconds(sim, 'quarters');
  assert.equal(lit, SEARCH.base + SEARCH.perTile * 15);
  go(sim, { type: 'room.lights', room: 'quarters', on: false });
  seconds(sim, 1);
  assert.ok(Math.abs(searchSeconds(sim, 'quarters') - lit * SEARCH.dark) < 1e-9);
  assert.ok(searchSeconds(sim, 'aft_corridor') < searchSeconds(sim, 'cargo'), 'a corridor is gone over quickly');
  assert.ok(FIND.crawlway < FIND.locker);
});

// ---------- the checkpoint inspection (S3.4) is a boarding ----------

test('standing by the lock at a checkpoint brings the cutter\'s party aboard', () => {
  const sim = newSim('checkpoint', { sector: SECTOR, run: { pursuit: false } });
  applyEffects([{ do: 'board', encounter: 'patrol-cutter' }], { sim, vars: {} });
  assert.equal(sim.state.boarding?.encounter, 'patrol-cutter');
  assert.equal(sim.state.boarding.wants, 'inspect');
  // Burning through brings the cutter onto the scope instead, closing.
  const other = newSim('run', { sector: SECTOR, run: { pursuit: false } });
  applyEffects([{ do: 'contact', encounter: 'patrol-cutter', range: 25 }], { sim: other, vars: {} });
  assert.equal(other.state.scope.contacts[0].state, 'closing');
  const inspection = content.all('events').find((event) => event.id === 'checkpoint.inspection');
  const effects = JSON.stringify(inspection.choices);
  assert.match(effects, /"do":"board"/);
  assert.doesNotMatch(effects, /contract.seize|"do":"fight"/, 'the event no longer seizes or fights by itself');
});

// ---------- never stuck ----------

test('every kind of party, with the captain doing anything at all, always leaves within its time', () => {
  const doors = SHIP.doors.filter((door) => door.b !== 'space').map((door) => door.id);
  const rooms = SHIP.rooms.map((room) => room.id);
  const ended = {};
  for (let i = 0; i < 12; i++) {
    for (const def of BOARDERS) {
      const sim = newSim(`stuck-${i}-${def.id}`);
      contraband(sim);
      const dice = sim.rng.stream('cosmetic');
      board(sim, def.id);
      const limit = BOARD.demand + def.party.stay + BOARD.leave + 2;
      let result = null;
      sim.events.on('boarding.ended', (event) => (result ??= event));
      for (let t = 0; t < limit * TICK_RATE && !result; t++) {
        if (t % (3 * TICK_RATE) === 0) {
          // Lock or open a door, vent or seal a room, hide or send someone, switch a deck: whatever is allowed.
          const alive = Object.values(sim.state.crew).filter((member) => member.owner === 'player' && member.alive);
          const crew = alive.length ? dice.pick(alive) : null;
          const tries = [
            { type: 'door.set', door: dice.pick(doors), state: dice.pick(['open', 'closed', 'locked']) },
            { type: 'room.vent', room: dice.pick(rooms), open: dice.chance(0.4) },
            crew && { type: 'crew.hide', crew: crew.id, on: dice.chance(0.7) },
            crew && { type: 'crew.move', crew: crew.id, room: dice.pick(rooms) },
            { type: 'deck.lights', deck: dice.pick(['upper', 'main', 'lower', 'hold']), on: dice.chance(0.5) },
            { type: 'debug.door', door: dice.pick(doors), jammed: true },
          ];
          for (const command of tries) if (command && !sim.whyNot(command)) sim.enqueue(command);
        }
        sim.step();
        if (t % TICK_RATE === 0) assert.deepEqual(checkInvariants(sim), [], `${def.id} seed ${i}, tick ${sim.state.tick}`);
      }
      assert.ok(result, `${def.id} seed ${i} was still aboard after ${limit}s (${sim.state.boarding?.phase})`);
      assert.ok(OUTCOMES[result.outcome] && REASONS[result.reason], JSON.stringify(result));
      assert.equal(Object.values(sim.state.crew).filter((member) => member.party).length, 0);
      ended[result.outcome] = (ended[result.outcome] ?? 0) + 1;
    }
  }
  assert.ok(ended.foiled > 0 && ended.lost > 0, JSON.stringify(ended));
});

test('a boarding replays exactly from the same seed and orders', () => {
  const runOnce = () => {
    const sim = newSim('replay');
    contraband(sim);
    board(sim, 'raider-skiff', { aboard: true });
    play(sim);
    return JSON.stringify(sim.snapshot());
  };
  assert.equal(runOnce(), runOnce());
});
