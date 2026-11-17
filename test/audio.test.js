import assert from 'node:assert/strict';
import { test } from 'node:test';

import { createAudio } from '../src/audio/engine.js';
import { EVENT_SOUNDS, PATCHES, validatePatch } from '../src/audio/patches.js';
import { AUTO_PAUSE, createSettings, defaultSettings, mergeSettings } from '../src/ui/settings.js';

/** A stand-in AudioContext that records what was built and lets the test move time. */
function fakeContext() {
  const param = () => ({ value: 0, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, cancelScheduledValues() {} });
  const node = (kind, log) => {
    const n = { kind, started: 0, stopped: 0, gain: param(), frequency: param(), detune: param(), Q: param(), connect: (to) => to, start: () => (n.started += 1), stop: () => (n.stopped += 1) };
    log.push(n);
    return n;
  };
  const made = [];
  const ctx = {
    made,
    state: 'suspended',
    currentTime: 0,
    sampleRate: 100,
    destination: {},
    resume() {
      ctx.state = 'running';
    },
    createGain: () => node('gain', made),
    createOscillator: () => node('osc', made),
    createBiquadFilter: () => node('filter', made),
    createBufferSource: () => node('noise', made),
    createBuffer: (channels, length) => ({ getChannelData: () => new Float32Array(length) }),
  };
  return ctx;
}

const count = (ctx, kind) => ctx.made.filter((n) => n.kind === kind).length;

test('every patch is well formed, and every game sound names a real one-shot patch', () => {
  for (const [name, patch] of Object.entries(PATCHES)) assert.deepEqual(validatePatch(patch), [], name);
  for (const [event, sound] of Object.entries(EVENT_SOUNDS)) {
    const names = typeof sound === 'function' ? [sound({ reason: 'order' }), sound({ reason: 'brownout' })] : [sound];
    for (const name of names.filter(Boolean)) {
      assert.ok(PATCHES[name], `${event} plays unknown patch "${name}"`);
      assert.ok(!PATCHES[name].loop, `${event} plays a loop`);
    }
  }
  assert.equal(EVENT_SOUNDS['power.changed']({ reason: 'brownout' }), null, 'a brownout is one sound, not a tick per system');
});

test('the patch checker catches bad patches', () => {
  const problems = validatePatch({ gain: 2, duration: -1, env: { attack: 0 }, voices: [{ wave: 'kazoo', freq: 0 }], noise: 3, filter: { type: 'comb' }, repeat: { count: 0 } }).join('\n');
  for (const text of ['gain', 'duration', 'env', 'unknown wave', 'freq', 'noise', 'filter', 'repeat']) assert.match(problems, new RegExp(text));
  assert.match(validatePatch({ gain: 0.1, duration: 0.1, env: { attack: 0.1, release: 0.1 }, voices: [] }).join(), /needs a voice or some noise/);
  assert.match(validatePatch({ loop: true, duration: 1, gain: 0.1, env: { attack: 0.1, release: 0.1 }, voices: [{ wave: 'sine', freq: 50 }] }).join(), /a loop has no duration/);
});

test('nothing plays until a gesture unlocks sound', () => {
  const ctx = fakeContext();
  let created = 0;
  const audio = createAudio({ createContext: () => (created += 1, ctx) });
  assert.equal(audio.play('click'), false);
  assert.equal(created, 0, 'no AudioContext is even made before the first touch');
  assert.equal(audio.unlocked, false);
  audio.unlock();
  audio.unlock();
  assert.equal(created, 1);
  assert.equal(audio.unlocked, true);
  assert.equal(audio.play('click'), true);
  assert.deepEqual(audio.stats.played, { click: 1 });
  assert.equal(count(ctx, 'osc'), PATCHES.click.voices.length);
});

test('a burst of the same sound is one sound; repeats and noise build what the patch says', () => {
  const ctx = fakeContext();
  const audio = createAudio({ createContext: () => ctx });
  audio.unlock();
  assert.equal(audio.play('tick'), true);
  assert.equal(audio.play('tick'), false, 'too soon');
  ctx.currentTime = 1;
  assert.equal(audio.play('tick'), true);
  assert.equal(audio.stats.played.tick, 2);

  const before = count(ctx, 'osc');
  audio.play('alarm');
  assert.equal(count(ctx, 'osc') - before, PATCHES.alarm.voices.length * PATCHES.alarm.repeat.count);
  audio.play('hiss');
  assert.equal(count(ctx, 'noise'), 1);
  assert.throws(() => audio.play('nope'), /Unknown sound patch/);
  assert.throws(() => audio.play('hum'), /is a loop/);
  assert.throws(() => audio.startLoop('click'), /not a loop/);
});

test('loops wait for the unlock, stop when muted and come back when unmuted', () => {
  const ctx = fakeContext();
  const audio = createAudio({ createContext: () => ctx });
  audio.startLoop('hum');
  assert.deepEqual(audio.loops, []);
  audio.unlock();
  assert.deepEqual(audio.loops, ['hum']);
  audio.muted = true;
  assert.deepEqual(audio.loops, []);
  assert.equal(audio.play('click'), false);
  audio.muted = false;
  assert.deepEqual(audio.loops, ['hum']);
  audio.stopLoop('hum');
  audio.muted = true;
  audio.muted = false;
  assert.deepEqual(audio.loops, [], 'a stopped loop stays stopped');
});

test('a device with no sound at all is not a problem', () => {
  const none = createAudio({ createContext: null });
  none.unlock();
  assert.equal(none.play('click'), false);
  const broken = createAudio({ createContext: () => { throw new Error('no audio'); } });
  broken.unlock();
  broken.startLoop('hum');
  assert.equal(broken.play('click'), false);
});

test('settings default to auto-pause on touch only, and every auto-pause has a setting', () => {
  assert.deepEqual(defaultSettings({ touch: true }).autoPause, { fired: true, contact: true, boarded: true, fire: true, breach: true, death: true, objection: true, refusal: true, situation: true });
  assert.deepEqual(defaultSettings({ touch: false }).autoPause, { fired: false, contact: false, boarded: false, fire: false, breach: false, death: false, objection: false, refusal: false, situation: false });
  assert.equal(defaultSettings({ touch: true }).shake, true, 'screen shake is on until turned off');
  assert.deepEqual(AUTO_PAUSE.map((item) => item.id).sort(), Object.keys(defaultSettings().autoPause).sort());
});

test('saved settings are merged carefully, saved on change, and survive bad storage', () => {
  assert.deepEqual(mergeSettings(defaultSettings({ touch: true }), { sound: 'loud', shake: false, autoPause: { fire: false, tea: true }, junk: 1 }), { sound: true, shake: false, scanlines: true, autoPause: { fired: true, contact: true, boarded: true, fire: false, breach: true, death: true, objection: true, refusal: true, situation: true } });

  const store = new Map([['cold-manifest.settings.v1', JSON.stringify({ sound: false })]]);
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const settings = createSettings({ storage, touch: false });
  assert.equal(settings.values.sound, false);
  const seen = [];
  settings.onChange((values) => seen.push(values.autoPause.breach));
  settings.set('autoPause.breach', true);
  settings.set('sound', true);
  assert.deepEqual(seen, [true, true]);
  assert.deepEqual(JSON.parse(store.get('cold-manifest.settings.v1')), { sound: true, shake: true, scanlines: true, autoPause: { fired: false, contact: false, boarded: false, fire: false, breach: true, death: false, objection: false, refusal: false, situation: false } });

  // URL overrides apply for the visit; broken or missing storage falls back to defaults.
  assert.deepEqual(createSettings({ storage, touch: true, overrides: { autoPause: false, sound: false } }).values, { sound: false, shake: true, scanlines: true, autoPause: { fired: false, contact: false, boarded: false, fire: false, breach: false, death: false, objection: false, refusal: false, situation: false } });
  const bad = { getItem: () => '{not json', setItem: () => { throw new Error('full'); } };
  const fallback = createSettings({ storage: bad, touch: true });
  assert.equal(fallback.values.autoPause.fire, true);
  fallback.set('sound', false);
  assert.equal(fallback.values.sound, false);
  assert.equal(createSettings({ storage: null, touch: false }).values.sound, true);
});
