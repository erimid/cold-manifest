// Seeded randomness (brief §19, DECISIONS D-005).
//
// All randomness in the game goes through this module. Each subsystem draws
// from its own named substream so that adding a roll to one system does not
// shift the results of any other. Everything here is pure and DOM-free.

/** Substream names. Asking for a name not on this list throws, to catch typos. */
export const STREAMS = Object.freeze([
  'map',
  'combat',
  'crew',
  'events',
  'ai',
  'threat',
  'market',
  'hazard', // fire spread and other accidents aboard
  'tactics', // enemy captains: where they aim, what they offer, whether talk works
  'encounters', // the scope: who turns up, where, and how the returns wander
  'boarding', // a party aboard (H.2): which lock, whose warrant, where it looks, what it finds, whether a bribe takes
  'cosmetic', // visual-only rolls (stars, flicker). Never used by the sim.
]);

/** Hash any string into four 32-bit integers (cyrb128). */
function hashSeed(str) {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  return [h1 >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0];
}

/**
 * One seeded generator (sfc32). `seed` may be any string or number.
 * The generator's whole state is four integers, so it saves and restores exactly.
 */
export function createRng(seed) {
  let [a, b, c, d] = hashSeed(String(seed));

  function nextUint() {
    a |= 0;
    b |= 0;
    c |= 0;
    d |= 0;
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return t >>> 0;
  }

  // Warm up so that similar seeds diverge immediately.
  for (let i = 0; i < 12; i++) nextUint();

  const rng = {
    /** Float in [0, 1). */
    next() {
      return nextUint() / 4294967296;
    },
    /** Integer in [0, n). */
    int(n) {
      if (!Number.isInteger(n) || n <= 0) throw new RangeError(`rng.int needs a positive integer, got ${n}`);
      return Math.floor(rng.next() * n);
    },
    /** Integer in [min, max], both inclusive. */
    between(min, max) {
      return min + rng.int(max - min + 1);
    },
    /** Float in [min, max). */
    range(min, max) {
      return min + rng.next() * (max - min);
    },
    /** True with probability p. */
    chance(p) {
      return rng.next() < p;
    },
    /** One element of a non-empty array. */
    pick(list) {
      if (!list.length) throw new RangeError('rng.pick needs a non-empty list');
      return list[rng.int(list.length)];
    },
    /** One element chosen in proportion to weightOf(item). Zero or negative weights are never chosen. */
    weighted(list, weightOf = (item) => item.weight ?? 1) {
      let total = 0;
      for (const item of list) total += Math.max(0, weightOf(item));
      if (total <= 0) throw new RangeError('rng.weighted needs at least one positive weight');
      let roll = rng.next() * total;
      for (const item of list) {
        roll -= Math.max(0, weightOf(item));
        if (roll < 0) return item;
      }
      return list[list.length - 1];
    },
    /** A shuffled copy (Fisher-Yates). The input is not changed. */
    shuffle(list) {
      const out = list.slice();
      for (let i = out.length - 1; i > 0; i--) {
        const j = rng.int(i + 1);
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
    getState() {
      return [a >>> 0, b >>> 0, c >>> 0, d >>> 0];
    },
    setState(state) {
      if (!Array.isArray(state) || state.length !== 4) throw new TypeError('rng state must be four integers');
      [a, b, c, d] = state;
    },
  };
  return rng;
}

/**
 * The set of substreams for one run. Streams are created on first use, each
 * derived from the run seed and its own name, so the order in which systems
 * first ask for a stream does not matter.
 */
export function createRngSet(runSeed) {
  const seed = String(runSeed);
  const streams = new Map();

  function stream(name) {
    if (!STREAMS.includes(name)) throw new Error(`Unknown RNG stream "${name}". Add it to STREAMS in rng.js.`);
    let rng = streams.get(name);
    if (!rng) {
      rng = createRng(`${seed}::${name}`);
      streams.set(name, rng);
    }
    return rng;
  }

  return {
    seed,
    stream,
    /** Snapshot of every stream used so far, for saves. */
    getState() {
      const out = {};
      for (const name of STREAMS) if (streams.has(name)) out[name] = streams.get(name).getState();
      return { seed, streams: out };
    },
    /** Restore a snapshot made by getState(). */
    setState(state) {
      if (state.seed !== seed) throw new Error(`RNG state is for seed "${state.seed}", not "${seed}"`);
      streams.clear();
      for (const [name, value] of Object.entries(state.streams)) stream(name).setState(value);
    },
  };
}

/** A fresh, human-typable run seed. The only place wall-clock time may seed anything. */
export function newRunSeed(now = Date.now()) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const rng = createRng(`boot:${now}`);
  let out = '';
  for (let i = 0; i < 8; i++) out += alphabet[rng.int(alphabet.length)];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}
