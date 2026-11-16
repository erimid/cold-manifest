// Content validation, shared by tools/content-check.js and the tests.
// Each stage adds the rules for the content types it introduces (PLAN.md §4).

import { AI_CATEGORIES, AI_SLOTS } from '../ai/categories.js';
import { validateLayout } from '../sim/ship.js';
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
function checkAiLine(item) {
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
  if (item.conditions !== undefined && (typeof item.conditions !== 'object' || item.conditions === null)) {
    problems.push('conditions must be an object');
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
  if (!Number.isInteger(item.pierce) || item.pierce < 0) problems.push('pierce must be a whole number of shield layers, 0 or more');
  const effects = item.effects;
  if (!effects || typeof effects !== 'object' || !chance(effects.fire) || !chance(effects.breach) || !chance(effects.crew)) problems.push('effects needs fire, breach and crew, each between 0 and 1');
  return problems;
}

const ITEM_RULES = {
  'ai-lines': checkAiLine,
  ships: validateLayout,
  weapons: checkWeapon,
};

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
      if (rule) for (const problem of rule(item)) errors.push(`${label}: ${problem}`);

      if (type === 'ships' && Array.isArray(item.weapons)) for (const id of item.weapons) fittedWeapons.push([label, id]);

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
  }

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
