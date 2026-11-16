// Transit events (S3.3, D-111; brief §15). DOM-free.
//
// An event is content (content/events/): something met on arriving at a point of the chart,
// with choices, and outcomes that change the world through effects (effects.js). Everything
// that decides whether an event, a choice or an outcome applies is written in the condition
// language (conditions.js).
//
//   {
//     "id": "derelict.cold-hull",
//     "title": "...", "text": "...",        text may name {place}, {hazard}, {ship} and the cast
//     "at": ["derelict"],                   the kinds of point it can be met at. Left out, the event
//                                           only ever follows another (the "event" effect) or the debug sheet
//     "weight": 1,                          how often, against the others that fit (default 1)
//     "once": true,                         met at most once a run (default true)
//     "priority": 0,                        on arriving, only the events of the highest priority that
//                                           fit are rolled between (default 0): an inspection (S3.4)
//                                           comes before anything else at a checkpoint
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
// The sim opens an event when we arrive somewhere for the first time (the sector says how
// likely, by kind of point) and keeps it in `run.events.open` until it is answered
// (`event.choose`) and put away (`event.dismiss`). Jumping away from an event leaves it behind.
// A sim given no events never opens one. A salvage claim (contracts.js) is an event too: standing at
// the claim point opens it, every time, until the claim is worked.

import { endFight } from '../sim/combat.js';
import { NODE_KINDS, nodeOf } from '../sim/sector.js';
import { checkCrewSpec, crewMatching, fillText, match, requirement, validateCondition, validateText, vars } from './conditions.js';
import { applyEffects, validateEffects } from './effects.js';

/** How likely arriving at each kind of point for the first time is to bring an event, unless the sector says otherwise. Ports open the port. */
export const EVENT_CHANCE = Object.freeze({ port: 0, empty: 0.35, hazard: 1, derelict: 1, checkpoint: 1 });

/** Names every event's text can use, beside its cast. */
const BUILTINS = Object.freeze({ place: 'text', hazard: 'text', ship: 'text' });

const rng = (sim) => sim.rng.stream('events');
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The events a sim can meet, by id. */
export function buildEvents(items = []) {
  return Object.freeze({ all: items, byId: new Map(items.map((item) => [item.id, item])) });
}

/** What a new run needs to keep about events (sector.js puts it in run.events). */
export function newEventState() {
  return {
    met: [], // ids of events opened this run
    rolled: [], // points where the dice for an event have been thrown
    open: null, // the event on the table: { id, node, cast: { name: crew id }, result: null | { choice, outcome, text } }
    next: null, // an event that follows the open one (the "event" effect)
    count: 0, // events opened this run
  };
}

/** The names in reach inside an open event: where we are, and its cast. */
function reachOf(sim, open) {
  const node = nodeOf(sim.state.run.map, open.node);
  return vars({
    place: ['text', node?.name ?? 'here'],
    hazard: ['text', (node?.hazard ?? 'the hazard').toLowerCase()],
    ship: ['text', sim.layout.name ?? 'the ship'],
    ...Object.fromEntries(Object.entries(open.cast).map(([name, id]) => [name, ['crew', id]])),
  });
}

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

/** Put an event on the table. `force` skips its own conditions (a follow-up, or the debug sheet). Returns true if it opened. */
export function openEvent(sim, id, { force = false } = {}) {
  const run = sim.state.run;
  const event = sim.transit.byId.get(id);
  if (!run || !event) return false;
  const cast = castFor(sim, event, run.at);
  if (!cast) return false;
  const open = { id, node: run.at, cast, result: null };
  if (!force && !match(event.when, { sim, vars: reachOf(sim, open) })) return false;
  if (run.events.open) sim.events.emit('event.lapsed', { event: run.events.open.id, tick: sim.state.tick });
  run.events.open = open;
  run.events.count += 1;
  if (!run.events.met.includes(id)) run.events.met.push(id);
  sim.events.emit('event.opened', { event: id, node: run.at, title: fillText(event.title, { sim, vars: reachOf(sim, open) }), tick: sim.state.tick });
  return true;
}

/** Arriving somewhere: maybe an event. The first visit to a point throws the dice once. */
function onArrival(sim, arrival) {
  const run = sim.state.run;
  const state = run.events;
  if (state.open) {
    // We left it behind.
    sim.events.emit('event.lapsed', { event: state.open.id, tick: sim.state.tick });
    state.open = null;
    state.next = null;
  }
  // The contract's claim comes before anything the dice would bring, and comes back until it is worked.
  const claim = run.contract?.status === 'active' ? run.contract.claim : null;
  if (claim && !claim.done && claim.node === arrival.node && openEvent(sim, claim.event, { force: true })) return;
  if (state.rolled.includes(arrival.node)) return;
  state.rolled.push(arrival.node);
  const chance = run.eventChance?.[arrival.kind] ?? EVENT_CHANCE[arrival.kind] ?? 0;
  if (!(chance > 0) || !rng(sim).chance(chance)) return;
  const fits = sim.transit.all.filter((event) => (event.at ?? []).includes(arrival.kind) && !(event.once !== false && state.met.includes(event.id)));
  // Highest priority first: the dice only fall between the events of one priority, and go down a priority when none of them can open.
  for (const priority of [...new Set(fits.map((event) => event.priority ?? 0))].sort((a, b) => b - a)) {
    const pool = fits.filter((event) => (event.priority ?? 0) === priority);
    while (pool.length) {
      const event = rng(sim).weighted(pool);
      if (openEvent(sim, event.id)) return;
      pool.splice(pool.indexOf(event), 1);
    }
  }
}

/** Listen for arrivals. Called once when the sim is created. */
export function attachEvents(sim) {
  if (!sim.transit.all.length) return;
  sim.events.on('sector.arrived', (arrival) => sim.state.run && onArrival(sim, arrival));
}

/** One choice of the open event as the screen needs it, or null if it is hidden. */
function choiceView(sim, open, choice) {
  const reach = reachOf(sim, open);
  const { met, tag } = requirement(choice.requires, { sim, vars: reach });
  if (!met && choice.hidden) return null;
  return { id: choice.id, label: fillText(choice.label, { sim, vars: reach }), tag, available: met };
}

/**
 * The event on the table, ready to show: { id, title, text, choices: [{ id, label, tag, available }], result }
 * where result is null until a choice is made, then { choice, text }. Null when no event is open.
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

/** Why a choice cannot be made right now, or null. */
export function whyNoChoice(sim, choiceId) {
  const open = sim.state.run?.events.open;
  const event = open && sim.transit.byId.get(open.id);
  if (!event) return 'no event is waiting for an answer';
  if (open.result) return 'that event has been answered';
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

function choose(sim, choiceId, newShipState) {
  const open = sim.state.run.events.open;
  const event = sim.transit.byId.get(open.id);
  const choice = event.choices.find((one) => one.id === choiceId);
  const reach = requirement(choice.requires, { sim, vars: reachOf(sim, open) }).vars;
  const picked = rng(sim).weighted(outcomesFor(sim, choice, reach), ({ outcome }) => outcome.weight ?? 1);
  const ctx = { sim, vars: picked.vars, newShipState, endFight };
  // The words are settled first, so they describe the world the choice was made in.
  const text = fillText(picked.outcome.text, ctx);
  open.result = { choice: choiceId, outcome: picked.index, text };
  sim.events.emit('event.chosen', { event: event.id, choice: choiceId, outcome: picked.index, text, tick: sim.state.tick });
  applyEffects(picked.outcome.effects, ctx);
}

export function eventCommands(newShipState) {
  return {
    // Answer the event on the table.
    'event.choose': {
      check: (sim, cmd) => whyNoChoice(sim, cmd.choice),
      apply: (sim, cmd) => choose(sim, cmd.choice, newShipState),
    },
    // Put an answered event away. If it leads on to another, that one opens.
    'event.dismiss': {
      check(sim) {
        const open = sim.state.run?.events.open;
        if (!open) return 'no event is open';
        return open.result ? null : 'the event is still waiting for an answer';
      },
      apply(sim) {
        const state = sim.state.run.events;
        const { id } = state.open;
        const next = state.next;
        state.open = null;
        state.next = null;
        sim.events.emit('event.closed', { event: id, tick: sim.state.tick });
        if (next) openEvent(sim, next, { force: true });
      },
    },
    // Debug panel only: put any event on the table, whatever its conditions say.
    'debug.event': {
      check(sim, cmd) {
        if (!sim.state.run) return 'there is no chart for this run';
        if (!sim.transit.byId.has(cmd.event)) return `no event "${cmd.event}"`;
        return null;
      },
      apply(sim, cmd) {
        sim.state.run.events.next = null;
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
  return problems;
}

// ---------- checking (the content checker and the tests) ----------

const NAME = /^[a-z][a-z0-9_]*$/;
const CHOICE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EVENT_KEYS = ['id', 'note', 'title', 'text', 'at', 'weight', 'once', 'priority', 'cast', 'when', 'choices'];
const CHOICE_KEYS = ['id', 'label', 'requires', 'hidden', 'outcomes'];
const OUTCOME_KEYS = ['when', 'weight', 'fallback', 'text', 'effects'];
const unknown = (item, allowed, what) => Object.keys(item).filter((key) => !allowed.includes(key)).map((key) => `${what}: unknown key "${key}"`);
const weightProblem = (value, what) => (value === undefined || (typeof value === 'number' && value > 0) ? [] : [`${what} must be a number above 0`]);

/** Check one content/events item. `refs` holds the ids that exist (see checkValue in conditions.js). Returns problems. */
export function checkEvent(item, refs = {}) {
  const problems = unknown(item, EVENT_KEYS, 'event');
  const reach = { ...BUILTINS };
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
    else if (BUILTINS[name]) problems.push(`cast: "${name}" is already the name of something every event has`);
    problems.push(...checkCrewSpec(spec, env(), `cast.${name}`, { cast: true }));
    reach[name] = 'crew';
  }

  const when = validateCondition(item.when, env(), 'when');
  problems.push(...when.problems); // what it binds stays inside it: people the text names are cast
  problems.push(...validateText(item.title, env(), 'title'), ...validateText(item.text, env(), 'text'));

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
  return ids;
}
