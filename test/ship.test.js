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
  assert.ok(SHIP.rooms.length >= 12 && SHIP.rooms.length <= 16, `${SHIP.rooms.length} rooms`);
  const layout = buildLayout(SHIP);
  for (const system of SYSTEM_IDS) assert.ok(layout.roomOfSystem(system), `no room for ${system}`);
  assert.equal(layout.doors.filter((d) => d.airlock).length, 4);
  assert.equal(layout.vents.length, 9);
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
  assert.deepEqual(layout.ventExits('cargo').map((e) => e.to).sort(), ['brig', 'engines', 'reactor']);
  assert.deepEqual(layout.ventExits('medbay'), [], 'the medbay has no vent');
  assert.deepEqual(layout.exits('nowhere'), []);
  assert.ok(layout.bounds.w > 30 && layout.bounds.h > 12);
});

test('the vent network reaches places the doors would make you walk around to', () => {
  const layout = buildLayout(SHIP);
  // Cargo to reactor is one crawl, but two doors by foot.
  assert.ok(layout.ventExits('cargo').some((e) => e.to === 'reactor'));
  assert.ok(!layout.exits('cargo').some((e) => e.to === 'reactor'));
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

test('duplicate ids, bad vents and a missing hull are caught', () => {
  assert.ok(problemsAfter((d) => d.rooms.push({ ...room(d, 'brig'), x: 40 })).some((p) => /duplicate room id/.test(p)));
  assert.ok(problemsAfter((d) => d.doors.push({ ...door(d, 'd_brig') })).some((p) => /duplicate door id/.test(p)));
  assert.ok(problemsAfter((d) => (d.vents[0].b = 'attic')).some((p) => /both ends must be rooms/.test(p)));
  assert.ok(problemsAfter((d) => (d.vents[0].b = d.vents[0].a)).some((p) => /same room/.test(p)));
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
