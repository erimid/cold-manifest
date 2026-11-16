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
// What counts as a memory, which bus events write one, and which orders are
// refused because of one are content (content/memories/ and content/refusals/, S3.3, D-110), written in
// the condition language. This file carries them out. A sim given no rules
// has a crew who remember nothing. S4.3 adds weights, opinions and decay;
// S4.5 widens refusal into mutiny.

import { fillText, isFresh, match, memoryMatching, memoryText, vars } from '../narrative/conditions.js';
import { crewEmit } from './atmosphere.js';
import { lightsNeedPower } from './power.js';
import { DARK_ROOM, lightIn } from './senses.js';

const TICKS = 20; // per second (DECISIONS D-002)

/** How many memories one person keeps. How long each kind lasts is in content/memories/. */
export const MEMORY_MAX = 8;
export { DARK_ROOM };
/**
 * Nerve in the dark. `seconds` alone in an unlit room fills dread from 0 to 1;
 * company slows it to `company` of that, a bad memory of the dark multiplies
 * it by `remembered`. In the light it drains in `calm` seconds. When it peaks
 * they light the lamp and hold it on for `hold` seconds.
 */
export const DREAD = Object.freeze({ seconds: 75, company: 0.4, remembered: 2, calm: 20, hold: 45 });

const isOurs = (ship, member) => (ship.side ?? 'player') === 'player' && member.owner === 'player';
const isDark = (r) => !r.jettisoned && lightIn(r) < DARK_ROOM;
const kinds = (ship) => ship.rules?.memory ?? {};

/** The kinds of memory this ship's crew can hold. */
export const memoryTypes = (ship) => Object.keys(kinds(ship));

/** Write something into a crew member's memory. The oldest go first when the log is full. */
export function remember(ship, member, type, { room = null, who = null } = {}) {
  if (!kinds(ship)[type]) throw new Error(`Unknown memory type "${type}"`);
  const entry = { type, tick: ship.state.tick, room, who, dark: room !== null && ship.state.rooms[room] ? isDark(ship.state.rooms[room]) : false };
  member.memories = member.memories.filter((old) => isFresh(ship, old));
  member.memories.push(entry);
  if (member.memories.length > MEMORY_MAX) member.memories.shift();
  return entry;
}

/** The newest memory of a kind that has not faded, and that `fits` if given. */
export function recall(ship, member, type, fits = () => true) {
  for (let i = member.memories.length - 1; i >= 0; i--) {
    const entry = member.memories[i];
    if ((type === null || entry.type === type) && isFresh(ship, entry) && fits(entry)) return entry;
  }
  return null;
}

/** Their newest bad memory of the dark: each kind of memory says whether it counts (its `shadow`). */
export const darkMemory = (ship, member) => memoryMatching({ shadow: true }, member, { sim: ship, vars: {} });

/** A memory in a few words, for the crew panel: "Okoro dying in Main hold". */
export const describeMemory = (ship, entry) => memoryText(ship, entry);

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
 * { rule, memory, reason } or null. The rules are content (content/refusals/),
 * tried in order; the reason is a whole sentence for the screen and names
 * what they remember (brief §8).
 */
export function refusalOf(ship, member, roomId) {
  if (!isOurs(ship, member) || member.room === roomId) return null;
  const r = ship.state.rooms[roomId];
  if (!r || r.jettisoned) return null;
  const reach = vars({ crew: ['crew', member.id], room: ['room', roomId] });
  for (const rule of ship.rules?.refusals ?? []) {
    const found = match(rule.when, { sim: ship, vars: reach });
    if (found) return { rule: rule.id, memory: found.memory?.value ?? null, reason: fillText(rule.reason, { sim: ship, vars: found }) };
  }
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
  const scare = darkMemory(ship, holder);
  return `${holder.name} wants the lamp on${scare ? `. Not after ${memoryText(ship, scare, 'shadow')}` : ''}`;
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
    if (!member.alive || member.owner !== 'player') continue;
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
    const lit = lightLamp(ship, member);
    crewEmit(ship, member, 'crew.spooked', { crew: member.id, room: member.room, lit, tick: ship.state.tick });
  }
}

/**
 * Write memories as things happen: each kind of memory lists the bus events that write it
 * (its `on`, content/memories/). Called once when the sim is created; everything it hears is
 * emitted inside a tick.
 */
export function attachMemory(sim) {
  const living = () => Object.values(sim.state.crew).filter((member) => member.alive && member.owner === 'player');
  const nameOf = (id) => sim.state.crew[id]?.name ?? id;
  for (const [type, writers] of Object.entries(sim.rules?.writers ?? {})) {
    sim.events.on(type, (event) => {
      for (const writer of writers) {
        if (!match(writer.when, { sim, vars: vars({ event: ['data', event] }) })) continue;
        const subject = sim.state.crew[event.crew];
        const who = writer.to === 'subject' ? (subject?.alive ? [subject] : []) : living().filter((member) => writer.to === 'everyone' || (event.crewAll ?? []).includes(member.id));
        // Aboard their ship the room means nothing here; it is remembered as what happened, not a place.
        const room = (event.aboard === undefined || event.aboard === 'player') && sim.state.rooms[event.room] ? event.room : null;
        for (const member of who) remember(sim, member, writer.type, { room, who: writer.names ? nameOf(event.crew) : null });
      }
    });
  }
}

/** Memory problems that should never happen. */
export function checkMemoryInvariants(ship) {
  const problems = [];
  for (const [id, member] of Object.entries(ship.state.crew)) {
    if (!Array.isArray(member.memories) || member.memories.length > MEMORY_MAX) problems.push(`crew ${id} holds ${member.memories?.length} memories`);
    else if (ship.rules && member.memories.some((entry) => !ship.rules.memory[entry.type])) problems.push(`crew ${id} has a memory of an unknown kind`);
    if (!(member.dread >= 0 && member.dread < 1)) problems.push(`crew ${id} dread is ${member.dread}`);
  }
  return problems;
}
