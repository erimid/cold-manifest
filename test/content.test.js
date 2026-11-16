import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AI_CATEGORIES, CONTENT_TARGETS } from '../src/ai/categories.js';
import { createContent } from '../src/engine/content.js';
import { coverage, normalizeLine, slotsIn, validateContent } from '../src/engine/content-schema.js';
import { readContentFiles } from '../tools/lib/load-content.js';

const line = (id, text, extra = {}) => ({ id, category: 'idle', text, ...extra });
const file = (items, path = 'ai-lines/test.json') => ({ path, data: { items } });

test('the real content folder is valid', () => {
  const { errors } = validateContent(readContentFiles());
  assert.deepEqual(errors, []);
});

test('category targets are the brief\'s, scaled to the 500-line cap (D-100)', () => {
  assert.equal(AI_CATEGORIES.length, 26);
  assert.equal(AI_CATEGORIES.reduce((sum, c) => sum + c.target, 0), 500);
  assert.equal(new Set(AI_CATEGORIES.map((c) => c.id)).size, 26);
  assert.ok(AI_CATEGORIES.every((c) => Number.isInteger(c.target) && c.target >= 8));
  assert.deepEqual(CONTENT_TARGETS, { aiLines: 500, scenes: 120, events: 150 });
});

test('registry returns items by type and id', () => {
  const content = createContent([file([line('a.1', 'One.'), line('a.2', 'Two.')])]);
  assert.equal(content.count('ai-lines'), 2);
  assert.equal(content.get('ai-lines', 'a.2').text, 'Two.');
  assert.equal(content.get('ai-lines', 'nope'), undefined);
  assert.throws(() => content.require('ai-lines', 'nope'), /Missing/);
  assert.throws(() => content.all('spaceships'), /Unknown content type/);
});

test('registry order does not depend on load order', () => {
  const a = file([line('a.1', 'One.')], 'ai-lines/a.json');
  const b = file([line('b.1', 'Two.')], 'ai-lines/b.json');
  const ids = (files) => createContent(files).all('ai-lines').map((item) => item.id);
  assert.deepEqual(ids([a, b]), ids([b, a]));
});

test('a valid file has no errors', () => {
  const { errors } = validateContent([file([line('a.1', '{crew_name} is at {port}.', { weight: 2 })])]);
  assert.deepEqual(errors, []);
});

test('bad JSON, bad shape and unknown folders are reported', () => {
  const { errors } = validateContent([
    { path: 'ai-lines/broken.json', error: 'Unexpected token' },
    { path: 'ai-lines/shape.json', data: [] },
    { path: 'spaceships/x.json', data: { items: [] } },
  ]);
  assert.equal(errors.length, 3);
  assert.match(errors[0], /not valid JSON/);
  assert.match(errors[1], /"items" array/);
  assert.match(errors[2], /known content folder/);
});

test('ids must exist, be well formed and be unique', () => {
  const { errors } = validateContent([
    file([{ category: 'idle', text: 'No id.' }, line('Bad ID', 'Spaces.'), line('a.1', 'First.'), line('a.1', 'Second.')]),
  ]);
  assert.equal(errors.length, 3);
  assert.match(errors[0], /missing id/);
  assert.match(errors[1], /lowercase/);
  assert.match(errors[2], /duplicate id/);
});

test('ai lines need a known category, text, known slots and a sane weight', () => {
  const { errors } = validateContent([
    file([
      line('a.1', 'Fine.', { category: 'banter' }),
      line('a.2', ''),
      line('a.3', 'Hello {crew}.'),
      line('a.4', 'Hello {crew_name.'),
      line('a.5', 'Weight.', { weight: 0 }),
      line('a.6', 'Flag.', { placeholder: 'yes' }),
    ]),
  ]);
  assert.equal(errors.length, 6);
  assert.match(errors[0], /unknown category/);
  assert.match(errors[1], /missing text/);
  assert.match(errors[2], /unknown slot "\{crew\}"/);
  assert.match(errors[3], /unbalanced/);
  assert.match(errors[4], /weight/);
  assert.match(errors[5], /placeholder/);
});

test('lines that differ only in slots, case or punctuation count as one', () => {
  assert.deepEqual(slotsIn('{crew_name} is at {port}.'), ['crew_name', 'port']);
  assert.equal(normalizeLine('{crew_name} is STILL in the reactor!'), normalizeLine('{past_crew_name} is still in the reactor.'));
  const { errors } = validateContent([
    file([line('a.1', '{crew_name} is still in the reactor.'), line('a.2', '{past_crew_name} is still in the reactor!')]),
  ]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /same wording as "a.1"/);
});

test('coverage ignores placeholder lines', () => {
  const content = createContent([
    file([line('a.1', 'Real one.'), line('a.2', 'Real two.'), line('a.3', 'Stand-in.', { placeholder: true })]),
    { path: 'events/e.json', data: { items: [{ id: 'e.1' }] } },
  ]);
  const report = coverage(content);
  assert.equal(report.aiLines, 2);
  assert.equal(report.placeholders, 1);
  assert.equal(report.categories.find((c) => c.id === 'idle').count, 2);
  assert.equal(report.events, 1);
  assert.equal(report.scenes, 0);
});
