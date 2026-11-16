// Transit events (S3.3, D-111): meeting them on the lanes (H.6), choices and their tags, outcomes and effects,
// the hooks into combat, scenes and the threat, and what the content checker catches.

import assert from 'node:assert/strict';
import test from 'node:test';

import { gatherRefs, validateContent } from '../src/engine/content-schema.js';
import { hashState } from '../src/engine/hash.js';
import { validateEffects, EFFECTS } from '../src/narrative/effects.js';
import { MAX_ABOARD, RESULT_SECONDS, checkEvent, eventView, roomsFor, situationViews, whyNoChoice } from '../src/narrative/events.js';
import { recall } from '../src/sim/memory.js';
import { heldReason, neighbours, nodeOf } from '../src/sim/sector.js';
import { checkInvariants, createSim } from '../src/sim/sim.js';
import { readContentFiles } from '../tools/lib/load-content.js';
import { spotIn } from '../src/sim/crew.js';
import { CATALOG, CREW, EVENTS, SHIP, castOff, content, dealWith, fly, routeVia, situation, standIn } from './helpers.js';

const REACH = content.require('sectors', 'the-reach');
const FILES = readContentFiles();
const REFS = gatherRefs(FILES);
const runSim = (events = EVENTS, seed = 'events', sector = REACH) => {
  const sim = createSim({ seed, ship: SHIP, crew: CREW, ...CATALOG, sector, events, encounters: content.all('encounters'), run: { pursuit: false } });
  sim.step();
  return sim;
};
const give = (sim, ...commands) => {
  for (const command of commands) sim.enqueue(command);
  sim.step();
};
/** A one-choice radio decision that does `effects`, for trying effects one at a time. */
const doing = (effects, extra = {}) => ({ id: 'test.one', title: 'Test', text: 'Test.', at: ['empty'], place: 'radio', choices: [{ id: 'go', label: 'Go', outcomes: [{ text: 'Done.', effects }] }], ...extra });
/** Open an event from the debug sheet and take its only choice. */
function play(effects, { before = () => {}, extra = {}, more = [] } = {}) {
  const sim = runSim([doing(effects, extra), ...more]);
  before(sim);
  give(sim, { type: 'debug.event', event: 'test.one' });
  give(sim, { type: 'event.choose', choice: 'go' });
  return sim;
}
const heard = (sim, type) => {
  const seen = [];
  sim.events.on(type, (event) => seen.push(event));
  return seen;
};
/** Cast off on a route that passes `to`, and fly in ship time until an event is met or the first lane is flown. */
function towards(sim, to) {
  castOff(sim, routeVia(sim.state.run, to));
  const run = sim.state.run;
  for (let i = 0; i < 20 * 600 && run.crossing && run.crossing.leg === 0 && !run.events.open && !run.events.aboard.length; i++) sim.step();
}
/** A one-choice situation aboard, in the cargo hold unless `place` says otherwise. */
const aboardOne = (effects = [], extra = {}) => ({ ...doing(effects), place: { room: 'cargo' }, sign: 'Something in {room}.', ...extra });
/** The one situation aboard, as its card shows it. */
const only = (sim) => situationViews(sim)[0];

test('every event in content passes its own check', () => {
  assert.ok(EVENTS.length >= 12);
  assert.ok(EVENTS.filter((event) => event.place !== 'radio').length >= 10, 'most of them happen aboard');
  for (const event of EVENTS) assert.ok(event.place === 'radio' || typeof event.place?.room === 'string' || Array.isArray(event.place?.room), `${event.id} says where it happens`);
  for (const { _file, ...event } of EVENTS) assert.deepEqual(checkEvent(event, REFS), [], event.id);
});

test('the lane to a point can bring an event of its kind, partway along: a radio decision heaves her to, a situation waits in its room; with no events nothing comes', () => {
  const always = { ...REACH, events: { empty: 1, hazard: 1, derelict: 1, checkpoint: 1 } };
  const radio = [doing([])];
  const sim = runSim(radio, 'arrive', always);
  const opened = heard(sim, 'event.opened');
  const run = sim.state.run;
  for (const node of run.map.nodes) if (node.kind !== 'port') node.kind = 'empty';
  assert.equal(eventView(sim), null, 'nothing at the origin');
  const to = neighbours(run.map, run.at).find((id) => nodeOf(run.map, id).kind !== 'port');
  towards(sim, to);
  const view = eventView(sim);
  assert.ok(view, 'an event on the way');
  assert.equal(opened.length, 1);
  assert.equal(opened[0].node, to, 'it is about the point ahead');
  assert.equal(run.crossing.leg, 0, 'met on the lane, not on arriving');
  const along = run.crossing.t / run.crossing.length;
  assert.ok(along >= 0.24 && along <= 0.76, `${along} of the way along`);
  assert.equal(view.result, null);
  assert.deepEqual(run.events.met, [view.id]);
  for (let i = 0; i < 100; i++) sim.step();
  assert.equal(run.crossing.t / run.crossing.length, along, 'she holds while it is on the table');
  assert.deepEqual(checkInvariants(sim), []);

  // The same lane with a situation: it is put in its room, Margo says its sign, and the ship sails on.
  const lived = runSim([aboardOne()], 'arrive', always);
  for (const node of lived.state.run.map.nodes) if (node.kind !== 'port') node.kind = 'empty';
  const said = heard(lived, 'ai.line');
  towards(lived, to);
  assert.equal(eventView(lived), null, 'no event view for a situation');
  assert.deepEqual([only(lived).room, only(lived).state, only(lived).sign], ['cargo', 'waiting', 'Something in Cargo hold.']);
  assert.equal(said.at(-1).text, 'Something in Cargo hold.');
  const was = lived.state.run.crossing.t;
  for (let i = 0; i < 100; i++) lived.step();
  assert.ok(lived.state.run.crossing.t > was, 'she sails on while it waits');
  assert.equal(heldReason(lived), null);
  assert.deepEqual(checkInvariants(lived), []);

  const quiet = runSim([], 'arrive', always);
  towards(quiet, to);
  assert.equal(eventView(quiet), null);
  const never = runSim(EVENTS, 'arrive', { ...REACH, events: { empty: 0, hazard: 0, derelict: 0, checkpoint: 0 } });
  towards(never, to);
  assert.equal(eventView(never), null, 'the sector says how likely an event is');
  assert.equal(situationViews(never).length, 0);
});

test('a point is only rolled for once, and an event is met once a run', () => {
  const sector = { ...REACH, events: { empty: 1, hazard: 1, derelict: 1, checkpoint: 1 } };
  const sim = runSim([doing([]), { ...doing([]), id: 'test.two' }], 'once', sector);
  const run = sim.state.run;
  // Make every point but the ports open space so both test events fit everywhere.
  for (const node of run.map.nodes) if (node.kind !== 'port') node.kind = 'empty';
  const first = neighbours(run.map, run.at).find((id) => nodeOf(run.map, id).kind !== 'port');
  const met = [];
  sim.events.on('event.opened', (event) => met.push(event.event));
  fly(sim, routeVia(run, first));
  assert.ok(run.events.rolled.includes(first));
  assert.equal(new Set(met).size, met.length, 'never the same one twice');
  assert.ok(met.length >= 1 && met.length <= 2);
  // Back by the same points: their dice have been thrown.
  const before = met.length;
  const back = routeVia(run, first);
  if (back.slice(1, -1).every((id) => run.events.rolled.includes(id))) {
    fly(sim, back);
    assert.equal(met.length, before);
  }
  assert.deepEqual(checkInvariants(sim), []);
});

test('a choice shows who meets its requirement, is locked with what is missing, or is hidden', () => {
  const sim = runSim();
  give(sim, { type: 'debug.event', event: 'hazard.loud-lane' });
  sim.step(); // Ilse is at the helm: she has it in hand at once
  let view = only(sim);
  assert.deepEqual([view.room, view.state, view.by], ['bridge', 'attended', 'Ilse']);
  assert.match(view.title, /: /);
  assert.ok(!/[{}]/.test(view.title + view.text + view.sign), 'every slot is filled');
  const byId = () => Object.fromEntries(only(sim).choices.map((choice) => [choice.id, choice]));
  assert.deepEqual(byId()['press-on'], { id: 'press-on', label: 'Hold the course and take what comes', tag: null, available: true });
  assert.equal(byId().thread.tag, '[Ilse, Piloting]');
  assert.equal(byId().sweep.tag, '[Sensors running]');
  assert.equal(whyNoChoice(sim, 'thread', view.n), null);
  sim.state.crew.ilse.skills.piloting = 1;
  sim.state.stations.sensors.down = true;
  assert.deepEqual(byId().thread, { id: 'thread', label: 'Let the best hands aboard fly it', tag: '[Needs Piloting 2]', available: false });
  assert.equal(byId().sweep.tag, '[Needs Sensors running]');
  assert.match(whyNoChoice(sim, 'thread', view.n), /not open to us/);
  assert.throws(() => sim.enqueue({ type: 'event.choose', situation: view.n, choice: 'thread' }), /not open to us/);
  assert.match(whyNoChoice(sim, 'dance', view.n), /no choice "dance"/);

  give(sim, { type: 'debug.event', event: 'empty.beacon' });
  standIn(sim, 'pruitt', 'sensors');
  sim.step();
  const beacon = () => situationViews(sim).find((one) => one.id === 'empty.beacon');
  assert.equal(beacon().mark, 'Beacon', 'it is marked on the scope');
  assert.ok(!beacon().choices.some((choice) => choice.id === 'listen'), 'hidden until the sensors can do it');
  // A trained hand posted to the sensors and on them.
  sim.state.stations.sensors.down = false;
  Object.assign(sim.state.crew.vesna, { post: 'sensors', skills: { piloting: 2 } });
  standIn(sim, 'vesna', 'sensors');
  assert.equal(beacon().choices.find((choice) => choice.id === 'listen').tag, '[A trained hand on the sensors]');
});

test('a radio decision is answered once, its outcome is told, and the event is put away', () => {
  const sim = runSim();
  const chosen = heard(sim, 'event.chosen');
  const closed = heard(sim, 'event.closed');
  assert.throws(() => sim.enqueue({ type: 'event.choose', choice: 'manifest' }), /no event is waiting/);
  assert.throws(() => sim.enqueue({ type: 'event.dismiss' }), /no event is open/);
  give(sim, { type: 'debug.event', event: 'checkpoint.patrol-line' });
  assert.throws(() => sim.enqueue({ type: 'event.dismiss' }), /still waiting for an answer/);
  assert.equal(situationViews(sim).length, 0, 'over the radio: on the table, not in a room');
  give(sim, { type: 'event.choose', choice: 'pay' });
  assert.equal(eventView(sim).result.choice, 'pay');
  assert.match(eventView(sim).result.text, /receipt/);
  assert.equal(chosen[0].text, eventView(sim).result.text);
  assert.throws(() => sim.enqueue({ type: 'event.choose', choice: 'run' }), /has been answered/);
  give(sim, { type: 'event.dismiss' });
  assert.equal(eventView(sim), null);
  assert.equal(closed.length, 1);
  assert.deepEqual(checkInvariants(sim), []);
});

// ---------- situations aboard (H.7, D-156) ----------

test('a situation waits in its room until one of ours stands there; then its card names them and offers its choices', () => {
  const sim = runSim(EVENTS, 'events', { ...REACH, events: { empty: 0, hazard: 0, derelict: 0, checkpoint: 0 } });
  castOff(sim, routeVia(sim.state.run, sim.state.run.map.delivery)); // under way, so the ship clock runs
  const attended = heard(sim, 'situation.attended');
  const chosen = heard(sim, 'event.chosen');
  const closed = heard(sim, 'event.closed');
  standIn(sim, 'vesna', 'quarters'); // she keeps the hold: without this she would find him at once
  give(sim, { type: 'debug.event', event: 'hold.stowaway' });
  let view = only(sim);
  assert.deepEqual([view.room, view.roomName, view.state, view.by, view.text], ['hold', 'Main hold', 'waiting', null, null]);
  assert.deepEqual(view.choices, [], 'nothing to choose until somebody is there');
  assert.match(view.sign, /Something moved in Main hold/);
  assert.ok(view.left > 9.99 && view.left <= 10, 'the hours it will wait');
  assert.match(whyNoChoice(sim, 'work', view.n), /nobody is in Main hold/);
  assert.throws(() => sim.enqueue({ type: 'event.choose', situation: view.n, choice: 'work' }), /nobody is in Main hold/);
  assert.throws(() => sim.enqueue({ type: 'event.choose', situation: 99, choice: 'work' }), /no situation 99/);
  assert.throws(() => sim.enqueue({ type: 'event.dismiss', situation: view.n }), /still waiting/);

  // Walking there counts once they have arrived, not on the way through.
  give(sim, { type: 'crew.move', crew: 'pruitt', room: 'hold', ship: 'us' });
  let ticks = 0;
  while (only(sim).state === 'waiting' && ticks++ < 20 * 120) sim.step();
  view = only(sim);
  assert.equal(view.state, 'attended', `Pruitt got there (${ticks} ticks)`);
  assert.equal(sim.state.crew.pruitt.room, 'hold');
  assert.notEqual(sim.state.crew.pruitt.task, 'walking');
  assert.deepEqual(attended.map((event) => [event.crew, event.room]), [['pruitt', 'hold']]);
  assert.equal(view.by, 'Pruitt');
  assert.match(view.text, /^Pruitt finds a boy/);
  assert.deepEqual(view.choices.map((choice) => choice.id), ['work', 'brig', 'ask']);
  assert.ok(view.left < 9.9 && view.left > 0, `the wait ran while nobody was there (${view.left})`);

  // If they walk off again it goes back to waiting; back, and it is theirs again.
  standIn(sim, 'pruitt', 'cargo');
  sim.step();
  assert.equal(only(sim).state, 'waiting');
  standIn(sim, 'pruitt', 'hold');
  sim.step();
  const left = only(sim).left;
  for (let i = 0; i < 200; i++) sim.step();
  assert.equal(only(sim).left, left, 'the wait stops while somebody is at it');

  give(sim, { type: 'event.choose', situation: view.n, choice: 'brig' });
  view = only(sim);
  assert.equal(view.state, 'answered');
  assert.match(view.result.text, /Pruitt leaves him the blanket/);
  assert.deepEqual([chosen[0].situation, chosen[0].room, chosen[0].crew], [view.n, 'hold', 'pruitt']);
  assert.equal(sim.state.run.flags.stowaway_brig, true);
  assert.throws(() => sim.enqueue({ type: 'event.choose', situation: view.n, choice: 'work' }), /has been dealt with/);
  give(sim, { type: 'event.dismiss', situation: view.n });
  assert.equal(situationViews(sim).length, 0);
  assert.equal(closed[0].situation, view.n);
  assert.deepEqual(checkInvariants(sim), []);
});

test('somebody asleep, hiding, dead or not ours does not attend; an answered card puts itself away', () => {
  const sim = runSim([aboardOne()]);
  give(sim, { type: 'debug.event', event: 'test.one' });
  standIn(sim, 'pruitt', 'cargo');
  for (const change of [{ asleep: true }, { hidden: 'locker' }, { alive: false }, { owner: 'enemy' }]) {
    const was = { ...sim.state.crew.pruitt };
    Object.assign(sim.state.crew.pruitt, change);
    sim.step();
    assert.equal(only(sim).state, 'waiting', JSON.stringify(change));
    Object.assign(sim.state.crew.pruitt, was);
  }
  sim.step();
  assert.equal(only(sim).state, 'attended');
  give(sim, { type: 'event.choose', situation: only(sim).n, choice: 'go' });
  for (let i = 0; i < RESULT_SECONDS * 20 - 2; i++) sim.step();
  assert.equal(only(sim)?.state, 'answered', 'still up to be read');
  for (let i = 0; i < 4; i++) sim.step();
  assert.equal(situationViews(sim).length, 0, 'and then it is put away');
});

test('left alone for its hours a situation lapses: it does what its lapse says and tells it; with nothing to tell it is just gone', () => {
  const lapse = { hours: 0.5, text: 'Nobody went to {room}.', effects: [{ do: 'money', add: -7 }, { do: 'fire', room: '$room', size: 0.3 }] };
  const sim = runSim([aboardOne([], { lapse })]);
  const lapsed = heard(sim, 'event.lapsed');
  const said = heard(sim, 'ai.line');
  const money = sim.state.money;
  give(sim, { type: 'debug.event', event: 'test.one' });
  // Not under way, so the ship clock stands still and nothing lapses in port.
  for (let i = 0; i < 400; i++) sim.step();
  assert.equal(only(sim).left, 0.5);
  castOff(sim, routeVia(sim.state.run, sim.state.run.map.delivery));
  for (let i = 0; i < 0.5 * sim.state.run.hour * 20 + 2; i++) sim.step();
  assert.equal(lapsed.length, 1);
  assert.deepEqual([lapsed[0].event, lapsed[0].room, lapsed[0].text], ['test.one', 'cargo', 'Nobody went to Cargo hold.']);
  assert.equal(sim.state.money, money - 7);
  assert.ok(sim.state.rooms.cargo.fire > 0, 'the leak found something to burn');
  assert.deepEqual([only(sim).state, only(sim).result.lapsed, only(sim).result.text], ['answered', true, 'Nobody went to Cargo hold.']);
  assert.equal(said.at(-1).text, 'Nobody went to Cargo hold.', 'Margo says what came of it');
  give(sim, { type: 'event.dismiss', situation: only(sim).n });
  assert.equal(situationViews(sim).length, 0);

  const bare = runSim([aboardOne([], { lapse: { hours: 0.2 } })]);
  give(bare, { type: 'debug.event', event: 'test.one' });
  castOff(bare, routeVia(bare.state.run, bare.state.run.map.delivery));
  for (let i = 0; i < 0.2 * bare.state.run.hour * 20 + 2; i++) bare.step();
  assert.equal(situationViews(bare).length, 0);
  assert.deepEqual(checkInvariants(bare), []);
});

test('a hull alongside heaves her to until it is dealt with or lapses; the room going over the side takes the matter with it', () => {
  const sim = runSim([aboardOne([], { place: { room: 'airlock', scope: 'Dead hull', hold: true }, lapse: { hours: 1, text: 'She drops astern.' } })]);
  castOff(sim, routeVia(sim.state.run, sim.state.run.map.delivery));
  give(sim, { type: 'debug.event', event: 'test.one' });
  const view = only(sim);
  assert.ok(['engines', 'cargo', 'quarters', 'hold'].includes(view.room), `${view.room} has a lock to space`);
  assert.deepEqual([view.mark, view.hold], ['Dead hull', true]);
  assert.equal(heldReason(sim), 'we are standing by something alongside');
  const t = sim.state.run.crossing.t;
  for (let i = 0; i < 100; i++) sim.step();
  assert.equal(sim.state.run.crossing.t, t, 'hove to');
  dealWith(sim, view.n, undefined, { dismiss: false });
  assert.equal(heldReason(sim), null, 'answered: she is under way while the card is read');
  // Left alone instead, she waits out the lapse and then sails.
  const left = runSim([aboardOne([], { place: { room: 'cargo', hold: true }, lapse: { hours: 1, text: 'She drops astern.' } })]);
  castOff(left, routeVia(left.state.run, left.state.run.map.delivery));
  give(left, { type: 'debug.event', event: 'test.one' });
  for (let i = 0; i < left.state.run.hour * 20 + 2; i++) left.step();
  assert.equal(heldReason(left), null);
  assert.equal(only(left).result.lapsed, true);

  const gone = runSim([aboardOne([], { place: { room: 'medbay' } })]);
  const lapsed = heard(gone, 'event.lapsed');
  give(gone, { type: 'debug.event', event: 'test.one' });
  gone.state.rooms.medbay.jettisoned = true;
  gone.step();
  assert.equal(situationViews(gone).length, 0);
  assert.equal(lapsed.length, 1);
});

test('a place can be a room, a system, a kind, a lock, anywhere, or where one of the cast is; gone, the next word is tried', () => {
  const { rooms, doors } = SHIP;
  const ids = (word) => roomsFor(rooms, doors, word).map((room) => room.id);
  assert.deepEqual(ids('medbay'), ['medbay']);
  assert.deepEqual(ids('doors'), ['door_control'], 'the room of a system');
  assert.deepEqual(ids('helm'), ['bridge'], 'a kind of room');
  assert.deepEqual(ids('airlock').sort(), ['cargo', 'engines', 'hold', 'quarters']);
  assert.ok(ids('any').length > 10 && !ids('any').includes('lift') && !ids('any').includes('aft_corridor'));
  assert.deepEqual(ids('ballroom'), []);

  const event = aboardOne([], { cast: { patient: { id: 'okoro' } }, place: { room: ['$patient', 'medbay', 'quarters'] }, sign: '{patient} in {room}.' });
  assert.deepEqual(checkEvent(event, REFS), []);
  const sim = runSim([event]);
  standIn(sim, 'okoro', 'weapons');
  give(sim, { type: 'debug.event', event: 'test.one' });
  assert.deepEqual([only(sim).room, only(sim).sign], ['weapons', 'Okoro in Weapons.']);
  const fallback = runSim([{ ...event, place: { room: ['medbay', 'quarters'] } }]);
  fallback.state.rooms.medbay.jettisoned = true;
  give(fallback, { type: 'debug.event', event: 'test.one' });
  assert.equal(only(fallback).room, 'quarters');
});

test('the lanes bring no more while the decks are busy, and a follow-up is placed in its own room', () => {
  const sector = { ...REACH, events: { empty: 1, hazard: 1, derelict: 1, checkpoint: 1 } };
  const three = ['a', 'b', 'c', 'd'].map((id) => aboardOne([], { id: `test.${id}` }));
  const sim = runSim(three, 'busy', sector);
  const run = sim.state.run;
  for (const node of run.map.nodes) if (node.kind !== 'port') node.kind = 'empty';
  const far = run.map.delivery;
  castOff(sim, routeVia(run, far));
  for (let i = 0; i < 40000 && run.crossing?.phase === 'under way'; i++) {
    sim.enqueue({ type: 'debug.run', skip: true });
    sim.step();
    assert.ok(situationViews(sim).length <= MAX_ABOARD);
  }
  assert.ok(run.crossing.path.length < 4 || situationViews(sim).length === MAX_ABOARD, 'the decks filled up and no more came');
  assert.deepEqual(checkInvariants(sim), []);

  const next = aboardOne([{ do: 'money', add: 5 }], { id: 'test.next', place: { room: 'helm' }, sign: 'On the bridge.' });
  delete next.at;
  const led = runSim([aboardOne([{ do: 'event', event: 'test.next' }]), next]);
  give(led, { type: 'debug.event', event: 'test.one' });
  dealWith(led, only(led).n);
  assert.deepEqual([only(led).id, only(led).room], ['test.next', 'bridge'], 'the follow-up comes as the first is put away');
  assert.deepEqual(led.state.run.events.met, ['test.one', 'test.next']);
  assert.deepEqual(checkInvariants(led), []);
});

test('jumping into port leaves every situation behind', () => {
  const sim = runSim([aboardOne()]);
  const lapsed = heard(sim, 'event.lapsed');
  castOff(sim, routeVia(sim.state.run, sim.state.run.map.delivery));
  give(sim, { type: 'debug.event', event: 'test.one' });
  sim.state.run.events.aboard[0].left = null;
  const run = sim.state.run;
  for (let i = 0; i < 40000 && run.crossing; i++) {
    if (run.crossing.phase === 'under way') sim.enqueue({ type: 'debug.run', skip: true });
    else if (!sim.whyNot({ type: 'route.jump' })) sim.enqueue({ type: 'route.jump' });
    else sim.enqueue({ type: 'debug.run', fix: true });
    sim.step();
  }
  assert.equal(run.crossing, null);
  assert.equal(situationViews(sim).length, 0);
  assert.equal(lapsed.length, 1);
});

test('the content check says where a situation cannot be placed', () => {
  const problems = (change) => {
    const event = aboardOne();
    change(event);
    return checkEvent(event, REFS).join('; ');
  };
  assert.equal(problems(() => {}), '');
  assert.match(problems((e) => delete e.place), /place: say where this happens/);
  assert.match(problems((e) => (e.place = 'bridge')), /place must be "radio" or/);
  assert.match(problems((e) => (e.place = { room: 'ballroom' })), /"ballroom" is not a room, a system's room or a kind of room on the ship "margin-of-error"/);
  assert.match(problems((e) => (e.place = { room: ['cargo', 'ballroom'] })), /"ballroom" is not a room/);
  assert.match(problems((e) => (e.place = { room: [] })), /place.room must be/);
  assert.match(problems((e) => (e.place = { room: '$patient' })), /"\$patient" is not one of the cast/);
  assert.match(problems((e) => Object.assign(e, { cast: { patient: {} }, place: { room: '$patient' } })), /add a room to fall back on/);
  assert.match(problems((e) => (e.place = { room: 'cargo', deck: 2 })), /place: unknown key "deck"/);
  assert.match(problems((e) => (e.place = { room: 'cargo', scope: 'A very long name for a mark' })), /place.scope must be/);
  assert.match(problems((e) => (e.place = { room: 'cargo', hold: 'yes' })), /place.hold must be true or false/);
  assert.match(problems((e) => delete e.sign), /sign is missing/);
  assert.match(problems((e) => (e.sign = '{who} is there.')), /sign: nothing called "\{who\}"/, 'nobody is there yet when the sign is said');
  assert.match(problems((e) => (e.lapse = { hours: 0 })), /lapse.hours must be/);
  assert.match(problems((e) => (e.lapse = { hours: 1, text: '{who} never came.' })), /lapse.text: nothing called "\{who\}"/);
  assert.match(problems((e) => (e.lapse = { hours: 1, effects: [{ do: 'hurt', crew: '$who', amount: 0.1 }] })), /nothing called "\$who"/);
  assert.match(problems((e) => (e.cast = { who: {} })), /already the name of something/);
  assert.equal(problems((e) => Object.assign(e, { text: '{who} is in {room}.', lapse: { hours: 1, text: 'Nobody went to {room}.', effects: [{ do: 'fire', room: '$room' }] } })), '');
  // A radio decision has no sign and no lapse, and nobody is "there".
  const radio = (change) => {
    const event = doing([]);
    change(event);
    return checkEvent(event, REFS).join('; ');
  };
  assert.match(radio((e) => (e.sign = 'A sign.')), /sign is for a situation aboard/);
  assert.match(radio((e) => (e.lapse = { hours: 1 })), /lapse is for a situation aboard/);
  assert.match(radio((e) => (e.text = '{who} answers.')), /nothing called "\{who\}"/);
});

test('outcomes are rolled by weight from the ones whose conditions hold; a fallback only counts when nothing else fits', () => {
  const event = {
    id: 'test.one', title: 'T', text: 'T.', at: ['empty'],
    choices: [{ id: 'go', label: 'Go', outcomes: [
      { when: { fact: 'money', gte: 500 }, text: 'Rich.' },
      { when: { fact: 'money', lt: 500 }, weight: 3, text: 'Poor A.' },
      { when: { fact: 'money', lt: 500 }, weight: 1, text: 'Poor B.' },
      { fallback: true, text: 'Fallback.' },
    ] }],
  };
  const tally = {};
  for (let i = 0; i < 200; i++) {
    const sim = runSim([event], `roll-${i}`);
    give(sim, { type: 'debug.event', event: 'test.one' });
    give(sim, { type: 'event.choose', choice: 'go' });
    const { text } = eventView(sim).result;
    tally[text] = (tally[text] ?? 0) + 1;
  }
  assert.deepEqual(Object.keys(tally).sort(), ['Poor A.', 'Poor B.']);
  assert.ok(tally['Poor A.'] > tally['Poor B.'] * 1.8, `weights 3 to 1 gave ${tally['Poor A.']} to ${tally['Poor B.']}`);
  const rich = runSim([event]);
  rich.state.money = 900;
  give(rich, { type: 'debug.event', event: 'test.one' });
  give(rich, { type: 'event.choose', choice: 'go' });
  assert.equal(eventView(rich).result.text, 'Rich.');
  const none = runSim([{ ...event, choices: [{ ...event.choices[0], outcomes: [event.choices[0].outcomes[0], event.choices[0].outcomes[3]] }] }]);
  give(none, { type: 'debug.event', event: 'test.one' });
  give(none, { type: 'event.choose', choice: 'go' });
  assert.equal(eventView(none).result.text, 'Fallback.');
});

test('effects change the run, the ship and the crew', () => {
  let sim = play([{ do: 'money', add: -500 }, { do: 'fuel', add: -3 }, { do: 'deadline', add: -1 }, { do: 'hull', add: -999 }, { do: 'trust', add: 7 }]);
  assert.equal(sim.state.money, 0, 'money stops at nothing');
  assert.equal(sim.state.run.fuel, REACH.fuel.start - 3);
  assert.equal(sim.state.hull.points, 1, 'an event never sinks the ship outright');
  assert.equal(sim.state.ai.trust, 57);
  const before = runSim([]).state.run.deadline;
  assert.equal(sim.state.run.deadline, before - 1);

  sim = play([{ do: 'fire', room: 'medbay', size: 0.4 }, { do: 'breach', room: { of: 'dace' } }, { do: 'damage', system: 'sensors', bars: 1 }, { do: 'fire', room: 'random' }]);
  assert.ok(sim.state.rooms.medbay.fire >= 0.4 && sim.state.rooms.medbay.fire < 0.45, 'a fire of the size asked for, already growing');
  assert.ok(sim.state.rooms.reactor.breach > 0.25, 'a hole where Dace stands (he is already patching it)');
  assert.equal(sim.state.systems.sensors.damage, 1);
  assert.ok(Object.values(sim.state.rooms).filter((room) => room.fire > 0).length >= 1);
  sim.step();
  assert.deepEqual(checkInvariants(sim), [], 'power follows the damage');

  sim = play([{ do: 'hurt', crew: 'okoro', amount: 0.6 }, { do: 'heal', crew: 'okoro', amount: 0.2 }, { do: 'hurt', crew: 'all', amount: 0.1 }, { do: 'remember', crew: 'all', memory: 'death', room: 'medbay', who: 'okoro' }]);
  assert.ok(Math.abs(sim.state.crew.okoro.health - 0.5) < 1e-9);
  assert.ok(Math.abs(sim.state.crew.ilse.health - 0.9) < 1e-9);
  assert.equal(recall(sim, sim.state.crew.okoro, 'wound').room, 'quarters', 'a hurt from an event is remembered like any other');
  assert.deepEqual([recall(sim, sim.state.crew.ilse, 'death').room, recall(sim, sim.state.crew.ilse, 'death').who], ['medbay', 'Okoro']);

  const crates = Object.keys(runSim([]).state.crates).length;
  sim = play([{ do: 'crate', kind: 'salvage', label: 'Found', count: 2 }, { do: 'crate', kind: 'cargo', room: 'hold', contents: 'Letters.' }, { do: 'cargo', name: 'Scrap', qty: 3 }, { do: 'intel', text: 'Seen near {place}.' }, { do: 'flag', name: 'met' }, { do: 'flag', name: 'count', add: 2 }, { do: 'flag', name: 'count', add: 1 }]);
  assert.equal(Object.keys(sim.state.crates).length, crates + 3);
  assert.deepEqual(sim.state.cargo.at(-1), { name: 'Scrap', qty: 3, from: 'event' });
  assert.ok(sim.state.intel[0].text.startsWith('Seen near ') && !sim.state.intel[0].text.includes('{'));
  assert.deepEqual(sim.state.run.flags, { met: true, count: 3 });
  assert.deepEqual(checkInvariants(sim), []);

  sim = play([{ do: 'pursuit', on: true }, { do: 'pursuit', delay: 3 }]);
  assert.equal(sim.state.run.pursuit.wait, REACH.pursuit.lead + 3);
  sim = play([{ do: 'pursuit', on: false }], { before: (s) => give(s, { type: 'debug.run', pursuit: 'on' }) });
  assert.equal(sim.state.run.pursuit, null);
});

test('an effect can be aimed at the cast, or at whoever a requirement found', () => {
  const event = doing([], { cast: { victim: { skill: 'combat' } } });
  event.choices[0].requires = { crew: { skill: 'medicine', not: '$victim' }, as: 'medic' };
  event.choices[0].outcomes = [{ when: { crew: { skill: 'piloting' }, as: 'pilot' }, text: '{medic} treats {victim}; {pilot} watches.', effects: [{ do: 'hurt', crew: '$victim', amount: 0.2 }, { do: 'heal', crew: '$victim', amount: 0.05 }, { do: 'remember', crew: '$pilot', memory: 'wound', who: '$victim' }] }, { fallback: true, text: 'Nobody watches.' }];
  event.choices.push({ id: 'no', label: 'No', outcomes: [{ text: 'No.' }] });
  assert.deepEqual(checkEvent(event, REFS), []);
  const sim = runSim([event]);
  sim.state.crew.dace.skills.medicine = 4; // the best medic who is not the victim, ahead of Okoro
  give(sim, { type: 'debug.event', event: 'test.one' });
  assert.equal(eventView(sim).choices[0].tag, '[Dace, Medicine]');
  give(sim, { type: 'event.choose', choice: 'go' });
  assert.equal(eventView(sim).result.text, 'Dace treats Halloran; Ilse watches.', 'Halloran is the best fighter, so the victim');
  assert.ok(Math.abs(sim.state.crew.halloran.health - 0.85) < 1e-9);
  assert.equal(recall(sim, sim.state.crew.ilse, 'wound').who, 'Halloran');
  // With nobody to cast, the event cannot be met at all.
  const empty = runSim([event]);
  for (const id of ['okoro', 'pruitt', 'halloran']) empty.state.crew[id].alive = false; // everyone who can fight
  const uncast = heard(empty, 'event.uncast');
  give(empty, { type: 'debug.event', event: 'test.one' });
  assert.equal(eventView(empty), null);
  assert.equal(uncast.length, 1);
});

test('an outcome can put a ship on the scope, cue a scene, cue the threat, and lead on to another event', () => {
  let sim = play([{ do: 'contact', encounter: 'raider-skiff', range: 20 }]);
  const contact = sim.state.scope.contacts.find((item) => item.encounter === 'raider-skiff');
  assert.ok(contact, 'a raider on the scope');
  assert.equal(contact.state, 'closing');
  assert.ok(eventView(sim).result, 'the outcome is still on the table to be read');
  give(sim, { type: 'event.dismiss' });
  assert.ok(sim.state.scope.contacts.includes(contact), 'and it keeps coming');
  assert.deepEqual(checkInvariants(sim), []);

  sim = runSim([doing([{ do: 'scene', scene: 'bar.first' }, { do: 'threat', threat: 'stowaway' }, { do: 'threat' }])]);
  const scenes = heard(sim, 'scene.cued');
  const threats = heard(sim, 'threat.cued');
  give(sim, { type: 'debug.event', event: 'test.one' });
  give(sim, { type: 'event.choose', choice: 'go' });
  assert.deepEqual(sim.state.run.scenes, ['bar.first']);
  assert.equal(sim.state.run.threat.id, 'stowaway', 'the first threat cued is the one that is aboard');
  assert.deepEqual([scenes.length, threats.length], [1, 2]);

  const next = { ...doing([{ do: 'money', add: 5 }]), id: 'test.next', at: undefined };
  delete next.at;
  sim = play([{ do: 'event', event: 'test.next' }], { more: [next] });
  assert.equal(eventView(sim).id, 'test.one');
  give(sim, { type: 'event.dismiss' });
  assert.equal(eventView(sim).id, 'test.next', 'the follow-up opens as the first is put away');
  give(sim, { type: 'event.choose', choice: 'go' });
  give(sim, { type: 'event.dismiss' });
  assert.equal(eventView(sim), null);
  assert.deepEqual(sim.state.run.events.met, ['test.one', 'test.next']);
});

test('an event replays exactly from its seed, and a snapshot taken mid-event restores it', () => {
  const start = () => {
    const sim = runSim(EVENTS, 'replay');
    give(sim, { type: 'debug.event', event: 'derelict.cold-hull' });
    standIn(sim, 'pruitt', only(sim).room);
    sim.step();
    return sim;
  };
  const playThrough = () => {
    const sim = start();
    give(sim, { type: 'event.choose', situation: only(sim).n, choice: 'board' });
    return sim;
  };
  const a = playThrough();
  const b = playThrough();
  assert.equal(hashState(a.snapshot()), hashState(b.snapshot()));
  const mid = start();
  const snap = mid.snapshot();
  const twin = runSim(EVENTS, 'replay');
  for (let i = 0; i < 50; i++) twin.step();
  twin.restore(snap);
  assert.deepEqual(situationViews(twin), situationViews(mid));
  give(twin, { type: 'event.choose', situation: only(twin).n, choice: 'board' });
  assert.equal(hashState(twin.snapshot()), hashState(a.snapshot()));
});

test('every effect checks what it is given', () => {
  const env = { vars: { scout: 'crew', place: 'text' }, refs: REFS };
  const bad = (effects) => validateEffects(effects, env)[0] ?? '';
  assert.deepEqual(validateEffects([{ do: 'hurt', crew: '$scout', amount: 0.3 }, { do: 'fire', room: { of: '$scout' } }, { do: 'contact', encounter: 'patrol-cutter' }, { do: 'threat' }, { do: 'intel', text: 'At {place}.' }], env), []);
  assert.match(bad([{ do: 'explode' }]), /no effect "explode"/);
  assert.match(bad([{ do: 'money' }]), /needs "add"/);
  assert.match(bad([{ do: 'money', add: 0 }]), /whole number, not 0/);
  assert.match(bad([{ do: 'money', add: 5, to: 'me' }]), /has no "to"/);
  assert.match(bad([{ do: 'hurt', crew: '$medic', amount: 0.3 }]), /nothing called "\$medic"/);
  assert.match(bad([{ do: 'hurt', crew: 'ilse', amount: 3 }]), /at most 1/);
  assert.match(bad([{ do: 'fire', room: 'ballroom' }]), /no room "ballroom"/);
  assert.match(bad([{ do: 'damage', system: 'warp' }]), /no system "warp"/);
  assert.match(bad([{ do: 'remember', crew: 'all', memory: 'birthday' }]), /no memory "birthday"/);
  assert.match(bad([{ do: 'fight', ship: 'salvager-skiff' }]), /no effect "fight"/, 'the duel is gone (H.3)');
  assert.match(bad([{ do: 'contact', encounter: 'margin-of-error' }]), /no encounter "margin-of-error"/);
  assert.match(bad([{ do: 'scene', scene: 'bar.first' }]), /no scene "bar.first"/);
  assert.match(bad([{ do: 'threat', threat: 'stowaway' }]), /no threat "stowaway"/);
  assert.match(bad([{ do: 'event', event: 'nowhere' }]), /no event "nowhere"/);
  assert.match(bad([{ do: 'crate', kind: 'cargo' }]), /needs "contents"/);
  assert.match(bad([{ do: 'crate', kind: 'gold' }]), /kind must be one of/);
  assert.match(bad([{ do: 'intel', text: 'By {nobody}.' }]), /nothing called "\{nobody\}"/);
  assert.match(bad([{ do: 'pursuit' }]), /needs "on" or "delay"/);
  assert.match(bad('fire'), /must be a list/);
  for (const [id, effect] of Object.entries(EFFECTS)) assert.equal(typeof effect.run, 'function', id);
});

test('the content check catches a broken event: bad references, names out of reach, and events that could get stuck', () => {
  const withEvent = (event) => validateContent([...FILES, { path: 'events/extra.json', data: { items: [event] } }]).errors;
  const good = doing([{ do: 'money', add: 5 }]);
  good.choices.push({ id: 'no', label: 'No', outcomes: [{ text: 'No.' }] });
  assert.deepEqual(withEvent(good), []);
  const broken = (change, pattern) => {
    const event = structuredClone(good);
    change(event);
    const errors = withEvent(event);
    assert.ok(errors.some((error) => pattern.test(error)), `${pattern} in ${JSON.stringify(errors)}`);
  };
  broken((e) => (e.at = ['nebula']), /unknown kind of point "nebula"/);
  broken((e) => (e.when = { fact: 'wealth' }), /no fact "wealth"/);
  broken((e) => (e.text = 'Hello {stranger}.'), /nothing called "\{stranger\}"/);
  broken((e) => (e.cast = { place: {} }), /already the name of something/);
  broken((e) => (e.cast = { scout: { skill: 'cooking' } }), /no skill "cooking"/);
  broken((e) => (e.choices[0].outcomes[0].effects = [{ do: 'contact', encounter: 'ghost-ship' }]), /no encounter "ghost-ship"/);
  broken((e) => (e.choices[0].outcomes[0].effects = [{ do: 'event', event: 'test.gone' }]), /no event "test.gone"/);
  broken((e) => (e.choices[0].outcomes[0].text = '{medic} helps.'), /nothing called "\{medic\}"/);
  broken((e) => (e.choices[0].label = '{medic} helps'), /nothing called "\{medic\}"/);
  broken((e) => e.choices.forEach((c) => (c.requires = { fact: 'money', gte: 1 })), /at least one choice must have no "requires"/);
  broken((e) => (e.choices[0].outcomes[0].when = { fact: 'money', gte: 1 }), /at least one outcome must have no "when"/);
  broken((e) => (e.choices[1].id = 'go'), /already has a choice with that id/);
  broken((e) => (e.choices[0].outcomes = []), /at least one outcome/);
  broken((e) => (e.choices[0].extra = 1), /unknown key "extra"/);
  broken((e) => delete e.at, /can never be met/);
  // A name a requirement remembers is in reach of that choice's outcomes, and only those.
  const scoped = structuredClone(good);
  scoped.choices[0].requires = { crew: { skill: 'medicine' }, as: 'medic' };
  scoped.choices[0].outcomes[0].text = '{medic} helps.';
  assert.deepEqual(withEvent(scoped), []);
  scoped.choices[1].outcomes[0].text = '{medic} helps.';
  assert.ok(withEvent(scoped).some((error) => /choice "no".*nothing called "\{medic\}"/.test(error)));
});

test('a name bound by the event-level "when" is not in reach of its text or choices: cast it instead', () => {
  const event = doing([{ do: 'hurt', crew: '$medic', amount: 0.1 }], { when: { crew: { skill: 'medicine' }, as: 'medic' }, title: 'Ask {medic}' });
  const problems = checkEvent(event, REFS);
  assert.ok(problems.some((p) => p.includes('medic')), problems.join('; '));
  assert.deepEqual(checkEvent({ ...event, when: undefined, cast: { medic: { skill: 'medicine' } } }, REFS).filter((p) => p.includes('medic')), []);
});
