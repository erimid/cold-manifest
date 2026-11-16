import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateContent } from '../src/engine/content-schema.js';
import { buildLayout, validateLayout, wallOf } from '../src/sim/ship.js';
import { SYSTEM_IDS } from '../src/sim/systems.js';
import { SHIP, shipCopy } from './helpers.js';

const problemsAfter = (change) => {
  const data = shipCopy();
  change(data);
  return validateLayout(data);
};
const room = (data, id) => data.rooms.find((r) => r.id === id);
const door = (data, id) => data.doors.find((d) => d.id === id);

test('the Margin of Error is a sound layout of the size the brief asks for', () => {
  assert.deepEqual(validateLayout(SHIP), []);
  const rooms = SHIP.rooms.filter((r) => r.kind !== 'lift').length; // the lift shaft is not a room you work in
  assert.ok(rooms >= 12 && rooms <= 16, `${rooms} rooms`);
  const layout = buildLayout(SHIP);
  for (const system of SYSTEM_IDS) assert.ok(layout.roomOfSystem(system), `no room for ${system}`);
  assert.equal(layout.doors.filter((d) => d.airlock).length, 4);
  assert.equal(layout.crawlways.length, 12);
  assert.deepEqual(layout.decks.map((d) => d.id), ['upper', 'main', 'lower', 'hold']);
});

test('the built layout answers the questions the sim will ask', () => {
  const layout = buildLayout(SHIP);
  assert.equal(layout.room('brig').name, 'Brig');
  assert.equal(layout.door('airlock_cargo').airlock, true);
  assert.equal(layout.roomOfSystem('doors').id, 'door_control');
  assert.deepEqual(layout.exits('brig'), [{ door: 'd_brig', to: 'aft_corridor' }]);
  assert.deepEqual(
    layout.exits('engines').map((e) => e.to).sort(),
    ['aft_corridor', 'cargo', 'reactor', 'space'],
  );
  assert.deepEqual(layout.crawlExits('cargo').map((e) => e.to).sort(), ['brig', 'engines']);
  assert.deepEqual(layout.crawlExits('medbay').map((e) => e.to), ['life_support']);
  assert.deepEqual(layout.crawlExits('brig').filter((e) => e.creature).map((e) => e.to), ['hold'], 'a duct only the creature fits');
  assert.equal(layout.room('lift').kind, 'lift');
  assert.deepEqual(layout.exits('nowhere'), []);
  assert.ok(layout.bounds.w > 30 && layout.bounds.h > 12);
});

test('the crawlways reach places the doors would make you walk around to', () => {
  const layout = buildLayout(SHIP);
  // Cargo to the brig is one crawl through the wall, but no door.
  assert.ok(layout.crawlExits('cargo').some((e) => e.to === 'brig'));
  assert.ok(!layout.exits('cargo').some((e) => e.to === 'brig'));
  // Every crawlway has a hatch on each side, inside its room.
  for (const c of layout.crawlways) {
    for (const id of [c.a, c.b]) {
      const r = layout.room(id);
      const h = c.hatches[id];
      assert.ok(h.x > r.x && h.x < r.x + r.w && h.y > r.y && h.y < r.y + r.h, `${c.id} hatch outside ${id}`);
    }
  }
});

test('rooms sit on decks, and the lift is no place for a system', () => {
  assert.ok(problemsAfter((d) => (room(d, 'brig').h = 2)).some((p) => /deck/.test(p)));
  assert.ok(problemsAfter((d) => (d.decks[1].y = 2)).some((p) => /deck/.test(p)));
  assert.ok(problemsAfter((d) => (room(d, 'lift').system = 'sensors')).some((p) => /lift/.test(p)));
});

test('wallOf finds the wall a doorway sits on', () => {
  const r = { x: 4, y: 1, w: 5, h: 5 };
  assert.equal(wallOf(r, { x: 6.5, y: 6, vertical: false }), 'bottom');
  assert.equal(wallOf(r, { x: 6.5, y: 1, vertical: false }), 'top');
  assert.equal(wallOf(r, { x: 4, y: 5, vertical: true }), 'left');
  assert.equal(wallOf(r, { x: 9, y: 3, vertical: true }), 'right');
  assert.equal(wallOf(r, { x: 6.5, y: 6, vertical: true }), null, 'wrong orientation');
  assert.equal(wallOf(r, { x: 8.8, y: 6, vertical: false }), null, 'hangs off the end of the wall');
  assert.equal(wallOf(r, { x: 6.5, y: 5, vertical: false }), null, 'inside the room, not on a wall');
});

test('overlapping rooms are caught', () => {
  const problems = problemsAfter((d) => (room(d, 'brig').x = 9));
  assert.ok(problems.some((p) => /overlaps room "cargo"/.test(p)), problems.join('\n'));
});

test('a door must sit on a wall both rooms share', () => {
  assert.ok(problemsAfter((d) => (door(d, 'd_brig').x = 20)).some((p) => /"d_brig": is not on a wall of room "aft_corridor"|do not share a wall/.test(p)));
  assert.ok(problemsAfter((d) => (door(d, 'd_brig').b = 'shields')).some((p) => /do not share a wall/.test(p)));
  assert.ok(problemsAfter((d) => (door(d, 'd_brig').b = 'attic')).some((p) => /side b must be a room/.test(p)));
  assert.ok(problemsAfter((d) => (door(d, 'd_brig').vertical = 'no')).some((p) => /needs numeric x and y/.test(p)));
});

test('an airlock must open onto space, not into another room', () => {
  const problems = problemsAfter((d) => (door(d, 'd_brig').b = 'space'));
  assert.ok(problems.some((p) => /is an airlock but room "brig" is on the other side/.test(p)), problems.join('\n'));
  assert.ok(problemsAfter((d) => (d.doors = d.doors.filter((x) => x.b !== 'space'))).some((p) => /at least one airlock/.test(p)));
});

test('every room must be reachable through doors', () => {
  const problems = problemsAfter((d) => (d.doors = d.doors.filter((x) => x.id !== 'd_brig')));
  assert.deepEqual(problems, ['room "brig" cannot be reached through doors']);
});

test('every system needs exactly one room', () => {
  assert.ok(problemsAfter((d) => delete room(d, 'medbay').system).includes('no room holds the medbay system'));
  assert.ok(problemsAfter((d) => (room(d, 'bridge').system = 'sensors')).some((p) => /sensors system is in more than one room/.test(p)));
  assert.ok(problemsAfter((d) => (room(d, 'bridge').system = 'teleporter')).some((p) => /unknown system/.test(p)));
});

test('duplicate ids, bad crawlways and a missing hull are caught', () => {
  assert.ok(problemsAfter((d) => d.rooms.push({ ...room(d, 'brig'), x: 40 })).some((p) => /duplicate room id/.test(p)));
  assert.ok(problemsAfter((d) => d.doors.push({ ...door(d, 'd_brig') })).some((p) => /duplicate door id/.test(p)));
  assert.ok(problemsAfter((d) => (d.crawlways[0].b = 'attic')).some((p) => /both ends must be rooms|room/.test(p)));
  assert.ok(problemsAfter((d) => (d.crawlways[0].b = d.crawlways[0].a)).some((p) => /same room/.test(p)));
  assert.ok(problemsAfter((d) => Object.assign(d.crawlways[0], { a: 'engines', b: 'bridge' })).some((p) => /wall/.test(p)));
  assert.ok(problemsAfter((d) => (d.vents = [])).some((p) => /crawlways/.test(p)));
  assert.ok(problemsAfter((d) => (d.hull = [[0, 0]])).some((p) => /hull/.test(p)));
  assert.ok(problemsAfter((d) => (room(d, 'brig').w = 2.5)).some((p) => /whole tiles/.test(p)));
});

test('buildLayout refuses an unsound layout', () => {
  const data = shipCopy();
  data.doors = data.doors.filter((x) => x.id !== 'd_brig');
  assert.throws(() => buildLayout(data), /invalid: room "brig" cannot be reached/);
});

test('the content checker applies the layout rules to ship files', () => {
  const data = shipCopy();
  room(data, 'brig').x = 9;
  const { errors } = validateContent([{ path: 'ships/broken.json', data: { items: [data] } }]);
  assert.ok(errors.some((e) => /ships\/broken.json "margin-of-error": room "brig": overlaps/.test(e)), errors.join('\n'));
});
