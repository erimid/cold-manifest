// The sound engine (brief §4): plays patches from patches.js with WebAudio.
//
// Browsers (iOS above all) allow no sound until the player has touched the
// page, so nothing is created until unlock() is called from a real gesture.
// Before that, and whenever sound is off, play() does nothing but count.

import { createRng } from '../engine/rng.js';
import { PATCHES } from './patches.js';

/** The same patch will not restart more often than this (seconds), so a burst of events is one sound, not a buzz. */
const MIN_REPEAT_SECONDS = 0.06;

/**
 * createContext makes an AudioContext; tests pass a fake. Returns the engine:
 *   unlock()            call from a tap or key press; safe to call every time
 *   play(name)          play a one-shot patch
 *   startLoop(name), stopLoop(name)
 *   muted               get or set
 */
export function createAudio({ createContext, patches = PATCHES } = {}) {
  let ctx = null;
  let master = null;
  let noiseBuffer = null;
  let muted = false;
  const lastPlayed = new Map(); // patch name -> context time
  const loops = new Map(); // patch name -> { stop } once sounding
  const wanted = new Set(); // loops asked for, sounding or not
  const stats = { played: {}, skipped: 0 };

  function noise() {
    if (!noiseBuffer) {
      // One second of white noise, made once, from its own seeded dice (never the sim's).
      noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      const dice = createRng('audio-noise');
      for (let i = 0; i < data.length; i++) data[i] = dice.next() * 2 - 1;
    }
    const source = ctx.createBufferSource();
    source.buffer = noiseBuffer;
    source.loop = true;
    return source;
  }

  /** Build one note of a patch starting at `at`. Returns a function that ends it early. */
  function build(patch, at) {
    const end = patch.loop ? null : at + patch.duration;
    const amp = ctx.createGain();
    amp.gain.setValueAtTime(0, at);
    amp.gain.linearRampToValueAtTime(patch.gain, at + patch.env.attack);
    if (end !== null) {
      amp.gain.setValueAtTime(patch.gain, Math.max(end, at + patch.env.attack));
      amp.gain.linearRampToValueAtTime(0, Math.max(end, at + patch.env.attack) + patch.env.release);
    }
    let out = amp;
    if (patch.filter) {
      const filter = ctx.createBiquadFilter();
      filter.type = patch.filter.type;
      filter.frequency.setValueAtTime(patch.filter.freq, at);
      if (patch.filter.to && end !== null) filter.frequency.exponentialRampToValueAtTime(patch.filter.to, end);
      if (patch.filter.q) filter.Q.value = patch.filter.q;
      amp.connect(filter);
      out = filter;
    }
    out.connect(master);

    const sources = [];
    const share = 1 / Math.max(1, patch.voices.length + (patch.noise ? 1 : 0));
    for (const voice of patch.voices) {
      const osc = ctx.createOscillator();
      osc.type = voice.wave;
      osc.frequency.setValueAtTime(voice.freq, at);
      if (voice.to && end !== null) osc.frequency.exponentialRampToValueAtTime(voice.to, end);
      if (voice.detune) osc.detune.value = voice.detune;
      const level = ctx.createGain();
      level.gain.value = share;
      osc.connect(level).connect(amp);
      sources.push(osc);
    }
    if (patch.noise) {
      const source = noise();
      const level = ctx.createGain();
      level.gain.value = patch.noise * share;
      source.connect(level).connect(amp);
      sources.push(source);
    }
    const stopAt = end === null ? null : Math.max(end, at + patch.env.attack) + patch.env.release + 0.02;
    for (const source of sources) {
      source.start(at);
      if (stopAt !== null) source.stop(stopAt);
    }
    return () => {
      const now = ctx.currentTime;
      amp.gain.cancelScheduledValues(now);
      amp.gain.setValueAtTime(amp.gain.value, now);
      amp.gain.linearRampToValueAtTime(0, now + patch.env.release);
      for (const source of sources) source.stop(now + patch.env.release + 0.02);
    };
  }

  function soundLoops() {
    if (!ctx || muted) return;
    for (const name of wanted) if (!loops.has(name)) loops.set(name, { stop: build(patches[name], ctx.currentTime) });
  }

  function silenceLoops() {
    for (const loop of loops.values()) loop.stop();
    loops.clear();
  }

  const audio = {
    stats,
    get unlocked() {
      return Boolean(ctx) && ctx.state === 'running';
    },
    get muted() {
      return muted;
    },
    set muted(value) {
      muted = Boolean(value);
      if (muted) silenceLoops();
      else soundLoops();
    },
    /** Call from inside a tap, click or key handler. Does nothing once sound is running. */
    unlock() {
      if (!createContext) return;
      try {
        if (!ctx) {
          ctx = createContext();
          master = ctx.createGain();
          master.gain.value = 0.9;
          master.connect(ctx.destination);
        }
        if (ctx.state !== 'running') ctx.resume?.();
        soundLoops();
      } catch {
        // No sound on this device. The game does not need it.
        ctx = null;
      }
    },
    /** Play a one-shot patch by name. Returns true if it sounded. */
    play(name) {
      const patch = patches[name];
      if (!patch) throw new Error(`Unknown sound patch "${name}"`);
      if (patch.loop) throw new Error(`"${name}" is a loop: use startLoop`);
      if (!ctx || muted || ctx.state !== 'running') {
        stats.skipped += 1;
        return false;
      }
      const now = ctx.currentTime;
      if (now - (lastPlayed.get(name) ?? -1) < MIN_REPEAT_SECONDS) {
        stats.skipped += 1;
        return false;
      }
      lastPlayed.set(name, now);
      const count = patch.repeat?.count ?? 1;
      for (let i = 0; i < count; i++) build(patch, now + i * (patch.repeat?.gap ?? 0));
      stats.played[name] = (stats.played[name] ?? 0) + 1;
      return true;
    },
    startLoop(name) {
      if (!patches[name]?.loop) throw new Error(`"${name}" is not a loop patch`);
      wanted.add(name);
      soundLoops();
    },
    stopLoop(name) {
      wanted.delete(name);
      loops.get(name)?.stop();
      loops.delete(name);
    },
    get loops() {
      return [...loops.keys()];
    },
  };
  return audio;
}
