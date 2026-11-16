// Power and systems (brief §6). DOM-free.
//
// The reactor makes a pool of power bars. The player routes bars to systems at
// any time, paused or not. Lights draw from the same pool: every few lit rooms
// cost a bar. If the pool shrinks (reactor damage) below what is in use, the
// ship browns out and sheds load in a fixed order until it fits.
//
// Every system has:
//   level    how many bars it can take (bought at ports later)
//   damage   how many of those bars are broken, 0 to level
//   power    how many bars are routed to it now, 0 to level - damage
// For the reactor, `level` is its output in bars and `power` is always 0.

import { SYSTEMS, SYSTEM_IDS } from './systems.js';

/** Systems that take power, in the order the power panel shows them. */
export const POWERED = Object.freeze(['shields', 'engines', 'weapons', 'life_support', 'doors', 'sensors', 'medbay', 'ai_core']);

/** What a brownout switches off first. Life support goes last. */
export const SHED_ORDER = Object.freeze(['weapons', 'shields', 'sensors', 'medbay', 'engines', 'lights', 'doors', 'ai_core', 'life_support']);

/** Oxygen (0 to 1) a room regains per second for each bar on life support, and loses per second with none. */
export const O2_REFILL_PER_BAR = 1 / 60;
export const O2_STALE = 1 / 480;

const isCount = (v) => Number.isInteger(v) && v >= 0;

/** Problems with a ship's "power" block, as readable strings. */
export function validatePower(data) {
  const power = data.power;
  if (!power || typeof power !== 'object') return ['needs a "power" block: { reactor, lightsPerBar, systems }'];
  const problems = [];
  if (!Number.isInteger(power.reactor) || power.reactor < 1) problems.push('power.reactor must be a whole number of bars, at least 1');
  if (!Number.isInteger(power.lightsPerBar) || power.lightsPerBar < 1) problems.push('power.lightsPerBar must be a whole number of rooms, at least 1');
  const systems = power.systems ?? {};
  let routed = 0;
  for (const id of Object.keys(systems)) {
    if (!POWERED.includes(id)) problems.push(`power.systems: "${id}" is not a system that takes power`);
  }
  for (const id of POWERED) {
    const entry = systems[id];
    if (!entry) {
      problems.push(`power.systems is missing "${id}"`);
      continue;
    }
    if (!Number.isInteger(entry.level) || entry.level < 1) problems.push(`power.systems.${id}.level must be a whole number, at least 1`);
    else if (!isCount(entry.power) || entry.power > entry.level) problems.push(`power.systems.${id}.power must be between 0 and its level`);
    else routed += entry.power;
  }
  if (!problems.length && Array.isArray(data.rooms)) {
    const lights = Math.ceil(data.rooms.length / power.lightsPerBar);
    if (routed + lights > power.reactor) {
      problems.push(`the ship starts using ${routed + lights} bars (${routed} routed, ${lights} for lights) but the reactor makes ${power.reactor}`);
    }
  }
  return problems;
}

/** The starting `systems` state for a ship. */
export function newSystemsState(power) {
  const systems = {};
  for (const id of SYSTEM_IDS) {
    if (id === 'reactor') systems[id] = { level: power.reactor, damage: 0, power: 0 };
    else if (POWERED.includes(id)) systems[id] = { level: power.systems[id].level, damage: 0, power: power.systems[id].power };
    else systems[id] = { level: 1, damage: 0, power: 0 };
  }
  return systems;
}

// ---------- reading the power state ----------

/** Bars the reactor is making right now. */
export const supply = (sim) => sim.state.systems.reactor.level - sim.state.systems.reactor.damage;

export const litRooms = (sim) => Object.values(sim.state.rooms).filter((room) => room.lightsOn).length;

const barsForLights = (sim, rooms) => Math.ceil(rooms / sim.layout.power.lightsPerBar);

/** Bars the lights are drawing. */
export const lightsDraw = (sim) => barsForLights(sim, litRooms(sim));

/** Bars routed to systems. */
export const routed = (sim) => POWERED.reduce((sum, id) => sum + sim.state.systems[id].power, 0);

export const used = (sim) => routed(sim) + lightsDraw(sim);
export const free = (sim) => supply(sim) - used(sim);

/** Bars a system could take right now: its level less its damage. */
export const usable = (sim, id) => sim.state.systems[id].level - sim.state.systems[id].damage;

export const isPowered = (sim, id) => sim.state.systems[id].power > 0;

/**
 * How well the ship's AI is holding together (brief §9). A stub until Stage 5:
 * `degradation` runs from 0 (whole) to 1 (wrecked).
 */
export function aiCoreStatus(sim) {
  const core = sim.state.systems.ai_core;
  const degradation = core.damage / core.level;
  const state = core.power === 0 ? 'offline' : degradation === 0 ? 'nominal' : degradation < 0.67 ? 'degraded' : 'failing';
  return { state, degradation };
}

/** Would lighting one more room need a bar that is not there? */
export function lightsNeedPower(sim) {
  const lit = litRooms(sim);
  return barsForLights(sim, lit + 1) > barsForLights(sim, lit) && free(sim) < 1;
}

// ---------- orders ----------

function setPower(sim, id, to, reason) {
  const system = sim.state.systems[id];
  const from = system.power;
  if (from === to) return;
  system.power = to;
  sim.events.emit('power.changed', { system: id, from, to, reason, tick: sim.state.tick });
}

export const POWER_COMMANDS = {
  // Route one bar to a system (delta 1) or take one back (delta -1).
  'power.add': {
    check(sim, cmd) {
      if (!POWERED.includes(cmd.system)) return `"${cmd.system}" does not take power`;
      if (cmd.delta !== 1 && cmd.delta !== -1) return 'delta must be 1 or -1';
      const system = sim.state.systems[cmd.system];
      if (cmd.delta < 0) return system.power > 0 ? null : 'it has no power to take back';
      if (system.power >= system.level - system.damage) return system.damage > 0 ? 'the rest of it is damaged' : 'it is at full power';
      if (free(sim) < 1) return 'no spare power';
      return null;
    },
    apply(sim, cmd) {
      setPower(sim, cmd.system, sim.state.systems[cmd.system].power + cmd.delta, 'order');
    },
  },
  // Debug panel only: break or mend bars of a system.
  'debug.system': {
    check(sim, cmd) {
      const system = sim.state.systems[cmd.system];
      if (!system) return `no system "${cmd.system}"`;
      if (!isCount(cmd.damage) || cmd.damage > system.level) return `damage must be between 0 and ${system.level}`;
      return null;
    },
    apply(sim, cmd) {
      const system = sim.state.systems[cmd.system];
      const from = system.damage;
      if (from === cmd.damage) return;
      system.damage = cmd.damage;
      sim.events.emit('system.damage', { system: cmd.system, from, to: cmd.damage, tick: sim.state.tick });
    },
  },
};

// ---------- each tick ----------

/** Take one bar off the first thing in the shed order that has one. Returns false if nothing is left to shed. */
function shedOne(sim) {
  for (const id of SHED_ORDER) {
    if (id === 'lights') {
      const before = lightsDraw(sim);
      if (before === 0) continue;
      // Rooms go dark from the far end of the room list until a whole bar is saved.
      for (let i = sim.layout.rooms.length - 1; i >= 0 && lightsDraw(sim) === before; i--) {
        const roomId = sim.layout.rooms[i].id;
        const room = sim.state.rooms[roomId];
        if (!room.lightsOn) continue;
        room.lightsOn = false;
        sim.events.emit('room.lights', { room: roomId, on: false, reason: 'brownout', tick: sim.state.tick });
      }
      return true;
    }
    const system = sim.state.systems[id];
    if (system.power > 0) {
      setPower(sim, id, system.power - 1, 'brownout');
      return true;
    }
  }
  return false;
}

/** Keep power within what works and what the reactor makes. */
export function stepPower(sim) {
  for (const id of POWERED) {
    const limit = usable(sim, id);
    if (sim.state.systems[id].power > limit) setPower(sim, id, limit, 'damage');
  }
  let shed = 0;
  while (used(sim) > supply(sim) && shedOne(sim)) shed += 1;
  if (shed) sim.events.emit('power.brownout', { shed, supply: supply(sim), tick: sim.state.tick });
}

/** Life support tops the air up; without it the air slowly goes stale. Flow between rooms is S1.5. */
export function stepLifeSupport(sim, seconds) {
  const bars = sim.state.systems.life_support.power;
  const change = bars > 0 ? bars * O2_REFILL_PER_BAR * seconds : -O2_STALE * seconds;
  for (const room of Object.values(sim.state.rooms)) {
    const next = Math.max(0, Math.min(1, room.oxygen + change));
    if (next !== room.oxygen) room.oxygen = next;
  }
}

/** Power problems that should never happen. */
export function checkPowerInvariants(sim) {
  const problems = [];
  const { systems } = sim.state;
  for (const id of SYSTEM_IDS) {
    const system = systems[id];
    if (!system) {
      problems.push(`system ${id} has no state`);
      continue;
    }
    if (!Number.isInteger(system.level) || system.level < 1) problems.push(`${id}.level is ${system.level}`);
    if (!isCount(system.damage) || system.damage > system.level) problems.push(`${id}.damage is ${system.damage} of ${system.level}`);
    if (!isCount(system.power) || system.power > system.level - system.damage) problems.push(`${id}.power is ${system.power} with ${system.level - system.damage} usable`);
    if (!POWERED.includes(id) && system.power !== 0) problems.push(`${id} takes no power but has ${system.power}`);
  }
  if (!problems.length && used(sim) > supply(sim)) problems.push(`power in use (${used(sim)}) exceeds supply (${supply(sim)})`);
  return problems;
}

export const systemName = (id) => SYSTEMS[id].name;
