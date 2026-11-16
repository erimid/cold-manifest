// The effect half of the content language (S3.3, D-109). DOM-free.
//
// An effect is { "do": "<name>", ...what it needs }. A list of them is what an
// event's outcome does to the world. They run inside a sim tick (the
// `event.choose` order), so they are part of the save and the replay like
// anything else, and all their dice come from the `events` stream.
//
// Where an effect wants someone or somewhere it takes an id, a name in reach
// ("$scout", see conditions.js), or one of the words below:
//   crew   "all" (everyone of ours aboard), "random" (one of them)
//   room   "random" (any room still attached), or { "of": "$scout" }: the room they are in
//
// Two effects are hooks for later stages. `scene` and `threat` only leave a note in the run (run.scenes, run.threat) and
// announce themselves on the bus; Stage 4 and Stage 6 pick them up.

import { harmCrew } from '../sim/atmosphere.js';
import { startBoarding } from '../sim/boarders.js';
import { spawnContact } from '../sim/encounters.js';
import { changeReputation, contractActive, contractOf, failContract, FAILURES, loadCargo, seizeCargo } from '../sim/contracts.js';
import { CRATE_KINDS, addCrate } from '../sim/hold.js';
import { remember } from '../sim/memory.js';
import { newPursuit } from '../sim/sector.js';
import { checkValue, resolve, validateText, fillText } from './conditions.js';

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const rng = (ctx) => ctx.sim.rng.stream('events');
const aboard = (sim) =>
  Object.values(sim.state.crew)
    .filter((member) => member.alive && member.owner === 'player')
    .sort((a, b) => a.index - b.index);

/** The crew an effect is aimed at: a list of members. */
function crewOf(target, ctx) {
  const all = aboard(ctx.sim);
  if (target === 'all') return all;
  if (target === 'random') return all.length ? [rng(ctx).pick(all)] : [];
  const member = ctx.sim.state.crew[resolve(target, ctx)];
  return member?.alive ? [member] : [];
}

/** The room an effect is aimed at, or null if it is not there any more. */
function roomOf(target, ctx) {
  const { sim } = ctx;
  let id;
  if (target === 'random') {
    const rooms = sim.layout.rooms.filter((room) => !sim.state.rooms[room.id].jettisoned);
    id = rooms.length ? rng(ctx).pick(rooms).id : null;
  } else if (isObject(target)) id = sim.state.crew[resolve(target.of, ctx)]?.room;
  else id = resolve(target, ctx);
  return sim.state.rooms[id] && !sim.state.rooms[id].jettisoned ? id : null;
}

const checkCrewTarget = (value, env, what) => (['all', 'random'].includes(value) ? [] : checkValue(value, 'crew', env, what));
function checkRoomTarget(value, env, what) {
  if (value === 'random') return [];
  if (isObject(value)) return Object.keys(value).join() === 'of' ? checkValue(value.of, 'crew', env, `${what}.of`) : [`${what} must be a room, "random" or { "of": someone }`];
  return checkValue(value, 'room', env, what);
}
const share = (value, env, what) => (typeof value === 'number' && value > 0 && value <= 1 ? [] : [`${what} must be above 0 and at most 1`]);
const whole = (value, env, what) => (Number.isInteger(value) && value !== 0 ? [] : [`${what} must be a whole number, not 0`]);
const count = (value, env, what) => (Number.isInteger(value) && value >= 1 ? [] : [`${what} must be a whole number, 1 or more`]);
const words = (value, env, what) => (typeof value === 'string' && value.trim() ? [] : [`${what} must be some words`]);
const typed = (type) => (value, env, what) => checkValue(value, type, env, what);

/**
 * Every effect: `args` (name -> a check), `optional` (names that may be left out),
 * and `run(sim, args, ctx)`. `args` reach `run` as written; it resolves what it needs.
 */
export const EFFECTS = Object.freeze({
  money: {
    args: { add: whole },
    run(sim, a) {
      const from = sim.state.money;
      sim.state.money = Math.max(0, from + a.add);
      sim.events.emit('money.changed', { from, to: sim.state.money, reason: 'event', tick: sim.state.tick });
    },
  },
  fuel: {
    args: { add: whole },
    run(sim, a) {
      const run = sim.state.run;
      if (run) run.fuel = clamp(run.fuel + a.add, 0, run.fuelMax);
    },
  },
  deadline: {
    args: { add: whole },
    run(sim, a) {
      const run = sim.state.run;
      if (run) run.deadline = Math.max(run.jumps, run.deadline + a.add);
    },
  },
  // The hull as a whole. An event never sinks the ship outright: it stops at one point.
  hull: {
    args: { add: whole },
    run(sim, a) {
      const { hull } = sim.state;
      hull.points = clamp(hull.points + a.add, Math.min(1, hull.points), hull.max);
    },
  },
  trust: {
    args: { add: typed('number') },
    run(sim, a) {
      const ai = sim.state.ai;
      const from = ai.trust;
      ai.trust = clamp(from + a.add, 0, 100);
      if (ai.trust !== from) sim.events.emit('ai.trust', { from, to: ai.trust, reason: 'event', tick: sim.state.tick });
    },
  },
  // A note for later events to read with the "flag" fact: set it (value, default true) or count it up (add).
  flag: {
    args: { name: words, value: (value) => (['string', 'number', 'boolean'].includes(typeof value) ? [] : ['flag.value must be text, a number, or true or false']), add: typed('number') },
    optional: ['value', 'add'],
    run(sim, a) {
      const run = sim.state.run;
      if (!run) return;
      run.flags[a.name] = a.add !== undefined ? (Number(run.flags[a.name]) || 0) + a.add : a.value ?? true;
    },
  },
  fire: {
    args: { room: checkRoomTarget, size: share },
    optional: ['size'],
    run(sim, a, ctx) {
      const id = roomOf(a.room, ctx);
      if (id) sim.state.rooms[id].fire = Math.max(sim.state.rooms[id].fire, a.size ?? 0.3);
    },
  },
  breach: {
    args: { room: checkRoomTarget, size: share },
    optional: ['size'],
    run(sim, a, ctx) {
      const id = roomOf(a.room, ctx);
      if (id) sim.state.rooms[id].breach = Math.max(sim.state.rooms[id].breach, a.size ?? 0.3);
    },
  },
  // Break (bars above 0) or mend (below) bars of a system.
  damage: {
    args: { system: typed('system'), bars: whole },
    optional: ['bars'],
    run(sim, a) {
      const system = sim.state.systems[a.system];
      if (!system || system.absent || system.lost) return;
      const from = system.damage;
      system.damage = clamp(from + (a.bars ?? 1), 0, system.level);
      if (system.damage !== from) sim.events.emit('system.damage', { system: a.system, from, to: system.damage, cause: 'event', tick: sim.state.tick });
    },
  },
  hurt: {
    args: { crew: checkCrewTarget, amount: share },
    run(sim, a, ctx) {
      for (const member of crewOf(a.crew, ctx)) harmCrew(sim, member.id, a.amount, 'event');
    },
  },
  heal: {
    args: { crew: checkCrewTarget, amount: share },
    run(sim, a, ctx) {
      for (const member of crewOf(a.crew, ctx)) member.health = Math.min(1, member.health + a.amount);
    },
  },
  // Put something in someone's head (memory.js). `who` is who it was about, `room` where.
  remember: {
    args: { crew: checkCrewTarget, memory: typed('memory'), room: checkRoomTarget, who: typed('crew') },
    optional: ['room', 'who'],
    run(sim, a, ctx) {
      const who = a.who === undefined ? null : sim.state.crew[resolve(a.who, ctx)]?.name ?? null;
      const room = a.room === undefined ? undefined : roomOf(a.room, ctx);
      for (const member of crewOf(a.crew, ctx)) remember(sim, member, a.memory, { room: room === undefined ? member.room : room, who });
    },
  },
  // A crate set down in the hold (hold.js). A cargo crate is sealed and needs `contents`.
  crate: {
    args: { kind: (value) => (CRATE_KINDS.includes(value) ? [] : [`crate.kind must be one of ${CRATE_KINDS.join(', ')}`]), room: checkRoomTarget, label: words, contents: words, count },
    optional: ['room', 'label', 'contents', 'count'],
    check: (effect) => (effect.kind === 'cargo' && effect.contents === undefined ? ['a cargo crate needs "contents", what is found when it is opened'] : []),
    run(sim, a, ctx) {
      const room = a.room === undefined ? sim.layout.crates[0]?.room ?? sim.layout.rooms[0].id : roomOf(a.room, ctx);
      if (!room || sim.state.rooms[room].jettisoned) return;
      for (let i = 0; i < (a.count ?? 1); i++) {
        const crate = addCrate(sim, { kind: a.kind, room, label: a.label, contents: a.contents });
        sim.events.emit('crate.added', { crate: crate.id, kind: a.kind, room, tick: sim.state.tick });
      }
    },
  },
  cargo: {
    args: { name: words, qty: count },
    run(sim, a) {
      sim.state.cargo.push({ name: a.name, qty: a.qty, from: 'event' });
    },
  },
  intel: {
    args: { text: (value, env, what) => validateText(value, env, what) },
    run(sim, a, ctx) {
      sim.state.intel.push({ text: fillText(a.text, ctx), from: 'event', tick: sim.state.tick });
    },
  },
  // A ship is already alongside and its party comes to our lock (H.2, boarders.js): an inspection at a
  // checkpoint, say. Does nothing if a party is already docked.
  board: {
    args: { encounter: typed('encounter') },
    run(sim, a) {
      const def = sim.encounters.byId.get(a.encounter);
      if (def) startBoarding(sim, def);
    },
  },
  // A ship turns up on the scope already sure of us and closing, `range` scope units out (H.1).
  contact: {
    args: { encounter: typed('encounter'), range: count },
    optional: ['range'],
    run(sim, a, ctx) {
      const def = sim.encounters.byId.get(a.encounter);
      if (def) spawnContact(sim, def, { range: a.range ?? 30, bearing: rng(ctx).range(0, 360), state: 'closing' });
    },
  },
  // Hook (Stage 4 and 8): a scene is waiting to be played.
  scene: {
    args: { scene: typed('scene') },
    run(sim, a) {
      const run = sim.state.run;
      if (run && !run.scenes.includes(a.scene)) run.scenes.push(a.scene);
      sim.events.emit('scene.cued', { scene: a.scene, tick: sim.state.tick });
    },
  },
  // Hook (Stage 6): something is aboard.
  threat: {
    args: { threat: typed('threat') },
    optional: ['threat'],
    run(sim, a) {
      const run = sim.state.run;
      if (run && !run.threat) run.threat = { id: a.threat ?? null, tick: sim.state.tick };
      sim.events.emit('threat.cued', { threat: a.threat ?? null, tick: sim.state.tick });
    },
  },
  // ---------- the contract and standing (S3.4) ----------
  // Standing with a faction moves; "client" is the contract's client.
  reputation: {
    args: { faction: typed('faction'), add: whole },
    run: (sim, a) => changeReputation(sim, a.faction, a.add, 'event'),
  },
  // The salvage claim is worked: `count` more of the contract's crates come aboard (all that are left with no count).
  'contract.load': {
    args: { count },
    optional: ['count'],
    run(sim, a) {
      if (!contractActive(sim)) return;
      loadCargo(sim, a.count ?? Infinity);
      const claim = contractOf(sim).claim;
      if (claim) claim.done = true;
    },
  },
  // An inspection takes the contraband aboard (or, with all, every crate of the contract). The contract fails if nothing of it is left.
  'contract.seize': {
    args: { all: typed('boolean') },
    optional: ['all'],
    run: (sim, a) => seizeCargo(sim, { all: a.all ?? false }),
  },
  // The contract fails outright, for one of the reasons in contracts.js.
  'contract.fail': {
    args: { reason: (value, env, what) => (FAILURES[value] ? [] : [`${what} must be one of ${Object.keys(FAILURES).join(', ')}`]) },
    run: (sim, a) => failContract(sim, a.reason),
  },
  // Another event follows this one, whatever its own conditions say.
  event: {
    args: { event: typed('event') },
    run(sim, a) {
      const run = sim.state.run;
      if (run) run.events.next = a.event;
    },
  },
  // Somebody starts following us from the origin (sector.js), or gives up (on); or whoever follows loses `delay` jumps.
  pursuit: {
    args: { on: typed('boolean'), delay: count },
    optional: ['on', 'delay'],
    check: (effect) => (effect.on === undefined && effect.delay === undefined ? ['needs "on" or "delay"'] : []),
    run(sim, a) {
      const run = sim.state.run;
      if (!run) return;
      if (a.on === false) run.pursuit = null;
      else if (a.on === true && (!run.pursuit || run.pursuit.done)) run.pursuit = newPursuit(run.rule, run.map.start);
      if (a.delay && run.pursuit && !run.pursuit.done) run.pursuit.wait += a.delay;
    },
  },
});

/** Carry out a list of effects, in order. `ctx` is { sim, vars }. */
export function applyEffects(effects, ctx) {
  for (const effect of effects ?? []) {
    EFFECTS[effect.do].run(ctx.sim, effect, ctx);
    ctx.sim.events.emit('effect.applied', { effect: effect.do, tick: ctx.sim.state.tick });
  }
}

/** Check a list of effects without running them. `env` is as for validateCondition. Returns problems. */
export function validateEffects(effects, env = {}, what = 'effects') {
  if (effects === undefined) return [];
  if (!Array.isArray(effects)) return [`${what} must be a list`];
  const problems = [];
  effects.forEach((effect, i) => {
    const where = `${what}[${i}]`;
    if (!isObject(effect)) return problems.push(`${where} must be an object with "do"`);
    const def = EFFECTS[effect.do];
    if (!def) return problems.push(`${where}: no effect "${effect.do}" (${Object.keys(EFFECTS).join(', ')})`);
    for (const [name, check] of Object.entries(def.args)) {
      if (effect[name] === undefined) {
        if (!(def.optional ?? []).includes(name)) problems.push(`${where}: "${effect.do}" needs "${name}"`);
      } else problems.push(...check(effect[name], env, `${where}.${name}`));
    }
    for (const key of Object.keys(effect)) if (key !== 'do' && !def.args[key]) problems.push(`${where}: "${effect.do}" has no "${key}"`);
    for (const problem of def.check?.(effect) ?? []) problems.push(`${where}: ${problem}`);
  });
  return problems;
}
