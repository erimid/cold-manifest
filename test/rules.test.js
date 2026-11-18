// Rules as content (S3.3, D-110): the crew's memories and refusals and Margo's risks are data in the
// condition language. The behaviour itself is tested in memory.test.js and judgement.test.js; this
// file tests that it really is the content that decides, and that the checker reads it.

import assert from 'node:assert/strict';
import test from 'node:test';

import { riskOf } from '../src/ai/judgement.js';
import { gatherRefs, validateContent } from '../src/engine/content-schema.js';
import { RISK_ROOMS, buildRules, checkRule } from '../src/narrative/rules.js';
import { killCrew } from '../src/sim/atmosphere.js';
import { memoryTypes, refusalOf, remember, topMemory } from '../src/sim/memory.js';
import { COMMAND_TYPES, createSim } from '../src/sim/sim.js';
import { readContentFiles } from '../tools/lib/load-content.js';
import { CATALOG, CREW, LINES, RULES, SHIP } from './helpers.js';

const FILES = readContentFiles();
const REFS = gatherRefs(FILES);
const simWith = (rules, extra = {}) => {
  const sim = createSim({ seed: 'rules', ship: SHIP, crew: CREW, ...CATALOG, rules, ...extra });
  sim.step();
  return sim;
};
const strip = ({ _file, ...item }) => item;

test('the rules in content pass their own checks, and cover what S2.10 hard-coded', () => {
  for (const item of RULES.memories) assert.deepEqual(checkRule('memory', strip(item), REFS), [], item.id);
  for (const item of RULES.refusals) assert.deepEqual(checkRule('refusal', strip(item), REFS), [], item.id);
  for (const item of RULES.risks) assert.deepEqual(checkRule('risk', strip(item), REFS), [], item.id);
  assert.deepEqual(RULES.memories.map((item) => item.id), ['death', 'burn', 'choke', 'wound', 'scare', 'override', 'kindness', 'slight', 'wrong', 'quarrel', 'spat', 'amends', 'help', 'hunger']); // seven from F.6, then F.7's hunger
  assert.deepEqual(buildRules(RULES).refusals.map((item) => item.id), ['grave', 'burn', 'choke', 'dark', 'override', 'feud', 'sour']);
  assert.deepEqual(buildRules(RULES).risks.map((item) => item.id), ['jettison_crew', 'vent_crew', 'vent_room_crew', 'vent_near', 'air_cut', 'into_fire', 'into_vacuum']);
  for (const item of RULES.risks) assert.ok(COMMAND_TYPES.includes(item.on) && RISK_ROOMS[item.rooms]);
});

test('with no rules nobody remembers, refuses or objects', () => {
  const sim = simWith({}, { lines: LINES });
  assert.deepEqual(memoryTypes(sim), []);
  sim.state.rooms.medbay.fire = 0.9;
  sim.state.crew.okoro.room = 'medbay';
  killCrew(sim, 'okoro', 'fire');
  assert.deepEqual(sim.state.crew.dace.memories, []);
  assert.equal(refusalOf(sim, sim.state.crew.dace, 'medbay'), null);
  assert.equal(riskOf(sim, { type: 'room.jettison', room: 'reactor' }), null);
  assert.throws(() => remember(sim, sim.state.crew.dace, 'death'), /Unknown memory type/);
});

test('a new kind of memory, refusal and risk is a content edit, not a code change', () => {
  const rules = {
    memories: [...RULES.memories, { id: 'brig', seconds: 60, text: 'a night in {room}', bare: 'a night locked up', on: [{ event: 'door.changed', to: 'everyone', when: { fact: 'event', field: 'to', eq: 'locked' } }] }],
    refusals: [{ id: 'cell', order: 0, when: [{ memory: { type: 'brig' }, as: 'memory' }, { fact: 'crew.room', crew: '$crew', ne: '$room' }, { fact: 'room.crew', room: '$room', eq: 0 }], reason: '{crew} will not sit in {room} alone. Not after {memory}.' }, ...RULES.refusals],
    risks: [{ id: 'dark_ship', order: 0, grave: false, on: 'lights.all', rooms: 'ship', when: [{ fact: 'order', field: 'on', eq: false }, { fact: 'room.crew', room: '$room', gte: 1 }], crew: { in: '$room', skill: 'medicine' } }, ...RULES.risks],
  };
  for (const item of rules.memories) assert.deepEqual(checkRule('memory', strip(item), { ...REFS, memories: new Set([...REFS.memories, 'brig']) }), []);
  assert.deepEqual(checkRule('refusal', rules.refusals[0], { ...REFS, memories: new Set(['brig']) }), []);
  assert.deepEqual(checkRule('risk', rules.risks[0], REFS), []);
  const sim = simWith(rules);
  const door = sim.layout.doors.find((one) => !one.airlock).id;
  sim.enqueue({ type: 'door.set', door, state: 'locked' });
  sim.step();
  assert.equal(topMemory(sim, sim.state.crew.ilse), 'a night locked up', 'the event named no room');
  assert.deepEqual(refusalOf(sim, sim.state.crew.ilse, 'brig').reason, 'Ilse will not sit in Brig alone. Not after a night locked up.');
  assert.equal(refusalOf(sim, sim.state.crew.ilse, 'shields'), null, 'Halloran is in there');
  assert.equal(refusalOf(sim, sim.state.crew.ilse, 'reactor'), null, 'Dace is in there');
  assert.deepEqual(riskOf(sim, { type: 'lights.all', on: false }), { id: 'dark_ship', grave: false, room: 'quarters', crew: ['okoro'] });
  assert.equal(riskOf(sim, { type: 'lights.all', on: true }), null);
});

test('the check refuses a rule that could not work', () => {
  const bad = (kind, item, pattern) => assert.ok(checkRule(kind, item, REFS).some((problem) => pattern.test(problem)), `${pattern} in ${JSON.stringify(checkRule(kind, item, REFS))}`);
  const memory = strip(RULES.memories[0]);
  bad('memory', { ...memory, seconds: 0 }, /seconds must be above 0/);
  bad('memory', { ...memory, text: '{crew} dying' }, /only \{who\} and \{room\}/);
  bad('memory', { ...memory, shadow: 'sometimes' }, /shadow must be one of/);
  bad('memory', { ...memory, on: [{ event: 'crew.died', to: 'nobody' }] }, /to must be one of/);
  bad('memory', { ...memory, on: [{ event: 'crew.died', to: 'everyone', when: { fact: 'room.fire', room: '$room', gt: 0 } }] }, /nothing called "\$room"/);
  bad('memory', { ...memory, colour: 'red' }, /unknown key "colour"/);
  const refusal = strip(RULES.refusals[0]);
  bad('refusal', { ...refusal, when: undefined }, /needs "when"/);
  bad('refusal', { ...refusal, reason: '{crew} fears {ghost}.' }, /nothing called "\{ghost\}"/);
  bad('refusal', { ...refusal, when: [{ memory: { type: 'birthday' }, as: 'memory' }] }, /no memory "birthday"/);
  bad('refusal', { ...refusal, reason: '{memory.regret}' }, /no kind of memory has a "regret" phrase/);
  const risk = strip(RULES.risks[0]);
  bad('risk', { ...risk, on: 'ship.explode' }, /no order "ship.explode"/);
  bad('risk', { ...risk, rooms: 'everywhere' }, /rooms must be one of/);
  bad('risk', { ...risk, grave: 'very' }, /grave must be true/);
  bad('risk', { ...risk, crew: undefined }, /needs "crew"/);
  bad('risk', { ...risk, crew: { in: '$crew' } }, /nothing called "\$crew"/);
});

test('the content check reads conditions wherever content carries them', () => {
  const errorsWith = (path, item) => validateContent([...FILES, { path, data: { items: [item] } }]).errors;
  const line = { id: 'x.line', category: 'idle', text: 'Quiet.' };
  assert.deepEqual(errorsWith('ai-lines/x.json', { ...line, conditions: { when: { fact: 'trust', gte: 70 } } }), []);
  assert.match(errorsWith('ai-lines/x.json', { ...line, conditions: { when: { fact: 'mood', gte: 70 } } })[0], /no fact "mood"/);
  assert.match(errorsWith('ai-lines/x.json', { ...line, conditions: { trigger: 'tea.time' } })[0], /nothing called "tea.time"/);
  assert.match(errorsWith('ai-lines/x.json', { ...line, conditions: { risk: 'boredom' } })[0], /no risk "boredom"/);
  assert.match(errorsWith('ai-lines/x.json', { ...line, conditions: { mood: 'bad' } })[0], /unknown key "mood"/);
  assert.match(errorsWith('crew/x.json', { id: 'x', name: 'X', skills: { cooking: 2 } })[0], /no skill "cooking"/);
  assert.match(errorsWith('crew/x.json', { id: 'x', name: 'X', skills: { medicine: 9 } })[0], /from 1 to 5/);
  assert.match(errorsWith('crew/x.json', { id: 'x', name: 'X', traits: ['coward'] })[0], /no trait "coward"/);
  assert.match(errorsWith('refusals/x.json', { id: 'x', when: { fact: 'room.fire', room: 'ballroom' }, reason: 'No.' })[0], /no room "ballroom"/);
  assert.match(errorsWith('risks/x.json', { id: 'x', grave: true, on: 'crew.move', rooms: 'ship', crew: { skill: 'cooking' } })[0], /no skill "cooking"/);
});

test('a refusal that names no memory still refuses, and says so on the bus', () => {
  const rule = { id: 'hot', order: 0, when: [{ fact: 'room.fire', room: '$room', gte: 0.9 }], reason: '{crew} will not go into {room}.' };
  assert.deepEqual(checkRule('refusal', rule, REFS), []);
  const sim = simWith({ ...RULES, refusals: [rule], risks: [] });
  sim.state.rooms.medbay.fire = 1;
  const heard = [];
  sim.events.on('crew.refused', (event) => heard.push(event));
  sim.enqueue({ type: 'crew.move', crew: 'ilse', room: 'medbay' });
  sim.step();
  assert.equal(heard.length, 1);
  assert.equal(heard[0].memory, null);
  assert.equal(heard[0].reason, 'Ilse will not go into Medbay.');
});
