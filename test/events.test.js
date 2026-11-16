// Transit events (S3.3, D-111): meeting them on the chart, choices and their tags, outcomes and effects,
// the hooks into combat, scenes and the threat, and what the content checker catches.

import assert from 'node:assert/strict';
import test from 'node:test';

import { gatherRefs, validateContent } from '../src/engine/content-schema.js';
import { hashState } from '../src/engine/hash.js';
import { validateEffects, EFFECTS } from '../src/narrative/effects.js';
import { checkEvent, eventView, whyNoChoice } from '../src/narrative/events.js';
import { recall } from '../src/sim/memory.js';
import { neighbours, nodeOf, whyNoCourseJump } from '../src/sim/sector.js';
import { checkInvariants, createSim } from '../src/sim/sim.js';
import { readContentFiles } from '../tools/lib/load-content.js';
import { CATALOG, CREW, EVENTS, SHIP, content } from './helpers.js';

const REACH = content.require('sectors', 'the-reach');
const FILES = readContentFiles();
const REFS = gatherRefs(FILES);
const runSim = (events = EVENTS, seed = 'events', sector = REACH) => {
  const sim = createSim({ seed, ship: SHIP, crew: CREW, ...CATALOG, sector, events, run: { pursuit: false } });
  sim.step();
  return sim;
};
const give = (sim, ...commands) => {
  for (const command of commands) sim.enqueue(command);
  sim.step();
};
/** A one-choice event that does `effects`, for trying effects one at a time. */
const doing = (effects, extra = {}) => ({ id: 'test.one', title: 'Test', text: 'Test.', at: ['empty'], choices: [{ id: 'go', label: 'Go', outcomes: [{ text: 'Done.', effects }] }], ...extra });
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
function fly(sim, to) {
  sim.enqueue({ type: 'course.plot', to });
  for (let i = 0; i < 4000 && whyNoCourseJump(sim); i++) sim.step();
  sim.enqueue({ type: 'course.jump' });
  sim.step();
}

test('every event in content passes its own check', () => {
  assert.ok(EVENTS.length >= 7);
  for (const { _file, ...event } of EVENTS) assert.deepEqual(checkEvent(event, REFS), [], event.id);
});

test('arriving somewhere for the first time can bring an event of the right kind; with no events nothing opens', () => {
  const always = { ...REACH, events: { empty: 1, hazard: 1, derelict: 1, checkpoint: 1 } };
  const sim = runSim(EVENTS, 'arrive', always);
  const opened = heard(sim, 'event.opened');
  const run = sim.state.run;
  assert.equal(eventView(sim), null, 'nothing at the origin');
  const to = neighbours(run.map, run.at).find((id) => nodeOf(run.map, id).kind !== 'port');
  fly(sim, to);
  const kind = nodeOf(run.map, to).kind;
  const view = eventView(sim);
  assert.ok(view, `an event at a ${kind}`);
  assert.equal(opened.length, 1);
  assert.ok(content.require('events', view.id).at.includes(kind));
  assert.ok(view.choices.length >= 2 && view.choices.some((choice) => choice.available));
  assert.equal(view.result, null);
  assert.deepEqual(run.events.met, [view.id]);
  assert.deepEqual(checkInvariants(sim), []);

  const quiet = runSim([], 'arrive', always);
  fly(quiet, to);
  assert.equal(eventView(quiet), null);
  const never = runSim(EVENTS, 'arrive', { ...REACH, events: { empty: 0, hazard: 0, derelict: 0, checkpoint: 0 } });
  fly(never, to);
  assert.equal(eventView(never), null, 'the sector says how likely an event is');
});

test('a point is only rolled for once, an event is met once a run, and jumping away leaves an open event behind', () => {
  const sector = { ...REACH, events: { empty: 1, hazard: 1, derelict: 1, checkpoint: 1 } };
  const sim = runSim([doing([]), { ...doing([]), id: 'test.two' }], 'once', sector);
  const run = sim.state.run;
  const lapsed = heard(sim, 'event.lapsed');
  // Make every point open space so both test events fit everywhere.
  for (const node of run.map.nodes) if (node.id !== run.map.start) node.kind = 'empty';
  const home = run.at;
  const first = neighbours(run.map, home)[0];
  fly(sim, first);
  const met = eventView(sim).id;
  fly(sim, home);
  assert.equal(lapsed.length, 1, 'we left it unanswered');
  assert.equal(eventView(sim), null);
  fly(sim, first);
  assert.equal(eventView(sim), null, 'the dice for that point have been thrown');
  const second = neighbours(run.map, first).find((id) => id !== home);
  fly(sim, second);
  assert.ok(eventView(sim) && eventView(sim).id !== met, 'the other event, not the same one again');
  assert.deepEqual(checkInvariants(sim), []);
});

test('a choice shows who meets its requirement, is locked with what is missing, or is hidden', () => {
  const sim = runSim();
  give(sim, { type: 'debug.event', event: 'hazard.loud-lane' });
  let view = eventView(sim);
  assert.match(view.title, /: /);
  assert.ok(!/[{}]/.test(view.title + view.text), 'every slot is filled');
  const byId = () => Object.fromEntries(eventView(sim).choices.map((choice) => [choice.id, choice]));
  assert.deepEqual(byId()['press-on'], { id: 'press-on', label: 'Hold the course and take what comes', tag: null, available: true });
  assert.equal(byId().thread.tag, '[Ilse, Piloting]');
  assert.equal(byId().sweep.tag, '[Sensors powered]');
  assert.equal(whyNoChoice(sim, 'thread'), null);
  sim.state.crew.ilse.alive = false;
  sim.state.systems.sensors.power = 0;
  assert.deepEqual(byId().thread, { id: 'thread', label: 'Let the best hands aboard fly it', tag: '[Needs Piloting 2]', available: false });
  assert.equal(byId().sweep.tag, '[Needs Sensors powered]');
  assert.match(whyNoChoice(sim, 'thread'), /not open to us/);
  assert.throws(() => sim.enqueue({ type: 'event.choose', choice: 'thread' }), /not open to us/);
  assert.match(whyNoChoice(sim, 'dance'), /no choice "dance"/);

  give(sim, { type: 'debug.event', event: 'empty.beacon' });
  view = eventView(sim);
  assert.ok(!view.choices.some((choice) => choice.id === 'listen'), 'hidden until the sensors can do it');
  sim.state.systems.sensors.power = 2;
  assert.equal(byId().listen.tag, '[Sensors at 2 bars]');
});

test('a choice is answered once, its outcome is told, and the event is put away', () => {
  const sim = runSim();
  const chosen = heard(sim, 'event.chosen');
  const closed = heard(sim, 'event.closed');
  assert.throws(() => sim.enqueue({ type: 'event.choose', choice: 'leave' }), /no event is waiting/);
  assert.throws(() => sim.enqueue({ type: 'event.dismiss' }), /no event is open/);
  give(sim, { type: 'debug.event', event: 'derelict.cold-hull' });
  assert.throws(() => sim.enqueue({ type: 'event.dismiss' }), /still waiting for an answer/);
  const scout = sim.state.crew[sim.state.run.events.open.cast.scout].name;
  assert.ok(eventView(sim).text.includes(scout) && eventView(sim).choices[1].label.includes(scout), 'the cast is named');
  give(sim, { type: 'event.choose', choice: 'leave' });
  assert.equal(eventView(sim).result.choice, 'leave');
  assert.match(eventView(sim).result.text, /log the position/);
  assert.equal(chosen[0].text, eventView(sim).result.text);
  assert.throws(() => sim.enqueue({ type: 'event.choose', choice: 'board' }), /has been answered/);
  give(sim, { type: 'event.dismiss' });
  assert.equal(eventView(sim), null);
  assert.equal(closed.length, 1);
  assert.deepEqual(checkInvariants(sim), []);
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
  sim.state.crew.dace.skills.medicine = 3; // Okoro is the fighter and cannot treat himself: the best medic who is not him
  give(sim, { type: 'debug.event', event: 'test.one' });
  assert.equal(eventView(sim).choices[0].tag, '[Dace, Medicine]');
  give(sim, { type: 'event.choose', choice: 'go' });
  assert.equal(eventView(sim).result.text, 'Dace treats Okoro; Ilse watches.');
  assert.ok(Math.abs(sim.state.crew.okoro.health - 0.85) < 1e-9);
  assert.equal(recall(sim, sim.state.crew.ilse, 'wound').who, 'Okoro');
  // With nobody to cast, the event cannot be met at all.
  const empty = runSim([event]);
  empty.state.crew.okoro.alive = false;
  const uncast = heard(empty, 'event.uncast');
  give(empty, { type: 'debug.event', event: 'test.one' });
  assert.equal(eventView(empty), null);
  assert.equal(uncast.length, 1);
});

test('an outcome can start a fight, cue a scene, cue the threat, and lead on to another event', () => {
  let sim = play([{ do: 'fight', ship: 'salvager-skiff' }]);
  assert.equal(sim.state.fight.enemy.ship, 'salvager-skiff');
  assert.ok(eventView(sim).result, 'the outcome is still on the table to be read');
  give(sim, { type: 'event.dismiss' });
  assert.ok(sim.state.fight && !sim.state.fight.over, 'and the fight goes on');
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
  const playThrough = () => {
    const sim = runSim(EVENTS, 'replay');
    give(sim, { type: 'debug.event', event: 'derelict.cold-hull' });
    give(sim, { type: 'event.choose', choice: 'board' });
    return sim;
  };
  const a = playThrough();
  const b = playThrough();
  assert.equal(hashState(a.snapshot()), hashState(b.snapshot()));
  const mid = runSim(EVENTS, 'replay');
  give(mid, { type: 'debug.event', event: 'derelict.cold-hull' });
  const snap = mid.snapshot();
  const twin = runSim(EVENTS, 'replay');
  for (let i = 0; i < 50; i++) twin.step();
  twin.restore(snap);
  assert.deepEqual(eventView(twin), eventView(mid));
  give(twin, { type: 'event.choose', choice: 'board' });
  assert.equal(hashState(twin.snapshot()), hashState(a.snapshot()));
});

test('every effect checks what it is given', () => {
  const env = { vars: { scout: 'crew', place: 'text' }, refs: REFS };
  const bad = (effects) => validateEffects(effects, env)[0] ?? '';
  assert.deepEqual(validateEffects([{ do: 'hurt', crew: '$scout', amount: 0.3 }, { do: 'fire', room: { of: '$scout' } }, { do: 'fight', ship: 'knife-cutter' }, { do: 'threat' }, { do: 'intel', text: 'At {place}.' }], env), []);
  assert.match(bad([{ do: 'explode' }]), /no effect "explode"/);
  assert.match(bad([{ do: 'money' }]), /needs "add"/);
  assert.match(bad([{ do: 'money', add: 0 }]), /whole number, not 0/);
  assert.match(bad([{ do: 'money', add: 5, to: 'me' }]), /has no "to"/);
  assert.match(bad([{ do: 'hurt', crew: '$medic', amount: 0.3 }]), /nothing called "\$medic"/);
  assert.match(bad([{ do: 'hurt', crew: 'ilse', amount: 3 }]), /at most 1/);
  assert.match(bad([{ do: 'fire', room: 'ballroom' }]), /no room "ballroom"/);
  assert.match(bad([{ do: 'damage', system: 'warp' }]), /no system "warp"/);
  assert.match(bad([{ do: 'remember', crew: 'all', memory: 'birthday' }]), /no memory "birthday"/);
  assert.match(bad([{ do: 'fight', ship: 'margin-of-error' }]), /no ship "margin-of-error"/, 'only a ship that can be fought');
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
  broken((e) => (e.choices[0].outcomes[0].effects = [{ do: 'fight', ship: 'ghost-ship' }]), /no ship "ghost-ship"/);
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
