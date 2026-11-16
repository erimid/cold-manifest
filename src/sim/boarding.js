// Boarding (brief §7, S2.4). DOM-free.
//
// In a fight the two ships lie close enough to dock. Anyone can cross: they
// walk to an airlock on the ship they are on, spend BOARD_SECONDS in the
// docking tube, and come out of the other ship's airlock nearest where they
// were sent, then walk on from there. Crossing onto a ship needs its shield
// capacitor nearly empty and no brace up (S2.8); going home never does, but nobody gets into the tube with someone of
// the other side in the room hanging on to them. Once aboard, a boarder fights whoever of the
// other side shares their room and wrecks the system they stand in (crew.js).
//
// Every function takes two ship contexts (the sim, and enemyOf(sim)) so the
// player's orders and the enemy captain use the same code.

import { findRoute, hostilesBeside, isHome, letGo, planPath, spotIn } from './crew.js';

/** Seconds in the docking tube, either way. */
export const BOARD_SECONDS = 5;

const EPS = 1e-9;

/** Rooms with an airlock in their wall. */
export function airlockRooms(ship) {
  return [...new Set(ship.layout.doors.filter((door) => door.airlock).map((door) => door.a))].filter((id) => !ship.state.rooms[id].jettisoned);
}

/** The airlock room closest on foot to `from`, or null if none can be reached. */
export function nearestAirlock(ship, from) {
  let best = null;
  for (const id of airlockRooms(ship)) {
    const route = findRoute(ship, from, id);
    if (route && (best === null || route.length < best.length)) best = { id, length: route.length };
  }
  return best?.id ?? null;
}

/** Why `member` cannot cross from `from` to `to` right now, or null. Going home is always open; going aboard needs their shields down. */
export function whyNotCross(from, to, member) {
  if (member.task === 'crossing') return `${member.name} is already in the docking tube`;
  if (hostilesBeside(from, member).length) return `${member.name} cannot get away from the fight`;
  if (!isHome(to, member) && (to.state.shield.field > 0 || to.state.shield.charge >= 1 - EPS)) return 'their shields are up: a charged capacitor throws off the docking clamp';
  if (nearestAirlock(from, member.room) === null) return 'there is no way to an airlock';
  return null;
}

/** Send `member`, aboard `from`, across to `room` on `to`. Check whyNotCross first. */
export function sendAcross(from, to, member, room) {
  const airlock = nearestAirlock(from, member.room);
  letGo(from, member); // nobody takes a crate across
  member.board = { room };
  member.goal = airlock;
  member.path = planPath(from, member, airlock) ?? [];
  member.task = member.path.length ? 'walking' : 'idle';
  member.wreck = 0;
  (from.events.bus ?? from.events).emit(member.owner === 'enemy' ? 'enemy.crew.boarding' : 'crew.boarding', { crew: member.id, from: from.side, to: to.side, room, tick: from.state.tick });
}

/** Take someone out of `from` and put them down in `to`'s `room`, standing still. */
export function moveAboard(from, to, member, room) {
  delete from.state.crew[member.id];
  const { x, y } = spotIn(to.layout.room(room), member.index);
  Object.assign(member, { room, x, y, px: x, py: y, goal: null, path: [], task: 'idle', board: null, crossEnds: null, wreck: 0 });
  to.state.crew[member.id] = member;
}

/** Out of the tube: into the airlock nearest where they are going, then on their way. */
function arrive(from, to, member) {
  const goal = member.board.room;
  const rooms = airlockRooms(to);
  const reach = rooms.map((id) => ({ id, route: to.state.rooms[goal]?.jettisoned ? null : findRoute(to, id, goal) }));
  const best = reach.filter((r) => r.route).sort((a, b) => a.route.length - b.route.length)[0] ?? reach[0];
  if (!best) return; // nowhere to come out: they stay in the tube until the fight ends
  moveAboard(from, to, member, best.id);
  if (goal !== best.id && best.route) {
    member.goal = goal;
    member.path = planPath(to, member, goal);
    member.task = 'walking';
  }
  (to.events.bus ?? to.events).emit(member.owner === 'enemy' ? 'enemy.crew.boarded' : 'crew.boarded', { crew: member.id, onto: to.side, room: member.room, tick: to.state.tick });
}

/** One tick of crossing for both ships: people reaching an airlock step into the tube, and people in it come out. */
export function stepBoarding(us, them) {
  const tick = us.state.tick;
  for (const [from, to] of [[us, them], [them, us]]) {
    for (const member of Object.values(from.state.crew)) {
      if (!member.alive || !member.board || member.path.length) continue;
      if (member.task === 'crossing') {
        if (tick >= member.crossEnds) arrive(from, to, member);
        continue;
      }
      // Reached the airlock, or stopped short of it.
      const problem = airlockRooms(from).includes(member.room) ? whyNotCross(from, to, member) : 'they never reached the airlock';
      if (problem) {
        member.board = null;
        member.task = 'idle';
        (from.events.bus ?? from.events).emit(member.owner === 'enemy' ? 'enemy.crew.blocked' : 'crew.blocked', { crew: member.id, room: member.room, reason: 'boarding', why: problem, aboard: from.side, tick });
        continue;
      }
      member.task = 'crossing';
      member.crossEnds = tick + Math.round(BOARD_SECONDS * 20);
    }
  }
}

/** Everyone of `owner`'s crew, on either ship: [{ member, ship }]. */
export function everyone(us, them, owner) {
  const out = [];
  for (const ship of them ? [us, them] : [us]) for (const member of Object.values(ship.state.crew)) if (member.owner === owner) out.push({ member, ship });
  return out.sort((a, b) => a.member.index - b.member.index);
}

/** Boarding problems that should never happen. */
export function checkBoardingInvariants(us, them) {
  const problems = [];
  const seen = new Set();
  for (const ship of them ? [us, them] : [us]) {
    for (const member of Object.values(ship.state.crew)) {
      if (seen.has(member.id)) problems.push(`crew ${member.id} is aboard both ships`);
      seen.add(member.id);
      if (!them && !isHome(ship, member)) problems.push(`crew ${member.id} is aboard a ship not theirs with no fight on`);
      if (!them && member.board) problems.push(`crew ${member.id} is boarding with no fight on`);
      if (member.task === 'crossing' && !airlockRooms(ship).includes(member.room)) problems.push(`crew ${member.id} is crossing from ${member.room}, which has no airlock`);
    }
  }
  return problems;
}
