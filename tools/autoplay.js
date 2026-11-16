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
// S1.3: the bot works doors and lights all over the ship, jams and frees doors
// through the debug command, and pauses at random. Its strategy and the
// report grow stage by stage (PLAN.md §4).

import { createClock } from '../src/engine/clock.js';
import { createContent } from '../src/engine/content.js';
import { findBadNumbers, hashState } from '../src/engine/hash.js';
import { createRng } from '../src/engine/rng.js';
import { DOOR_SECONDS, TICK_RATE, TICK_SECONDS, checkInvariants, createSim } from '../src/sim/sim.js';
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

/** The longest a door can take to finish moving, plus a margin. Longer means stuck. */
const MAX_DOOR_TICKS = Math.ceil(DOOR_SECONDS * TICK_RATE) + 3;

/** Play one run to the end. Returns its stats, or throws on any failure. */
function playRun(seed) {
  const sim = createSim({ seed, ship });
  const clock = createClock({ sim, tickSeconds: TICK_SECONDS });
  // The bot's own dice, kept apart from the sim's so its choices are not part of the game state.
  const bot = createRng(`bot:${seed}`);
  const stats = { orders: 0, refused: 0, dropped: 0, doorMoves: 0, pauses: 0 };
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

  /** Give an order the way a player would: only if the game would accept it. */
  function order(command) {
    if (sim.whyNot(command)) {
      stats.refused += 1;
      return;
    }
    sim.enqueue(command);
    stats.orders += 1;
  }

  function act() {
    const roll = bot.next();
    if (roll < 0.6) {
      order({ type: 'door.set', door: bot.pick(sim.layout.doors).id, state: bot.pick(['open', 'closed', 'locked']) });
    } else if (roll < 0.85) {
      order({ type: 'room.lights', room: bot.pick(sim.layout.rooms).id, on: bot.chance(0.5) });
    } else if (roll < 0.95) {
      const door = bot.pick(sim.layout.doors).id;
      order({ type: 'debug.door', door, jammed: sim.state.doors[door].state !== 'jammed' });
    } else {
      order({ type: 'debug.room', room: bot.pick(sim.layout.rooms).id, set: { fire: bot.next(), breach: bot.next(), oxygen: bot.next() } });
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

const started = performance.now();
const failures = [];
const totals = { orders: 0, refused: 0, dropped: 0, doorMoves: 0, pauses: 0 };
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
console.log(`  pauses per run:    ${per(totals.pauses)} (state checked every paused frame)`);
console.log(`  wall time:         ${seconds.toFixed(2)}s`);

if (failures.length) {
  for (const failure of failures.slice(0, 20)) console.error(`FAILED seed ${failure.seed}: ${failure.reason}`);
  if (failures.length > 20) console.error(`...and ${failures.length - 20} more`);
  process.exit(1);
}
console.log('\nPASSED: no crashes, no stuck doors, nothing moved while paused, every run replays from its seed.');
