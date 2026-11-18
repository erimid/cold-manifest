// Staffing matters (F.7, D-240 to D-245): hunger and meals, what tiredness and
// hunger cost a hand (slower, and fumbles), off-watch hands turning in on their
// own, and Margo spread thin over more stations than she can watch.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spotIn } from '../src/sim/crew.js';
import { TICK_RATE, checkInvariants, createSim } from '../src/sim/sim.js';
import { SLIP, slipChance, slipping, stride } from '../src/sim/slips.js';
import { MARGO, MARGO_RATING, POSTS, crewRating, margoLoad, rating } from '../src/sim/stations.js';
import { BACK_BELOW, HUNGER, fed, hungryWord, onWatch, worn } from '../src/sim/watches.js';
import { regardOf } from '../src/sim/memory.js';
import { CATALOG, CREW, SHIP, newCrewedSim } from './helpers.js';

const seconds = (sim, s) => {
  for (let i = 0; i < Math.round(s * TICK_RATE); i++) sim.step();
};
const go = (sim, ...commands) => {
  for (const command of commands) sim.enqueue(command);
  sim.step();
};
function place(sim, id, room) {
  const member = sim.state.crew[id];
  const at = spotIn(sim.layout.room(room), member.index);
  Object.assign(member, { room, x: at.x, y: at.y, px: at.x, py: at.y, path: [], goal: null, task: 'idle' });
  return member;
}
const watchSim = (seed, watches = 2, extra = {}) => createSim({ seed, ship: SHIP, crew: CREW, watches, ...CATALOG, ...extra });

test('hunger climbs while a hand is up, and the watch below eats before it turns in', () => {
  const sim = watchSim('meal');
  for (const member of Object.values(sim.state.crew)) member.hunger = 0.6;
  const meals = [];
  sim.events.on('crew.eating', (event) => meals.push(event.crew));
  seconds(sim, 30);
  const below = Object.values(sim.state.crew).filter((member) => !onWatch(sim, member));
  const up = Object.values(sim.state.crew).filter((member) => onWatch(sim, member));
  for (const member of below) {
    assert.equal(member.room, 'quarters', `${member.id} went below`);
    assert.ok(meals.includes(member.id), `${member.id} sat down to eat`);
  }
  // A meal takes about a ship half-hour: then they sleep, fed.
  seconds(sim, 30);
  for (const member of below) {
    assert.ok(member.hunger < HUNGER.from && !member.eating && member.asleep, `${member.id} ate and turned in`);
  }
  for (const member of up) assert.ok(member.hunger > 0.6, `${member.id}, on watch, is hungrier`);
  assert.deepEqual(checkInvariants(sim), []);
});

test('a hungry hand is slower; a tired and hungry one slower still', () => {
  const sim = newCrewedSim('worn');
  const ilse = sim.state.crew.ilse;
  const fresh = crewRating(ilse, 'piloting');
  ilse.hunger = 1;
  assert.equal(fed(ilse), HUNGER.floor);
  assert.equal(hungryWord(ilse), 'Starving');
  assert.ok(near(crewRating(ilse, 'piloting'), fresh * HUNGER.floor));
  ilse.fatigue = 1;
  assert.ok(crewRating(ilse, 'piloting') < fresh * 0.5, 'tired and starving, a pilot is worth less than half');
  assert.ok(stride(ilse) < 0.8, 'and walks slower');
  ilse.hunger = 0;
  ilse.fatigue = 0;
  assert.equal(worn(ilse), 1);
  assert.equal(stride(ilse), 1);
  assert.equal(slipChance(ilse), 0, 'a fresh, fed hand never slips');
});

test('a worn hand on a station fumbles it now and then, and the station does nothing while they do', () => {
  const sim = watchSim('fumble', 1);
  go(sim, { type: 'roster.muster' });
  seconds(sim, 20);
  const ilse = sim.state.crew.ilse;
  assert.equal(rating(sim, 'helm') > MARGO_RATING, true, 'a fresh pilot beats Margo');
  const slips = [];
  sim.events.on('crew.slipped', (event) => slips.push(event));
  ilse.fatigue = 1;
  ilse.hunger = 1;
  let dark = 0;
  for (let i = 0; i < 300 * TICK_RATE; i++) {
    ilse.fatigue = 1;
    ilse.hunger = 1;
    sim.step();
    if (slipping(ilse)) {
      dark += 1;
      assert.equal(rating(sim, 'helm'), 0, 'the helm does not answer while the pilot fumbles it');
    }
  }
  const mine = slips.filter((event) => event.crew === 'ilse');
  assert.ok(mine.length >= 2, `${mine.length} fumbles in five minutes dead on her feet`);
  assert.ok(mine.every((event) => event.station === 'helm' && event.why === 'tired and hungry'));
  assert.ok(dark >= mine.length * SLIP.seconds * TICK_RATE - TICK_RATE);
  assert.deepEqual(checkInvariants(sim), []);
});

test('a fumbled repair loses some of its progress', () => {
  const sim = watchSim('setback', 1);
  sim.state.systems.sensors.damage = 1;
  const dace = place(sim, 'dace', 'sensors');
  dace.post = null;
  dace.fatigue = 1;
  dace.hunger = 1;
  let setback = false;
  sim.events.on('crew.slipped', (event) => {
    if (event.crew === 'dace' && event.job === 'repair') setback = true;
  });
  for (let i = 0; i < 400 * TICK_RATE && !setback && sim.state.systems.sensors.damage > 0; i++) {
    const before = sim.state.systems.sensors.repair ?? 0;
    dace.fatigue = 1;
    dace.hunger = 1;
    sim.step();
    if (setback) assert.ok((sim.state.systems.sensors.repair ?? 0) <= Math.max(0, before - SLIP.setback) + 1e-9, 'the bar lost ground');
  }
  assert.ok(setback, 'a dead-tired engineer fumbled the repair');
});

test('all hands keeps everyone at their posts and nobody eats; starving sours them on the captain', () => {
  const sim = watchSim('starve', 1);
  go(sim, { type: 'roster.muster' });
  for (const member of Object.values(sim.state.crew)) member.hunger = 0.85;
  const starving = [];
  sim.events.on('crew.starving', (event) => starving.push(event.crew));
  seconds(sim, 120);
  assert.ok(starving.length >= 4, `${starving.join()} went hungry at their posts`);
  for (const id of starving) {
    const member = sim.state.crew[id];
    assert.ok(member.memories.some((entry) => entry.type === 'hunger'), `${id} remembers going hungry`);
    assert.ok(regardOf(member) < 0, `${id} thinks less of the captain for it`);
  }
  // Sent to the mess, a hungry hand on watch eats.
  go(sim, { type: 'crew.move', crew: 'vesna', room: 'quarters' });
  seconds(sim, 60);
  assert.ok(sim.state.crew.vesna.hunger < HUNGER.from, 'Vesna ate');
  assert.equal(sim.state.crew.vesna.starving, false);
});

test('a hand off watch who is left standing about goes back below on their own', () => {
  const sim = watchSim('back-below');
  seconds(sim, 40);
  const sleeper = Object.values(sim.state.crew).find((member) => member.asleep);
  go(sim, { type: 'crew.move', crew: sleeper.id, room: 'aft_corridor' });
  seconds(sim, 15);
  assert.equal(sleeper.room, 'aft_corridor', 'the order stands while they are there');
  seconds(sim, BACK_BELOW + 30);
  assert.equal(sleeper.room, 'quarters');
  assert.ok(sleeper.asleep || sleeper.eating, `${sleeper.id} turned in`);
});

test('Margo spread thin: the more she holds past her attention, the worse she runs all of it', () => {
  const run = (handed) => {
    const sim = createSim({ seed: 'thin', ship: SHIP, ...CATALOG, margo: 'own' });
    for (const id of ['shields', 'medbay', 'weapons']) go(sim, { type: 'station.stand', station: id, down: false });
    for (const id of handed) go(sim, { type: 'station.cover', station: id, cover: 'crew' });
    seconds(sim, 1);
    return { held: margoLoad(sim).held, air: rating(sim, 'life_support') };
  };
  const all = run([]);
  const few = run(POSTS.filter((id) => !['life_support', 'helm', 'sensors', 'reactor'].includes(id)));
  assert.ok(all.held > MARGO.attention && few.held <= MARGO.attention, `${all.held} and ${few.held}`);
  assert.equal(few.air, MARGO_RATING, 'with no more than she can watch, the air is run by the book');
  assert.ok(near(all.air, MARGO_RATING * (1 - MARGO.spread * (all.held - MARGO.attention))), `${all.air}`);
});

test('the needs are deterministic and survive a snapshot', () => {
  const a = watchSim('same', 1);
  const b = watchSim('same', 1);
  for (const sim of [a, b]) {
    go(sim, { type: 'roster.muster' });
    for (const member of Object.values(sim.state.crew)) Object.assign(member, { fatigue: 0.95, hunger: 0.9 });
  }
  seconds(a, 120);
  seconds(b, 120);
  assert.deepEqual(a.snapshot(), b.snapshot());
});

function near(a, b, eps = 1e-9) {
  return Math.abs(a - b) < eps;
}
