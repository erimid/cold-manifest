// Transit events (S3.3, D-111; brief §15). DOM-free.
//
// An event is content (content/events/): something met on the lane to a point of the chart (H.6),
// with choices, and outcomes that change the world through effects (effects.js). Everything
// that decides whether an event, a choice or an outcome applies is written in the condition
// language (conditions.js).
//
//   {
//     "id": "derelict.cold-hull",
//     "title": "...", "text": "...",        text may name {place}, {hazard}, {ship} and the cast
//     "at": ["derelict"],                   the kinds of point it can be met on the way to. Left out, the event
//                                           only ever follows another (the "event" effect) or the debug sheet
//     "weight": 1,                          how often, against the others that fit (default 1)
//     "once": true,                         met at most once a run (default true)
//     "priority": 0,                        on a lane, only the events of the highest priority that
//                                           fit are rolled between (default 0): an inspection (S3.4)
//                                           comes before anything else at a checkpoint
//     "place": { "room": "cargo",            where it happens (H.7, D-156). A situation aboard waits in a room: a room
//                "scope": "Derelict",       id, the room of a system ("sensors"), a kind of room ("helm", "hold"),
//                "hold": true },            "airlock" (a room with a lock to space), "any", "$name" (where one of the
//                                           cast is), or a list of these, the first that is still there. `scope` also
//                                           marks it on the scope under that word; `hold` heaves the ship to while it
//                                           waits. "radio" instead is a decision made over the radio: the event view
//     "sign": "Something is dripping...",   a situation only: what is known before anyone is there (Margo says it)
//     "lapse": { "hours": 3, "text": "...", "effects": [ ... ] },
//                                           a situation only: what happens if nobody goes to it in that many hours
//     "cast": { "scout": { "pick": "random" } },
//                                           people the event is about: a crew filter each, cast in
//                                           order ("pick": "random" or "best"). Nobody fits: no event
//     "when": <condition>,                  sees the cast
//     "choices": [
//       { "id": "board", "label": "Send {scout} across",
//         "requires": <condition>,          what it takes. The choice shows a tag for it:
//                                           "[Ilse, Medicine]" when met, "[Needs Medicine 2]" when not
//         "hidden": true,                   not shown at all unless `requires` is met (default false)
//         "outcomes": [
//           { "when": <condition>,          sees the cast and whatever `requires` remembered
//             "weight": 1,                  the outcomes that fit are rolled between, by weight
//             "fallback": true,             only counted when no outcome that is not a fallback fits
//             "text": "...", "effects": [ ... ] } ] } ]
//   }
//
// On a crossing (sector.js, H.6), the first time a lane runs to a point the dice are thrown for
// an event (the sector says how likely, by kind of point); if one comes, it comes partway along
// that lane. A sim given no events never meets one. A salvage claim (contracts.js) is an event
// too: passing the claim point brings it, every time, until the claim is worked.
//
// Since H.7 (D-156) most events are situations aboard. A situation is put in a room of the ship
// (`run.events.aboard`) and waits there in ship time; the ship sails on unless it says `hold`.
// Margo says its `sign`. When one of ours is standing in that room it is attended: its text and
// its choices are offered on a card at the room, and the text and the conditions can name who is
// there ({who}, "$who") and the room ({room}, "$room"). `event.choose` and `event.dismiss` take
// its number as `situation`. Left alone for its `lapse` hours it lapses, and does what the lapse
// says. An answered card puts itself away after a while.
//
// A decision made over the radio ("place": "radio"; an event with no place is one too) is still
// one at a time on the table, `run.events.open`, in the event view with the ship hove to, until
// it is answered and put away. Jumping into a port leaves every event behind.

import { findRoute } from '../sim/crew.js';
import { NODE_KINDS, nodeOf } from '../sim/sector.js';
import { checkCrewSpec, crewMatching, fillText, match, requirement, validateCondition, validateText, vars } from './conditions.js';
import { applyEffects, validateEffects } from './effects.js';

/** How likely the first lane to each kind of point is to bring an event, unless the sector says otherwise. Ports open the port. */
export const EVENT_CHANCE = Object.freeze({ port: 0, empty: 0.35, hazard: 1, derelict: 1, checkpoint: 1 });

/** Names every event's text can use, beside its cast. */
const BUILTINS = Object.freeze({ place: 'text', hazard: 'text', ship: 'text' });
/** What a situation aboard can name as well: the room it is in, and (once someone is there) who has gone to it. */
const ABOARD = Object.freeze({ room: 'room', who: 'crew' });

/** A decision made over the radio: the event view, as before H.7. An event that says nothing of its place is one. */
export const RADIO = 'radio';
/** Words a place's `room` can use beside a room id, a system or a kind of room. */
export const ROOM_WORDS = Object.freeze(['any', 'airlock']);
/** Situations that can be waiting aboard at once: the lanes bring no more until one is dealt with. */
export const MAX_ABOARD = 2;
/** Seconds of ship time an answered card stays up before it puts itself away. */
export const RESULT_SECONDS = 40;

const rng = (sim) => sim.rng.stream('events');
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const SPACE = 'space';

/** Is this event a situation aboard (it has a room to wait in)? */
export const isAboard = (event) => isObject(event?.place);

/**
 * The rooms one word of a place's `room` can mean on a ship: `rooms` are { id, system, kind } and `doors`
 * { a, b }, as the ship file has them. A cast name ("$patient") is not for here: it is wherever they are.
 */
export function roomsFor(rooms, doors, spec) {
  if (spec === 'any') return rooms.filter((room) => !['lift', 'corridor'].includes(room.kind));
  if (spec === 'airlock') return rooms.filter((room) => doors.some((door) => door.b === SPACE && door.a === room.id));
  return rooms.filter((room) => room.id === spec || room.system === spec || (room.kind !== undefined && room.kind !== 'room' && room.kind === spec));
}

/** The events a sim can meet, by id. */
export function buildEvents(items = []) {
  return Object.freeze({ all: items, byId: new Map(items.map((item) => [item.id, item])) });
}

/** What a new run needs to keep about events (sector.js puts it in run.events). */
export function newEventState() {
  return {
    met: [], // ids of events opened this run
    rolled: [], // points where the dice for an event have been thrown
    open: null, // the radio decision on the table: { id, node, cast: { name: crew id }, result: null | { choice, outcome, text } }
    next: null, // an event that follows the open one (the "event" effect)
    // Situations aboard (H.7): { n, id, node, cast, room, by: crew id | null (who is there), hold, mark, left: hours
    // until it lapses | null, result: null | { choice, outcome, text, lapsed? }, shown: seconds answered, next }
    aboard: [],
    serial: 0, // the number of the last situation placed
    count: 0, // events opened this run
  };
}

/** The names in reach inside an open event: where we are, its cast, and for a situation its room and who is there. */
function reachOf(sim, open) {
  const node = nodeOf(sim.state.run.map, open.node);
  return vars({
    place: ['text', node?.name ?? 'here'],
    hazard: ['text', (node?.hazard ?? 'the hazard').toLowerCase()],
    ship: ['text', sim.layout.name ?? 'the ship'],
    ...(open.room ? { room: ['room', open.room] } : {}),
    ...(open.by && sim.state.crew[open.by] ? { who: ['crew', open.by] } : {}),
    ...Object.fromEntries(Object.entries(open.cast).map(([name, id]) => [name, ['crew', id]])),
  });
}

const liveRoom = (sim, id) => Boolean(sim.state.rooms[id]) && !sim.state.rooms[id].jettisoned;

/** The room a situation is put in: the first word of its place that still names a room of the ship, or null. */
function roomOfPlace(sim, event, cast) {
  for (const spec of [].concat(event.place.room)) {
    if (typeof spec !== 'string') continue;
    if (spec.startsWith('$')) {
      const room = sim.state.crew[cast[spec.slice(1)]]?.room;
      if (liveRoom(sim, room)) return room;
      continue;
    }
    const fit = roomsFor(sim.layout.rooms, sim.layout.doors, spec).filter((room) => liveRoom(sim, room.id));
    if (fit.length) return (fit.length === 1 ? fit[0] : rng(sim).pick(fit)).id;
  }
  return null;
}

/**
 * Our people standing in a room, awake and in plain sight: the ones who can deal with what is there. Never the
 * people it is about (`cast`: ids): the patient does not look in on their own cough, nor a fighter part the fight.
 */
function attendants(sim, room, cast = []) {
  return Object.values(sim.state.crew)
    .filter((member) => member.owner === 'player' && member.alive && !member.asleep && !member.hidden && member.room === room && member.task !== 'walking' && !cast.includes(member.id))
    .sort((a, b) => a.index - b.index);
}

/**
 * The hand to send to a room: one of ours, awake, in plain sight, with nothing in their arms and not already
 * walking somewhere. Somebody who is not holding a station before somebody who is (the helm is not left for a
 * drip in the hold while anyone else can go), then by the fewest doors on the way, then the first aboard.
 * `fit(member)` can rule people out. Null if nobody can go.
 */
export function nearestHand(sim, room, fit = () => true) {
  const posted = new Set(Object.values(sim.state.stations ?? {}).map((station) => station.by));
  let best = null;
  for (const member of Object.values(sim.state.crew).sort((a, b) => a.index - b.index)) {
    if (member.owner !== 'player' || !member.alive || member.asleep || member.hidden || member.job || member.carry || member.task === 'walking' || !sim.state.rooms[member.room] || !fit(member)) continue;
    const route = findRoute(sim, member.room, room, member);
    if (!route) continue;
    const cost = (posted.has(member.id) ? 1000 : 0) + route.length;
    if (!best || cost < best.cost) best = { member, cost };
  }
  return best?.member ?? null;
}

/** The situations aboard, in the order they came. */
export const aboard = (sim) => sim.state.run?.events?.aboard ?? [];
const findAboard = (sim, n) => aboard(sim).find((one) => one.n === n) ?? null;
/** Situations still waiting for an answer. */
export const waiting = (sim) => aboard(sim).filter((one) => !one.result);
/** Is the ship hove to by a situation (a hull alongside)? */
export const heldBySituation = (sim) => aboard(sim).some((one) => one.hold && !one.result);
/** Can the lanes bring another event right now? Not with a decision on the table, or the decks already busy. */
export const canMeet = (sim) => Boolean(sim.state.run?.events) && !sim.state.run.events.open && waiting(sim).length < MAX_ABOARD;

/** Cast an event's people, in order. Returns { name: crew id }, or null if somebody cannot be found. */
function castFor(sim, event, node) {
  const cast = {};
  for (const [name, spec] of Object.entries(event.cast ?? {})) {
    const { pick = 'best', ...filter } = spec;
    const fit = crewMatching(filter, { sim, vars: reachOf(sim, { node, cast }) });
    if (!fit.length) return null;
    cast[name] = (pick === 'random' ? rng(sim).pick(fit) : fit[0]).id;
  }
  return cast;
}

/**
 * Meet an event: a radio decision goes on the table, a situation into its room. `force` skips its own conditions
 * (a follow-up, or the debug sheet). `node` is the point it is about: the one we are passing on a crossing (H.6),
 * else where we are. Returns true if it opened.
 */
export function openEvent(sim, id, { force = false, node } = {}) {
  const run = sim.state.run;
  const event = sim.transit.byId.get(id);
  if (!run || !event) return false;
  const state = run.events;
  const at = node ?? state.open?.node ?? run.crossing?.path[run.crossing.leg + 1] ?? run.at;
  const cast = castFor(sim, event, at);
  if (!cast) return false;
  let open = { id, node: at, cast, result: null };
  if (isAboard(event)) {
    // Forced with its room gone (the debug sheet, a follow-up): anywhere that is still there.
    const room = roomOfPlace(sim, event, cast) ?? (force ? sim.layout.rooms.find((one) => liveRoom(sim, one.id))?.id : null);
    if (!room) return false;
    open = { n: state.serial + 1, ...open, room, by: null, hold: Boolean(event.place.hold), mark: event.place.scope ?? null, left: event.lapse?.hours ?? null, shown: 0, next: null };
  }
  if (!force && !match(event.when, { sim, vars: reachOf(sim, open) })) return false;
  const ctx = { sim, vars: reachOf(sim, open) };
  const title = fillText(event.title, ctx);
  if (isAboard(event)) {
    state.serial = open.n;
    state.aboard.push(open);
  } else {
    if (state.open) sim.events.emit('event.lapsed', { event: state.open.id, tick: sim.state.tick });
    state.open = open;
  }
  state.count += 1;
  if (!state.met.includes(id)) state.met.push(id);
  const where = isAboard(event) ? { situation: open.n, room: open.room, sign: fillText(event.sign ?? event.title, ctx), mark: open.mark, hold: open.hold } : {};
  sim.events.emit('event.opened', { event: id, node: at, title, ...where, tick: sim.state.tick });
  if (isAboard(event)) sim.events.emit('situation.placed', { situation: open.n, event: id, room: open.room, title, tick: sim.state.tick });
  return true;
}

/**
 * An event on the lane to a point we are about to pass (H.6; sector.js threw its dice when the lane began).
 * The highest priority first: the dice only fall between the events of one priority, and go down a priority
 * when none of them can open. With `aboard: true` only situations aboard can come (a lane's hourly chance,
 * H.8), never a decision over the radio. Returns true if one opened.
 */
export function rollLaneEvent(sim, nodeId, { aboard: only = false } = {}) {
  const run = sim.state.run;
  const state = run?.events;
  const node = run && nodeOf(run.map, nodeId);
  if (!state || !node || !canMeet(sim) || !sim.transit.all.length) return false;
  const here = new Set(state.aboard.map((one) => one.id));
  const fits = sim.transit.all.filter((event) => (event.at ?? []).includes(node.kind) && !here.has(event.id) && !(event.once !== false && state.met.includes(event.id)) && (!only || isAboard(event)));
  for (const priority of [...new Set(fits.map((event) => event.priority ?? 0))].sort((a, b) => b - a)) {
    const pool = fits.filter((event) => (event.priority ?? 0) === priority);
    while (pool.length) {
      const event = rng(sim).weighted(pool);
      if (openEvent(sim, event.id, { node: nodeId })) return true;
      pool.splice(pool.indexOf(event), 1);
    }
  }
  return false;
}

/** Events used to open on arriving at a point; since H.6 they come along the lanes (sector.js calls rollLaneEvent). */
export function attachEvents() {}

/** One choice of the open event as the screen needs it, or null if it is hidden. */
function choiceView(sim, open, choice) {
  const reach = reachOf(sim, open);
  const { met, tag } = requirement(choice.requires, { sim, vars: reach });
  if (!met && choice.hidden) return null;
  return { id: choice.id, label: fillText(choice.label, { sim, vars: reach }), tag, available: met };
}

/**
 * The radio decision on the table, ready to show: { id, title, text, choices: [{ id, label, tag, available }], result }
 * where result is null until a choice is made, then { choice, text }. Null when none is open.
 */
export function eventView(sim) {
  const open = sim.state.run?.events.open;
  const event = open && sim.transit.byId.get(open.id);
  if (!event) return null;
  const ctx = { sim, vars: reachOf(sim, open) };
  return {
    id: event.id,
    title: fillText(event.title, ctx),
    text: fillText(event.text, ctx),
    choices: event.choices.map((choice) => choiceView(sim, open, choice)).filter(Boolean),
    result: open.result ? { choice: open.result.choice, text: open.result.text } : null,
  };
}

/**
 * The situations aboard, ready to show at their rooms: [{ n, id, room, roomName, title, sign, mark, hold,
 * state: 'waiting' | 'attended' | 'answered', by (the name of who is there), text and choices (once
 * attended), result, left (hours until it lapses, or null) }].
 */
export function situationViews(sim) {
  return aboard(sim)
    .map((one) => {
      const event = sim.transit.byId.get(one.id);
      if (!event) return null;
      const ctx = { sim, vars: reachOf(sim, one) };
      const attended = Boolean(one.by && sim.state.crew[one.by]) && !one.result;
      return {
        n: one.n,
        id: event.id,
        room: one.room,
        roomName: sim.layout.room(one.room)?.name ?? 'the ship',
        title: fillText(event.title, ctx),
        sign: fillText(event.sign ?? event.title, ctx),
        mark: one.mark,
        hold: one.hold,
        about: Object.values(one.cast), // the people it is about: they cannot be the one sent to it
        state: one.result ? 'answered' : attended ? 'attended' : 'waiting',
        by: sim.state.crew[one.by]?.name ?? null,
        text: attended ? fillText(event.text, ctx) : null,
        choices: attended ? event.choices.map((choice) => choiceView(sim, one, choice)).filter(Boolean) : [],
        result: one.result ? { choice: one.result.choice, text: one.result.text, lapsed: Boolean(one.result.lapsed) } : null,
        left: one.left,
      };
    })
    .filter(Boolean);
}

/** The record an order is about: the situation it numbers, else the radio decision on the table. */
const recordFor = (sim, cmd) => (cmd.situation !== undefined ? findAboard(sim, cmd.situation) : (sim.state.run?.events.open ?? null));

/** Why a choice cannot be made right now, or null. `situation` is the number of a situation aboard; left out, the radio decision. */
export function whyNoChoice(sim, choiceId, situation) {
  const open = recordFor(sim, { situation });
  const event = open && sim.transit.byId.get(open.id);
  if (!event) return situation !== undefined ? `no situation ${situation} aboard` : 'no event is waiting for an answer';
  if (open.result) return situation !== undefined ? 'that has been dealt with' : 'that event has been answered';
  if (situation !== undefined && !sim.state.crew[open.by]?.alive) return `nobody is in ${sim.layout.room(open.room)?.name ?? 'that room'} to deal with it`;
  const choice = event.choices.find((one) => one.id === choiceId);
  if (!choice) return `the event has no choice "${choiceId}"`;
  return requirement(choice.requires, { sim, vars: reachOf(sim, open) }).met ? null : 'that choice is not open to us';
}

/** The outcomes of a choice that fit right now, each with the names it has in reach: [{ outcome, index, vars }]. */
function outcomesFor(sim, choice, reach) {
  const fit = [];
  choice.outcomes.forEach((outcome, index) => {
    const found = match(outcome.when, { sim, vars: reach });
    if (found) fit.push({ outcome, index, vars: found });
  });
  const first = fit.filter(({ outcome }) => !outcome.fallback);
  return first.length ? first : fit;
}

function choose(sim, open, choiceId) {
  const event = sim.transit.byId.get(open.id);
  const choice = event.choices.find((one) => one.id === choiceId);
  const reach = requirement(choice.requires, { sim, vars: reachOf(sim, open) }).vars;
  const picked = rng(sim).weighted(outcomesFor(sim, choice, reach), ({ outcome }) => outcome.weight ?? 1);
  const ctx = { sim, vars: picked.vars, open };
  // The words are settled first, so they describe the world the choice was made in.
  const text = fillText(picked.outcome.text, ctx);
  open.result = { choice: choiceId, outcome: picked.index, text };
  sim.events.emit('event.chosen', { event: event.id, choice: choiceId, outcome: picked.index, text, ...(open.n ? { situation: open.n, room: open.room, crew: open.by } : {}), tick: sim.state.tick });
  applyEffects(picked.outcome.effects, ctx);
}

/** Put an answered event away. If it leads on to another, that one opens. */
function putAway(sim, open) {
  const state = sim.state.run.events;
  const next = open.n ? open.next : state.next;
  if (open.n) state.aboard.splice(state.aboard.indexOf(open), 1);
  else {
    state.open = null;
    state.next = null;
  }
  sim.events.emit('event.closed', { event: open.id, ...(open.n ? { situation: open.n, room: open.room } : {}), tick: sim.state.tick });
  if (next) openEvent(sim, next, { force: true, node: open.node });
}

/** Nobody went: the situation does what its lapse says, and its card tells it; with nothing to tell, it is just gone. */
function lapse(sim, one) {
  const event = sim.transit.byId.get(one.id);
  const ctx = { sim, vars: reachOf(sim, one), open: one };
  const text = event?.lapse?.text ? fillText(event.lapse.text, ctx) : null;
  sim.events.emit('event.lapsed', { event: one.id, situation: one.n, room: one.room, text, tick: sim.state.tick });
  one.result = { choice: null, outcome: null, text: text ?? '', lapsed: true };
  applyEffects(event?.lapse?.effects, ctx);
  if (!text) putAway(sim, one); // nothing to read: gone at once, and whatever it leads on to comes
}

/** Leave every event behind (the jump into port): nothing of them carries on. */
export function leaveEvents(sim) {
  const state = sim.state.run?.events;
  if (!state) return;
  if (state.open && !state.open.result) sim.events.emit('event.lapsed', { event: state.open.id, tick: sim.state.tick });
  for (const one of state.aboard) if (!one.result) sim.events.emit('event.lapsed', { event: one.id, situation: one.n, room: one.room, text: null, tick: sim.state.tick });
  state.open = null;
  state.next = null;
  state.aboard = [];
}

/** Each tick: who is at each situation, the hours it will wait, and answered cards putting themselves away. */
export function stepSituations(sim, dt) {
  const run = sim.state.run;
  if (!run?.events?.aboard.length) return;
  const hours = dt / run.hour;
  for (const one of [...run.events.aboard]) {
    if (one.result) {
      one.shown += dt;
      if (one.shown >= RESULT_SECONDS) putAway(sim, one);
      continue;
    }
    if (!liveRoom(sim, one.room) || Object.values(one.cast).some((id) => !sim.state.crew[id])) {
      // The room went over the side, or one of the people it was about was taken off the ship: the matter went with them.
      sim.events.emit('event.lapsed', { event: one.id, situation: one.n, room: one.room, text: null, tick: sim.state.tick });
      run.events.aboard.splice(run.events.aboard.indexOf(one), 1);
      continue;
    }
    const there = attendants(sim, one.room, Object.values(one.cast));
    const by = there.find((member) => member.id === one.by) ?? there[0] ?? null;
    if ((by?.id ?? null) !== one.by) {
      one.by = by?.id ?? null;
      if (by) sim.events.emit('situation.attended', { situation: one.n, event: one.id, crew: by.id, room: one.room, tick: sim.state.tick });
    }
    // The wait is in ship hours, which only run under way; and it stops while somebody is at it.
    if (!one.by && one.left !== null && run.crossing) {
      one.left = Math.max(0, one.left - hours);
      if (one.left <= 0) lapse(sim, one);
    }
  }
}

export function eventCommands() {
  return {
    // Answer the radio decision on the table, or (`situation`: its number) a situation someone of ours is at.
    'event.choose': {
      check: (sim, cmd) => whyNoChoice(sim, cmd.choice, cmd.situation),
      apply: (sim, cmd) => choose(sim, recordFor(sim, cmd), cmd.choice),
    },
    // Put an answered event away. If it leads on to another, that one opens.
    'event.dismiss': {
      check(sim, cmd) {
        const open = recordFor(sim, cmd);
        if (!open) return cmd.situation !== undefined ? `no situation ${cmd.situation} aboard` : 'no event is open';
        return open.result ? null : 'the event is still waiting for an answer';
      },
      apply: (sim, cmd) => putAway(sim, recordFor(sim, cmd)),
    },
    // Debug panel only: meet any event, whatever its conditions say.
    'debug.event': {
      check(sim, cmd) {
        if (!sim.state.run) return 'there is no chart for this run';
        if (!sim.transit.byId.has(cmd.event)) return `no event "${cmd.event}"`;
        return null;
      },
      apply(sim, cmd) {
        if (!isAboard(sim.transit.byId.get(cmd.event))) sim.state.run.events.next = null;
        if (!openEvent(sim, cmd.event, { force: true })) sim.events.emit('event.uncast', { event: cmd.event, tick: sim.state.tick });
      },
    },
  };
}

/** Event problems that should never happen. */
export function checkEventInvariants(sim) {
  const state = sim.state.run?.events;
  if (!state) return [];
  const problems = [];
  if (state.open && !sim.transit.byId.has(state.open.id)) problems.push(`the open event "${state.open.id}" does not exist`);
  if (state.next && !state.open) problems.push('an event is queued to follow one that is not open');
  if (state.count < state.met.length) problems.push('more events met than opened');
  const seen = new Set();
  for (const one of state.aboard) {
    if (!sim.transit.byId.has(one.id)) problems.push(`the situation "${one.id}" does not exist`);
    if (!sim.state.rooms[one.room]) problems.push(`situation ${one.n} is in "${one.room}", which is not a room`);
    if (seen.has(one.n) || one.n > state.serial) problems.push(`situation number ${one.n} is used twice or was never given out`);
    seen.add(one.n);
    if (one.next && !one.result) problems.push(`situation ${one.n} leads on before it is answered`);
  }
  return problems;
}

// ---------- checking (the content checker and the tests) ----------

const NAME = /^[a-z][a-z0-9_]*$/;
const CHOICE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EVENT_KEYS = ['id', 'note', 'title', 'text', 'at', 'place', 'sign', 'lapse', 'weight', 'once', 'priority', 'cast', 'when', 'choices'];
const PLACE_KEYS = ['room', 'scope', 'hold'];
const LAPSE_KEYS = ['hours', 'text', 'effects'];
const CHOICE_KEYS = ['id', 'label', 'requires', 'hidden', 'outcomes'];
const OUTCOME_KEYS = ['when', 'weight', 'fallback', 'text', 'effects'];
const unknown = (item, allowed, what) => Object.keys(item).filter((key) => !allowed.includes(key)).map((key) => `${what}: unknown key "${key}"`);
const weightProblem = (value, what) => (value === undefined || (typeof value === 'number' && value > 0) ? [] : [`${what} must be a number above 0`]);

/**
 * Where an event says it happens (H.7): "radio", or a room of the ship for a situation. Every word of `room`
 * must name a room on every ship we can fly (`refs.ships`: the ship files), or one of the cast.
 */
function checkPlace(item, refs) {
  const { place } = item;
  if (place === undefined) return ['place: say where this happens: "radio" for a decision made over the radio, or { "room": ... } for a situation aboard'];
  if (place === RADIO) return [];
  if (!isObject(place)) return [`place must be "${RADIO}" or { "room": ... }`];
  const problems = unknown(place, PLACE_KEYS, 'place');
  const words = [].concat(place.room ?? []);
  if (!words.length) problems.push('place.room must be a room, a system, a kind of room, "airlock", "any", "$name" for where one of the cast is, or a list of these');
  let sure = false; // does some word always name a room?
  for (const word of words) {
    if (typeof word !== 'string' || !word) {
      problems.push('place.room: every entry must be text');
      continue;
    }
    if (word.startsWith('$')) {
      if (!isObject(item.cast) || !Object.hasOwn(item.cast, word.slice(1))) problems.push(`place.room: "${word}" is not one of the cast`);
      continue;
    }
    sure = true;
    for (const ship of refs.ships ?? []) {
      if (!roomsFor(ship.rooms ?? [], ship.doors ?? [], word).length) problems.push(`place.room: "${word}" is not a room, a system's room or a kind of room on the ship "${ship.id}"`);
    }
  }
  if (words.length && !sure && !problems.length) problems.push('place.room: add a room to fall back on, for when nobody of the cast is anywhere it could happen');
  if (place.scope !== undefined && (typeof place.scope !== 'string' || !place.scope.trim() || place.scope.length > 16)) problems.push('place.scope must be a word or two for the mark on the scope (16 letters at most)');
  if (place.hold !== undefined && typeof place.hold !== 'boolean') problems.push('place.hold must be true or false');
  return problems;
}

/** Check one content/events item. `refs` holds the ids that exist (see checkValue in conditions.js). Returns problems. */
export function checkEvent(item, refs = {}) {
  const problems = [...unknown(item, EVENT_KEYS, 'event'), ...checkPlace(item, refs)];
  const situation = isAboard(item);
  // A situation knows its room from the start; who has gone to it only once someone has (the text and the choices).
  const reach = { ...BUILTINS, ...(situation ? { room: ABOARD.room } : {}) };
  const env = () => ({ vars: { ...reach }, refs });

  if (item.at !== undefined) {
    if (!Array.isArray(item.at) || !item.at.length) problems.push('at must be a list of kinds of point, or be left out for an event that only follows another');
    else for (const kind of item.at) if (!NODE_KINDS[kind]) problems.push(`at: unknown kind of point "${kind}" (${Object.keys(NODE_KINDS).join(', ')})`);
  }
  problems.push(...weightProblem(item.weight, 'weight'));
  if (item.once !== undefined && typeof item.once !== 'boolean') problems.push('once must be true or false');
  if (item.priority !== undefined && !Number.isInteger(item.priority)) problems.push('priority must be a whole number');

  if (item.cast !== undefined && !isObject(item.cast)) problems.push('cast must be an object of name: crew filter');
  for (const [name, spec] of Object.entries(isObject(item.cast) ? item.cast : {})) {
    if (!NAME.test(name)) problems.push(`cast: "${name}" must be a short lowercase name`);
    else if (BUILTINS[name] || ABOARD[name]) problems.push(`cast: "${name}" is already the name of something an event has`);
    problems.push(...checkCrewSpec(spec, env(), `cast.${name}`, { cast: true }));
    reach[name] = 'crew';
  }

  const when = validateCondition(item.when, env(), 'when');
  problems.push(...when.problems); // what it binds stays inside it: people the text names are cast
  problems.push(...validateText(item.title, env(), 'title'));
  if (situation) {
    problems.push(...validateText(item.sign, env(), 'sign'));
    if (item.lapse !== undefined) {
      if (!isObject(item.lapse)) problems.push('lapse must be { "hours": ..., "text": ..., "effects": [ ... ] }');
      else {
        problems.push(...unknown(item.lapse, LAPSE_KEYS, 'lapse'));
        if (!(typeof item.lapse.hours === 'number' && item.lapse.hours > 0)) problems.push('lapse.hours must be a number of ship hours above 0');
        if (item.lapse.text !== undefined) problems.push(...validateText(item.lapse.text, env(), 'lapse.text'));
        problems.push(...validateEffects(item.lapse.effects, env(), 'lapse.effects'));
      }
    }
    reach.who = ABOARD.who;
  } else {
    if (item.sign !== undefined) problems.push('sign is for a situation aboard: a radio decision has only its text');
    if (item.lapse !== undefined) problems.push('lapse is for a situation aboard: a radio decision waits on the table');
  }
  problems.push(...validateText(item.text, env(), 'text'));

  if (!Array.isArray(item.choices) || !item.choices.length) return [...problems, 'choices must be a list with at least one choice'];
  const seen = new Set();
  item.choices.forEach((choice, i) => {
    const where = `choice ${isObject(choice) && typeof choice.id === 'string' ? `"${choice.id}"` : i + 1}`;
    if (!isObject(choice)) return problems.push(`${where} must be an object`);
    problems.push(...unknown(choice, CHOICE_KEYS, where));
    if (typeof choice.id !== 'string' || !CHOICE_ID.test(choice.id)) problems.push(`${where}: id must be lowercase letters and digits joined by -`);
    else if (seen.has(choice.id)) problems.push(`${where}: the event already has a choice with that id`);
    seen.add(choice.id);
    if (choice.hidden !== undefined && typeof choice.hidden !== 'boolean') problems.push(`${where}: hidden must be true or false`);
    const requires = validateCondition(choice.requires, env(), `${where}: requires`);
    problems.push(...requires.problems);
    // The label is shown whether or not the requirement is met, so it can only name what the event itself has.
    problems.push(...validateText(choice.label, env(), `${where}: label`));
    const inChoice = { vars: { ...reach, ...requires.binds }, refs };
    if (!Array.isArray(choice.outcomes) || !choice.outcomes.length) return problems.push(`${where}: outcomes must be a list with at least one outcome`);
    choice.outcomes.forEach((outcome, n) => {
      const at = `${where}, outcome ${n + 1}`;
      if (!isObject(outcome)) return problems.push(`${at} must be an object`);
      problems.push(...unknown(outcome, OUTCOME_KEYS, at), ...weightProblem(outcome.weight, `${at}: weight`));
      if (outcome.fallback !== undefined && typeof outcome.fallback !== 'boolean') problems.push(`${at}: fallback must be true or false`);
      const found = validateCondition(outcome.when, inChoice, `${at}: when`);
      const inOutcome = { vars: { ...inChoice.vars, ...found.binds }, refs };
      problems.push(...found.problems, ...validateText(outcome.text, inOutcome, `${at}: text`), ...validateEffects(outcome.effects, inOutcome, `${at}: effects`));
    });
    if (!choice.outcomes.some((outcome) => isObject(outcome) && outcome.when === undefined)) problems.push(`${where}: at least one outcome must have no "when", so the choice always leads somewhere`);
  });
  if (!item.choices.some((choice) => isObject(choice) && choice.requires === undefined)) problems.push('at least one choice must have no "requires", so the event can always be answered');
  return problems;
}

/** The events another event leads on to, for the checker: ids named by "event" effects. */
export function followUps(item) {
  const ids = [];
  for (const choice of Array.isArray(item.choices) ? item.choices : []) for (const outcome of Array.isArray(choice?.outcomes) ? choice.outcomes : []) for (const effect of Array.isArray(outcome?.effects) ? outcome.effects : []) if (effect?.do === 'event' && typeof effect.event === 'string') ids.push(effect.event);
  for (const effect of Array.isArray(item.lapse?.effects) ? item.lapse.effects : []) if (effect?.do === 'event' && typeof effect.event === 'string') ids.push(effect.event);
  return ids;
}
