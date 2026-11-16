// Ship layouts (brief §6). A layout is content: a JSON item under
// content/ships/. This module checks a layout and turns it into the graphs
// the sim and renderer use. Pure and DOM-free.
//
// Layouts are drawn on a grid of square tiles. From S2.6 (D-071) the player's
// ship is drawn side-on: x runs along the ship, y runs down through its decks,
// so a room's floor is its bottom edge.
//   decks   optional [{ id, name, y, h }]: the horizontal bands rooms sit in, for
//           the schematic's deck labels. Every room fits inside its decks; a
//           room may span several (a tall hold, an engine room, a lift shaft).
//   rooms   rectangles { id, name, x, y, w, h, kind?, system?, jettison? } in whole
//           tiles. `jettison: true` marks a section that can be cut loose.
//           `kind: "lift"` is a lift shaft: crew ride it fast while door control
//           has power, and cannot use it at all while it has none.
//   doors   { id, a, b, x, y, vertical } where (x, y) is the middle of the
//           doorway on the wall the two rooms share, and `vertical` says the
//           wall runs up and down. `b` may be "space" for an airlock. A door
//           in a floor or ceiling (vertical: false) is a hatch with a ladder.
//   crawlways  { id, a, b, creature? } (D-072): service crawlways between two
//           rooms that share a wall. Only engineers use them (slowly), and
//           `creature: true` marks a duct too narrow for anyone but the creature.
//   hull    the outline of the ship as a list of [x, y] points
//   crewStart  room ids where the starting crew stand, in roster order
//   power   { reactor, lightsPerBar, systems: { id: { level, power } } }: the
//           reactor's bars, how many lit rooms one bar carries, and each
//           powered system's size and starting power (see power.js)
//   hullPoints  how much punishment the ship takes before it breaks up
//   hardpoints  [{ id, x, y }]: where weapons mount on the hull, 2 to 4
//   weapons     ids from content/weapons/, fitted to the hardpoints in order
//   facing      "right" (the default), "left" or "up": which way the bow points
//   enemy       true for a ship the player fights rather than flies. An enemy
//               may leave systems out, mount no weapons and carry no crew.
//   crew        enemies only: who is aboard, [{ id, name }], placed in crewStart
//   tactics     enemies only: how it fights, hails, surrenders and runs (tactics.js)

import { validatePower } from './power.js';
import { validateTactics } from './tactics.js';
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

/**
 * Where two rooms touch: the shared stretch of wall at least one tile long, as
 * { vertical, at, from, to } (at is the wall's x or y; from and to run along it), or null.
 */
export function sharedWall(a, b) {
  const span = (lo1, hi1, lo2, hi2) => [Math.max(lo1, lo2), Math.min(hi1, hi2)];
  if (a.x + a.w === b.x || b.x + b.w === a.x) {
    const [from, to] = span(a.y, a.y + a.h, b.y, b.y + b.h);
    if (to - from >= 1) return { vertical: true, at: a.x + a.w === b.x ? b.x : a.x, from, to };
  }
  if (a.y + a.h === b.y || b.y + b.h === a.y) {
    const [from, to] = span(a.x, a.x + a.w, b.x, b.x + b.w);
    if (to - from >= 1) return { vertical: false, at: a.y + a.h === b.y ? b.y : a.y, from, to };
  }
  return null;
}

/**
 * The two ends of a crawlway: a service hatch in each room, either side of the
 * shared wall (above the doorways for a wall, by the wall's far end for a floor).
 */
export function crawlHatches(a, b) {
  const wall = sharedWall(a, b);
  const inset = 0.55;
  if (wall.vertical) {
    // Waist high above the floor of the lower of the two, clear of any doorway (doors are a tile tall, at floor level).
    const y = wall.to - wall.from >= 2.5 ? wall.to - 1.5 : (wall.from + wall.to) / 2;
    const side = (room) => (room.x < wall.at ? -inset : inset);
    return { [a.id]: { x: wall.at + side(a), y }, [b.id]: { x: wall.at + side(b), y } };
  }
  const x = wall.to - inset;
  const side = (room) => (room.y < wall.at ? -inset : inset);
  return { [a.id]: { x, y: wall.at + side(a) }, [b.id]: { x, y: wall.at + side(b) } };
}

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
  if (data.vents !== undefined) problems.push('"vents" became "crawlways" in S2.6');
  const crawlways = data.crawlways ?? [];
  if (!Array.isArray(crawlways)) return [...problems, '"crawlways" must be a list'];

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
    if (room.kind === 'lift' && room.system !== undefined) problems.push(`${label}: a lift shaft holds no system`);
    for (const other of rooms.values()) {
      if (overlaps(room, other)) problems.push(`${label}: overlaps room "${other.id}"`);
    }
    rooms.set(room.id, room);
  }

  if (data.enemy !== undefined && typeof data.enemy !== 'boolean') problems.push('"enemy" must be true or false');
  const enemy = data.enemy === true;

  // Systems: each exactly once. An enemy ship may do without most of them.
  for (const system of SYSTEM_IDS) {
    const homes = data.rooms.filter((r) => r?.system === system).map((r) => r.id);
    if (homes.length === 0 && (!enemy || system === 'reactor')) problems.push(`no room holds the ${system} system`);
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

  // Decks: bands that do not overlap, and every room inside the ones it spans
  const decks = data.decks ?? [];
  if (!Array.isArray(decks) || !decks.every((d) => d && typeof d.id === 'string' && d.id && typeof d.name === 'string' && Number.isInteger(d.y) && Number.isInteger(d.h) && d.h >= 1)) {
    problems.push('"decks" must be a list of { id, name, y, h } in whole tiles');
  } else if (decks.length) {
    const sorted = [...decks].sort((a, b) => a.y - b.y);
    for (let i = 1; i < sorted.length; i++) if (sorted[i].y < sorted[i - 1].y + sorted[i - 1].h) problems.push(`deck "${sorted[i].id}" overlaps deck "${sorted[i - 1].id}"`);
    for (const room of rooms.values()) {
      const top = sorted.find((d) => d.y === room.y);
      const bottom = sorted.find((d) => d.y + d.h === room.y + room.h);
      if (!top || !bottom) problems.push(`room "${room.id}": its ceiling and floor must line up with decks`);
    }
  }

  // Crawlways
  const crawlIds = new Set();
  for (const crawl of crawlways) {
    const label = `crawlway "${crawl?.id}"`;
    if (!crawl || typeof crawl.id !== 'string' || !crawl.id) {
      problems.push('a crawlway is missing its id');
      continue;
    }
    if (crawlIds.has(crawl.id)) problems.push(`${label}: duplicate crawlway id`);
    crawlIds.add(crawl.id);
    if (crawl.creature !== undefined && typeof crawl.creature !== 'boolean') problems.push(`${label}: "creature" must be true or false`);
    const a = rooms.get(crawl.a);
    const b = rooms.get(crawl.b);
    if (!a || !b) problems.push(`${label}: both ends must be rooms`);
    else if (a === b) problems.push(`${label}: both ends are the same room`);
    else if (!sharedWall(a, b)) problems.push(`${label}: rooms "${a.id}" and "${b.id}" do not share a wall`);
  }

  // Hull outline
  if (!Array.isArray(data.hull) || data.hull.length < 3 || !data.hull.every((p) => Array.isArray(p) && p.length === 2 && p.every(isNum))) {
    problems.push('needs a "hull" outline of at least three [x, y] points');
  }

  // Where the crew start
  if (!Array.isArray(data.crewStart) || (!data.crewStart.length && !enemy)) problems.push('needs a "crewStart" list of room ids');
  else for (const id of data.crewStart) if (!rooms.has(id)) problems.push(`crewStart: no room "${id}"`);

  problems.push(...validatePower(data));

  // An enemy's own crew and how it fights. The player's crew come from content/crew/ instead.
  const roster = data.crew ?? [];
  if (!Array.isArray(roster) || !roster.every((p) => p && typeof p.id === 'string' && p.id && typeof p.name === 'string' && p.name)) problems.push('"crew" must be a list of { id, name }');
  else {
    if (roster.length && !enemy) problems.push('only an enemy ship lists its own "crew"');
    if (new Set(roster.map((p) => p.id)).size !== roster.length) problems.push('crew: duplicate id');
    if (roster.length && Array.isArray(data.crewStart) && !data.crewStart.length) problems.push('a ship with crew needs a "crewStart" list');
  }
  if (data.tactics !== undefined && !enemy) problems.push('only an enemy ship has "tactics"');
  problems.push(...validateTactics(data.tactics, { crewed: Array.isArray(roster) && roster.length > 0 }));

  // Fighting: hull strength, hardpoints and what is mounted on them
  if (!Number.isInteger(data.hullPoints) || data.hullPoints < 1) problems.push('"hullPoints" must be a whole number, at least 1');
  const hardpoints = data.hardpoints ?? [];
  const fitted = data.weapons ?? [];
  if (!Array.isArray(hardpoints) || !hardpoints.every((h) => h && typeof h.id === 'string' && h.id && isNum(h.x) && isNum(h.y))) {
    problems.push('"hardpoints" must be a list of { id, x, y }');
  } else {
    if (new Set(hardpoints.map((h) => h.id)).size !== hardpoints.length) problems.push('hardpoints: duplicate id');
    if (hardpoints.length > 4 || (!enemy && hardpoints.length < 2)) problems.push(`needs ${enemy ? 'at most 4' : '2 to 4'} hardpoints, has ${hardpoints.length}`);
    if (!Array.isArray(fitted) || !fitted.every((id) => typeof id === 'string' && id)) problems.push('"weapons" must be a list of weapon ids');
    else if (fitted.length > hardpoints.length) problems.push(`${fitted.length} weapons fitted but only ${hardpoints.length} hardpoints`);
  }
  if (data.facing !== undefined && !['right', 'up', 'left'].includes(data.facing)) problems.push('"facing" must be "right", "left" or "up"');

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
  const decks = Object.freeze((data.decks ?? []).map((deck) => Object.freeze({ ...deck })));
  const crawlways = (data.crawlways ?? []).map((crawl) => {
    const a = data.rooms.find((r) => r.id === crawl.a);
    const b = data.rooms.find((r) => r.id === crawl.b);
    return Object.freeze({ creature: false, ...crawl, hatches: Object.freeze(crawlHatches(a, b)) });
  });
  const roomById = new Map(rooms.map((r) => [r.id, r]));
  const doorById = new Map(doors.map((d) => [d.id, d]));

  // roomId -> [{ door, to }] where `to` is a room id or "space"
  const exits = new Map(rooms.map((r) => [r.id, []]));
  for (const door of doors) {
    exits.get(door.a).push({ door: door.id, to: door.b });
    if (!door.airlock) exits.get(door.b).push({ door: door.id, to: door.a });
  }
  // roomId -> [{ crawlway, to }]
  const crawlExits = new Map(rooms.map((r) => [r.id, []]));
  for (const crawl of crawlways) {
    crawlExits.get(crawl.a).push({ crawlway: crawl.id, to: crawl.b, creature: crawl.creature });
    crawlExits.get(crawl.b).push({ crawlway: crawl.id, to: crawl.a, creature: crawl.creature });
  }
  const crawlById = new Map(crawlways.map((c) => [c.id, c]));

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
    decks,
    crawlways,
    power: Object.freeze(structuredClone(data.power)),
    crewStart: Object.freeze([...data.crewStart]),
    enemy: data.enemy === true,
    crew: Object.freeze((data.crew ?? []).map((p) => Object.freeze({ ...p }))),
    tactics: data.tactics ? Object.freeze(structuredClone(data.tactics)) : null,
    facing: data.facing ?? 'right',
    hullPoints: data.hullPoints,
    hardpoints: Object.freeze((data.hardpoints ?? []).map((h) => Object.freeze({ ...h }))),
    weapons: Object.freeze([...(data.weapons ?? [])]),
    hasSystem: (system) => rooms.some((r) => r.system === system),
    room: (id) => roomById.get(id),
    door: (id) => doorById.get(id),
    exits: (roomId) => exits.get(roomId) ?? [],
    crawlExits: (roomId) => crawlExits.get(roomId) ?? [],
    crawlway: (id) => crawlById.get(id),
    roomOfSystem: (system) => rooms.find((r) => r.system === system),
  });
}
