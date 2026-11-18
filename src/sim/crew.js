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
// `owner` says whose crew someone is ('player' or 'enemy'). Anyone of the
// other side aboard our ship is a boarder (a party off a docked contact,
// boarders.js): they fight whoever of ours shares their room (if their party
// is hostile), and fix nothing. Our crew never cross to another ship: that
// went with the duel in H.3.

import { crewEmit, harmCrew } from './atmosphere.js';
import { chill } from './cold.js';
import { moodOf, refusalOf } from './memory.js';
import { skillFactor, skillOf } from './roles.js';
import { liftRuns } from './power.js';
import { STATIONS, injured, postOfRole, rating, stationOfRoom } from './stations.js';
import { worn } from './watches.js';
import { slipping, stride } from './slips.js';
import { SPACE, SYSTEMS } from './systems.js';

/** Tiles per second on foot. A suit is heavy. */
export const WALK_SPEED = 3;
export const SUIT_SPEED = 0.7;
/**
 * Every way between decks is a lift (D-093): the main shaft, and a deck lift
 * under each hatch. With the lift motor switched on (power.js, H.4) a lift carries crew at this many
 * times walking speed; with it off they crank it by hand, at this share of it.
 */
export const LIFT_SPEED = 2;
export const CRANK_SPEED = 0.3;
/** How fast the lifts run just now: powered, or cranked by hand. */
export const liftSpeed = (sim) => (liftRuns(sim) ? LIFT_SPEED : CRANK_SPEED);
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
/** Health regained per second in a medbay run by the book; a medic on the station is faster (stations.js). */
export const MEDBAY_HEAL = 1 / 40;
/** How open a door must be to walk through. */
export const WALKABLE = 0.9;
/** Hand to hand: one healthy fighter takes a healthy one down alone in this many seconds. Hurt fighters hit softer. */
export const MELEE_SECONDS = 14;
/** A stunner (a bounty party's, H.2) knocks people down to this much health and no further. */
export const STUN_FLOOR = 0.1;
/** A boarder left alone with a system breaks a bar of it every this many seconds. */
export const SABOTAGE_SECONDS = 9;
/** Seconds for an agent (agents.js, H.2) to force a door: a locked one is cut, a jammed one levered. Forced, it hangs open, jammed. */
export const FORCE_SECONDS = Object.freeze({ locked: 10, jammed: 14 });
/** How loud forcing a door is. */
export const FORCE_NOISE = 0.7;
/** Air an agent without a suit will not stand in, and will not walk through if there is any other way. */
export const THIN_AIR = 0.3;
/** What walking through thin air costs an agent without a suit, in seconds, when planning a way. */
const THIN_AIR_COST = 60;

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
export function newCrewMember(layout, { id, name, role = null, engineer = false, skills = {}, traits = [] }, roomId, index = 0, owner = 'player') {
  const { x, y } = spotIn(layout.room(roomId), index);
  return {
    id,
    name: name ?? id,
    index,
    owner, // whose crew: 'player' or 'enemy'. Not always the ship they are aboard
    role, // the job they signed on for (roles.js, D-130): pilot, engineer, gunner, medic, security, quartermaster
    engineer: engineer === true || role === 'engineer', // may use the service crawlways (D-072)
    skills: { ...skills }, // piloting, engineering, weapons, medicine, combat, negotiation, 0 to 5; each level speeds its work (D-131)
    traits: [...traits], // trait ids; none exist until S4.1

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
    task: 'idle', // what they are doing: idle | walking | waiting | extinguish | patch | repair | unjam | fighting | sabotage
    wreck: 0, // 0 to 1 progress toward breaking the next bar of the system they are sabotaging
    carry: null, // the crate in their arms (hold.js)
    job: null, // a crate job under way: { kind, crate, to, slot, phase, t, since } (hold.js)
    hidden: null, // where they are hiding (agents.js, H.2): 'locker' or 'crawlway'; null when in plain sight
    memories: [], // what they remember: { type, tick, room, who, dark } (memory.js)
    dread: 0, // 0 to 1: how the dark is wearing on them (memory.js)
    regard: {}, // what they think of the captain ("captain") and of each crewmate (by id): -10 to 10 (F.6, memory.js)
    lampUntil: 0, // the tick until which they will not sit in the dark again
    post: owner === 'player' ? postOfRole(role) : null, // the station they are posted to (stations.js, H.4), or null for a spare hand
    watch: 0, // which watch they stand (watches.js)
    fatigue: 0, // 0 fresh to 1 dead on their feet (watches.js)
    asleep: false, // below, in their bunk
    hunger: 0, // 0 fed to 1 starving (watches.js, F.7)
    eating: false, // at a meal in the mess
    offIdle: 0, // seconds stood idle off watch away from the quarters (watches.js, D-244)
    starving: false, // has gone past HUNGER.starving and not been fed since
    slip: 0, // ticks left of a slip: a tired or hungry hand's fumble (slips.js, F.7)
    due: null, // where the watch bill wants them once they are free: 'post' | 'bunk'
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

/** Can `who` force this door, if it is shut against them? Agents (a boarding party, H.2) can; our crew cannot. */
export function isForceable(sim, doorId, who) {
  if (!who?.forces) return false;
  const door = sim.layout.door(doorId);
  const d = sim.state.doors[doorId];
  return !door.airlock && !d.sealed && (d.state === 'locked' || d.state === 'jammed');
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
      if (exit.to === SPACE) continue;
      const passable = isPassable(sim, exit.door);
      if (!passable && !isForceable(sim, exit.door, who)) continue;
      const door = layout.door(exit.door);
      const next = layout.room(exit.to);
      const there = floorMid(next);
      const walk = (Math.abs(door.x - at.x) + Math.abs(there.x - door.x)) / WALK_SPEED;
      // Up or down a deck lift, or along the main shaft.
      const ride = !door.vertical || room.kind === 'lift' || next.kind === 'lift' ? Math.abs(there.y - at.y) / (WALK_SPEED * rise) : 0;
      // An agent counts the time to force a shut door, and walks round air it cannot breathe if it can.
      const force = passable ? 0 : FORCE_SECONDS[sim.state.doors[exit.door].state] ?? 0;
      const air = who?.forces && !who.suit && sim.state.rooms[exit.to].oxygen < THIN_AIR ? THIN_AIR_COST : 0;
      edges.push({ to: exit.to, cost: walk + ride + force + air, step: { door: exit.door, from: here } });
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

/**
 * Walk someone to a room without an order from the captain: the watch bill or a posting (watches.js, stations.js).
 * They will not go where they would refuse to (memory.js) or where there is no way. Returns whether they set off.
 */
export function sendTo(sim, member, roomId, why = 'watch') {
  if (!member.alive || member.room === roomId) return false;
  if (!findRoute(sim, member.room, roomId, member) || refusalOf(sim, member, roomId)) return false;
  letGo(sim, member);
  member.asleep = false;
  member.goal = roomId;
  member.path = planPath(sim, member, roomId);
  member.task = 'walking';
  crewEmit(sim, member, 'crew.sent', { crew: member.id, room: roomId, why, tick: sim.state.tick });
  return true;
}

export const CREW_COMMANDS = {
  // Send someone to a room. They work out the doors themselves.
  'crew.move': {
    check(sim, cmd) {
      const problem = living(sim, cmd.crew);
      if (problem) return problem;
      if (cmd.ship !== undefined && cmd.ship !== 'us') return 'there is no other ship to send them to'; // boarding by clamp only, and only theirs onto ours (H.3)
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
        crewEmit(sim, member, 'crew.refused', { crew: cmd.crew, room: cmd.room, rule: no.rule, memory: no.memory?.type ?? null, reason: no.reason, tick: sim.state.tick });
        return;
      }
      letGo(sim, member); // a new order: whatever they were carrying is set down here
      member.asleep = false; // an order wakes a sleeper, and stands until the next change of the watch (watches.js)
      member.due = null;
      member.goal = cmd.room;
      member.path = planPath(sim, member, cmd.room);
      member.task = 'walking';
      // How they take it (F.6): shortly or gladly, and what they remember that makes it so. For the intercom.
      crewEmit(sim, member, 'crew.ordered', { crew: cmd.crew, room: cmd.room, ...moodOf(sim, member), tick: sim.state.tick });
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
      if (cmd.health !== undefined && !(cmd.health > 0 && cmd.health <= 1)) return 'health must be above 0 and at most 1';
      if (cmd.fatigue !== undefined && !(cmd.fatigue >= 0 && cmd.fatigue <= 1)) return 'fatigue must be between 0 and 1';
      if (cmd.hunger !== undefined && !(cmd.hunger >= 0 && cmd.hunger <= 1)) return 'hunger must be between 0 and 1';
      return cmd.health === undefined && cmd.fatigue === undefined && cmd.hunger === undefined ? 'needs health, fatigue or hunger' : null;
    },
    apply(sim, cmd) {
      if (cmd.health !== undefined) sim.state.crew[cmd.crew].health = cmd.health;
      if (cmd.fatigue !== undefined) sim.state.crew[cmd.crew].fatigue = cmd.fatigue;
      if (cmd.hunger !== undefined) sim.state.crew[cmd.crew].hunger = cmd.hunger;
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
  const pace = WALK_SPEED * (member.suit ? SUIT_SPEED : 1) * (member.carry ? CARRY_SPEED : 1) * (lit < DARK_LIGHT ? DARK_WALK : 1) * chill(sim, member) * stride(member);
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
      if (!isPassable(sim, next.door) && isForceable(sim, next.door, member)) {
        // An agent cuts a locked door and levers a jammed one; it hangs open, jammed, after.
        member.task = 'forcing';
        member.forcing = (member.forcing ?? 0) + ((0.5 + 0.5 * member.health) * time) / FORCE_SECONDS[d.state];
        const here = sim.state.rooms[member.room];
        here.noise = Math.max(here.noise, FORCE_NOISE); // a bang (senses.js) that rings as long as the cutting goes on
        if (member.forcing < 1) return;
        member.forcing = 0;
        d.openness = 1;
        setDoor(sim, next.door, 'jammed', member.id);
        sim.events.emit('door.forced', { door: next.door, by: member.id, tick: sim.state.tick });
        continue;
      }
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
    // Aboard their ship, there is nothing to save and a system to break. A boarding party (H.2) breaks only what it came to strip.
    if (member.party && member.agent?.strip !== room.system) return null;
    const system = room.system ? sim.state.systems[room.system] : null;
    return system && !system.lost && system.damage < system.level ? { type: 'sabotage', system: room.system } : null;
  }
  if (r.fire > 0) return { type: 'extinguish' };
  if (r.breach > 0) return { type: 'patch' };
  if (room.system) {
    const system = sim.state.systems[room.system];
    if (system.damage > 0 && !system.lost && !system.stripped) return { type: 'repair', system: room.system };
  }
  for (const exit of sim.layout.exits(member.room)) {
    const d = sim.state.doors[exit.door];
    if (d.state === 'jammed' && !d.sealed) return { type: 'unjam', door: exit.door };
  }
  return null;
}

/**
 * The other side's people in this crew member's room, still on their feet and not in the docking tube.
 * Nobody hiding fights or is fought (H.2), and a boarding party that has come peacefully (an inspection,
 * a salvage crew who think her dead) is not fought until it turns hostile.
 */
export function hostilesBeside(sim, member) {
  // Hidden, or beaten down by a stunner (H.2) and not yet back on their feet: out of the fight.
  if (member.hidden || (member.stunned && member.health <= STUN_FLOOR + 0.05)) return [];
  const calm = sim.state.boarding && !sim.state.boarding.hostile;
  return Object.values(sim.state.crew).filter((other) => other.alive && other.room === member.room && other.owner !== member.owner && !other.hidden && !(calm && (other.party || member.party)));
}

/** Hit someone; false if there is nobody here this one would hit (a bounty party and the one it came for). */
function fight(sim, member, foes, seconds) {
  // Everyone goes for whoever is closest to dropping. Stage 4 skills and traits change who wins (brief §7).
  // Security hit harder (D-131). A party that came for one of us (H.2) wants them alive.
  // A bounty party (stun) beats people down but kills nobody: it is paid for one of them alive.
  const spare = member.agent?.spare;
  const stun = member.agent?.stun;
  const struck = foes.filter((other) => other.id !== spare && !(stun && other.health <= STUN_FLOOR + 1e-9));
  if (!struck.length) return false;
  member.task = 'fighting';
  const target = struck.reduce((weakest, other) => (other.health < weakest.health ? other : weakest));
  // A boarder hits harder for what they carry (`party.arms`, H.8): sidearms, batons and stunners against our fists and spanners.
  const blow = ((0.5 + 0.5 * member.health) * skillFactor(skillOf(member, 'combat')) * (member.agent?.arms ?? 1) * seconds) / MELEE_SECONDS;
  harmCrew(sim, target.id, stun ? Math.min(blow, target.health - STUN_FLOOR) : blow, 'melee');
  if (stun && target.health <= STUN_FLOOR + 1e-9) target.stunned = true;
  return true;
}

function work(sim, member, seconds) {
  const foes = hostilesBeside(sim, member);
  if (foes.length && fight(sim, member, foes, seconds)) return;
  if (member.job) return; // a crate job (hold.js) comes before the room's own trouble
  const job = jobIn(sim, member);
  member.task = job ? job.type : 'idle';
  const r = sim.state.rooms[member.room];

  if (!job) {
    // Nothing to fix: a running medbay patches up its own crew instead, at its station's rating:
    // a medic on the station heals everyone in it faster, themselves included (D-131, H.4).
    if (isHome(sim, member) && sim.layout.room(member.room).system === 'medbay' && member.health < 1) {
      const pace = rating(sim, 'medbay');
      if (pace > 0) member.health = Math.min(1, member.health + MEDBAY_HEAL * (sim.state.systems.medbay.level - sim.state.systems.medbay.damage) * pace * seconds);
    }
    return;
  }

  // A tired or hungry hand who has fumbled it gets nothing done until they have it back (slips.js, F.7).
  if (slipping(member)) return;
  // Hurt people work slower, and so does anyone in a suit, in the dark, dead on their feet or hungry (watches.js) or cold (cold.js, F.2).
  let rate = (0.5 + 0.5 * member.health) * (member.suit ? SUIT_WORK : 1) * worn(member) * chill(sim, member) * seconds;
  if (job.type !== 'extinguish' && r.light < 0.5) rate *= DARK_WORK;
  // Engineers mend, patch and free doors faster (D-131). Anyone can put out a fire.
  if (job.type === 'repair' || job.type === 'patch' || job.type === 'unjam') rate *= skillFactor(skillOf(member, 'engineering'));

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
    // Anyone sent somewhere, or given a job, comes out of hiding to do it (H.2).
    if (member.hidden && (member.path.length || member.job || member.carry)) unhide(sim, member);
    if (member.hidden) {
      member.task = 'hiding';
      continue;
    }
    if (member.path.length) walk(sim, member, seconds);
    else work(sim, member, seconds);
    // Someone left standing in a doorway or on a deck lift when their way was cut short steps back into the room.
    if (member.alive && !member.path.length && !inside(sim.layout.room(member.room), member)) member.path = [spotIn(sim.layout.room(member.room), member.index)];
  }
}

/** Out of hiding: by an order, or found. */
export function unhide(sim, member, by = null) {
  if (!member.hidden) return;
  const spot = member.hidden;
  member.hidden = null;
  if (member.task === 'hiding') member.task = 'idle';
  crewEmit(sim, member, by ? 'crew.found' : 'crew.unhid', { crew: member.id, room: member.room, spot, by, tick: sim.state.tick });
}

const inside = (room, member) => member.x >= room.x && member.x <= room.x + room.w && member.y >= room.y && member.y <= room.y + room.h;

/** A line for the UI about what someone is doing. */
export function describeTask(sim, member) {
  if (!member.alive) return 'Dead';
  const room = sim.layout.room(member.room);
  switch (member.task) {
    case 'crawling':
      return 'In a service crawlway';
    case 'walking':
      if (onLift(member) && !liftRuns(sim)) return `Cranking the lift by hand, to ${sim.layout.room(member.goal)?.name ?? 'somewhere'}`;
      return `Walking to ${sim.layout.room(member.goal)?.name ?? 'somewhere'}`;
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
    case 'hiding':
      return member.hidden === 'crawlway' ? 'Hiding in a service crawlway' : 'Hiding in a locker';
    case 'forcing':
      return 'Forcing a door';
    case 'grabbing':
      return 'Dragging someone off';
    case 'searching':
      return 'Searching the room';
    default:
      if (member.asleep) return 'Asleep';
      if (member.eating) return 'Eating in the mess';
      if (member.slip > 0) return member.post && stationOfRoom(sim, member.room) === member.post ? `Fumbled the ${STATIONS[member.post].name.toLowerCase()}` : 'Fumbled it';
      if (isHome(sim, member) && room.system === 'medbay' && member.health < 1 && rating(sim, 'medbay') > 0) return 'Being patched up';
      if (member.post && injured(member)) return 'Too badly hurt to stand a station';
      return member.post && stationOfRoom(sim, member.room) === member.post ? `On station: ${STATIONS[member.post].name.toLowerCase()}` : 'Standing by';
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
  }
  for (const id of Object.keys(sim.state.systems)) {
    const repair = sim.state.systems[id].repair ?? 0;
    if (!(repair >= 0 && repair < 1)) problems.push(`${id}.repair is ${repair}`);
  }
  return problems;
}
