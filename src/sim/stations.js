// Stations (H.4, D-153, D-179, D-180). DOM-free.
//
// Crew time is the scarce thing aboard, not reactor bars. Every system has a
// station, and the system works at its station's RATING:
//
//   someone posted to it and on it   their skill: 0.8 for an untrained hand,
//                                    and 0.2 more for each level of the
//                                    station's skill (less when they are tired)
//   nobody on it                     Margo runs it by the book: 1.0, while her
//                                    core is up (H.5 gives her a mind of her own
//                                    about how)
//   dark                             0: stood down, wholly broken, gone, the
//                                    reactor dead, or nobody on it and no Margo
//
// The reactor's output (power.js) scales every rating: low slows the whole
// ship and hard hurries it.
//
// "On it" means standing in the station's room, posted there, awake and with
// nothing else to do: someone fighting a fire in their own station room, or
// carrying a crate through it, is not on the station. A post is an
// assignment (`member.post`); being sent somewhere else does not change it,
// and the station falls to Margo until they are back. Each crew member holds
// one post and each post one crew member, so six people cannot cover ten
// stations: who stands where is the game.
//
// The helm is a station with no system (the bridge); the AI core is a system
// nobody can be posted to (it is Margo, and it runs at 1 while it runs).

import { LIFT_LOAD, POWERED, OUTPUT, OUTPUT_LEVELS, live, liftRuns, litRooms, outputLimit, outputOf, reactorUp, setOutput, usable } from './power.js';
import { ROLES, skillOf } from './roles.js';
import { tiredness } from './watches.js';

export const STATIONS = Object.freeze({
  helm: { name: 'Helm', skill: 'piloting', kind: 'helm', blurb: 'Brings her round and takes the fix for a jump. A good pilot does both faster.' },
  reactor: { name: 'Reactor', system: 'reactor', skill: 'engineering', blurb: 'The reactor runs hard only with a hand on it. Margo keeps to the book.' },
  engines: { name: 'Engines', system: 'engines', skill: 'engineering', blurb: 'How hard the drive pushes when it burns.' },
  life_support: { name: 'Air plant', system: 'life_support', skill: 'engineering', blurb: 'How fast the air comes back.' },
  sensors: { name: 'Sensors', system: 'sensors', skill: 'piloting', blurb: 'How good the picture on the scope is.' },
  shields: { name: 'Shields', system: 'shields', skill: 'engineering', blurb: 'How fast the capacitor fills for a brace.' },
  weapons: { name: 'Guns', system: 'weapons', skill: 'weapons', blurb: 'How fast the gun and the turret come ready.' },
  doors: { name: 'Door control', system: 'doors', skill: 'combat', blurb: 'How fast the doors run. Dark, every door is worked by hand.' },
  medbay: { name: 'Medbay', system: 'medbay', skill: 'medicine', blurb: 'How fast the hurt mend.' },
  ai_core: { name: 'AI core', system: 'ai_core', skill: null, blurb: 'Margo. Stood down, she runs nothing and says nothing.' },
});
export const STATION_IDS = Object.freeze(Object.keys(STATIONS));
/** Stations someone can be posted to: all but Margo's own. */
export const POSTS = Object.freeze(STATION_IDS.filter((id) => STATIONS[id].skill));

/** Margo's rating on a station nobody is on: the book figure. */
export const MARGO_RATING = 1;
/** An untrained hand's rating, and what each level of the station's skill adds. */
export const CREW_RATING = Object.freeze({ base: 0.8, perLevel: 0.2 });

/** The reactor's rated load is this many times its bars: with everything running at steady she is at about her limit. */
export const RATED = 1.25;

/** The starting state of the stations: which are stood down. */
export function newStationState(layout) {
  const down = new Set(layout.power.down ?? []);
  return Object.fromEntries(STATION_IDS.map((id) => [id, { down: down.has(id), by: null }]));
}

/** The station a role is posted to at the start, or null. */
export const postOfRole = (role) => ROLES[role]?.station ?? null;

// ---------- reading ----------

/** The room a station is in, or undefined if the ship has none. */
export function roomOfStation(sim, id) {
  const station = STATIONS[id];
  if (!station) return undefined;
  return station.system ? sim.layout.roomOfSystem(station.system) : sim.layout.rooms.find((room) => room.kind === station.kind);
}

/** The station in a room, or null. */
export function stationOfRoom(sim, roomId) {
  const room = sim.layout.room(roomId);
  if (!room) return null;
  return STATION_IDS.find((id) => (STATIONS[id].system ? room.system === STATIONS[id].system : room.kind === STATIONS[id].kind)) ?? null;
}

/** Could this station run if someone ran it? */
export function stationLive(sim, id) {
  const station = STATIONS[id];
  if (!station) return false;
  if (station.system) return live(sim, station.system);
  const room = roomOfStation(sim, id);
  return Boolean(room) && !sim.state.rooms[room.id].jettisoned && !sim.state.stations[id].down && reactorUp(sim);
}

/** What a crew member is worth on a station that uses `skill`, tiredness and all. */
export const crewRating = (member, skill) => (CREW_RATING.base + CREW_RATING.perLevel * Math.max(0, Math.min(5, skillOf(member, skill)))) * tiredness(member);

/** Is this crew member standing ready where they are: ours, awake, in plain sight, hands free, nothing else to do? */
const ready = (member) => member.alive && (member.owner ?? 'player') === 'player' && !member.path.length && member.task === 'idle' && !member.asleep && !member.hidden && !member.job && !member.carry;

/** Who is on a station right now: the crew member posted to it and standing ready in its room, or null. */
export function operatorOf(sim, id) {
  if (!STATIONS[id]?.skill) return null;
  const room = roomOfStation(sim, id);
  if (!room) return null;
  for (const member of Object.values(sim.state.crew)) {
    if (member.post === id && member.room === room.id && ready(member)) return member;
  }
  return null;
}

/** Is Margo there to run what nobody is on? */
export const margoUp = (sim) => live(sim, 'ai_core');

/** Who has a station: a crew member's id, 'margo', or null when it is dark. */
export function holderOf(sim, id) {
  if (!stationLive(sim, id)) return null;
  if (id === 'ai_core') return 'margo';
  const operator = operatorOf(sim, id);
  if (operator) return operator.id;
  return margoUp(sim) ? 'margo' : null;
}

/** How well a station is being run right now: 0 when dark, 1 by the book. */
export function rating(sim, id) {
  if (!stationLive(sim, id)) return 0;
  const pace = outputOf(sim).pace;
  if (id === 'ai_core') return pace > 0 ? 1 : 0;
  const operator = operatorOf(sim, id);
  if (operator) return crewRating(operator, STATIONS[id].skill) * pace;
  return margoUp(sim) ? MARGO_RATING * pace : 0;
}

/** Is a station doing anything? */
export const running = (sim, id) => rating(sim, id) > 0;

/** The working bars of a system that is running (its shield layers, its air plant's size): 0 when its station is dark. */
export const bars = (sim, id) => (running(sim, id) ? usable(sim, id) : 0);

/** Who holds each post: { station: crew member }. */
export function postsHeld(sim) {
  const held = {};
  for (const member of Object.values(sim.state.crew)) if (member.alive && member.post && (member.owner ?? 'player') === 'player') held[member.post] = member;
  return held;
}

/**
 * The share of the reactor's rated load in use, 0 to 1: every running system,
 * the lift motor and the lamps, times how hard the reactor is being run. It is
 * the ship's heat on a scope (senses.js).
 */
export function reactorLoad(sim) {
  if (!reactorUp(sim)) return 0;
  let load = litRooms(sim) / sim.layout.power.lightsPerBar;
  for (const id of POWERED) if (running(sim, id)) load += 1;
  if (liftRuns(sim)) load += LIFT_LOAD;
  return Math.max(0, Math.min(1, (load / (sim.state.systems.reactor.level * RATED)) * outputOf(sim).heat));
}

// ---------- orders ----------

const ours = (sim, id) => {
  const member = sim.state.crew[id];
  return member?.alive && member.owner === 'player' ? null : `no crew member "${id}" of ours aboard`;
};

/** Commands that need crew.js (walking) are given their `send` when the sim is built (sim.js), to keep this file free of it. */
export function stationCommands({ send }) {
  return {
    // Stand a station down (dark: it does nothing, draws nothing and makes no noise) or stand it to.
    'station.stand': {
      check(sim, cmd) {
        const station = STATIONS[cmd.station];
        if (!station) return `no station "${cmd.station}"`;
        if (typeof cmd.down !== 'boolean') return 'needs down: true or false';
        if (station.system && sim.state.systems[station.system].absent) return 'this ship has no such system';
        if (station.system && sim.state.systems[station.system].lost) return 'that system went with its room';
        if (sim.state.stations[cmd.station].down === cmd.down) return cmd.down ? 'it is already stood down' : 'it is already stood to';
        if (!cmd.down && station.system && usable(sim, station.system) === 0) return 'every bar of it is damaged';
        if (!cmd.down && !reactorUp(sim)) return 'the reactor is dead';
        return null;
      },
      apply(sim, cmd) {
        sim.state.stations[cmd.station].down = cmd.down;
        sim.events.emit('station.stood', { station: cmd.station, system: STATIONS[cmd.station].system ?? null, down: cmd.down, tick: sim.state.tick });
      },
    },
    // The reactor's output. Hard needs a hand on the reactor and no damage to it.
    'power.output': {
      check(sim, cmd) {
        if (!OUTPUT[cmd.level]) return `output must be one of ${OUTPUT_LEVELS.join(', ')}`;
        if (cmd.level === sim.state.power.output) return `the reactor is already running ${cmd.level}`;
        const limit = outputLimit(sim);
        if (limit === null) return 'the reactor is dead';
        if (OUTPUT_LEVELS.indexOf(cmd.level) > OUTPUT_LEVELS.indexOf(limit)) return `the reactor's damage will not let it run ${cmd.level}`;
        if (cmd.level === 'hard' && !operatorOf(sim, 'reactor')) return 'running hard needs someone on the reactor station: Margo keeps to the book';
        return null;
      },
      apply(sim, cmd) {
        setOutput(sim, cmd.level, 'order');
      },
    },
    // Post someone to a station (or to none). They go there now; whoever held the post before loses it.
    'crew.post': {
      check(sim, cmd) {
        const problem = ours(sim, cmd.crew);
        if (problem) return problem;
        if (cmd.station === null) return sim.state.crew[cmd.crew].post === null ? 'they hold no post' : null;
        const station = STATIONS[cmd.station];
        if (!station) return `no station "${cmd.station}"`;
        if (!station.skill) return 'nobody is posted to the AI core: that is Margo';
        const room = roomOfStation(sim, cmd.station);
        if (!room || sim.state.rooms[room.id].jettisoned) return 'this ship has no such station';
        return null;
      },
      apply(sim, cmd) {
        const member = sim.state.crew[cmd.crew];
        const from = member.post;
        if (cmd.station !== null) {
          for (const other of Object.values(sim.state.crew)) if (other !== member && other.post === cmd.station && other.owner === 'player') other.post = null;
        }
        member.post = cmd.station;
        sim.events.emit('crew.posted', { crew: member.id, from, to: cmd.station, tick: sim.state.tick });
        if (cmd.station !== null) send(sim, member, roomOfStation(sim, cmd.station).id);
      },
    },
  };
}

// ---------- each tick ----------

/** Note who has each station, and drop the reactor back from hard when nobody is on it. */
export function stepStations(sim) {
  if (sim.state.power.output === 'hard' && !operatorOf(sim, 'reactor')) setOutput(sim, 'steady', 'unmanned');
  for (const id of STATION_IDS) {
    const entry = sim.state.stations[id];
    const by = holderOf(sim, id);
    if (by === entry.by) continue;
    const from = entry.by;
    entry.by = by;
    if (sim.state.tick <= 1) continue;
    sim.events.emit('station.changed', { station: id, from, to: by, tick: sim.state.tick });
    // Someone has left their station and Margo has picked it up: she says so (voice.js).
    if (by === 'margo' && from && from !== 'margo') sim.events.emit('station.taken', { station: id, crew: from, room: roomOfStation(sim, id)?.id, tick: sim.state.tick });
  }
}

/** Station problems that should never happen. */
export function checkStationInvariants(sim) {
  const problems = [];
  for (const id of STATION_IDS) {
    const entry = sim.state.stations?.[id];
    if (!entry || typeof entry.down !== 'boolean') problems.push(`station ${id} has no state`);
  }
  const seen = new Set();
  for (const member of Object.values(sim.state.crew)) {
    if (member.owner !== 'player') continue;
    if (member.post === null || member.post === undefined) continue;
    if (!POSTS.includes(member.post)) problems.push(`crew ${member.id} is posted to "${member.post}"`);
    else if (member.alive && seen.has(member.post)) problems.push(`two crew hold the post "${member.post}"`);
    if (member.alive) seen.add(member.post);
  }
  if (sim.state.power.output === 'hard' && !operatorOf(sim, 'reactor')) problems.push('the reactor runs hard with nobody on it');
  return problems;
}
