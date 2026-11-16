// Ship layouts (brief §6). A layout is content: a JSON item under
// content/ships/. This module checks a layout and turns it into the graphs
// the sim and renderer use. Pure and DOM-free.
//
// Layouts are drawn on a grid of square tiles:
//   rooms   rectangles { id, name, x, y, w, h, kind?, system?, jettison? } in whole
//           tiles. `jettison: true` marks a section that can be cut loose.
//   doors   { id, a, b, x, y, vertical } where (x, y) is the middle of the
//           doorway on the wall the two rooms share, and `vertical` says the
//           wall runs up and down. `b` may be "space" for an airlock.
//   vents   { id, a, b }: crawlspaces between rooms. Crew cannot use them.
//   hull    the outline of the ship as a list of [x, y] points
//   power   { reactor, lightsPerBar, systems: { id: { level, power } } }: the
//           reactor's bars, how many lit rooms one bar carries, and each
//           powered system's size and starting power (see power.js)

import { validatePower } from './power.js';
import { SPACE, SYSTEM_IDS } from './systems.js';

const EPS = 1e-9;

/** Which wall of `room` the doorway (x, y, vertical) sits on, or null. A doorway is one tile long. */
export function wallOf(room, door) {
  const { x, y, vertical } = door;
  if (vertical) {
    const within = y - 0.5 >= room.y - EPS && y + 0.5 <= room.y + room.h + EPS;
    if (!within) return null;
    if (Math.abs(x - room.x) < EPS) return 'left';
    if (Math.abs(x - (room.x + room.w)) < EPS) return 'right';
    return null;
  }
  const within = x - 0.5 >= room.x - EPS && x + 0.5 <= room.x + room.w + EPS;
  if (!within) return null;
  if (Math.abs(y - room.y) < EPS) return 'top';
  if (Math.abs(y - (room.y + room.h)) < EPS) return 'bottom';
  return null;
}

const OPPOSITE = { left: 'right', right: 'left', top: 'bottom', bottom: 'top' };

function overlaps(a, b) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/** Every room reachable from `start` through the given links. */
function reachable(start, links) {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    for (const next of links.get(queue.shift()) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return seen;
}

/** Problems with a ship layout, as readable strings. Empty means the layout is sound. */
export function validateLayout(data) {
  const problems = [];
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

  if (typeof data.name !== 'string' || !data.name.trim()) problems.push('missing name');
  if (!Array.isArray(data.rooms) || !data.rooms.length) return [...problems, 'needs a "rooms" list'];
  if (!Array.isArray(data.doors)) return [...problems, 'needs a "doors" list'];
  const vents = data.vents ?? [];
  if (!Array.isArray(vents)) return [...problems, '"vents" must be a list'];

  // Rooms
  const rooms = new Map();
  for (const room of data.rooms) {
    const label = `room "${room?.id}"`;
    if (!room || typeof room.id !== 'string' || !room.id) {
      problems.push('a room is missing its id');
      continue;
    }
    if (room.id === SPACE) problems.push(`${label}: "${SPACE}" is reserved for the outside`);
    if (rooms.has(room.id)) problems.push(`${label}: duplicate room id`);
    if (typeof room.name !== 'string' || !room.name.trim()) problems.push(`${label}: missing name`);
    if (![room.x, room.y, room.w, room.h].every(Number.isInteger) || room.w < 1 || room.h < 1) {
      problems.push(`${label}: x, y, w, h must be whole tiles, at least 1 wide and tall`);
      continue;
    }
    if (room.jettison !== undefined && typeof room.jettison !== 'boolean') problems.push(`${label}: "jettison" must be true or false`);
    if (room.system !== undefined && !SYSTEM_IDS.includes(room.system)) problems.push(`${label}: unknown system "${room.system}"`);
    for (const other of rooms.values()) {
      if (overlaps(room, other)) problems.push(`${label}: overlaps room "${other.id}"`);
    }
    rooms.set(room.id, room);
  }

  // Systems: each exactly once
  for (const system of SYSTEM_IDS) {
    const homes = data.rooms.filter((r) => r?.system === system).map((r) => r.id);
    if (homes.length === 0) problems.push(`no room holds the ${system} system`);
    if (homes.length > 1) problems.push(`the ${system} system is in more than one room: ${homes.join(', ')}`);
  }

  // Doors
  const doorIds = new Set();
  const links = new Map();
  const link = (a, b) => links.set(a, [...(links.get(a) ?? []), b]);
  let airlocks = 0;
  for (const door of data.doors) {
    const label = `door "${door?.id}"`;
    if (!door || typeof door.id !== 'string' || !door.id) {
      problems.push('a door is missing its id');
      continue;
    }
    if (doorIds.has(door.id)) problems.push(`${label}: duplicate door id`);
    doorIds.add(door.id);
    if (!isNum(door.x) || !isNum(door.y) || typeof door.vertical !== 'boolean') {
      problems.push(`${label}: needs numeric x and y and a true/false "vertical"`);
      continue;
    }
    const a = rooms.get(door.a);
    if (!a) {
      problems.push(`${label}: side a must be a room, got "${door.a}"`);
      continue;
    }
    const wallA = wallOf(a, door);
    if (!wallA) {
      problems.push(`${label}: is not on a wall of room "${a.id}"`);
      continue;
    }
    if (door.b === SPACE) {
      airlocks += 1;
      for (const other of rooms.values()) {
        if (other !== a && wallOf(other, door)) problems.push(`${label}: is an airlock but room "${other.id}" is on the other side`);
      }
      continue;
    }
    const b = rooms.get(door.b);
    if (!b) {
      problems.push(`${label}: side b must be a room or "${SPACE}", got "${door.b}"`);
      continue;
    }
    if (a === b) problems.push(`${label}: both sides are the same room`);
    if (wallOf(b, door) !== OPPOSITE[wallA]) problems.push(`${label}: rooms "${a.id}" and "${b.id}" do not share a wall there`);
    link(a.id, b.id);
    link(b.id, a.id);
  }
  if (airlocks === 0) problems.push('needs at least one airlock (a door with b: "space") so rooms can be vented');

  // Every room must be walkable from every other
  if (rooms.size) {
    const first = rooms.keys().next().value;
    const seen = reachable(first, links);
    for (const id of rooms.keys()) {
      if (!seen.has(id)) problems.push(`room "${id}" cannot be reached through doors`);
    }
  }

  // Vents
  const ventIds = new Set();
  for (const vent of vents) {
    const label = `vent "${vent?.id}"`;
    if (!vent || typeof vent.id !== 'string' || !vent.id) {
      problems.push('a vent is missing its id');
      continue;
    }
    if (ventIds.has(vent.id)) problems.push(`${label}: duplicate vent id`);
    ventIds.add(vent.id);
    if (!rooms.has(vent.a) || !rooms.has(vent.b)) problems.push(`${label}: both ends must be rooms`);
    else if (vent.a === vent.b) problems.push(`${label}: both ends are the same room`);
  }

  // Hull outline
  if (!Array.isArray(data.hull) || data.hull.length < 3 || !data.hull.every((p) => Array.isArray(p) && p.length === 2 && p.every(isNum))) {
    problems.push('needs a "hull" outline of at least three [x, y] points');
  }

  problems.push(...validatePower(data));

  return problems;
}

/**
 * Turn layout data into what the sim and renderer use. Throws if the layout
 * is not sound, so nothing downstream has to guard against bad data.
 */
export function buildLayout(data) {
  const problems = validateLayout(data);
  if (problems.length) throw new Error(`Ship layout "${data.id}" is invalid: ${problems.join('; ')}`);

  const rooms = data.rooms.map((room) => Object.freeze({ kind: 'room', ...room }));
  const doors = data.doors.map((door) => Object.freeze({ ...door, airlock: door.b === SPACE }));
  const vents = (data.vents ?? []).map((vent) => Object.freeze({ ...vent }));
  const roomById = new Map(rooms.map((r) => [r.id, r]));
  const doorById = new Map(doors.map((d) => [d.id, d]));

  // roomId -> [{ door, to }] where `to` is a room id or "space"
  const exits = new Map(rooms.map((r) => [r.id, []]));
  for (const door of doors) {
    exits.get(door.a).push({ door: door.id, to: door.b });
    if (!door.airlock) exits.get(door.b).push({ door: door.id, to: door.a });
  }
  // roomId -> [{ vent, to }]
  const ventExits = new Map(rooms.map((r) => [r.id, []]));
  for (const vent of vents) {
    ventExits.get(vent.a).push({ vent: vent.id, to: vent.b });
    ventExits.get(vent.b).push({ vent: vent.id, to: vent.a });
  }

  const xs = data.hull.map((p) => p[0]);
  const ys = data.hull.map((p) => p[1]);
  const bounds = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };

  return Object.freeze({
    id: data.id,
    name: data.name,
    hull: data.hull,
    bounds,
    rooms,
    doors,
    vents,
    power: Object.freeze(structuredClone(data.power)),
    room: (id) => roomById.get(id),
    door: (id) => doorById.get(id),
    exits: (roomId) => exits.get(roomId) ?? [],
    ventExits: (roomId) => ventExits.get(roomId) ?? [],
    roomOfSystem: (system) => rooms.find((r) => r.system === system),
  });
}
