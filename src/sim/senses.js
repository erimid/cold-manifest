// What a ship gives off, and what can be made of it (D-074). DOM-free.
//
// One model, read three ways:
//   - a contact on the scope reads our SIGNATURE to notice us, track us and
//     close on us, and Margo reads theirs (encounters.js, H.1): running dark
//     is how a hauler is not caught;
//   - Margo reads each ROOM to know what is happening aboard. A room she
//     cannot see (lamps off, nobody in it, internal sensors down) keeps its
//     last-known state, and the screen shows that behind static;
//   - the creature (Stage 6) will read the same rooms through `sense()`: the
//     light, noise, heat and movement in a room are what it hunts by.
//
// A room gives off:
//   light     its lamps, or the glow of a fire
//   noise     running machinery, a fire, air rushing out of a hole, people at
//             work or fighting, a gun going off, a hit landing. Bangs fade.
//   heat      a fire, the power running through the room's system, the
//             reactor's load, the drive, and warm bodies
//   movement  people walking
// A ship's signature adds its rooms up: how much of it is lit, how loud it
// is, how hard the reactor is working, how hard the drive is burning, and a
// short flare each time a gun fires.
//
// What a ship knows:
//   state.seen[room]   our own rooms: { live, tick }, and once a room has been lost sight of, the
//                      ROOM_FACTS and `foes` as they were when it was (kept until it is seen again)
// While a room is in sight the truth is read straight from the ship: nothing is copied.
// (The fight's lock on another ship and the rooms of it resolving on a sensor
// return went with the duel in H.3.)

import { isHome } from './crew.js';
import { supply, used } from './power.js';

/** How much each part counts toward a ship's signature. The parts are each 0 to 1. */
export const SIGNATURE = Object.freeze({ light: 0.2, noise: 0.1, heat: 0.35, burn: 0.2, flare: 0.5 });
/** A ship's noise is its rooms' mean noise times this (most rooms are quiet). */
const SHIP_NOISE_GAIN = 3;

/** How loud things are in a room, 0 to 1. The loudest thing is what is heard. */
export const NOISE = Object.freeze({
  fire: 0.5, // at full intensity
  breach: 0.5, // a full-size hole with air still going out of it
  hum: 0.12, // a system with power, plus a little per bar
  humPerBar: 0.06,
  reactor: 0.3, // at full load
  drive: 0.5, // engines at full burn
  sensors: 0.3, // active sensors ping
  walking: 0.15,
  working: 0.3,
  fighting: 0.6,
  gun: 0.9, // a bang: a gun going off in the weapons room
  hit: 1, // a bang: a shot landing
  fade: 0.5, // how fast a bang dies away, per second
});

/** A gun going off lights the ship up for a few seconds: flare added per bar the gun draws, and how fast it fades. */
export const FLARE = Object.freeze({ perBar: 0.15, fade: 0.08 });

/** A fire's glow counts as light: a big fire shows on the cameras by itself. */
const FIRE_GLOW = 0.7;
/** Light enough for the cameras to see a room by. */
export const SEE_LIGHT = 0.35;

/** How well a ship's sensors read what is outside: unpowered (eyes and optics), powered, more per extra bar; and a ship built without a sensors room has a fixed set. */
export const GAIN = Object.freeze({ passive: 0.5, active: 1, perExtraBar: 0.25, builtin: 0.8 });

/** The facts about a room that are remembered when it can no longer be seen. */
export const ROOM_FACTS = Object.freeze(['oxygen', 'temperature', 'light', 'noise', 'hull', 'fire', 'breach']);

const clamp01 = (value) => Math.max(0, Math.min(1, value));

// ---------- state ----------

const factsOf = (r) => Object.fromEntries(ROOM_FACTS.map((field) => [field, r[field]]));

/** The sensing part of a new ship's state. */
export function newSenseState(layout) {
  return {
    flare: 0, // 0 to 1: a gun has just gone off (a brace will do the same, S2.8)
    seen: Object.fromEntries(layout.rooms.map((room) => [room.id, { live: true, tick: 0 }])),
  };
}

// ---------- what a room gives off ----------

const living = (ship, roomId) => Object.values(ship.state.crew).filter((member) => member.alive && member.room === roomId);
const NOBODY = Object.freeze([]);
/** Everyone alive aboard, by the room they are in: built once a tick, for the loops below. */
function byRoom(ship) {
  const rooms = new Map();
  for (const id in ship.state.crew) {
    const member = ship.state.crew[id];
    if (!member.alive) continue;
    const list = rooms.get(member.room);
    if (list) list.push(member);
    else rooms.set(member.room, [member]);
  }
  return rooms;
}
const copyFacts = (to, from) => {
  for (const field of ROOM_FACTS) to[field] = from[field];
};
const WORK = new Set(['extinguish', 'patch', 'repair', 'unjam', 'sabotage', 'lifting', 'opening', 'loading', 'cycling', 'stashing', 'forcing', 'searching', 'grabbing']);

/** The share of the reactor's output in use, 0 to 1. */
export function reactorLoad(ship) {
  const made = supply(ship);
  return made > 0 ? clamp01(used(ship) / made) : 0;
}

/** How hard the drive is burning, 0 to 1. */
export function burn(ship) {
  const { engines } = ship.state.systems;
  if (engines.absent) return 0;
  // Our own drive only burns when the helm has it lit (encounters.js). In a fight, and aboard any other
  // ship, powered engines are burning engines, as they were before the helm (the duel goes in H.3).
  const { helm, fight } = ship.state;
  if (helm && !(fight && !fight.over) && !helm.burn) return 0;
  return engines.power / engines.level;
}

/** Below this light a room is dark to stand in (the same line a dark walk uses, crew.js). A fire lights its own room. */
export const DARK_ROOM = 0.2;
/** The light in a room: its lamps, or a fire's glow. */
export const lightIn = (r) => Math.max(r.light, clamp01(r.fire * 2) * FIRE_GLOW);

/** The steady noise in a room, without any bang still ringing. `people` is who is in it; `load` the reactor's. */
function steadyNoise(ship, room, people, load) {
  const r = ship.state.rooms[room.id];
  if (r.jettisoned) return 0;
  let level = NOISE.fire * r.fire;
  if (r.oxygen > 0.02) level = Math.max(level, NOISE.breach * r.breach);
  const system = room.system ? ship.state.systems[room.system] : null;
  if (system && !system.lost) {
    if (room.system === 'reactor') level = Math.max(level, NOISE.reactor * load);
    else if (system.power > 0) {
      level = Math.max(level, NOISE.hum + NOISE.humPerBar * system.power);
      if (room.system === 'engines') level = Math.max(level, NOISE.drive * burn(ship));
      if (room.system === 'sensors') level = Math.max(level, NOISE.sensors);
    }
  }
  for (const member of people) {
    const loud = member.task === 'fighting' ? NOISE.fighting : member.task === 'walking' ? NOISE.walking : WORK.has(member.task) ? NOISE.working : 0;
    if (loud > level) level = loud;
  }
  return level;
}

/** A sudden noise in a room: it rings, then fades back to whatever the room sounds like. */
export function bang(ship, roomId, level) {
  const r = ship.state.rooms[roomId];
  if (r && !r.jettisoned) r.noise = Math.max(r.noise, clamp01(level));
}

/** The ship lights up for a moment: a gun firing. */
export function flare(ship, amount) {
  ship.state.flare = clamp01(ship.state.flare + amount);
}

/**
 * What can be sensed in a room, each 0 to 1 (movement is a head count). This
 * is the one reading everything uses: Margo's cameras, the other ship's
 * sensors, and in Stage 6 the creature.
 */
export function sense(ship, roomId, people = living(ship, roomId), load = reactorLoad(ship)) {
  const room = ship.layout.room(roomId);
  const r = ship.state.rooms[roomId];
  if (!room || r.jettisoned) return { light: 0, noise: 0, heat: 0, movement: 0 };
  const system = room.system ? ship.state.systems[room.system] : null;
  let heat = Math.max(0, r.temperature - 20) / 200 + 0.15 * people.length;
  if (system && !system.lost) {
    heat += 0.12 * system.power;
    if (room.system === 'reactor') heat += 0.5 * load;
    if (room.system === 'engines') heat += 0.5 * burn(ship);
  }
  let movement = 0;
  for (const member of people) if (member.task === 'walking') movement += 1;
  return { light: lightIn(r), noise: r.noise, heat: clamp01(heat), movement };
}

/** How much a room shows up to someone scanning the ship from outside, 0 to 1. */
export function emission(ship, roomId, people, load) {
  const s = sense(ship, roomId, people, load);
  return clamp01(0.5 * s.light + 0.3 * s.heat + 0.3 * s.noise);
}

// ---------- what a ship gives off ----------

/** A ship's signature: { light, noise, heat, burn, flare, total }, each 0 to 1. */
export function signature(ship) {
  const rooms = ship.layout.rooms.map((room) => ship.state.rooms[room.id]).filter((r) => !r.jettisoned);
  const count = Math.max(1, rooms.length);
  const light = rooms.reduce((sum, r) => sum + lightIn(r), 0) / count;
  const noise = clamp01((rooms.reduce((sum, r) => sum + r.noise, 0) / count) * SHIP_NOISE_GAIN);
  const heat = clamp01(reactorLoad(ship) + 0.25 * rooms.reduce((sum, r) => sum + r.fire, 0));
  const drive = burn(ship);
  const { flare: lit } = ship.state;
  const total = clamp01(SIGNATURE.light * light + SIGNATURE.noise * noise + SIGNATURE.heat * heat + SIGNATURE.burn * drive + SIGNATURE.flare * lit);
  return { light, noise, heat, burn: drive, flare: lit, total };
}

// ---------- what a ship can see ----------

/** How well this ship's sensors read another ship. */
export function sensorGain(ship) {
  const { sensors } = ship.state.systems;
  if (sensors.absent) return GAIN.builtin;
  return sensors.power > 0 ? GAIN.active + GAIN.perExtraBar * (sensors.power - 1) : GAIN.passive;
}

/** Are the ship's sensors running? They cover every room of our own ship, and keep the picture of the other ship fresh. */
export function sensorsUp(ship) {
  const { sensors } = ship.state.systems;
  return sensors.absent ? true : sensors.power > 0;
}

/** Can Margo see into this room right now? Sensors, enough light for the cameras, or one of ours standing in it. */
export function watched(ship, roomId) {
  const r = ship.state.rooms[roomId];
  if (r.jettisoned) return true; // there is nothing left to wonder about
  return sensorsUp(ship) || lightIn(r) >= SEE_LIGHT || living(ship, roomId).some((member) => isHome(ship, member));
}

/**
 * A room of our own as we know it: the facts, `live` (false when this is only
 * what was last seen), `age` in ticks since it was, and `foes` seen in it.
 */
export function roomView(ship, roomId) {
  const seen = ship.state.seen[roomId];
  const r = ship.state.rooms[roomId];
  if (seen.live) return { ...factsOf(r), jettisoned: r.jettisoned, lightsOn: r.lightsOn, live: true, age: 0, foes: living(ship, roomId).filter((member) => !isHome(ship, member)).length };
  // The lamps are ours to switch, so we know those; the rest is memory.
  return { ...factsOf(seen), light: r.light, jettisoned: false, lightsOn: r.lightsOn, live: false, age: ship.state.tick - seen.tick, foes: seen.foes };
}

/**
 * Is this news from a room nobody can see into? A fire that starts in the
 * dark is not known about until someone looks (then it is `fire.found`).
 */
export const unseen = (ship, event) => event?.room !== undefined && ship.state.seen[event.room]?.live === false;

/** Rooms of our own ship Margo cannot see into right now. */
export const hiddenRooms = (ship) => ship.layout.rooms.filter((room) => !ship.state.seen[room.id].live).map((room) => room.id);

// ---------- each tick ----------

/** Noise settles, the gun flare fades, and Margo looks into every room she can. */
export function stepSenses(ship, seconds) {
  const { state } = ship;
  const crew = byRoom(ship);
  const load = reactorLoad(ship);
  const cover = sensorsUp(ship);
  state.flare = Math.max(0, state.flare - FLARE.fade * seconds);

  let hidden = null;
  for (const room of ship.layout.rooms) {
    const r = state.rooms[room.id];
    const people = crew.get(room.id) ?? NOBODY;
    if (!r.jettisoned) r.noise = Math.max(steadyNoise(ship, room, people, load), r.noise - NOISE.fade * seconds);
    const seen = state.seen[room.id];
    // The same rule as watched(): sensors, light for the cameras, or one of ours standing there.
    if (!(r.jettisoned || cover || lightIn(r) >= SEE_LIGHT || people.some((member) => isHome(ship, member)))) {
      if (seen.live) {
        // Lost sight of it: remember it as it is this moment.
        (hidden ??= []).push(room.id);
        copyFacts(seen, r);
        seen.live = false;
        seen.tick = state.tick;
        seen.foes = 0;
        for (const member of people) if (!isHome(ship, member)) seen.foes += 1;
      }
      continue;
    }
    if (seen.live) continue;
    // Looking again: what is there now that was not when we last looked?
    if (!r.jettisoned) {
      if (r.fire > 0 && seen.fire === 0) ship.events.emit('fire.found', { room: room.id, tick: state.tick });
      if (r.breach > 0 && seen.breach === 0) ship.events.emit('breach.found', { room: room.id, tick: state.tick });
    }
    seen.live = true;
  }
  if (hidden) ship.events.emit('rooms.hidden', { rooms: hidden, tick: state.tick });
}

// ---------- invariants ----------

export function checkSenseInvariants(ship) {
  const problems = [];
  const { state } = ship;
  if (!(state.flare >= 0 && state.flare <= 1)) problems.push(`flare is ${state.flare}`);
  for (const room of ship.layout.rooms) {
    const seen = state.seen[room.id];
    if (!seen) problems.push(`room ${room.id} has never been seen`);
    else if (seen.tick > state.tick) problems.push(`room ${room.id} was last seen in the future`);
    else if (!seen.live && seen.fire === undefined) problems.push(`room ${room.id} is out of sight with nothing remembered`);
  }
  return problems;
}
