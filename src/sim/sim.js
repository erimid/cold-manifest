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
// Other ships are contacts on the scope (encounters.js), never a second ship
// stepped beside ours: a hauler hides, runs, lies, pays, or fires one gun to
// warn them off (combat.js), and boarders walk our own decks (boarders.js).

import { attachJudgement, checkJudgementInvariants, considerOrder, overrode, standDown, stepJudgement, takeObjection } from '../ai/judgement.js';
import { attachVoice, checkVoiceInvariants, newVoiceState, stepVoice } from '../ai/voice.js';
import { createEventBus } from '../engine/events.js';
import { createRngSet } from '../engine/rng.js';
import { EVENT_CHANCE, attachEvents, buildEvents, checkEventInvariants, eventCommands, newEventState } from '../narrative/events.js';
import { buildRules } from '../narrative/rules.js';
import { ATMOSPHERE_COMMANDS, checkAtmosphereInvariants, stepAtmosphere } from './atmosphere.js';
import { COMBAT_COMMANDS, START_MONEY, checkCombatInvariants, newCombatState, stepCombat } from './combat.js';
import { CREW_COMMANDS, checkCrewInvariants, newCrewState, stepCrew } from './crew.js';
import { POWER_COMMANDS, checkPowerInvariants, isPowered, lightsNeedPower, newSystemsState, stepPower } from './power.js';
import { checkSenseInvariants, newSenseState, stepSenses } from './senses.js';
import { HOLD_COMMANDS, checkHoldInvariants, newHoldState, stepHold } from './hold.js';
import { attachMemory, checkMemoryInvariants, lampHolder, memoryTypes, remember, stepNerve, whyKeepLamp } from './memory.js';
import { attachSector, checkRunInvariants, newRunState, sectorCommands, stepSector } from './sector.js';
import { CONTRACT_COMMANDS, attachContracts, checkContractInvariants, setUpContract } from './contracts.js';
import { PORT_COMMANDS } from './port.js';
import { ENCOUNTER_COMMANDS, attachEncounters, buildEncounters, checkEncounterInvariants, newHelmState, newScopeState, stepEncounters } from './encounters.js';
import { BOARDING_COMMANDS, checkBoarderInvariants, roomsOnDeck, stepBoarders } from './boarders.js';
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
    vent: false, // its emergency vent is open to space (H.2, boarders.js)
  };
}

function newDoorState() {
  return {
    state: 'closed', // open | closed | locked | jammed
    openness: 0, // 0 shut to 1 fully open; what crew, air and the creature actually meet
  };
}

/**
 * Everything that makes up our ship's state. `roster` is the crew aboard: [{ id, name }], `owner` whose
 * crew they are ('player'), and `catalog` where its weapons are looked up.
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
  // Every lamp on one deck (H.2): a deck the boarders are on goes dark, or comes back up as far as the power goes.
  'deck.lights': {
    check(sim, cmd) {
      const deck = sim.layout.decks.find((item) => item.id === cmd.deck);
      if (!deck) return `no deck "${cmd.deck}"`;
      if (typeof cmd.on !== 'boolean') return 'needs on: true or false';
      const rooms = roomsOnDeck(sim, deck);
      if (!rooms.some((id) => sim.state.rooms[id].lightsOn !== cmd.on)) return cmd.on ? 'every lamp on that deck is already on' : 'that deck is already dark';
      if (!rooms.some((id) => sim.state.rooms[id].lightsOn !== cmd.on && !COMMANDS['room.lights'].check(sim, { type: 'room.lights', room: id, on: cmd.on }))) return cmd.on ? 'no spare power for more lights' : 'the only lamps left on that deck are ones the crew will not sit without';
      return null;
    },
    apply(sim, cmd) {
      const deck = sim.layout.decks.find((item) => item.id === cmd.deck);
      let changed = 0;
      for (const id of roomsOnDeck(sim, deck)) {
        const order = { type: 'room.lights', room: id, on: cmd.on };
        if (sim.state.rooms[id].lightsOn === cmd.on || COMMANDS['room.lights'].check(sim, order)) continue;
        COMMANDS['room.lights'].apply(sim, order);
        changed += 1;
      }
      sim.events.emit('deck.lights', { deck: cmd.deck, on: cmd.on, rooms: changed, tick: sim.state.tick });
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
      if (!memoryTypes(sim).includes(cmd.memory)) return `memory must be one of ${memoryTypes(sim).join(', ')}`;
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
  ...COMBAT_COMMANDS,
  ...sectorCommands(),
  ...eventCommands(),
  ...CONTRACT_COMMANDS,
  ...PORT_COMMANDS,
  ...ENCOUNTER_COMMANDS,
  ...BOARDING_COMMANDS,
};

/** Every kind of order the sim accepts, for the content checker (a risk rule names the kind it is about). */
export const COMMAND_TYPES = Object.freeze(Object.keys(COMMANDS));

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
// Nerves come after the lamps, so a lamp someone puts on is counted by the senses in the same tick.
// The guns come after the ship: a round lands on the ship as it now stands.
// The scope comes after the chart: a jump clears it before any contact moves again.
// A boarding party (H.2) decides what to do next after the crew have moved, with the ship as it now stands.
const SYSTEMS = [(sim) => stepCrew(sim, TICK_SECONDS), (sim) => stepHold(sim, TICK_SECONDS), (sim) => stepAtmosphere(sim, TICK_SECONDS), stepPower, stepDoors, stepLights, (sim) => stepNerve(sim, TICK_SECONDS), (sim) => stepSenses(sim, TICK_SECONDS), (sim) => stepCombat(sim, TICK_SECONDS), (sim) => stepSector(sim, TICK_SECONDS), (sim) => stepEncounters(sim, TICK_SECONDS), (sim) => stepBoarders(sim, TICK_SECONDS), stepJudgement, stepVoice];

/**
 * Create a simulation.
 *   seed    the run seed
 *   ship    a ship layout item from content/ships/
 *   crew    the starting roster: [{ id, name }], placed in the ship's crewStart rooms
 *   lines   the AI line library from content/ai-lines/ (she is silent without it)
 *   weapons the weapon items from content/weapons/: what our mounts are, and what a contact fires at us
 *   sector  a sector item from content/sectors/: the run's chart is drawn from it (S3.1). Without one there is no run
 *   run     options for the run: { pursuit: true | false } to fix whether the contract is followed
 *   rules   { memories, refusals, risks }: the items of those content folders, what the crew remember and
 *           refuse and what Margo objects to (S3.3).
 *           Without them nobody remembers, refuses or objects
 *   events  the items from content/events/: what can be met on the chart (S3.3). Without them nothing is
 *   contract a contract template from content/contracts/ (S3.4): its cargo comes aboard, its advance is paid,
 *           and it is what the drop pays for. Needs a sector. Without one the run has no contract
 *   ports   the items from content/ports/: what a port's services cost (S3.4). Without them ports charge nothing
 *   encounters the items from content/encounters/ (H.1): the ships that can turn up on the scope. Without them
 *           nothing does, except through the debug command in tests that pass their own
 */
export function createSim({ seed, ship, crew = [], lines = [], weapons = [], sector = null, run = {}, rules = {}, events = [], contract = null, ports = [], encounters = [] }) {
  const layout = buildLayout(ship);
  const weaponById = new Map(weapons.map((item) => [item.id, item]));
  const catalog = {
    weapon(id) {
      const item = weaponById.get(id);
      if (!item) throw new Error(`Unknown weapon "${id}"`);
      return item;
    },
    hasWeapon: (id) => weaponById.has(id),
  };
  for (const id of layout.weapons) catalog.weapon(id);
  const sim = {
    side: 'player',
    /** Content the sim looks things up in: weapons. Never changes during a run. */
    catalog,
    /** The ship's fixed shape: rooms, doors, vents. Never changes during a run. */
    layout,
    /** Everything the AI could say. Content, not state. */
    lines,
    /** What the crew remember and refuse, and what Margo objects to. Content, not state. */
    rules: buildRules(rules),
    /** The transit events that can be met (`events` is the bus, so these go by another name). Content, not state. */
    transit: buildEvents(events),
    /** The contract this run carries (content/contracts/), or null. Its progress is state: run.contract. */
    contract,
    /** What ports charge (content/ports/). Content, not state. */
    ports,
    /** The ships that can turn up on the scope (content/encounters/). Content, not state. */
    encounters: buildEncounters(encounters),
    state: {
      seed: String(seed),
      ship: layout.id,
      tick: 0,
      nextCommandId: 1,
      commands: [], // orders waiting for the next tick
      ...newShipState(layout, crew, 'player', catalog),
      money: START_MONEY, // spent on bribes, fuel and repairs (port.js); the contract pays into it (contracts.js)
      reputation: {}, // standing with each faction by id, -10 to 10 (contracts.js); 0 when not there
      cargo: [], // what we have been handed: { name, qty, from }; it also comes aboard as crates (hold.js). Goods become content in Stage 7
      intel: [], // things we have been told: { text, from, tick }
      ai: newVoiceState(),
      helm: newHelmState(), // our heading, the drive and our velocity (encounters.js)
      scope: newScopeState(), // the contacts around us, and our decoys (encounters.js)
      boarding: null, // a party docked with us, at the lock or aboard (boarders.js)
      boardings: { next: 1, record: [] }, // how boardings have ended: { encounter, wants, outcome, reason, seconds, took, seized, tick }
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
  if (sector) {
    sim.state.run = newRunState(sector, sim.rng.stream('map'), contract?.slack ? { ...run, slack: contract.slack } : run);
    // What the events leave behind them (narrative/events.js, effects.js): the event on the table, notes for
    // later events, and the hooks for scenes (Stage 4) and the threat (Stage 6).
    Object.assign(sim.state.run, { events: newEventState(), eventChance: { ...EVENT_CHANCE, ...sector.events }, flags: {}, scenes: [], threat: null, contract: null, contactChance: { ...sector.contacts } });
    if (contract) setUpContract(sim, contract);
  } else if (contract) throw new Error('A contract needs a sector to be flown across');
  attachVoice(sim);
  attachJudgement(sim);
  attachMemory(sim);
  attachSector(sim);
  attachEvents(sim);
  attachContracts(sim);
  attachEncounters(sim);
  return sim;
}

/** Problems aboard our ship that should never happen. */
function shipProblems(ship) {
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
  problems.push(...checkPowerInvariants(ship), ...checkAtmosphereInvariants(ship), ...checkCrewInvariants(ship), ...checkCombatInvariants(ship), ...checkSenseInvariants(ship), ...checkHoldInvariants(ship), ...checkMemoryInvariants(ship));
  if (Object.keys(state.rooms).length !== layout.rooms.length) problems.push('room states do not match the layout');
  if (Object.keys(state.doors).length !== layout.doors.length) problems.push('door states do not match the layout');
  return problems;
}

/** Problems with a sim state that should never happen. Empty means healthy. */
export function checkInvariants(sim) {
  const problems = [];
  if (!Number.isInteger(sim.state.tick) || sim.state.tick < 0) problems.push(`tick is ${sim.state.tick}`);
  problems.push(...shipProblems(sim), ...checkVoiceInvariants(sim), ...checkJudgementInvariants(sim), ...checkRunInvariants(sim), ...checkEventInvariants(sim), ...checkContractInvariants(sim), ...checkEncounterInvariants(sim), ...checkBoarderInvariants(sim));
  return problems;
}
