// Agents on our decks (Stage H, H.2; D-165). DOM-free.
//
// An agent is something that walks our ship on aims of its own: a boarding
// party now (boarders.js), the creature in Stage 6. It is crew-shaped (a
// crew.js member with `owner` not ours), so it walks the same room and door
// graph with the same pace, lifts and doors, and it never uses the service
// crawlways. What this file adds is what an agent makes of the ship:
//   - which room to try next: what it is looking for, plus the light, noise
//     and movement it can make out (the senses.js reading, D-074);
//   - going over a room, slower in the dark, and what turns up when it does:
//     our people hidden in lockers or a crawlway, crates in a compartment;
//   - forcing a locked or jammed door (crew.js does the work at the door).
//
// Our side of hiding lives here too: the `hide` places a ship file gives a
// room (lockers, bunks, a gap behind the crates), the crawlways an engineer
// can pull in after them, and a room's `compartment`, a space under the deck
// plates for one crate (more from S7.3).

import { FORCE_NOISE, FORCE_SECONDS, THIN_AIR, findRoute, isHome } from './crew.js';
import { lightIn, DARK_ROOM } from './senses.js';

export { FORCE_NOISE, FORCE_SECONDS, THIN_AIR };

/**
 * Going over a room: seconds are `base` plus `perTile` for each tile of floor, `corridor` of that for a
 * corridor (nothing to open), `dark` times as long without light.
 */
export const SEARCH = Object.freeze({ base: 3, perTile: 0.25, corridor: 0.35, dark: 1.6 });
/** The chance a search turns up each thing hidden in the room, at a thoroughness of 1, in the light. */
export const FIND = Object.freeze({ locker: 0.3, crawlway: 0.12, compartment: 0.18, dark: 0.5 });

/** The ways to hide: where, and what it takes. */
export const HIDING = Object.freeze({ locker: 'In a locker', crawlway: 'In a service crawlway' });

const clamp01 = (value) => Math.max(0, Math.min(1, value));

/** Our own people, alive and aboard, in a room. */
export const oursIn = (ship, roomId) => Object.values(ship.state.crew).filter((member) => member.alive && member.room === roomId && isHome(ship, member));

/** Is this room dark to someone standing in it? */
export const isDark = (ship, roomId) => lightIn(ship.state.rooms[roomId]) < DARK_ROOM;

/** How long an agent takes to go over a room, at a thoroughness of 1. */
export function searchSeconds(ship, roomId) {
  const room = ship.layout.room(roomId);
  let seconds = SEARCH.base + SEARCH.perTile * room.w * room.h;
  if (room.kind === 'corridor') seconds *= SEARCH.corridor;
  if (isDark(ship, roomId)) seconds *= SEARCH.dark;
  return seconds;
}

/** The chance one search of a room turns up something hidden there in `spot` (locker, crawlway, compartment). */
export function findChance(ship, roomId, spot, thorough = 1) {
  return clamp01((FIND[spot] ?? 0) * thorough * (isDark(ship, roomId) ? FIND.dark : 1));
}

// ---------- hiding ----------

/** Lockers free in a room for one of ours to hide in. */
export function lockersFree(ship, roomId) {
  const room = ship.layout.room(roomId);
  const taken = oursIn(ship, roomId).filter((member) => member.hidden === 'locker').length;
  return Math.max(0, (room?.hide ?? 0) - taken);
}

/** Crawlway hatches free in a room for an engineer to pull in after them. */
export function crawlwaysFree(ship, roomId) {
  const hatches = ship.layout.crawlExits(roomId).filter((exit) => !exit.creature && !ship.state.rooms[exit.to].jettisoned).length;
  const taken = oursIn(ship, roomId).filter((member) => member.hidden === 'crawlway').length;
  return Math.max(0, hatches - taken);
}

/** Where `member` would hide in the room they stand in: 'crawlway' (engineers prefer it), 'locker', or null. */
export function hidingSpot(ship, member) {
  if (member.engineer && crawlwaysFree(ship, member.room) > 0) return 'crawlway';
  if (lockersFree(ship, member.room) > 0) return 'locker';
  return null;
}

/** Why `member` cannot hide where they stand just now, or null. */
export function whyNoHide(ship, member) {
  if (member.hidden) return `${member.name} is already hidden`;
  if (member.path.length) return `${member.name} has to stop somewhere first`;
  if (member.carry) return `${member.name} cannot hide holding a crate`;
  if (hidingSpot(ship, member)) return null;
  const room = ship.layout.room(member.room);
  if (!room.hide && !(member.engineer && ship.layout.crawlExits(member.room).length)) return `there is nowhere to hide in ${room.name.toLowerCase()}`;
  return `every hiding place in ${room.name.toLowerCase()} is taken`;
}

/** Compartments free in a room for one more crate. */
export function compartmentsFree(ship, roomId) {
  const room = ship.layout.room(roomId);
  const used = Object.values(ship.state.crates).filter((crate) => crate.room === roomId && crate.hidden).length;
  return Math.max(0, (room?.compartment ?? 0) - used);
}

/** The room with a free compartment closest on foot to `from` for someone carrying, or null. */
export function nearestCompartment(ship, from) {
  let best = null;
  for (const room of ship.layout.rooms) {
    if (!room.compartment || ship.state.rooms[room.id].jettisoned || compartmentsFree(ship, room.id) < 1) continue;
    const route = findRoute(ship, from, room.id, null);
    if (route && (!best || route.length < best.length)) best = { id: room.id, length: route.length };
  }
  return best?.id ?? null;
}

// ---------- choosing where to go ----------

/**
 * How much a room draws an agent, before the distance: `bias` (what it expects to find there, by room id
 * or kind) plus what it can make out of the room from where it is: noise carries, light shows under the
 * doors, people moving can be heard. `senses` weighs those three.
 */
export function roomPull(ship, roomId, bias = 1, senses = { noise: 1, light: 0.3, movement: 0.6 }) {
  const r = ship.state.rooms[roomId];
  if (!r || r.jettisoned) return 0;
  const moving = Object.values(ship.state.crew).filter((member) => member.alive && member.room === roomId && isHome(ship, member) && member.task === 'walking').length;
  return bias + senses.noise * 2 * r.noise + senses.light * lightIn(r) + senses.movement * Math.min(2, moving);
}

/**
 * The best room for `agent` to go to next among `rooms`, or null: the pull of each, less a little for
 * every door on the way. `rng` breaks ties a little differently each time.
 */
export function pickRoom(ship, agent, rooms, pullOf, rng) {
  let best = null;
  for (const id of rooms) {
    const route = id === agent.room ? [] : findRoute(ship, agent.room, id, agent);
    if (!route) continue;
    const score = pullOf(id) - 0.15 * route.length + (rng ? rng.range(0, 0.05) : 0);
    if (!best || score > best.score) best = { id, score };
  }
  return best?.id ?? null;
}
