// The condition language (S3.3, D-109): matching, names in reach, requirement tags, text, and the checks.

import assert from 'node:assert/strict';
import test from 'node:test';

import { checkCrewSpec, crewMatching, fillText, holds, match, requirement, resolve, validateCondition, validateText, vars } from '../src/narrative/conditions.js';
import { FACTS } from '../src/narrative/facts.js';
import { gatherRefs } from '../src/engine/content-schema.js';
import { remember } from '../src/sim/memory.js';
import { readContentFiles } from '../tools/lib/load-content.js';
import { newCrewedSim } from './helpers.js';

const REFS = gatherRefs(readContentFiles());
/** Ilse on the bridge (piloting 2, negotiation 1), Dace in the reactor (engineering 2), Okoro in quarters (medicine 2). */
const started = () => {
  const sim = newCrewedSim();
  sim.step();
  return sim;
};
const on = (sim, names = {}) => ({ sim, vars: vars(names) });
const problemsOf = (cond, names = {}) => validateCondition(cond, { vars: names, refs: REFS }).problems;

test('a missing condition holds; all, any and not combine; a list means all', () => {
  const sim = started();
  const yes = { fact: 'money', gte: 0 };
  const no = { fact: 'money', lt: 0 };
  assert.ok(holds(undefined, on(sim)));
  assert.ok(holds([yes, yes], on(sim)));
  assert.ok(!holds([yes, no], on(sim)));
  assert.ok(holds({ any: [no, yes] }, on(sim)));
  assert.ok(!holds({ any: [no, no] }, on(sim)));
  assert.ok(holds({ not: no }, on(sim)));
  assert.ok(!holds({ all: [yes, { not: yes }] }, on(sim)));
});

test('facts compare with eq ne gt gte lt lte in; with no comparison a number asks "above zero" and the rest ask "true"', () => {
  const sim = started();
  sim.state.money = 120;
  assert.ok(holds({ fact: 'money', eq: 120 }, on(sim)));
  assert.ok(holds({ fact: 'money', gt: 100, lte: 120 }, on(sim)), 'two comparisons make a range');
  assert.ok(!holds({ fact: 'money', gt: 100, lt: 120 }, on(sim)));
  assert.ok(holds({ fact: 'money', in: [60, 120] }, on(sim)));
  assert.ok(holds({ fact: 'money' }, on(sim)));
  sim.state.money = 0;
  assert.ok(!holds({ fact: 'money' }, on(sim)));
  assert.ok(holds({ fact: 'crew.room', crew: 'dace', eq: 'reactor' }, on(sim)));
  assert.ok(!holds({ fact: 'fight' }, on(sim)));
  sim.state.rooms.medbay.fire = 0.4;
  assert.ok(holds({ fact: 'room.fire', room: 'medbay', gte: 0.2 }, on(sim)));
});

test('something that is not there is not equal to anything, and nothing else can be said of it', () => {
  const sim = started();
  assert.ok(!holds({ fact: 'room.fire', room: 'ballroom', gte: 0 }, on(sim)));
  assert.ok(!holds({ fact: 'room.fire', room: 'ballroom', lt: 1 }, on(sim)));
  assert.ok(!holds({ fact: 'fuel' }, on(sim)), 'no chart, so no fuel to speak of');
  assert.ok(holds({ fact: 'order', field: 'ship', ne: 'them' }, on(sim, { order: ['data', { type: 'crew.move' }] })));
  assert.ok(!holds({ fact: 'order', field: 'ship', eq: 'them' }, on(sim, { order: ['data', { type: 'crew.move' }] })));
});

test('names in reach stand in for ids, and can be reached into', () => {
  const sim = started();
  const ctx = on(sim, { crew: ['crew', 'okoro'], room: ['room', 'quarters'], order: ['data', { door: 'd1', crew: 'ilse' }] });
  assert.equal(resolve('$crew', ctx), 'okoro');
  assert.equal(resolve('$order.door', ctx), 'd1');
  assert.equal(resolve('$nobody', ctx), undefined);
  assert.equal(resolve('medbay', ctx), 'medbay');
  assert.ok(holds({ fact: 'crew.room', crew: '$crew', eq: '$room' }, ctx));
  assert.ok(holds({ fact: 'crew.room', crew: '$order.crew', eq: 'bridge' }, ctx));
});

test('a crew condition finds who fits, best at the skill first, and remembers them under a name', () => {
  const sim = started();
  assert.deepEqual(crewMatching({}, on(sim)).map((m) => m.id), ['ilse', 'dace', 'okoro', 'pruitt', 'halloran', 'vesna']);
  assert.deepEqual(crewMatching({ skill: 'medicine' }, on(sim)).map((m) => m.id), ['okoro']);
  assert.deepEqual(crewMatching({ skill: 'medicine', min: 4 }, on(sim)), []);
  assert.deepEqual(crewMatching({ in: 'reactor', suit: false }, on(sim)).map((m) => m.id), ['dace']);
  assert.deepEqual(crewMatching({ engineer: true }, on(sim)).map((m) => m.id), ['dace']);
  assert.deepEqual(crewMatching({ not: 'ilse', away: 'reactor' }, on(sim)).map((m) => m.id), ['okoro', 'pruitt', 'halloran', 'vesna']);
  assert.deepEqual(crewMatching({ where: { fact: 'crew.skill', crew: '$this', skill: 'piloting', gte: 2 } }, on(sim)).map((m) => m.id), ['ilse']);
  sim.state.crew.dace.skills.medicine = 4;
  assert.deepEqual(crewMatching({ skill: 'medicine' }, on(sim)).map((m) => m.id), ['dace', 'okoro'], 'the better medic comes first');

  const found = match({ crew: { skill: 'medicine' }, as: 'medic' }, on(sim));
  assert.deepEqual(found.medic, { type: 'crew', value: 'dace' });
  assert.ok(holds({ crew: {}, count: 6 }, on(sim)));
  assert.ok(!holds({ crew: {}, count: 7 }, on(sim)));
  // What one condition remembers, the next in the list can use.
  assert.ok(holds([{ crew: { skill: 'piloting' }, as: 'pilot' }, { fact: 'crew.room', crew: '$pilot', eq: 'bridge' }], on(sim)));
  sim.state.crew.okoro.alive = false;
  assert.deepEqual(crewMatching({}, on(sim)).map((m) => m.id), ['ilse', 'dace', 'pruitt', 'halloran', 'vesna'], 'the dead fit nothing');
});

test('a memory condition finds the newest memory that fits and has not faded', () => {
  const sim = started();
  const dace = sim.state.crew.dace;
  const ctx = on(sim, { crew: ['crew', 'dace'], room: ['room', 'medbay'] });
  assert.ok(!holds({ memory: { type: 'burn' } }, ctx));
  remember(sim, dace, 'burn', { room: 'reactor' });
  remember(sim, dace, 'death', { room: 'medbay', who: 'Okoro' });
  assert.equal(match({ memory: { type: 'burn' }, as: 'm' }, ctx).m.value.room, 'reactor');
  assert.equal(match({ memory: { type: ['burn', 'death'] }, as: 'm' }, ctx).m.value.type, 'death', 'the newest of either');
  assert.ok(holds({ memory: { type: 'death', room: '$room' } }, ctx));
  assert.ok(!holds({ memory: { type: 'burn', room: '$room' } }, ctx));
  assert.ok(!holds({ memory: { shadow: true } }, ctx), 'neither happened in the dark');
  assert.ok(holds({ memory: { any: [{ type: 'wound' }, { dark: false }] } }, ctx));
  assert.ok(!holds({ memory: { type: 'burn' }, of: 'ilse' }, ctx), "someone else's head");
  for (let i = 0; i < 240 * 20; i++) sim.step();
  assert.ok(!holds({ memory: { type: 'burn' } }, ctx), 'faded');
  assert.ok(holds({ memory: { type: 'death' } }, ctx), 'a death lasts longer');
});

test('a requirement says who met it, "[Ilse, Piloting]", or what is missing, "[Needs Medicine 4]"', () => {
  const sim = started();
  assert.deepEqual(requirement(undefined, on(sim)), { met: true, tag: null, vars: {} });
  const pilot = requirement({ crew: { skill: 'piloting', min: 2 }, as: 'pilot' }, on(sim));
  assert.equal(pilot.tag, '[Ilse, Piloting]');
  assert.equal(pilot.vars.pilot.value, 'ilse');
  assert.equal(requirement({ crew: { id: 'okoro', skill: 'medicine' } }, on(sim)).tag, '[Okoro, Medicine]');
  assert.deepEqual(requirement({ crew: { skill: 'medicine', min: 4 } }, on(sim)), { met: false, tag: '[Needs Medicine 4]', vars: null });
  assert.equal(requirement({ crew: { engineer: true } }, on(sim)).tag, '[Dace, Engineer]');
  sim.state.crew.okoro.alive = false;
  assert.equal(requirement({ crew: { id: 'okoro', skill: 'medicine' } }, on(sim)).tag, '[Needs Okoro, Medicine]');
  // A fact has no words of its own: the label gives them.
  assert.equal(requirement({ fact: 'money', gte: 60, label: '60 credits' }, on(sim)).tag, '[60 credits]');
  sim.state.money = 10;
  assert.equal(requirement({ fact: 'money', gte: 60, label: '60 credits' }, on(sim)).tag, '[Needs 60 credits]');
  assert.equal(requirement({ fact: 'money', gte: 60 }, on(sim)).tag, '[Not possible now]');
  assert.equal(requirement([{ crew: { skill: 'piloting' } }, { fact: 'money', gte: 60, label: '60 credits' }], on(sim)).tag, '[Needs 60 credits]', 'only what is missing');
  assert.equal(requirement({ any: [{ crew: { skill: 'medicine' } }, { crew: { skill: 'engineering' } }] }, on(sim)).tag, '[Dace, Engineering]');
});

test('text names what is in reach: crew by name, rooms by their stencil, memories by their own words', () => {
  const sim = started();
  const memory = remember(sim, sim.state.crew.dace, 'death', { room: 'medbay', who: 'Okoro' });
  const ctx = on(sim, { crew: ['crew', 'dace'], room: ['room', 'life_support'], memory: ['memory', memory], place: ['text', 'KV-7'], order: ['data', { type: 'crew.move' }] });
  assert.equal(fillText('{crew} in {room} at {place}', ctx), 'Dace in Life support at KV-7');
  assert.equal(fillText('{memory.who}, {memory.room}, {memory}, {memory.shadow}', ctx), 'Okoro, Medbay, Okoro dying in Medbay, Okoro died in the dark');
  assert.equal(fillText('{order.type} {nobody}', ctx), 'crew.move {nobody}', 'a name that is not there is left as written');
});

test('the check refuses what could never work, and says where', () => {
  assert.deepEqual(problemsOf([{ fact: 'money', gte: 60 }, { crew: { skill: 'medicine', min: 2 }, as: 'medic' }, { fact: 'room.fire', room: 'medbay', gt: 0 }]), []);
  assert.match(problemsOf({ fact: 'wealth', gte: 1 })[0], /no fact "wealth"/);
  assert.match(problemsOf({ fact: 'room.fire', gt: 0 })[0], /needs "room"/);
  assert.match(problemsOf({ fact: 'room.fire', room: 'ballroom', gt: 0 })[0], /no room "ballroom"/);
  assert.match(problemsOf({ fact: 'room.fire', room: '$room', gt: 0 })[0], /nothing called "\$room" is in reach/);
  assert.deepEqual(problemsOf({ fact: 'room.fire', room: '$room', gt: 0 }, { room: 'room' }), []);
  assert.match(problemsOf({ fact: 'room.fire', room: '$crew', gt: 0 }, { crew: 'crew' })[0], /is a crew, and a room is wanted/);
  assert.match(problemsOf({ fact: 'money', gte: 'lots' })[0], /must be a number/);
  assert.match(problemsOf({ fact: 'money', eq: 'lots' })[0], /"money" is a number/);
  assert.match(problemsOf({ fact: 'money', gte: 1, more: true })[0], /unknown key "more"/);
  assert.match(problemsOf({ fact: 'system.power', system: 'warp', gte: 1 })[0], /no system "warp"/);
  assert.match(problemsOf({ crew: { skill: 'cooking' } })[0], /no skill "cooking"/);
  assert.match(problemsOf({ crew: { id: 'petrov' } })[0], /no crew "petrov"/);
  assert.match(problemsOf({ crew: { trait: 'coward' } })[0], /no trait "coward"/);
  assert.match(problemsOf({ crew: { min: 2 } })[0], /"min" needs a "skill"/);
  assert.match(problemsOf({ crew: { pick: 'random' } })[0], /only means something in an event's cast/);
  assert.match(problemsOf({ memory: { type: 'birthday' } }, { crew: 'crew' })[0], /no memory "birthday"/);
  assert.match(problemsOf({ memory: { type: 'burn' } })[0], /nothing called "\$crew"/, 'a memory needs a head to be in');
  assert.match(problemsOf({ any: [{ crew: {}, as: 'x' }, { fact: 'money' }] })[0], /cannot be counted on/);
  assert.match(problemsOf({ all: [], fact: 'money' })[0], /exactly one of/);
  assert.match(problemsOf('money')[0], /must be an object/);
  assert.deepEqual(validateCondition([{ crew: {}, as: 'a' }, { memory: {}, of: '$a', as: 'b' }], { vars: {}, refs: REFS }).binds, { a: 'crew', b: 'memory' });
  assert.deepEqual(checkCrewSpec({ pick: 'random', skill: 'combat' }, { refs: REFS }, 'cast.x', { cast: true }), []);
});

test('text is checked against the names in reach', () => {
  const env = { vars: { scout: 'crew', memory: 'memory', order: 'data', place: 'text' }, refs: REFS };
  assert.deepEqual(validateText('{scout} at {place}, {memory.who}, {memory.shadow}, {order.type}', env), []);
  assert.match(validateText('{medic} is here', env)[0], /nothing called "\{medic\}"/);
  assert.match(validateText('{scout.name}', env)[0], /reaches too far/);
  assert.match(validateText('{memory.regret}', env)[0], /no kind of memory has a "regret" phrase/);
  assert.match(validateText('{order}', env)[0], /needs a field/);
  assert.match(validateText('half {open', env)[0], /unbalanced/);
  assert.match(validateText('', env)[0], /missing/);
});

test('every fact says what it needs and what it gives, and answers on a plain ship without throwing', () => {
  const sim = started();
  const sample = { faction: 'receivers', room: 'medbay', crew: 'ilse', door: sim.layout.doors[0].id, system: 'sensors', skill: 'medicine', name: 'x', kind: 'ammo', field: 'type', event: 'none' };
  for (const [id, fact] of Object.entries(FACTS)) {
    assert.ok(['number', 'boolean', 'string', 'any'].includes(fact.value), `${id} says what it gives`);
    const args = Object.fromEntries(Object.keys(fact.args ?? {}).map((name) => [name, sample[name]]));
    for (const name of Object.keys(args)) assert.ok(args[name] !== undefined, `${id}: the test has no sample "${name}"`);
    const value = fact.get(sim, args, on(sim, { order: ['data', { type: 'x' }], event: ['data', { type: 'y' }] }));
    if (value !== undefined && fact.value !== 'any') assert.equal(typeof value, fact.value, `${id} gave ${value}`);
    assert.doesNotThrow(() => fact.get(sim, {}, on(sim)), `${id} with nothing to go on`);
  }
});
