// Content validation, shared by tools/content-check.js and the tests.
// Each stage adds the rules for the content types it introduces (PLAN.md §4).

import { AI_CATEGORIES, AI_SLOTS } from '../ai/categories.js';
import { TRIGGERS } from '../ai/voice.js';
import { SKILLS, validateCondition } from '../narrative/conditions.js';
import { checkEvent, followUps } from '../narrative/events.js';
import { checkRule } from '../narrative/rules.js';
import { COMMAND_TYPES } from '../sim/sim.js';
import { SYSTEM_IDS } from '../sim/systems.js';
import { NODE_KINDS, checkSector, generateSector } from '../sim/sector.js';
import { CONTRACT_TYPES } from '../sim/contracts.js';
import { SERVICES } from '../sim/port.js';
import { CRATE_KINDS } from '../sim/hold.js';
import { validateLayout } from '../sim/ship.js';
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
  // Skills and traits are read by the condition language from S3.3 (D-112); S4.1 makes them matter to the work.
  if (item.skills !== undefined) {
    if (!item.skills || typeof item.skills !== 'object' || Array.isArray(item.skills)) problems.push('skills must be an object of skill: level');
    else
      for (const [skill, level] of Object.entries(item.skills)) {
        if (!SKILLS.includes(skill)) problems.push(`skills: no skill "${skill}" (${SKILLS.join(', ')})`);
        if (!(Number.isInteger(level) && level >= 1 && level <= 5)) problems.push(`skills.${skill} must be a whole number from 1 to 5`);
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
  if (!range(item.slack, 0)) problems.push('slack must be [fewest, most] spare jumps on the deadline');
  if (item.events !== undefined) {
    if (!item.events || typeof item.events !== 'object' || Array.isArray(item.events)) problems.push('events must be an object of kind of point: chance of an event on arriving');
    else
      for (const [kind, chance] of Object.entries(item.events)) {
        if (!NODE_KINDS[kind]) problems.push(`events: unknown kind "${kind}" (${Object.keys(NODE_KINDS).join(', ')})`);
        if (!share(chance)) problems.push(`events.${kind} must be between 0 and 1`);
      }
  }
  const chase = item.pursuit;
  if (!chase || !share(chase.chance) || !isNonEmptyString(chase.ship) || !Number.isInteger(chase.lead) || chase.lead < 0 || !Number.isInteger(chase.sight) || chase.sight < 0) problems.push('pursuit must be { chance, ship, lead, sight }');
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
  if (item.slack !== undefined && !(Array.isArray(item.slack) && item.slack.length === 2 && item.slack.every(whole) && item.slack[0] <= item.slack[1])) problems.push('slack must be [fewest, most] spare jumps');
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
function checkPort(item) {
  const problems = [];
  if (!isNonEmptyString(item.name)) problems.push('missing name');
  if (!isNonEmptyString(item.text)) problems.push('missing text: what the port screen says about it');
  for (const key of ['fuel', 'hull', 'system', 'salvage']) if (!(Number.isInteger(item[key]) && item[key] >= 0)) problems.push(`${key} must be a whole number of credits, 0 or more`);
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
  ports: (item) => checkPort(item),
  factions: (item) => checkFaction(item),
};

/**
 * Everything a condition, an effect or a line can point at, gathered from all the files before any
 * one of them is checked: ids by type as Sets. Rooms and doors are those of our own ships (an event
 * happens aboard the ship we fly); `ships` are the ones that can be fought.
 */
export function gatherRefs(files) {
  const ids = (type, keep = () => true) => new Set(files.filter((file) => !file.error && typeOfPath(file.path) === type && Array.isArray(file.data?.items)).flatMap((file) => file.data.items.filter((item) => item && typeof item.id === 'string' && keep(item))));
  const of = (type, keep) => new Set([...ids(type, keep)].map((item) => item.id));
  const ours = [...ids('ships', (item) => item.enemy !== true)];
  const inShips = (key) => new Set(ours.flatMap((ship) => (Array.isArray(ship[key]) ? ship[key] : []).map((part) => part?.id).filter(Boolean)));
  return {
    rooms: inShips('rooms'),
    doors: inShips('doors'),
    systems: new Set(SYSTEM_IDS),
    crew: of('crew'),
    traits: new Set(), // S4.1 makes traits content
    memories: of('memories'),
    phrases: new Set([...ids('memories')].flatMap((item) => Object.keys(item.phrases && typeof item.phrases === 'object' ? item.phrases : {}))),
    risks: of('risks'),
    ships: of('ships', (item) => item.enemy === true),
    scenes: of('scenes'),
    events: of('events'),
    threats: of('threats'),
    factions: of('factions'),
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
  const pursuers = []; // [label, ship id] for every sector's pursuer
  const enemyShips = new Set();
  const refs = gatherRefs(files);
  const followed = new Set(); // events another event leads on to
  const unplaced = []; // [label, id] for events with no `at`

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

      if (type === 'contracts' && typeof item.claim?.event === 'string') followed.add(item.claim.event); // a claim opens it
      if (type === 'events') {
        for (const id of followUps(item)) followed.add(id);
        if (item.at === undefined) unplaced.push([label, item.id]);
      }

      if (type === 'weapons' && item.mount === false) unmountable.add(item.id);
      if (type === 'ships' && Array.isArray(item.weapons)) for (const id of item.weapons) fittedWeapons.push([label, id]);
      if (type === 'sectors' && isNonEmptyString(item.pursuit?.ship)) pursuers.push([label, item.pursuit.ship]);
      if (type === 'ships' && item.enemy === true) enemyShips.add(item.id);

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

  for (const [label, id] of pursuers) if (!enemyShips.has(id)) errors.push(`${label}: is followed by "${id}", which is not an enemy ship`);

  for (const [label, id] of unplaced) if (!followed.has(id)) errors.push(`${label}: has no "at" and no other event leads on to it, so it can never be met`);

  return { errors, warnings };
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
