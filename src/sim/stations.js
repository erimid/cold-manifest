// Stations (H.4, D-153, D-179, D-180). DOM-free.
//
// Crew time is the scarce thing aboard, not reactor bars. Every system has a
// station, and the system works at its station's RATING:
//
//   someone posted to it and on it   their skill: 0.8 for an untrained hand,
//                                    and 0.2 more for each level of the
//                                    station's skill (less when they are tired)
//   nobody on it                     Margo runs it (H.5, D-187 to D-192): 1.0 by
//                                    the book while her core is up, less when
//                                    she has more jobs than attention, and
//                                    times the manner she runs it in (quiet,
//                                    by the book, pushed)
//   dark                             0: stood down, wholly broken, gone, the
//                                    reactor dead, or nobody on it and no Margo
//                                    (her core down, or the station kept for
//                                    the crew)
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
//
// Margo (H.5). Each station has a `cover`: `fill` (she runs it when nobody
// is on it, the default), `hers` (handed to her: nobody is posted there and
// it comes first with her), or `crew` (kept for the crew: with nobody on it,
// it is dark). The captain may give a standing `order` for how she runs it
// (quiet, book, push); `runs` is how she actually runs it, which her own
// judgement, her trust in the captain and her picture of the scope decide
// (ai/margo.js). Her attention is MARGO.attention stations' worth, less for
// a damaged core: she gives it to what needs it most (crew first, then the
// route, guns last), and what is left over runs at MARGO.floor. A bare test
// sim's Margo (`ai.mind` 'book') has attention to spare and no way of her
// own: she runs everything by the book or as ordered, as H.4 did.
//
// Who holds what and how well is worked out once per stepStations into a
// table that the rest of the tick reads (DF-15): outside a step every read
// works it out afresh, so a test that moves someone by hand sees it at once.

import { LIFT_LOAD, POWERED, OUTPUT, OUTPUT_LEVELS, aiCoreStatus, live, liftRuns, litRooms, outputLimit, outputOf, reactorUp, setOutput, usable } from './power.js';
import { ROLES, skillOf } from './roles.js';
import { tiredness } from './watches.js';
import { chill } from './cold.js';

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
/**
 * Margo's attention (H.5, D-188): how many stations she can run at the book figure at once with a sound core,
 * what a station she has no attention left for runs at, and the share of her attention a wrecked core loses.
 */
export const MARGO = Object.freeze({ attention: 4, floor: 0.6, damage: 0.5 });
/** Her priorities when two jobs need her as much (her personality file: the crew first, then the route, the guns last). */
export const PRIORITY = Object.freeze(['life_support', 'medbay', 'helm', 'sensors', 'engines', 'doors', 'shields', 'weapons']);
/** How she can run a station (D-189): what it does to the rating, and to the heat and hum it gives off. */
export const MANNERS = Object.freeze({
  quiet: { name: 'Quiet', say: 'quiet', rating: 0.6, load: 0.5, blurb: 'Run low and cool: less done, less heat and hum for a scope to find.' },
  book: { name: 'Book', say: 'by the book', rating: 1, load: 1, blurb: 'By the book.' },
  push: { name: 'Push', say: 'pushed', rating: 1.25, load: 1.5, blurb: 'Run hot: more done, more heat and hum.' },
});
export const MANNER_IDS = Object.freeze(Object.keys(MANNERS));
/** Who runs a station when nobody is posted on it (D-187). */
export const COVERS = Object.freeze({
  fill: { name: 'Fill in', blurb: 'Margo runs it when nobody is on it.' },
  hers: { name: 'Hers', blurb: 'Handed to Margo: nobody is posted to it, and it comes first with her.' },
  crew: { name: 'Crew only', blurb: 'Margo keeps her hands off: with nobody on it, it is dark.' },
});
export const COVER_IDS = Object.freeze(Object.keys(COVERS));
/** Stations she can be told how to run: not the reactor, which is her own supply and runs to the reactor's output. */
export const MANNER_STATIONS = Object.freeze(PRIORITY);
/** An untrained hand's rating, and what each level of the station's skill adds. */
export const CREW_RATING = Object.freeze({ base: 0.8, perLevel: 0.2 });

/** The reactor's rated load is this many times its bars: with everything running at steady she is at about her limit. */
export const RATED = 1.25;

/** The starting state of the stations: which are stood down. */
export function newStationState(layout) {
  const down = new Set(layout.power.down ?? []);
  // cover: who runs it with nobody on it; order: the captain's standing order for how she runs it (null: her
  // own way); runs: how she is running it; why: her reason, when it is her own; against: running it her way
  // against the order.
  return Object.fromEntries(STATION_IDS.map((id) => [id, { down: down.has(id), by: null, cover: 'fill', order: null, runs: 'book', why: null, against: null }]));
}

/** The station a role is posted to at the start, or null. */
export const postOfRole = (role) => ROLES[role]?.station ?? null;

// ---------- reading ----------

/** The room a station is in, or undefined if the ship has none. */
export function roomOfStation(sim, id) {
  // Asked many times a tick, and a layout never changes: looked up once per layout.
  let rooms = STATION_ROOMS.get(sim.layout);
  if (!rooms) {
    rooms = {};
    for (const [key, station] of Object.entries(STATIONS)) rooms[key] = station.system ? sim.layout.roomOfSystem(station.system) : sim.layout.rooms.find((room) => room.kind === station.kind);
    STATION_ROOMS.set(sim.layout, rooms);
  }
  return rooms[id];
}
const STATION_ROOMS = new WeakMap();

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
  const kept = settled(sim);
  if (kept) return kept.operator[id] ?? null;
  const room = roomOfStation(sim, id);
  if (!room) return null;
  const { crew } = sim.state;
  for (const key in crew) {
    const member = crew[key];
    if (member.post === id && member.room === room.id && ready(member)) return member;
  }
  return null;
}

/** Is Margo there to run what nobody is on? */
export const margoUp = (sim) => live(sim, 'ai_core');

/** Who has a station: a crew member's id, 'margo', or null when it is dark. */
export function holderOf(sim, id) {
  const kept = settled(sim);
  if (kept) return kept.holder[id] ?? null;
  if (!stationLive(sim, id)) return null;
  if (id === 'ai_core') return 'margo';
  const operator = operatorOf(sim, id);
  if (operator) return operator.id;
  return margoUp(sim) && sim.state.stations[id].cover !== 'crew' ? 'margo' : null;
}

/** How well a station is being run right now: 0 when dark, 1 by the book. */
export function rating(sim, id) {
  const kept = settled(sim);
  if (kept) return kept.rating[id] ?? 0;
  // Worked out afresh: only a station Margo runs with a mind of her own needs the whole table (her attention).
  const by = holderOf(sim, id);
  if (by === null) return 0;
  const pace = outputOf(sim).pace;
  if (id === 'ai_core') return pace > 0 ? 1 : 0;
  if (by !== 'margo') return crewRating(sim.state.crew[by], STATIONS[id].skill) * chill(sim, sim.state.crew[by]) * pace;
  if (id === 'reactor') return MARGO_RATING * pace;
  if (sim.state.ai?.mind !== 'own') return MARGO_RATING * MANNERS[sim.state.stations[id].runs ?? 'book'].rating * pace;
  return buildTable(sim).rating[id] ?? 0;
}

/**
 * How hard her core is being knocked about, 0 to 1 (D-188): its broken bars, or a fire or a holed hull in the
 * room it sits in (the starting ship's core is a single bar: whole or dead, so the room is what tells).
 */
export function coreStrain(sim) {
  const room = sim.layout.roomOfSystem('ai_core');
  const r = room ? sim.state.rooms[room.id] : null;
  return Math.max(aiCoreStatus(sim).degradation, r ? r.fire : 0, r ? 1 - r.hull : 0);
}

/** How many stations' worth of attention Margo has (D-188): less as her core is knocked about; endless for a bare sim's Margo. */
export function margoAttention(sim) {
  if (sim.state.ai?.mind !== 'own') return Infinity;
  return MARGO.attention * (1 - MARGO.damage * Math.min(1, coreStrain(sim)));
}

/**
 * Margo's attention this moment: { attention, held (stations she runs), jobs (those that need her now),
 * share: { station: 0 to 1 of her attention } }.
 */
export function margoLoad(sim) {
  const t = table(sim);
  return {
    attention: t.attention,
    held: t.hers.length,
    share: t.share,
    // Counted only when asked: the table counts them only when she holds more than she can watch.
    get jobs() {
      return t.jobs ?? t.hers.filter((id) => needOf(sim, id) > 0).length;
    },
  };
}

/**
 * How much a station of hers needs her right now (D-188): 2 urgent, 1 in use, 0 idle. Read from the ship
 * as it is: she does not need to see a thing to know her own systems are working.
 */
export function needOf(sim, id) {
  const { state } = sim;
  switch (id) {
    case 'life_support': {
      for (const key in state.rooms) {
        const r = state.rooms[key];
        if (!r.jettisoned && (r.breach > 0 || r.oxygen < 0.8)) return 2;
      }
      return 1;
    }
    case 'medbay': {
      const room = roomOfStation(sim, 'medbay');
      for (const key in state.crew) {
        const member = state.crew[key];
        if (member.alive && member.room === room?.id && member.health < 1 && (member.owner ?? 'player') === 'player') return 2;
      }
      return 0;
    }
    case 'helm':
      return 1;
    case 'sensors':
      return state.scope?.contacts.some((contact) => contact.state !== 'lost') ? 2 : 1;
    case 'engines':
      // In use on a burn, or under way on a crossing, where the drive sets the pace (H.8: left at her floor, the
      // drive made a crossing she flew half as long again as one the crew flew).
      return state.helm?.burn || (state.run?.crossing?.phase === 'under way' && !state.run.crossing.stalled) ? 1 : 0;
    case 'doors':
      return state.boarding ? 2 : 1;
    case 'shields':
      return state.shield.charge < usable(sim, 'shields') ? 1 : 0;
    case 'weapons':
      return state.weapons.some((slot) => slot.target !== null || (slot.powered && slot.charge < sim.catalog.weapon(slot.id).charge)) ? 1 : 0;
    default:
      return 0;
  }
}

// The table of who holds each station and how well. Built at each stepStations and read until the next, so
// what comes early in a tick (the crew, the air) reads where things stood when the last tick settled. Any read
// outside a step builds it afresh (and does not keep it), so a test that moves someone by hand sees it at once.
// Kept on the sim itself (not its state, which is saved): `sim.stationTable`.
function settled(sim) {
  const kept = sim.stationTable;
  if (!kept) return null;
  if (kept.open) return kept.tick === sim.state.tick ? kept : null;
  return sim.stepping && kept.tick === sim.state.tick - 1 ? kept : null;
}
const table = (sim) => settled(sim) ?? buildTable(sim);

/** A step has ended (sim.js): the table stands for the start of the next step only. */
export function closeStationTable(sim) {
  if (sim.stationTable) sim.stationTable.open = false;
}

// One shape for every table's maps, so reading them stays quick.
const blank = (fill) => ({ helm: fill, reactor: fill, engines: fill, life_support: fill, sensors: fill, shields: fill, weapons: fill, doors: fill, medbay: fill, ai_core: fill });
if (Object.keys(blank(0)).join() !== STATION_IDS.join()) throw new Error('stations.js: blank() must list every station, in order');

/** The stations a layout has, each with its room, looked up once per layout. */
const PRESENT = new WeakMap();
function present(sim) {
  let list = PRESENT.get(sim.layout);
  if (!list) {
    list = STATION_IDS.map((id) => ({ id, room: roomOfStation(sim, id) ?? null, skill: STATIONS[id].skill, system: STATIONS[id].system ?? null }));
    PRESENT.set(sim.layout, list);
  }
  return list;
}

function buildTable(sim) {
  const { crew, stations, rooms } = sim.state;
  const pace = outputOf(sim).pace;
  const up = reactorUp(sim);
  const list = present(sim);
  const operator = blank(null);
  for (const key in crew) {
    const member = crew[key];
    if (!member.post || !ready(member)) continue;
    const room = roomOfStation(sim, member.post);
    if (room && member.room === room.id && !operator[member.post]) operator[member.post] = member;
  }
  const holder = blank(null);
  const value = blank(0);
  const share = {};
  const hers = [];
  const margo = live(sim, 'ai_core');
  for (const { id, room, skill, system } of list) {
    // stationLive, inlined: this runs twice a tick.
    if (system ? !live(sim, system) : !room || rooms[room.id].jettisoned || stations[id].down || !up) continue;
    if (id === 'ai_core') {
      holder[id] = 'margo';
      value[id] = pace > 0 ? 1 : 0;
      continue;
    }
    const member = operator[id];
    if (member) {
      holder[id] = member.id;
      value[id] = crewRating(member, skill) * chill(sim, member) * pace; // a cold hand is a slow one (F.2)
      continue;
    }
    if (!margo || stations[id].cover === 'crew') continue;
    holder[id] = 'margo';
    // The reactor is her own supply: she keeps it at its output and it costs her no attention.
    if (id === 'reactor') value[id] = MARGO_RATING * pace;
    else hers.push(id);
  }
  // With more of hers than she has attention for, it goes to what needs her most; among equals, to what was
  // handed to her, then by her priorities. With enough to go round the order makes no odds.
  const attention = margoAttention(sim);
  let jobs = null;
  if (hers.length > attention) {
    const need = {};
    jobs = 0;
    for (const id of hers) {
      need[id] = needOf(sim, id);
      if (need[id] > 0) jobs += 1;
    }
    hers.sort((x, y) => need[y] - need[x] || (stations[y].cover === 'hers') - (stations[x].cover === 'hers') || PRIORITY.indexOf(x) - PRIORITY.indexOf(y));
  }
  let left = attention;
  for (const id of hers) {
    const part = left >= 1 ? 1 : left > 0 ? left : 0;
    left -= 1;
    share[id] = part;
    value[id] = MARGO_RATING * MANNERS[stations[id].runs ?? 'book'].rating * (MARGO.floor + (1 - MARGO.floor) * part) * pace;
  }
  return { tick: sim.state.tick, operator, holder, rating: value, share, attention, jobs, hers };
}

/**
 * How much heat and hum a running station gives off, as a share of the book figure: what its manner makes of
 * it when Margo is running it, 1 for a hand on it, 0 when it is dark.
 */
export function loadOf(sim, id) {
  if (!running(sim, id)) return 0;
  return holderOf(sim, id) === 'margo' ? MANNERS[sim.state.stations[id]?.runs ?? 'book'].load : 1;
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
  for (const id of POWERED) load += STATIONS[id] ? loadOf(sim, id) : running(sim, id) ? 1 : 0;
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
    // Who runs a station with nobody on it (H.5, D-187): hand it to Margo, leave her to fill in, or keep it for the crew.
    'station.cover': {
      check(sim, cmd) {
        if (!POSTS.includes(cmd.station)) return STATIONS[cmd.station] ? 'the AI core is Margo already' : `no station "${cmd.station}"`;
        if (!COVERS[cmd.cover]) return `cover must be one of ${COVER_IDS.join(', ')}`;
        if (sim.state.stations[cmd.station].cover === cmd.cover) return `it is ${COVERS[cmd.cover].name.toLowerCase()} already`;
        if (cmd.station === 'reactor' && cmd.cover === 'crew') return 'Margo will not leave her own supply untended';
        return null;
      },
      apply(sim, cmd) {
        // Handed to her, nobody holds the post: whoever did stays where they are, with no post, until told otherwise.
        if (cmd.cover === 'hers') {
          for (const member of Object.values(sim.state.crew)) {
            if (member.post !== cmd.station || (member.owner ?? 'player') !== 'player') continue;
            member.post = null;
            sim.events.emit('crew.posted', { crew: member.id, from: cmd.station, to: null, tick: sim.state.tick });
          }
        }
        setCover(sim, cmd.station, cmd.cover);
      },
    },
    // The captain's standing order for how Margo runs a station (H.5, D-189): quiet, book or push, or null to leave it to her.
    'station.order': {
      check(sim, cmd) {
        if (!MANNER_STATIONS.includes(cmd.station)) return STATIONS[cmd.station] ? 'Margo runs that one one way only' : `no station "${cmd.station}"`;
        if (cmd.manner !== null && !MANNERS[cmd.manner]) return `manner must be one of ${MANNER_IDS.join(', ')}, or null`;
        if (sim.state.stations[cmd.station].order === cmd.manner) return cmd.manner === null ? 'it is left to her already' : `that is her order already`;
        return null;
      },
      apply(sim, cmd) {
        const entry = sim.state.stations[cmd.station];
        const from = entry.order;
        entry.order = cmd.manner;
        // A Margo with no way of her own does as she is told at once; one with a mind of her own weighs it on the next tick (ai/margo.js).
        if (sim.state.ai?.mind !== 'own') entry.runs = cmd.manner ?? 'book';
        sim.events.emit('station.ordered', { station: cmd.station, from, to: cmd.manner, room: roomOfStation(sim, cmd.station)?.id, tick: sim.state.tick });
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
          // Posting someone to a station handed to Margo takes it back from her (H.5).
          if (sim.state.stations[cmd.station].cover === 'hers') setCover(sim, cmd.station, 'fill');
        }
        member.post = cmd.station;
        sim.events.emit('crew.posted', { crew: member.id, from, to: cmd.station, tick: sim.state.tick });
        if (cmd.station !== null) send(sim, member, roomOfStation(sim, cmd.station).id);
      },
    },
  };
}

function setCover(sim, id, cover) {
  const entry = sim.state.stations[id];
  const from = entry.cover;
  entry.cover = cover;
  sim.events.emit('station.cover', { station: id, from, to: cover, room: roomOfStation(sim, id)?.id, tick: sim.state.tick });
}

// ---------- each tick ----------

/** Note who has each station, and drop the reactor back from hard when nobody is on it. */
export function stepStations(sim) {
  if (sim.state.power.output === 'hard' && !operatorOf(sim, 'reactor')) setOutput(sim, 'steady', 'unmanned');
  // Settle who holds what for the rest of the tick (DF-15): everything after this reads the table.
  const built = buildTable(sim);
  built.open = true;
  sim.stationTable = built;
  for (const id of STATION_IDS) {
    const entry = sim.state.stations[id];
    const by = built.holder[id];
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
  for (const id of STATION_IDS) {
    const entry = sim.state.stations?.[id];
    if (!entry) continue;
    if (!COVERS[entry.cover]) problems.push(`station ${id} has cover "${entry.cover}"`);
    if (entry.order !== null && !MANNERS[entry.order]) problems.push(`station ${id} has the order "${entry.order}"`);
    if (!MANNERS[entry.runs]) problems.push(`station ${id} runs "${entry.runs}"`);
    if (entry.cover === 'hers' && Object.values(sim.state.crew).some((member) => member.alive && member.post === id && (member.owner ?? 'player') === 'player')) problems.push(`station ${id} is handed to Margo and someone is posted to it`);
  }
  return problems;
}
