#!/usr/bin/env node
// Headless autoplay (brief §19). Run with: npm run autoplay -- --runs 100
//
// A bot plays seeded runs of the simulation with no browser, through the same
// clock and command queue a player uses. A crash, a broken invariant, a stuck
// state, anything changing while paused, or a run that does not replay
// identically from its seed is a failure.
//
//   --runs N       how many seeded runs (default 100)
//   --minutes M    game minutes per run (default 10)
//   --seed S       base seed; run i uses "S-i" (default "auto")
//   --ship ID      ship layout to fly (default "margin-of-error")
//
// S1.6: the bot sends three crew around the ship to deal with whatever is
// worst, suits them up for breaches, works doors, airlocks and lights, routes
// power, starts fires and breaches, breaks systems and jams doors through the
// debug commands, now and then jettisons a room, and pauses at random. Its strategy and the
// report grow stage by stage (PLAN.md §4).

import { createClock } from '../src/engine/clock.js';
import { createContent } from '../src/engine/content.js';
import { findBadNumbers, hashState } from '../src/engine/hash.js';
import { createRng } from '../src/engine/rng.js';
import { POWERED, used, supply } from '../src/sim/power.js';
import { MANUAL_DOOR_SECONDS, TICK_RATE, TICK_SECONDS, checkInvariants, createSim } from '../src/sim/sim.js';
import { readContentFiles } from './lib/load-content.js';

function option(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const runs = Number(option('runs', 100));
const minutes = Number(option('minutes', 10));
const baseSeed = String(option('seed', 'auto'));
if (!Number.isInteger(runs) || runs <= 0 || !(minutes > 0)) {
  console.error('Usage: node tools/autoplay.js [--runs N] [--minutes M] [--seed S] [--ship ID]');
  process.exit(2);
}
const ticks = Math.round(minutes * 60 * TICK_RATE);

const content = createContent(readContentFiles());
const shipId = String(option('ship', 'margin-of-error'));
const ship = content.require('ships', shipId);
const roster = content.all('crew').map(({ id, name }) => ({ id, name }));

/** The longest anyone should stand still with somewhere to be: a hand-worked door, with a wide margin. */
const MAX_STILL_TICKS = 200;

/** The longest a door can take to finish moving, plus a margin. Longer means stuck. */
const MAX_DOOR_TICKS = Math.ceil(MANUAL_DOOR_SECONDS * TICK_RATE) + 3;

/** Play one run to the end. Returns its stats, or throws on any failure. */
function playRun(seed) {
  const sim = createSim({ seed, ship, crew: roster });
  const clock = createClock({ sim, tickSeconds: TICK_SECONDS });
  // The bot's own dice, kept apart from the sim's so its choices are not part of the game state.
  const bot = createRng(`bot:${seed}`);
  const stats = { orders: 0, refused: 0, dropped: 0, doorMoves: 0, pauses: 0, powerMoves: 0, brownouts: 0, darkTicks: 0, fires: 0, spreads: 0, firesOut: 0, scorched: 0, jettisons: 0, airlessTicks: 0, moves: 0, arrivals: 0, blocked: 0, deaths: 0, firesFought: 0, patches: 0, repairs: 0 };
  const stillSince = new Map(); // crew id -> { tick, x, y } where they last made progress
  const movingSince = new Map(); // door id -> tick its last order was applied

  sim.events.on('door.changed', ({ door, tick }) => movingSince.set(door, tick));
  sim.events.on('door.opened', ({ door }) => {
    stats.doorMoves += 1;
    movingSince.delete(door);
  });
  sim.events.on('door.closed', ({ door }) => {
    stats.doorMoves += 1;
    movingSince.delete(door);
  });
  sim.events.on('command.dropped', () => (stats.dropped += 1));
  sim.events.on('power.changed', ({ reason }) => reason === 'order' && (stats.powerMoves += 1));
  sim.events.on('power.brownout', () => (stats.brownouts += 1));
  sim.events.on('fire.started', ({ cause }) => (cause === 'spread' ? (stats.spreads += 1) : (stats.fires += 1)));
  sim.events.on('fire.out', () => (stats.firesOut += 1));
  sim.events.on('system.damage', ({ cause }) => cause === 'fire' && (stats.scorched += 1));
  sim.events.on('room.jettisoned', () => (stats.jettisons += 1));
  sim.events.on('crew.ordered', () => (stats.moves += 1));
  sim.events.on('crew.arrived', () => (stats.arrivals += 1));
  sim.events.on('crew.blocked', () => (stats.blocked += 1));
  sim.events.on('crew.died', () => (stats.deaths += 1));
  sim.events.on('fire.out', ({ by }) => by && (stats.firesFought += 1));
  sim.events.on('breach.sealed', () => (stats.patches += 1));
  sim.events.on('system.repaired', () => (stats.repairs += 1));

  /** Give an order the way a player would: only if the game would accept it. */
  function order(command) {
    if (sim.whyNot(command)) {
      stats.refused += 1;
      return;
    }
    sim.enqueue(command);
    stats.orders += 1;
  }

  /** The room that most needs someone: fire, then a breach, then damage. Sometimes just anywhere. */
  function troubleSpot() {
    const rooms = sim.layout.rooms.filter((room) => !sim.state.rooms[room.id].jettisoned);
    if (bot.chance(0.25)) return bot.pick(rooms);
    const score = (room) => {
      const r = sim.state.rooms[room.id];
      const system = room.system ? sim.state.systems[room.system] : null;
      return r.fire * 3 + r.breach * 2 + (system && !system.lost ? system.damage : 0);
    };
    const worst = rooms.reduce((a, b) => (score(b) > score(a) ? b : a));
    return score(worst) > 0 ? worst : bot.pick(rooms);
  }

  function crewAct() {
    const alive = Object.values(sim.state.crew).filter((member) => member.alive);
    if (!alive.length) return;
    const member = bot.pick(alive);
    if (bot.chance(0.15)) return order({ type: 'crew.suit', crew: member.id, on: !member.suit });
    const room = troubleSpot();
    if (sim.state.rooms[room.id].breach > 0 && !member.suit) order({ type: 'crew.suit', crew: member.id, on: true });
    order({ type: 'crew.move', crew: member.id, room: room.id });
  }

  function act() {
    if (bot.chance(0.3)) return crewAct();
    const roll = bot.next();
    if (roll < 0.25) {
      // Like a player, it wants the doors working: half the time it tries to get door control back first.
      if (sim.state.systems.doors.power === 0 && bot.chance(0.5)) {
        order({ type: 'debug.system', system: 'doors', damage: 0 });
        if (!sim.whyNot({ type: 'power.add', system: 'doors', delta: 1 })) order({ type: 'power.add', system: 'doors', delta: 1 });
        else order({ type: 'power.add', system: bot.pick(POWERED.filter((id) => id !== 'doors')), delta: -1 });
      } else order({ type: 'power.add', system: bot.pick(POWERED), delta: bot.chance(0.55) ? 1 : -1 });
    } else if (roll < 0.32) {
      const system = bot.pick(Object.keys(sim.state.systems));
      order({ type: 'debug.system', system, damage: bot.chance(0.5) ? 0 : bot.between(0, sim.state.systems[system].level) });
    } else if (roll < 0.6) {
      order({ type: 'door.set', door: bot.pick(sim.layout.doors).id, state: bot.pick(['open', 'closed', 'locked']) });
    } else if (roll < 0.85) {
      order({ type: 'room.lights', room: bot.pick(sim.layout.rooms).id, on: bot.chance(0.5) });
    } else if (roll < 0.95) {
      const door = bot.pick(sim.layout.doors).id;
      order({ type: 'debug.door', door, jammed: sim.state.doors[door].state !== 'jammed' });
    } else if (roll < 0.985) {
      // Trouble: usually a fire or a breach, sometimes both, and sometimes it gets patched.
      const set = bot.chance(0.3) ? { fire: 0, breach: 0 } : bot.chance(0.5) ? { fire: bot.next() } : { breach: bot.next() };
      order({ type: 'debug.room', room: bot.pick(sim.layout.rooms).id, set });
    } else {
      order({ type: 'room.jettison', room: bot.pick(sim.layout.rooms).id });
    }
  }

  let pausedFor = 0;
  let pausedHash = null;

  // One frame per tick: the bot sees and acts exactly as often as the sim steps.
  while (sim.state.tick < ticks) {
    // The bot gives an order now and then, paused or not.
    if (bot.chance(0.05)) {
      act();
      if (clock.paused) pausedHash = hashState(sim.snapshot()); // the queue may have grown; that is allowed
    }

    if (clock.paused) {
      const ran = clock.advance(TICK_SECONDS);
      if (ran !== 0) throw new Error(`clock ran ${ran} tick(s) while paused`);
      if (hashState(sim.snapshot()) !== pausedHash) throw new Error(`state changed while paused at tick ${sim.state.tick}`);
      if (--pausedFor <= 0) clock.resume();
      continue;
    }

    clock.advance(TICK_SECONDS);

    const problems = checkInvariants(sim);
    if (problems.length) throw new Error(`tick ${sim.state.tick}: ${problems.join('; ')}`);
    if (used(sim) > supply(sim)) throw new Error(`tick ${sim.state.tick}: ${used(sim)} bars in use of ${supply(sim)}`);
    if (sim.state.systems.doors.power === 0) stats.darkTicks += 1;
    for (const room of Object.values(sim.state.rooms)) if (!room.jettisoned && room.oxygen < 0.15) stats.airlessTicks += 1;
    for (const member of Object.values(sim.state.crew)) {
      const last = stillSince.get(member.id);
      if (!member.alive || !member.path.length || !last || last.x !== member.x || last.y !== member.y) {
        stillSince.set(member.id, { tick: sim.state.tick, x: member.x, y: member.y });
      } else if (sim.state.tick - last.tick > MAX_STILL_TICKS) {
        throw new Error(`${member.id} stuck on a path in ${member.room} at ${member.x.toFixed(2)}, ${member.y.toFixed(2)} since tick ${last.tick} (${member.task}, next ${JSON.stringify(member.path[0])})`);
      }
    }
    for (const [door, since] of movingSince) {
      const d = sim.state.doors[door];
      const settled = d.state === 'jammed' || d.openness === (d.state === 'open' ? 1 : 0);
      if (settled) movingSince.delete(door);
      else if (sim.state.tick - since > MAX_DOOR_TICKS) throw new Error(`${door} stuck: ${d.state} at ${d.openness} since tick ${since}, now ${sim.state.tick}`);
    }

    if (bot.chance(0.004)) {
      clock.pause('bot');
      pausedFor = bot.between(1, 60);
      pausedHash = hashState(sim.snapshot());
      stats.pauses += 1;
    }
  }

  const bad = findBadNumbers(sim.state);
  if (bad.length) throw new Error(`non-finite numbers at ${bad.join(', ')}`);
  return { ...stats, hash: hashState(sim.snapshot()) };
}

const sim0Rooms = ship.rooms.length;
const started = performance.now();
const failures = [];
const totals = { orders: 0, refused: 0, dropped: 0, doorMoves: 0, pauses: 0, powerMoves: 0, brownouts: 0, darkTicks: 0, fires: 0, spreads: 0, firesOut: 0, scorched: 0, jettisons: 0, airlessTicks: 0, moves: 0, arrivals: 0, blocked: 0, deaths: 0, firesFought: 0, patches: 0, repairs: 0 };
for (let i = 1; i <= runs; i++) {
  const seed = `${baseSeed}-${i}`;
  try {
    const first = playRun(seed);
    const second = playRun(seed);
    if (first.hash !== second.hash) failures.push({ seed, reason: `replay mismatch (${first.hash} vs ${second.hash})` });
    for (const key of Object.keys(totals)) totals[key] += first[key];
  } catch (err) {
    failures.push({ seed, reason: err.message });
  }
}
const seconds = (performance.now() - started) / 1000;
const per = (n) => (n / runs).toFixed(1);

console.log('Cold Manifest autoplay');
console.log(`  runs:              ${runs} (seeds ${baseSeed}-1 to ${baseSeed}-${runs})`);
console.log(`  length:            ${minutes} game minute(s) each, ${ticks} ticks`);
console.log(`  crashed or bad:    ${failures.length}`);
console.log(`  replayed exact:    ${runs - failures.length} of ${runs}`);
console.log(`  ship:              ${ship.name}`);
console.log(`  orders per run:    ${per(totals.orders)} given, ${per(totals.refused)} refused up front, ${per(totals.dropped)} dropped`);
console.log(`  door moves:        ${per(totals.doorMoves)} completed per run`);
console.log(`  power per run:     ${per(totals.powerMoves)} bars routed, ${per(totals.brownouts)} brownouts, door control dark ${((100 * totals.darkTicks) / (runs * ticks)).toFixed(0)}% of the time`);
console.log(`  hazards per run:   ${per(totals.fires)} fires lit, ${per(totals.spreads)} spread, ${per(totals.firesOut)} went out, ${per(totals.scorched)} system bars burned, ${per(totals.jettisons)} rooms jettisoned`);
console.log(`  crew per run:      ${per(totals.moves)} sent, ${per(totals.arrivals)} arrived, ${per(totals.blocked)} blocked, ${per(totals.deaths)} of ${roster.length} died`);
console.log(`  crew work per run: ${per(totals.firesFought)} fires put out, ${per(totals.patches)} breaches patched, ${per(totals.repairs)} system bars repaired`);
console.log(`  air:               rooms were unbreathable ${((100 * totals.airlessTicks) / (runs * ticks * sim0Rooms)).toFixed(0)}% of room-time`);
console.log(`  pauses per run:    ${per(totals.pauses)} (state checked every paused frame)`);
console.log(`  wall time:         ${seconds.toFixed(2)}s`);

if (failures.length) {
  for (const failure of failures.slice(0, 20)) console.error(`FAILED seed ${failure.seed}: ${failure.reason}`);
  if (failures.length > 20) console.error(`...and ${failures.length - 20} more`);
  process.exit(1);
}
console.log('\nPASSED: no crashes, no stuck doors, no crew stuck on a path, power never over supply, no fire without air, nothing moved while paused, every run replays from its seed.');
