// The cargo hold: crates you can see, open, move and jettison, and the ammo
// runs that feed the heavy guns (D-076, S2.8). DOM-free.
//
// A crate is a thing in a room: { id, kind, label, contents, rounds, sealed,
// room, by }. `room` is where it sits, or null while someone carries it (`by`).
// Kinds:
//   ammo     an ordnance crate: `rounds` for the slug thrower and the lance
//   cargo    a company manifest crate, sealed until someone opens it
//   salvage  something taken off another ship (a surrender, for now)
// Crates start where the ship file puts them (`crates` in content/ships/).
// Both ships keep theirs the same way, so the enemy captain sends its own
// people for rounds with the same orders the player gives.
//
// Every crate order is a job for one crew member of ours aboard our own ship:
//   crate.open      walk to it and break the seal
//   crate.move      walk to it, lift it, carry it to a room, set it down
//   crate.jettison  carry it to the nearest airlock and cycle it out
//   weapon.load     carry an ordnance crate to the weapons room and load a gun
// A job runs in phases: fetch (walk to the crate), lift, carry, work. Carrying
// is slow and needs both hands, so nobody carries through a service crawlway.
// Any other order to that crew member drops the crate where they stand; so does
// dying, or being sent across to the other ship. A job that cannot go on (the
// way is shut, the crate is gone) ends with `crew.blocked`, and no job runs
// longer than JOB_SECONDS, so nobody is ever stuck on an ammo run.

import { crewEmit } from './atmosphere.js';
import { CARRY_SPEED, findRoute, hostilesBeside, isHome, letGo, planPath } from './crew.js';
import { bang } from './senses.js';
import { SPACE } from './systems.js';

export const CRATE_KINDS = Object.freeze(['ammo', 'cargo', 'salvage']);
/** Seconds to get a crate up off the deck, to break a seal, to load a gun, and to cycle a crate out of an airlock. */
export const LIFT_SECONDS = 1.5;
export const OPEN_SECONDS = 3;
export const LOAD_SECONDS = 3;
export const CYCLE_SECONDS = 3;
export { CARRY_SPEED };
/** No job runs longer than this; it is given up and the crate set down. */
export const JOB_SECONDS = 120;
/** Rounds in a fresh ordnance crate, unless the ship file says otherwise. */
export const CRATE_ROUNDS = 4;
/** How loud an airlock cycling a crate out is. */
const CYCLE_NOISE = 0.6;

const DEFAULT_LABEL = Object.freeze({ ammo: 'Ordnance crate', cargo: 'Manifest crate', salvage: 'Salvage crate' });

// ---------- state ----------

/** Problems with a ship file's `crates` list. */
export function validateCrates(crates, roomIds) {
  if (crates === undefined) return [];
  if (!Array.isArray(crates)) return ['"crates" must be a list'];
  const problems = [];
  crates.forEach((crate, index) => {
    const label = `crate ${index + 1}`;
    if (!crate || typeof crate !== 'object') return problems.push(`${label} must be an object`);
    if (!CRATE_KINDS.includes(crate.kind)) problems.push(`${label}: kind must be one of ${CRATE_KINDS.join(', ')}`);
    if (!roomIds.has(crate.room)) problems.push(`${label}: no room "${crate.room}"`);
    if (crate.count !== undefined && !(Number.isInteger(crate.count) && crate.count >= 1)) problems.push(`${label}: count must be a whole number, at least 1`);
    if (crate.rounds !== undefined && !(Number.isInteger(crate.rounds) && crate.rounds >= 1)) problems.push(`${label}: rounds must be a whole number, at least 1`);
    if (crate.rounds !== undefined && crate.kind !== 'ammo') problems.push(`${label}: only an ammo crate holds rounds`);
    if (crate.label !== undefined && (typeof crate.label !== 'string' || !crate.label.trim())) problems.push(`${label}: label must be some words`);
    if (crate.kind === 'cargo' && (typeof crate.contents !== 'string' || !crate.contents.trim())) problems.push(`${label}: a cargo crate needs "contents", what is found when it is opened`);
  });
  return problems;
}

function makeCrate(id, { kind, room, label, contents, rounds, contract = false, contraband = false }) {
  return {
    id,
    kind,
    label: label ?? DEFAULT_LABEL[kind],
    contents: contents ?? null,
    rounds: kind === 'ammo' ? (rounds ?? CRATE_ROUNDS) : 0,
    sealed: kind === 'cargo', // a company seal: only manifest crates have one
    room,
    by: null, // who is carrying it, while someone is
    contract: Boolean(contract), // part of the run's contract cargo (contracts.js, S3.4)
    contraband: Boolean(contraband), // what an inspection looks for
  };
}

/** The crates a ship starts with, from its layout. */
export function newHoldState(layout) {
  const crates = {};
  let n = 0;
  for (const entry of layout.crates) {
    for (let i = 0; i < (entry.count ?? 1); i++) {
      n += 1;
      const id = `crate-${n}`;
      crates[id] = makeCrate(id, entry);
    }
  }
  return { crates, nextCrate: n + 1 };
}

/** Put a new crate down in a room: salvage from a surrender, say. Returns it. */
export function addCrate(ship, entry) {
  const id = `crate-${ship.state.nextCrate++}`;
  ship.state.crates[id] = makeCrate(id, entry);
  return ship.state.crates[id];
}

// ---------- reading the hold ----------

/** Crates sitting in a room, in the order they were stowed. */
export const cratesIn = (ship, roomId) => Object.values(ship.state.crates).filter((crate) => crate.room === roomId);
/** Ordnance aboard: rounds in crates nobody has loaded yet. */
export const roundsInHold = (ship) => Object.values(ship.state.crates).reduce((sum, crate) => sum + (crate.kind === 'ammo' ? crate.rounds : 0), 0);
/** Does this weapon take rounds? */
export const takesAmmo = (ship, slot) => Boolean(ship.catalog.weapon(ship.state.weapons[slot].id).ammo);
/** How many rounds a weapon's magazine holds, or null if it needs none. */
export const magazineOf = (ship, slot) => ship.catalog.weapon(ship.state.weapons[slot].id).ammo?.magazine ?? null;

/** Rooms with an airlock to space whose door still works. */
function airlocks(ship) {
  return [...new Set(ship.layout.doors.filter((door) => door.airlock && !ship.state.doors[door.id].sealed).map((door) => door.a))].filter((id) => !ship.state.rooms[id].jettisoned);
}

/** Is there a way for someone carrying a crate from `from` to `to`? Carriers never crawl. */
const carryRoute = (ship, from, to) => findRoute(ship, from, to, null);

/** The nearest airlock a crate in `from` can be carried to, or null. */
function nearestAirlock(ship, from) {
  let best = null;
  for (const id of airlocks(ship)) {
    const route = carryRoute(ship, from, id);
    if (route && (!best || route.length < best.length)) best = { id, length: route.length };
  }
  return best?.id ?? null;
}

/** The best ordnance crate for a load: the one already carried by this person, else the nearest with rounds. */
function ammoFor(ship, member) {
  const carried = member.carry ? ship.state.crates[member.carry] : null;
  if (carried?.kind === 'ammo' && carried.rounds > 0) return carried;
  let best = null;
  for (const crate of Object.values(ship.state.crates)) {
    if (crate.kind !== 'ammo' || crate.rounds < 1 || crate.by || crate.room === null) continue;
    if (Object.values(ship.state.crew).some((other) => other !== member && other.job?.crate === crate.id)) continue; // someone is already on their way to it
    const route = findRoute(ship, member.room, crate.room, member);
    if (route && (!best || route.length < best.length)) best = { crate, length: route.length };
  }
  return best?.crate ?? null;
}

/** Where the crate a job is about ends up: the room to carry it to, or null when it is worked where it lies. */
function destination(ship, job) {
  if (job.kind === 'open') return null;
  return job.to;
}

/**
 * Who should take a crate order when the player has not said: our own crew
 * aboard, alive and not in a fight, preferring someone free, then someone not
 * flying the ship, then whoever is closest to `roomId`. Returns an id or null.
 */
export function pickHand(ship, roomId) {
  const helm = ship.layout.rooms.find((room) => room.kind === 'helm')?.id;
  let best = null;
  for (const member of Object.values(ship.state.crew)) {
    if (!member.alive || !isHome(ship, member) || member.board || member.task === 'crossing') continue;
    const route = findRoute(ship, member.room, roomId, member);
    if (!route) continue;
    const key = [member.job ? 1 : 0, member.room === helm && !member.path.length ? 1 : 0, route.length, member.index];
    const before = (a, b) => {
      for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i];
      return false;
    };
    if (!best || before(key, best.key)) best = { id: member.id, key };
  }
  return best?.id ?? null;
}

// ---------- orders ----------

/** The crew member a crate order goes to, or a reason it cannot. */
function hand(ship, cmd) {
  const member = ship.state.crew[cmd.crew];
  if (!member) return `no crew member "${cmd.crew}"`;
  if (!member.alive) return `${member.name} is dead`;
  if (!isHome(ship, member)) return `${member.name} is not aboard`;
  if (member.board || member.task === 'crossing') return `${member.name} is on the way to the other ship`;
  return member;
}

/** The crate an order is about, or a reason. Someone else carrying it is a reason; the same person is not. */
function crateFor(ship, cmd, member) {
  const crate = ship.state.crates[cmd.crate];
  if (!crate) return `no crate "${cmd.crate}"`;
  if (crate.by && crate.by !== member.id) return `${ship.state.crew[crate.by]?.name ?? 'someone'} is carrying that`;
  return crate;
}

/** Can `member` get to the crate, and from there (carrying it) to `to`? */
function reach(ship, member, crate, to) {
  const at = crate.room ?? member.room;
  if (crate.room !== null && !findRoute(ship, member.room, at, member)) return `${member.name} cannot get to it: a door on the way is locked or jammed`;
  if (to && to !== at && !carryRoute(ship, at, to)) return 'there is no way to carry it there';
  return null;
}

function startJob(ship, member, job) {
  letGo(ship, member, { keep: job.crate });
  member.job = { ...job, phase: member.carry === job.crate ? 'carry' : 'fetch', t: 0, since: ship.state.tick };
  // Someone caught mid-stride (in a doorway, on a lift) first steps back to their spot in the room they are in.
  member.goal = member.path.length ? member.room : null;
  member.path = member.path.length ? planPath(ship, member, member.room) ?? [] : [];
  member.task = member.path.length ? 'walking' : 'idle';
  crewEmit(ship, member, 'crew.ordered', { crew: member.id, room: job.to ?? ship.state.crates[job.crate].room ?? member.room, job: job.kind, tick: ship.state.tick });
}

export const HOLD_COMMANDS = {
  // Break a crate's seal and see what is inside.
  'crate.open': {
    check(ship, cmd) {
      const member = hand(ship, cmd);
      if (typeof member === 'string') return member;
      const crate = crateFor(ship, cmd, member);
      if (typeof crate === 'string') return crate;
      if (!crate.sealed) return crate.kind === 'ammo' ? 'it is stencilled: rounds for the heavy guns' : 'it is already open';
      return reach(ship, member, crate, null);
    },
    apply(ship, cmd) {
      startJob(ship, ship.state.crew[cmd.crew], { kind: 'open', crate: cmd.crate, to: null });
    },
  },
  // Carry a crate to another room and set it down.
  'crate.move': {
    check(ship, cmd) {
      const member = hand(ship, cmd);
      if (typeof member === 'string') return member;
      const crate = crateFor(ship, cmd, member);
      if (typeof crate === 'string') return crate;
      const room = ship.state.rooms[cmd.room];
      if (!room) return `no room "${cmd.room}"`;
      if (room.jettisoned) return 'that section is gone';
      if (crate.room === cmd.room) return 'it is already there';
      return reach(ship, member, crate, cmd.room);
    },
    apply(ship, cmd) {
      startJob(ship, ship.state.crew[cmd.crew], { kind: 'move', crate: cmd.crate, to: cmd.room });
    },
  },
  // Carry a crate to the nearest airlock and cycle it out into space.
  'crate.jettison': {
    check(ship, cmd) {
      const member = hand(ship, cmd);
      if (typeof member === 'string') return member;
      const crate = crateFor(ship, cmd, member);
      if (typeof crate === 'string') return crate;
      const from = crate.room ?? member.room;
      if (!nearestAirlock(ship, from)) return 'there is no airlock it can be carried to';
      return reach(ship, member, crate, null);
    },
    apply(ship, cmd) {
      const member = ship.state.crew[cmd.crew];
      const crate = ship.state.crates[cmd.crate];
      startJob(ship, member, { kind: 'jettison', crate: cmd.crate, to: nearestAirlock(ship, crate.room ?? member.room) });
    },
  },
  // Fetch an ordnance crate from wherever it is and load a heavy gun from it. `crate` is optional: the nearest is used.
  'weapon.load': {
    check(ship, cmd) {
      const member = hand(ship, cmd);
      if (typeof member === 'string') return member;
      if (!Number.isInteger(cmd.slot) || !ship.state.weapons[cmd.slot]) return `no weapon in slot ${cmd.slot}`;
      const magazine = magazineOf(ship, cmd.slot);
      if (magazine === null) return 'that gun needs no rounds';
      if (ship.state.weapons[cmd.slot].rounds >= magazine) return 'it is fully loaded';
      const gunRoom = ship.layout.roomOfSystem('weapons');
      if (!gunRoom || ship.state.rooms[gunRoom.id].jettisoned) return 'the weapons room is gone';
      let crate;
      if (cmd.crate !== undefined) {
        crate = crateFor(ship, cmd, member);
        if (typeof crate === 'string') return crate;
        if (crate.kind !== 'ammo') return 'that crate holds no rounds';
        if (crate.rounds < 1) return 'that crate is empty';
      } else {
        crate = ammoFor(ship, member);
        if (!crate) return roundsInHold(ship) > 0 ? `${member.name} cannot get to any rounds` : 'there are no rounds left aboard';
      }
      return reach(ship, member, crate, gunRoom.id);
    },
    apply(ship, cmd) {
      const member = ship.state.crew[cmd.crew];
      const crate = cmd.crate !== undefined ? ship.state.crates[cmd.crate] : ammoFor(ship, member);
      startJob(ship, member, { kind: 'load', crate: crate.id, to: ship.layout.roomOfSystem('weapons').id, slot: cmd.slot });
    },
  },
};

// ---------- each tick ----------

/** Give up a job: the crate is set down where they stand. */
function giveUp(ship, member, reason) {
  letGo(ship, member);
  crewEmit(ship, member, 'crew.blocked', { crew: member.id, room: member.room, reason, tick: ship.state.tick });
}

function done(ship, member) {
  member.job = null;
  member.task = 'idle';
}

/** Walk on to `room`, or give up if there is no way. */
function headFor(ship, member, room) {
  const path = planPath(ship, member, room);
  if (!path) return giveUp(ship, member, 'way');
  member.goal = room;
  member.path = path;
  member.task = 'walking';
}

/** Someone's job, for one tick in which they are standing still. */
function stepJob(ship, member, seconds) {
  const job = member.job;
  const crate = ship.state.crates[job.crate];
  const { tick } = ship.state;
  if (!crate) return giveUp(ship, member, 'gone');
  const rate = (0.5 + 0.5 * member.health) * seconds;

  if (job.phase === 'fetch') {
    if (crate.by && crate.by !== member.id) return giveUp(ship, member, 'taken');
    if (crate.room !== member.room) return headFor(ship, member, crate.room);
    job.phase = job.kind === 'open' ? 'work' : 'lift';
    job.t = 0;
  }
  if (job.phase === 'lift') {
    // Two hands can go for the same crate; whoever lifts it first has it (a bigger crew makes this happen).
    if (crate.by && crate.by !== member.id) return giveUp(ship, member, 'taken');
    member.task = 'lifting';
    job.t += rate;
    if (job.t < LIFT_SECONDS) return;
    Object.assign(crate, { room: null, by: member.id });
    member.carry = crate.id;
    job.phase = 'carry';
    job.t = 0;
  }
  if (job.phase === 'carry') {
    const to = destination(ship, job);
    if (to && member.room !== to) {
      if (ship.state.rooms[to].jettisoned) return giveUp(ship, member, 'gone');
      return headFor(ship, member, to);
    }
    if (job.kind === 'move') {
      letGo(ship, member);
      crewEmit(ship, member, 'crate.moved', { crew: member.id, crate: crate.id, room: member.room, tick });
      return done(ship, member);
    }
    job.phase = 'work';
    job.t = 0;
  }
  // Working with it: breaking the seal, loading the gun, or cycling the airlock.
  member.task = job.kind === 'open' ? 'opening' : job.kind === 'load' ? 'loading' : 'cycling';
  job.t += rate;
  const need = job.kind === 'open' ? OPEN_SECONDS : job.kind === 'load' ? LOAD_SECONDS : CYCLE_SECONDS;
  if (job.t < need) return;
  if (job.kind === 'open') {
    crate.sealed = false;
    crewEmit(ship, member, 'crate.opened', { crew: member.id, crate: crate.id, kind: crate.kind, label: crate.label, contents: crate.contents, room: crate.room, tick });
  } else if (job.kind === 'load') {
    const slot = ship.state.weapons[job.slot];
    const magazine = magazineOf(ship, job.slot);
    const take = Math.min(crate.rounds, magazine - slot.rounds);
    slot.rounds += take;
    crate.rounds -= take;
    member.carry = null;
    if (crate.rounds > 0) Object.assign(crate, { room: member.room, by: null });
    else delete ship.state.crates[crate.id]; // the empty crate is broken down
    ship.events.emit('weapon.loaded', { slot: job.slot, weapon: slot.id, rounds: slot.rounds, crew: member.id, tick });
  } else {
    member.carry = null;
    delete ship.state.crates[crate.id];
    bang(ship, member.room, CYCLE_NOISE);
    crewEmit(ship, member, 'crate.jettisoned', { crew: member.id, crate: crate.id, kind: crate.kind, label: crate.label, room: member.room, tick });
  }
  done(ship, member);
}

/**
 * Every job aboard, for people standing still (walking is crew.js), and the
 * crates of anyone who can no longer hold them. Runs after the crew move.
 */
export function stepHold(ship, seconds) {
  for (const member of Object.values(ship.state.crew)) {
    if (member.carry && (!member.alive || !isHome(ship, member) || member.board)) letGo(ship, member);
    if (!member.alive || !member.job || member.board) continue;
    if (ship.state.tick - member.job.since > JOB_SECONDS * 20) {
      // Too long: whatever is in the way, they give it up and step back to their spot in the room they are in.
      giveUp(ship, member, 'slow');
      if (member.path.length) Object.assign(member, { goal: member.room, path: planPath(ship, member, member.room) ?? [], task: 'walking' });
      continue;
    }
    if (member.path.length) continue; // walking: crew.js moves them
    if (hostilesBeside(ship, member).length) continue; // fighting first (crew.js); the job waits
    stepJob(ship, member, seconds);
  }
  // A room cut loose takes its crates with it.
  for (const crate of Object.values(ship.state.crates)) {
    if (crate.room !== null && ship.state.rooms[crate.room]?.jettisoned) {
      delete ship.state.crates[crate.id];
      ship.events.emit('crate.lost', { crate: crate.id, kind: crate.kind, label: crate.label, room: crate.room, tick: ship.state.tick });
    }
  }
}

/** A line for the UI about someone's job, or null. */
export function describeJob(ship, member) {
  const job = member.job;
  if (!job) return null;
  const crate = ship.state.crates[job.crate];
  const what = crate?.kind === 'ammo' ? 'rounds' : 'a crate';
  const to = job.to ? ship.layout.room(job.to)?.name : null;
  if (member.task === 'lifting') return `Lifting ${what}`;
  if (member.task === 'opening') return 'Breaking a seal';
  if (member.task === 'loading') return `Loading the ${ship.catalog.weapon(ship.state.weapons[job.slot].id).name.toLowerCase()}`;
  if (member.task === 'cycling') return 'Cycling a crate out of the airlock';
  if (job.phase === 'fetch') return job.kind === 'load' ? 'Fetching rounds' : `Going for ${what}`;
  if (job.kind === 'load') return 'Carrying rounds to the guns';
  if (job.kind === 'jettison') return 'Carrying a crate to the airlock';
  return `Carrying ${what}${to ? ` to ${to}` : ''}`;
}

/** Hold problems that should never happen. */
export function checkHoldInvariants(ship) {
  const problems = [];
  const crew = ship.state.crew;
  for (const crate of Object.values(ship.state.crates)) {
    if (!CRATE_KINDS.includes(crate.kind)) problems.push(`${crate.id} is a "${crate.kind}"`);
    if ((crate.room === null) === (crate.by === null)) problems.push(`${crate.id} is ${crate.room === null ? 'nowhere' : `in ${crate.room} and carried`}`);
    if (crate.room !== null && (!ship.layout.room(crate.room) || crate.room === SPACE)) problems.push(`${crate.id} is in unknown room "${crate.room}"`);
    if (crate.by !== null && crew[crate.by]?.carry !== crate.id) problems.push(`${crate.id} is carried by ${crate.by}, who is not holding it`);
    if (!(Number.isInteger(crate.rounds) && crate.rounds >= 0)) problems.push(`${crate.id} holds ${crate.rounds} rounds`);
  }
  for (const member of Object.values(crew)) {
    if (member.carry && ship.state.crates[member.carry]?.by !== member.id) problems.push(`${member.id} holds ${member.carry}, which is not in their hands`);
    if (member.job && !member.alive) problems.push(`${member.id} is dead with a job`);
    if (member.job && ship.state.tick - member.job.since > JOB_SECONDS * 20 + 1) problems.push(`${member.id} has been on a ${member.job.kind} job since tick ${member.job.since}`);
  }
  ship.state.weapons.forEach((slot, index) => {
    const magazine = magazineOf(ship, index);
    if (magazine === null ? slot.rounds !== null : !(Number.isInteger(slot.rounds) && slot.rounds >= 0 && slot.rounds <= magazine)) problems.push(`weapon ${index} holds ${slot.rounds} rounds`);
  });
  return problems;
}
