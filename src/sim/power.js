// The reactor and the few big switches (brief §6; H.4, D-153, D-181). DOM-free.
//
// Power is no longer routed by the bar. The reactor runs at one of three
// outputs, and everything that is switched on simply runs. What a system then
// does with its power is down to who is on its station (stations.js).
//
//   low     everything works slower, and the ship runs cool
//   steady  the book figure
//   hard    everything works faster, and she glows; it needs a hand on the
//           reactor station, and a reactor with no damage
//
// The switches are the lights (by room, by deck or all at once), the air,
// the engines, the lift motor and any other station stood down
// (stations.js). Each thing left running adds to the reactor's load, which is
// the ship's heat on a scope, and hums in its own room (senses.js).
//
// Reactor damage takes the outputs away from the top: any damage and she
// cannot run hard, half her bars gone and she only runs low, all of them and
// the ship is dark.
//
// Every system has:
//   level    how many bars of it there are (bought at ports later)
//   damage   how many of those bars are broken, 0 to level
// A system with every bar broken does nothing; one with some broken does less
// (fewer shield layers, a weaker air plant).

import { SYSTEMS, SYSTEM_IDS } from './systems.js';

/** Systems that draw on the reactor, in the order the switch panel shows them. */
export const POWERED = Object.freeze(['shields', 'engines', 'weapons', 'life_support', 'doors', 'sensors', 'medbay', 'ai_core']);

/** The reactor's outputs: how fast everything works at each, and how hot she runs. */
export const OUTPUT = Object.freeze({
  low: Object.freeze({ name: 'Low', pace: 0.8, heat: 0.6 }),
  steady: Object.freeze({ name: 'Steady', pace: 1, heat: 1 }),
  hard: Object.freeze({ name: 'Hard', pace: 1.15, heat: 1.4 }),
});
export const OUTPUT_LEVELS = Object.freeze(Object.keys(OUTPUT));
/** What the lift motor adds to the reactor's load while it is switched on, in the load of one system. */
export const LIFT_LOAD = 0.5;

const isCount = (v) => Number.isInteger(v) && v >= 0;

/** Problems with a ship's "power" block, as readable strings. */
export function validatePower(data) {
  const power = data.power;
  if (!power || typeof power !== 'object') return ['needs a "power" block: { reactor, lightsPerBar, systems, down }'];
  const problems = [];
  if (!Number.isInteger(power.reactor) || power.reactor < 1) problems.push('power.reactor must be a whole number of bars, at least 1');
  if (!Number.isInteger(power.lightsPerBar) || power.lightsPerBar < 1) problems.push('power.lightsPerBar must be a whole number of rooms, at least 1');
  const systems = power.systems ?? {};
  for (const id of Object.keys(systems)) {
    if (!POWERED.includes(id)) problems.push(`power.systems: "${id}" is not a system that takes power`);
  }
  const fitted = (id) => !Array.isArray(data.rooms) || data.rooms.some((room) => room?.system === id);
  for (const id of POWERED) {
    const entry = systems[id];
    if (!fitted(id)) {
      // A ship may leave a system out (ship.js), and then it has nothing to run.
      if (entry) problems.push(`power.systems lists "${id}" but no room holds it`);
      continue;
    }
    if (!entry) {
      problems.push(`power.systems is missing "${id}"`);
      continue;
    }
    if (!Number.isInteger(entry.level) || entry.level < 1) problems.push(`power.systems.${id}.level must be a whole number, at least 1`);
    if (entry.power !== undefined) problems.push(`power.systems.${id}.power: bars are no longer routed (H.4); list a system that starts stood down in power.down`);
  }
  if (power.down !== undefined) {
    if (!Array.isArray(power.down)) problems.push('power.down must be a list of systems that start stood down');
    else for (const id of power.down) if (!POWERED.includes(id)) problems.push(`power.down: "${id}" is not a system that takes power`);
  }
  if (power.output !== undefined && !OUTPUT_LEVELS.includes(power.output)) problems.push(`power.output must be one of ${OUTPUT_LEVELS.join(', ')}`);
  return problems;
}

/** The starting `systems` state for a ship. A system the ship was built without is marked `absent` and never runs. */
export function newSystemsState(layout) {
  const { power } = layout;
  const systems = {};
  for (const id of SYSTEM_IDS) {
    if (id === 'reactor') systems[id] = { level: power.reactor, damage: 0 };
    else if (!layout.hasSystem(id)) systems[id] = { level: 1, damage: 0, absent: true };
    else if (POWERED.includes(id)) systems[id] = { level: power.systems[id].level, damage: 0 };
    else systems[id] = { level: 1, damage: 0 };
  }
  return systems;
}

/** The starting state of the reactor's switches. */
export function newPowerState(layout) {
  return {
    output: layout.power.output ?? 'steady', // low | steady | hard
    lift: true, // the lift motor: off, the lifts are cranked by hand
  };
}

// ---------- reading the power state ----------

/** Bars of the reactor that still work. */
export const supply = (sim) => sim.state.systems.reactor.level - sim.state.systems.reactor.damage;
/** The reactor as a share of what it was built to make, 0 to 1. */
export const reactorHealth = (sim) => supply(sim) / sim.state.systems.reactor.level;
/** Is the reactor making anything at all? */
export const reactorUp = (sim) => supply(sim) > 0 && !sim.state.systems.reactor.lost;

export const litRooms = (sim) => Object.values(sim.state.rooms).filter((room) => room.lightsOn && !room.jettisoned).length;

/** Bars of a system that work: its level less its damage. */
export const usable = (sim, id) => sim.state.systems[id].level - sim.state.systems[id].damage;

/** The highest output the reactor can hold as it stands, or null when it is dead. */
export function outputLimit(sim) {
  if (!reactorUp(sim)) return null;
  const health = reactorHealth(sim);
  return health >= 1 ? 'hard' : health > 0.5 ? 'steady' : 'low';
}

/** The output the reactor is running at: { name, pace, heat }, or nothing at all when it is dead. */
const DEAD = Object.freeze({ name: 'Dead', pace: 0, heat: 0 });
export const outputOf = (sim) => (reactorUp(sim) ? OUTPUT[sim.state.power.output] : DEAD);

/**
 * Could this system run if someone ran it? It is fitted and still aboard, not
 * every bar of it is broken, it has not been stood down, and the reactor is up.
 */
export function live(sim, id) {
  const system = sim.state.systems[id];
  if (!system || system.absent || system.lost || system.stripped) return false;
  if (sim.state.stations?.[id]?.down) return false;
  return usable(sim, id) > 0 && reactorUp(sim);
}

/** Is the lift motor running? Off, or with the reactor dead, the lifts are cranked by hand. */
export const liftRuns = (sim) => sim.state.power.lift && reactorUp(sim);

/**
 * How well the ship's AI is holding together (brief §9). A stub until Stage 5:
 * `degradation` runs from 0 (whole) to 1 (wrecked).
 */
export function aiCoreStatus(sim) {
  const core = sim.state.systems.ai_core;
  const degradation = core.damage / core.level;
  const state = !live(sim, 'ai_core') ? 'offline' : degradation === 0 ? 'nominal' : degradation < 0.67 ? 'degraded' : 'failing';
  return { state, degradation };
}

/** Why a lamp cannot be lit right now, or null. */
export const whyNoLights = (sim) => (reactorUp(sim) ? null : 'the reactor is dead: there is nothing to light a lamp with');

// ---------- orders ----------

function setOutput(sim, to, reason) {
  const from = sim.state.power.output;
  if (from === to) return;
  sim.state.power.output = to;
  sim.events.emit('power.output', { from, to, reason, tick: sim.state.tick });
}
export { setOutput };

export const POWER_COMMANDS = {
  // The lift motor: off, the lifts are cranked by hand and the ship is a little cooler.
  'power.lift': {
    check(sim, cmd) {
      if (typeof cmd.on !== 'boolean') return 'needs on: true or false';
      if (cmd.on === sim.state.power.lift) return cmd.on ? 'the lift motor is already running' : 'the lift motor is already off';
      return null;
    },
    apply(sim, cmd) {
      sim.state.power.lift = cmd.on;
      sim.events.emit('power.lift', { on: cmd.on, tick: sim.state.tick });
    },
  },
  // Debug panel only: break or mend bars of a system.
  'debug.system': {
    check(sim, cmd) {
      const system = sim.state.systems[cmd.system];
      if (!system) return `no system "${cmd.system}"`;
      if (!isCount(cmd.damage) || cmd.damage > system.level) return `damage must be between 0 and ${system.level}`;
      if (system.lost) return 'that system went with its room';
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

/** Keep the reactor's output within what its damage allows; a dead reactor puts every lamp out. */
export function stepPower(sim) {
  const limit = outputLimit(sim);
  if (limit === null) {
    let out = 0;
    for (const { id } of sim.layout.rooms) {
      const room = sim.state.rooms[id];
      if (!room.lightsOn) continue;
      room.lightsOn = false;
      out += 1;
      sim.events.emit('room.lights', { room: id, on: false, reason: 'brownout', tick: sim.state.tick });
    }
    if (out) sim.events.emit('power.brownout', { dead: true, supply: 0, tick: sim.state.tick });
    return;
  }
  if (OUTPUT_LEVELS.indexOf(sim.state.power.output) > OUTPUT_LEVELS.indexOf(limit)) {
    setOutput(sim, limit, 'damage');
    sim.events.emit('power.brownout', { output: limit, supply: supply(sim), tick: sim.state.tick });
  }
}

/** Power problems that should never happen. */
export function checkPowerInvariants(sim) {
  const problems = [];
  const { systems, power } = sim.state;
  for (const id of SYSTEM_IDS) {
    const system = systems[id];
    if (!system) {
      problems.push(`system ${id} has no state`);
      continue;
    }
    if (!Number.isInteger(system.level) || system.level < 1) problems.push(`${id}.level is ${system.level}`);
    if (!isCount(system.damage) || system.damage > system.level) problems.push(`${id}.damage is ${system.damage} of ${system.level}`);
    if (system.power !== undefined) problems.push(`${id} carries routed bars (${system.power}): bars went in H.4`);
  }
  if (!OUTPUT_LEVELS.includes(power?.output)) problems.push(`the reactor's output is "${power?.output}"`);
  else {
    const limit = outputLimit(sim);
    if (limit && OUTPUT_LEVELS.indexOf(power.output) > OUTPUT_LEVELS.indexOf(limit)) problems.push(`the reactor runs ${power.output} but can only hold ${limit}`);
  }
  if (typeof power?.lift !== 'boolean') problems.push(`the lift switch is ${power?.lift}`);
  return problems;
}

export const systemName = (id) => SYSTEMS[id].name;
