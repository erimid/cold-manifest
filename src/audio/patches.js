// Sound patches as data (brief §4). Each patch is a few oscillators, an
// envelope and a filter; the engine in engine.js turns one into WebAudio
// nodes. Game events trigger patches by name through EVENT_SOUNDS.
//
// These are Stage 1 placeholders (DECISIONS DF-02): functional beeps and
// hums. The real sound design is Stage 11.
//
// A patch:
//   gain      peak loudness, 0 to 1
//   duration  seconds the note is held before its release
//   env       { attack, release } in seconds
//   voices    [{ wave, freq, to?, detune? }]: `to` glides the pitch over the note
//   noise     0 to 1: white noise mixed in
//   filter    { type, freq, to?, q? }
//   repeat    { count, gap }: play it this many times, `gap` seconds apart
//   loop      true for a sound that runs until stopped (no duration)

export const PATCHES = Object.freeze({
  hum: { loop: true, gain: 0.05, env: { attack: 1.5, release: 0.8 }, voices: [{ wave: 'sawtooth', freq: 55 }, { wave: 'sawtooth', freq: 55, detune: 9 }, { wave: 'sine', freq: 110 }], filter: { type: 'lowpass', freq: 180, q: 1 } },
  click: { gain: 0.12, duration: 0.02, env: { attack: 0.002, release: 0.04 }, voices: [{ wave: 'square', freq: 660, to: 440 }], filter: { type: 'lowpass', freq: 2400 } },
  deny: { gain: 0.14, duration: 0.09, env: { attack: 0.004, release: 0.08 }, voices: [{ wave: 'square', freq: 150 }, { wave: 'square', freq: 158 }], filter: { type: 'lowpass', freq: 900 } },
  blip: { gain: 0.05, duration: 0.012, env: { attack: 0.002, release: 0.03 }, voices: [{ wave: 'triangle', freq: 520 }], filter: { type: 'bandpass', freq: 900, q: 2 } },
  tick: { gain: 0.1, duration: 0.03, env: { attack: 0.002, release: 0.06 }, voices: [{ wave: 'sine', freq: 880 }] },
  door: { gain: 0.1, duration: 0.16, env: { attack: 0.01, release: 0.12 }, voices: [{ wave: 'sawtooth', freq: 90, to: 60 }], noise: 0.5, filter: { type: 'lowpass', freq: 1200, to: 300 } },
  alarm: { gain: 0.16, duration: 0.18, env: { attack: 0.01, release: 0.06 }, voices: [{ wave: 'square', freq: 740, to: 560 }], filter: { type: 'lowpass', freq: 2600 }, repeat: { count: 3, gap: 0.3 } },
  klaxon: { gain: 0.16, duration: 0.3, env: { attack: 0.02, release: 0.1 }, voices: [{ wave: 'sawtooth', freq: 300, to: 420 }, { wave: 'sawtooth', freq: 304, to: 426 }], filter: { type: 'lowpass', freq: 1800 }, repeat: { count: 2, gap: 0.5 } },
  powerdown: { gain: 0.16, duration: 0.7, env: { attack: 0.01, release: 0.3 }, voices: [{ wave: 'sawtooth', freq: 220, to: 40 }], filter: { type: 'lowpass', freq: 1400, to: 120 } },
  thunk: { gain: 0.22, duration: 0.25, env: { attack: 0.003, release: 0.5 }, voices: [{ wave: 'sine', freq: 90, to: 34 }], noise: 0.6, filter: { type: 'lowpass', freq: 500, to: 80 } },
  hiss: { gain: 0.1, duration: 0.5, env: { attack: 0.02, release: 0.5 }, voices: [], noise: 1, filter: { type: 'highpass', freq: 2500 } },
  chirp: { gain: 0.1, duration: 0.08, env: { attack: 0.004, release: 0.1 }, voices: [{ wave: 'sine', freq: 660, to: 990 }] },
  flatline: { gain: 0.12, duration: 1.2, env: { attack: 0.01, release: 0.6 }, voices: [{ wave: 'sine', freq: 440 }], filter: { type: 'lowpass', freq: 1200 } },
  shot: { gain: 0.14, duration: 0.09, env: { attack: 0.002, release: 0.16 }, voices: [{ wave: 'sawtooth', freq: 1400, to: 220 }], noise: 0.25, filter: { type: 'lowpass', freq: 3200, to: 600 } },
  shield: { gain: 0.12, duration: 0.22, env: { attack: 0.005, release: 0.35 }, voices: [{ wave: 'sine', freq: 520, to: 780 }, { wave: 'sine', freq: 527, to: 790 }], filter: { type: 'bandpass', freq: 900, q: 3 } },
  pause: { gain: 0.08, duration: 0.05, env: { attack: 0.004, release: 0.1 }, voices: [{ wave: 'sine', freq: 330, to: 262 }] },
});

/** Which patch a game event plays. An entry may be a name, or a function of the event returning a name or null. */
export const EVENT_SOUNDS = Object.freeze({
  'fire.started': 'alarm',
  'breach.opened': 'klaxon',
  'fire.found': 'alarm',
  'breach.found': 'klaxon',
  'fix.ready': 'chirp',
  'enemy.lock.gained': 'tick',
  'fire.out': 'hiss',
  'breach.sealed': 'chirp',
  'system.repaired': 'chirp',
  'door.opened': 'door',
  'door.closed': 'door',
  'power.changed': (event) => (event.reason === 'order' ? 'tick' : null),
  'power.brownout': 'powerdown',
  'room.jettisoned': 'thunk',
  'crew.died': 'flatline',
  'fight.started': 'klaxon',
  'weapon.ready': 'chirp',
  'weapon.fired': 'shot',
  'shot.resolved': (event) => (event.result === 'hit' ? 'thunk' : event.result === 'shield' ? 'shield' : null),
});

const WAVES = ['sine', 'square', 'sawtooth', 'triangle'];
const FILTERS = ['lowpass', 'highpass', 'bandpass'];
const positive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

/** Problems with a patch, as readable strings. */
export function validatePatch(patch) {
  const problems = [];
  if (!patch || typeof patch !== 'object') return ['not an object'];
  if (!(patch.gain > 0 && patch.gain <= 1)) problems.push('gain must be above 0 and at most 1');
  if (patch.loop ? patch.duration !== undefined : !positive(patch.duration)) problems.push(patch.loop ? 'a loop has no duration' : 'duration must be above 0');
  if (!patch.env || !positive(patch.env.attack) || !positive(patch.env.release)) problems.push('env needs attack and release above 0');
  if (!Array.isArray(patch.voices)) problems.push('voices must be a list');
  else {
    patch.voices.forEach((voice, i) => {
      if (!WAVES.includes(voice.wave)) problems.push(`voice ${i + 1}: unknown wave "${voice.wave}"`);
      if (!positive(voice.freq)) problems.push(`voice ${i + 1}: freq must be above 0`);
      if (voice.to !== undefined && !positive(voice.to)) problems.push(`voice ${i + 1}: "to" must be above 0`);
    });
    if (!patch.voices.length && !(patch.noise > 0)) problems.push('needs a voice or some noise');
  }
  if (patch.noise !== undefined && !(patch.noise >= 0 && patch.noise <= 1)) problems.push('noise must be between 0 and 1');
  if (patch.filter && (!FILTERS.includes(patch.filter.type) || !positive(patch.filter.freq))) problems.push('filter needs a known type and a freq above 0');
  if (patch.repeat && (!Number.isInteger(patch.repeat.count) || patch.repeat.count < 1 || !positive(patch.repeat.gap))) problems.push('repeat needs a whole count and a gap above 0');
  if (patch.repeat && patch.loop) problems.push('a loop cannot repeat');
  return problems;
}
