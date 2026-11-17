// Being hunted (fun pass F.1; D-214 to D-216): a contact looks for us with a search beam and only learns anything
// when the beam crosses us; its certainty builds and falls where the scope can show it and sound it; it doubles
// back and pings; and every contact is over in about a minute and a half.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EVENT_SOUNDS, HUNT_TONES, PATCHES, STAGE_SOUNDS, huntTone, validatePatch } from '../src/audio/patches.js';
import { AWARE, HUNT, STAGES_OF_AWARENESS, contactView, scopeView, stageOf } from '../src/sim/encounters.js';
import { TICK_RATE, checkInvariants, createSim } from '../src/sim/sim.js';
import { STAGE_MARKS, hunter, hunterText } from '../src/ui/scope.js';
import { CATALOG, CREW, SHIP, content } from './helpers.js';

const ENCOUNTERS = content.all('encounters');
const newSim = (seed) => createSim({ seed, ship: SHIP, crew: CREW, ...CATALOG, ships: [], encounters: ENCOUNTERS });
function go(sim, command) {
  sim.enqueue(command);
  sim.step();
}
function goDark(sim) {
  go(sim, { type: 'lights.all', on: false });
  for (const station of ['sensors', 'engines']) if (!sim.state.stations[station].down) go(sim, { type: 'station.stand', station, down: true });
}
const first = (sim) => sim.state.scope.contacts[0];
/** Run until the encounter ends or `limit` seconds pass, with `each(sim, heard)` every tick. Returns what was heard and how it ended. */
function hunt(sim, { limit = 200, each = null } = {}) {
  const heard = { looks: [], stages: [], pings: [], ended: null };
  sim.events.on('contact.swept', (event) => heard.looks.push({ ...event, state: first(sim)?.state }));
  sim.events.on('contact.stage', (event) => heard.stages.push(event.stage));
  sim.events.on('contact.pinged', (event) => heard.pings.push(event));
  sim.events.on('encounter.ended', (event) => (heard.ended ??= event));
  for (let i = 0; i < limit * TICK_RATE && !heard.ended; i++) {
    each?.(sim, heard);
    sim.step();
    assert.deepEqual(checkInvariants(sim), [], `tick ${sim.state.tick}`);
  }
  return heard;
}

test('a contact only learns of us when its beam crosses us, and its certainty climbs look by look through every stage', () => {
  const sim = newSim('hunt-lit');
  go(sim, { type: 'debug.contact', encounter: 'patrol-cutter', range: 50, bearing: 30, miss: 10 });
  const contact = first(sim);
  assert.equal(stageOf(contact), 'passing');
  assert.equal(contact.sweep.mode, 'wide');
  let between = 0; // ticks where its certainty rose with no look
  let last = 0;
  let looks = 0;
  const heard = hunt(sim, {
    each(s, h) {
      const c = first(s);
      if (!c || c.state === 'closing' || c.state === 'alongside') return;
      if (c.aware > last + 1e-9 && h.looks.length === looks) between += 1;
      last = c.aware;
      looks = h.looks.length;
    },
  });
  assert.equal(between, 0, 'between looks it learns nothing');
  assert.deepEqual(heard.stages.filter((stage, i, all) => all.indexOf(stage) === i), ['brushed', 'sniff', 'sure'], 'brushed, then a sniff, then sure');
  const before = heard.looks.filter((look) => look.state !== 'closing' && look.state !== 'alongside');
  assert.ok(before.length >= 3, `it took ${before.length} looks to be sure`);
  for (let i = 1; i < before.length; i++) assert.ok(before[i].certainty >= before[i - 1].certainty - HUNT.fade * 15, 'a lit ship is read a little better each look');
  assert.ok(before.every((look) => look.found));
  assert.equal(heard.ended.outcome, 'docked');
  assert.ok(heard.ended.seconds < 90, `found and boarded in ${heard.ended.seconds} s`);
});

test('with a sniff it doubles back: the beam combs the patch we are in, and looks come quicker', () => {
  const sim = newSim('hunt-comb');
  go(sim, { type: 'lights.all', on: false }); // lamps off: enough to be faint, not enough to be gone
  go(sim, { type: 'debug.contact', encounter: 'patrol-cutter', range: 45, bearing: 200, miss: 5 });
  const gaps = { wide: [], narrow: [] };
  let lastLook = null;
  let off = 0;
  sim.events.on('contact.swept', (event) => {
    if (event.ping) return;
    const mode = first(sim).sweep.mode;
    if (lastLook !== null && lastLook.mode === mode) gaps[mode].push((event.tick - lastLook.tick) / TICK_RATE);
    lastLook = { tick: event.tick, mode };
  });
  for (let i = 0; i < 60 * TICK_RATE && first(sim) && first(sim).state !== 'closing' && first(sim).state !== 'lost'; i++) {
    sim.step();
    const view = contactView(sim, first(sim));
    if (view?.sweep?.mode === 'narrow') off = Math.max(off, Math.abs(view.sweep.off - view.sweep.centre));
  }
  assert.ok(gaps.wide.length >= 1 && gaps.narrow.length >= 2, JSON.stringify(gaps));
  assert.ok(Math.abs(gaps.wide[0] - 360 / HUNT.spin) < 1.5, `once round: ${gaps.wide[0]} s`);
  assert.ok(Math.max(...gaps.narrow) < gaps.wide[0] / 2, `combing: ${gaps.narrow.join(', ')} s between looks`);
  assert.ok(off > HUNT.arc * 0.8, `it swings ${off} degrees either side of where it thinks we are`);
});

test('go dark on a ship with a sniff and its certainty falls look by look; it searches, pings, and gives up', () => {
  const sim = newSim('hunt-dark');
  go(sim, { type: 'debug.contact', encounter: 'patrol-cutter', range: 55, bearing: 100, miss: 20 });
  let dark = false;
  const heard = hunt(sim, {
    each(s) {
      if (!dark && first(s)?.state === 'shadowing') {
        dark = true;
        goDark(s);
      }
    },
  });
  assert.ok(dark);
  const blanks = heard.looks.filter((look) => !look.found && !look.ping);
  assert.ok(blanks.length >= 2 && blanks[0].certainty < blanks[0].was, 'a look that finds nothing costs it certainty');
  assert.ok(heard.stages.includes('searching'), heard.stages.join(' '));
  assert.ok(heard.pings.length >= 1, 'it pinged for us');
  assert.equal(heard.ended.outcome, 'quiet');
  assert.equal(heard.stages.at(-1) === 'gone' || first(sim).state === 'lost', true);
  assert.ok(heard.ended.seconds < 90, `over in ${heard.ended.seconds} s`);
});

test('a ping reads a dark ship that a beam cannot, if it is close; and it shows us exactly where the pinger is', () => {
  const reads = (range) => {
    const sim = newSim('hunt-ping');
    goDark(sim);
    go(sim, { type: 'debug.contact', encounter: 'patrol-cutter', range, bearing: 0, miss: range });
    return { sim, ...hunt(sim, { each: (s, h) => h.pings.length && h.looks.at(-1).tick < s.state.tick - TICK_RATE && (h.ended = h.ended ?? { outcome: 'stopped' }) }) };
  };
  const near = reads(20);
  assert.ok(near.looks.filter((look) => !look.ping).every((look) => !look.found), 'its beam reads nothing of a dark ship');
  assert.equal(near.pings.length, 1, 'so after a few empty sweeps it pings');
  assert.equal(near.pings[0].found, true, 'and close in, the ping finds us');
  assert.equal(first(near.sim).track.known, true, 'a ping gives it away: we know what it is now');
  assert.equal(first(near.sim).sweep.pings, 1, 'and it has one fewer left');
  const far = reads(70);
  assert.equal(far.pings[0]?.found ?? false, false, 'from far off it does not');
});

test('the scope is told how close each contact is to finding us, whatever the return is like', () => {
  const sim = newSim('hunt-view');
  goDark(sim); // sensors down: a poor return
  go(sim, { type: 'debug.contact', encounter: 'raider-skiff', range: 100, bearing: 300, miss: 30 });
  for (let i = 0; i < 4 * TICK_RATE; i++) sim.step();
  const view = scopeView(sim);
  assert.equal(view.notice, AWARE.notice);
  assert.equal(view.sure, AWARE.close);
  const [seen] = view.contacts;
  assert.equal(seen.state, null, 'its intent cannot be read off a poor return');
  assert.equal(seen.stage, 'passing');
  assert.equal(seen.stageText, STAGES_OF_AWARENESS.passing);
  assert.equal(seen.certainty, 0);
  assert.equal(seen.sweep.mode, 'wide');
  assert.ok(Math.abs(seen.sweep.off) <= 180);
  assert.equal(hunterText(hunter(view)), 'C1 SWEEPING · 0%');
  first(sim).aware = 0.5;
  first(sim).state = 'shadowing';
  assert.equal(hunterText(hunter(scopeView(sim))), 'C1 HAS A SNIFF · 50%');
});

test('every stage of a contact\'s awareness has a mark on the scope and a sound, and the tone climbs with its certainty', () => {
  const stages = Object.keys(STAGES_OF_AWARENESS);
  assert.deepEqual(stages, ['passing', 'brushed', 'sniff', 'sure', 'searching', 'gone']);
  assert.deepEqual(Object.keys(STAGE_MARKS), stages);
  assert.deepEqual(Object.keys(STAGE_SOUNDS), stages);
  for (const stage of stages) {
    assert.ok(STAGE_MARKS[stage].words && STAGE_MARKS[stage].colour, `${stage} has words and a colour`);
    assert.deepEqual(validatePatch(PATCHES[STAGE_SOUNDS[stage]]), [], `${stage} sounds`);
  }
  assert.equal(new Set(Object.values(STAGE_MARKS).map((mark) => mark.words)).size, stages.length, 'no two stages read the same');
  assert.equal(new Set(Object.values(STAGE_SOUNDS)).size, stages.length, 'or sound the same');
  // Every stage a contact can be in maps to one of them.
  for (const [state, extra, want] of [['unseen', {}, 'passing'], ['unseen', { aware: 0.1 }, 'brushed'], ['shadowing', {}, 'sniff'], ['shadowing', { searching: true }, 'searching'], ['closing', {}, 'sure'], ['alongside', {}, 'sure'], ['lost', {}, 'gone']]) assert.equal(stageOf({ state, aware: 0, searching: false, ...extra }), want);

  // The tone of a look climbs from a sniff to sure, each step higher than the last.
  const pitches = HUNT_TONES.map((name) => PATCHES[name].voices[0].freq);
  for (let i = 1; i < pitches.length; i++) assert.ok(pitches[i] > pitches[i - 1]);
  assert.equal(huntTone(0.05), 'tone1');
  assert.equal(huntTone(AWARE.notice), 'tone2');
  assert.equal(huntTone(1), 'tone5');
  const swept = EVENT_SOUNDS['contact.swept'];
  assert.equal(swept({ shown: true, found: false, certainty: 0 }), 'sweep', 'a beam that reads nothing is a tick');
  assert.equal(swept({ shown: true, found: true, certainty: 0.65 }), 'tone4');
  assert.equal(swept({ shown: false, found: true, certainty: 0.65 }), null, 'what is not on our scope is not heard');
  const staged = EVENT_SOUNDS['contact.stage'];
  for (const stage of stages.filter((name) => name !== 'passing')) assert.equal(staged({ shown: true, stage }), STAGE_SOUNDS[stage]);
  assert.equal(EVENT_SOUNDS['contact.pinged']({}), 'ping');
});

test('a contact is over in about a minute and a half: every kind, lit, dark or run from', () => {
  const lengths = [];
  for (const def of ENCOUNTERS) {
    for (const tactic of ['lit', 'dark', 'run']) {
      for (const n of [1, 2, 3]) {
        const sim = newSim(`cap:${def.id}:${tactic}:${n}`);
        sim.state.money = 0; // nothing to pay a toll with: it has to end some other way
        if (tactic === 'dark') goDark(sim);
        go(sim, { type: 'debug.contact', encounter: def.id, range: 40 + n * 5, bearing: n * 100, miss: n * 8 });
        if (tactic === 'run') {
          go(sim, { type: 'helm.heading', heading: (n * 100 + 180) % 360 });
          go(sim, { type: 'helm.burn', on: true });
        }
        const { ended } = hunt(sim, { limit: 181 });
        assert.ok(ended, `${def.id}, ${tactic} ${n}: still going after three minutes`);
        lengths.push(ended.seconds);
      }
    }
  }
  lengths.sort((a, b) => a - b);
  assert.ok(lengths[Math.floor(lengths.length / 2)] < 90, `median ${lengths[Math.floor(lengths.length / 2)]} s`);
  assert.ok(lengths.at(-1) <= HUNT.most + 1, `longest ${lengths.at(-1)} s`);
});
