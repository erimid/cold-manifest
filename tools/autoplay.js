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
//
// S1.2: the bot sends probes around the test bay and pauses at random. Its
// strategy and the report grow stage by stage (PLAN.md §4).

import { createClock } from '../src/engine/clock.js';
import { findBadNumbers, hashState } from '../src/engine/hash.js';
import { createRng } from '../src/engine/rng.js';
import { BAY, TICK_RATE, TICK_SECONDS, checkInvariants, createSim } from '../src/sim/sim.js';

function option(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const runs = Number(option('runs', 100));
const minutes = Number(option('minutes', 10));
const baseSeed = String(option('seed', 'auto'));
if (!Number.isInteger(runs) || runs <= 0 || !(minutes > 0)) {
  console.error('Usage: node tools/autoplay.js [--runs N] [--minutes M] [--seed S]');
  process.exit(2);
}
const ticks = Math.round(minutes * 60 * TICK_RATE);

/** The longest any order can take: corner to corner, plus a margin. Longer means stuck. */
const MAX_TRIP_TICKS = Math.ceil((Math.hypot(BAY.width, BAY.height) / BAY.probeSpeed) * TICK_RATE) + 5;

/** Play one run to the end. Returns its stats, or throws on any failure. */
function playRun(seed) {
  const sim = createSim({ seed });
  const clock = createClock({ sim, tickSeconds: TICK_SECONDS });
  // The bot's own dice, kept apart from the sim's so its choices are not part of the game state.
  const bot = createRng(`bot:${seed}`);
  const stats = { orders: 0, arrivals: 0, pauses: 0, pausedFrames: 0 };
  const movingSince = new Map();

  sim.events.on('command.applied', ({ command, tick }) => movingSince.set(command.probe, tick));
  sim.events.on('probe.arrived', ({ probe }) => {
    stats.arrivals += 1;
    movingSince.delete(probe);
  });

  let pausedFor = 0;
  let pausedHash = null;

  // One frame per tick: the bot sees and acts exactly as often as the sim steps.
  while (sim.state.tick < ticks) {
    // The bot gives an order now and then, paused or not.
    if (bot.chance(0.02)) {
      const probe = bot.pick(sim.state.probes);
      sim.enqueue({ type: 'probe.move', probe: probe.id, x: bot.range(-50, BAY.width + 50), y: bot.range(-50, BAY.height + 50) });
      stats.orders += 1;
      if (clock.paused) pausedHash = hashState(sim.snapshot()); // the queue grew; that is allowed
    }

    if (clock.paused) {
      stats.pausedFrames += 1;
      const ran = clock.advance(TICK_SECONDS);
      if (ran !== 0) throw new Error(`clock ran ${ran} tick(s) while paused`);
      if (hashState(sim.snapshot()) !== pausedHash) throw new Error(`state changed while paused at tick ${sim.state.tick}`);
      if (--pausedFor <= 0) clock.resume();
      continue;
    }

    clock.advance(TICK_SECONDS);

    const problems = checkInvariants(sim);
    if (problems.length) throw new Error(`tick ${sim.state.tick}: ${problems.join('; ')}`);
    for (const [probe, since] of movingSince) {
      if (sim.state.tick - since > MAX_TRIP_TICKS) throw new Error(`${probe} stuck: moving since tick ${since}, now ${sim.state.tick}`);
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
const totals = { orders: 0, arrivals: 0, pauses: 0 };
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
console.log(`  orders per run:    ${per(totals.orders)} given, ${per(totals.arrivals)} arrivals`);
console.log(`  pauses per run:    ${per(totals.pauses)} (state checked every paused frame)`);
console.log(`  wall time:         ${seconds.toFixed(2)}s`);

if (failures.length) {
  for (const failure of failures.slice(0, 20)) console.error(`FAILED seed ${failure.seed}: ${failure.reason}`);
  if (failures.length > 20) console.error(`...and ${failures.length - 20} more`);
  process.exit(1);
}
console.log('\nPASSED: no crashes, no stuck probes, nothing moved while paused, every run replays from its seed.');
