#!/usr/bin/env node
// Headless autoplay (brief §19). Run with: npm run autoplay -- --runs 100
//
// Plays seeded runs of the simulation with no browser and reports what
// happened. A crash, a broken invariant, or a run that does not replay
// identically from its seed is a failure.
//
//   --runs N       how many seeded runs (default 100)
//   --minutes M    game minutes per run (default 10)
//   --seed S       base seed; run i uses "S-i" (default "auto")
//
// S1.1: the sim is a stub, so there is nothing for a bot to decide yet. This
// already checks the three things every later version must keep true:
// no crashes, healthy state, and exact replay from the seed. The bot's
// strategy and the full report grow stage by stage (PLAN.md §4).

import { findBadNumbers, hashState } from '../src/engine/hash.js';
import { TICK_RATE, checkInvariants, createSim } from '../src/sim/sim.js';

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

/** Play one run to the end. Returns its final state hash, or throws on a broken invariant. */
function playRun(seed) {
  const sim = createSim({ seed });
  for (let t = 0; t < ticks; t++) {
    sim.step();
    const problems = checkInvariants(sim);
    if (problems.length) throw new Error(`tick ${sim.state.tick}: ${problems.join('; ')}`);
  }
  const bad = findBadNumbers(sim.state);
  if (bad.length) throw new Error(`non-finite numbers at ${bad.join(', ')}`);
  return hashState(sim.snapshot());
}

const started = performance.now();
const failures = [];
for (let i = 1; i <= runs; i++) {
  const seed = `${baseSeed}-${i}`;
  try {
    const first = playRun(seed);
    const second = playRun(seed);
    if (first !== second) failures.push({ seed, reason: `replay mismatch (${first} vs ${second})` });
  } catch (err) {
    failures.push({ seed, reason: err.message });
  }
}
const seconds = (performance.now() - started) / 1000;

console.log('Cold Manifest autoplay');
console.log(`  runs:            ${runs} (seeds ${baseSeed}-1 to ${baseSeed}-${runs})`);
console.log(`  length:          ${minutes} game minute(s) each, ${ticks} ticks`);
console.log(`  crashed or bad:  ${failures.length}`);
console.log(`  replayed exact:  ${runs - failures.length} of ${runs}`);
console.log(`  wall time:       ${seconds.toFixed(2)}s`);

if (failures.length) {
  for (const failure of failures.slice(0, 20)) console.error(`FAILED seed ${failure.seed}: ${failure.reason}`);
  if (failures.length > 20) console.error(`...and ${failures.length - 20} more`);
  process.exit(1);
}
console.log('\nPASSED: no crashes, no broken invariants, every run replays from its seed.');
