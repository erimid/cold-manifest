// The ship AI's voice: when M.A.R.G.O. speaks, and which line she picks
// (brief §9). DOM-free; the text box in src/ui/ only shows what this decides.
//
// Her timers run on the sim clock like everything else, so she does not talk
// while the game is paused. Things that happen ask for a line in a category;
// requests wait in a short queue by priority, go stale and are dropped, and
// are spoken one at a time, never over each other.
//
// S1.7 is the frame for Stage 5: about 40 placeholder lines, a handful of
// triggers, and no trust, memory or damage behaviour yet.

import { slotsIn } from '../engine/content-schema.js';
import { aiCoreStatus } from '../sim/power.js';

const TICKS = 20; // per second (DECISIONS D-002); voice.js is imported by sim.js, so it cannot import the constant back

/** Seconds a line stays up: a base, plus reading time per character, plus a breath before the next. */
export const LINE_BASE_SECONDS = 1.4;
export const LINE_SECONDS_PER_CHAR = 0.045;
export const LINE_GAP_SECONDS = 0.6;
/** Calm periods: one idle remark every 45 to 90 seconds (brief §9). */
export const IDLE_MIN_SECONDS = 45;
export const IDLE_MAX_SECONDS = 90;
export const QUEUE_MAX = 6;
export const LOG_MAX = 60;

const crewName = (sim, event) => ({ crew_name: sim.state.crew[event.crew]?.name });

/**
 * What makes her speak. For each game event: the line category, how urgent it
 * is (higher goes first), how many seconds the remark stays worth making,
 * how long before the same trigger may speak again, and the odds she bothers.
 */
export const TRIGGERS = Object.freeze({
  'run.start': { category: 'greeting', priority: 2, ttl: 30 },
  idle: { category: 'idle', priority: 0, ttl: 6 },
  'crew.ordered': { category: 'order_confirm', priority: 1, ttl: 4, cooldown: 10, chance: 0.4, slots: crewName },
  'power.brownout': { category: 'hazard', priority: 3, ttl: 10, cooldown: 30 },
  'crew.hurt': { category: 'crew_injury', priority: 3, ttl: 12, cooldown: 15, slots: crewName },
  'fire.started': { category: 'hazard', priority: 4, ttl: 12, cooldown: 20 },
  'breach.opened': { category: 'hazard', priority: 4, ttl: 12, cooldown: 20 },
  'room.jettisoned': { category: 'hazard', priority: 4, ttl: 15 },
  'crew.died': { category: 'crew_death', priority: 5, ttl: 40, slots: crewName },
  'fight.started': { category: 'combat_start', priority: 4, ttl: 15 },
  'fight.over': { category: 'combat_end', priority: 3, ttl: 20 },
});

export function newVoiceState() {
  return {
    queue: [], // remarks waiting: { trigger, priority, expires, slots }
    speaking: null, // { id, until } while a line is up
    nextIdle: 0, // tick of the next idle remark, set on the first tick
    cooldowns: {}, // trigger -> tick it may speak again
    heard: {}, // line id -> tick last spoken this run
    log: [], // the last LOG_MAX lines spoken: { n, tick, id, category, priority, text }
    said: 0, // lines spoken this run
  };
}

function scheduleIdle(sim) {
  const wait = sim.rng.stream('ai').range(IDLE_MIN_SECONDS, IDLE_MAX_SECONDS);
  sim.state.ai.nextIdle = sim.state.tick + Math.round(wait * TICKS);
}

/** Ask for a remark. It may be dropped: on cooldown, by the odds, or because the queue is full of more urgent things. */
export function requestLine(sim, trigger, event = {}) {
  const rule = TRIGGERS[trigger];
  const ai = sim.state.ai;
  const { tick } = sim.state;
  if (!rule || (ai.cooldowns[trigger] ?? 0) > tick) return false;
  if (rule.chance !== undefined && !sim.rng.stream('ai').chance(rule.chance)) return false;
  if (rule.cooldown) ai.cooldowns[trigger] = tick + rule.cooldown * TICKS;
  const slots = rule.slots ? rule.slots(sim, event) : {};
  ai.queue.push({ trigger, priority: rule.priority, expires: tick + rule.ttl * TICKS, slots });
  if (ai.queue.length > QUEUE_MAX) {
    // Lose the least urgent; among equals, the oldest.
    let drop = 0;
    for (let i = 1; i < ai.queue.length; i++) if (ai.queue[i].priority < ai.queue[drop].priority) drop = i;
    ai.queue.splice(drop, 1);
  }
  return true;
}

/** The lines that fit a remark: right category, right trigger, and every slot they use is known. */
export function candidates(lines, entry) {
  const rule = TRIGGERS[entry.trigger];
  return lines.filter((line) => {
    if (line.category !== rule.category) return false;
    const wanted = line.conditions?.trigger;
    if (wanted !== undefined && wanted !== entry.trigger) return false;
    return slotsIn(line.text).every((slot) => typeof entry.slots[slot] === 'string' && entry.slots[slot]);
  });
}

/** Pick a line: one not heard this run if there is one, otherwise the ones heard longest ago (brief §9). */
function pickLine(sim, entry) {
  const pool = candidates(sim.lines, entry);
  if (!pool.length) return null;
  const { heard } = sim.state.ai;
  let choices = pool.filter((line) => heard[line.id] === undefined);
  if (!choices.length) {
    const oldest = Math.min(...pool.map((line) => heard[line.id]));
    choices = pool.filter((line) => heard[line.id] === oldest);
  }
  return sim.rng.stream('ai').weighted(choices);
}

const fill = (text, slots) => text.replace(/\{([^{}]*)\}/g, (_, slot) => slots[slot]);

function speak(sim, entry, line) {
  const ai = sim.state.ai;
  const text = fill(line.text, entry.slots);
  const seconds = LINE_BASE_SECONDS + text.length * LINE_SECONDS_PER_CHAR + LINE_GAP_SECONDS;
  ai.speaking = { id: line.id, until: sim.state.tick + Math.ceil(seconds * TICKS) };
  ai.heard[line.id] = sim.state.tick;
  ai.said += 1;
  const spoken = { n: ai.said, tick: sim.state.tick, id: line.id, category: line.category, priority: entry.priority, text };
  ai.log.push(spoken);
  if (ai.log.length > LOG_MAX) ai.log.shift();
  scheduleIdle(sim);
  sim.events.emit('ai.line', { ...spoken, trigger: entry.trigger });
}

/** Listen for the things she remarks on. Called once when the sim is created. */
export function attachVoice(sim) {
  for (const trigger of Object.keys(TRIGGERS)) {
    if (trigger === 'idle' || trigger === 'run.start') continue;
    sim.events.on(trigger, (event) => requestLine(sim, trigger, event));
  }
}

/** One tick of her timers. */
export function stepVoice(sim) {
  const ai = sim.state.ai;
  const { tick } = sim.state;
  if (tick === 1) {
    scheduleIdle(sim);
    requestLine(sim, 'run.start');
  }
  // With no power to her core she says nothing, and forgets what she was about to say.
  if (aiCoreStatus(sim).state === 'offline') {
    ai.queue.length = 0;
    if (ai.speaking && tick >= ai.speaking.until) ai.speaking = null;
    return;
  }
  if (ai.speaking) {
    if (tick < ai.speaking.until) return;
    ai.speaking = null;
  }
  if (tick >= ai.nextIdle && !ai.queue.length) {
    requestLine(sim, 'idle');
    scheduleIdle(sim);
  }
  // Stale remarks are dropped, then the most urgent goes first (oldest first among equals).
  ai.queue = ai.queue.filter((entry) => entry.expires > tick);
  while (ai.queue.length) {
    let top = 0;
    for (let i = 1; i < ai.queue.length; i++) if (ai.queue[i].priority > ai.queue[top].priority) top = i;
    const [entry] = ai.queue.splice(top, 1);
    const line = pickLine(sim, entry);
    if (line) {
      speak(sim, entry, line);
      return;
    }
  }
}

/** Voice problems that should never happen. */
export function checkVoiceInvariants(sim) {
  const problems = [];
  const ai = sim.state.ai;
  if (ai.queue.length > QUEUE_MAX) problems.push(`the AI queue holds ${ai.queue.length} remarks`);
  if (ai.log.length > LOG_MAX) problems.push(`the AI log holds ${ai.log.length} lines`);
  for (const line of ai.log) if (/[{}]/.test(line.text)) problems.push(`an unfilled slot was spoken: "${line.text}"`);
  return problems;
}
