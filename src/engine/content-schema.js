// Content validation, shared by tools/content-check.js and the tests.
// Each stage adds the rules for the content types it introduces (PLAN.md §4).

import { AI_CATEGORIES, AI_SLOTS } from '../ai/categories.js';
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

const ITEM_RULES = {
  'ai-lines': checkAiLine,
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
