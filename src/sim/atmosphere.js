// Air, fire, breaches, venting and jettison (brief §6). DOM-free.
//
// Each room's `oxygen` is how full of breathable air it is, 0 to 1. Air moves
// between rooms through open doors, leaks to space through an open airlock or
// a hull breach, is topped up by life support and is burned by fire. Bigger
// rooms hold more air, so they take longer to empty and to refill.
//
// Fire needs air: it grows where there is plenty, starves below FIRE_MIN_O2 and
// is out the moment the room is empty. It heats the room, wears down the
// room's system and anyone standing in it, and jumps to neighbouring rooms,
// readily through an open door and rarely through a closed one.
//
// All the numbers here are starting values to tune by play (DECISIONS D-034).

import { SPACE } from './systems.js';

/** How fast air moves through a fully open interior door, an open airlock, and a full-size breach (tiles of air per second per unit of difference). */
export const DOOR_FLOW = 8;
export const AIRLOCK_FLOW = 30;
export const BREACH_FLOW = 6;

/** Oxygen a room regains per second for each bar on life support, and loses per second with none. */
export const O2_REFILL_PER_BAR = 1 / 60;
export const O2_STALE = 1 / 480;

/** Below this much oxygen a fire starves; a new fire needs FIRE_CATCH_O2 to take hold. */
export const FIRE_MIN_O2 = 0.12;
export const FIRE_CATCH_O2 = 0.25;
export const FIRE_GROWTH = 0.025; // per second in full air
export const FIRE_STARVE = 0.3; // per second when starved
export const FIRE_BURN = 0.03; // oxygen per second at full intensity
export const FIRE_START = 0.15; // the size of a fire that has just caught
/** Chance per second that a full-size fire jumps through an open door, and the fraction of that through a closed one. */
export const FIRE_SPREAD = 0.05;
export const CLOSED_DOOR_SPREAD = 0.04;
/** Seconds of full-size fire to break one bar of the room's system. */
export const SCORCH_SECONDS = 15;

/** Temperatures in °C, and how fast a room moves toward its target (fraction of the gap per second). */
export const TEMP_NORMAL = 20;
export const TEMP_FIRE = 480; // added at full intensity
export const TEMP_EXPOSED = -90; // open to space
export const TEMP_RATE = 0.12;

/** Below this much oxygen an unsuited crew member starts to suffocate. */
export const BREATHABLE_O2 = 0.15;
export const SUFFOCATE_SECONDS = 8; // from full health, in no air at all
export const BURN_SECONDS = 20; // from full health, in a full-size fire
export const SUIT_FIRE_PROTECTION = 0.5;

const clamp01 = (value) => Math.max(0, Math.min(1, value));
const volume = (room) => room.w * room.h;

/** Is this room open to space right now, through an airlock or a breach? */
export function isExposed(sim, roomId) {
  if (sim.state.rooms[roomId].breach > 0) return true;
  return sim.layout.exits(roomId).some((exit) => exit.to === SPACE && sim.state.doors[exit.door].openness > 0);
}

function stepAir(sim, seconds) {
  const { rooms, doors, systems } = sim.state;

  // Life support, ship-wide.
  const bars = systems.life_support.power;
  const change = bars > 0 ? bars * O2_REFILL_PER_BAR * seconds : -O2_STALE * seconds;
  for (const room of Object.values(rooms)) {
    if (!room.jettisoned) room.oxygen = clamp01(room.oxygen + change);
  }

  // Through doors: between rooms the air evens out; through an airlock it is gone.
  for (const door of sim.layout.doors) {
    const { openness } = doors[door.id];
    if (openness <= 0) continue;
    const a = rooms[door.a];
    const va = volume(sim.layout.room(door.a));
    if (door.airlock) {
      a.oxygen = clamp01(a.oxygen * (1 - Math.min(1, (AIRLOCK_FLOW * openness * seconds) / va)));
      continue;
    }
    const b = rooms[door.b];
    const vb = volume(sim.layout.room(door.b));
    const difference = a.oxygen - b.oxygen;
    if (difference === 0) continue;
    // Never move more than would make the two rooms equal.
    const share = Math.min(1, (DOOR_FLOW * openness * seconds * (va + vb)) / (va * vb));
    const moved = (difference * share * (va * vb)) / (va + vb);
    a.oxygen = clamp01(a.oxygen - moved / va);
    b.oxygen = clamp01(b.oxygen + moved / vb);
  }

  // Through the hull.
  for (const room of sim.layout.rooms) {
    const r = rooms[room.id];
    if (r.breach > 0 !== r.breached) {
      r.breached = r.breach > 0;
      if (r.breached) sim.events.emit('breach.opened', { room: room.id, tick: sim.state.tick });
    }
    if (r.breach > 0 && r.oxygen > 0) r.oxygen = clamp01(r.oxygen * (1 - Math.min(1, (BREACH_FLOW * r.breach * seconds) / volume(room))));
  }
}

function stepFire(sim, seconds) {
  const { rooms, doors, systems } = sim.state;
  const dice = sim.rng.stream('hazard');
  const catching = [];

  for (const room of sim.layout.rooms) {
    const r = rooms[room.id];
    if (r.fire <= 0) {
      if (r.burning) {
        r.burning = false;
        r.scorch = 0;
      }
      continue;
    }
    if (!r.burning) {
      // Lit by something other than spread (a hit, the debug panel): announce it once.
      r.burning = true;
      sim.events.emit('fire.started', { room: room.id, cause: 'ignition', tick: sim.state.tick });
    }

    // It eats air, and the air decides whether it grows or dies.
    r.oxygen = clamp01(r.oxygen - FIRE_BURN * r.fire * seconds);
    if (r.oxygen <= 0) r.fire = 0;
    else if (r.oxygen < FIRE_MIN_O2) r.fire = Math.max(0, r.fire - FIRE_STARVE * seconds);
    else r.fire = Math.min(1, r.fire + FIRE_GROWTH * r.oxygen * seconds);

    if (r.fire <= 0) {
      r.burning = false;
      r.scorch = 0;
      sim.events.emit('fire.out', { room: room.id, tick: sim.state.tick });
      continue;
    }

    // The room's system cooks, one bar at a time.
    if (room.system) {
      const system = systems[room.system];
      if (system.damage < system.level) {
        r.scorch += (r.fire * seconds) / SCORCH_SECONDS;
        if (r.scorch >= 1) {
          r.scorch = 0;
          system.damage += 1;
          sim.events.emit('system.damage', { system: room.system, from: system.damage - 1, to: system.damage, cause: 'fire', tick: sim.state.tick });
        }
      }
    }

    // It looks for the next room.
    for (const exit of sim.layout.exits(room.id)) {
      if (exit.to === SPACE) continue;
      const next = rooms[exit.to];
      if (next.fire > 0 || next.jettisoned || next.oxygen < FIRE_CATCH_O2 || catching.includes(exit.to)) continue;
      const open = doors[exit.door].openness;
      const chance = FIRE_SPREAD * r.fire * seconds * (open > 0 ? Math.max(open, CLOSED_DOOR_SPREAD) : CLOSED_DOOR_SPREAD);
      if (dice.chance(chance)) catching.push(exit.to);
    }
  }

  // New fires start after the pass, so a fire cannot cross two rooms in one tick.
  for (const roomId of catching) {
    Object.assign(rooms[roomId], { fire: FIRE_START, burning: true });
    sim.events.emit('fire.started', { room: roomId, cause: 'spread', tick: sim.state.tick });
  }
}

function stepTemperature(sim, seconds) {
  const share = Math.min(1, TEMP_RATE * seconds);
  for (const room of sim.layout.rooms) {
    const r = sim.state.rooms[room.id];
    if (r.jettisoned) continue;
    const target = TEMP_NORMAL + TEMP_FIRE * r.fire + (isExposed(sim, room.id) ? TEMP_EXPOSED * (1 - r.oxygen) : 0);
    r.temperature += (target - r.temperature) * share;
    // Fire is loud (the creature will listen for this in Stage 6).
    r.noise = r.fire * 0.5;
  }
}

/** Kill a crew member. Stage 4 hangs memories and grief on this event. */
export function killCrew(sim, id, cause) {
  const member = sim.state.crew[id];
  if (!member || member.alive === false) return;
  Object.assign(member, { alive: false, health: 0, goal: null, path: [], task: 'dead' });
  sim.events.emit('crew.died', { crew: id, room: member.room, cause, tick: sim.state.tick });
}

/** What bad air and fire do to anyone standing in them. */
function stepCrewHazards(sim, seconds) {
  for (const [id, member] of Object.entries(sim.state.crew)) {
    if (member.alive === false) continue;
    const room = sim.state.rooms[member.room];
    if (!room) continue;
    let health = member.health ?? 1;
    let cause = null;
    if (!member.suit && room.oxygen < BREATHABLE_O2) {
      health -= ((1 - room.oxygen / BREATHABLE_O2) * seconds) / SUFFOCATE_SECONDS;
      cause = 'suffocation';
    }
    if (room.fire > 0) {
      health -= (room.fire * seconds * (member.suit ? 1 - SUIT_FIRE_PROTECTION : 1)) / BURN_SECONDS;
      cause = 'fire';
    }
    if (cause === null) continue;
    const before = member.health ?? 1;
    member.health = Math.max(0, health);
    if (before >= 0.5 && member.health < 0.5 && member.health > 0) sim.events.emit('crew.hurt', { crew: id, room: member.room, cause, tick: sim.state.tick });
    if (member.health === 0) killCrew(sim, id, cause);
  }
}

/** One tick of air, fire, heat and what they do to people. */
export function stepAtmosphere(sim, seconds) {
  stepAir(sim, seconds);
  stepFire(sim, seconds);
  stepTemperature(sim, seconds);
  stepCrewHazards(sim, seconds);
}

// ---------- emergency jettison ----------

/** Why this room cannot be jettisoned right now, or null if it can. */
export function whyNotJettison(sim, roomId) {
  const room = sim.layout.room(roomId);
  if (!room) return `no room "${roomId}"`;
  if (sim.state.rooms[roomId].jettisoned) return 'that section is already gone';
  if (!room.jettison) return 'that section is part of the spine of the ship and cannot be cut loose';
  for (const exit of sim.layout.exits(roomId)) {
    if (exit.to === SPACE) continue;
    const door = sim.state.doors[exit.door];
    if (door.openness > 0 || door.state === 'open') return 'seal it first: every door into it must be shut';
  }
  return null;
}

export const ATMOSPHERE_COMMANDS = {
  // Cut a sealed room loose. Whatever is inside is lost, crew included.
  'room.jettison': {
    check: (sim, cmd) => whyNotJettison(sim, cmd.room),
    apply(sim, cmd) {
      const room = sim.layout.room(cmd.room);
      const r = sim.state.rooms[cmd.room];
      const hadFire = r.fire > 0;
      Object.assign(r, { jettisoned: true, oxygen: 0, temperature: -270, light: 0, lightsOn: false, noise: 0, hull: 0, fire: 0, breach: 0, scorch: 0, burning: false, breached: false });
      if (hadFire) sim.events.emit('fire.out', { room: cmd.room, tick: sim.state.tick });
      // Every door that led there is welded shut for good.
      for (const exit of sim.layout.exits(cmd.room)) {
        Object.assign(sim.state.doors[exit.door], { state: 'locked', openness: 0, sealed: true });
      }
      // Its system goes with it.
      if (room.system) {
        const system = sim.state.systems[room.system];
        const from = system.damage;
        Object.assign(system, { damage: system.level, power: 0, lost: true });
        sim.events.emit('system.damage', { system: room.system, from, to: system.level, cause: 'jettison', tick: sim.state.tick });
      }
      const lost = [];
      for (const [id, member] of Object.entries(sim.state.crew)) {
        if (member.room !== cmd.room || member.alive === false) continue;
        lost.push(id);
        killCrew(sim, id, 'jettison');
      }
      sim.events.emit('room.jettisoned', { room: cmd.room, system: room.system ?? null, crew: lost, tick: sim.state.tick });
    },
  },
};

/** Air and fire problems that should never happen. */
export function checkAtmosphereInvariants(sim) {
  const problems = [];
  for (const room of sim.layout.rooms) {
    const r = sim.state.rooms[room.id];
    if (!(r.scorch >= 0 && r.scorch <= 1)) problems.push(`${room.id}.scorch is ${r.scorch}`);
    if (r.fire > 0 && r.oxygen <= 0) problems.push(`${room.id} is burning with no air`);
    if (r.jettisoned && (r.fire > 0 || r.oxygen > 0 || r.lightsOn)) problems.push(`${room.id} is jettisoned but not dead`);
  }
  for (const [id, member] of Object.entries(sim.state.crew)) {
    if (member.alive !== false && member.health !== undefined && !(member.health > 0 && member.health <= 1)) problems.push(`crew ${id} is alive with health ${member.health}`);
  }
  return problems;
}
