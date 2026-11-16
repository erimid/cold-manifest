// Crew memory, nerve, and the orders they will not take (S2.10, D-070; brief §8).
// DOM-free.
//
// Each of our crew keeps a short log of things that happened to them: a
// crewmate dying, their own burns, running out of air, a wound, a bad scare
// in the dark, the captain overriding Margo. A memory fades after a few
// minutes. While it lasts it can make them refuse an order to walk into a
// room, and the refusal names what they remember.
//
// The dark has a second price here (DF-41): standing in an unlit room wears
// on the nerves, faster alone and faster for anyone with a bad memory of the
// dark. When it gets too much they put the lamp on themselves, and for a
// while they will not have it switched off again.
//
// The memory types and the refusal rules are hard-coded until S3.3 moves
// them into the condition language; S4.3 adds weights, opinions and text
// templates from content, and S4.5 widens refusal into mutiny.

import { BREATHABLE_O2, crewEmit } from './atmosphere.js';
import { lightsNeedPower } from './power.js';
import { lightIn } from './senses.js';

const TICKS = 20; // per second (DECISIONS D-002)

/** How many memories one person keeps, and how many seconds each kind lasts. */
export const MEMORY_MAX = 8;
export const MEMORY_SECONDS = Object.freeze({ death: 300, burn: 240, choke: 240, wound: 240, scare: 300, override: 420 });
export const MEMORY_TYPES = Object.freeze(Object.keys(MEMORY_SECONDS));

/** Below this light a room is dark to stand in (the same line a dark walk uses, crew.js). A fire lights its own room. */
export const DARK_ROOM = 0.2;
/**
 * Nerve in the dark. `seconds` alone in an unlit room fills dread from 0 to 1;
 * company slows it to `company` of that, a bad memory of the dark multiplies
 * it by `remembered`. In the light it drains in `calm` seconds. When it peaks
 * they light the lamp and hold it on for `hold` seconds.
 */
export const DREAD = Object.freeze({ seconds: 75, company: 0.4, remembered: 2, calm: 20, hold: 45 });
/** What the refusal rules count as too much: a fire worth fearing, air too thin to work in, and danger nobody walks into on the captain's word alone. */
export const FEARED_FIRE = 0.2;
export const FEARED_AIR = 0.5;
export const RECKLESS_FIRE = 0.5;

const isOurs = (ship, member) => (ship.side ?? 'player') === 'player' && member.owner === 'player';
const isDark = (r) => !r.jettisoned && lightIn(r) < DARK_ROOM;
/** A room by its stencilled name, used bare the way the crew and Margo say it: "Fire in Engines." */
const the = (ship, roomId) => ship.layout.room(roomId)?.name ?? 'the ship';
const fresh = (ship, entry) => ship.state.tick - entry.tick < MEMORY_SECONDS[entry.type] * TICKS;

/** Write something into a crew member's memory. The oldest go first when the log is full. */
export function remember(ship, member, type, { room = null, who = null } = {}) {
  if (!MEMORY_SECONDS[type]) throw new Error(`Unknown memory type "${type}"`);
  const entry = { type, tick: ship.state.tick, room, who, dark: room !== null && ship.state.rooms[room] ? isDark(ship.state.rooms[room]) : false };
  member.memories = member.memories.filter((old) => fresh(ship, old));
  member.memories.push(entry);
  if (member.memories.length > MEMORY_MAX) member.memories.shift();
  return entry;
}

/** The newest memory of a kind that has not faded, and that `fits` if given. */
export function recall(ship, member, type, fits = () => true) {
  for (let i = member.memories.length - 1; i >= 0; i--) {
    const entry = member.memories[i];
    if ((type === null || entry.type === type) && fresh(ship, entry) && fits(entry)) return entry;
  }
  return null;
}

/** Their newest bad memory of the dark: a scare, or anything that happened to them in an unlit room. */
export const darkMemory = (ship, member) => recall(ship, member, null, (entry) => entry.type === 'scare' || (entry.dark && entry.type !== 'override'));

/** A memory in a few words, for the crew panel: "Okoro dying in Main hold". */
export function describeMemory(ship, entry) {
  const where = entry.room ? ` in ${the(ship, entry.room)}` : '';
  switch (entry.type) {
    case 'death':
      return `${entry.who ?? 'someone'} dying${entry.room ? where : ' aboard their ship'}`;
    case 'burn':
      return `burns${where}`;
    case 'choke':
      return `no air${where}`;
    case 'wound':
      return `a wound${where}`;
    case 'scare':
      return `the dark${where}`;
    default:
      return `the captain overriding Margo${where}`;
  }
}

/** What they hold on to most right now, for the crew panel, or null. */
export function topMemory(ship, member) {
  const entry = recall(ship, member, null);
  return entry ? describeMemory(ship, entry) : null;
}

/** A word for how someone's nerve is holding. */
export function nerveWord(member) {
  return member.dread >= 0.66 ? 'shaking' : member.dread >= 0.33 ? 'uneasy' : 'steady';
}

/**
 * Would this crew member refuse to walk into this room, and why? Returns
 * { rule, memory, reason } or null. The reason is a whole sentence for the
 * screen and names what they remember (brief §8).
 */
export function refusalOf(ship, member, roomId) {
  if (!isOurs(ship, member) || member.room === roomId || !member.memories.length) return null;
  const r = ship.state.rooms[roomId];
  if (!r || r.jettisoned) return null;
  const { name } = member;
  const room = the(ship, roomId);
  const dark = isDark(r);
  const others = Object.values(ship.state.crew).filter((other) => other !== member && other.alive && other.room === roomId);
  const foes = others.some((other) => other.owner !== member.owner);
  const friends = others.some((other) => other.owner === member.owner);
  const no = (rule, memory, reason) => ({ rule, memory, reason });

  // Where a crewmate died, while whatever is wrong in there is still wrong.
  const grave = recall(ship, member, 'death', (entry) => entry.room === roomId);
  if (grave && (r.fire > 0 || r.breach > 0 || r.oxygen < FEARED_AIR || dark || foes)) return no('grave', grave, `${name} won't go back into ${room}. Not after what happened to ${grave.who}.`);

  const burn = recall(ship, member, 'burn');
  if (burn && !member.suit && r.fire >= FEARED_FIRE) return no('burn', burn, `${name} won't walk into the fire in ${room} without a suit. Not after the burns from ${the(ship, burn.room)}.`);

  const choke = recall(ship, member, 'choke');
  if (choke && !member.suit && r.oxygen < FEARED_AIR) return no('choke', choke, `${name} won't go into ${room} without a suit. Not after running out of air in ${the(ship, choke.room)}.`);

  const shadow = darkMemory(ship, member);
  if (shadow && dark && !friends) {
    const after = shadow.type === 'death' ? `${shadow.who} died in the dark` : shadow.type === 'scare' ? `the dark in ${the(ship, shadow.room)}` : `getting hurt in the dark in ${the(ship, shadow.room)}`;
    return no('dark', shadow, `${name} won't go into ${room} alone in the dark. Not after ${after}.`);
  }

  const order = recall(ship, member, 'override');
  if (order && !member.suit && (r.fire >= RECKLESS_FIRE || r.oxygen < BREATHABLE_O2)) return no('override', order, `${name} won't walk into ${room} on the captain's word. Not after the captain overrode Margo over ${the(ship, order.room)}.`);

  return null;
}

/** Someone standing in this room who will not have its lamp switched off just now, or null. */
export function lampHolder(ship, roomId) {
  if ((ship.side ?? 'player') !== 'player') return null;
  return Object.values(ship.state.crew).find((member) => member.alive && member.owner === 'player' && member.room === roomId && !member.path.length && member.lampUntil > ship.state.tick) ?? null;
}

/** Why this room's lamp cannot be switched off, as a sentence, or null if it can. */
export function whyKeepLamp(ship, roomId) {
  const holder = lampHolder(ship, roomId);
  if (!holder) return null;
  const scare = recall(ship, holder, 'scare');
  return `${holder.name} wants the lamp on${scare ? `. Not after the dark in ${the(ship, scare.room)}` : ''}`;
}

/** Put the lamp on in the room they stand in, if there is power for it. */
function lightLamp(ship, member) {
  const r = ship.state.rooms[member.room];
  if (r.lightsOn || r.jettisoned || lightsNeedPower(ship)) return false;
  r.lightsOn = true;
  ship.events.emit('room.lights', { room: member.room, on: true, reason: 'crew', by: member.id, tick: ship.state.tick });
  crewEmit(ship, member, 'crew.lit', { crew: member.id, room: member.room, tick: ship.state.tick });
  return true;
}

/** One tick of nerves: dread builds in the dark and drains in the light. Our own ship only; their crews are not ours to fret over. */
export function stepNerve(ship, seconds) {
  if ((ship.side ?? 'player') !== 'player') return;
  const crew = Object.values(ship.state.crew);
  for (const member of crew) {
    if (!member.alive || member.owner !== 'player' || member.task === 'crossing') continue;
    const r = ship.state.rooms[member.room];
    if (!isDark(r)) {
      member.dread = Math.max(0, member.dread - seconds / DREAD.calm);
      continue;
    }
    if (member.path.length) continue; // on the move: no better, no worse
    if (member.lampUntil > ship.state.tick) {
      lightLamp(ship, member); // still rattled: the lamp goes on wherever they stop
      continue;
    }
    const company = crew.some((other) => other !== member && other.alive && other.owner === 'player' && other.room === member.room);
    member.dread += (seconds / DREAD.seconds) * (company ? DREAD.company : 1) * (darkMemory(ship, member) ? DREAD.remembered : 1);
    if (member.dread < 1) continue;
    member.dread = 0;
    member.lampUntil = ship.state.tick + DREAD.hold * TICKS;
    remember(ship, member, 'scare', { room: member.room });
    const lit = lightLamp(ship, member);
    crewEmit(ship, member, 'crew.spooked', { crew: member.id, room: member.room, lit, tick: ship.state.tick });
  }
}

/** Write memories as things happen. Called once when the sim is created; everything it hears is emitted inside a tick. */
export function attachMemory(sim) {
  const living = () => Object.values(sim.state.crew).filter((member) => member.alive && member.owner === 'player');
  const nameOf = (id) => sim.state.crew[id]?.name ?? id;
  sim.events.on('crew.died', (event) => {
    // Aboard their ship the room means nothing here; it is remembered as a death, not a place.
    const room = event.aboard === 'player' && sim.state.rooms[event.room] ? event.room : null;
    for (const member of living()) remember(sim, member, 'death', { room, who: nameOf(event.crew) });
  });
  sim.events.on('crew.hurt', (event) => {
    const member = sim.state.crew[event.crew];
    if (!member?.alive || event.aboard !== 'player') return;
    remember(sim, member, event.cause === 'fire' ? 'burn' : event.cause === 'suffocation' ? 'choke' : 'wound', { room: event.room });
  });
  sim.events.on('captain.overrode', (event) => {
    // Everyone remembers a monstrous order forced through, refused or only argued; a risky one stays with the people it was about.
    for (const member of living()) if (event.grave || event.crewAll.includes(member.id)) remember(sim, member, 'override', { room: event.room, who: nameOf(event.crew) });
  });
}

/** Memory problems that should never happen. */
export function checkMemoryInvariants(ship) {
  const problems = [];
  for (const [id, member] of Object.entries(ship.state.crew)) {
    if (!Array.isArray(member.memories) || member.memories.length > MEMORY_MAX) problems.push(`crew ${id} holds ${member.memories?.length} memories`);
    else if (member.memories.some((entry) => !MEMORY_SECONDS[entry.type])) problems.push(`crew ${id} has a memory of an unknown kind`);
    if (!(member.dread >= 0 && member.dread < 1)) problems.push(`crew ${id} dread is ${member.dread}`);
  }
  return problems;
}
