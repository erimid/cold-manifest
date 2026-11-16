// Stations and shifts (H.4, D-153, D-179 to D-186): a system works at its
// station's rating. That is the posted crew member's skill when they are on
// it, Margo's by-the-book figure when nobody is, and nothing when it is dark.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spotIn } from '../src/sim/crew.js';
import { fixOf, stepFix } from '../src/sim/combat.js';
import { OUTPUT } from '../src/sim/power.js';
import { COMMAND_TYPES, TICK_RATE, checkInvariants, createSim } from '../src/sim/sim.js';
import { signature } from '../src/sim/senses.js';
import { MARGO_RATING, STATIONS, STATION_IDS, bars, crewRating, operatorOf, rating, reactorLoad, running } from '../src/sim/stations.js';
import { WATCH, onWatch, tiredness } from '../src/sim/watches.js';
import { CATALOG, CREW, SHIP, newCrewedSim, newSim } from './helpers.js';

const seconds = (sim, s) => {
  for (let i = 0; i < Math.round(s * TICK_RATE); i++) sim.step();
};
const go = (sim, ...commands) => {
  for (const command of commands) sim.enqueue(command);
  sim.step();
};
/** Stand a crew member in a room at once, at their own spot in it. */
function place(sim, id, room) {
  const member = sim.state.crew[id];
  const at = spotIn(sim.layout.room(room), member.index);
  Object.assign(member, { room, x: at.x, y: at.y, px: at.x, py: at.y, path: [], goal: null, task: 'idle' });
  return member;
}
const watchSim = (seed = 'watch', crew = CREW, watches = 2) => createSim({ seed, ship: SHIP, crew, watches, ...CATALOG });

test('every station names a skill and a room on the starting ship, and every role but one a station', () => {
  const sim = newCrewedSim('stations');
  for (const id of STATION_IDS) {
    const station = STATIONS[id];
    assert.ok(station.name && station.blurb, id);
    assert.ok(sim.state.stations[id], `${id} has state`);
  }
  assert.equal(sim.state.crew.ilse.post, 'helm');
  assert.equal(sim.state.crew.dace.post, 'reactor');
  assert.equal(sim.state.crew.pruitt.post, 'weapons');
  assert.equal(sim.state.crew.okoro.post, 'medbay');
  assert.equal(sim.state.crew.halloran.post, 'doors');
  assert.equal(sim.state.crew.vesna.post, null, 'the quartermaster is the spare hand');
});

test('a station works at its rating: the posted hand, Margo, or nothing', () => {
  const sim = newCrewedSim('rating');
  // Ilse starts on the bridge, at her post.
  assert.equal(operatorOf(sim, 'helm')?.id, 'ilse');
  assert.ok(Math.abs(rating(sim, 'helm') - crewRating(sim.state.crew.ilse, 'piloting')) < 1e-9);
  assert.ok(rating(sim, 'helm') > MARGO_RATING);
  // Nobody is posted to the sensors: Margo has them, by the book.
  assert.equal(operatorOf(sim, 'sensors'), null);
  assert.equal(rating(sim, 'sensors'), MARGO_RATING);
  // Someone standing in a station's room who is not posted there does not touch it.
  place(sim, 'okoro', 'sensors');
  assert.equal(rating(sim, 'sensors'), MARGO_RATING);
  // Posted there, an untrained hand is worse than Margo.
  sim.state.crew.okoro.post = 'sensors';
  assert.ok(rating(sim, 'sensors') < MARGO_RATING);
  // Stood down, it is dark: nothing.
  go(sim, { type: 'station.stand', station: 'sensors', down: true });
  assert.equal(rating(sim, 'sensors'), 0);
  assert.equal(running(sim, 'sensors'), false);
  assert.equal(bars(sim, 'sensors'), 0);
  go(sim, { type: 'station.stand', station: 'sensors', down: false });
  assert.ok(running(sim, 'sensors'));
});

test('with Margo down, only the stations with someone on them run', () => {
  const sim = newCrewedSim('no-margo');
  go(sim, { type: 'station.stand', station: 'ai_core', down: true });
  assert.ok(rating(sim, 'helm') > 0, 'Ilse still has the helm');
  assert.equal(rating(sim, 'sensors'), 0);
  assert.equal(rating(sim, 'life_support'), 0);
  seconds(sim, 1);
  assert.deepEqual(checkInvariants(sim), []);
});

test('a skilled pilot beats Margo at the helm, and Margo beats an untrained hand', () => {
  /** Seconds to bring her round 120 degrees and seconds to take a sensor fix, with `who` posted to the helm (null: Margo). */
  const fly = (who) => {
    const sim = newCrewedSim('helm');
    for (const member of Object.values(sim.state.crew)) member.post = null;
    place(sim, 'ilse', 'quarters');
    if (who) {
      sim.state.crew[who].post = 'helm';
      place(sim, who, 'bridge');
    }
    sim.step();
    assert.equal(operatorOf(sim, 'helm')?.id ?? null, who);
    go(sim, { type: 'helm.heading', heading: (sim.state.helm.heading + 120) % 360 });
    let turn = 0;
    while (sim.state.helm.heading !== sim.state.helm.wanted && turn < 60 * TICK_RATE) {
      sim.step();
      turn += 1;
    }
    let fix = 0;
    sim.state.fix = 0;
    while (fixOf(sim) < 1 && fix < 120 * TICK_RATE) {
      stepFix(sim, 1 / TICK_RATE);
      fix += 1;
    }
    return { turn: turn / TICK_RATE, fix: fix / TICK_RATE, rating: rating(sim, 'helm') };
  };
  const pilot = fly('ilse'); // piloting 3
  const margo = fly(null);
  const untrained = fly('okoro'); // no piloting
  assert.ok(pilot.rating > margo.rating && margo.rating > untrained.rating);
  assert.ok(pilot.turn < margo.turn * 0.85 && margo.turn < untrained.turn * 0.9, `turn: ${pilot.turn} ${margo.turn} ${untrained.turn}`);
  assert.ok(pilot.fix < margo.fix * 0.85 && margo.fix < untrained.fix * 0.9, `fix: ${pilot.fix} ${margo.fix} ${untrained.fix}`);
});

test('fewer crew means fewer things done well', () => {
  const wellRun = (crew) => {
    const sim = watchSim('fewer', crew, 1); // all hands
    go(sim, { type: 'station.stand', station: 'weapons', down: false }, { type: 'station.stand', station: 'medbay', down: false }, { type: 'roster.muster' });
    seconds(sim, 40);
    return STATION_IDS.filter((id) => rating(sim, id) > MARGO_RATING).length;
  };
  const six = wellRun(CREW);
  const two = wellRun(CREW.slice(0, 2));
  assert.ok(six >= 5, `six crew run ${six} stations better than Margo`);
  assert.equal(two, 2);
});

test('posting someone sends them to the station, and they take it when they get there', () => {
  const sim = newCrewedSim('post');
  go(sim, { type: 'crew.post', crew: 'vesna', station: 'sensors' });
  assert.equal(sim.state.crew.vesna.post, 'sensors');
  assert.equal(sim.state.crew.vesna.goal, 'sensors');
  seconds(sim, 30);
  assert.equal(operatorOf(sim, 'sensors')?.id, 'vesna');
  // Sent away, she still holds the post but Margo has the station.
  go(sim, { type: 'crew.move', crew: 'vesna', room: 'hold' });
  seconds(sim, 1);
  assert.equal(operatorOf(sim, 'sensors'), null);
  assert.equal(rating(sim, 'sensors'), MARGO_RATING);
  // Two people cannot hold one post: the newcomer takes it over.
  go(sim, { type: 'crew.post', crew: 'okoro', station: 'sensors' });
  assert.equal(sim.state.crew.vesna.post, null);
  go(sim, { type: 'crew.post', crew: 'okoro', station: null });
  assert.equal(sim.state.crew.okoro.post, null);
  assert.throws(() => sim.enqueue({ type: 'crew.post', crew: 'okoro', station: 'ai_core' }), /Margo/);
  assert.throws(() => sim.enqueue({ type: 'crew.post', crew: 'okoro', station: 'galley' }), /no station/);
});

test('someone fighting a fire in their station room is not on the station', () => {
  const sim = newCrewedSim('busy');
  assert.equal(operatorOf(sim, 'helm')?.id, 'ilse');
  go(sim, { type: 'debug.room', room: 'bridge', set: { fire: 0.6 } });
  sim.step();
  assert.equal(sim.state.crew.ilse.task, 'extinguish');
  assert.equal(operatorOf(sim, 'helm'), null);
  assert.equal(rating(sim, 'helm'), MARGO_RATING);
});

test('the bar orders are gone, and the switches are few', () => {
  assert.ok(!COMMAND_TYPES.includes('power.add'));
  for (const type of ['station.stand', 'power.output', 'power.lift', 'crew.post', 'crew.watch', 'roster.watches', 'roster.muster', 'deck.lights']) assert.ok(COMMAND_TYPES.includes(type), type);
  const sim = newSim('no-bars');
  for (const system of Object.values(sim.state.systems)) assert.equal(system.power, undefined, 'no system carries routed bars');
});

test('the reactor has three outputs, each with its heat and its pace', () => {
  const sim = newCrewedSim('output');
  const at = (level) => {
    if (sim.state.power.output !== level) go(sim, { type: 'power.output', level });
    return { load: reactorLoad(sim), heat: signature(sim).heat, pace: rating(sim, 'sensors') };
  };
  const steady = at('steady');
  const low = at('low');
  assert.ok(low.load < steady.load && low.heat < steady.heat);
  assert.ok(low.pace < steady.pace);
  // Run hard needs a hand on the reactor: Margo keeps to the book.
  assert.equal(operatorOf(sim, 'reactor')?.id, 'dace');
  const hard = at('hard');
  assert.ok(hard.load > steady.load && hard.pace > steady.pace);
  assert.equal(OUTPUT.hard.pace > 1, true);
  go(sim, { type: 'crew.move', crew: 'dace', room: 'engines' });
  seconds(sim, 1);
  assert.equal(sim.state.power.output, 'steady', 'with nobody on the reactor she drops back');
  assert.match(sim.whyNot({ type: 'power.output', level: 'hard' }), /reactor/);
});

test('a damaged reactor cannot run hard, a half-wrecked one runs low, and a dead one darkens the ship', () => {
  const sim = newCrewedSim('reactor');
  const { level } = sim.state.systems.reactor;
  const seen = [];
  sim.events.on('power.brownout', (event) => seen.push(event));
  go(sim, { type: 'power.output', level: 'hard' });
  go(sim, { type: 'debug.system', system: 'reactor', damage: 1 });
  sim.step();
  assert.equal(sim.state.power.output, 'steady');
  go(sim, { type: 'debug.system', system: 'reactor', damage: Math.ceil(level / 2) });
  sim.step();
  assert.equal(sim.state.power.output, 'low');
  assert.match(sim.whyNot({ type: 'power.output', level: 'steady' }), /damage/);
  assert.ok(seen.length >= 2);
  go(sim, { type: 'debug.system', system: 'reactor', damage: level });
  seconds(sim, 1);
  for (const id of STATION_IDS) assert.equal(rating(sim, id), 0, `${id} is dark`);
  assert.ok(Object.values(sim.state.rooms).every((room) => !room.lightsOn), 'every lamp is out');
  assert.match(sim.whyNot({ type: 'room.lights', room: 'bridge', on: true }), /reactor/);
  assert.deepEqual(checkInvariants(sim), []);
});

test('each switch has its cost in heat or noise', () => {
  const sim = newCrewedSim('switches');
  seconds(sim, 2);
  const before = { load: reactorLoad(sim), noise: sim.state.rooms.life_support.noise };
  go(sim, { type: 'station.stand', station: 'life_support', down: true });
  seconds(sim, 2);
  assert.ok(reactorLoad(sim) < before.load, 'air off: less load');
  assert.ok(sim.state.rooms.life_support.noise < before.noise, 'air off: a quieter room');
  const lit = reactorLoad(sim);
  go(sim, { type: 'deck.lights', deck: 'upper', on: false });
  seconds(sim, 1);
  assert.ok(reactorLoad(sim) < lit, 'a dark deck: less load');
  const guns = reactorLoad(sim);
  go(sim, { type: 'station.stand', station: 'weapons', down: false });
  assert.ok(reactorLoad(sim) > guns, 'guns stood to: more load');
  // The lift motor is its own switch: off, the lifts are cranked by hand.
  const withLift = reactorLoad(sim);
  go(sim, { type: 'power.lift', on: false });
  assert.ok(reactorLoad(sim) < withLift);
  assert.equal(sim.state.power.lift, false);
});

test('a watch bill: two watches turn about, the watch below sleeps, and sleep takes the tiredness off', () => {
  const sim = watchSim('bill');
  assert.equal(sim.state.roster.watches, 2);
  const first = Object.values(sim.state.crew).filter((member) => onWatch(sim, member)).map((member) => member.id);
  assert.equal(first.length, 3);
  seconds(sim, 40);
  const below = Object.values(sim.state.crew).filter((member) => !onWatch(sim, member));
  assert.ok(below.every((member) => member.room === 'quarters' && member.asleep), 'the watch below is in its bunks');
  assert.equal(operatorOf(sim, 'helm')?.id ?? null, onWatch(sim, sim.state.crew.ilse) ? 'ilse' : null);
  const changes = [];
  sim.events.on('watch.changed', (event) => changes.push(event));
  const tired = Object.fromEntries(Object.values(sim.state.crew).map((member) => [member.id, member.fatigue]));
  seconds(sim, WATCH.seconds);
  assert.equal(changes.length, 1);
  const now = Object.values(sim.state.crew).filter((member) => onWatch(sim, member)).map((member) => member.id);
  assert.deepEqual(now.filter((id) => first.includes(id)), [], 'the other watch is on');
  for (const id of first) assert.ok(sim.state.crew[id].fatigue > tired[id], `${id} stood a watch and is more tired`);
  seconds(sim, 40);
  for (const id of first) assert.ok(sim.state.crew[id].asleep && sim.state.crew[id].room === 'quarters', `${id} has turned in`);
  for (const id of now) assert.ok(!sim.state.crew[id].asleep, `${id} is up`);
  const peak = sim.state.crew[first[0]].fatigue;
  seconds(sim, WATCH.seconds - 60);
  assert.ok(sim.state.crew[first[0]].fatigue < peak - 0.2, 'a watch below takes it off');
  assert.deepEqual(checkInvariants(sim), []);
});

test('all hands keeps everyone up and wears them down; a tired hand is worse on station', () => {
  const sim = watchSim('all-hands', CREW, 1);
  go(sim, { type: 'roster.muster' });
  seconds(sim, 30);
  const fresh = rating(sim, 'helm');
  assert.ok(Object.values(sim.state.crew).every((member) => !member.asleep));
  seconds(sim, WATCH.seconds * 2.2);
  assert.ok(sim.state.crew.ilse.fatigue > 0.9);
  assert.ok(tiredness(sim.state.crew.ilse) < 0.7);
  assert.ok(rating(sim, 'helm') < fresh * 0.75, 'a tired pilot is a worse pilot');
  // Three watches: two thirds of the crew are below at a time.
  go(sim, { type: 'roster.watches', count: 3 });
  assert.equal(Object.values(sim.state.crew).filter((member) => onWatch(sim, member)).length, 2);
  assert.throws(() => sim.enqueue({ type: 'roster.watches', count: 4 }), /1, 2 or 3/);
  const below = Object.values(sim.state.crew).find((member) => !onWatch(sim, member));
  go(sim, { type: 'crew.watch', crew: below.id, watch: sim.state.roster.on });
  assert.ok(onWatch(sim, below));
});

test('an order wakes a sleeper, and a sim with no watch bill never tires anyone', () => {
  const sim = watchSim('wake');
  seconds(sim, 40);
  const sleeper = Object.values(sim.state.crew).find((member) => member.asleep);
  assert.ok(sleeper);
  go(sim, { type: 'crew.move', crew: sleeper.id, room: 'aft_corridor' });
  assert.equal(sleeper.asleep, false);
  const bare = newCrewedSim('bare');
  assert.equal(bare.state.roster.watches, 0);
  seconds(bare, 60);
  assert.ok(Object.values(bare.state.crew).every((member) => member.fatigue === 0 && !member.asleep));
  assert.equal(bare.state.crew.halloran.room, 'shields', 'nobody is walked to a post without a watch bill');
});

test('the watch bill is deterministic and survives a snapshot', () => {
  const a = watchSim('same');
  const b = watchSim('same');
  seconds(a, 30);
  const snap = a.snapshot();
  seconds(a, 300);
  seconds(b, 330);
  assert.deepEqual(a.state.crew, b.state.crew);
  assert.deepEqual(a.state.roster, b.state.roster);
  a.restore(snap);
  seconds(a, 300);
  assert.deepEqual(a.state.crew, b.state.crew);
});
