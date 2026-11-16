// The sector map and the run across it (S3.1, D-104 to D-107). DOM-free.
//
// A run crosses one sector: a band of space from an origin port to the port
// the cargo is going to, drawn on Margo's company route chart. The chart is a
// graph of 15 to 25 points (ports, open space, hazards, derelicts and
// checkpoints) in columns, joined by lanes. Every lane costs fuel, one or two
// for a long one, and every jump counts against the contract's deadline.
//
// A jump is the same act whether we are running from a fight or not
// (D-087): plot a course down a lane, let the sensors take a fix with someone
// at the helm, then jump. Out of a fight the fix builds while the ship goes
// about its business, so a fire or a hull breach still has to be dealt with
// while she works it out. In a fight, a course plotted before we escape is
// where the escape takes us.
//
// Some contracts are followed (the pursuit hook). A ship sets out from the
// origin a couple of jumps behind us and closes one lane a jump, by the
// shortest way. Going straight keeps the gap; every detour gives it a lane.
// If it reaches the point we are at, a fight starts. Margo only sees it
// within a couple of lanes, and only with the sensors running: otherwise the
// chart shows where it was last seen.
//
// Everything here is generated from the 'map' RNG stream and kept in
// `sim.state.run`, so a run replays from its seed and saves with the rest.

import { endFight, startFight, whyNoJump, stepFix } from './combat.js';

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
 * lanes: [{ a, b, fuel, side? }], start, delivery }. Always connected, by construction:
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

  const sector = { id: def.id, name: def.name, nodes, lanes, start: start.id, delivery: delivery.id };
  // The cheapest way across must be affordable on a full start tank: if it is not, the straightest way is made short.
  if (cheapestRoute(sector, sector.start, sector.delivery).fuel > def.fuel.start) {
    const straight = fewestJumps(sector, sector.start, sector.delivery);
    for (let i = 0; i + 1 < straight.length; i++) laneBetween(sector, straight[i], straight[i + 1]).fuel = LANE_FUEL.short;
  }
  return sector;
}

// ---------- reading a chart ----------

export const nodeOf = (sector, id) => sector.nodes.find((node) => node.id === id) ?? null;
export const laneBetween = (sector, a, b) => sector.lanes.find((lane) => (lane.a === a && lane.b === b) || (lane.a === b && lane.b === a)) ?? null;
/** The points one lane away. */
export const neighbours = (sector, id) => sector.lanes.filter((lane) => lane.a === id || lane.b === id).map((lane) => (lane.a === id ? lane.b : lane.a));

/** The route with the fewest jumps, as a list of point ids from `from` to `to`, or null. */
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

/** Lanes between two points, the fewest jumps, or Infinity. */
export function distance(sector, from, to) {
  const path = fewestJumps(sector, from, to);
  return path ? path.length - 1 : Infinity;
}

/** The route that burns the least fuel, then takes the fewest jumps: { path, fuel, jumps }, or { path: null, fuel: Infinity }. */
export function cheapestRoute(sector, from, to) {
  const best = new Map([[from, { cost: 0, fuel: 0, back: null }]]);
  const open = new Set([from]);
  const done = new Set();
  while (open.size) {
    const id = [...open].sort((a, b) => best.get(a).cost - best.get(b).cost || a.localeCompare(b))[0];
    open.delete(id);
    done.add(id);
    if (id === to) break;
    for (const next of neighbours(sector, id)) {
      if (done.has(next)) continue;
      const lane = laneBetween(sector, id, next);
      const cost = best.get(id).cost + lane.fuel * 100 + 1;
      if (!best.has(next) || cost < best.get(next).cost) {
        best.set(next, { cost, fuel: best.get(id).fuel + lane.fuel, back: id });
        open.add(next);
      }
    }
  }
  if (!best.has(to)) return { path: null, fuel: Infinity, jumps: Infinity };
  const path = [];
  for (let id = to; id !== null; id = best.get(id).back) path.unshift(id);
  return { path, fuel: best.get(to).fuel, jumps: path.length - 1 };
}

/**
 * Problems with a generated chart that should never happen: too few or too many points, a point that
 * cannot be reached, a lane to nowhere, no affordable way to the delivery. Empty means sound.
 */
export function checkSector(sector, def) {
  const problems = [];
  const ids = new Set(sector.nodes.map((node) => node.id));
  if (sector.nodes.length < def.nodes[0] || sector.nodes.length > def.nodes[1]) problems.push(`${sector.nodes.length} points, outside ${def.nodes[0]} to ${def.nodes[1]}`);
  if (ids.size !== sector.nodes.length) problems.push('two points share an id');
  for (const node of sector.nodes) {
    if (!NODE_KINDS[node.kind]) problems.push(`${node.id} is of no known kind ("${node.kind}")`);
    if (!(node.x >= 0 && node.x <= 1 && node.y >= 0 && node.y <= 1)) problems.push(`${node.id} is off the chart`);
  }
  for (const lane of sector.lanes) {
    if (!ids.has(lane.a) || !ids.has(lane.b)) problems.push(`a lane runs to nowhere (${lane.a} to ${lane.b})`);
    if (!Object.values(LANE_FUEL).includes(lane.fuel)) problems.push(`lane ${lane.a} to ${lane.b} costs ${lane.fuel} fuel`);
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
 * The run's state: the chart, where we are, fuel, jumps, the deadline, a plotted course and the pursuit.
 * `contract` is a stand-in until contracts are content (S3.4): it only says whether we are followed.
 */
export function newRunState(def, rng, { pursuit } = {}) {
  const map = generateSector(def, rng);
  const route = cheapestRoute(map, map.start, map.delivery);
  const slack = rng.between(def.slack[0], def.slack[1]);
  const followed = pursuit ?? rng.chance(def.pursuit.chance);
  return {
    sector: def.id,
    map,
    at: map.start,
    visited: [map.start],
    fuel: def.fuel.start,
    fuelMax: def.fuel.max,
    jumps: 0,
    deadline: route.jumps + slack, // jumps the contract allows
    plot: null, // the point we have plotted a course to, one lane away
    late: false, // past the deadline
    delivered: false, // reached the delivery port
    escape: null, // a course to take once an escape from a fight is settled (stepSector)
    rule: { ...def.pursuit }, // how a pursuer of this sector behaves, kept so the debug panel can call one up
    pursuit: followed ? newPursuit(def.pursuit, map.start) : null,
  };
}

function newPursuit(rule, at) {
  return {
    ship: rule.ship,
    at,
    wait: rule.lead, // jumps of ours before it moves again
    lead: rule.lead,
    sight: rule.sight, // lanes away Margo can see it, with the sensors running
    seen: false, // seen on our last jump
    lastSeen: null, // { node, jump }
    caught: 0, // fights it has forced
    done: false, // beaten off for good
  };
}

/** Why we cannot plot a course to `to` right now, or null. `to: null` clears the course. */
export function whyNoPlot(sim, to) {
  const run = sim.state.run;
  if (!run) return 'there is no chart for this run';
  if (to === null) return run.plot ? null : 'no course is plotted';
  if (!nodeOf(run.map, to)) return `no point "${to}" on the chart`;
  if (to === run.at) return 'we are already here';
  const lane = laneBetween(run.map, run.at, to);
  if (!lane) return 'no lane runs there from here';
  if (run.fuel < lane.fuel) return `that lane takes ${lane.fuel} fuel and we have ${run.fuel}`;
  return null;
}

/** Why we cannot make the plotted jump right now, or null. Out of a fight only: in one, ship.jump escapes. */
export function whyNoCourseJump(sim) {
  const run = sim.state.run;
  if (!run) return 'there is no chart for this run';
  if (!run.plot) return 'no course is plotted';
  if (sim.state.fight && !sim.state.fight.over) return 'in a fight a jump is an escape: use the fight controls';
  const lane = laneBetween(run.map, run.at, run.plot);
  if (run.fuel < lane.fuel) return `that lane takes ${lane.fuel} fuel and we have ${run.fuel}`;
  return whyNoJump(sim);
}

/** Why we cannot refuel right now, or null. Ports only, and only when the tanks are not full. */
export function whyNoRefuel(sim) {
  const run = sim.state.run;
  if (!run) return 'there is no chart for this run';
  if (nodeOf(run.map, run.at).kind !== 'port') return 'only a port has fuel to sell';
  if (sim.state.fight && !sim.state.fight.over) return 'not in a fight';
  if (run.fuel >= run.fuelMax) return 'the tanks are full';
  return null;
}

/** Cross the lane to `to`: fuel, the jump count, the deadline, the pursuit, and arriving. */
function travel(sim, to, how, newShipState) {
  const run = sim.state.run;
  const { tick } = sim.state;
  const lane = laneBetween(run.map, run.at, to);
  const from = run.at;
  run.fuel -= lane.fuel;
  run.at = to;
  run.jumps += 1;
  if (!run.visited.includes(to)) run.visited.push(to);
  run.plot = null;
  sim.state.fix = 0; // a fix is good for where it was taken
  const node = nodeOf(run.map, to);
  sim.events.emit('sector.jumped', { from, to, kind: node.kind, fuel: lane.fuel, left: run.fuel, jumps: run.jumps, deadline: run.deadline, how, tick });
  if (!run.delivered && !run.late && run.jumps > run.deadline) {
    run.late = true;
    sim.events.emit('contract.late', { jumps: run.jumps, deadline: run.deadline, tick });
  }
  if (to === run.map.delivery && !run.delivered) {
    run.delivered = true;
    sim.events.emit('sector.delivered', { node: to, late: run.late, jumps: run.jumps, tick });
  }
  sim.events.emit('sector.arrived', { node: to, kind: node.kind, name: node.name, hazard: node.hazard ?? null, tick });
  const cheapest = Math.min(...run.map.lanes.filter((l) => l.a === to || l.b === to).map((l) => l.fuel));
  if (!run.delivered && run.fuel < cheapest) sim.events.emit('fuel.out', { node: to, fuel: run.fuel, tick });
  stepPursuit(sim, newShipState);
}

/** The pursuer's move after each of our jumps: wait, or close one lane; then whether Margo sees it, and whether it has us. */
function stepPursuit(sim, newShipState) {
  const run = sim.state.run;
  const chase = run.pursuit;
  if (!chase || chase.done || run.delivered) return; // at the drop the cargo is signed for, and nobody is owed a chase
  const { tick } = sim.state;
  if (chase.wait > 0) chase.wait -= 1;
  else if (chase.at !== run.at) chase.at = fewestJumps(run.map, chase.at, run.at)[1];
  const lanes = distance(run.map, chase.at, run.at);
  const wasSeen = chase.seen;
  chase.seen = lanes <= chase.sight && sim.state.systems.sensors.power > 0;
  if (chase.seen) {
    chase.lastSeen = { node: chase.at, jump: run.jumps };
    if (!wasSeen) sim.events.emit('pursuit.sighted', { node: chase.at, lanes, ship: chase.ship, tick });
  }
  if (chase.at === run.at) caught(sim, newShipState);
}

/** The pursuer is alongside: a fight, with the ship that has followed us. */
function caught(sim, newShipState) {
  const run = sim.state.run;
  const chase = run.pursuit;
  chase.caught += 1;
  chase.lastSeen = { node: chase.at, jump: run.jumps };
  if (sim.state.fight) endFight(sim);
  startFight(sim, chase.ship, newShipState);
  sim.state.fight.pursuer = true;
  sim.events.emit('pursuit.caught', { node: run.at, ship: chase.ship, tick: sim.state.tick });
}

/** A fight is decided: an escape takes the plotted course, and a pursuer beaten off for now falls back. */
export function attachSector(sim) {
  sim.events.on('fight.over', (event) => {
    const run = sim.state.run;
    if (!run) return;
    if (event.outcome === 'escaped' && run.plot && !whyNoPlot(sim, run.plot)) run.escape = run.plot;
    if (sim.state.fight?.pursuer && run.pursuit) {
      if (['destroyed', 'crew-dead', 'surrendered'].includes(event.outcome)) {
        run.pursuit.done = true;
        sim.events.emit('pursuit.ended', { outcome: event.outcome, tick: sim.state.tick });
      } else run.pursuit.wait = run.pursuit.lead; // it lost us here; it will pick the trail up again
    }
  });
}

/** Each tick: settle an escape down the plotted lane, and work the fix for a plotted course out of a fight. */
export function stepSector(sim, dt, newShipState) {
  const run = sim.state.run;
  if (!run) return;
  if (run.escape) {
    const to = run.escape;
    run.escape = null;
    if (sim.state.fight) endFight(sim);
    travel(sim, to, 'escape', newShipState);
    return;
  }
  if (run.plot && !sim.state.fight) stepFix(sim, dt, { ready: 'course.ready', lost: 'course.lost' });
}

export function sectorCommands(newShipState) {
  return {
    // Plot a course down one lane (to: a point id), or clear it (to: null). Works in a fight too: it is where an escape goes.
    'course.plot': {
      check: (sim, cmd) => whyNoPlot(sim, cmd.to),
      apply(sim, cmd) {
        const run = sim.state.run;
        run.plot = cmd.to;
        sim.events.emit('course.plotted', { to: cmd.to, from: run.at, tick: sim.state.tick });
      },
    },
    // Jump down the plotted lane once the sensors have a fix (out of a fight; in one, ship.jump is an escape).
    'course.jump': {
      check: (sim) => whyNoCourseJump(sim),
      apply(sim) {
        if (sim.state.fight) endFight(sim); // a decided fight left on the screen
        travel(sim, sim.state.run.plot, 'jump', newShipState);
      },
    },
    // Fill the tanks at a port. Free for now: S3.4 gives it a price.
    'port.refuel': {
      check: (sim) => whyNoRefuel(sim),
      apply(sim) {
        const run = sim.state.run;
        const bought = run.fuelMax - run.fuel;
        run.fuel = run.fuelMax;
        sim.events.emit('port.refueled', { node: run.at, bought, fuel: run.fuel, tick: sim.state.tick });
      },
    },
    // Debug panel only: fuel, the sensor fix, and the pursuer (on from the origin, off, or alongside now).
    'debug.run': {
      check(sim, cmd) {
        const run = sim.state.run;
        if (!run) return 'there is no chart for this run';
        if (cmd.fuel !== undefined && !(Number.isInteger(cmd.fuel) && cmd.fuel >= 0 && cmd.fuel <= run.fuelMax)) return `fuel must be a whole number from 0 to ${run.fuelMax}`;
        if (cmd.pursuit !== undefined && !['on', 'off', 'catch'].includes(cmd.pursuit)) return 'pursuit must be on, off or catch';
        if (cmd.pursuit === 'catch' && sim.state.fight && !sim.state.fight.over) return 'already in a fight';
        if (cmd.fix !== undefined && cmd.fix !== true) return 'fix can only be true';
        return cmd.fuel === undefined && cmd.pursuit === undefined && cmd.fix === undefined ? 'needs fuel, pursuit or fix' : null;
      },
      apply(sim, cmd) {
        const run = sim.state.run;
        if (cmd.fuel !== undefined) run.fuel = cmd.fuel;
        if (cmd.fix) sim.state.fix = 1;
        if (cmd.pursuit === 'off') run.pursuit = null;
        if (cmd.pursuit === 'on') run.pursuit = newPursuit(run.rule, run.map.start);
        if (cmd.pursuit === 'catch') {
          run.pursuit = { ...(run.pursuit ?? newPursuit(run.rule, run.at)), at: run.at, wait: 0, done: false };
          caught(sim, newShipState);
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
  if (!(Number.isInteger(run.jumps) && run.jumps >= 0)) problems.push(`run: jumps is ${run.jumps}`);
  if (run.plot !== null && !laneBetween(run.map, run.at, run.plot)) problems.push(`run: the course to ${run.plot} has no lane from ${run.at}`);
  if (run.pursuit && !has(run.pursuit.at)) problems.push(`run: the pursuer is at "${run.pursuit.at}"`);
  if (!run.visited.includes(run.at)) problems.push('run: where we are is not in the visited list');
  return problems;
}
