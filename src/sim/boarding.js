// Airlocks (brief §7, S2.4). DOM-free.
//
// Our crew no longer cross to another ship: the ship duel and its docking
// tube went in H.3 (D-152). What is left is where a ship can clamp on to us:
// a boarding party (boarders.js) comes through one of these, and cargo
// handed over goes out of one.

import { findRoute } from './crew.js';

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
