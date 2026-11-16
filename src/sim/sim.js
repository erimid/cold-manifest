// The simulation root. DOM-free (DECISIONS D-001): this file and everything it
// imports must run in plain Node, because tools/autoplay.js runs it headless.
//
// Two rules hold for everything that is ever added here (DECISIONS D-003):
//   1. The sim changes only inside step(). Nothing else may touch `state`.
//   2. The outside world talks to the sim only through enqueue(command), and
//      hears back only through the event bus.
// Together these make pause exact (the clock simply stops calling step) and
// let the autoplay bot use the same interface as a player.
//
// S1.3: the ship exists. Rooms carry their state (oxygen, temperature, light,
// noise, hull, fire, breach) and doors open, close and lock. Nothing changes
// those room values yet except lights and the debug command: power is S1.4,
// air and hazards are S1.5, crew are S1.6.

import { createEventBus } from '../engine/events.js';
import { createRngSet } from '../engine/rng.js';
import { buildLayout } from './ship.js';

/** Sim ticks per second (DECISIONS D-002). */
export const TICK_RATE = 20;
/** Seconds of game time per tick. */
export const TICK_SECONDS = 1 / TICK_RATE;

/** How long a door takes to slide fully open or shut, and a light to come up, in seconds. */
export const DOOR_SECONDS = 0.35;
export const LIGHT_SECONDS = 0.25;

const clamp01 = (value) => Math.max(0, Math.min(1, value));

/** The room values the debug command may set, with their allowed range. */
const ROOM_FIELDS = Object.freeze({
  oxygen: [0, 1],
  temperature: [-270, 1500],
  noise: [0, 1],
  hull: [0, 1],
  fire: [0, 1],
  breach: [0, 1],
});

function newRoomState() {
  return {
    oxygen: 1, // 0 to 1; 1 is a full, breathable atmosphere
    temperature: 20, // degrees C
    light: 1, // 0 to 1, what the room's lamps are putting out right now
    lightsOn: true, // what the lamps have been told to do
    noise: 0, // 0 to 1
    hull: 1, // 0 to 1 integrity
    fire: 0, // 0 to 1 intensity
    breach: 0, // 0 to 1 size of the hole
  };
}

function newDoorState() {
  return {
    state: 'closed', // open | closed | locked | jammed
    openness: 0, // 0 shut to 1 fully open; what crew, air and the creature actually meet
  };
}

/**
 * Every order the sim accepts. `check` returns a reason string when the order
 * makes no sense (it is rejected when given, and dropped if the world changed
 * before it could start); `apply` carries it out at the start of a tick.
 */
const COMMANDS = {
  'door.set': {
    check(sim, cmd) {
      const door = sim.state.doors[cmd.door];
      if (!door) return `no door "${cmd.door}"`;
      if (!['open', 'closed', 'locked'].includes(cmd.state)) return `a door cannot be set to "${cmd.state}"`;
      if (door.state === 'jammed') return 'the door is jammed';
      return null;
    },
    apply(sim, cmd) {
      const door = sim.state.doors[cmd.door];
      if (door.state === cmd.state) return;
      const from = door.state;
      door.state = cmd.state;
      sim.events.emit('door.changed', { door: cmd.door, from, to: cmd.state, tick: sim.state.tick });
    },
  },
  'room.lights': {
    check(sim, cmd) {
      if (!sim.state.rooms[cmd.room]) return `no room "${cmd.room}"`;
      if (typeof cmd.on !== 'boolean') return 'needs on: true or false';
      return null;
    },
    apply(sim, cmd) {
      const room = sim.state.rooms[cmd.room];
      if (room.lightsOn === cmd.on) return;
      room.lightsOn = cmd.on;
      sim.events.emit('room.lights', { room: cmd.room, on: cmd.on, tick: sim.state.tick });
    },
  },
  // Debug panel only (?debug=1): set room values directly, or jam and free a door.
  'debug.room': {
    check(sim, cmd) {
      if (!sim.state.rooms[cmd.room]) return `no room "${cmd.room}"`;
      for (const [field, value] of Object.entries(cmd.set ?? {})) {
        const range = ROOM_FIELDS[field];
        if (!range) return `cannot set "${field}"`;
        if (!(value >= range[0] && value <= range[1])) return `${field} must be between ${range[0]} and ${range[1]}`;
      }
      return null;
    },
    apply(sim, cmd) {
      Object.assign(sim.state.rooms[cmd.room], cmd.set);
    },
  },
  'debug.door': {
    check(sim, cmd) {
      if (!sim.state.doors[cmd.door]) return `no door "${cmd.door}"`;
      if (typeof cmd.jammed !== 'boolean') return 'needs jammed: true or false';
      return null;
    },
    apply(sim, cmd) {
      const door = sim.state.doors[cmd.door];
      const from = door.state;
      // A jammed door stays wherever it was; freed, it settles to the nearer end.
      const to = cmd.jammed ? 'jammed' : door.openness >= 0.5 ? 'open' : 'closed';
      if (from === to || (!cmd.jammed && from !== 'jammed')) return;
      door.state = to;
      sim.events.emit('door.changed', { door: cmd.door, from, to, tick: sim.state.tick });
    },
  },
};

function stepDoors(sim) {
  const stride = TICK_SECONDS / DOOR_SECONDS;
  for (const [id, door] of Object.entries(sim.state.doors)) {
    if (door.state === 'jammed') continue; // stuck exactly where it is
    const goal = door.state === 'open' ? 1 : 0;
    if (door.openness === goal) continue;
    door.openness = goal > door.openness ? Math.min(goal, door.openness + stride) : Math.max(goal, door.openness - stride);
    if (door.openness === goal) sim.events.emit(goal ? 'door.opened' : 'door.closed', { door: id, tick: sim.state.tick });
  }
}

function stepLights(sim) {
  const stride = TICK_SECONDS / LIGHT_SECONDS;
  for (const room of Object.values(sim.state.rooms)) {
    const goal = room.lightsOn ? 1 : 0;
    if (room.light === goal) continue;
    room.light = goal > room.light ? Math.min(goal, room.light + stride) : Math.max(goal, room.light - stride);
  }
}

/** Everything that happens each tick, in order. Later sessions add systems here. */
const SYSTEMS = [stepDoors, stepLights];

/**
 * Create a simulation.
 *   seed    the run seed
 *   ship    a ship layout item from content/ships/
 */
export function createSim({ seed, ship }) {
  const layout = buildLayout(ship);
  const sim = {
    /** The ship's fixed shape: rooms, doors, vents. Never changes during a run. */
    layout,
    state: {
      seed: String(seed),
      ship: layout.id,
      tick: 0,
      nextCommandId: 1,
      commands: [], // orders waiting for the next tick
      rooms: Object.fromEntries(layout.rooms.map((room) => [room.id, newRoomState()])),
      doors: Object.fromEntries(layout.doors.map((door) => [door.id, newDoorState()])),
    },
    rng: createRngSet(seed),
    events: createEventBus(),

    /**
     * Give an order. It is carried out at the start of the next tick, so an
     * order given while paused simply waits. Returns the order's id.
     * Throws if the order is unknown or makes no sense right now.
     */
    enqueue(command) {
      const handler = COMMANDS[command?.type];
      if (!handler) throw new Error(`Unknown command "${command?.type}"`);
      const problem = handler.check(sim, command);
      if (problem) throw new Error(`Bad ${command.type} command: ${problem}`);
      const id = sim.state.nextCommandId++;
      sim.state.commands.push({ ...command, id });
      return id;
    },

    /** Why an order would be refused right now, or null if it would be accepted. For the UI. */
    whyNot(command) {
      const handler = COMMANDS[command?.type];
      return handler ? handler.check(sim, command) : `Unknown command "${command?.type}"`;
    },

    /** Advance the simulation by exactly one tick. Only the clock (or a headless tool) calls this. */
    step() {
      const { state } = sim;
      state.tick += 1;
      const orders = state.commands;
      state.commands = [];
      for (const command of orders) {
        // The world may have changed since the order was given; skip orders that no longer make sense.
        const problem = COMMANDS[command.type].check(sim, command);
        if (problem) {
          sim.events.emit('command.dropped', { command, reason: problem, tick: state.tick });
          continue;
        }
        COMMANDS[command.type].apply(sim, command);
        sim.events.emit('command.applied', { command, tick: state.tick });
      }
      for (const system of SYSTEMS) system(sim);
    },

    /** Game time in seconds. */
    get time() {
      return sim.state.tick * TICK_SECONDS;
    },

    /** Everything needed to restore this exact moment (DECISIONS D-011). */
    snapshot() {
      return { state: structuredClone(sim.state), rng: sim.rng.getState() };
    },
    restore(snap) {
      if (snap.state.ship !== layout.id) throw new Error(`Save is for ship "${snap.state.ship}", not "${layout.id}"`);
      for (const key of Object.keys(sim.state)) delete sim.state[key];
      Object.assign(sim.state, structuredClone(snap.state));
      sim.rng.setState(snap.rng);
    },
  };
  return sim;
}

/** Problems with a sim state that should never happen. Empty means healthy. */
export function checkInvariants(sim) {
  const problems = [];
  const { state, layout } = sim;
  if (!Number.isInteger(state.tick) || state.tick < 0) problems.push(`tick is ${state.tick}`);
  const in01 = (value) => value >= 0 && value <= 1;

  for (const room of layout.rooms) {
    const r = state.rooms[room.id];
    if (!r) {
      problems.push(`room ${room.id} has no state`);
      continue;
    }
    for (const field of ['oxygen', 'light', 'noise', 'hull', 'fire', 'breach']) {
      if (!in01(r[field])) problems.push(`${room.id}.${field} is ${r[field]}`);
    }
    if (!(r.temperature >= -273.15 && r.temperature <= 5000)) problems.push(`${room.id}.temperature is ${r.temperature}`);
    if (typeof r.lightsOn !== 'boolean') problems.push(`${room.id}.lightsOn is ${r.lightsOn}`);
  }
  for (const door of layout.doors) {
    const d = state.doors[door.id];
    if (!d) {
      problems.push(`door ${door.id} has no state`);
      continue;
    }
    if (!['open', 'closed', 'locked', 'jammed'].includes(d.state)) problems.push(`${door.id}.state is ${d.state}`);
    if (!in01(d.openness)) problems.push(`${door.id}.openness is ${d.openness}`);
  }
  if (Object.keys(state.rooms).length !== layout.rooms.length) problems.push('room states do not match the layout');
  if (Object.keys(state.doors).length !== layout.doors.length) problems.push('door states do not match the layout');
  return problems;
}
