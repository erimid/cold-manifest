// Crew: where they are, how they walk, and what they do when they get there
// (brief §6, §8). DOM-free.
//
// S1.6 crew are placeholders with a name, a position, health and a suit flag.
// Skills, traits, needs, stress and memory arrive in Stage 4 and hang off the
// same objects.
//
// A crew member is sent to a room and walks there through doors, opening the
// shut ones (and closing behind themselves the ones they opened). Once in a
// room with nowhere else to be, they deal with the worst thing in it without
// being told: fire first, then a breach, then a damaged system, then a jammed
// door.
//
// In a fight (S2.4) crew can be aboard the other ship: `owner` says whose crew
// they are ('player' or 'enemy') and the ship's `side` says whose ship it is.
// Anyone aboard a ship that is not theirs is a boarder: they fight whoever of
// the other side shares their room, wreck the system they stand in, and fix
// nothing. Crossing between ships is boarding.js.

import { crewEmit, harmCrew } from './atmosphere.js';
import { SPACE, SYSTEMS } from './systems.js';

/** Tiles per second on foot. A suit is heavy. */
export const WALK_SPEED = 3;
export const SUIT_SPEED = 0.7;
/** Work rates, per second, for one healthy crew member in a lit room. */
export const EXTINGUISH_RATE = 0.09; // fire intensity
export const PATCH_RATE = 0.06; // breach size
export const REPAIR_RATE = 1 / 8; // system bars
export const UNJAM_RATE = 1 / 6; // doors
/** A suit makes fiddly work slower; so does the dark (brief §6). Fire makes its own light. */
export const SUIT_WORK = 0.75;
export const DARK_WORK = 0.5;
/** Health regained per second in a powered medbay. */
export const MEDBAY_HEAL = 1 / 40;
/** How open a door must be to walk through. */
export const WALKABLE = 0.9;
/** Hand to hand: one healthy fighter takes a healthy one down alone in this many seconds. Hurt fighters hit softer. */
export const MELEE_SECONDS = 14;
/** A boarder left alone with a system breaks a bar of it every this many seconds. */
export const SABOTAGE_SECONDS = 9;

/** Where crew stand in a room, as offsets from its middle, by their place on the roster. */
const SPOTS = [[0, 0], [-1, 0.6], [1, 0.6], [-1, -0.6], [1, -0.6], [0, 1.1], [0, -1.1], [1.6, 0]];
const EDGE = 0.6; // how close to a wall anyone stands

export function spotIn(room, index) {
  const [dx, dy] = SPOTS[index % SPOTS.length];
  const clamp = (value, low, high) => (high < low ? (low + high) / 2 : Math.max(low, Math.min(high, value)));
  return {
    x: clamp(room.x + room.w / 2 + dx, room.x + EDGE, room.x + room.w - EDGE),
    y: clamp(room.y + room.h / 2 + dy, room.y + EDGE, room.y + room.h - EDGE),
  };
}

/** A new crew member standing in `roomId`. `index` is their place on the roster. */
export function newCrewMember(layout, { id, name }, roomId, index = 0, owner = 'player') {
  const { x, y } = spotIn(layout.room(roomId), index);
  return {
    id,
    name: name ?? id,
    index,
    owner, // whose crew: 'player' or 'enemy'. Not always the ship they are aboard

    room: roomId,
    x,
    y,
    px: x, // where they were a tick ago, so the renderer can move them smoothly
    py: y,
    health: 1,
    suit: false,
    alive: true,
    goal: null, // the room they are walking to
    path: [], // waypoints still ahead of them
    task: 'idle', // what they are doing: idle | walking | waiting | extinguish | patch | repair | unjam | fighting | sabotage | crossing
    board: null, // set while heading for the other ship: { room } there to go to (boarding.js)
    crossEnds: null, // the tick they come out the other end, while crossing
    wreck: 0, // 0 to 1 progress toward breaking the next bar of the system they are sabotaging
  };
}

/** The starting roster for a ship: people from content, placed in the ship's `crewStart` rooms. */
export function newCrewState(layout, roster = [], owner = 'player') {
  const crew = {};
  const starts = layout.crewStart.length ? layout.crewStart : [layout.rooms[0].id];
  roster.forEach((person, index) => {
    crew[person.id] = newCrewMember(layout, person, starts[index % starts.length], index, owner);
  });
  return crew;
}

/** Is this crew member aboard their own ship? */
export const isHome = (ship, member) => (member.owner ?? 'player') === (ship.side ?? 'player');


// ---------- finding the way ----------

/** Can someone on foot get through this door, if they open it themselves? */
export function isPassable(sim, doorId) {
  const door = sim.layout.door(doorId);
  const d = sim.state.doors[doorId];
  if (door.airlock || d.sealed || d.state === 'locked') return false;
  if (d.state === 'jammed' && d.openness < WALKABLE) return false;
  return true;
}

/** The doors to go through from one room to another, fewest first, or null if there is no way. */
export function findRoute(sim, from, to) {
  if (from === to) return [];
  const cameBy = new Map([[from, null]]);
  const queue = [from];
  while (queue.length) {
    const here = queue.shift();
    for (const exit of sim.layout.exits(here)) {
      if (exit.to === SPACE || cameBy.has(exit.to) || !isPassable(sim, exit.door)) continue;
      if (sim.state.rooms[exit.to].jettisoned) continue;
      cameBy.set(exit.to, { door: exit.door, from: here });
      if (exit.to === to) {
        const route = [];
        for (let step = cameBy.get(to); step; step = cameBy.get(step.from)) route.unshift({ door: step.door, from: step.from });
        return route;
      }
      queue.push(exit.to);
    }
  }
  return null;
}

/** The point half a tile inside `roomId` from a door. */
function besideDoor(layout, door, roomId) {
  const room = layout.room(roomId);
  if (door.vertical) return { x: door.x + (room.x + room.w / 2 < door.x ? -0.5 : 0.5), y: door.y };
  return { x: door.x, y: door.y + (room.y + room.h / 2 < door.y ? -0.5 : 0.5) };
}

/** Waypoints from where a crew member stands to their spot in `to`, or null if there is no way. */
export function planPath(sim, member, to) {
  const route = findRoute(sim, member.room, to);
  if (!route) return null;
  const path = [];
  for (const step of route) {
    const door = sim.layout.door(step.door);
    const next = door.a === step.from ? door.b : door.a;
    path.push({ ...besideDoor(sim.layout, door, step.from), door: door.id });
    path.push({ ...besideDoor(sim.layout, door, next), enter: next, through: door.id });
  }
  path.push(spotIn(sim.layout.room(to), member.index));
  return path;
}

// ---------- orders ----------

const living = (sim, id) => {
  const member = sim.state.crew[id];
  if (!member) return `no crew member "${id}"`;
  if (!member.alive) return `${member.name} is dead`;
  return null;
};

export const CREW_COMMANDS = {
  // Send someone to a room. They work out the doors themselves.
  'crew.move': {
    check(sim, cmd) {
      const problem = living(sim, cmd.crew);
      if (problem) return problem;
      const room = sim.state.rooms[cmd.room];
      if (!room) return `no room "${cmd.room}"`;
      if (room.jettisoned) return 'that section is gone';
      if (!findRoute(sim, sim.state.crew[cmd.crew].room, cmd.room)) return 'there is no way through: a door on the way is locked or jammed';
      return null;
    },
    apply(sim, cmd) {
      const member = sim.state.crew[cmd.crew];
      member.goal = cmd.room;
      member.path = planPath(sim, member, cmd.room);
      member.task = 'walking';
      crewEmit(sim, member, 'crew.ordered', { crew: cmd.crew, room: cmd.room, tick: sim.state.tick });
    },
  },
  // Suit up or strip off. A suit keeps you breathing and halves burns, and slows everything you do.
  'crew.suit': {
    check(sim, cmd) {
      const problem = living(sim, cmd.crew);
      if (problem) return problem;
      if (typeof cmd.on !== 'boolean') return 'needs on: true or false';
      return null;
    },
    apply(sim, cmd) {
      const member = sim.state.crew[cmd.crew];
      if (member.suit === cmd.on) return;
      member.suit = cmd.on;
      crewEmit(sim, member, 'crew.suit', { crew: cmd.crew, on: cmd.on, tick: sim.state.tick });
    },
  },
  // Debug panel only: set someone's health.
  'debug.crew': {
    check(sim, cmd) {
      const problem = living(sim, cmd.crew);
      if (problem) return problem;
      if (!(cmd.health > 0 && cmd.health <= 1)) return 'health must be above 0 and at most 1';
      return null;
    },
    apply(sim, cmd) {
      sim.state.crew[cmd.crew].health = cmd.health;
    },
  },
};

// ---------- each tick ----------

function setDoor(sim, doorId, to, by) {
  const door = sim.state.doors[doorId];
  if (door.state === to) return;
  const from = door.state;
  door.state = to;
  sim.events.emit('door.changed', { door: doorId, from, to, by, tick: sim.state.tick });
}

function stop(sim, member, reason, door) {
  member.goal = null;
  member.path = [];
  member.task = 'idle';
  member.board = null;
  crewEmit(sim, member, 'crew.blocked', { crew: member.id, room: member.room, door, reason, tick: sim.state.tick });
}

function walk(sim, member, seconds) {
  let left = WALK_SPEED * (member.suit ? SUIT_SPEED : 1) * seconds;
  member.task = 'walking';
  while (member.path.length) {
    const next = member.path[0];
    const distance = Math.hypot(next.x - member.x, next.y - member.y);
    if (distance > left) {
      member.x += ((next.x - member.x) * left) / distance;
      member.y += ((next.y - member.y) * left) / distance;
      return;
    }
    member.x = next.x;
    member.y = next.y;
    left -= distance;

    if (next.door) {
      // Standing at a door. Is it still a way through, and is it open yet?
      const d = sim.state.doors[next.door];
      if (!isPassable(sim, next.door)) {
        const detour = planPath(sim, member, member.goal);
        if (!detour) return stop(sim, member, 'door', next.door);
        member.path = detour;
        continue;
      }
      if (d.openness < WALKABLE) {
        if (d.state !== 'open') {
          setDoor(sim, next.door, 'open', member.id);
          member.path[1].close = true; // they opened it, so they shut it behind them
        }
        member.task = 'waiting';
        return;
      }
    }
    if (next.enter) {
      member.room = next.enter;
      // Shut the door they opened, unless someone else is about to use it.
      const others = Object.values(sim.state.crew).some((other) => other !== member && other.alive && (other.path[0]?.door === next.through || other.path[0]?.through === next.through));
      if (next.close && !others && sim.state.doors[next.through].state === 'open') setDoor(sim, next.through, 'closed', member.id);
    }
    member.path.shift();
  }
  member.goal = null;
  member.task = 'idle';
  crewEmit(sim, member, 'crew.arrived', { crew: member.id, room: member.room, tick: sim.state.tick });
}

/** What needs doing most in the room this crew member is standing in. */
function jobIn(sim, member) {
  const room = sim.layout.room(member.room);
  const r = sim.state.rooms[member.room];
  if (r.jettisoned) return null;
  if (!isHome(sim, member)) {
    // Aboard their ship, there is nothing to save and a system to break.
    const system = room.system ? sim.state.systems[room.system] : null;
    return system && !system.lost && system.damage < system.level ? { type: 'sabotage', system: room.system } : null;
  }
  if (r.fire > 0) return { type: 'extinguish' };
  if (r.breach > 0) return { type: 'patch' };
  if (room.system) {
    const system = sim.state.systems[room.system];
    if (system.damage > 0 && !system.lost) return { type: 'repair', system: room.system };
  }
  for (const exit of sim.layout.exits(member.room)) {
    const d = sim.state.doors[exit.door];
    if (d.state === 'jammed' && !d.sealed) return { type: 'unjam', door: exit.door };
  }
  return null;
}

/** The other side's people in this crew member's room, still on their feet and not in the docking tube. */
export function hostilesBeside(sim, member) {
  return Object.values(sim.state.crew).filter((other) => other.alive && other.room === member.room && other.owner !== member.owner && other.task !== 'crossing');
}

function fight(sim, member, foes, seconds) {
  member.task = 'fighting';
  // Everyone goes for whoever is closest to dropping. Stage 4 skills and traits change who wins (brief §7).
  const target = foes.reduce((weakest, other) => (other.health < weakest.health ? other : weakest));
  harmCrew(sim, target.id, ((0.5 + 0.5 * member.health) * seconds) / MELEE_SECONDS, 'melee');
}

function work(sim, member, seconds) {
  const foes = hostilesBeside(sim, member);
  if (foes.length) return fight(sim, member, foes, seconds);
  const job = jobIn(sim, member);
  member.task = job ? job.type : 'idle';
  const r = sim.state.rooms[member.room];

  if (!job) {
    // Nothing to fix: a powered medbay patches up its own crew instead.
    if (isHome(sim, member) && sim.layout.room(member.room).system === 'medbay' && sim.state.systems.medbay.power > 0 && member.health < 1) {
      member.health = Math.min(1, member.health + MEDBAY_HEAL * sim.state.systems.medbay.power * seconds);
    }
    return;
  }

  // Hurt people work slower, and so does anyone in a suit or in the dark.
  let rate = (0.5 + 0.5 * member.health) * (member.suit ? SUIT_WORK : 1) * seconds;
  if (job.type !== 'extinguish' && r.light < 0.5) rate *= DARK_WORK;

  if (job.type === 'extinguish') {
    r.fire = Math.max(0, r.fire - EXTINGUISH_RATE * rate);
    if (r.fire === 0) {
      r.burning = false;
      r.scorch = 0;
      sim.events.emit('fire.out', { room: member.room, by: member.id, tick: sim.state.tick });
    }
  } else if (job.type === 'patch') {
    r.breach = Math.max(0, r.breach - PATCH_RATE * rate);
    if (r.breach === 0) sim.events.emit('breach.sealed', { room: member.room, by: member.id, tick: sim.state.tick });
  } else if (job.type === 'repair') {
    const system = sim.state.systems[job.system];
    system.repair = (system.repair ?? 0) + REPAIR_RATE * rate;
    if (system.repair >= 1) {
      system.repair = 0;
      system.damage -= 1;
      sim.events.emit('system.repaired', { system: job.system, damage: system.damage, by: member.id, tick: sim.state.tick });
    }
  } else if (job.type === 'sabotage') {
    const system = sim.state.systems[job.system];
    member.wreck += ((0.5 + 0.5 * member.health) * seconds) / SABOTAGE_SECONDS;
    if (member.wreck >= 1) {
      member.wreck = 0;
      const from = system.damage;
      system.damage += 1;
      sim.events.emit('system.damage', { system: job.system, from, to: system.damage, cause: 'sabotage', by: member.id, tick: sim.state.tick });
    }
  } else if (job.type === 'unjam') {
    const d = sim.state.doors[job.door];
    d.repair = (d.repair ?? 0) + UNJAM_RATE * rate;
    if (d.repair >= 1) {
      d.repair = 0;
      setDoor(sim, job.door, d.openness >= 0.5 ? 'open' : 'closed', member.id);
    }
  }
}

/** Move and work everyone, in roster order. */
export function stepCrew(sim, seconds) {
  for (const member of Object.values(sim.state.crew)) {
    member.px = member.x;
    member.py = member.y;
    if (!member.alive) continue;
    if (member.path.length) walk(sim, member, seconds);
    else if (!member.board) work(sim, member, seconds); // at the airlock, or in the tube: boarding.js has them
  }
}

/** A line for the UI about what someone is doing. */
export function describeTask(sim, member) {
  if (!member.alive) return 'Dead';
  const room = sim.layout.room(member.room);
  switch (member.task) {
    case 'walking':
      if (member.board) return 'Heading for the airlock';
      return `Walking to ${sim.layout.room(member.goal)?.name ?? 'somewhere'}`;
    case 'crossing':
      return isHome(sim, member) ? 'Crossing over' : 'Crossing back';
    case 'fighting':
      return 'Fighting hand to hand';
    case 'sabotage':
      return `Wrecking ${SYSTEMS[room.system].name.toLowerCase()}`;
    case 'waiting':
      return 'Waiting on a door';
    case 'extinguish':
      return 'Fighting the fire';
    case 'patch':
      return 'Patching the hull';
    case 'repair':
      return `Repairing ${SYSTEMS[room.system].name.toLowerCase()}`;
    case 'unjam':
      return 'Freeing a jammed door';
    default:
      return isHome(sim, member) && room.system === 'medbay' && member.health < 1 && sim.state.systems.medbay.power > 0 ? 'Being patched up' : 'Standing by';
  }
}

/** Crew problems that should never happen. */
export function checkCrewInvariants(sim) {
  const problems = [];
  for (const [id, member] of Object.entries(sim.state.crew)) {
    const room = sim.layout.room(member.room);
    if (!room) {
      problems.push(`crew ${id} is in unknown room "${member.room}"`);
      continue;
    }
    if (!Number.isFinite(member.x) || !Number.isFinite(member.y)) problems.push(`crew ${id} is at ${member.x}, ${member.y}`);
    else if (member.alive && !member.path.length && (member.x < room.x || member.x > room.x + room.w || member.y < room.y || member.y > room.y + room.h)) {
      problems.push(`crew ${id} is standing outside ${member.room}`);
    }
    if (!member.alive && (member.path.length || member.goal)) problems.push(`crew ${id} is dead but still has somewhere to be`);
    if (member.alive && !(member.health > 0 && member.health <= 1)) problems.push(`crew ${id} is alive with health ${member.health}`);
    if (!['player', 'enemy'].includes(member.owner)) problems.push(`crew ${id} belongs to "${member.owner}"`);
    if (!(member.wreck >= 0 && member.wreck < 1)) problems.push(`crew ${id} wreck progress is ${member.wreck}`);
    if (member.task === 'crossing' && !(member.board && member.crossEnds !== null)) problems.push(`crew ${id} is crossing with nowhere to go`);
    if (member.board && !member.alive) problems.push(`crew ${id} is dead but still boarding`);
  }
  for (const id of Object.keys(sim.state.systems)) {
    const repair = sim.state.systems[id].repair ?? 0;
    if (!(repair >= 0 && repair < 1)) problems.push(`${id}.repair is ${repair}`);
  }
  return problems;
}
