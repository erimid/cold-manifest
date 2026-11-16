// What a condition can ask about (S3.3, D-109). DOM-free.
//
// Each fact has:
//   args      what it needs to be told, by name and type ("room", "crew", "door",
//             "system", "string"); `optional` lists the ones that may be left out
//   value     what it gives back: "number", "boolean", "string" or "any"
//   get       (sim, args, ctx) -> the value, or undefined when what it was pointed
//             at is not there (a condition on it then does not hold)
//
// Adding a fact here is all it takes for events, refusals, risks and lines to be
// able to ask it, and for the content checker to check every use of it.

import { usable } from '../sim/power.js';
import { DARK_ROOM, lightIn, roomView } from '../sim/senses.js';

const room = (sim, id) => {
  const r = sim.state.rooms[id];
  return r && !r.jettisoned ? r : undefined;
};
const member = (sim, id) => sim.state.crew[id];
const others = (sim, roomId, but) => Object.values(sim.state.crew).filter((other) => other.alive && other.room === roomId && other.id !== but);
const run = (sim) => sim.state.run ?? undefined;
const fightOn = (sim) => Boolean(sim.state.fight && !sim.state.fight.over);

export const FACTS = Object.freeze({
  // ---------- the run ----------
  money: { value: 'number', get: (sim) => sim.state.money },
  fuel: { value: 'number', get: (sim) => run(sim)?.fuel },
  'fuel.room': { value: 'number', get: (sim) => run(sim) && run(sim).fuelMax - run(sim).fuel },
  jumps: { value: 'number', get: (sim) => run(sim)?.jumps },
  'jumps.left': { value: 'number', get: (sim) => run(sim) && run(sim).deadline - run(sim).jumps },
  late: { value: 'boolean', get: (sim) => run(sim)?.late },
  followed: { value: 'boolean', get: (sim) => run(sim) && Boolean(run(sim).pursuit && !run(sim).pursuit.done) },
  'place.kind': { value: 'string', get: (sim) => run(sim)?.map.nodes.find((node) => node.id === run(sim).at)?.kind },
  flag: { args: { name: 'string' }, value: 'any', get: (sim, a) => run(sim)?.flags?.[a.name] ?? 0 },
  'event.met': { args: { event: 'event' }, value: 'boolean', get: (sim, a) => Boolean(run(sim)?.events?.met.includes(a.event)) },
  fight: { value: 'boolean', get: fightOn },

  // ---------- the ship ----------
  hull: { value: 'number', get: (sim) => sim.state.hull.points },
  'hull.lost': { value: 'number', get: (sim) => sim.state.hull.max - sim.state.hull.points },
  trust: { value: 'number', get: (sim) => sim.state.ai.trust },
  cargo: { args: { name: 'string' }, optional: ['name'], value: 'number', get: (sim, a) => sim.state.cargo.filter((item) => a.name === undefined || item.name === a.name).reduce((sum, item) => sum + item.qty, 0) },
  crates: { args: { kind: 'string' }, optional: ['kind'], value: 'number', get: (sim, a) => Object.values(sim.state.crates).filter((crate) => a.kind === undefined || crate.kind === a.kind).length },
  'system.power': { args: { system: 'system' }, value: 'number', get: (sim, a) => sim.state.systems[a.system]?.power },
  'system.damage': { args: { system: 'system' }, value: 'number', get: (sim, a) => sim.state.systems[a.system]?.damage },
  'system.usable': { args: { system: 'system' }, value: 'number', get: (sim, a) => (sim.state.systems[a.system] ? usable(sim, a.system) : undefined) },

  // ---------- rooms, as they are ----------
  'room.fire': { args: { room: 'room' }, value: 'number', get: (sim, a) => room(sim, a.room)?.fire },
  'room.breach': { args: { room: 'room' }, value: 'number', get: (sim, a) => room(sim, a.room)?.breach },
  'room.oxygen': { args: { room: 'room' }, value: 'number', get: (sim, a) => room(sim, a.room)?.oxygen },
  'room.light': { args: { room: 'room' }, value: 'number', get: (sim, a) => room(sim, a.room) && lightIn(room(sim, a.room)) },
  'room.dark': { args: { room: 'room' }, value: 'boolean', get: (sim, a) => room(sim, a.room) && lightIn(room(sim, a.room)) < DARK_ROOM },
  'room.gone': { args: { room: 'room' }, value: 'boolean', get: (sim, a) => (sim.state.rooms[a.room] ? Boolean(sim.state.rooms[a.room].jettisoned) : undefined) },
  /** How many of ours stand in a room. */
  'room.crew': { args: { room: 'room' }, value: 'number', get: (sim, a) => room(sim, a.room) && others(sim, a.room).filter((other) => other.owner === 'player' && other.task !== 'crossing').length },
  /** Is anyone who is not ours in the room? */
  'room.foes': { args: { room: 'room' }, value: 'boolean', get: (sim, a) => room(sim, a.room) && others(sim, a.room).some((other) => other.owner !== 'player') },
  /** Is anyone of ours in the room, other than `crew`? */
  'room.friends': { args: { room: 'room', crew: 'crew' }, optional: ['crew'], value: 'boolean', get: (sim, a) => room(sim, a.room) && others(sim, a.room, a.crew).some((other) => other.owner === 'player') },

  // ---------- rooms, as Margo sees them (senses.js): stale or blank where she has no eyes ----------
  'seen.live': { args: { room: 'room' }, value: 'boolean', get: (sim, a) => (sim.state.rooms[a.room] ? roomView(sim, a.room).live : undefined) },
  'seen.fire': { args: { room: 'room' }, value: 'number', get: (sim, a) => (sim.state.rooms[a.room] ? roomView(sim, a.room).fire : undefined) },
  'seen.oxygen': { args: { room: 'room' }, value: 'number', get: (sim, a) => (sim.state.rooms[a.room] ? roomView(sim, a.room).oxygen : undefined) },

  // ---------- doors ----------
  'door.airlock': { args: { door: 'door' }, value: 'boolean', get: (sim, a) => (sim.state.doors[a.door] ? Boolean(sim.layout.door(a.door)?.airlock) : undefined) },
  'door.state': { args: { door: 'door' }, value: 'string', get: (sim, a) => sim.state.doors[a.door]?.state },
  'door.open': { args: { door: 'door' }, value: 'boolean', get: (sim, a) => sim.state.doors[a.door] && sim.state.doors[a.door].openness > 0 },

  // ---------- one of the crew ----------
  'crew.alive': { args: { crew: 'crew' }, value: 'boolean', get: (sim, a) => Boolean(member(sim, a.crew)?.alive) },
  'crew.ours': { args: { crew: 'crew' }, value: 'boolean', get: (sim, a) => member(sim, a.crew) && member(sim, a.crew).owner === 'player' },
  'crew.suit': { args: { crew: 'crew' }, value: 'boolean', get: (sim, a) => member(sim, a.crew) && Boolean(member(sim, a.crew).suit) },
  'crew.health': { args: { crew: 'crew' }, value: 'number', get: (sim, a) => member(sim, a.crew)?.health },
  'crew.dread': { args: { crew: 'crew' }, value: 'number', get: (sim, a) => member(sim, a.crew)?.dread },
  'crew.room': { args: { crew: 'crew' }, value: 'string', get: (sim, a) => member(sim, a.crew)?.room },
  'crew.skill': { args: { crew: 'crew', skill: 'skill' }, value: 'number', get: (sim, a) => member(sim, a.crew) && (member(sim, a.crew).skills?.[a.skill] ?? 0) },
  /** How many of ours are alive aboard. */
  'crew.count': { value: 'number', get: (sim) => Object.values(sim.state.crew).filter((one) => one.alive && one.owner === 'player').length },

  // ---------- what set this off: a field of the order being weighed, or of the bus event ----------
  order: { args: { field: 'string' }, value: 'any', get: (sim, a, ctx) => ctx.vars?.order?.value?.[a.field] },
  event: { args: { field: 'string' }, value: 'any', get: (sim, a, ctx) => ctx.vars?.event?.value?.[a.field] },
});
