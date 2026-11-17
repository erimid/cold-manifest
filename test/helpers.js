// Shared test setup: the real content, loaded the way the tools load it.

import { createContent } from '../src/engine/content.js';
import { newCrewMember } from '../src/sim/crew.js';
import { createSim } from '../src/sim/sim.js';
import { eventView, situationViews } from '../src/narrative/events.js';
import { spotIn } from '../src/sim/crew.js';
import { bestRoute, cheapestRoute, nodeOf } from '../src/sim/sector.js';
import { readContentFiles } from '../tools/lib/load-content.js';

export const content = createContent(readContentFiles());
export const SHIP = content.require('ships', 'margin-of-error');

/** What the crew remember and refuse and what Margo objects to (content/memories, refusals, risks). */
export const RULES = { memories: content.all('memories'), refusals: content.all('refusals'), risks: content.all('risks') };

/** The weapons, ships and rules the sim looks things up in. */
export const CATALOG = { weapons: content.all('weapons'), ships: content.all('ships'), rules: RULES };

/** The transit events. */
export const EVENTS = content.all('events');

/** The placeholder starting crew. */
export const CREW = content.all('crew').map(({ id, name, role, engineer, skills, traits }) => ({ id, name, role, engineer, skills, traits }));

/** A fresh sim on the starting ship with its six crew aboard. */
export const newCrewedSim = (seed = 'test') => createSim({ seed, ship: SHIP, crew: CREW, ...CATALOG });

/** The AI line library. */
export const LINES = content.all('ai-lines');

/** A crewed sim with the ship AI able to speak. */
export const newTalkingSim = (seed = 'test') => createSim({ seed, ship: SHIP, crew: CREW, lines: LINES, ...CATALOG });

/** Stand a new crew member in a room of a sim. */
export function putCrew(sim, id, room, extra = {}) {
  const member = Object.assign(newCrewMember(sim.layout, { id }, room, Object.keys(sim.state.crew).length), extra);
  sim.state.crew[id] = member;
  return member;
}

/** A fresh sim on the starting ship, with nobody aboard. */
export const newSim = (seed = 'test') => createSim({ seed, ship: SHIP, ...CATALOG });

/** A deep copy of the ship layout data, safe to break in tests. */
export const shipCopy = () => {
  const { _file, ...data } = SHIP;
  return structuredClone(data);
};

/** Plot a route (point ids from where we are to a port) and cast off. Throws with the reason if either is refused. */
export function castOff(sim, path) {
  for (const command of [{ type: 'route.plot', path }, { type: 'route.sail' }]) {
    const why = sim.whyNot(command);
    if (why) throw new Error(`${command.type}: ${why}`);
    sim.enqueue(command);
    sim.step();
  }
}

/** Answer an open event with the first choice open to us, and put it away. */
export function answerFirst(sim, view) {
  const choice = view.choices.find((one) => one.available);
  sim.enqueue({ type: 'event.choose', choice: choice.id });
  sim.step();
  sim.enqueue({ type: 'event.dismiss' });
}

/** Stand one of ours in a room on the spot, awake and idle: no walk (tests only). */
export function standIn(sim, id, room) {
  const member = sim.state.crew[id];
  const at = spotIn(sim.layout.room(room), member.index);
  Object.assign(member, { room, x: at.x, y: at.y, px: at.x, py: at.y, path: [], goal: null, task: 'idle', asleep: false, hidden: null });
}

/** A situation aboard as the cards show it, by number (H.7), or undefined. */
export const situation = (sim, n) => situationViews(sim).find((view) => view.n === n);

/**
 * Deal with a situation aboard (H.7): if nobody is at it, the last of ours is stood in its room for as long as
 * it takes and then put back where they were. `pick(view)` gives the choice (default: the first open to us);
 * `dismiss: false` leaves the answered card up. Returns the outcome's text.
 */
export function dealWith(sim, n, pick = (view) => view.choices.find((one) => one.available).id, { dismiss = true } = {}) {
  let back = null;
  if (situation(sim, n).state === 'waiting') {
    const about = situation(sim, n).about;
    const spare = Object.values(sim.state.crew).filter((member) => member.owner === 'player' && member.alive && !about.includes(member.id)).sort((a, b) => b.index - a.index)[0];
    const { room, x, y, px, py, path, goal, task, asleep, hidden } = spare;
    back = () => Object.assign(spare, { room, x, y, px, py, path, goal, task, asleep, hidden });
    standIn(sim, spare.id, situation(sim, n).room);
    sim.step();
  }
  sim.enqueue({ type: 'event.choose', situation: n, choice: pick(situation(sim, n)) });
  sim.step();
  const { text } = situation(sim, n).result;
  if (dismiss) {
    sim.enqueue({ type: 'event.dismiss', situation: n });
    sim.step();
  }
  back?.();
  return text;
}

/** Deal with every situation waiting aboard, each with the first choice open to us. Returns how many there were. */
export function dealWithAll(sim) {
  const open = situationViews(sim).filter((view) => !view.result);
  for (const view of open) dealWith(sim, view.n);
  return open.length;
}

/**
 * Fly the crossing under way to the end (H.6): skip along each lane to the next thing on it (`skip: false`
 * flies it in ship time), answer each radio decision with `answer(sim, view)` and deal with each situation aboard
 * (H.7) by its first open choice, then take the fix and jump into port.
 * Returns the sim's event types seen on the way. Throws if the crossing is still going after `limit` ticks.
 */
export function flyCrossing(sim, { answer = answerFirst, skip = true, limit = 40000 } = {}) {
  const seen = [];
  const stop = sim.events.on('*', (_, type) => seen.push(type));
  const run = sim.state.run;
  for (let i = 0; run.crossing && i < limit; i++) {
    const view = eventView(sim);
    if (view && !view.result) answer(sim, view);
    else if (view) sim.enqueue({ type: 'event.dismiss' });
    else if (dealWithAll(sim)) continue;
    else if (run.crossing.stalled) break;
    else if (run.crossing.phase === 'under way' && skip && !sim.whyNot({ type: 'debug.run', skip: true })) sim.enqueue({ type: 'debug.run', skip: true });
    else if (run.crossing.phase === 'off port' && !sim.whyNot({ type: 'route.jump' })) sim.enqueue({ type: 'route.jump' });
    else if (run.crossing.phase === 'off port' && skip) mendForRunIn(sim);
    sim.step();
  }
  stop();
  if (run.crossing && !run.crossing.stalled) throw new Error(`still crossing after ${limit} ticks: ${run.crossing.phase} on lane ${run.crossing.leg}`);
  return seen;
}

/** Plot, cast off and fly a route to its port. Returns the event types seen on the way. */
export function fly(sim, path, options) {
  castOff(sim, path);
  return flyCrossing(sim, options);
}

/**
 * A route from where we are that passes `via` (any point) and runs on to a port after it without crossing
 * itself, the one nearest the drop; or, if a port comes first on the way to `via`, the route to that port.
 * Returns a list of point ids.
 */
export function routeVia(run, via) {
  const there = cheapestRoute(run.map, run.at, via).path;
  const first = there.findIndex((id, i) => i > 0 && nodeOf(run.map, id).kind === 'port');
  if (first >= 0) return there.slice(0, first + 1);
  const ports = run.map.nodes.filter((node) => node.kind === 'port' && !there.includes(node.id));
  const ons = ports
    .map((port) => bestRoute(run.map, via, port.id, { ports: false }))
    .filter((on) => on.path && on.path.slice(1).every((id) => !there.includes(id)))
    .sort((a, b) => cheapestRoute(run.map, a.path.at(-1), run.map.delivery).fuel - cheapestRoute(run.map, b.path.at(-1), run.map.delivery).fuel || a.fuel - b.fuel);
  return [...there, ...ons[0].path.slice(1)];
}

/** Off a port with no way in: mend whatever the run in needs (the sensors, the drive, the bridge) and hand her the fix (debug). */
export function mendForRunIn(sim) {
  for (const system of ['sensors', 'engines', 'helm']) {
    const state = sim.state.systems[system];
    if (state && !state.lost && state.damage > 0) sim.enqueue({ type: 'debug.system', system, damage: 0 });
    if (sim.state.stations[system]?.down) sim.enqueue({ type: 'station.stand', station: system, down: false });
  }
  sim.enqueue({ type: 'debug.run', fix: true });
}

/** The quickest way from where we are to the nearest port we have the fuel for, never through another port. */
export function nearestPort(sim) {
  const { run } = sim.state;
  const routes = run.map.nodes.filter((node) => node.kind === 'port' && node.id !== run.at).map((node) => bestRoute(run.map, run.at, node.id, { by: 'hours', ports: false }));
  return routes.filter((route) => route.path && route.fuel <= run.fuel).sort((a, b) => a.hours - b.hours)[0].path;
}

/** Cast off for the nearest port and skip along the lanes until she is off it, ready for the run in. */
export function offPort(sim) {
  castOff(sim, nearestPort(sim));
  const run = sim.state.run;
  for (let i = 0; i < 200 && run.crossing.phase === 'under way'; i++) {
    if (run.events.open) answerFirst(sim, eventView(sim));
    else if (dealWithAll(sim)) continue;
    else sim.enqueue({ type: 'debug.run', skip: true });
    sim.step();
  }
  if (run.crossing.phase !== 'off port') throw new Error('never got off the port');
}
