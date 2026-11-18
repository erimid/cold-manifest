// Content validation, shared by tools/content-check.js and the tests.
// Each stage adds the rules for the content types it introduces (PLAN.md §4).

import { ROLES } from '../sim/roles.js';
import { AI_CATEGORIES, AI_SLOTS } from '../ai/categories.js';
import { TRIGGERS } from '../ai/voice.js';
import { SKILLS, validateCondition } from '../narrative/conditions.js';
import { checkEvent, followUps } from '../narrative/events.js';
import { checkRule } from '../narrative/rules.js';
import { COMMAND_TYPES } from '../sim/sim.js';
import { SYSTEM_IDS } from '../sim/systems.js';
import { NODE_KINDS, RISK_WHERE, checkSector, generateSector } from '../sim/sector.js';
import { CONTRACT_TYPES } from '../sim/contracts.js';
import { SERVICES, checkNotices } from '../sim/port.js';
import { CRATE_KINDS } from '../sim/hold.js';
import { validateLayout } from '../sim/ship.js';
import { validateEncounter } from '../sim/encounters.js';
import { createRng } from './rng.js';
import { CONTENT_TYPES, typeOfPath } from './content.js';

const ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const SLOT_PATTERN = /\{([^{}]*)\}/g;
const CATEGORY_IDS = new Set(AI_CATEGORIES.map((c) => c.id));

/** The slot names used in a line of text. */
export function slotsIn(text) {
  return [...text.matchAll(SLOT_PATTERN)].map((m) => m[1]);
}

/**
 * A line reduced to its wording: slots collapsed to one marker, case and
 * punctuation removed. Two lines with the same normalized text are the same
 * line as far as the 3,000 count is concerned (brief §9).
 */
export function normalizeLine(text) {
  return text
    .replace(SLOT_PATTERN, ' _slot_ ')
    .toLowerCase()
    .replace(/[^a-z0-9_ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Rules for one AI line. Returns a list of problems (empty when valid). */
function checkAiLine(item, refs = {}) {
  const problems = [];
  if (!CATEGORY_IDS.has(item.category)) problems.push(`unknown category "${item.category}"`);
  if (!isNonEmptyString(item.text)) {
    problems.push('missing text');
  } else {
    for (const slot of slotsIn(item.text)) {
      if (!AI_SLOTS.includes(slot)) problems.push(`unknown slot "{${slot}}"`);
    }
    if (/[{}]/.test(item.text.replace(SLOT_PATTERN, ''))) problems.push('unbalanced { or } in text');
  }
  if (item.weight !== undefined && !(typeof item.weight === 'number' && item.weight > 0)) {
    problems.push('weight must be a number above 0');
  }
  if (item.placeholder !== undefined && typeof item.placeholder !== 'boolean') {
    problems.push('placeholder must be true or false');
  }
  if (item.conditions !== undefined) {
    if (typeof item.conditions !== 'object' || item.conditions === null || Array.isArray(item.conditions)) return [...problems, 'conditions must be an object'];
    // Which remark a line answers (`trigger`), which of Margo's risks it is for (`risk`), and anything else
    // that must be true, in the condition language (`when`; S3.3, D-109).
    const { trigger, risk, when, ...rest } = item.conditions;
    for (const key of Object.keys(rest)) problems.push(`conditions: unknown key "${key}" (trigger, risk, when)`);
    if (trigger !== undefined && !TRIGGERS[trigger]) problems.push(`conditions.trigger: nothing called "${trigger}" makes her speak`);
    for (const id of risk === undefined ? [] : [].concat(risk)) if (refs.risks && !refs.risks.has(id)) problems.push(`conditions.risk: no risk "${id}"`);
    problems.push(...validateCondition(when, { vars: {}, refs }, 'conditions.when').problems);
  }
  return problems;
}

/** Rules for one weapon (brief §7; the fields are described in content/weapons/weapons.json). */
function checkWeapon(item) {
  const problems = [];
  const positive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
  const chance = (v) => typeof v === 'number' && v >= 0 && v <= 1;
  if (!isNonEmptyString(item.name)) problems.push('missing name');
  if (!isNonEmptyString(item.short) || item.short.length > 8) problems.push('needs a "short" name of at most 8 characters for the weapons panel');
  if (!['energy', 'kinetic'].includes(item.kind)) problems.push('kind must be "energy" or "kinetic"');
  if (!Number.isInteger(item.power) || item.power < 1) problems.push('power must be a whole number of bars, at least 1');
  if (!positive(item.charge)) problems.push('charge must be seconds above 0');
  if (!positive(item.flight)) problems.push('flight must be seconds above 0');
  if (!Number.isInteger(item.damage) || item.damage < 0) problems.push('damage must be a whole number, 0 or more');
  if (!Number.isInteger(item.pierce) || item.pierce < 0) problems.push('pierce must be a whole number, 0 or more: each point makes a brace spend one more unit to stop it');
  if (item.mount !== undefined && typeof item.mount !== 'boolean') problems.push('mount, if given, must be true or false');
  if (item.ammo !== undefined && !(item.ammo && Number.isInteger(item.ammo.magazine) && item.ammo.magazine >= 1)) problems.push('ammo, if given, must be { magazine }: the rounds the gun holds, at least 1');
  // A mount's role (H.3, D-172): point defence fires by itself at drones and pods; a gun is laid on a contact, out to its range.
  if (item.role !== undefined && !['pd', 'gun'].includes(item.role)) problems.push('role, if given, must be "pd" (point defence) or "gun" (the deterrent gun)');
  if (item.role === 'gun' && !positive(item.range)) problems.push('a gun needs a range: how far out, in scope units, it can reach a contact');
  if (item.range !== undefined && !positive(item.range)) problems.push('range must be scope units above 0');
  const effects = item.effects;
  if (!effects || typeof effects !== 'object' || !chance(effects.fire) || !chance(effects.breach) || !chance(effects.crew)) problems.push('effects needs fire, breach and crew, each between 0 and 1');
  return problems;
}

/** What crew answer over the intercom (S2.9, D-094): a walk, or one of the hold's jobs; and what they say when they refuse an order or put a lamp back on (S2.10). */
export const REPLY_KINDS = Object.freeze(['move', 'open', 'carry', 'jettison', 'load', 'refuse', 'lamp']);

/** Rules for one crew member. Their intercom replies are lists of lines by kind; `{room}` is the only slot. */
function checkCrew(item, refs = {}) {
  const problems = [];
  if (!isNonEmptyString(item.name)) problems.push('missing name');
  // Skills and traits are read by the condition language from S3.3 (D-112); skills speed their work from D-131.
  if (item.skills !== undefined) {
    if (!item.skills || typeof item.skills !== 'object' || Array.isArray(item.skills)) problems.push('skills must be an object of skill: level');
    else
      for (const [skill, level] of Object.entries(item.skills)) {
        if (!SKILLS.includes(skill)) problems.push(`skills: no skill "${skill}" (${SKILLS.join(', ')})`);
        if (!(Number.isInteger(level) && level >= 1 && level <= 5)) problems.push(`skills.${skill} must be a whole number from 1 to 5`);
      }
  }
  // A role (D-130) names the skill they excel at: it must be one of their skills, and none higher.
  if (item.role !== undefined) {
    if (!ROLES[item.role]) problems.push(`role: no role "${item.role}" (${Object.keys(ROLES).join(', ')})`);
    else {
      const skill = ROLES[item.role].skill;
      const level = item.skills?.[skill] ?? 0;
      if (level < 2) problems.push(`role ${item.role} needs ${skill} at 2 or more`);
      for (const [other, l] of Object.entries(item.skills ?? {})) if (l > level) problems.push(`role ${item.role}: ${other} ${l} is higher than ${skill} ${level}, so they would excel at the wrong thing`);
    }
  }
  if (item.traits !== undefined) {
    if (!Array.isArray(item.traits)) problems.push('traits must be a list of trait ids');
    else for (const trait of item.traits) if (!refs.traits?.has(trait)) problems.push(`traits: no trait "${trait}" (traits arrive in S4.1)`);
  }
  if (item.replies === undefined) return problems;
  if (!item.replies || typeof item.replies !== 'object' || Array.isArray(item.replies)) return [...problems, 'replies must be an object of line lists'];
  for (const kind of REPLY_KINDS) if (!Array.isArray(item.replies[kind]) || !item.replies[kind].length) problems.push(`replies needs a list of "${kind}" lines`);
  for (const [kind, lines] of Object.entries(item.replies)) {
    if (!REPLY_KINDS.includes(kind)) problems.push(`replies has an unknown kind "${kind}"`);
    for (const line of Array.isArray(lines) ? lines : []) {
      if (!isNonEmptyString(line)) problems.push(`replies.${kind} has an empty line`);
      else for (const slot of slotsIn(line)) if (slot !== 'room') problems.push(`replies.${kind}: unknown slot "{${slot}}"`);
    }
  }
  return problems;
}

/** Seeded charts the checker draws from every sector definition to prove they always work (S3.1). */
export const SECTOR_SAMPLES = 200;

/** Rules for one sector definition, then a few hundred charts drawn from it, each checked for soundness. */
function checkSectorDef(item) {
  const problems = [];
  const range = (v, min) => Array.isArray(v) && v.length === 2 && v.every(Number.isInteger) && v[0] >= min && v[0] <= v[1];
  const share = (v) => v === undefined || (typeof v === 'number' && v >= 0 && v <= 1);
  if (!isNonEmptyString(item.name)) problems.push('missing name');
  if (!range(item.nodes, 4)) problems.push('nodes must be [fewest, most], whole numbers, at least 4');
  if (!range(item.columns, 3)) problems.push('columns must be [fewest, most], whole numbers, at least 3');
  if (!item.kinds || typeof item.kinds !== 'object') problems.push('kinds must be an object of { weight, minimum } by kind');
  else {
    for (const [kind, rule] of Object.entries(item.kinds)) {
      if (!NODE_KINDS[kind]) problems.push(`kinds: unknown kind "${kind}" (${Object.keys(NODE_KINDS).join(', ')})`);
      if (!(typeof rule?.weight === 'number' && rule.weight >= 0)) problems.push(`kinds.${kind}: weight must be a number, 0 or more`);
      if (rule?.minimum !== undefined && !(Number.isInteger(rule.minimum) && rule.minimum >= 0)) problems.push(`kinds.${kind}: minimum must be a whole number`);
    }
    if (!Object.values(item.kinds).some((rule) => rule?.weight > 0)) problems.push('kinds: at least one kind needs a weight above 0');
  }
  if (!Array.isArray(item.hazards) || !item.hazards.length || !item.hazards.every(isNonEmptyString)) problems.push('hazards must be a list of names');
  if (!Array.isArray(item.designations) || item.designations.length < 2 || !item.designations.every(isNonEmptyString)) problems.push('designations must be a list of at least 2 codes');
  for (const key of ['longLane', 'crossLanes', 'sideLanes']) if (!share(item[key])) problems.push(`${key} must be between 0 and 1`);
  if (!(Number.isInteger(item.fuel?.start) && Number.isInteger(item.fuel?.max) && item.fuel.start >= 1 && item.fuel.start <= item.fuel.max)) problems.push('fuel must be { start, max }, whole numbers, start at least 1 and no more than max');
  const shares = (v) => Array.isArray(v) && v.length === 2 && v.every((n) => typeof n === 'number' && n >= 0 && n <= 3) && v[0] <= v[1];
  if (!shares(item.slack)) problems.push('slack must be [least, most] spare time on the deadline, a share of the cheapest way across in hours (0 to 3)');
  if (item.hour !== undefined) problems.push('hour is retired (H.8, D-206): an hour on the ship clock is SHIP_HOUR seconds for every sector (src/sim/shipclock.js)');
  const h = item.hours;
  if (!h || !['base', 'column', 'climb', 'min', 'max'].every((key) => typeof h[key] === 'number' && h[key] >= 0) || !(h.min >= 1 && h.min <= h.max)) problems.push('hours must be { base, column, climb, min, max }, numbers, min at least 1 and no more than max');
  if (!(typeof item.union === 'number' && item.union >= 0 && item.union < 0.5)) problems.push('union must be the depth of the Union band, from 0 to under 0.5');
  if (item.events !== undefined) {
    if (!item.events || typeof item.events !== 'object' || Array.isArray(item.events)) problems.push('events must be an object of kind of point: chance of an event on the lane to it');
    else
      for (const [kind, chance] of Object.entries(item.events)) {
        if (!NODE_KINDS[kind]) problems.push(`events: unknown kind "${kind}" (${Object.keys(NODE_KINDS).join(', ')})`);
        if (!share(chance)) problems.push(`events.${kind} must be between 0 and 1`);
      }
  }
  if (item.contacts !== undefined) problems.push('contacts: since H.6 a lane\'s risk says what turns up (risks[].contacts)');
  if (!Array.isArray(item.risks) || !item.risks.length) problems.push('risks must be a list of lane risks');
  else {
    const ids = new Set();
    item.risks.forEach((risk, i) => {
      const at = `risks[${i}]${isNonEmptyString(risk?.id) ? ` (${risk.id})` : ''}`;
      if (!isNonEmptyString(risk?.id)) problems.push(`${at}: missing id`);
      else if (ids.has(risk.id)) problems.push(`${at}: the id is used twice`);
      else ids.add(risk.id);
      for (const key of ['name', 'label', 'text']) if (!isNonEmptyString(risk?.[key])) problems.push(`${at}: missing ${key}`);
      const where = risk?.where;
      const keys = where && typeof where === 'object' ? Object.keys(where) : [];
      if (keys.length !== 1 || !RISK_WHERE.includes(keys[0])) problems.push(`${at}: where must be one of { touches: kind }, { beacon: true }, { union: true }, { default: true }`);
      else if (keys[0] === 'touches' ? !NODE_KINDS[where.touches] || where.touches === 'port' : where[keys[0]] !== true) problems.push(`${at}: where.${keys[0]} is "${where[keys[0]]}"`);
      if (!share(risk?.contacts) || risk?.contacts === undefined) problems.push(`${at}: contacts must be a chance an hour, 0 to 1`);
      if (!risk?.encounters || typeof risk.encounters !== 'object' || Array.isArray(risk.encounters) || !Object.values(risk.encounters).every((w) => typeof w === 'number' && w >= 0)) problems.push(`${at}: encounters must be an object of encounter id: weight`);
      if (risk?.aboard !== undefined && !share(risk.aboard)) problems.push(`${at}: aboard must be a chance an hour, 0 to 1`);
      if (risk?.length !== undefined && !(typeof risk.length === 'number' && risk.length > 0 && risk.length <= 2)) problems.push(`${at}: length must be a number above 0, at most 2`);
      if (risk?.strikes !== undefined && !(share(risk.strikes.perHour) && isNonEmptyString(risk.strikes.weapon))) problems.push(`${at}: strikes must be { perHour, weapon }`);
    });
    if (!item.risks.some((risk) => risk?.where?.default === true)) problems.push('risks: one risk needs where: { default: true }, so every lane has one');
  }
  const chase = item.pursuit;
  if (!chase || !share(chase.chance) || !isNonEmptyString(chase.encounter) || !(typeof chase.lead === 'number' && chase.lead >= 0) || !(typeof chase.rate === 'number' && chase.rate > 0 && chase.rate <= 1)) problems.push('pursuit must be { chance, encounter, lead (hours), rate (a chance an hour) }');
  if (problems.length) return problems;
  const kindsNeeded = Object.values(item.kinds).reduce((n, rule) => n + (rule.minimum ?? 0), 0);
  if (kindsNeeded > item.nodes[0] - 2) return [`the kinds' minimums need ${kindsNeeded} points between the ends, and a chart may have only ${item.nodes[0] - 2}`];
  for (let i = 1; i <= SECTOR_SAMPLES; i++) {
    const found = checkSector(generateSector(item, createRng(`check:${item.id}:${i}`)), item);
    if (found.length) return [`chart ${i} of ${SECTOR_SAMPLES}: ${found.join('; ')}`];
  }
  return problems;
}

/** Rules for one contract template (S3.4; the format is described at the top of src/sim/contracts.js). */
function checkContract(item, refs = {}) {
  const problems = [];
  const allowed = ['id', 'note', 'type', 'title', 'client', 'contact', 'text', 'pay', 'advance', 'latePay', 'followed', 'slack', 'value', 'cargo', 'claim', 'reputation', 'penalty'];
  for (const key of Object.keys(item)) if (!allowed.includes(key) && key !== '_file') problems.push(`unknown key "${key}"`);
  const whole = (v) => Number.isInteger(v) && v >= 0;
  const share = (v) => typeof v === 'number' && v >= 0 && v <= 1;
  if (!CONTRACT_TYPES[item.type]) problems.push(`type must be one of ${Object.keys(CONTRACT_TYPES).join(', ')}`);
  for (const key of ['title', 'contact', 'text']) if (!isNonEmptyString(item[key])) problems.push(`needs "${key}": words for the contract board`);
  if (!isNonEmptyString(item.client)) problems.push('needs "client": the faction it is for');
  else if (refs.factions && !refs.factions.has(item.client)) problems.push(`client: no faction "${item.client}"`);
  if (!(whole(item.pay) && item.pay > 0)) problems.push('pay must be a whole number of credits above 0');
  if (item.advance !== undefined && !(whole(item.advance) && item.advance < item.pay)) problems.push('advance must be a whole number of credits, less than the pay');
  if (item.penalty !== undefined && !whole(item.penalty)) problems.push('penalty must be a whole number of credits');
  if (!whole(item.value)) problems.push('value must be a whole number of credits: what a port pays for one crate of it');
  if (item.latePay !== undefined && !share(item.latePay)) problems.push('latePay must be between 0 and 1');
  if (item.followed !== undefined && !share(item.followed)) problems.push('followed must be a chance between 0 and 1');
  if (item.slack !== undefined && !(Array.isArray(item.slack) && item.slack.length === 2 && item.slack.every((n) => typeof n === 'number' && n >= 0 && n <= 3) && item.slack[0] <= item.slack[1])) problems.push('slack must be [least, most] spare time, a share of the cheapest way across in hours');
  const rep = item.reputation;
  if (!rep || typeof rep !== 'object' || !Number.isInteger(rep.deliver) || !Number.isInteger(rep.fail) || rep.fail > 0) problems.push('reputation must be { deliver, fail }, whole numbers, fail 0 or below');
  if (!Array.isArray(item.cargo) || !item.cargo.length) problems.push('cargo must be a list of crate lines');
  else
    item.cargo.forEach((line, i) => {
      const where = `cargo[${i}]`;
      if (!line || typeof line !== 'object') return problems.push(`${where} must be an object`);
      for (const key of Object.keys(line)) if (!['count', 'kind', 'label', 'contents', 'contraband'].includes(key)) problems.push(`${where}: unknown key "${key}"`);
      if (line.count !== undefined && !(Number.isInteger(line.count) && line.count >= 1)) problems.push(`${where}.count must be a whole number, 1 or more`);
      if (line.kind !== undefined && !['cargo', 'salvage'].includes(line.kind)) problems.push(`${where}.kind must be cargo or salvage (${CRATE_KINDS.join(', ')} exist; ammo is not cargo)`);
      if (!isNonEmptyString(line.label)) problems.push(`${where}: needs a label, what the stencil says`);
      if (!isNonEmptyString(line.contents)) problems.push(`${where}: needs contents, what is found when it is opened`);
      if (line.contraband !== undefined && typeof line.contraband !== 'boolean') problems.push(`${where}.contraband must be true or false`);
    });
  if (item.claim !== undefined) {
    const claim = item.claim;
    if (!claim || typeof claim !== 'object' || !NODE_KINDS[claim.at] || claim.at === 'port') problems.push(`claim.at must be a kind of point other than a port (${Object.keys(NODE_KINDS).join(', ')})`);
    if (!isNonEmptyString(claim?.event)) problems.push('claim.event must name the event that opens at the claim');
    else if (refs.events && !refs.events.has(claim.event)) problems.push(`claim.event: no event "${claim.event}"`);
  }
  return problems;
}

/** Rules for one port definition (S3.4; described in content/ports/). */
function checkPort(item, refs) {
  const problems = [...checkNotices(item.notices, refs)];
  if (!isNonEmptyString(item.name)) problems.push('missing name');
  if (!isNonEmptyString(item.text)) problems.push('missing text: what the port screen says about it');
  for (const key of ['fuel', 'hull', 'system', 'salvage']) if (!(Number.isInteger(item[key]) && item[key] >= 0)) problems.push(`${key} must be a whole number of credits, 0 or more`);
  if (item.flare !== undefined && !(Number.isInteger(item.flare) && item.flare >= 0)) problems.push('flare must be a whole number of credits, 0 or more: what a flare costs (F.2)');
  if (!Array.isArray(item.services)) problems.push(`services must be a list (${SERVICES.join(', ')})`);
  else for (const service of item.services) if (!SERVICES.includes(service)) problems.push(`services: no service "${service}" (${SERVICES.join(', ')})`);
  return problems;
}

/** Rules for one faction stub (S3.4; S7.4 writes them in full). */
function checkFaction(item) {
  const problems = [];
  if (!isNonEmptyString(item.name)) problems.push('missing name');
  if (!isNonEmptyString(item.line)) problems.push('missing line: one sentence on who they are');
  return problems;
}

/** The rules for each content type: (item, refs) -> problems. `refs` is what exists across all the content (gatherRefs). */
const ITEM_RULES = {
  'ai-lines': checkAiLine,
  crew: checkCrew,
  ships: (item) => validateLayout(item),
  weapons: (item) => checkWeapon(item),
  sectors: (item) => checkSectorDef(item),
  events: checkEvent,
  memories: (item, refs) => checkRule('memory', item, refs),
  refusals: (item, refs) => checkRule('refusal', item, refs),
  risks: (item, refs) => checkRule('risk', item, refs),
  contracts: checkContract,
  ports: (item, refs) => checkPort(item, refs),
  factions: (item) => checkFaction(item),
  encounters: (item, refs) => validateEncounter(item, { weapons: refs.weapons, encounters: refs.encounters, factions: refs.factions, nodeKinds: new Set(Object.keys(NODE_KINDS)) }),
};

/**
 * Everything a condition, an effect or a line can point at, gathered from all the files before any
 * one of them is checked: ids by type as Sets. Rooms and doors are those of our own ships (an event
 * happens aboard the ship we fly). There are no enemy ships since H.3: other ships are encounters.
 */
export function gatherRefs(files) {
  const ids = (type, keep = () => true) => new Set(files.filter((file) => !file.error && typeOfPath(file.path) === type && Array.isArray(file.data?.items)).flatMap((file) => file.data.items.filter((item) => item && typeof item.id === 'string' && keep(item))));
  const of = (type, keep) => new Set([...ids(type, keep)].map((item) => item.id));
  const ours = [...ids('ships')];
  const inShips = (key) => new Set(ours.flatMap((ship) => (Array.isArray(ship[key]) ? ship[key] : []).map((part) => part?.id).filter(Boolean)));
  return {
    rooms: inShips('rooms'),
    ships: ours.map((ship) => ({ id: ship.id, rooms: Array.isArray(ship.rooms) ? ship.rooms.filter(Boolean) : [], doors: Array.isArray(ship.doors) ? ship.doors.filter(Boolean) : [] })), // where a situation can be placed (H.7)
    doors: inShips('doors'),
    systems: new Set(SYSTEM_IDS),
    crew: of('crew'),
    traits: new Set(), // S4.1 makes traits content
    memories: of('memories'),
    phrases: new Set([...ids('memories')].flatMap((item) => Object.keys(item.phrases && typeof item.phrases === 'object' ? item.phrases : {}))),
    risks: of('risks'),
    weapons: of('weapons'),
    scenes: of('scenes'),
    events: of('events'),
    threats: of('threats'),
    factions: of('factions'),
    encounters: of('encounters'),
    orders: new Set(COMMAND_TYPES),
  };
}

/**
 * Validate loaded content files.
 * `files` is a list of { path, data } or { path, error } (for files that failed to parse).
 * Returns { errors, warnings } as lists of readable strings.
 */
export function validateContent(files) {
  const errors = [];
  const warnings = [];
  const seenIds = new Map(CONTENT_TYPES.map((type) => [type, new Map()]));
  const seenLines = new Map();
  const fittedWeapons = []; // [label, weapon id] for every weapon a ship mounts
  const unmountable = new Set(); // weapons marked mount: false, such as a drone's zap
  const pursuers = []; // [label, encounter id] for every sector's pursuer
  const laneContacts = []; // [label, encounter id] for every encounter a lane risk can bring (H.6)
  const strikeWeapons = []; // [label, weapon id] for what strikes the hull in a hazard lane (H.6)
  const refs = gatherRefs(files);
  const followed = new Set(); // events another event leads on to
  const unplaced = []; // [label, id] for events with no `at`
  const flagsSet = new Map(); // flag name -> the first item that sets it (F.5: every flag an effect sets is read somewhere)
  const flagsRead = new Map(); // flag name -> the first item whose condition reads it

  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    const { path, data, error } = file;
    if (error) {
      errors.push(`${path}: not valid JSON (${error})`);
      continue;
    }
    const type = typeOfPath(path);
    if (!type) {
      errors.push(`${path}: not inside a known content folder (${CONTENT_TYPES.join(', ')})`);
      continue;
    }
    if (!data || typeof data !== 'object' || !Array.isArray(data.items)) {
      errors.push(`${path}: must be an object with an "items" array`);
      continue;
    }
    if (data.items.length === 0) warnings.push(`${path}: has no items`);

    data.items.forEach((item, index) => {
      const where = `${path} item ${index + 1}`;
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        errors.push(`${where}: must be an object`);
        return;
      }
      if (!isNonEmptyString(item.id)) {
        errors.push(`${where}: missing id`);
        return;
      }
      const label = `${path} "${item.id}"`;
      if (!ID_PATTERN.test(item.id)) {
        errors.push(`${label}: id must be lowercase letters and digits joined by . _ or -`);
      }
      const ids = seenIds.get(type);
      if (ids.has(item.id)) errors.push(`${label}: duplicate id (first used in ${ids.get(item.id)})`);
      else ids.set(item.id, path);

      const rule = ITEM_RULES[type];
      if (rule) for (const problem of rule(item, refs)) errors.push(`${label}: ${problem}`);

      for (const [name, how] of flagsIn(item)) {
        const into = how === 'set' ? flagsSet : flagsRead;
        if (!into.has(name)) into.set(name, label);
      }
      if (type === 'contracts' && typeof item.claim?.event === 'string') followed.add(item.claim.event); // a claim opens it
      if (type === 'events') {
        for (const id of followUps(item)) followed.add(id);
        if (item.at === undefined && item.jolt === undefined) unplaced.push([label, item.id]);
      }

      if (type === 'weapons' && item.mount === false) unmountable.add(item.id);
      if (type === 'ships' && Array.isArray(item.weapons)) for (const id of item.weapons) fittedWeapons.push([label, id]);
      if (type === 'sectors' && isNonEmptyString(item.pursuit?.encounter)) pursuers.push([label, item.pursuit.encounter]);
      if (type === 'sectors' && Array.isArray(item.risks)) {
        for (const risk of item.risks) {
          for (const id of Object.keys(risk?.encounters ?? {})) laneContacts.push([`${label} risk ${risk.id}`, id]);
          if (isNonEmptyString(risk?.strikes?.weapon)) strikeWeapons.push([`${label} risk ${risk.id}`, risk.strikes.weapon]);
        }
      }

      if (type === 'ai-lines' && isNonEmptyString(item.text)) {
        const key = normalizeLine(item.text);
        if (seenLines.has(key)) {
          errors.push(`${label}: same wording as "${seenLines.get(key)}" (lines that differ only in slots count as one)`);
        } else {
          seenLines.set(key, item.id);
        }
      }
    });
  }

  for (const [label, id] of fittedWeapons) {
    if (!seenIds.get('weapons').has(id)) errors.push(`${label}: fits a weapon that does not exist: "${id}"`);
    else if (unmountable.has(id)) errors.push(`${label}: fits "${id}", which no ship can mount`);
  }

  for (const [label, id] of pursuers) if (!refs.encounters.has(id)) errors.push(`${label}: is followed by "${id}", which is not an encounter`);
  for (const [label, id] of laneContacts) if (!refs.encounters.has(id)) errors.push(`${label}: can bring "${id}", which is not an encounter`);
  for (const [label, id] of strikeWeapons) if (!seenIds.get('weapons').has(id)) errors.push(`${label}: strikes with "${id}", which is not a weapon`);

  // Choices come back (F.5, D-230): a note an event leaves that nothing reads is a choice that never comes back,
  // and a note read that nothing leaves is a condition that never holds.
  for (const [name, label] of flagsSet) if (!flagsRead.has(name)) errors.push(`${label}: sets the flag "${name}", which nothing reads (an event, a line, a rule or a port notice)`);
  for (const [name, label] of flagsRead) if (!flagsSet.has(name)) errors.push(`${label}: reads the flag "${name}", which nothing sets`);

  for (const [label, id] of unplaced) if (!followed.has(id)) errors.push(`${label}: has no "at", no "jolt" and no other event leads on to it, so it can never be met`);

  return { errors, warnings };
}

/** Every flag an item sets (a "flag" effect) or reads (the "flag" fact), anywhere inside it: [name, 'set' | 'read']. */
export function flagsIn(item) {
  const found = [];
  const walk = (node) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== 'object') return;
    if (node.do === 'flag' && typeof node.name === 'string') found.push([node.name, 'set']);
    if (node.fact === 'flag' && typeof node.name === 'string') found.push([node.name, 'read']);
    for (const value of Object.values(node)) walk(value);
  };
  walk(item);
  return found;
}

/** Counts for the coverage report. Placeholder lines are counted separately and never toward targets. */
export function coverage(content) {
  const lines = content.all('ai-lines');
  const real = lines.filter((line) => !line.placeholder);
  const categories = AI_CATEGORIES.map((category) => ({
    ...category,
    count: real.filter((line) => line.category === category.id).length,
  }));
  return {
    categories,
    aiLines: real.length,
    placeholders: lines.length - real.length,
    scenes: content.count('scenes'),
    events: content.count('events'),
  };
}
