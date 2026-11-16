// The sector chart and the crossings over it (S3.1, D-104; lanes and crossings since H.6, D-193 to D-199). DOM-free.
//
// A run crosses one sector: a band of space from an origin port to the port
// the cargo is going to, drawn on Margo's company route chart. The chart is a
// graph of 15 to 25 points (ports, open space, hazards, derelicts and
// checkpoints) in columns, joined by lanes. Every lane costs fuel (one, or two
// for a long one), is so many hours long on the ship clock, and holds a risk:
// a patrol lane by a checkpoint, a dead station by a derelict, bad space by a
// hazard, the quick line of an old company beacon, Union space, or nothing on
// the chart. The risk is what tends to turn up while we are on it.
//
// At a port the captain plots a route: a run of lanes to another port. Then
// the ship casts off and flies it as one continuous crossing in ship time.
// The points on the way are passed, not stopped at. The ship moves along the
// lanes at a pace set by the helm and the drive (stand the engines down to
// run quiet and she coasts); she heaves to while a ship is alongside, a party
// is aboard or a decision is on the table. At the end of the last lane she is
// off the port, and the run in is the one jump left (D-087): the sensors take
// a fix with someone at the helm, then she jumps in.
//
// The deadline is in ship hours, counted from the origin while under way.
//
// Some contracts are followed. The follower is a contact (encounters.js): a
// few hours after we set out it may find us on the scope, coming up from
// astern. Driven off by the gun it gives up; slipped any other way it picks
// the trail up again later.
//
// Everything here is generated from the 'map' RNG stream (the crossing's dice
// from 'voyage' and 'encounters') and kept in `sim.state.run`, so a run
// replays from its seed and saves with the rest.

import { THRUST, driveShare } from './senses.js';
import { hasPilot, strike, stepFix, whyNoJump } from './combat.js';
import { findContact, heldAlongside, liveContacts, SPAWN, spawnContact } from './encounters.js';
import { rating } from './stations.js';
import { aboard, canMeet, heldBySituation, leaveEvents, openEvent, rollLaneEvent } from '../narrative/events.js';

/** What a point on the chart can be, as the chart labels it. */
export const NODE_KINDS = Object.freeze({
  port: 'Port',
  empty: 'Open space',
  hazard: 'Hazard',
  derelict: 'Derelict',
  checkpoint: 'Checkpoint',
});

/** Fuel a lane costs: a short one, and a long one. */
export const LANE_FUEL = Object.freeze({ short: 1, long: 2 });

/** The kinds of `where` a lane risk can have (content/sectors/). */
export const RISK_WHERE = Object.freeze(['touches', 'beacon', 'union', 'default']);

/**
 * The crossing's pace: the share of a lane's hours an hour of ship time covers. With someone at the helm she
 * makes the drive's share of its push (THRUST of it run by the book is 1); with nobody at the helm, or the
 * drive stood down or broken, she coasts at COAST. A good engineer gets a little more, up to PACE_MAX.
 */
export const COAST = 0.35;
export const PACE_MAX = 1.4;
/** How much of a hazard lane's strikes a helm rated 1 sees coming, and the most any helm can. */
export const DODGE = Object.freeze({ perRating: 0.4, most: 0.8 });
/** The most contacts the lanes will put on the scope at once. */
export const MAX_LANE_CONTACTS = 2;
/** Where along its lane a passing point's event comes: between these shares of the lane. */
const EVENT_ALONG = Object.freeze([0.25, 0.75]);
/** How far out a follower turns up, in scope units, and how wide of dead astern. */
const PURSUER = Object.freeze({ range: 90, spread: 40, aware: 0.5 });

/** The most points a column in the middle of the chart may hold, and the fewest. */
const COLUMN_MIN = 2;
const COLUMN_MAX = 4;

// ---------- generating a sector ----------

const byY = (a, b) => a.y - b.y || a.id.localeCompare(b.id);
const laneKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/** How many points go in each middle column: `inner` points over `middle` columns, 2 to 4 each. */
function columnSizes(rng, inner, wantedMiddle) {
  const middle = Math.max(Math.ceil(inner / COLUMN_MAX), Math.min(Math.floor(inner / COLUMN_MIN), wantedMiddle));
  const sizes = new Array(middle).fill(COLUMN_MIN);
  let left = inner - COLUMN_MIN * middle;
  while (left > 0) {
    const open = sizes.map((n, i) => (n < COLUMN_MAX ? i : -1)).filter((i) => i >= 0);
    sizes[rng.pick(open)] += 1;
    left -= 1;
  }
  return sizes;
}

/** Do two lanes between the same pair of columns cross on the chart? */
function crosses(lanes, nodes, a, b) {
  const rank = (id) => nodes[id].rank;
  for (const lane of lanes) {
    if (lane.side) continue;
    const [p, q] = nodes[lane.a].col < nodes[lane.b].col ? [lane.a, lane.b] : [lane.b, lane.a];
    if (nodes[p].col !== nodes[a].col || nodes[q].col !== nodes[b].col) continue;
    if (p === a || q === b) continue;
    if ((rank(p) - rank(a)) * (rank(q) - rank(b)) < 0) return true;
  }
  return false;
}

/**
 * A new sector chart from a sector definition (content/sectors/) and an RNG.
 * Returns { id, name, nodes: [{ id, kind, name, col, rank, x, y, hazard?, role? }],
 * lanes: [{ a, b, fuel, hours, risk, hazard?, side? }], start, delivery, union: { side, depth } }. Points may carry
 * `beacon`. Always connected, by construction:
 * every point has a lane from the column before it and a lane to the column after.
 */
export function generateSector(def, rng) {
  const total = rng.between(def.nodes[0], def.nodes[1]);
  const columns = rng.between(def.columns[0], def.columns[1]);
  const sizes = [1, ...columnSizes(rng, total - 2, columns - 2), 1];
  const last = sizes.length - 1;
  const used = new Set();
  const designate = () => {
    for (;;) {
      const code = `${rng.pick(def.designations)}-${rng.between(100, 899)}`;
      if (!used.has(code)) {
        used.add(code);
        return code;
      }
    }
  };

  // Points, column by column, spread down the chart with a little drift.
  const cols = sizes.map((size, col) => {
    const points = [];
    for (let i = 0; i < size; i++) {
      const edge = col === 0 || col === last;
      const y = edge ? 0.5 + rng.range(-0.15, 0.15) : (i + 0.5 + rng.range(-0.3, 0.3)) / size;
      const x = col / last + (edge ? 0 : rng.range(-0.22, 0.22) / last);
      points.push({ col, x: Math.round(x * 1000) / 1000, y: Math.round(Math.min(0.96, Math.max(0.04, y)) * 1000) / 1000 });
    }
    return points.sort(byY);
  });
  const nodes = [];
  for (const points of cols) points.forEach((point, rank) => nodes.push({ id: `n${nodes.length + 1}`, ...point, rank }));
  const byId = Object.fromEntries(nodes.map((node) => [node.id, node]));
  const inCol = (col) => nodes.filter((node) => node.col === col);

  // Lanes. Each point reaches the nearest point in the next column, and each point there is reached from
  // the nearest behind it; then a few more lanes forward and a few sideways, never crossing on the chart.
  const lanes = [];
  const have = new Set();
  const long = def.longLane ?? 0.38;
  const add = (a, b, side = false) => {
    if (a === b || have.has(laneKey(a, b))) return;
    have.add(laneKey(a, b));
    const fuel = !side && Math.abs(byId[a].y - byId[b].y) > long ? LANE_FUEL.long : LANE_FUEL.short;
    lanes.push(side ? { a, b, fuel, side: true } : { a, b, fuel });
  };
  const nearest = (node, list) => [...list].sort((p, q) => Math.abs(p.y - node.y) - Math.abs(q.y - node.y) || p.rank - q.rank);
  for (let col = 0; col < last; col++) {
    const here = inCol(col);
    const next = inCol(col + 1);
    for (const node of here) add(node.id, nearest(node, next)[0].id);
    for (const node of next) if (!lanes.some((lane) => lane.b === node.id)) add(nearest(node, here)[0].id, node.id);
    for (const node of here) {
      const second = nearest(node, next)[1];
      if (second && rng.chance(def.crossLanes ?? 0.35) && !crosses(lanes, byId, node.id, second.id)) add(node.id, second.id);
    }
    if (col > 0) {
      for (let i = 0; i + 1 < here.length; i++) if (rng.chance(def.sideLanes ?? 0.25)) add(here[i].id, here[i + 1].id, true);
    }
  }

  // What each point is. The two ends are ports; in between, every kind turns up at least its minimum,
  // checkpoints in the middle columns where a patrol line would sit, and the rest by weight.
  const start = nodes[0];
  const delivery = nodes.at(-1);
  Object.assign(start, { kind: 'port', role: 'origin' });
  Object.assign(delivery, { kind: 'port', role: 'delivery' });
  const inner = rng.shuffle(nodes.slice(1, -1));
  const central = (node) => node.col >= 2 && node.col <= last - 2;
  const kinds = Object.entries(def.kinds);
  for (const [kind, rule] of kinds) {
    for (let n = 0; n < (rule.minimum ?? 0); n++) {
      const pool = inner.filter((node) => !node.kind);
      const preferred = kind === 'checkpoint' ? pool.filter(central) : pool;
      const node = (preferred.length ? preferred : pool)[0];
      if (node) node.kind = kind;
    }
  }
  for (const node of inner) if (!node.kind) node.kind = rng.weighted(kinds, ([, rule]) => rule.weight)[0];
  for (const node of nodes) {
    node.name = designate();
    if (node.kind === 'hazard') node.hazard = rng.pick(def.hazards);
  }


  // Lane risks (H.6): an old company beacon on one open-space point, a band of Union space along the top or the
  // bottom of the chart, then the first risk in the sector's list whose `where` fits each lane.
  const empties = nodes.filter((node) => node.kind === 'empty' && !node.role);
  if (empties.length) rng.pick(empties).beacon = true;
  const union = { side: rng.chance(0.5) ? 'top' : 'bottom', depth: def.union ?? 0 };
  const inUnion = (node) => !node.role && (union.side === 'top' ? node.y < union.depth : node.y > 1 - union.depth);
  const risks = def.risks ?? [];
  for (const lane of lanes) {
    const ends = [byId[lane.a], byId[lane.b]];
    const risk = risks.find(({ where }) =>
      where.touches ? ends.some((end) => end.kind === where.touches) : where.beacon ? ends.some((end) => end.beacon) : where.union ? ends.every(inUnion) : Boolean(where.default),
    );
    lane.risk = risk?.id ?? null;
    const hazard = risk?.where.touches === 'hazard' ? ends.find((end) => end.kind === 'hazard')?.hazard : null;
    if (hazard) lane.hazard = hazard;
    lane.hours = laneHours(def, ends[0], ends[1], last, risk);
  }

  const sector = { id: def.id, name: def.name, nodes, lanes, start: start.id, delivery: delivery.id, union };
  // The cheapest way across must be affordable on a full start tank: if it is not, the straightest way is made short.
  if (cheapestRoute(sector, sector.start, sector.delivery).fuel > def.fuel.start) {
    const straight = fewestJumps(sector, sector.start, sector.delivery);
    for (let i = 0; i + 1 < straight.length; i++) laneBetween(sector, straight[i], straight[i + 1]).fuel = LANE_FUEL.short;
  }
  return sector;
}

/** A lane's length in ship hours: its run across the columns and up or down the chart, times its risk's `length`. */
function laneHours(def, a, b, last, risk) {
  const h = def.hours ?? { base: 2, column: 1.5, climb: 4, min: 2, max: 8 };
  const columns = Math.abs(a.col - b.col);
  const raw = Math.min(h.max, Math.max(h.min, Math.round(h.base + h.column * columns + h.climb * Math.abs(a.y - b.y))));
  return Math.max(1, Math.round(raw * (risk?.length ?? 1)));
}

// ---------- reading a chart ----------

export const nodeOf = (sector, id) => sector.nodes.find((node) => node.id === id) ?? null;
export const laneBetween = (sector, a, b) => sector.lanes.find((lane) => (lane.a === a && lane.b === b) || (lane.a === b && lane.b === a)) ?? null;
/** The points one lane away. */
export const neighbours = (sector, id) => sector.lanes.filter((lane) => lane.a === id || lane.b === id).map((lane) => (lane.a === id ? lane.b : lane.a));
/** Is this point in Union space? */
export const inUnionSpace = (sector, node) => Boolean(sector.union?.depth) && !node.role && (sector.union.side === 'top' ? node.y < sector.union.depth : node.y > 1 - sector.union.depth);

/** The route with the fewest lanes, as a list of point ids from `from` to `to`, or null. */
export function fewestJumps(sector, from, to) {
  const back = new Map([[from, null]]);
  const queue = [from];
  while (queue.length) {
    const id = queue.shift();
    if (id === to) break;
    for (const next of neighbours(sector, id).sort()) {
      if (back.has(next)) continue;
      back.set(next, id);
      queue.push(next);
    }
  }
  if (!back.has(to)) return null;
  const path = [];
  for (let id = to; id !== null; id = back.get(id)) path.unshift(id);
  return path;
}

/** Lanes between two points, the fewest, or Infinity. */
export function distance(sector, from, to) {
  const path = fewestJumps(sector, from, to);
  return path ? path.length - 1 : Infinity;
}

/** What a run of points adds up to: { fuel, hours, legs }. */
export function routeTotals(sector, path) {
  let fuel = 0;
  let hours = 0;
  for (let i = 0; i + 1 < path.length; i++) {
    const lane = laneBetween(sector, path[i], path[i + 1]);
    fuel += lane.fuel;
    hours += lane.hours ?? 0;
  }
  return { fuel, hours, legs: path.length - 1 };
}

/**
 * The best route from one point to another: `by` 'fuel' (the least fuel, then the fewest hours) or 'hours'
 * (the fewest hours, then the least fuel). With `ports: false` it never passes through a port on the way
 * (a route ends at the first port it reaches). Returns { path, fuel, hours, legs }, or { path: null, fuel: Infinity, ... }.
 */
export function bestRoute(sector, from, to, { by = 'fuel', ports = true } = {}) {
  const weigh = (lane) => (by === 'hours' ? (lane.hours ?? 0) * 100 + lane.fuel : lane.fuel * 1000 + (lane.hours ?? 0));
  const best = new Map([[from, { cost: 0, back: null }]]);
  const open = new Set([from]);
  const done = new Set();
  while (open.size) {
    const id = [...open].sort((a, b) => best.get(a).cost - best.get(b).cost || a.localeCompare(b))[0];
    open.delete(id);
    done.add(id);
    if (id === to) break;
    if (!ports && id !== from && nodeOf(sector, id).kind === 'port') continue; // a port on the way is where a route ends
    for (const next of neighbours(sector, id)) {
      if (done.has(next)) continue;
      const cost = best.get(id).cost + weigh(laneBetween(sector, id, next)) + 1;
      if (!best.has(next) || cost < best.get(next).cost) {
        best.set(next, { cost, back: id });
        open.add(next);
      }
    }
  }
  if (!best.has(to)) return { path: null, fuel: Infinity, hours: Infinity, legs: Infinity };
  const path = [];
  for (let id = to; id !== null; id = best.get(id).back) path.unshift(id);
  return { path, ...routeTotals(sector, path) };
}

/** The route that burns the least fuel, then takes the fewest hours. */
export const cheapestRoute = (sector, from, to) => bestRoute(sector, from, to, { by: 'fuel' });

/**
 * Problems with a generated chart that should never happen: too few or too many points, a point that
 * cannot be reached, a lane to nowhere or with no length or risk, no affordable way to the delivery. Empty means sound.
 */
export function checkSector(sector, def) {
  const problems = [];
  const ids = new Set(sector.nodes.map((node) => node.id));
  const risks = new Set((def.risks ?? []).map((risk) => risk.id));
  if (sector.nodes.length < def.nodes[0] || sector.nodes.length > def.nodes[1]) problems.push(`${sector.nodes.length} points, outside ${def.nodes[0]} to ${def.nodes[1]}`);
  if (ids.size !== sector.nodes.length) problems.push('two points share an id');
  for (const node of sector.nodes) {
    if (!NODE_KINDS[node.kind]) problems.push(`${node.id} is of no known kind ("${node.kind}")`);
    if (!(node.x >= 0 && node.x <= 1 && node.y >= 0 && node.y <= 1)) problems.push(`${node.id} is off the chart`);
  }
  for (const lane of sector.lanes) {
    if (!ids.has(lane.a) || !ids.has(lane.b)) problems.push(`a lane runs to nowhere (${lane.a} to ${lane.b})`);
    if (!Object.values(LANE_FUEL).includes(lane.fuel)) problems.push(`lane ${lane.a} to ${lane.b} costs ${lane.fuel} fuel`);
    if (!(Number.isInteger(lane.hours) && lane.hours >= 1)) problems.push(`lane ${lane.a} to ${lane.b} is ${lane.hours} hours long`);
    if (risks.size && !risks.has(lane.risk)) problems.push(`lane ${lane.a} to ${lane.b} has no risk ("${lane.risk}")`);
  }
  if (!ids.has(sector.start) || !ids.has(sector.delivery)) return [...problems, 'the origin or the delivery is missing'];
  for (const node of sector.nodes) if (!fewestJumps(sector, sector.start, node.id)) problems.push(`${node.id} cannot be reached from the origin`);
  if (nodeOf(sector, sector.delivery).kind !== 'port') problems.push('the delivery is not a port');
  const route = cheapestRoute(sector, sector.start, sector.delivery);
  if (!route.path) problems.push('the delivery cannot be reached');
  else if (route.fuel > def.fuel.start) problems.push(`the cheapest way to the delivery costs ${route.fuel} fuel, more than the ${def.fuel.start} we start with`);
  for (const [kind, rule] of Object.entries(def.kinds)) {
    const count = sector.nodes.filter((node) => node.kind === kind && !node.role).length;
    if (count < (rule.minimum ?? 0)) problems.push(`only ${count} ${kind} point(s), wanted ${rule.minimum}`);
  }
  return problems;
}

// ---------- the run ----------

/**
 * The run's state: the chart, where we are, fuel, hours under way against the deadline, a plotted route,
 * the crossing being flown and the pursuit. Options: `pursuit` fixes whether we are followed (the contract
 * board rolls it, S3.4), and `slack` replaces the sector's range of spare time on the deadline, as a share of the
 * cheapest way across in hours.
 */
export function newRunState(def, rng, { pursuit, slack: spare } = {}) {
  const map = generateSector(def, rng);
  const route = cheapestRoute(map, map.start, map.delivery);
  const [least, most] = spare ?? def.slack;
  const slack = least + (most - least) * rng.next();
  const followed = pursuit ?? rng.chance(def.pursuit.chance);
  return {
    sector: def.id,
    map,
    at: map.start, // the port we are at, or the last point passed on a crossing
    visited: [map.start],
    fuel: def.fuel.start,
    fuelMax: def.fuel.max,
    hour: def.hour ?? 10, // seconds of ship time to an hour on the ship clock
    risks: Object.fromEntries((def.risks ?? []).map((risk) => [risk.id, risk])),
    hours: 0, // ship hours under way since the origin
    legs: 0, // lanes flown
    slack, // the share of spare time the deadline was given
    deadline: Math.round(route.hours * (1 + slack)), // hours the contract allows: the cheapest way across and a share more
    route: null, // a route plotted at a port: point ids from here to another port
    crossing: null, // the crossing under way (startCrossing)
    late: false, // past the deadline
    delivered: false, // reached the delivery port
    rule: { ...def.pursuit }, // how a follower of this sector behaves, kept so the debug panel can call one up
    pursuit: followed ? newPursuit(def.pursuit) : null,
  };
}

export function newPursuit(rule) {
  return {
    encounter: rule.encounter, // the kind of contact it is, from content/encounters/
    wait: rule.lead, // hours under way before it can find us
    lead: rule.lead,
    rate: rule.rate, // the chance an hour, after that, that it does
    contact: null, // its contact on the scope, while it is there
    seen: false, // its return has shown on the scope this time
    caught: 0, // times it has found us
    done: false, // driven off for good
  };
}

/** The lane risk of a lane, or null. */
export const riskOf = (run, lane) => (lane?.risk ? (run.risks[lane.risk] ?? null) : null);
/** The lane being flown right now, or null. */
export function laneNow(run) {
  const c = run?.crossing;
  return c ? laneBetween(run.map, c.path[c.leg], c.path[c.leg + 1]) : null;
}

/** Is the ship held where she is: alongside, clamped, a party aboard, out of fuel, or a decision on the table? */
export function heldReason(sim) {
  const run = sim.state.run;
  if (run?.crossing?.stalled) return 'out of fuel';
  if (run?.events?.open) return 'a decision is on the table';
  if (heldBySituation(sim)) return 'we are standing by something alongside';
  if (sim.state.boarding) return 'a ship is clamped to our airlock';
  if (heldAlongside(sim)) return 'a ship is alongside';
  return null;
}

/** The share of a lane's hours an hour under way covers: the helm and the drive (COAST without them). */
export function paceOf(sim) {
  if (!hasPilot(sim)) return COAST;
  return Math.min(PACE_MAX, Math.max(COAST, driveShare(sim) / THRUST));
}

/** Hours of the crossing still to fly at the nominal pace, or 0. */
export function hoursLeft(run) {
  const c = run?.crossing;
  if (!c) return 0;
  return Math.max(0, c.length - c.t) + routeTotals(run.map, c.path.slice(c.leg + 1)).hours;
}

/** Why this route cannot be plotted right now, or null. `path: null` clears it. */
export function whyNoRoute(sim, path) {
  const run = sim.state.run;
  if (!run) return 'there is no chart for this run';
  if (path === null) return run.route ? null : 'no route is plotted';
  if (run.crossing) return 'a route is plotted at a port: we are under way';
  if (!Array.isArray(path) || path.length < 2) return 'a route needs at least one lane';
  if (path[0] !== run.at) return 'a route starts where we are';
  for (let i = 0; i + 1 < path.length; i++) {
    if (!nodeOf(run.map, path[i + 1])) return `no point "${path[i + 1]}" on the chart`;
    if (!laneBetween(run.map, path[i], path[i + 1])) return `no lane runs from ${nodeOf(run.map, path[i])?.name ?? path[i]} to ${nodeOf(run.map, path[i + 1]).name}`;
  }
  if (new Set(path).size !== path.length) return 'a route crosses the same point twice';
  if (nodeOf(run.map, path.at(-1)).kind !== 'port') return 'a route ends at a port';
  if (path.slice(1, -1).some((id) => nodeOf(run.map, id).kind === 'port')) return 'a route ends at the first port it reaches';
  const { fuel } = routeTotals(run.map, path);
  if (fuel > run.fuel) return `that route takes ${fuel} fuel and we have ${run.fuel}`;
  return null;
}

/** Why we cannot cast off on the plotted route (or on `path`, plotted and sailed at once) right now, or null. */
export function whyNoSail(sim, path) {
  const run = sim.state.run;
  if (!run) return 'there is no chart for this run';
  if (run.crossing) return 'we are already under way';
  if (path !== undefined) {
    const why = whyNoRoute(sim, path);
    if (why) return why;
  } else if (!run.route) return 'no route is plotted';
  const { fuel } = routeTotals(run.map, path ?? run.route);
  if (fuel > run.fuel) return `that route takes ${fuel} fuel and we have ${run.fuel}`;
  if (sim.state.boarding) return 'a ship is clamped to our airlock';
  if (heldAlongside(sim)) return 'a ship is alongside';
  return null;
}

/** Why we cannot make the run into port right now, or null. */
export function whyNoRunIn(sim) {
  const run = sim.state.run;
  if (!run) return 'there is no chart for this run';
  if (!run.crossing) return 'we are not under way';
  if (run.crossing.phase !== 'off port') return 'we are not off the port yet';
  if (heldAlongside(sim)) return 'a ship is alongside: she cannot jump with it this close';
  if (sim.state.boarding) return 'a ship is clamped to our airlock';
  return whyNoJump(sim);
}

/** Cast off: the plotted route becomes the crossing, and the first lane begins. */
function startCrossing(sim) {
  const run = sim.state.run;
  const path = run.route;
  const totals = routeTotals(run.map, path);
  run.route = null;
  run.crossing = { path, leg: 0, t: 0, length: 0, eventAt: null, phase: 'under way', stalled: false, hours: 0 };
  sim.state.fix = 0;
  sim.events.emit('route.sailed', { from: path[0], to: path.at(-1), legs: totals.legs, hours: totals.hours, fuel: totals.fuel, tick: sim.state.tick });
  startLeg(sim);
}

/** On to the next lane of the crossing: its fuel, its length, and whether the point it runs to brings an event on the way. */
function startLeg(sim) {
  const run = sim.state.run;
  const c = run.crossing;
  const lane = laneNow(run);
  const to = nodeOf(run.map, c.path[c.leg + 1]);
  if (run.fuel < lane.fuel) {
    // An event drank what the route needed: she drifts where she is.
    c.stalled = true;
    sim.events.emit('fuel.out', { node: run.at, fuel: run.fuel, tick: sim.state.tick });
    return;
  }
  run.fuel -= lane.fuel;
  Object.assign(c, { t: 0, length: lane.hours, eventAt: null });
  // The first time we pass a point its dice are thrown once; what comes, comes somewhere along the lane to it.
  // The contract's claim comes before anything the dice would bring: passing it opens the claim (endLeg).
  const state = run.events;
  const claim = run.contract?.status === 'active' && run.contract.claim && !run.contract.claim.done ? run.contract.claim.node : null;
  if (state && to.kind !== 'port' && to.id !== claim && !state.rolled.includes(to.id)) {
    state.rolled.push(to.id);
    const chance = run.eventChance?.[to.kind] ?? 0;
    if (chance > 0 && sim.rng.stream('events').chance(chance)) c.eventAt = sim.rng.stream('voyage').range(...EVENT_ALONG);
  }
  sim.events.emit('route.leg', { from: c.path[c.leg], to: to.id, risk: lane.risk, hours: lane.hours, fuel: lane.fuel, left: run.fuel, tick: sim.state.tick });
}

/** The end of a lane: past a point and on to the next lane, or off the port at the end of the route. */
function endLeg(sim) {
  const run = sim.state.run;
  const c = run.crossing;
  const to = c.path[c.leg + 1];
  const node = nodeOf(run.map, to);
  if (c.leg + 2 >= c.path.length) {
    c.phase = 'off port';
    c.t = c.length;
    sim.state.fix = 0;
    sim.events.emit('route.offport', { node: to, name: node.name, tick: sim.state.tick });
    return;
  }
  c.leg += 1;
  run.at = to;
  run.legs += 1;
  if (!run.visited.includes(to)) run.visited.push(to);
  sim.events.emit('route.passed', { node: to, kind: node.kind, name: node.name, hazard: node.hazard ?? null, tick: sim.state.tick });
  // The contract's claim: she heaves to by it, and the claim is put to the captain (H.7 makes it a derelict alongside).
  const claim = run.contract?.status === 'active' ? run.contract.claim : null;
  if (claim && !claim.done && claim.node === to && !run.events?.open && !aboard(sim).some((one) => one.id === claim.event)) openEvent(sim, claim.event, { force: true, node: to });
  startLeg(sim);
}

/** Jump into the port at the end of the route: the crossing is over. */
function arrive(sim) {
  const run = sim.state.run;
  const c = run.crossing;
  const from = c.path.at(-2);
  const to = c.path.at(-1);
  const node = nodeOf(run.map, to);
  run.at = to;
  run.legs += 1;
  if (!run.visited.includes(to)) run.visited.push(to);
  run.crossing = null;
  sim.state.fix = 0; // a fix is good for where it was taken
  leaveEvents(sim); // whatever was on the table or waiting aboard is left behind with the crossing
  sim.events.emit('sector.jumped', { from, to, kind: node.kind, left: run.fuel, hours: run.hours, deadline: run.deadline, how: 'jump', tick: sim.state.tick });
  if (to === run.map.delivery && !run.delivered) {
    run.delivered = true;
    sim.events.emit('sector.delivered', { node: to, late: run.late, hours: run.hours, tick: sim.state.tick });
  }
  sim.events.emit('sector.arrived', { node: to, kind: node.kind, name: node.name, tick: sim.state.tick });
}

/** Each tick under way: the clock, the deadline, the ship along her lane, and what the lane brings. */
export function stepSector(sim, dt) {
  const run = sim.state.run;
  const c = run?.crossing;
  if (!c) return;
  const hours = dt / run.hour;
  run.hours += hours;
  c.hours += hours;
  if (!run.late && !run.delivered && run.hours > run.deadline) {
    run.late = true;
    sim.events.emit('contract.late', { hours: Math.floor(run.hours), deadline: run.deadline, tick: sim.state.tick });
  }
  if (c.phase === 'under way') {
    if (!heldReason(sim)) c.t += hours * paceOf(sim);
    if (c.eventAt !== null && c.t >= c.eventAt * c.length && canMeet(sim)) {
      c.eventAt = null;
      rollLaneEvent(sim, c.path[c.leg + 1]);
    }
    if (c.t >= c.length && !c.stalled && !run.events?.open) endLeg(sim);
  } else stepFix(sim, dt, { ready: 'course.ready', lost: 'course.lost' });
  if (!run.crossing) return;
  const risk = riskOf(run, laneNow(run));
  if (risk) laneRisks(sim, risk, hours);
  stepPursuit(sim, hours);
}

/** What a lane's risk brings, hour by hour: ships on the scope, and things hitting the hull. */
function laneRisks(sim, risk, hours) {
  const run = sim.state.run;
  if (risk.contacts > 0 && !run.delivered && liveContacts(sim).length < MAX_LANE_CONTACTS) {
    const rng = sim.rng.stream('encounters');
    if (rng.chance(risk.contacts * hours)) {
      const pool = Object.entries(risk.encounters ?? {}).filter(([id, weight]) => weight > 0 && sim.encounters.byId.has(id));
      if (pool.length) {
        const def = sim.encounters.byId.get(rng.weighted(pool, ([, weight]) => weight)[0]);
        // Far enough out that a ship with her sensors up sees it before it can see her: there is time to do something.
        const contact = spawnContact(sim, def, { range: rng.range(SPAWN.near, SPAWN.far), bearing: rng.range(0, 360), miss: rng.range(0, SPAWN.miss), side: rng.chance(0.5) ? 1 : -1 });
        contact.lane = risk.id;
      }
    }
  }
  if (risk.strikes && run.crossing.phase === 'under way' && !heldReason(sim)) {
    const seen = hasPilot(sim) ? Math.min(DODGE.most, DODGE.perRating * rating(sim, 'helm')) : 0;
    if (sim.rng.stream('voyage').chance(risk.strikes.perHour * hours * (1 - seen))) strike(sim, risk.strikes.weapon);
  }
}

/** The follower: after its lead, it may find us, and turns up on the scope coming from astern. */
function stepPursuit(sim, hours) {
  const run = sim.state.run;
  const chase = run.pursuit;
  if (!chase || chase.done || run.delivered) return;
  if (chase.contact !== null) {
    const contact = findContact(sim, chase.contact);
    if (!contact) {
      // Gone from the scope without an ending we heard about: it is back on the trail.
      chase.contact = null;
      chase.wait = chase.lead;
      return;
    }
    if (!chase.seen && contact.track.shown) {
      chase.seen = true;
      sim.events.emit('pursuit.sighted', { contact: contact.id, encounter: chase.encounter, tick: sim.state.tick });
    }
    return;
  }
  if (chase.wait > 0) {
    chase.wait = Math.max(0, chase.wait - hours);
    return;
  }
  if (!sim.rng.stream('voyage').chance(chase.rate * hours)) return;
  findUs(sim);
}

/** The follower finds us: it turns up astern, with a fair idea of where we are. */
function findUs(sim) {
  const run = sim.state.run;
  const chase = run.pursuit;
  const def = sim.encounters.byId.get(chase.encounter);
  if (!def) return;
  const rng = sim.rng.stream('encounters');
  const contact = spawnContact(sim, def, { range: PURSUER.range, bearing: sim.state.helm.heading + 180 + rng.range(-PURSUER.spread, PURSUER.spread), miss: 0, state: 'shadowing' });
  contact.pursuer = true;
  contact.aware = Math.max(contact.aware ?? 0, PURSUER.aware);
  chase.contact = contact.id;
  chase.seen = false;
  chase.caught += 1;
  sim.events.emit('pursuit.caught', { contact: contact.id, encounter: chase.encounter, tick: sim.state.tick });
}

/** A follower's encounter ends: driven off by the gun, it gives up for good; any other way, it picks the trail up again. */
export function attachSector(sim) {
  sim.events.on('encounter.ended', (event) => {
    const run = sim.state.run;
    if (!event.pursuer || !run?.pursuit || run.pursuit.done) return;
    run.pursuit.contact = null;
    if (event.outcome === 'deterred') {
      run.pursuit.done = true;
      sim.events.emit('pursuit.ended', { outcome: event.outcome, tick: sim.state.tick });
    } else run.pursuit.wait = run.pursuit.lead;
  });
}

export function sectorCommands() {
  return {
    // Plot a route at a port (path: point ids from here to a port), or clear it (path: null).
    'route.plot': {
      check: (sim, cmd) => whyNoRoute(sim, cmd.path),
      apply(sim, cmd) {
        const run = sim.state.run;
        run.route = cmd.path === null ? null : [...cmd.path];
        if (cmd.path === null) sim.events.emit('route.cleared', { tick: sim.state.tick });
        else sim.events.emit('route.plotted', { path: [...cmd.path], ...routeTotals(run.map, cmd.path), tick: sim.state.tick });
      },
    },
    // Cast off and fly the plotted route, or `path` (plotted and sailed at once).
    'route.sail': {
      check: (sim, cmd) => (cmd.path === null ? 'a route needs at least one lane' : whyNoSail(sim, cmd.path)),
      apply(sim, cmd) {
        if (cmd.path) sim.state.run.route = [...cmd.path];
        startCrossing(sim);
      },
    },
    // Off the port at the end of the route: jump in once the sensors have a fix.
    'route.jump': {
      check: (sim) => whyNoRunIn(sim),
      apply: (sim) => arrive(sim),
    },
    // Debug panel and tests only: fuel, the sensor fix, on to the next thing on this lane, and the follower (on, off, or here now).
    'debug.run': {
      check(sim, cmd) {
        const run = sim.state.run;
        if (!run) return 'there is no chart for this run';
        if (cmd.fuel !== undefined && !(Number.isInteger(cmd.fuel) && cmd.fuel >= 0 && cmd.fuel <= run.fuelMax)) return `fuel must be a whole number from 0 to ${run.fuelMax}`;
        if (cmd.pursuit !== undefined && !['on', 'off', 'catch'].includes(cmd.pursuit)) return 'pursuit must be on, off or catch';
        if (cmd.pursuit === 'catch' && !run.crossing) return 'a follower finds us under way, not at a port';
        if (cmd.fix !== undefined && cmd.fix !== true) return 'fix can only be true';
        if (cmd.skip !== undefined && cmd.skip !== true) return 'skip can only be true';
        if (cmd.skip && run.crossing?.phase !== 'under way') return 'skip needs a lane under way';
        return cmd.fuel === undefined && cmd.pursuit === undefined && cmd.fix === undefined && cmd.skip === undefined ? 'needs fuel, pursuit, fix or skip' : null;
      },
      apply(sim, cmd) {
        const run = sim.state.run;
        if (cmd.fuel !== undefined) run.fuel = cmd.fuel;
        if (cmd.fix) sim.state.fix = 1;
        // On along this lane to the next thing on it: the event waiting partway, else the lane's end.
        if (cmd.skip) {
          const c = run.crossing;
          c.t = Math.max(c.t, c.eventAt !== null ? c.eventAt * c.length : c.length);
        }
        if (cmd.pursuit === 'off') run.pursuit = null;
        if (cmd.pursuit === 'on') run.pursuit = newPursuit(run.rule);
        if (cmd.pursuit === 'catch') {
          if (run.pursuit?.contact !== null && run.pursuit?.contact !== undefined && findContact(sim, run.pursuit.contact)) return;
          run.pursuit = { ...(run.pursuit ?? newPursuit(run.rule)), wait: 0, done: false, contact: null };
          findUs(sim);
        }
      },
    },
  };
}

/** Problems with the run's state that should never happen. */
export function checkRunInvariants(sim) {
  const run = sim.state.run;
  if (!run) return [];
  const problems = [];
  const has = (id) => Boolean(nodeOf(run.map, id));
  if (!has(run.at)) problems.push(`run: we are at "${run.at}", which is not on the chart`);
  if (!(Number.isInteger(run.fuel) && run.fuel >= 0 && run.fuel <= run.fuelMax)) problems.push(`run: fuel is ${run.fuel}`);
  if (!(Number.isInteger(run.legs) && run.legs >= 0)) problems.push(`run: legs is ${run.legs}`);
  if (!(run.hours >= 0 && Number.isFinite(run.hours))) problems.push(`run: hours is ${run.hours}`);
  if (run.route && run.crossing) problems.push('run: a route is plotted while under way');
  if (run.route && run.route[0] !== run.at) problems.push(`run: the route starts at ${run.route[0]}, not where we are`);
  const c = run.crossing;
  if (c) {
    if (c.path[c.leg] !== run.at) problems.push(`run: on lane ${c.leg} from ${c.path[c.leg]}, but at ${run.at}`);
    if (!laneNow(run)) problems.push(`run: lane ${c.leg} of the crossing does not exist`);
    if (!(c.t >= 0 && c.t <= c.length + 1)) problems.push(`run: ${c.t} hours into a ${c.length} hour lane`);
    if (!['under way', 'off port'].includes(c.phase)) problems.push(`run: the crossing is "${c.phase}"`);
  } else if (nodeOf(run.map, run.at)?.kind !== 'port') problems.push(`run: stopped at ${run.at}, which is not a port`);
  if (!run.visited.includes(run.at)) problems.push('run: where we are is not in the visited list');
  return problems;
}
