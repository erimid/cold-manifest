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
// The ship has power (power.js): the reactor's bars are routed between
// systems, lights draw from the same pool, and doors need the door control
// system or a pair of hands. It has air (atmosphere.js): oxygen flows through
// doors, fire burns it, breaches and airlocks lose it, and a sealed room can
// be jettisoned. It has crew (crew.js): they walk the room and door graph and
// fight fires, patch breaches and repair systems where they stand. And it has
// a voice (ai/voice.js): the ship AI remarks on what happens, on the same clock.
// She has a say (ai/judgement.js): she holds an order she thinks is risky or
// monstrous until the captain overrides or stands down. The crew remember
// (memory.js), and may refuse an order because of what they remember.
// And it can fight (combat.js): in a fight the enemy is a second whole ship,
// stepped by the same code as the player's.

import { attachJudgement, checkJudgementInvariants, considerOrder, overrode, standDown, stepJudgement, takeObjection } from '../ai/judgement.js';
import { attachVoice, checkVoiceInvariants, newVoiceState, stepVoice } from '../ai/voice.js';
import { createEventBus } from '../engine/events.js';
import { createRngSet } from '../engine/rng.js';
import { checkBoardingInvariants } from './boarding.js';
import { ATMOSPHERE_COMMANDS, checkAtmosphereInvariants, stepAtmosphere } from './atmosphere.js';
import { START_MONEY, checkCombatInvariants, checkFightInvariants, combatCommands, enemyOf, newCombatState, stepCombat } from './combat.js';
import { CREW_COMMANDS, checkCrewInvariants, newCrewState, stepCrew } from './crew.js';
import { POWER_COMMANDS, checkPowerInvariants, isPowered, lightsNeedPower, newSystemsState, stepPower } from './power.js';
import { checkSenseInvariants, newSenseState, stepSenses } from './senses.js';
import { HOLD_COMMANDS, checkHoldInvariants, newHoldState, stepHold } from './hold.js';
import { MEMORY_TYPES, attachMemory, checkMemoryInvariants, lampHolder, remember, stepNerve, whyKeepLamp } from './memory.js';
import { attachSector, checkRunInvariants, newRunState, sectorCommands, stepSector } from './sector.js';
import { buildLayout } from './ship.js';

/** Sim ticks per second (DECISIONS D-002). */
export const TICK_RATE = 20;
/** Seconds of game time per tick. */
export const TICK_SECONDS = 1 / TICK_RATE;

/** How long a door takes to slide fully open or shut, and a light to come up, in seconds. */
export const DOOR_SECONDS = 0.35;
/** A door worked by hand, with door control unpowered, is slower. */
export const MANUAL_DOOR_SECONDS = 1.2;
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
    breached: false, // whether the current breach has been announced
    scorch: 0, // 0 to 1 progress of a fire toward breaking the next bar of the room's system
    burning: false, // whether the current fire has been announced
    jettisoned: false, // cut loose and gone for good
  };
}

function newDoorState() {
  return {
    state: 'closed', // open | closed | locked | jammed
    openness: 0, // 0 shut to 1 fully open; what crew, air and the creature actually meet
  };
}

/**
 * Everything that makes up one ship's state: the player's, or an enemy's in a fight.
 * `roster` is the crew aboard: [{ id, name }], `owner` whose crew they are ('player' or 'enemy'),
 * and `catalog` where its weapons are looked up.
 */
export function newShipState(layout, roster, owner, catalog) {
  const systems = newSystemsState(layout);
  return {
    rooms: Object.fromEntries(layout.rooms.map((room) => [room.id, newRoomState()])),
    doors: Object.fromEntries(layout.doors.map((door) => [door.id, newDoorState()])),
    systems,
    crew: newCrewState(layout, roster, owner),
    ...newHoldState(layout),
    ...newCombatState(layout, systems, catalog),
    ...newSenseState(layout),
  };
}

/** Is anyone standing on either side of this door, able to work it by hand? */
export function handsAt(sim, doorId) {
  const door = sim.layout.door(doorId);
  return Object.values(sim.state.crew).some((member) => member.alive !== false && (member.room === door.a || member.room === door.b));
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
      if (door.sealed) return 'that section is gone';
      if (door.state === 'jammed') return 'the door is jammed';
      if (door.state === cmd.state || isPowered(sim, 'doors')) return null;
      // Door control is dark (brief §6): locks stay as they are, and a door moves only if someone is there to move it.
      if (cmd.state === 'locked' || door.state === 'locked') return 'the lock needs door control power';
      if (!handsAt(sim, cmd.door)) return 'door control has no power, so someone has to work it by hand';
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
      if (sim.state.rooms[cmd.room].jettisoned) return 'that section is gone';
      if (cmd.on && !sim.state.rooms[cmd.room].lightsOn && lightsNeedPower(sim)) return 'no spare power for more lights';
      // Someone badly scared by the dark keeps the lamp on where they stand (S2.10).
      if (!cmd.on && sim.state.rooms[cmd.room].lightsOn) return whyKeepLamp(sim, cmd.room);
      return null;
    },
    apply(sim, cmd) {
      const room = sim.state.rooms[cmd.room];
      if (room.lightsOn === cmd.on) return;
      room.lightsOn = cmd.on;
      sim.events.emit('room.lights', { room: cmd.room, on: cmd.on, tick: sim.state.tick });
    },
  },
  // Every lamp at once: off to run dark, or back on for as many rooms as there is power to light.
  'lights.all': {
    check(sim, cmd) {
      if (typeof cmd.on !== 'boolean') return 'needs on: true or false';
      const rooms = Object.entries(sim.state.rooms).filter(([, room]) => !room.jettisoned);
      if (!rooms.some(([, room]) => room.lightsOn !== cmd.on)) return cmd.on ? 'every lamp is already on' : 'the ship is already dark';
      // Lamps the crew are holding on stay on: if those are all that is left, there is nothing to switch.
      if (!cmd.on && !rooms.some(([id, room]) => room.lightsOn && !lampHolder(sim, id))) return 'the only lamps left are ones the crew will not sit without';
      if (cmd.on && lightsNeedPower(sim)) return 'no spare power for more lights';
      return null;
    },
    apply(sim, cmd) {
      let changed = 0;
      for (const { id } of sim.layout.rooms) {
        const room = sim.state.rooms[id];
        if (room.jettisoned || room.lightsOn === cmd.on) continue;
        if (cmd.on && lightsNeedPower(sim)) break;
        if (!cmd.on && lampHolder(sim, id)) continue;
        room.lightsOn = cmd.on;
        changed += 1;
        sim.events.emit('room.lights', { room: id, on: cmd.on, reason: 'all', tick: sim.state.tick });
      }
      if (changed) sim.events.emit('lights.all', { on: cmd.on, rooms: changed, tick: sim.state.tick });
    },
  },
  // Debug panel only (?debug=1): set room values directly, or jam and free a door.
  'debug.room': {
    check(sim, cmd) {
      if (!sim.state.rooms[cmd.room]) return `no room "${cmd.room}"`;
      if (sim.state.rooms[cmd.room].jettisoned) return 'that section is gone';
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
      if (sim.state.doors[cmd.door].sealed) return 'that section is gone';
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
  // The captain's answer to an order Margo is holding (judgement.js): carry it out anyway, or let it go.
  'captain.override': {
    check: (sim) => (sim.state.ai.objection ? null : 'Margo is not holding any order of yours'),
    apply(sim) {
      const held = takeObjection(sim);
      const command = { ...held.command, id: sim.state.nextCommandId++ };
      // The world may have moved on while they argued.
      const problem = COMMANDS[command.type].check(sim, command);
      if (problem) {
        sim.events.emit('command.dropped', { command, reason: problem, tick: sim.state.tick });
        return;
      }
      COMMANDS[command.type].apply(sim, command);
      sim.events.emit('command.applied', { command, tick: sim.state.tick });
      overrode(sim, held);
    },
  },
  'captain.standDown': {
    check: (sim) => (sim.state.ai.objection ? null : 'Margo is not holding any order of yours'),
    apply: (sim) => standDown(sim),
  },
  // Debug panel only: set Margo's trust, or give her refusals back.
  'debug.ai': {
    check(sim, cmd) {
      if (cmd.trust !== undefined && !(cmd.trust >= 0 && cmd.trust <= 100)) return 'trust must be between 0 and 100';
      if (cmd.refusals !== undefined && cmd.refusals !== 0) return 'refusals can only be reset to 0';
      return cmd.trust === undefined && cmd.refusals === undefined ? 'needs trust or refusals' : null;
    },
    apply(sim, cmd) {
      if (cmd.trust !== undefined) sim.state.ai.trust = cmd.trust;
      if (cmd.refusals !== undefined) sim.state.ai.refusals = 0;
    },
  },
  // Debug panel only: put a memory in someone's head, or (dread: 0.95) their nerves on edge.
  'debug.memory': {
    check(sim, cmd) {
      const member = sim.state.crew[cmd.crew];
      if (!member?.alive || member.owner !== 'player') return `no crew member "${cmd.crew}" of ours aboard`;
      if (cmd.dread !== undefined) return cmd.dread >= 0 && cmd.dread < 1 ? null : 'dread must be at least 0 and below 1';
      if (!MEMORY_TYPES.includes(cmd.memory)) return `memory must be one of ${MEMORY_TYPES.join(', ')}`;
      if (cmd.room !== undefined && !sim.state.rooms[cmd.room]) return `no room "${cmd.room}"`;
      return null;
    },
    apply(sim, cmd) {
      const member = sim.state.crew[cmd.crew];
      if (cmd.dread !== undefined) member.dread = cmd.dread;
      else remember(sim, member, cmd.memory, { room: cmd.room ?? member.room, who: cmd.who ?? 'Petrov' });
    },
  },
  ...POWER_COMMANDS,
  ...ATMOSPHERE_COMMANDS,
  ...CREW_COMMANDS,
  ...HOLD_COMMANDS,
  ...combatCommands(newShipState),
  ...sectorCommands(newShipState),
};

function stepDoors(sim) {
  const stride = TICK_SECONDS / (isPowered(sim, 'doors') ? DOOR_SECONDS : MANUAL_DOOR_SECONDS);
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
// Order matters: crew act on the world as it stood, then fire can break a system, so power is settled
// after the air and before anything reads it.
// In a fight the enemy ship then takes the same steps, and the shooting is settled once both ships are up to date.
// Nerves come after the lamps, so a lamp someone puts on is counted by the senses in the same tick.
const SHIP_SYSTEMS = [(ship) => stepCrew(ship, TICK_SECONDS), (ship) => stepHold(ship, TICK_SECONDS), (ship) => stepAtmosphere(ship, TICK_SECONDS), stepPower, stepDoors, stepLights, (ship) => stepNerve(ship, TICK_SECONDS), (ship) => stepSenses(ship, TICK_SECONDS)];

function stepEnemy(sim) {
  const enemy = enemyOf(sim);
  if (!enemy) return;
  enemy.state.tick = sim.state.tick;
  for (const system of SHIP_SYSTEMS) system(enemy);
}

// The chart comes after the fight, so an escape decided this tick is flown before anyone hears about it.
const SYSTEMS = [...SHIP_SYSTEMS, stepEnemy, (sim) => stepCombat(sim, TICK_SECONDS), (sim) => stepSector(sim, TICK_SECONDS, newShipState), stepJudgement, stepVoice];

/**
 * Create a simulation.
 *   seed    the run seed
 *   ship    a ship layout item from content/ships/
 *   crew    the starting roster: [{ id, name }], placed in the ship's crewStart rooms
 *   lines   the AI line library from content/ai-lines/ (she is silent without it)
 *   weapons the weapon items from content/weapons/
 *   ships   every ship item from content/ships/, so enemies can be brought alongside
 *   sector  a sector item from content/sectors/: the run's chart is drawn from it (S3.1). Without one there is no run
 *   run     options for the run: { pursuit: true | false } to fix whether the contract is followed
 */
export function createSim({ seed, ship, crew = [], lines = [], weapons = [], ships = [], sector = null, run = {} }) {
  const layout = buildLayout(ship);
  const weaponById = new Map(weapons.map((item) => [item.id, item]));
  const shipById = new Map(ships.map((item) => [item.id, item]));
  const layouts = new Map([[layout.id, layout]]);
  const catalog = {
    weapon(id) {
      const item = weaponById.get(id);
      if (!item) throw new Error(`Unknown weapon "${id}"`);
      return item;
    },
    hasWeapon: (id) => weaponById.has(id),
    layout(id) {
      if (!layouts.has(id)) {
        if (!shipById.has(id)) throw new Error(`Unknown ship "${id}"`);
        layouts.set(id, buildLayout(shipById.get(id)));
      }
      return layouts.get(id);
    },
    /** Ships that can be fought. */
    enemies: ships.filter((item) => item.enemy === true).map((item) => item.id),
  };
  for (const id of layout.weapons) catalog.weapon(id);
  const sim = {
    side: 'player',
    /** Content the sim looks things up in: weapons and other ships. Never changes during a run. */
    catalog,
    /** The ship's fixed shape: rooms, doors, vents. Never changes during a run. */
    layout,
    /** Everything the AI could say. Content, not state. */
    lines,
    state: {
      seed: String(seed),
      ship: layout.id,
      tick: 0,
      nextCommandId: 1,
      commands: [], // orders waiting for the next tick
      ...newShipState(layout, crew, 'player', catalog),
      fight: null, // the fight in progress, enemy ship and all (combat.js)
      money: START_MONEY, // spent on bribes for now; Stage 3 and 7 give it more uses
      cargo: [], // what we have been handed: { name, qty, from }; it also comes aboard as crates (hold.js). Goods become content in Stage 7
      intel: [], // things we have been told: { text, from, tick }
      ai: newVoiceState(),
      run: null, // the chart, fuel, jumps, deadline and pursuit (sector.js); set below when there is a sector
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
        // Margo reads every order on its way through, and may hold one (judgement.js).
        if (considerOrder(sim, command)) {
          sim.events.emit('command.held', { command, tick: state.tick });
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
  if (sector) sim.state.run = newRunState(sector, sim.rng.stream('map'), run);
  attachVoice(sim);
  attachJudgement(sim);
  attachMemory(sim);
  attachSector(sim);
  return sim;
}

/** Problems aboard one ship (the player's or the enemy's) that should never happen. */
function shipProblems(ship, foe) {
  const problems = [];
  const { state, layout } = ship;
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
  problems.push(...checkPowerInvariants(ship), ...checkAtmosphereInvariants(ship), ...checkCrewInvariants(ship), ...checkCombatInvariants(ship, foe), ...checkSenseInvariants(ship), ...checkHoldInvariants(ship), ...checkMemoryInvariants(ship));
  if (Object.keys(state.rooms).length !== layout.rooms.length) problems.push('room states do not match the layout');
  if (Object.keys(state.doors).length !== layout.doors.length) problems.push('door states do not match the layout');
  return problems;
}

/** Problems with a sim state that should never happen. Empty means healthy. */
export function checkInvariants(sim) {
  const problems = [];
  if (!Number.isInteger(sim.state.tick) || sim.state.tick < 0) problems.push(`tick is ${sim.state.tick}`);
  const enemy = enemyOf(sim);
  problems.push(...shipProblems(sim, enemy), ...checkVoiceInvariants(sim), ...checkJudgementInvariants(sim), ...checkFightInvariants(sim), ...checkBoardingInvariants(sim, enemy), ...checkRunInvariants(sim));
  if (enemy) problems.push(...shipProblems(enemy, sim).map((problem) => `enemy: ${problem}`));
  return problems;
}
