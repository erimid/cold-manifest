// Crew: where they are, how they walk, and what they do when they get there
// (brief §6, §8). DOM-free.
//
// S1.6 crew are placeholders with a name, a position, health and a suit flag.
// S2.10 gave them a short memory and a nerve for the dark (memory.js), and
// with those the right to refuse an order. Skills, traits, needs and stress
// arrive in Stage 4 and hang off the same objects.
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
import { refusalOf } from './memory.js';
import { isPowered } from './power.js';
import { SPACE, SYSTEMS } from './systems.js';

/** Tiles per second on foot. A suit is heavy. */
export const WALK_SPEED = 3;
export const SUIT_SPEED = 0.7;
/**
 * Every way between decks is a lift (D-093): the main shaft, and a deck lift
 * under each hatch. With door control powered a lift carries crew at this many
 * times walking speed; without it they crank it by hand, at this share of it.
 */
export const LIFT_SPEED = 2;
export const CRANK_SPEED = 0.3;
/** How fast the lifts run just now: powered, or cranked by hand. */
export const liftSpeed = (sim) => (isPowered(sim, 'doors') ? LIFT_SPEED : CRANK_SPEED);
/** Seconds an engineer takes to squeeze through a service crawlway (D-072). */
export const CRAWL_SECONDS = 2.5;
/** Carrying a crate (hold.js) slows anyone down to this share of their pace, and nobody carries through a crawlway. */
export const CARRY_SPEED = 0.6;
/** Work rates, per second, for one healthy crew member in a lit room. */
export const EXTINGUISH_RATE = 0.09; // fire intensity
export const PATCH_RATE = 0.06; // breach size
export const REPAIR_RATE = 1 / 8; // system bars
export const UNJAM_RATE = 1 / 6; // doors
/** A suit makes fiddly work slower; so does the dark (brief §6). Fire makes its own light. */
export const SUIT_WORK = 0.75;
export const DARK_WORK = 0.5;
/** Below this light a room counts as dark to walk through, and crew go at DARK_WALK of their pace (S2.5, D-096). */
export const DARK_LIGHT = 0.2;
export const DARK_WALK = 0.7;
/** Health regained per second in a powered medbay. */
export const MEDBAY_HEAL = 1 / 40;
/** How open a door must be to walk through. */
export const WALKABLE = 0.9;
/** Hand to hand: one healthy fighter takes a healthy one down alone in this many seconds. Hurt fighters hit softer. */
export const MELEE_SECONDS = 14;
/** A boarder left alone with a system breaks a bar of it every this many seconds. */
export const SABOTAGE_SECONDS = 9;

/** Where crew stand in a room, as offsets along its floor from the middle, by their place on the roster. Side-on, everyone stands on the deck. */
const SPOTS = [0, -1, 1, -2, 2, -0.5, 0.5, 1.5];
const EDGE = 0.6; // how close to a wall anyone stands
/** How far above the floor a standing crew member's middle is. */
export const STAND = 0.5;

export function spotIn(room, index) {
  const dx = SPOTS[index % SPOTS.length];
  const clamp = (value, low, high) => (high < low ? (low + high) / 2 : Math.max(low, Math.min(high, value)));
  return { x: clamp(room.x + room.w / 2 + dx, room.x + EDGE, room.x + room.w - EDGE), y: room.y + room.h - STAND };
}

/** A new crew member standing in `roomId`. `index` is their place on the roster. */
export function newCrewMember(layout, { id, name, engineer = false }, roomId, index = 0, owner = 'player') {
  const { x, y } = spotIn(layout.room(roomId), index);
  return {
    id,
    name: name ?? id,
    index,
    owner, // whose crew: 'player' or 'enemy'. Not always the ship they are aboard
    engineer: engineer === true, // may use the service crawlways (D-072); from S4.1 a skill or trait decides

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
    carry: null, // the crate in their arms (hold.js)
    job: null, // a crate job under way: { kind, crate, to, slot, phase, t, since } (hold.js)
    memories: [], // what they remember: { type, tick, room, who, dark } (memory.js)
    dread: 0, // 0 to 1: how the dark is wearing on them (memory.js)
    lampUntil: 0, // the tick until which they will not sit in the dark again
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

/** Put down whatever they are carrying, where they stand, and drop the job they were on. `keep` is a crate to hold on to. */
export function letGo(sim, member, { keep = null } = {}) {
  if (member.carry && member.carry !== keep) {
    const crate = sim.state.crates?.[member.carry];
    if (crate) Object.assign(crate, { room: member.room, by: null });
    member.carry = null;
  }
  member.job = null;
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


/** The middle of a room's floor, for estimating how long a trip takes. */
const floorMid = (room) => ({ x: room.x + room.w / 2, y: room.y + room.h - STAND });

/**
 * The quickest way from one room to another, or null if there is no way: a list of
 * steps { door, from } or { crawlway, from }. Trips are costed in seconds on foot:
 * the lifts are faster than walking with power and slower cranked by hand, and crawlways, open only
 * to an engineer (`who.engineer`) with empty hands, are slow.
 */
export function findRoute(sim, from, to, who = null) {
  if (from === to) return [];
  const { layout } = sim;
  const best = new Map([[from, { cost: 0, step: null }]]);
  const done = new Set();
  const open = [from];
  const rise = liftSpeed(sim);
  while (open.length) {
    open.sort((a, b) => best.get(a).cost - best.get(b).cost || (a < b ? -1 : 1));
    const here = open.shift();
    if (here === to) break;
    if (done.has(here)) continue;
    done.add(here);
    const room = layout.room(here);
    const at = floorMid(room);
    const edges = [];
    for (const exit of layout.exits(here)) {
      if (exit.to === SPACE || !isPassable(sim, exit.door)) continue;
      const door = layout.door(exit.door);
      const next = layout.room(exit.to);
      const there = floorMid(next);
      const walk = (Math.abs(door.x - at.x) + Math.abs(there.x - door.x)) / WALK_SPEED;
      // Up or down a deck lift, or along the main shaft.
      const ride = !door.vertical || room.kind === 'lift' || next.kind === 'lift' ? Math.abs(there.y - at.y) / (WALK_SPEED * rise) : 0;
      edges.push({ to: exit.to, cost: walk + ride, step: { door: exit.door, from: here } });
    }
    if (who?.engineer && !who.carry) {
      for (const exit of layout.crawlExits(here)) {
        if (exit.creature) continue;
        const there = floorMid(layout.room(exit.to));
        edges.push({ to: exit.to, cost: CRAWL_SECONDS + (Math.abs(there.x - at.x) + Math.abs(there.y - at.y)) / WALK_SPEED, step: { crawlway: exit.crawlway, from: here } });
      }
    }
    for (const edge of edges) {
      if (sim.state.rooms[edge.to].jettisoned) continue;
      const cost = best.get(here).cost + edge.cost;
      if (!best.has(edge.to) || cost < best.get(edge.to).cost - 1e-9) {
        best.set(edge.to, { cost, step: edge.step });
        open.push(edge.to);
      }
    }
  }
  if (!best.has(to)) return null;
  const route = [];
  for (let at = to; at !== from; at = best.get(at).step.from) route.unshift(best.get(at).step);
  return route;
}

/** The point half a tile inside `roomId` from a door. */
function besideDoor(layout, door, roomId) {
  const room = layout.room(roomId);
  if (door.vertical) return { x: door.x + (room.x + room.w / 2 < door.x ? -0.5 : 0.5), y: door.y };
  return { x: door.x, y: door.y + (room.y + room.h / 2 < door.y ? -0.5 : 0.5) };
}

/** Waypoints from where a crew member stands to their spot in `to`, or null if there is no way. */
export function planPath(sim, member, to) {
  const route = findRoute(sim, member.room, to, member);
  if (!route) return null;
  const { layout } = sim;
  const path = [];
  for (const step of route) {
    const here = layout.room(step.from);
    if (step.crawlway) {
      // Up to the service hatch, through, and down the other side.
      const crawl = layout.crawlway(step.crawlway);
      const next = crawl.a === step.from ? crawl.b : crawl.a;
      const a = crawl.hatches[step.from];
      const b = crawl.hatches[next];
      path.push({ x: a.x, y: here.y + here.h - STAND });
      path.push({ ...a });
      path.push({ ...b, enter: next, crawl: step.crawlway, length: Math.hypot(b.x - a.x, b.y - a.y) });
      const room = layout.room(next);
      path.push({ x: b.x, y: room.y + room.h - STAND });
      continue;
    }
    const door = layout.door(step.door);
    const next = door.a === step.from ? door.b : door.a;
    const there = layout.room(next);
    if (!door.vertical && door.y === here.y) {
      // A hatch overhead: onto the deck lift below it, then up.
      path.push({ x: door.x, y: here.y + here.h - STAND });
      path.push({ ...besideDoor(layout, door, step.from), door: door.id });
      path.push({ ...besideDoor(layout, door, next), enter: next, through: door.id });
    } else if (!door.vertical) {
      // A hatch underfoot: down through it to the floor below.
      path.push({ ...besideDoor(layout, door, step.from), door: door.id });
      path.push({ ...besideDoor(layout, door, next), enter: next, through: door.id });
      path.push({ x: door.x, y: there.y + there.h - STAND });
    } else {
      path.push({ ...besideDoor(layout, door, step.from), door: door.id });
      path.push({ ...besideDoor(layout, door, next), enter: next, through: door.id });
    }
  }
  path.push(spotIn(layout.room(to), member.index));
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
      if (!findRoute(sim, sim.state.crew[cmd.crew].room, cmd.room, sim.state.crew[cmd.crew])) return 'there is no way through: a door on the way is locked or jammed';
      return null;
    },
    apply(sim, cmd) {
      const member = sim.state.crew[cmd.crew];
      // They may say no (S2.10): a memory can keep them out of a room. Nothing else about them changes.
      const no = refusalOf(sim, member, cmd.room);
      if (no) {
        crewEmit(sim, member, 'crew.refused', { crew: cmd.crew, room: cmd.room, rule: no.rule, memory: no.memory.type, reason: no.reason, tick: sim.state.tick });
        return;
      }
      letGo(sim, member); // a new order: whatever they were carrying is set down here
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

/** Is this crew member riding a lift just now: their next leg goes up or down? */
export function onLift(member) {
  const next = member.path?.[0];
  return Boolean(next && !next.crawl && Math.abs(next.y - member.y) > Math.abs(next.x - member.x));
}

/** How fast a leg of a trip goes, as a share of walking: on foot, on a lift, or through a crawlway. */
function legSpeed(sim, member, next) {
  const dx = Math.abs(next.x - member.x);
  const dy = Math.abs(next.y - member.y);
  if (next.crawl) return next.length / CRAWL_SECONDS / WALK_SPEED; // the same squeeze whatever the wall
  if (dy <= dx) return 1;
  return liftSpeed(sim);
}

function walk(sim, member, seconds) {
  // Time left this tick, spent leg by leg, as each leg has its own pace.
  let time = seconds;
  // Feeling the way through an unlit room is slower (S2.5, D-096).
  const lit = sim.state.rooms[member.room]?.light ?? 1;
  const pace = WALK_SPEED * (member.suit ? SUIT_SPEED : 1) * (member.carry ? CARRY_SPEED : 1) * (lit < DARK_LIGHT ? DARK_WALK : 1);
  member.task = 'walking';
  while (member.path.length) {
    const next = member.path[0];
    if (next.crawl) member.task = 'crawling';
    const left = pace * legSpeed(sim, member, next) * time;
    const distance = Math.hypot(next.x - member.x, next.y - member.y);
    if (distance > left) {
      member.x += ((next.x - member.x) * left) / distance;
      member.y += ((next.y - member.y) * left) / distance;
      return;
    }
    if (left > 0) time -= (time * distance) / left;
    member.x = next.x;
    member.y = next.y;

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
  if (member.job) return; // a crate job (hold.js) comes before the room's own trouble
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
    case 'crawling':
      return 'In a service crawlway';
    case 'walking':
      if (member.board) return 'Heading for the airlock';
      if (onLift(member) && !isPowered(sim, 'doors')) return `Cranking the lift by hand, to ${sim.layout.room(member.goal)?.name ?? 'somewhere'}`;
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
