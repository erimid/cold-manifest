// Crew remember (F.6, D-235 to D-239): what the captain chooses in a situation aboard becomes a memory with weight
// for the people it was about, moves what they think of the captain and of each other, and that changes how they
// answer an order, which orders they refuse, and who will go where.

import assert from 'node:assert/strict';
import test from 'node:test';

import { MOOD_REPLIES, validateContent } from '../src/engine/content-schema.js';
import { validateCondition } from '../src/narrative/conditions.js';
import { validateEffects } from '../src/narrative/effects.js';
import { nearestHand, openEvent, rememberedLine, situationViews } from '../src/narrative/events.js';
import { checkRule } from '../src/narrative/rules.js';
import { CAPTAIN, REGARD, feudsOf, moodOf, moveRegard, recall, refusalOf, regardOf, regardWord, remember, topMemory } from '../src/sim/memory.js';
import { checkInvariants, createSim } from '../src/sim/sim.js';
import { createIntercom } from '../src/ui/intercom.js';
import { readContentFiles } from '../tools/lib/load-content.js';
import { CATALOG, CREW, EVENTS, SHIP, castOff, content, dealWith, nearestPort, newCrewedSim, standIn } from './helpers.js';

const REACH = content.require('sectors', 'the-reach');
const REPLIES = Object.fromEntries(content.all('crew').map(({ id, replies }) => [id, replies]));

/** A sim under way on a quiet lane: no ships, no lane dice, no follower. */
function underWay(seed = 'remember') {
  const sim = createSim({ seed, ship: SHIP, crew: CREW, ...CATALOG, sector: REACH, events: EVENTS, encounters: content.all('encounters'), run: { pursuit: false } });
  for (const [id, risk] of Object.entries(sim.state.run.risks)) sim.state.run.risks[id] = { ...risk, contacts: 0, aboard: 0, strikes: undefined };
  sim.state.run.events.rolled.push(...sim.state.run.map.nodes.map((node) => node.id));
  castOff(sim, nearestPort(sim));
  return sim;
}
const give = (sim, ...commands) => {
  for (const command of commands) sim.enqueue(command);
  sim.step();
};
const hear = (sim, type) => {
  const heard = [];
  sim.events.on(type, (event) => heard.push(event));
  return heard;
};
/** Put a situation aboard and answer it with `choice`. Returns { one: its record as placed, text, view }. */
function settle(sim, id, choice) {
  assert.ok(openEvent(sim, id, { force: true }), `${id} opened`);
  const one = structuredClone(sim.state.run.events.aboard.at(-1));
  const text = dealWith(sim, one.n, () => choice, { dismiss: false });
  const view = situationViews(sim).find((item) => item.n === one.n);
  give(sim, { type: 'event.dismiss', situation: one.n });
  return { one, text, view };
}
/** Somebody of ours who is none of `but`. */
const someoneElse = (sim, ...but) => Object.values(sim.state.crew).find((member) => member.alive && !but.includes(member.id));
/** Stand everyone in the quarters, so a room is empty unless the test puts someone in it. */
const muster = (sim) => {
  for (const member of Object.values(sim.state.crew)) standIn(sim, member.id, 'quarters');
};

test('a choice in a situation is seen in a named crew member\'s later answer: letting a fight run sours both, and they say so', () => {
  const sim = underWay();
  const moved = hear(sim, 'crew.regard');
  const { one, view } = settle(sim, 'mess.fight', 'let');
  const first = sim.state.crew[one.cast.first];
  const second = sim.state.crew[one.cast.second];

  // The memory, with its weight, in the heads of the two it was about and nobody else's.
  assert.equal(topMemory(sim, first), `being left to fight it out with ${second.name}`);
  assert.equal(recall(sim, first, 'quarrel').about, second.id);
  assert.equal(regardOf(first), -2);
  assert.equal(regardOf(first, second.id), REGARD.feud);
  assert.equal(regardOf(second, first.id), REGARD.feud);
  const bystander = someoneElse(sim, first.id, second.id);
  assert.equal(regardOf(bystander), 0);
  assert.equal(bystander.memories.length, 0);
  assert.equal(moved.length, 4, 'each of the two thinks less of the other and of the captain');
  assert.deepEqual(view.result.remembered.sort(), [first.name, second.name].sort(), 'the card says whose heads it went into');
  assert.match(rememberedLine(view.result.remembered), / and .* will remember this\.$/);
  assert.deepEqual(feudsOf(sim, first), [second.name]);

  // Later: an ordinary order. They go, and the answer names what the captain chose.
  muster(sim);
  const ordered = hear(sim, 'crew.ordered');
  give(sim, { type: 'crew.move', crew: first.id, room: 'cargo' });
  assert.equal(ordered.length, 1);
  assert.equal(ordered[0].mood, 'sour');
  assert.equal(ordered[0].remembers, `being left to fight it out with ${second.name}`);
  const reply = createIntercom(REPLIES).reply(ordered[0], 'Main hold');
  assert.equal(reply.kind, 'sour');
  assert.ok(reply.text.includes(`being left to fight it out with ${second.name}`), reply.text);
  assert.ok(!REPLIES[first.id].move.includes(reply.text), 'not one of their ordinary answers');

  // Somebody it was not about answers as they always did.
  give(sim, { type: 'crew.move', crew: bystander.id, room: 'cargo' });
  assert.equal(ordered[1].mood, null);
  assert.equal(createIntercom(REPLIES).reply(ordered[1], 'Main hold').kind, 'move');
  assert.deepEqual(checkInvariants(sim), []);
});

test('who will go where: nobody is shut in a room with the crewmate they fought, and the nearest hand is somebody else', () => {
  const sim = underWay('feud');
  const { one } = settle(sim, 'mess.fight', 'let');
  const [first, second] = [sim.state.crew[one.cast.first], sim.state.crew[one.cast.second]];
  const third = someoneElse(sim, first.id, second.id);
  muster(sim);
  standIn(sim, second.id, 'medbay');
  standIn(sim, first.id, 'cargo');

  const refused = hear(sim, 'crew.refused');
  give(sim, { type: 'crew.move', crew: first.id, room: 'medbay' });
  assert.equal(refused.length, 1);
  assert.equal(refused[0].rule, 'feud');
  assert.equal(refused[0].reason, `${first.name} won't be shut in Medbay with ${second.name}. Not after the fight with ${second.name}.`);
  assert.equal(first.task, 'idle', 'they stay where they are');

  // The hand picked for a job in that room is never the one who would refuse it.
  for (const member of Object.values(sim.state.crew)) if (![first.id, second.id].includes(member.id)) standIn(sim, member.id, 'bridge');
  assert.notEqual(nearestHand(sim, 'medbay', (member) => member.id !== second.id)?.id, first.id);
  assert.equal(nearestHand(sim, 'cargo')?.id, first.id, 'they are still the nearest hand for anywhere else');

  // A third in the room, or the other asleep in their bunk, and they will go.
  standIn(sim, third.id, 'medbay');
  assert.equal(refusalOf(sim, first, 'medbay'), null);
  standIn(sim, third.id, 'bridge');
  second.asleep = true;
  assert.equal(refusalOf(sim, first, 'medbay'), null);
  second.asleep = false;
  assert.equal(refusalOf(sim, first, 'medbay')?.rule, 'feud');
  // Parting them leaves words, not a feud.
  const calm = underWay('feud');
  const parted = settle(calm, 'mess.fight', 'part').one;
  assert.equal(regardOf(calm.state.crew[parted.cast.first], parted.cast.second), -2);
  assert.deepEqual(feudsOf(calm, calm.state.crew[parted.cast.first]), []);
  assert.equal(regardOf(calm.state.crew[parted.cast.first]), 0, 'and nothing is held against the captain');
});

test('somebody who has soured on the captain will not walk into danger for them, and says what they remember', () => {
  const sim = underWay('sour');
  const { one } = settle(sim, 'quarters.nerves', 'order');
  const shaky = sim.state.crew[one.cast.shaky];
  assert.equal(regardOf(shaky), -2);
  assert.equal(regardWord(regardOf(shaky)), 'cool');
  muster(sim);
  sim.state.rooms.cargo.fire = 0.4;
  assert.equal(refusalOf(sim, shaky, 'cargo'), null, 'one slight: they answer shortly, but they go');

  // The second slight, and they have had enough.
  remember(sim, shaky, 'slight', { says: 'a day\'s pay docked over the fight' });
  assert.equal(regardOf(shaky), REGARD.sour);
  assert.equal(regardWord(regardOf(shaky)), 'sour');
  const refused = hear(sim, 'crew.refused');
  give(sim, { type: 'crew.move', crew: shaky.id, room: 'cargo' });
  assert.equal(refused[0]?.rule, 'sour');
  assert.equal(refused[0].reason, `${shaky.name} won't walk into that for this captain. Not after a day's pay docked over the fight.`);
  // Anybody else goes, and so do they once the room is safe.
  assert.equal(refusalOf(sim, someoneElse(sim, shaky.id), 'cargo'), null);
  sim.state.rooms.cargo.fire = 0;
  assert.equal(refusalOf(sim, shaky, 'cargo'), null);
  // A kindness mends it.
  sim.state.rooms.cargo.fire = 0.4;
  remember(sim, shaky, 'kindness');
  assert.equal(refusalOf(sim, shaky, 'cargo'), null);
});

test('a kindness is remembered too: they answer gladly, think better of who sat with them, and loyalty takes them past an old fright', () => {
  const sim = underWay('warm');
  const { one, view } = settle(sim, 'quarters.nerves', 'sit');
  const shaky = sim.state.crew[one.cast.shaky];
  assert.equal(regardOf(shaky), 2);
  assert.equal(view.result.remembered[0], shaky.name);
  const sitter = Object.keys(shaky.regard).find((of) => of !== CAPTAIN);
  assert.ok(sitter && sitter !== shaky.id, 'whoever sat with them');
  assert.equal(regardOf(shaky, sitter), 2);
  assert.deepEqual(moodOf(sim, shaky), { mood: 'warm', remembers: 'the company when the nerve went' });

  muster(sim);
  const ordered = hear(sim, 'crew.ordered');
  give(sim, { type: 'crew.move', crew: shaky.id, room: 'cargo' });
  const reply = createIntercom(REPLIES).reply(ordered[0], 'Main hold');
  assert.equal(reply.kind, 'warm');
  assert.ok(reply.text.includes('the company when the nerve went'), reply.text);

  // Burned once, unsuited, and the hold is on fire: they refuse, until they think enough of the captain.
  muster(sim);
  remember(sim, shaky, 'burn', { room: 'medbay' });
  sim.state.rooms.cargo.fire = 0.4;
  assert.equal(refusalOf(sim, shaky, 'cargo')?.rule, 'burn');
  remember(sim, shaky, 'kindness');
  assert.equal(regardOf(shaky), REGARD.loyal);
  assert.equal(regardWord(regardOf(shaky)), 'loyal');
  assert.equal(refusalOf(sim, shaky, 'cargo'), null, 'for this captain they go');
});

test('leaving a situation alone is a choice as well: whoever it was about remembers that nobody came', () => {
  const sim = underWay('lapse');
  assert.ok(openEvent(sim, 'quarters.nerves', { force: true }));
  const one = sim.state.run.events.aboard.at(-1);
  const shaky = sim.state.crew[one.cast.shaky];
  for (const member of Object.values(sim.state.crew)) if (member.id !== shaky.id) standIn(sim, member.id, 'bridge');
  if (shaky.room === 'bridge') standIn(sim, shaky.id, 'quarters');
  one.room = shaky.room;
  one.left = 0.001;
  for (let i = 0; i < 5 && !one.result; i++) sim.step();
  assert.ok(one.result?.lapsed);
  assert.equal(topMemory(sim, shaky), 'being left alone with the fear');
  assert.equal(regardOf(shaky), -2);
  assert.deepEqual(situationViews(sim).find((item) => item.n === one.n).result.remembered, [shaky.name]);
});

test('regard is kept within bounds, is part of the state, and a ship with no rules has nobody who remembers', () => {
  const sim = underWay('bounds');
  const ilse = sim.state.crew.ilse;
  for (let i = 0; i < 9; i++) remember(sim, ilse, 'wrong');
  assert.equal(regardOf(ilse), REGARD.min);
  moveRegard(sim, ilse, 'dace', 99);
  assert.equal(regardOf(ilse, 'dace'), REGARD.max);
  remember(sim, ilse, 'quarrel', { who: 'Ilse', about: 'ilse' });
  assert.equal(ilse.regard.ilse, undefined, 'nobody has a view of themselves');
  assert.deepEqual(checkInvariants(sim), []);
  const copy = createSim({ seed: 'bounds', ship: SHIP, crew: CREW, ...CATALOG, sector: REACH, events: EVENTS, encounters: content.all('encounters'), run: { pursuit: false } });
  copy.restore(JSON.parse(JSON.stringify(sim.snapshot())));
  assert.deepEqual(copy.state.crew.ilse.regard, ilse.regard);
  // An override is remembered against the captain (D-102), a little.
  const dace = sim.state.crew.dace;
  remember(sim, dace, 'override', { room: 'medbay' });
  assert.equal(regardOf(dace), -1);

  const bare = createSim({ seed: 'bare', ship: SHIP, crew: CREW, weapons: CATALOG.weapons, ships: CATALOG.ships, sector: REACH, events: EVENTS, run: { pursuit: false } });
  castOff(bare, nearestPort(bare));
  assert.ok(openEvent(bare, 'quarters.nerves', { force: true }));
  const shaky = bare.state.crew[bare.state.run.events.aboard.at(-1).cast.shaky];
  dealWith(bare, bare.state.run.events.aboard.at(-1).n, () => 'order');
  assert.deepEqual([shaky.memories, shaky.regard], [[], {}]);
  assert.equal(moodOf(newCrewedSim(), newCrewedSim().state.crew.ilse).mood, null);
});

test('the checker reads the new parts of the language, and refuses them where they are wrong', () => {
  const kind = { id: 'test', seconds: 60, text: 'a thing', captain: -2, toward: 3 };
  assert.deepEqual(checkRule('memory', kind), []);
  assert.match(checkRule('memory', { ...kind, captain: 0 }).join('\n'), /captain must be a whole number from -5 to 5, not 0/);
  assert.match(checkRule('memory', { ...kind, toward: 9 }).join('\n'), /toward must be a whole number/);

  const env = { vars: { crew: 'crew', room: 'room' } };
  assert.deepEqual(validateCondition([{ crew: { in: '$room', awake: true }, as: 'other' }, { memory: { toward: 'bad', about: '$other', captain: 'good' } }, { fact: 'crew.regard', crew: '$crew', of: '$other', lte: -4 }], env).problems, []);
  assert.match(validateCondition({ memory: { captain: 'meh' } }, env).problems.join('\n'), /captain must be "bad" or "good"/);
  assert.match(validateCondition({ memory: { about: '$nobody' } }, env).problems.join('\n'), /nothing called "\$nobody"/);

  const reach = { vars: { who: 'crew', room: 'room' } };
  assert.deepEqual(validateEffects([{ do: 'remember', crew: { in: '$room' }, memory: 'slight', says: 'what {who} did' }], reach), []);
  assert.match(validateEffects([{ do: 'remember', crew: '$who', memory: 'slight', says: 'what {medic} did' }], reach).join('\n'), /nothing called "\{medic\}"/);
  assert.match(validateEffects([{ do: 'hurt', crew: { near: '$room' }, amount: 0.1 }], reach).join('\n'), /must be someone, "all", "random" or/);

  // Only the answers of someone sour or warm can name a memory.
  const files = readContentFiles();
  const crew = structuredClone(files.find((file) => file.path.endsWith('crew/placeholder.json')));
  crew.data.items[0].replies.move[0] = 'Going. {memory}.';
  const { errors } = validateContent(files.map((file) => (file.path === crew.path ? crew : file)));
  assert.ok(errors.some((error) => /replies\.move: unknown slot "\{memory\}"/.test(error)), errors.join('\n'));
  for (const item of content.all('crew')) for (const kind of MOOD_REPLIES) assert.ok(item.replies[kind].some((line) => line.includes('{memory}')) && item.replies[kind].some((line) => !line.includes('{memory}')), `${item.id} ${kind}: one line that names the memory and one for when it has faded`);
});

test('the situations about one of the crew leave a memory with them, whatever is chosen', () => {
  const kinds = Object.fromEntries(content.all('memories').map((item) => [item.id, item]));
  const weighty = (effects = []) => effects.filter((effect) => effect.do === 'remember' && (kinds[effect.memory].captain || kinds[effect.memory].toward));
  let tagged = 0;
  for (const event of EVENTS) {
    const written = [...event.choices.flatMap((choice) => choice.outcomes.flatMap((outcome) => weighty(outcome.effects))), ...weighty(event.lapse?.effects)];
    for (const effect of written) assert.ok(effect.says, `${event.id}: a memory from a choice is in the choice's own words`);
    if (written.length) tagged += 1;
    // An event with a cast is about someone: leaving it alone is remembered by them.
    if (event.cast && event.lapse) assert.ok(weighty(event.lapse.effects).length, `${event.id}: its lapse is remembered`);
  }
  assert.ok(tagged >= 8, `${tagged} events leave a memory`);
});

test('an answer that names a memory is only said while there is one: once it has faded they are still short with the captain', () => {
  const intercom = createIntercom(REPLIES);
  const faded = intercom.reply({ crew: 'dace', room: 'cargo', mood: 'sour', remembers: null }, 'Main hold');
  assert.equal(faded.kind, 'sour');
  assert.ok(!faded.text.includes('{memory}') && !faded.text.includes('remember'), faded.text);
  assert.equal(createIntercom({}).reply({ crew: 'x', room: 'cargo', mood: 'warm', remembers: null }, 'Main hold').text, 'Main hold. Gladly, Captain.');
  // A crate job is answered as it always was.
  assert.equal(intercom.reply({ crew: 'dace', room: 'cargo', job: 'open', mood: 'sour' }, 'Main hold').kind, 'open');
});
