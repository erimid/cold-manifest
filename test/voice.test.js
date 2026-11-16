import assert from 'node:assert/strict';
import { test } from 'node:test';

import { IDLE_MAX_SECONDS, LOG_MAX, QUEUE_MAX, TRIGGERS, candidates, requestLine } from '../src/ai/voice.js';
import { AI_CATEGORIES } from '../src/ai/categories.js';
import { TICK_RATE, checkInvariants } from '../src/sim/sim.js';
import { LINES, content, newCrewedSim, newTalkingSim } from './helpers.js';

/** Margo's risks, from content/. */
const RISKS = Object.fromEntries(content.all('risks').map((rule) => [rule.id, rule]));

const seconds = (sim, s) => {
  for (let i = 0; i < Math.round(s * TICK_RATE); i++) sim.step();
};
const give = (sim, ...commands) => {
  for (const command of commands) sim.enqueue(command);
  sim.step();
};
const said = (sim) => sim.state.ai.log.map((line) => line.category);

test('placeholder lines are flagged, the voice sample is 50 real lines, and every trigger has lines', () => {
  const placeholders = LINES.filter((line) => line.id.startsWith('ph.'));
  const sample = LINES.filter((line) => line.id.startsWith('vs.'));
  assert.equal(placeholders.length + sample.length, LINES.length);
  assert.ok(placeholders.length >= 40, `${placeholders.length} placeholder lines`);
  assert.ok(placeholders.every((line) => line.placeholder === true));
  assert.equal(sample.length, 50, 'the voice sample is 50 lines (S2.10)');
  assert.ok(sample.every((line) => line.placeholder === undefined), 'sample lines are real: they count toward coverage');
  const known = new Set(AI_CATEGORIES.map((c) => c.id));
  for (const [trigger, rule] of Object.entries(TRIGGERS)) {
    assert.ok(known.has(rule.category), `${trigger} uses a real category`);
    // Whatever the risk, she has at least three ways to say it.
    // She only refuses the monstrous ones.
    for (const risk of trigger === 'ai.refused' ? Object.keys(RISKS).filter((id) => RISKS[id].grave) : [null, ...Object.keys(RISKS)]) {
      const fits = candidates(LINES, { trigger, risk, slots: { crew_name: 'Ilse', room: 'Medbay' } });
      assert.ok(fits.length >= 3, `${trigger} has ${fits.length} lines${risk ? ` for ${risk}` : ''}`);
    }
  }
  for (const line of LINES) {
    // A line that names a trigger or a risk must name a real one.
    if (line.conditions?.trigger) assert.ok(TRIGGERS[line.conditions.trigger], line.id);
    for (const risk of [].concat(line.conditions?.risk ?? [])) assert.ok(RISKS[risk], `${line.id} names risk ${risk}`);
  }
  // Most of her lines are short (brief §9: most under 25 words).
  const long = sample.filter((line) => line.text.split(/\s+/).length > 25);
  assert.ok(long.length <= 3, `long sample lines: ${long.map((line) => line.id).join(', ')}`);
  assert.ok(sample.every((line) => !line.text.includes('!')), 'she does not shout');
});

test('she greets the captain at the start of a run, then waits before idle talk', () => {
  const sim = newTalkingSim();
  const heard = [];
  sim.events.on('ai.line', (e) => heard.push(e));
  sim.step();
  assert.deepEqual(said(sim), ['greeting']);
  assert.equal(heard[0].trigger, 'run.start');
  assert.equal(heard[0].text, sim.state.ai.log[0].text);
  seconds(sim, 30);
  assert.deepEqual(said(sim), ['greeting'], 'nothing more in the first half minute of calm');
  seconds(sim, IDLE_MAX_SECONDS);
  assert.deepEqual(said(sim).slice(0, 2), ['greeting', 'idle']);
});

test('in calm she speaks about once every 45 to 90 seconds', () => {
  const sim = newTalkingSim('calm');
  seconds(sim, 20 * 60);
  const ticks = sim.state.ai.log.map((line) => line.tick);
  const gaps = ticks.slice(1).map((t, i) => (t - ticks[i]) / TICK_RATE);
  assert.ok(gaps.length >= 12 && gaps.length <= 27, `${gaps.length} idle lines in 20 minutes`);
  assert.ok(Math.min(...gaps) >= 45 && Math.max(...gaps) <= 95, `gaps from ${Math.min(...gaps)} to ${Math.max(...gaps)}`);
});

test('a fire gets a fire line and a breach a breach line, with slots filled for crew', () => {
  const sim = newTalkingSim();
  seconds(sim, 8);
  give(sim, { type: 'debug.room', room: 'cargo', set: { fire: 0.5 } });
  seconds(sim, 6);
  give(sim, { type: 'debug.room', room: 'brig', set: { breach: 0.5 } });
  seconds(sim, 8);
  const ids = sim.state.ai.log.map((line) => line.id);
  const byId = Object.fromEntries(LINES.map((line) => [line.id, line]));
  assert.equal(byId[ids[1]].conditions.trigger, 'fire.started');
  assert.equal(byId[ids[2]].conditions.trigger, 'breach.opened');

  sim.state.crew.dace.health = 0.01;
  give(sim, { type: 'debug.room', room: 'reactor', set: { fire: 1 } });
  seconds(sim, 12);
  const death = sim.state.ai.log.find((line) => line.category === 'crew_death');
  assert.ok(death, 'she marks the death');
  assert.match(death.text, /Dace/);
  assert.doesNotMatch(death.text, /[{}]/);
  assert.deepEqual(checkInvariants(sim), []);
});

test('lines never overlap, and the most urgent waiting remark goes first', () => {
  const sim = newTalkingSim();
  sim.step(); // the greeting is now up
  const greetingEnds = sim.state.ai.speaking.until;
  requestLine(sim, 'crew.hurt', { crew: 'ilse' });
  requestLine(sim, 'crew.died', { crew: 'okoro' });
  requestLine(sim, 'fire.started', {});
  while (sim.state.tick < greetingEnds - 1) sim.step();
  assert.equal(sim.state.ai.log.length, 1, 'nothing interrupts the line that is up');
  seconds(sim, 30);
  // The injury remark was only worth making for twelve seconds; by the time the other two were said it had gone stale.
  assert.deepEqual(said(sim), ['greeting', 'crew_death', 'hazard']);
  const log = sim.state.ai.log;
  for (let i = 1; i < log.length; i++) {
    const shown = (1.4 + log[i - 1].text.length * 0.045) * TICK_RATE;
    assert.ok(log[i].tick - log[i - 1].tick >= shown, 'each line had its reading time');
  }
});

test('stale remarks are dropped instead of being said late', () => {
  const sim = newTalkingSim();
  sim.step();
  requestLine(sim, 'crew.ordered', { crew: 'ilse' }); // may be skipped by the odds; ask until one is queued
  sim.state.ai.cooldowns = {};
  while (!sim.state.ai.queue.length) {
    sim.state.ai.cooldowns = {};
    requestLine(sim, 'crew.ordered', { crew: 'ilse' });
  }
  // Keep her busy past the order remark's four seconds.
  sim.state.ai.speaking.until = sim.state.tick + 6 * TICK_RATE;
  seconds(sim, 10);
  assert.deepEqual(said(sim), ['greeting']);
  assert.equal(sim.state.ai.queue.length, 0);
});

test('the queue is bounded and keeps the urgent remarks', () => {
  const sim = newTalkingSim();
  sim.step();
  for (let i = 0; i < 20; i++) {
    sim.state.ai.cooldowns = {};
    requestLine(sim, 'idle');
    requestLine(sim, 'crew.died', { crew: 'ilse' });
  }
  assert.equal(sim.state.ai.queue.length, QUEUE_MAX);
  assert.ok(sim.state.ai.queue.every((entry) => entry.trigger === 'crew.died'));
});

test('the same trigger does not chatter: spreading fires get one remark per cooldown', () => {
  const sim = newTalkingSim();
  seconds(sim, 8);
  for (const room of ['cargo', 'brig', 'weapons', 'shields']) give(sim, { type: 'debug.room', room, set: { fire: 0.4 } });
  seconds(sim, 15);
  assert.equal(said(sim).filter((c) => c === 'hazard').length, 1);
});

test('no line repeats until every line that fits has been heard', () => {
  const sim = newTalkingSim('repeat');
  const pool = candidates(LINES, { trigger: 'idle', slots: {} }).length;
  seconds(sim, pool * IDLE_MAX_SECONDS + 60);
  const idle = sim.state.ai.log.filter((line) => line.category === 'idle').map((line) => line.id);
  assert.ok(idle.length >= pool);
  assert.equal(new Set(idle.slice(0, pool)).size, pool, 'the first pass through the idle lines has no repeats');
});

test('with her core stood down she is silent, and speaks again when it is stood to', () => {
  const sim = newTalkingSim();
  seconds(sim, 8);
  give(sim, { type: 'station.stand', station: 'ai_core', down: true });
  give(sim, { type: 'debug.room', room: 'cargo', set: { fire: 0.5 } });
  seconds(sim, 200);
  assert.deepEqual(said(sim), ['greeting']);
  give(sim, { type: 'station.stand', station: 'ai_core', down: false }, { type: 'debug.room', room: 'cargo', set: { fire: 0 } }, { type: 'debug.room', room: 'brig', set: { breach: 0.3 } });
  seconds(sim, 5);
  assert.equal(said(sim).at(-1), 'hazard');
});

test('the log is bounded, the voice is seeded, and it survives a snapshot', () => {
  const a = newTalkingSim('voice');
  seconds(a, 5);
  give(a, { type: 'debug.room', room: 'cargo', set: { fire: 0.5 } }, { type: 'crew.move', crew: 'ilse', room: 'cargo' });
  seconds(a, 4);
  const b = newTalkingSim('voice');
  b.restore(JSON.parse(JSON.stringify(a.snapshot())));
  seconds(a, 300);
  seconds(b, 300);
  assert.deepEqual(a.snapshot(), b.snapshot());

  const other = newTalkingSim('another seed');
  seconds(other, 300);
  assert.notDeepEqual(other.state.ai.log.map((l) => l.id), newTalkingSim('voice').state.ai.log.map((l) => l.id));

  const long = newTalkingSim('long');
  for (let i = 0; i < 200; i++) {
    long.state.ai.cooldowns = {};
    long.state.ai.speaking = null;
    requestLine(long, 'idle');
    long.step();
  }
  assert.equal(long.state.ai.log.length, LOG_MAX);
  assert.deepEqual(checkInvariants(long), []);
});

test('a sim with no line library runs and says nothing', () => {
  const sim = newCrewedSim();
  give(sim, { type: 'debug.room', room: 'cargo', set: { fire: 0.5 } });
  seconds(sim, 120);
  assert.equal(sim.state.ai.log.length, 0);
  assert.deepEqual(checkInvariants(sim), []);
});
