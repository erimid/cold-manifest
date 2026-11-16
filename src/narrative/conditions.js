// The condition language (S3.3, DECISIONS D-004, D-109; PLAN §1.4). DOM-free.
//
// One small JSON language says "when" for everything that is content: transit
// events and their choices, the orders the crew refuse, the risks Margo
// objects to, which bus events become memories, and (from Stage 5) which of
// her lines fit. The effect half lives in effects.js; the things a condition
// can ask about live in facts.js.
//
// A condition is one of:
//
//   [ c, c, ... ]                 every one of them (the same as { all })
//   { "all": [ c, ... ] }         every one
//   { "any": [ c, ... ] }         at least one
//   { "not": c }                  not that
//   { "fact": "fuel", "gte": 3 }  something measured (facts.js), compared with
//                                 eq ne gt gte lt lte in. With no comparison
//                                 it asks "is it true / above zero".
//   { "crew": { "skill": "medicine", "min": 2 }, "as": "medic" }
//                                 someone of ours who fits (see CREW_FILTERS),
//                                 remembered under a name if "as" is given.
//                                 "count": 2 asks for at least two.
//   { "memory": { "type": "burn" }, "as": "memory" }
//                                 the newest memory that fits and has not
//                                 faded, in the head of "of" (default $crew).
//
// Any of them may carry "label": the words shown in a requirement tag such as
// "[Sensors powered]" where the language cannot work the words out itself.
//
// Wherever an id is wanted (a room, a crew member, a door) a reference can be
// given instead: "$room", "$medic", or a field of something, "$order.door".
// The names in reach depend on where the condition is used; the checker knows
// them (validateCondition) and refuses a condition that reaches for one that
// is not there.
//
// Text can name the same things in braces: "{medic} goes across to {place}".

import { FACTS } from './facts.js';

/** Ticks per second (DECISIONS D-002). */
const TICKS = 20;

/** The six skills (brief §8). Crew carry them as data from S3.3; S4.1 makes them matter to the work. */
export const SKILLS = Object.freeze(['piloting', 'engineering', 'weapons', 'medicine', 'combat', 'negotiation']);

export const OPS = Object.freeze({
  eq: (a, b) => a === b,
  ne: (a, b) => a !== b,
  gt: (a, b) => a > b,
  gte: (a, b) => a >= b,
  lt: (a, b) => a < b,
  lte: (a, b) => a <= b,
  in: (a, b) => b.includes(a),
});

/** What a name in reach can be. `data` is a plain object such as an order or a bus event. */
export const VAR_TYPES = Object.freeze(['crew', 'room', 'memory', 'data', 'text', 'number']);

/** Make the names in reach for a condition: vars({ crew: ['crew', 'ilse'], room: ['room', 'medbay'] }). */
export function vars(entries = {}) {
  return Object.fromEntries(Object.entries(entries).map(([name, [type, value]]) => [name, { type, value }]));
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isRef = (value) => typeof value === 'string' && value.startsWith('$');
const capital = (word) => word.charAt(0).toUpperCase() + word.slice(1).replace(/[-_]/g, ' ');

/** A reference or a literal, as a plain value. An unknown name gives undefined. */
export function resolve(value, ctx) {
  if (!isRef(value)) return value;
  const [name, ...path] = value.slice(1).split('.');
  let found = ctx.vars?.[name]?.value;
  for (const key of path) found = found?.[key];
  return found;
}

/** Has this memory faded? Each kind lasts as long as its rule in content says. */
export function isFresh(ship, entry) {
  const kind = ship.rules?.memory[entry.type];
  return Boolean(kind) && ship.state.tick - entry.tick < kind.seconds * TICKS;
}

// ---------- crew ----------

/** Our people aboard our own ship, in roster order. */
const ours = (sim) =>
  Object.values(sim.state.crew)
    .filter((member) => member.alive && member.owner === 'player')
    .sort((a, b) => a.index - b.index);

/**
 * What a crew filter may ask. Each has `type` (what the value must be, for the checker)
 * and `fits(member, value, ctx)`.
 */
export const CREW_FILTERS = Object.freeze({
  id: { type: 'crew', fits: (member, id) => member.id === id },
  not: { type: 'crew', fits: (member, id) => member.id !== id },
  in: { type: 'room', fits: (member, room) => member.room === room && member.task !== 'crossing' },
  away: { type: 'room', fits: (member, room) => member.room !== room },
  suit: { type: 'boolean', fits: (member, suit) => Boolean(member.suit) === suit },
  engineer: { type: 'boolean', fits: (member, engineer) => Boolean(member.engineer) === engineer },
  skill: { type: 'skill', fits: (member, skill, ctx, spec) => (member.skills?.[skill] ?? 0) >= (spec.min ?? 1) },
  min: { type: 'count', fits: () => true }, // read by `skill`
  trait: { type: 'trait', fits: (member, trait) => (member.traits ?? []).includes(trait) },
  where: { type: 'condition', fits: (member, cond, ctx) => match(cond, { ...ctx, vars: { ...ctx.vars, this: { type: 'crew', value: member.id } } }) !== null },
  pick: { type: 'pick', fits: () => true }, // read by the cast (events.js)
});

/** Everyone of ours who fits a crew filter, best first: by the skill asked for, then by roster order. */
export function crewMatching(spec, ctx) {
  const fit = ours(ctx.sim).filter((member) => Object.entries(spec).every(([key, value]) => CREW_FILTERS[key]?.fits(member, key === 'where' ? value : resolve(value, ctx), ctx, spec)));
  if (spec.skill) fit.sort((a, b) => (b.skills?.[spec.skill] ?? 0) - (a.skills?.[spec.skill] ?? 0) || a.index - b.index);
  return fit;
}

// ---------- memories ----------

function memoryFits(ship, entry, spec, ctx) {
  if (spec.any) return spec.any.some((one) => memoryFits(ship, entry, one, ctx));
  if (spec.type !== undefined && ![].concat(spec.type).includes(entry.type)) return false;
  if (spec.room !== undefined && entry.room !== resolve(spec.room, ctx)) return false;
  if (spec.dark !== undefined && Boolean(entry.dark) !== spec.dark) return false;
  if (spec.shadow !== undefined) {
    const how = ship.rules?.memory[entry.type]?.shadow ?? 'if-dark';
    if ((how === 'always' || (how === 'if-dark' && Boolean(entry.dark))) !== spec.shadow) return false;
  }
  return true;
}

/** The newest memory in someone's head that fits and has not faded, or null. */
export function memoryMatching(spec, member, ctx) {
  const memories = member?.memories ?? [];
  for (let i = memories.length - 1; i >= 0; i--) {
    if (isFresh(ctx.sim, memories[i]) && memoryFits(ctx.sim, memories[i], spec, ctx)) return memories[i];
  }
  return null;
}

// ---------- matching ----------

function factValue(cond, ctx) {
  const fact = FACTS[cond.fact];
  if (!fact) return undefined;
  const args = {};
  for (const name of Object.keys(fact.args ?? {})) args[name] = resolve(cond[name], ctx);
  return fact.get(ctx.sim, args, ctx);
}

function factHolds(cond, ctx) {
  const value = factValue(cond, ctx);
  const ops = Object.keys(OPS).filter((op) => cond[op] !== undefined);
  // Something that is not there is not equal to anything, and nothing else can be said of it.
  if (value === undefined || value === null) return ops.length > 0 && ops.every((op) => op === 'ne');
  if (!ops.length) return typeof value === 'number' ? value > 0 : Boolean(value);
  return ops.every((op) => OPS[op](value, op === 'in' ? cond.in : resolve(cond[op], ctx)));
}

/**
 * Does the condition hold? Returns the names in reach afterwards (the ones given, plus any the
 * condition remembered with "as"), or null if it does not hold. `ctx` is { sim, vars }.
 * A missing condition always holds.
 */
export function match(cond, ctx) {
  const reach = ctx.vars ?? {};
  if (cond === undefined || cond === null) return reach;
  if (Array.isArray(cond)) return match({ all: cond }, ctx);
  if (cond.all) {
    let now = reach;
    for (const one of cond.all) {
      now = match(one, { ...ctx, vars: now });
      if (!now) return null;
    }
    return now;
  }
  if (cond.any) {
    for (const one of cond.any) {
      const now = match(one, ctx);
      if (now) return now;
    }
    return null;
  }
  if (cond.not !== undefined) return match(cond.not, ctx) ? null : reach;
  if (cond.fact !== undefined) return factHolds(cond, ctx) ? reach : null;
  if (cond.crew !== undefined) {
    const fit = crewMatching(cond.crew, ctx);
    if (fit.length < (cond.count ?? 1)) return null;
    return cond.as ? { ...reach, [cond.as]: { type: 'crew', value: fit[0].id } } : reach;
  }
  if (cond.memory !== undefined) {
    const member = ctx.sim.state.crew[resolve(cond.of ?? '$crew', ctx)];
    const found = memoryMatching(cond.memory, member, ctx);
    if (!found) return null;
    return cond.as ? { ...reach, [cond.as]: { type: 'memory', value: found } } : reach;
  }
  return null;
}

/** Does the condition hold? */
export const holds = (cond, ctx) => match(cond, ctx) !== null;

// ---------- requirement tags ----------

function crewWords(spec, member, ctx) {
  const words = [];
  const named = spec.id !== undefined ? ctx.sim.state.crew[resolve(spec.id, ctx)]?.name ?? capital(String(resolve(spec.id, ctx))) : null;
  if (member) words.push(member.name);
  else if (named) words.push(named);
  if (spec.skill) words.push(member || (spec.min ?? 1) <= 1 ? capital(spec.skill) : `${capital(spec.skill)} ${spec.min}`);
  if (spec.trait) words.push(ctx.sim.rules?.traits?.[spec.trait]?.name ?? capital(spec.trait));
  if (spec.engineer === true) words.push('Engineer');
  return words;
}

/** Walk a condition and say what it took: { vars | null, have: [words], need: [words] }. */
function explain(cond, ctx) {
  const reach = ctx.vars ?? {};
  if (cond === undefined || cond === null) return { vars: reach, have: [], need: [] };
  if (Array.isArray(cond)) return explain({ all: cond }, ctx);
  const labelled = (result) => (cond.label ? { vars: result.vars, have: result.vars ? [cond.label] : [], need: result.vars ? [] : [cond.label] } : result);
  if (cond.all) {
    let now = reach;
    let met = true;
    const have = [];
    const need = [];
    for (const one of cond.all) {
      const part = explain(one, { ...ctx, vars: now });
      if (part.vars) now = part.vars;
      else met = false;
      have.push(...part.have);
      need.push(...part.need);
    }
    return labelled({ vars: met ? now : null, have, need });
  }
  if (cond.any) {
    const parts = cond.any.map((one) => explain(one, ctx));
    return labelled(parts.find((part) => part.vars) ?? { vars: null, have: [], need: parts[0]?.need ?? [] });
  }
  if (cond.crew !== undefined) {
    const now = match(cond, ctx);
    const member = now ? crewMatching(cond.crew, ctx)[0] : null;
    return labelled({ vars: now, have: now ? crewWords(cond.crew, member, ctx) : [], need: now ? [] : crewWords(cond.crew, null, ctx) });
  }
  return labelled({ vars: match(cond, ctx), have: [], need: [] });
}

/**
 * The tag a choice shows for what it requires (brief §15): "[Ilse, Medicine]" when it is met,
 * "[Needs Medicine 2]" when it is not. Returns { met, tag, vars }; tag is null when there is nothing to say.
 */
export function requirement(cond, ctx) {
  const { vars: now, have, need } = explain(cond, ctx);
  const words = [...new Set(now ? have : need)];
  const tag = now ? (words.length ? `[${words.join(', ')}]` : null) : words.length ? `[Needs ${words.join(', ')}]` : '[Not possible now]';
  return { met: Boolean(now), tag, vars: now };
}

// ---------- text ----------

const SLOT = /\{([^{}]*)\}/g;

/** The names a piece of text asks for: "{medic} in {memory.room}" gives ["medic", "memory.room"]. */
export const slotsOf = (text) => [...String(text).matchAll(SLOT)].map((found) => found[1]);

const roomName = (sim, id) => sim.layout.room(id)?.name ?? 'the ship';

/** A memory in a few words, from its kind's own templates: "Okoro dying in Medbay". */
export function memoryText(sim, entry, phrase = null) {
  const kind = sim.rules?.memory[entry.type];
  if (!kind) return entry.type;
  const template = (phrase && kind.phrases?.[phrase]) ?? (entry.room ? kind.text : kind.bare ?? kind.text);
  return template.replace(SLOT, (_, slot) => (slot === 'who' ? entry.who ?? 'someone' : slot === 'room' ? roomName(sim, entry.room) : `{${slot}}`));
}

function slotText(slot, ctx) {
  const [name, key] = slot.split('.');
  const found = ctx.vars?.[name];
  if (!found) return null;
  const { type, value } = found;
  if (type === 'crew') return ctx.sim.state.crew[value]?.name ?? String(value);
  if (type === 'room') return roomName(ctx.sim, value);
  if (type === 'memory') {
    if (key === 'who') return value.who ?? 'someone';
    if (key === 'room') return roomName(ctx.sim, value.room);
    return memoryText(ctx.sim, value, key ?? null);
  }
  if (type === 'data') return key === undefined || value?.[key] === undefined ? null : String(value[key]);
  return String(value);
}

/** Fill the braces in a piece of text from the names in reach. A name that is not there is left as written. */
export function fillText(text, ctx) {
  return String(text).replace(SLOT, (whole, slot) => slotText(slot, ctx) ?? whole);
}

// ---------- checking (the content checker and the tests) ----------

/**
 * Check a reference or a literal where a `type` is wanted. `env` is { vars: { name: type }, refs },
 * where refs holds the ids that exist: { rooms, doors, crew, systems, traits, memories, ... } as Sets
 * (a missing Set means "cannot be checked here").
 */
export function checkValue(value, type, env, what) {
  if (isRef(value)) {
    const [name, ...path] = value.slice(1).split('.');
    const found = env.vars?.[name];
    if (!found) return [`${what}: nothing called "$${name}" is in reach here (${Object.keys(env.vars ?? {}).map((n) => `$${n}`).join(', ') || 'nothing is'})`];
    if (path.length) return ['data', 'memory'].includes(found) ? [] : [`${what}: "$${name}" is a ${found}, so it has no .${path.join('.')}`];
    return found === type || found === 'data' || type === 'any' ? [] : [`${what}: "$${name}" is a ${found}, and a ${type} is wanted`];
  }
  const sets = { room: 'rooms', crew: 'crew', door: 'doors', system: 'systems', trait: 'traits', memory: 'memories', ship: 'ships', scene: 'scenes', event: 'events', threat: 'threats', faction: 'factions', encounter: 'encounters' };
  if (type === 'faction' && value === 'client') return []; // the contract's client, whoever that is
  if (type === 'boolean') return typeof value === 'boolean' ? [] : [`${what} must be true or false`];
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value) ? [] : [`${what} must be a number`];
  if (type === 'count') return Number.isInteger(value) && value >= 0 ? [] : [`${what} must be a whole number, 0 or more`];
  if (type === 'skill') return SKILLS.includes(value) ? [] : [`${what}: no skill "${value}" (${SKILLS.join(', ')})`];
  if (type === 'string' || type === 'any') return typeof value === 'string' || type === 'any' ? [] : [`${what} must be text`];
  if (sets[type]) {
    if (typeof value !== 'string') return [`${what} must name a ${type}`];
    const known = env.refs?.[sets[type]];
    return !known || known.has(value) ? [] : [`${what}: no ${type} "${value}"`];
  }
  return [`${what}: cannot check a "${type}"`];
}

const MEMORY_KEYS = ['type', 'room', 'dark', 'shadow', 'any'];

function checkMemorySpec(spec, env, what) {
  if (!isObject(spec)) return [`${what} must be an object: { type, room, dark, shadow } or { any: [...] }`];
  const problems = [];
  for (const key of Object.keys(spec)) if (!MEMORY_KEYS.includes(key)) problems.push(`${what}: unknown key "${key}" (${MEMORY_KEYS.join(', ')})`);
  if (spec.any !== undefined) {
    if (!Array.isArray(spec.any) || !spec.any.length) problems.push(`${what}.any must be a list`);
    else spec.any.forEach((one, i) => problems.push(...checkMemorySpec(one, env, `${what}.any[${i}]`)));
  }
  for (const type of spec.type === undefined ? [] : [].concat(spec.type)) problems.push(...checkValue(type, 'memory', { refs: env.refs }, `${what}.type`));
  if (spec.room !== undefined) problems.push(...checkValue(spec.room, 'room', env, `${what}.room`));
  for (const key of ['dark', 'shadow']) if (spec[key] !== undefined) problems.push(...checkValue(spec[key], 'boolean', env, `${what}.${key}`));
  return problems;
}

/** Check a crew filter. `cast: true` allows "pick". Returns problems. */
export function checkCrewSpec(spec, env, what, { cast = false } = {}) {
  if (!isObject(spec)) return [`${what} must be an object of filters (${Object.keys(CREW_FILTERS).join(', ')})`];
  const problems = [];
  for (const [key, value] of Object.entries(spec)) {
    const filter = CREW_FILTERS[key];
    if (!filter) problems.push(`${what}: unknown filter "${key}" (${Object.keys(CREW_FILTERS).join(', ')})`);
    else if (filter.type === 'condition') problems.push(...validateCondition(value, { ...env, vars: { ...env.vars, this: 'crew' } }, `${what}.where`).problems);
    else if (filter.type === 'pick') {
      if (!cast) problems.push(`${what}: "pick" only means something in an event's cast`);
      else if (!['best', 'random'].includes(value)) problems.push(`${what}.pick must be "best" or "random"`);
    } else problems.push(...checkValue(value, filter.type, env, `${what}.${key}`));
  }
  if (spec.min !== undefined && spec.skill === undefined) problems.push(`${what}: "min" needs a "skill" to measure`);
  return problems;
}

const NAME = /^[a-z][a-z0-9_]*$/;
const SHAPES = ['all', 'any', 'not', 'fact', 'crew', 'memory'];

/**
 * Check a condition without running it. Returns { problems, binds }: the problems as readable
 * strings, and the names it would remember with "as" (name -> type) for whatever reads it next.
 */
export function validateCondition(cond, env = {}, what = 'condition') {
  const problems = [];
  const binds = {};
  const reach = () => ({ ...env, vars: { ...env.vars, ...binds } });
  const walk = (node, where, binding) => {
    if (Array.isArray(node)) return node.forEach((one, i) => walk(one, `${where}[${i}]`, binding));
    if (!isObject(node)) return problems.push(`${where} must be an object or a list of conditions`);
    // A fact may take arguments called "crew" or "memory", so with a fact those are its arguments, not shapes.
    const shapes = SHAPES.filter((key) => node[key] !== undefined && !(node.fact !== undefined && (key === 'crew' || key === 'memory')));
    if (shapes.length !== 1) return problems.push(`${where} must be exactly one of ${SHAPES.join(', ')}${shapes.length ? ` (it has ${shapes.join(' and ')})` : ''}`);
    const [shape] = shapes;
    if (node.label !== undefined && !(typeof node.label === 'string' && node.label.trim())) problems.push(`${where}.label must be text`);
    const allowed = new Set([shape, 'label']);
    if (shape === 'all' || shape === 'any') {
      if (!Array.isArray(node[shape]) || !node[shape].length) problems.push(`${where}.${shape} must be a list with something in it`);
      // What one branch of an "any" remembers cannot be counted on by what follows, so only "all" passes names on.
      else node[shape].forEach((one, i) => walk(one, `${where}.${shape}[${i}]`, binding && shape === 'all'));
    } else if (shape === 'not') walk(node.not, `${where}.not`, false);
    else if (shape === 'fact') {
      const fact = FACTS[node.fact];
      if (!fact) problems.push(`${where}: no fact "${node.fact}"`);
      else {
        for (const [name, type] of Object.entries(fact.args ?? {})) {
          allowed.add(name);
          if (node[name] === undefined) {
            if (!(fact.optional ?? []).includes(name)) problems.push(`${where}: fact "${node.fact}" needs "${name}"`);
          } else problems.push(...checkValue(node[name], type, reach(), `${where}.${name}`));
        }
        for (const op of Object.keys(OPS)) {
          allowed.add(op);
          if (node[op] === undefined) continue;
          if (op === 'in') {
            if (!Array.isArray(node.in) || !node.in.length) problems.push(`${where}.in must be a list`);
          } else if (isRef(node[op])) problems.push(...checkValue(node[op], 'any', reach(), `${where}.${op}`));
          else if (['gt', 'gte', 'lt', 'lte'].includes(op) && typeof node[op] !== 'number') problems.push(`${where}.${op} must be a number`);
          else if (fact.value === 'number' && typeof node[op] !== 'number') problems.push(`${where}.${op}: "${node.fact}" is a number`);
          else if (fact.value === 'boolean' && typeof node[op] !== 'boolean') problems.push(`${where}.${op}: "${node.fact}" is true or false`);
        }
      }
    } else if (shape === 'crew') {
      allowed.add('as').add('count');
      problems.push(...checkCrewSpec(node.crew, reach(), `${where}.crew`));
      if (node.count !== undefined && !(Number.isInteger(node.count) && node.count >= 1)) problems.push(`${where}.count must be a whole number, 1 or more`);
    } else if (shape === 'memory') {
      allowed.add('as').add('of');
      problems.push(...checkMemorySpec(node.memory, reach(), `${where}.memory`));
      problems.push(...checkValue(node.of ?? '$crew', 'crew', reach(), `${where}.of`));
    }
    if (node.as !== undefined && (shape === 'crew' || shape === 'memory')) {
      if (typeof node.as !== 'string' || !NAME.test(node.as)) problems.push(`${where}.as must be a short lowercase name`);
      else if (!binding) problems.push(`${where}.as: a name remembered inside "any" or "not" cannot be counted on; move it out`);
      else binds[node.as] = shape;
    }
    for (const key of Object.keys(node)) if (!allowed.has(key)) problems.push(`${where}: unknown key "${key}"`);
  };
  if (cond !== undefined && cond !== null) walk(cond, what, true);
  return { problems, binds };
}

/** Check the braces in a piece of text against the names in reach. Returns problems. */
export function validateText(text, env, what = 'text') {
  if (!(typeof text === 'string' && text.trim())) return [`${what} is missing`];
  const problems = [];
  if (/[{}]/.test(text.replace(SLOT, ''))) problems.push(`${what}: unbalanced { or }`);
  for (const slot of slotsOf(text)) {
    const [name, key, ...rest] = slot.split('.');
    const type = env.vars?.[name];
    if (!type) problems.push(`${what}: nothing called "{${name}}" is in reach here (${Object.keys(env.vars ?? {}).map((n) => `{${n}}`).join(', ') || 'nothing is'})`);
    else if (rest.length || (key !== undefined && !['memory', 'data'].includes(type))) problems.push(`${what}: "{${slot}}" reaches too far into a ${type}`);
    else if (type === 'data' && key === undefined) problems.push(`${what}: "{${slot}}" needs a field, such as {${name}.name}`);
    else if (type === 'memory' && key !== undefined && !['who', 'room'].includes(key) && env.refs?.phrases && !env.refs.phrases.has(key)) problems.push(`${what}: no kind of memory has a "${key}" phrase`);
  }
  return problems;
}
