// Rules as content (S3.3, D-110): what the crew remember, the orders they refuse because of it,
// and the risks Margo objects to. They are written in the condition language (conditions.js);
// memory.js and ai/judgement.js only carry them out. DOM-free.
//
//   content/memories/   { seconds, text, bare?, phrases?, shadow?, on? }
//             A kind of memory: how long it lasts, how it reads in the crew panel ("{who} dying
//             in {room}", or `bare` when there is no room), other ways of putting it that a
//             refusal's reason can ask for by name ("{memory.shadow}"), whether it counts as a bad
//             memory of the dark ("always", "never", or "if-dark": only if the room was dark),
//             and which bus events write it: { event, to, when?, names? } where `to` is
//             "subject" (the crew member the event is about), "everyone" (all of ours aboard)
//             or "named" (everyone the event lists), `when` sees the event as $event, and
//             `names: true` records who the event was about.
//   content/refusals/   { when, reason, order? }
//             An order to walk into a room that someone will not take. `when` sees $crew and
//             $room; whatever it remembers with "as" can be named in `reason`.
//   content/risks/      { on, rooms, when?, crew, grave, order? }
//             An order Margo objects to. `on` is the kind of order; `rooms` says where to look
//             ("order.room", "order.door.inside", "order.door.beside" or "ship"); for the first
//             of those rooms where `when` holds (it sees $order and $room) and someone fits
//             `crew`, they are the people at risk. `grave` orders are refused, the rest argued.
//
// Refusals and risks are tried in `order` (lowest first, then as loaded); the first that fits wins.

import { SPACE } from '../sim/systems.js';
import { checkCrewSpec, slotsOf, validateCondition, validateText } from './conditions.js';

export const MEMORY_TO = Object.freeze(['subject', 'everyone', 'named']);
export const SHADOWS = Object.freeze(['always', 'if-dark', 'never']);

/** Where a risk looks, given the order: each returns a list of room ids. */
export const RISK_ROOMS = Object.freeze({
  'order.room': (sim, order) => (sim.state.rooms[order.room] ? [order.room] : []),
  'order.door.inside': (sim, order) => {
    const door = sim.layout.door(order.door);
    return door ? [door.a] : [];
  },
  // Rooms the one behind the door would empty with it: through any door standing open.
  'order.door.beside': (sim, order) => {
    const door = sim.layout.door(order.door);
    if (!door) return [];
    return sim.layout
      .exits(door.a)
      .filter((exit) => exit.to !== SPACE && sim.state.doors[exit.door].openness > 0)
      .map((exit) => exit.to);
  },
  ship: (sim) => sim.layout.rooms.map((room) => room.id),
});

const byOrder = (a, b) => (a.order ?? 0) - (b.order ?? 0);

/**
 * The rule set a sim works from, built once from content: { memories, refusals, risks }, each the
 * items of that folder. With none, nobody remembers, refuses or objects.
 */
export function buildRules({ memories = [], refusals = [], risks = [] } = {}) {
  const writers = {}; // bus event -> [{ type, to, when, names }]
  for (const item of memories) for (const entry of item.on ?? []) (writers[entry.event] ??= []).push({ ...entry, type: item.id });
  return Object.freeze({
    memory: Object.fromEntries(memories.map((item) => [item.id, item])),
    writers,
    refusals: [...refusals].sort(byOrder),
    risks: [...risks].sort(byOrder),
    risk: Object.fromEntries(risks.map((item) => [item.id, item])),
  });
}

export const NO_RULES = buildRules();

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const words = (value) => typeof value === 'string' && value.trim().length > 0;

function checkMemoryText(text, what) {
  if (!words(text)) return [`${what} must be some words`];
  return slotsOf(text)
    .filter((slot) => !['who', 'room'].includes(slot))
    .map((slot) => `${what}: only {who} and {room} can be used here, not {${slot}}`);
}

/** Check one memory, refusal or risk item (`kind` says which). `refs` holds the ids that exist (see checkValue) plus `orders`, the kinds of order. Returns problems. */
export function checkRule(kind, item, refs = {}) {
  const problems = [];
  const keys = (allowed) => {
    for (const key of Object.keys(item)) if (!['id', 'note', '_file', ...allowed].includes(key)) problems.push(`unknown key "${key}"`);
  };
  if (item.order !== undefined && typeof item.order !== 'number') problems.push('order must be a number');
  if (kind === 'memory') {
    keys(['seconds', 'text', 'bare', 'phrases', 'shadow', 'on']);
    if (!(typeof item.seconds === 'number' && item.seconds > 0)) problems.push('seconds must be above 0: how long the memory lasts');
    problems.push(...checkMemoryText(item.text, 'text'));
    if (item.bare !== undefined) problems.push(...checkMemoryText(item.bare, 'bare'));
    if (item.phrases !== undefined) {
      if (!isObject(item.phrases)) problems.push('phrases must be an object of named wordings');
      else for (const [name, text] of Object.entries(item.phrases)) problems.push(...checkMemoryText(text, `phrases.${name}`));
    }
    if (item.shadow !== undefined && !SHADOWS.includes(item.shadow)) problems.push(`shadow must be one of ${SHADOWS.join(', ')}`);
    if (item.on !== undefined && !Array.isArray(item.on)) problems.push('on must be a list of { event, to }');
    for (const [i, entry] of (Array.isArray(item.on) ? item.on : []).entries()) {
      const where = `on[${i}]`;
      if (!isObject(entry)) {
        problems.push(`${where} must be an object`);
        continue;
      }
      for (const key of Object.keys(entry)) if (!['event', 'to', 'when', 'names'].includes(key)) problems.push(`${where}: unknown key "${key}"`);
      if (!words(entry.event)) problems.push(`${where}.event must name a bus event, such as "crew.died"`);
      if (!MEMORY_TO.includes(entry.to)) problems.push(`${where}.to must be one of ${MEMORY_TO.join(', ')}`);
      if (entry.names !== undefined && typeof entry.names !== 'boolean') problems.push(`${where}.names must be true or false`);
      problems.push(...validateCondition(entry.when, { vars: { event: 'data' }, refs }, `${where}.when`).problems);
    }
  } else if (kind === 'refusal') {
    keys(['order', 'when', 'reason']);
    const vars = { crew: 'crew', room: 'room' };
    if (item.when === undefined) problems.push('needs "when": a refusal with no condition would refuse every order');
    const { problems: found, binds } = validateCondition(item.when, { vars, refs }, 'when');
    problems.push(...found, ...validateText(item.reason, { vars: { ...vars, ...binds }, refs }, 'reason'));
  } else if (kind === 'risk') {
    keys(['order', 'on', 'rooms', 'when', 'crew', 'grave']);
    const vars = { order: 'data', room: 'room' };
    if (!words(item.on)) problems.push('on must name a kind of order, such as "crew.move"');
    else if (refs.orders && !refs.orders.has(item.on)) problems.push(`on: no order "${item.on}"`);
    if (!RISK_ROOMS[item.rooms]) problems.push(`rooms must be one of ${Object.keys(RISK_ROOMS).join(', ')}`);
    if (typeof item.grave !== 'boolean') problems.push('grave must be true (she refuses) or false (she argues)');
    problems.push(...validateCondition(item.when, { vars, refs }, 'when').problems);
    if (item.crew === undefined) problems.push('needs "crew": who the order puts at risk');
    else problems.push(...checkCrewSpec(item.crew, { vars, refs }, 'crew'));
  }
  return problems;
}
