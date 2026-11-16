// The ship AI's voice: when M.A.R.G.O. speaks, and which line she picks
// (brief §9). DOM-free; the text box in src/ui/ only shows what this decides.
//
// Her timers run on the sim clock like everything else, so she does not talk
// while the game is paused. Things that happen ask for a line in a category;
// requests wait in a short queue by priority, go stale and are dropped, and
// are spoken one at a time, never over each other.
//
// S1.7 is the frame for Stage 5: placeholder lines and a handful of triggers.
// S2.10 added her first real lines (the voice sample), her trust and her say
// in the captain's orders (judgement.js). Memory and damage behaviour wait
// for Stage 5.

import { slotsIn } from '../engine/content-schema.js';
import { holds } from '../narrative/conditions.js';
import { findCrew } from '../sim/combat.js';
import { aiCoreStatus } from '../sim/power.js';
import { newJudgementState } from './judgement.js';
import { unseen } from '../sim/senses.js';

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

const crewName = (sim, event) => ({ crew_name: findCrew(sim, event.crew)?.member.name ?? event.name });
/** For lines about a person in a place: an order she is holding, or one a crew member turned down. */
const crewAndRoom = (sim, event) => ({ ...crewName(sim, event), room: sim.layout.room(event.room)?.name });

/**
 * What makes her speak. For each game event: the line category, how urgent it
 * is (higher goes first), how many seconds the remark stays worth making,
 * how long before the same trigger may speak again, and the odds she bothers.
 */
export const TRIGGERS = Object.freeze({
  'run.start': { category: 'greeting', priority: 2, ttl: 30 },
  idle: { category: 'idle', priority: 0, ttl: 6 },
  'crew.ordered': { category: 'order_confirm', priority: 1, ttl: 4, cooldown: 20, chance: 0.15, slots: crewName }, // rarer since the crew answer for themselves (D-094)
  'power.brownout': { category: 'hazard', priority: 3, ttl: 10, cooldown: 30 },
  // Stations and the watch (H.4): she says when she picks up a station someone has left, when the watch turns
  // over, and when the reactor drops back from hard because nobody is on it.
  'station.taken': { category: 'order_confirm', priority: 1, ttl: 6, cooldown: 45, chance: 0.6, slots: crewAndRoom },
  'watch.changed': { category: 'idle', priority: 1, ttl: 10 },
  'power.output': { category: 'order_confirm', priority: 2, ttl: 8, cooldown: 20, when: (event) => event.reason === 'unmanned' },
  'crew.hurt': { category: 'crew_injury', priority: 3, ttl: 12, cooldown: 15, slots: crewName },
  // A fire or a hole in a room she cannot see into is not news until someone looks (senses.js): then it is "found".
  'fire.started': { category: 'hazard', priority: 4, ttl: 12, cooldown: 20, seen: true },
  'breach.opened': { category: 'hazard', priority: 4, ttl: 12, cooldown: 20, seen: true },
  'fire.found': { category: 'hazard', priority: 4, ttl: 12, cooldown: 20 },
  'breach.found': { category: 'hazard', priority: 4, ttl: 12, cooldown: 20 },
  'rooms.hidden': { category: 'sensor_uncertain', priority: 2, ttl: 10, cooldown: 90 },
  'lights.all': { category: 'order_confirm', priority: 1, ttl: 6, cooldown: 30, when: (event) => event.on === false },
  'room.jettisoned': { category: 'hazard', priority: 4, ttl: 15 },
  'crew.died': { category: 'crew_death', priority: 5, ttl: 40, slots: crewName },
  'hull.hit': { category: 'hazard', priority: 4, ttl: 6, cooldown: 15 },
  // A party aboard (boarders.js still announces it the S2.4 way, for the auto-pause and for her).
  'enemy.crew.boarded': { category: 'combat_progress', priority: 4, ttl: 10, cooldown: 30 },
  // Our guns and theirs (H.3, D-172 to D-177): the deterrent gun, warning shots, a toll, a scan, pods and drones.
  'ship.wrecked': { category: 'combat_end', priority: 6, ttl: 20, urgent: true, own: true },
  'weapon.fired': { category: 'combat_progress', priority: 2, ttl: 5, cooldown: 25, chance: 0.5, own: true },
  'contact.struck': { category: 'combat_progress', priority: 3, ttl: 6, cooldown: 15, own: true, when: (event) => event.hit },
  'contact.deterred': { category: 'combat_end', priority: 4, ttl: 12, own: true },
  'contact.fired': { category: 'combat_progress', priority: 4, ttl: 8, cooldown: 20, own: true, when: (event) => event.warn },
  'contact.toll': { category: 'combat_start', priority: 5, ttl: 15, own: true },
  'contact.scanning': { category: 'sensor_uncertain', priority: 3, ttl: 10, cooldown: 30, own: true },
  'contact.scanned': { category: 'combat_start', priority: 4, ttl: 12, own: true },
  'pods.launched': { category: 'combat_start', priority: 5, ttl: 10, own: true },
  'pod.downed': { category: 'combat_progress', priority: 3, ttl: 6, cooldown: 10, own: true },
  'drone.attached': { category: 'combat_progress', priority: 3, ttl: 6, cooldown: 20, own: true },
  'contact.spent': { category: 'combat_end', priority: 3, ttl: 12, own: true },
  'fix.ready': { category: 'combat_progress', priority: 3, ttl: 12, cooldown: 20 },
  // The brace, the heavy guns' rounds, and the hold (S2.8).
  'ship.braced': { category: 'combat_progress', priority: 2, ttl: 4, cooldown: 30, chance: 0.5 },
  'weapon.empty': { category: 'combat_progress', priority: 3, ttl: 10, cooldown: 20 },
  'drone.launched': { category: 'combat_progress', priority: 2, ttl: 5, cooldown: 25 },
  'drone.lost': { category: 'combat_progress', priority: 2, ttl: 5, cooldown: 15 },
  'weapon.loaded': { category: 'order_confirm', priority: 2, ttl: 6, cooldown: 20, chance: 0.6, slots: crewName },
  'crate.opened': { category: 'cargo', priority: 2, ttl: 10, cooldown: 15, slots: crewName },
  'crate.jettisoned': { category: 'cargo', priority: 2, ttl: 10, cooldown: 15 },
  // Her say in an order (judgement.js). `urgent` cuts short whatever she was saying: the captain is waiting on her.
  // `own` keeps these to lines written for that trigger, so a stray line of the same category cannot stand in.
  'ai.argued': { category: 'argument', priority: 6, ttl: 15, urgent: true, own: true, slots: crewAndRoom },
  'ai.refused': { category: 'refusal', priority: 6, ttl: 15, urgent: true, own: true, slots: crewAndRoom },
  'captain.overrode': { category: 'override', priority: 6, ttl: 12, urgent: true, own: true, slots: crewAndRoom },
  'captain.stood_down': { category: 'order_confirm', priority: 6, ttl: 8, urgent: true, own: true, slots: crewAndRoom },
  // The crew saying no, and the crew putting the lamps back on (memory.js).
  'crew.refused': { category: 'crew_conflict', priority: 3, ttl: 10, cooldown: 25, chance: 0.7, own: true, slots: crewAndRoom },
  'crew.lit': { category: 'crew_conflict', priority: 2, ttl: 10, cooldown: 40, chance: 0.7, own: true, slots: crewAndRoom },
  // The chart (S3.1): a plotted course, the jump, fuel, the pursuer and the deadline.
  'course.ready': { category: 'jump', priority: 2, ttl: 10, cooldown: 20, chance: 0.4, own: true },
  'sector.jumped': { category: 'jump', priority: 2, ttl: 10, chance: 0.5, own: true },
  'fuel.out': { category: 'jump', priority: 4, ttl: 20, own: true },
  'pursuit.sighted': { category: 'contract', priority: 3, ttl: 15, cooldown: 30, own: true },
  'pursuit.ended': { category: 'contract', priority: 3, ttl: 15, own: true },
  'contract.late': { category: 'contract', priority: 3, ttl: 20, own: true },
  'sector.delivered': { category: 'contract', priority: 3, ttl: 20, own: true },
  // The scope (H.1, D-151): a return, what it turns out to be, what it does about us, and losing it.
  'contact.sighted': { category: 'sensor_uncertain', priority: 3, ttl: 12, cooldown: 20, own: true },
  'contact.identified': { category: 'sensor_uncertain', priority: 2, ttl: 10, cooldown: 20, own: true },
  'contact.noticed': { category: 'combat_start', priority: 3, ttl: 10, cooldown: 30, own: true },
  'contact.closing': { category: 'combat_start', priority: 4, ttl: 12, cooldown: 30, own: true },
  'contact.alongside': { category: 'combat_start', priority: 5, ttl: 12, own: true },
  'contact.fooled': { category: 'combat_progress', priority: 3, ttl: 8, cooldown: 20, own: true },
  'contact.hailed': { category: 'combat_progress', priority: 4, ttl: 10, own: true, when: (event) => event.ok === false },
  'contact.lost': { category: 'combat_end', priority: 3, ttl: 15, own: true },
  'contact.passed': { category: 'combat_end', priority: 2, ttl: 15, own: true },
  // Boarded (H.2, D-165): a party at the lock, aboard, finding things, and gone.
  'boarding.demand': { category: 'combat_start', priority: 5, ttl: 15, own: true },
  'boarding.aboard': { category: 'combat_progress', priority: 4, ttl: 10, own: true },
  'boarding.bribed': { category: 'combat_progress', priority: 4, ttl: 10, own: true, when: (event) => event.ok === false },
  'boarding.hostile': { category: 'combat_progress', priority: 4, ttl: 10, own: true },
  'cargo.seized': { category: 'cargo', priority: 3, ttl: 10, cooldown: 20, own: true },
  'crate.taken': { category: 'cargo', priority: 3, ttl: 10, cooldown: 20, own: true },
  'crew.found': { category: 'crew_injury', priority: 4, ttl: 10, cooldown: 15, own: true, slots: crewName },
  'crew.taken': { category: 'crew_death', priority: 5, ttl: 30, own: true, slots: crewName },
  'system.stripped': { category: 'hazard', priority: 4, ttl: 12, own: true },
  'room.vented': { category: 'order_confirm', priority: 2, ttl: 8, cooldown: 30, own: true, when: (event) => event.open },
  'boarding.ended': { category: 'combat_end', priority: 3, ttl: 15, own: true },
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
    ...newJudgementState(), // her trust in the captain and any order she is holding (judgement.js)
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
  if ((rule.seen && unseen(sim, event)) || (rule.when && !rule.when(event))) return false;
  if (rule.chance !== undefined && !sim.rng.stream('ai').chance(rule.chance)) return false;
  if (rule.cooldown) ai.cooldowns[trigger] = tick + rule.cooldown * TICKS;
  const slots = rule.slots ? rule.slots(sim, event) : {};
  ai.queue.push({ trigger, priority: rule.priority, expires: tick + rule.ttl * TICKS, slots, risk: event.risk ?? null });
  if (ai.queue.length > QUEUE_MAX) {
    // Lose the least urgent; among equals, the oldest.
    let drop = 0;
    for (let i = 1; i < ai.queue.length; i++) if (ai.queue[i].priority < ai.queue[drop].priority) drop = i;
    ai.queue.splice(drop, 1);
  }
  return true;
}

/** The lines that fit a remark: right category, right trigger, and every slot they use is known. */
export function candidates(lines, entry, sim = null) {
  const rule = TRIGGERS[entry.trigger];
  return lines.filter((line) => {
    // Anything else the line asks of the world, in the condition language (S3.3; the selector proper is S5.2).
    if (line.conditions?.when !== undefined && sim && !holds(line.conditions.when, { sim, vars: {} })) return false;
    if (line.category !== rule.category) return false;
    const wanted = line.conditions?.trigger;
    if (wanted !== undefined ? wanted !== entry.trigger : rule.own) return false;
    // A line written for particular risks (judgement.js) is only for those.
    const risks = line.conditions?.risk;
    if (risks !== undefined && ![].concat(risks).includes(entry.risk)) return false;
    return slotsIn(line.text).every((slot) => typeof entry.slots[slot] === 'string' && entry.slots[slot]);
  });
}

/** Pick a line: one not heard this run if there is one, otherwise the ones heard longest ago (brief §9). */
function pickLine(sim, entry) {
  const pool = candidates(sim.lines, entry, sim);
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
  ai.speaking = { id: line.id, until: sim.state.tick + Math.ceil(seconds * TICKS), priority: entry.priority };
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
    // She finishes what she is saying, unless the captain is waiting on her about an order.
    const cutIn = ai.queue.some((entry) => TRIGGERS[entry.trigger].urgent && entry.priority >= (ai.speaking.priority ?? 0) && entry.expires > tick);
    if (tick < ai.speaking.until && !cutIn) return;
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
