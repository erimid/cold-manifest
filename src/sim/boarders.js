// Boarded (Stage H, H.2; D-165 to D-171). DOM-free.
//
// A contact that docks (encounters.js) puts a clamp on one of our airlocks
// and, unless it is paid off at the lock, sends a party aboard with a goal:
//   inspect  go over the holds and a few rooms for contraband; seize what is found, write a fine
//   cargo    find crates and carry them back through the airlock
//   crew     find one named member of our crew and drag them off
//   salvage  strip one system for parts (they think she is a dead ship)
// Party members are agents (agents.js) on our decks: crew-shaped people with
// owner 'enemy' who walk the rooms and lifts (never the crawlways), open and
// force doors, go over rooms, react to light and noise, and fight hand to
// hand when the party is hostile (crew.js does the walking and the fighting).
//
// Our answers, besides the ones the ship already has (lock and jam doors,
// lights, the doors' power, fighting in our own halls):
//   crew.hide        into a locker, or an engineer into a crawlway
//   crate.stash      a crate under the deck plates of a compartment (hold.js)
//   room.vent        open a room's emergency vent: no air for anyone without a suit
//   deck.lights      a whole deck's lamps at once (sim.js)
//   boarding.bribe   pay at the airlock, before anyone comes through
//   boarding.yield   hand over what they came for (cargo or a crew member)
//   boarding.admit   open the lock now, rather than make them wait
//   boarding.fight   turn on a party that came peacefully
//
// One boarding at a time (state.boarding). It runs demand -> aboard ->
// leaving, and it always ends: a party gives up after its `stay`, a party
// that is half down or out of air leaves, and anyone not off the ship
// LEAVE_SECONDS after the party starts to go is cut loose with the clamp.
// Every way it ends is one of three outcomes, with a reason:
//   foiled   they left with nothing
//   bought   paid off at the airlock
//   lost     they got what they came for

import { crewEmit, killCrew } from './atmosphere.js';
import { airlockRooms } from './boarding.js';
import { changeReputation, checkCargo, addMoney, contractOf } from './contracts.js';
import { CARRY_SPEED, findRoute, isHome, letGo, newCrewMember, planPath, unhide } from './crew.js';
import { THIN_AIR, findChance, hidingSpot, isDark, oursIn, pickRoom, roomPull, searchSeconds, whyNoHide } from './agents.js';
import { LIFT_SECONDS } from './hold.js';
import { bestSkillAboard } from './roles.js';
import { running } from './stations.js';
import { SYSTEMS } from './systems.js';

/** What a party can come for. */
export const GOALS = Object.freeze({ inspect: 'Inspection', cargo: 'Raid on the hold', crew: 'Bounty', salvage: 'Salvage' });
/** How a boarding can end. */
export const OUTCOMES = Object.freeze({ foiled: 'Foiled', bought: 'Bought off', lost: 'Lost' });
/** Why it ended, as the report and the debug panel say it. */
export const REASONS = Object.freeze({
  bribed: 'Paid off at the airlock',
  yielded: 'Handed over what they came for',
  clean: 'Searched and found nothing',
  seized: 'Found contraband',
  took: 'Took cargo',
  taken: 'Took one of the crew',
  stripped: 'Stripped a system',
  driven: 'Driven off',
  gaveup: 'Gave up looking',
  empty: 'Nothing left to take',
});

/**
 * The numbers. `demand` seconds at the lock before they come through anyway; `morale`: a boarder this hurt
 * goes back; `grab` seconds to drag someone off, one on one; `leave` seconds from the order to go to the
 * clamp coming off whoever is still aboard; `perSkill` added to a bribe for each point of negotiation above
 * the first.
 */
export const BOARD = Object.freeze({ demand: 20, morale: 0.35, grab: 6, leave: 90, perSkill: 0.06, record: 40 });

const TICKS = 20;
const clamp01 = (value) => Math.max(0, Math.min(1, value));
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// ---------- content ----------

/**
 * Problems with an encounter's `party` (content/encounters/), as readable strings. `wants` is the
 * encounter's goal.
 */
export function validateParty(party, wants) {
  const problems = [];
  if (!isObject(party)) return ['party must be an object: who comes aboard and how'];
  const allowed = ['size', 'names', 'skills', 'arms', 'suits', 'demand', 'bribe', 'stay', 'thorough', 'rooms', 'take', 'fine', 'faction', 'strip', 'hostile'];
  for (const key of Object.keys(party)) if (!allowed.includes(key)) problems.push(`party: unknown key "${key}"`);
  if (!(Number.isInteger(party.size) && party.size >= 1 && party.size <= 6)) problems.push('party.size must be a whole number, 1 to 6');
  if (party.names !== undefined && !(Array.isArray(party.names) && party.names.every((n) => typeof n === 'string' && n.trim()))) problems.push('party.names must be a list of names');
  if (party.skills !== undefined && !(isObject(party.skills) && Object.values(party.skills).every((v) => Number.isInteger(v) && v >= 0 && v <= 5))) problems.push('party.skills must be { skill: 0 to 5 }');
  if (party.arms !== undefined && !(typeof party.arms === 'number' && party.arms >= 0.5 && party.arms <= 4)) problems.push('party.arms must be a number, 0.5 to 4: how much harder than one of ours they hit, for what they carry (H.8)');
  for (const key of ['suits', 'hostile']) if (party[key] !== undefined && typeof party[key] !== 'boolean') problems.push(`party.${key} must be true or false`);
  if (typeof party.demand !== 'string' || !party.demand.trim()) problems.push('party.demand must be what they say at the lock');
  if (party.bribe !== undefined && !(isObject(party.bribe) && Number.isInteger(party.bribe.cost) && party.bribe.cost > 0 && party.bribe.chance >= 0 && party.bribe.chance <= 1)) problems.push('party.bribe must be { cost, chance }: credits, and the chance they take it and go');
  if (!(typeof party.stay === 'number' && party.stay > 0)) problems.push('party.stay must be the seconds they will look before they give up');
  if (party.thorough !== undefined && !(typeof party.thorough === 'number' && party.thorough > 0)) problems.push('party.thorough must be a number above 0');
  if (wants === 'inspect') {
    if (!(Number.isInteger(party.rooms) && party.rooms >= 1)) problems.push('party.rooms must be how many rooms an inspection goes over');
    if (party.fine !== undefined && !(Number.isInteger(party.fine) && party.fine >= 0)) problems.push('party.fine must be credits, 0 or more');
  }
  if (wants === 'cargo' && !(Number.isInteger(party.take) && party.take >= 1)) problems.push('party.take must be how many crates a raid means to carry off');
  if (wants === 'salvage' && party.strip !== undefined && !(Array.isArray(party.strip) && party.strip.length && party.strip.every((id) => SYSTEMS[id]))) problems.push('party.strip must be a list of systems, the ones they want first');
  if (party.faction !== undefined && (typeof party.faction !== 'string' || !party.faction.trim())) problems.push('party.faction must name a faction');
  return problems;
}

// ---------- state ----------

/** The boarding in progress, or null. */
export const boardingOf = (sim) => sim.state.boarding ?? null;
/** The party's people still aboard (alive or not). */
export const partyOf = (sim) => {
  const boarding = boardingOf(sim);
  return boarding ? boarding.party.map((id) => sim.state.crew[id]).filter(Boolean) : [];
};
const defOf = (sim) => sim.encounters.byId.get(sim.state.boarding.encounter);

/** The best negotiator of ours aboard: their skill, 0 if nobody has any. */
export const ourTalker = (sim) => bestSkillAboard(Object.values(sim.state.crew).filter((member) => member.alive && isHome(sim, member)), 'negotiation');

/** The chance a bribe at the lock works, with the crew's negotiation. */
export function bribeChance(sim) {
  const party = defOf(sim).party;
  return clamp01((party.bribe?.chance ?? 0) + BOARD.perSkill * Math.max(0, ourTalker(sim) - 1));
}

/** Fill a party's words: {crew_name} is the person a bounty is for, {system} what a salvage crew wants. */
function words(sim, text) {
  const boarding = boardingOf(sim);
  const target = boarding.target ? sim.state.crew[boarding.target]?.name ?? 'one of your crew' : 'one of your crew';
  return text.replaceAll('{crew_name}', target).replaceAll('{system}', boarding.strip ? SYSTEMS[boarding.strip].name.toLowerCase() : 'your fittings');
}

/**
 * Clamp on: a party is at our airlock with `def`'s goal. Returns the boarding, or null if one is already on
 * or there is no airlock to dock at. `contact` is the scope contact it came from, if any; `size` is how many
 * of the party got here, when some of their pods were shot down (H.3).
 */
export function startBoarding(sim, def, { contact = null, at = null, size = null } = {}) {
  if (sim.state.boarding || !def?.party) return null;
  const locks = airlockRooms(sim);
  if (!locks.length) return null;
  const rng = sim.rng.stream('boarding');
  const ours = Object.values(sim.state.crew).filter((member) => member.alive && isHome(sim, member)).sort((a, b) => a.index - b.index);
  const party = def.party;
  const boarding = {
    id: (sim.state.boardings?.next ?? 1),
    encounter: def.id,
    name: def.name,
    wants: def.wants,
    contact,
    size: Math.max(1, Math.min(def.party.size, size ?? def.party.size)), // how many come through the lock
    phase: 'demand',
    dock: at && locks.includes(at) ? at : rng.pick(locks),
    since: sim.state.tick,
    demandEnds: sim.state.tick + Math.round(BOARD.demand * TICKS),
    deadline: null, // set when they come aboard
    leaveEnds: null, // set when they start to go
    hostile: party.hostile ?? (def.wants === 'cargo' || def.wants === 'crew'),
    party: [], // ids of the people aboard, once they are
    target: def.wants === 'crew' && ours.length ? rng.pick(ours).id : null,
    strip: null,
    searched: {}, // room id -> true, once gone over
    seized: 0, // contraband taken by an inspection
    took: 0, // crates carried off, or 1 for a crew member taken, or a system stripped
    tried: false, // a bribe was offered
    reason: null, // why they are leaving
  };
  if (def.wants === 'salvage') {
    const wanted = (party.strip ?? ['sensors', 'shields', 'medbay', 'weapons', 'life_support', 'engines']).filter((id) => sim.layout.roomOfSystem(id) && !sim.state.rooms[sim.layout.roomOfSystem(id).id].jettisoned && !sim.state.systems[id].absent && !sim.state.systems[id].lost);
    boarding.strip = wanted[0] ?? null;
  }
  sim.state.boarding = boarding;
  sim.state.boardings = { next: boarding.id + 1, record: sim.state.boardings?.record ?? [] };
  sim.events.emit('boarding.demand', { boarding: boarding.id, encounter: def.id, name: def.name, wants: def.wants, room: boarding.dock, text: words(sim, party.demand), target: boarding.target, strip: boarding.strip, bribe: party.bribe?.cost ?? null, tick: sim.state.tick });
  return boarding;
}

/** Through the lock: the party steps into our airlock and starts on its goal. */
function comeAboard(sim) {
  const boarding = boardingOf(sim);
  const def = defOf(sim);
  const { party } = def;
  boarding.phase = 'aboard';
  boarding.deadline = sim.state.tick + Math.round(party.stay * TICKS);
  for (let n = 0; n < boarding.size; n++) {
    const id = `b${boarding.id}-${n + 1}`;
    const name = party.names?.[n] ?? `${def.name} crew ${n + 1}`;
    const member = newCrewMember(sim.layout, { id, name, skills: party.skills ?? {} }, boarding.dock, 10 + n, 'enemy');
    Object.assign(member, {
      suit: party.suits === true,
      party: boarding.id,
      forces: true, // they cut what is locked against them (crew.js)
      agent: { aim: null, search: null, grab: 0, strip: null, spare: boarding.target, stun: def.wants === 'crew', arms: party.arms ?? 1, flee: false, lift: 0, lifting: null },
    });
    sim.state.crew[id] = member;
    boarding.party.push(id);
  }
  sim.events.emit('boarding.aboard', { boarding: boarding.id, encounter: def.id, name: def.name, wants: def.wants, room: boarding.dock, size: boarding.size, tick: sim.state.tick });
  // The S2.4 news, so the auto-pause and Margo hear it the way they always have.
  sim.events.emit('enemy.crew.boarded', { crew: boarding.party[0], onto: 'player', room: boarding.dock, tick: sim.state.tick });
}

/** The party is going: everyone heads back to the clamp. `reason` is why (REASONS). */
function leave(sim, reason) {
  const boarding = boardingOf(sim);
  if (boarding.phase === 'leaving') return;
  boarding.phase = 'leaving';
  boarding.reason ??= reason;
  boarding.leaveEnds = sim.state.tick + Math.round(BOARD.leave * TICKS);
  for (const member of partyOf(sim)) if (member.agent) Object.assign(member.agent, { aim: null, search: null, grab: 0, strip: null });
  sim.events.emit('boarding.leaving', { boarding: boarding.id, encounter: boarding.encounter, name: boarding.name, reason: boarding.reason, tick: sim.state.tick });
}

/** The last of them is gone (or cut loose): settle it. */
function finish(sim, reason = null) {
  const boarding = boardingOf(sim);
  const def = defOf(sim);
  if (reason) boarding.reason = reason;
  // Whoever is left aboard goes with the clamp; whatever they were carrying goes with them.
  for (const member of partyOf(sim)) {
    if (member.carry) takeCrate(sim, member);
    delete sim.state.crew[member.id];
  }
  if (boarding.wants === 'inspect' && boarding.seized > 0) {
    addMoney(sim, -Math.min(sim.state.money, def.party.fine ?? 0), 'fine');
    if (def.party.faction) changeReputation(sim, def.party.faction, -2, 'inspection');
  }
  const why = boarding.reason ?? 'gaveup';
  const outcome = why === 'bribed' ? 'bought' : why === 'yielded' || boarding.took > 0 || boarding.seized > 0 ? 'lost' : 'foiled';
  const seconds = (sim.state.tick - boarding.since) / TICKS;
  const entry = { encounter: boarding.encounter, wants: boarding.wants, outcome, reason: why, seconds, took: boarding.took, seized: boarding.seized, tick: sim.state.tick };
  const { record } = sim.state.boardings;
  record.push(entry);
  if (record.length > BOARD.record) record.shift();
  sim.state.boarding = null;
  sim.events.emit('boarding.ended', { boarding: boarding.id, name: boarding.name, ...entry });
}

// ---------- what the party does ----------

/** A crate a raider has carried to the lock goes over to their ship. */
function takeCrate(sim, member) {
  const crate = sim.state.crates[member.carry];
  member.carry = null;
  if (!crate) return;
  delete sim.state.crates[crate.id];
  boardingOf(sim).took += 1;
  sim.events.emit('crate.taken', { crate: crate.id, kind: crate.kind, label: crate.label, by: member.id, room: member.room, tick: sim.state.tick });
  if (contractOf(sim) && crate.contract) checkCargo(sim, 'seized');
}

/** Contraband found by an inspection is tagged and taken on the spot. */
function seize(sim, crate, by) {
  if (crate.by && sim.state.crew[crate.by]) sim.state.crew[crate.by].carry = null;
  delete sim.state.crates[crate.id];
  const boarding = boardingOf(sim);
  boarding.seized += 1;
  const contract = contractOf(sim);
  if (contract && crate.contract) contract.seized += 1;
  sim.events.emit('cargo.seized', { count: 1, crate: crate.id, label: crate.label, by, tick: sim.state.tick });
  if (contract) checkCargo(sim, 'seized');
}

/** Crates a raid would take from a room: in the open, not in anyone's arms. */
const loot = (sim, roomId) => Object.values(sim.state.crates).filter((crate) => crate.room === roomId && !crate.hidden && crate.kind !== 'ammo');

/** Rooms worth going over for this goal, with how much each draws them before what they can sense. */
function biasOf(sim, roomId) {
  const boarding = boardingOf(sim);
  const room = sim.layout.room(roomId);
  const holds = room.kind === 'hold' || room.system === 'cargo';
  if (boarding.wants === 'inspect' || boarding.wants === 'cargo') return holds ? 4 : room.kind === 'corridor' ? 0.2 : 1;
  if (boarding.wants === 'crew') return room.system === 'quarters' ? 1.6 : room.kind === 'corridor' ? 0.5 : 1;
  return 1;
}

/** One search of a room is done: what it turns up. */
function searched(sim, member, roomId) {
  const boarding = boardingOf(sim);
  const def = defOf(sim);
  const rng = sim.rng.stream('boarding');
  const thorough = def.party.thorough ?? 1;
  boarding.searched[roomId] = true;
  sim.events.emit('boarding.searched', { boarding: boarding.id, room: roomId, by: member.id, tick: sim.state.tick });
  for (const crate of Object.values(sim.state.crates)) {
    if (crate.room !== roomId || !crate.hidden) continue;
    if (!rng.chance(findChance(sim, roomId, 'compartment', thorough))) continue;
    crate.hidden = false;
    sim.events.emit('crate.found', { crate: crate.id, label: crate.label, room: roomId, by: member.id, tick: sim.state.tick });
  }
  if (boarding.wants === 'inspect') {
    for (const crate of Object.values(sim.state.crates)) if (crate.room === roomId && !crate.hidden && crate.contraband) seize(sim, crate, member.id);
    return;
  }
  // A hostile party (or a salvage crew, who want no witnesses) drags out anyone it finds hiding.
  for (const hider of oursIn(sim, roomId)) {
    if (!hider.hidden) continue;
    if (rng.chance(findChance(sim, roomId, hider.hidden, thorough))) unhide(sim, hider, member.id);
  }
}

/** Our people in plain sight in a room: what a party can see. */
const inSight = (sim, roomId) => oursIn(sim, roomId).filter((member) => !member.hidden);

function goTo(sim, member, roomId) {
  const path = planPath(sim, member, roomId);
  if (!path) return false;
  Object.assign(member, { goal: roomId, path, task: 'walking' });
  member.agent.aim = roomId;
  return true;
}

/** Where to look next: the room with the most pull that nobody of the party is already on its way to. */
function nextRoom(sim, member) {
  const boarding = boardingOf(sim);
  const aims = new Set(partyOf(sim).filter((other) => other !== member && other.alive).map((other) => other.agent?.aim ?? other.room));
  // A raid goes back for crates it has seen lying about, searched or not.
  const worth = (id) => !boarding.searched[id] || (boarding.wants === 'cargo' && loot(sim, id).length > 0);
  const rooms = sim.layout.rooms.filter((room) => room.kind !== 'lift' && !sim.state.rooms[room.id].jettisoned && worth(room.id) && !aims.has(room.id)).map((room) => room.id);
  return pickRoom(sim, member, rooms, (id) => roomPull(sim, id, biasOf(sim, id)), sim.rng.stream('boarding'));
}

/** Start going over the room they stand in. */
function startSearch(sim, member) {
  member.agent.search = { room: member.room, t: 0, need: searchSeconds(sim, member.room) / (defOf(sim).party.thorough ?? 1) };
  member.task = 'searching';
}

/** One boarder, standing still this tick, aboard and on the job. */
function stepAgent(sim, member, dt) {
  const boarding = boardingOf(sim);
  const { agent } = member;
  const r = sim.state.rooms[member.room];
  // Fighting comes first (crew.js has them at it already).
  if (member.task === 'fighting') return;
  // Out of air with no suit, or too hurt to go on: back to the clamp, and they do not come out again.
  if (!agent.flee && ((!member.suit && r.oxygen < THIN_AIR) || member.health < BOARD.morale)) {
    agent.flee = true;
    crewEmit(sim, member, 'crew.fled', { crew: member.id, room: member.room, why: member.health < BOARD.morale ? 'hurt' : 'air', tick: sim.state.tick });
  }
  if (agent.flee) return void (member.room !== boarding.dock && !member.path.length && goTo(sim, member, boarding.dock));

  // Seen: a salvage crew who find the ship is not dead after all want no witnesses.
  if (!boarding.hostile && boarding.wants === 'salvage' && inSight(sim, member.room).length) {
    boarding.hostile = true;
    sim.events.emit('boarding.hostile', { boarding: boarding.id, name: boarding.name, room: member.room, why: 'seen', tick: sim.state.tick });
  }

  if (boarding.wants === 'crew') {
    const target = sim.state.crew[boarding.target];
    if (target?.alive && target.room === member.room && !target.hidden) {
      // Hold on to them; anyone of ours fighting in the room slows it down.
      member.task = 'grabbing';
      const holders = partyOf(sim).filter((other) => other.alive && other.room === member.room && !other.agent.flee).length;
      const fighters = inSight(sim, member.room).filter((other) => other.id !== target.id).length;
      agent.grab += (dt * holders) / (1 + fighters) / BOARD.grab / Math.max(1, holders);
      if (agent.grab >= 1) {
        delete sim.state.crew[target.id];
        Object.assign(target, { goal: null, path: [], task: 'taken' });
        letGo(sim, target);
        boarding.took = 1;
        sim.events.emit('crew.taken', { crew: target.id, name: target.name, room: member.room, by: member.id, tick: sim.state.tick });
        leave(sim, 'taken');
      }
      return;
    }
    agent.grab = 0;
  }

  if (boarding.wants === 'cargo') {
    if (member.carry) return void (member.room === boarding.dock ? takeCrate(sim, member) : goTo(sim, member, boarding.dock));
    const crate = loot(sim, member.room).find((item) => !partyOf(sim).some((other) => other.agent?.lifting === item.id && other !== member));
    if (crate) {
      member.task = 'lifting';
      agent.lifting = crate.id;
      agent.lift += dt * (0.5 + 0.5 * member.health);
      if (agent.lift < LIFT_SECONDS) return;
      Object.assign(crate, { room: null, by: member.id });
      member.carry = crate.id;
      agent.lift = 0;
      agent.lifting = null;
      return void goTo(sim, member, boarding.dock);
    }
  }

  if (boarding.wants === 'salvage' && boarding.strip) {
    const room = sim.layout.roomOfSystem(boarding.strip);
    const system = sim.state.systems[boarding.strip];
    if (room.id !== member.room) return void (goTo(sim, member, room.id) || (agent.aim = null));
    agent.strip = boarding.strip; // crew.js has them break it bar by bar
    if (system.damage >= system.level) {
      system.stripped = true;
      boarding.took = 1;
      sim.events.emit('system.stripped', { system: boarding.strip, by: member.id, tick: sim.state.tick });
      leave(sim, 'stripped');
    }
    return;
  }

  // Going over a room.
  if (agent.search) {
    if (agent.search.room !== member.room) agent.search = null;
    else {
      member.task = 'searching';
      agent.search.t += dt * (0.5 + 0.5 * member.health);
      if (agent.search.t < agent.search.need) return;
      agent.search = null;
      searched(sim, member, member.room);
    }
  }
  if (!boarding.searched[member.room] && sim.layout.room(member.room).kind !== 'lift') return startSearch(sim, member);
  agent.aim = null;
  const next = nextRoom(sim, member);
  if (next) return void (goTo(sim, member, next) || (boarding.searched[next] = true));
  member.task = 'idle';
}

/** Has the party what it came for, or nothing left to try? Then it goes. */
function goalDone(sim) {
  const boarding = boardingOf(sim);
  const def = defOf(sim);
  const rooms = sim.layout.rooms.filter((room) => room.kind !== 'lift' && !sim.state.rooms[room.id].jettisoned);
  const left = rooms.filter((room) => !boarding.searched[room.id]);
  const busy = partyOf(sim).some((member) => member.alive && (member.agent.search || member.carry || member.path.length));
  if (boarding.wants === 'inspect') {
    const done = Object.keys(boarding.searched).length;
    if (done >= def.party.rooms || (!left.length && !busy)) return boarding.seized > 0 ? 'seized' : 'clean';
  } else if (boarding.wants === 'cargo') {
    if (boarding.took >= def.party.take) return 'took';
    if (!left.length && !busy && !rooms.some((room) => loot(sim, room.id).length)) return boarding.took ? 'took' : 'empty';
  } else if (boarding.wants === 'crew') {
    if (!sim.state.crew[boarding.target]?.alive) return boarding.took ? 'taken' : 'gaveup';
    if (!left.length && !busy) boarding.searched = {}; // round again until their time runs out
  } else if (boarding.wants === 'salvage' && !boarding.strip) return 'empty';
  return null;
}

/** One tick of the boarding. */
export function stepBoarders(sim, dt) {
  const boarding = boardingOf(sim);
  if (!boarding) return;
  const { tick } = sim.state;
  if (boarding.phase === 'demand') {
    if (tick >= boarding.demandEnds) comeAboard(sim);
    return;
  }
  const party = partyOf(sim);
  const standing = party.filter((member) => member.alive);
  if (boarding.phase === 'aboard') {
    for (const member of standing) {
      if (!member.path.length && member.task !== 'fighting') stepAgent(sim, member, dt);
      if (boardingOf(sim)?.phase !== 'aboard') return;
    }
    const down = party.filter((member) => !member.alive || member.agent.flee).length;
    if (down * 2 >= party.length) leave(sim, 'driven');
    else if (tick >= boarding.deadline) leave(sim, 'gaveup');
    else {
      const done = goalDone(sim);
      if (done) leave(sim, done);
    }
  }
  if (boarding.phase === 'leaving') {
    for (const member of standing) {
      if (member.path.length || member.task === 'fighting') continue;
      if (member.room === boarding.dock) {
        if (member.carry) takeCrate(sim, member);
        delete sim.state.crew[member.id];
        boarding.party = boarding.party.filter((id) => id !== member.id);
        crewEmit(sim, member, 'crew.left', { crew: member.id, room: member.room, tick });
      } else if (!goTo(sim, member, boarding.dock)) {
        // The dock is cut off for good (jettisoned, sealed): the nearest lock that is not.
        const lock = airlockRooms(sim).find((id) => findRoute(sim, member.room, id, member));
        if (lock) boarding.dock = lock;
      }
    }
    const still = partyOf(sim).filter((member) => member.alive);
    if (!still.length || tick >= boarding.leaveEnds) finish(sim);
  }
}

// ---------- orders ----------

const living = (sim, id) => {
  const member = sim.state.crew[id];
  if (!member || member.owner !== 'player' || !isHome(sim, member)) return `no crew member "${id}" of ours aboard`;
  if (!member.alive) return `${member.name} is dead`;
  return null;
};

/** Why there is no paying them at the lock just now, or null. */
export function whyNoBribe(sim) {
  const boarding = boardingOf(sim);
  if (!boarding) return 'nobody is docked with us';
  if (boarding.phase !== 'demand') return 'they are already aboard';
  const bribe = defOf(sim).party.bribe;
  if (!bribe) return 'they are not here for money';
  if (boarding.tried) return 'they have already said no';
  if (sim.state.money < bribe.cost) return `that takes ${bribe.cost} credits and we have ${sim.state.money}`;
  return null;
}

/** Why there is no handing over what they want just now, or null. */
export function whyNoYield(sim) {
  const boarding = boardingOf(sim);
  if (!boarding) return 'nobody is docked with us';
  if (boarding.phase !== 'demand') return 'they are already aboard';
  if (boarding.wants === 'cargo') return Object.values(sim.state.crates).some((crate) => crate.kind !== 'ammo' && !crate.hidden) ? null : 'there is nothing in the hold to give them';
  if (boarding.wants === 'crew') return sim.state.crew[boarding.target]?.alive ? null : 'the one they want is not aboard';
  return 'they are not asking for anything we could hand over';
}

export const BOARDING_COMMANDS = {
  // Hide where they stand, or come out. Engineers take a crawlway if there is one; everyone else a locker.
  'crew.hide': {
    check(sim, cmd) {
      const problem = living(sim, cmd.crew);
      if (problem) return problem;
      if (typeof cmd.on !== 'boolean') return 'needs on: true or false';
      const member = sim.state.crew[cmd.crew];
      if (!cmd.on) return member.hidden ? null : `${member.name} is not hiding`;
      return whyNoHide(sim, member);
    },
    apply(sim, cmd) {
      const member = sim.state.crew[cmd.crew];
      if (!cmd.on) return unhide(sim, member);
      letGo(sim, member);
      member.hidden = hidingSpot(sim, member);
      member.task = 'hiding';
      crewEmit(sim, member, 'crew.hid', { crew: member.id, room: member.room, spot: member.hidden, tick: sim.state.tick });
    },
  },
  // Open (or shut) a room's emergency vent: its air goes out into space.
  'room.vent': {
    check(sim, cmd) {
      const room = sim.layout.room(cmd.room);
      if (!room) return `no room "${cmd.room}"`;
      if (typeof cmd.open !== 'boolean') return 'needs open: true or false';
      if (sim.state.rooms[cmd.room].jettisoned) return 'that section is gone';
      if (room.kind === 'lift') return 'a lift shaft has no vent';
      if (Boolean(sim.state.rooms[cmd.room].vent) === cmd.open) return cmd.open ? 'the vent is already open' : 'the vent is already shut';
      if (!running(sim, 'doors')) return 'the vents are worked from door control, which is dark';
      return null;
    },
    apply(sim, cmd) {
      sim.state.rooms[cmd.room].vent = cmd.open;
      sim.events.emit('room.vented', { room: cmd.room, open: cmd.open, tick: sim.state.tick });
    },
  },
  // Pay them at the lock. It works, and they go; or they take the money and come aboard anyway.
  'boarding.bribe': {
    check: (sim) => whyNoBribe(sim),
    apply(sim) {
      const boarding = boardingOf(sim);
      const { cost } = defOf(sim).party.bribe;
      const chance = bribeChance(sim);
      const ok = sim.rng.stream('boarding').chance(chance);
      boarding.tried = true;
      addMoney(sim, -cost, 'bribe');
      sim.events.emit('boarding.bribed', { boarding: boarding.id, name: boarding.name, ok, cost, chance, tick: sim.state.tick });
      if (ok) {
        boarding.reason = 'bribed';
        finish(sim);
      } else boarding.demandEnds = sim.state.tick; // and in they come
    },
  },
  // Give them what they came for: the crates they asked for, or the one they hold a warrant for.
  'boarding.yield': {
    check: (sim) => whyNoYield(sim),
    apply(sim) {
      const boarding = boardingOf(sim);
      if (boarding.wants === 'cargo') {
        const crates = Object.values(sim.state.crates).filter((crate) => crate.kind !== 'ammo' && !crate.hidden).slice(0, defOf(sim).party.take);
        for (const crate of crates) {
          if (crate.by && sim.state.crew[crate.by]) {
            sim.state.crew[crate.by].carry = null;
            sim.state.crew[crate.by].job = null;
          }
          delete sim.state.crates[crate.id];
          boarding.took += 1;
          sim.events.emit('crate.taken', { crate: crate.id, kind: crate.kind, label: crate.label, by: null, room: boarding.dock, tick: sim.state.tick });
        }
        if (contractOf(sim)) checkCargo(sim, 'seized');
      } else {
        const target = sim.state.crew[boarding.target];
        letGo(sim, target);
        delete sim.state.crew[target.id];
        Object.assign(target, { goal: null, path: [], task: 'taken' });
        boarding.took = 1;
        sim.events.emit('crew.taken', { crew: target.id, name: target.name, room: target.room, by: null, tick: sim.state.tick });
      }
      boarding.reason = 'yielded';
      finish(sim);
    },
  },
  // Open the lock now rather than make them cut it.
  'boarding.admit': {
    check: (sim) => (boardingOf(sim)?.phase === 'demand' ? null : 'nobody is waiting at the lock'),
    apply(sim) {
      boardingOf(sim).demandEnds = sim.state.tick;
    },
  },
  // Turn on a party that came peacefully: an inspection or a salvage crew. Standing with an inspector's faction pays for it.
  'boarding.fight': {
    check(sim) {
      const boarding = boardingOf(sim);
      if (!boarding || boarding.phase === 'demand') return 'nobody is aboard to fight';
      if (boarding.hostile) return 'it is already a fight';
      return null;
    },
    apply(sim) {
      const boarding = boardingOf(sim);
      boarding.hostile = true;
      const faction = defOf(sim).party.faction;
      if (faction) changeReputation(sim, faction, -3, 'assault');
      sim.events.emit('boarding.hostile', { boarding: boarding.id, name: boarding.name, why: 'ordered', tick: sim.state.tick });
    },
  },
  // Debug panel and tests: put a party at our lock, as if its ship had just docked.
  'debug.boarding': {
    check(sim, cmd) {
      if (cmd.clear === true) return boardingOf(sim) ? null : 'nobody is docked with us';
      const def = sim.encounters.byId.get(cmd.encounter);
      if (!def) return `no encounter "${cmd.encounter}"`;
      if (!def.party) return `the ${def.name.toLowerCase()} sends nobody aboard`;
      if (boardingOf(sim)) return 'a party is already at the lock';
      if (cmd.at !== undefined && !airlockRooms(sim).includes(cmd.at)) return `no airlock in "${cmd.at}"`;
      if (cmd.target !== undefined && living(sim, cmd.target)) return living(sim, cmd.target);
      return null;
    },
    apply(sim, cmd) {
      if (cmd.clear) return finish(sim, 'gaveup');
      const boarding = startBoarding(sim, sim.encounters.byId.get(cmd.encounter), { at: cmd.at ?? null });
      if (boarding && cmd.target !== undefined) {
        boarding.target = cmd.target;
      }
      if (boarding && cmd.aboard) comeAboard(sim);
    },
  },
};

/** The rooms that have any of their floor on a deck. */
export function roomsOnDeck(sim, deck) {
  return sim.layout.rooms.filter((room) => !sim.state.rooms[room.id].jettisoned && room.y < deck.y + deck.h && room.y + room.h > deck.y).map((room) => room.id);
}

/** What a party member is doing, for the UI. */
export function describeBoarder(sim, member) {
  if (!member.alive) return 'Down';
  if (member.agent?.flee) return 'Falling back to the lock';
  if (member.carry) return 'Carrying off a crate';
  switch (member.task) {
    case 'searching':
      return 'Searching';
    case 'forcing':
      return 'Forcing a door';
    case 'grabbing':
      return 'Dragging someone off';
    case 'sabotage':
      return 'Stripping a system';
    case 'fighting':
      return 'Fighting';
    case 'walking':
      return boardingOf(sim)?.phase === 'leaving' ? 'Heading back to the lock' : 'Moving';
    default:
      return 'Standing';
  }
}

// ---------- invariants ----------

export function checkBoarderInvariants(sim) {
  const problems = [];
  const boarding = boardingOf(sim);
  const ids = new Set(boarding?.party ?? []);
  for (const member of Object.values(sim.state.crew)) {
    if (member.party && !ids.has(member.id)) problems.push(`boarder ${member.id} is aboard with no boarding on`);
    if (member.hidden && !['locker', 'crawlway'].includes(member.hidden)) problems.push(`crew ${member.id} is hiding "${member.hidden}"`);
    if (member.hidden && !member.alive) problems.push(`crew ${member.id} is dead and hiding`);
    if (member.hidden && member.path.length) problems.push(`crew ${member.id} is hiding and walking`);
  }
  for (const room of sim.layout.rooms) {
    const r = sim.state.rooms[room.id];
    const lockers = oursIn(sim, room.id).filter((member) => member.hidden === 'locker').length;
    if (lockers > (room.hide ?? 0)) problems.push(`${room.id}: ${lockers} hiding in ${room.hide ?? 0} lockers`);
    if (r.vent && r.jettisoned) problems.push(`${room.id} is gone with its vent open`);
  }
  if (!boarding) return problems;
  if (!GOALS[boarding.wants]) problems.push(`boarding wants "${boarding.wants}"`);
  if (!['demand', 'aboard', 'leaving'].includes(boarding.phase)) problems.push(`boarding is in phase "${boarding.phase}"`);
  if (!sim.encounters.byId.has(boarding.encounter)) problems.push(`boarding from no encounter "${boarding.encounter}"`);
  if (boarding.phase === 'demand' && boarding.party.length) problems.push('boarders aboard while still at the lock');
  if (boarding.phase === 'aboard' && sim.state.tick > boarding.deadline + 1) problems.push('a party stayed past its time');
  if (boarding.phase === 'leaving' && sim.state.tick > boarding.leaveEnds + 1) problems.push('a party is still aboard after the clamp should have come off');
  if (boarding.phase === 'demand' && sim.state.tick > boarding.demandEnds + 1) problems.push('a party is still waiting at the lock after its time');
  return problems;
}
