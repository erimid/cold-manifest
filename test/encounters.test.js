// The scope and its contacts (Stage H, H.1; D-151): the helm, what each side makes of the other, and the
// four ways to slip a contact, each against a run of the same encounter where we do nothing.

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { validateContent } from '../src/engine/content-schema.js';
import { ALONGSIDE, ENDINGS, HELM, SCOPE, STATES, bluffChance, contactView, errorOf, returnQuality, scopeView, speedOf, validateEncounter } from '../src/sim/encounters.js';
import { signature } from '../src/sim/senses.js';
import { TICK_RATE, checkInvariants, createSim } from '../src/sim/sim.js';
import { readContentFiles } from '../tools/lib/load-content.js';
import { CATALOG, CREW, SHIP, content } from './helpers.js';

const ENCOUNTERS = content.all('encounters');
const SECTOR = content.require('sectors', 'the-reach');

const newSim = (seed = 'scope', extra = {}) => createSim({ seed, ship: SHIP, crew: CREW, ...CATALOG, encounters: ENCOUNTERS, ...extra });
/** A sim with no enemy ships to fight, so a docking is just a docking. */
const quietSim = (seed, extra = {}) => newSim(seed, { ships: [], ...extra });

function go(sim, command) {
  sim.enqueue(command);
  sim.step();
}
function seconds(sim, n) {
  for (let i = 0; i < n * TICK_RATE; i++) {
    sim.step();
    const problems = checkInvariants(sim);
    assert.deepEqual(problems, [], `tick ${sim.state.tick}`);
  }
}
/** Every lamp off, and the sensors and engines powered down: as quiet as she gets with air to breathe. */
function goDark(sim) {
  if (!sim.whyNot({ type: 'lights.all', on: false })) go(sim, { type: 'lights.all', on: false });
  for (const system of ['sensors', 'engines']) while (sim.state.systems[system].power > 0) go(sim, { type: 'power.add', system, delta: -1 });
}
/** Every bar the engines can take, paid for by the sensors. */
function fullEngines(sim) {
  go(sim, { type: 'power.add', system: 'sensors', delta: -1 });
  go(sim, { type: 'power.add', system: 'engines', delta: 1 });
  assert.equal(sim.state.systems.engines.power, sim.state.systems.engines.level);
}
/** Run until the encounter ends (or `limit` seconds pass) and say how: { outcome, seconds, heard }. */
function play(sim, limit = 900, each = null) {
  const heard = [];
  let ended = null;
  for (const type of ['contact.sighted', 'contact.identified', 'contact.noticed', 'contact.closing', 'contact.searching', 'contact.alongside', 'contact.docked', 'contact.lost', 'contact.passed', 'contact.fooled', 'contact.wise', 'contact.took']) sim.events.on(type, () => heard.push(type.replace('contact.', '')));
  sim.events.on('encounter.ended', (event) => (ended ??= event));
  const start = sim.state.tick;
  while (!ended && sim.state.tick - start < limit * TICK_RATE) {
    each?.(sim, (sim.state.tick - start) / TICK_RATE);
    sim.step();
    const problems = checkInvariants(sim);
    assert.deepEqual(problems, [], `tick ${sim.state.tick}`);
  }
  return { outcome: ended?.outcome ?? null, seconds: ended?.seconds ?? null, heard };
}
const spawn = (sim, encounter, options = {}) => go(sim, { type: 'debug.contact', encounter, ...options });
const first = (sim) => sim.state.scope.contacts[0];

// ---------- content ----------

test('every encounter in content/encounters is sound, and the checker says what is wrong with a bad one', () => {
  assert.ok(ENCOUNTERS.length >= 4, 'at least four kinds of contact');
  const refs = { weapons: new Set(content.all('weapons').map((item) => item.id)), encounters: new Set(ENCOUNTERS.map((item) => item.id)) };
  for (const item of ENCOUNTERS) assert.deepEqual(validateEncounter(item, refs), [], item.id);
  assert.deepEqual([...new Set(ENCOUNTERS.map((item) => item.wants))].sort(), ['cargo', 'crew', 'hull', 'inspect', 'salvage', 'scan', 'toll'], 'one for each thing a contact can be looking for');

  const { _file, ...good } = ENCOUNTERS[0];
  const bad = (change) => validateEncounter({ ...good, ...change }, refs).join('; ');
  assert.match(bad({ wants: 'tea' }), /wants must be one of/);
  assert.match(bad({ notice: 0.5, sure: 0.3 }), /notice below sure/);
  assert.match(bad({ bluffs: { flattery: 0.5 } }), /no bluff "flattery"/);
  assert.match(bad({ decoys: { chaff: 1 } }), /no decoy "chaff"/);
  assert.match(bad({ alongside: { seconds: 10, hail: 'Heave to.', fight: 'nobody' } }), /alongside: unknown key "fight"/);
  assert.match(bad({ guns: { ...good.guns, weapon: 'death-ray' } }), /no weapon "death-ray"/);
  assert.match(bad({ wants: 'toll' }), /needs a toll/);
  assert.match(bad({ wants: 'scan', scan: { range: 10, seconds: 5, calls: 'nobody' } }), /no encounter "nobody"/);
  assert.match(bad({ colour: 'red' }), /unknown key "colour"/);

  // The whole content folder still checks clean, and a sector may only name real kinds of point for its contacts.
  const files = readContentFiles();
  assert.deepEqual(validateContent(files).errors, []);
  const broken = structuredClone(files);
  broken.find((file) => file.path.startsWith('sectors/')).data.items[0].contacts = { port: 0.5, nowhere: 2 };
  const errors = validateContent(broken).errors.join('\n');
  assert.match(errors, /contacts: a contact cannot turn up at a port/);
  assert.match(errors, /contacts: unknown kind "nowhere"/);
});

// ---------- the helm ----------

test('the helm: she comes round with a pilot and power, the drive pushes her, and cutting it leaves her drifting', () => {
  const sim = quietSim('helm');
  seconds(sim, 1);
  assert.equal(speedOf(sim), 0);
  assert.equal(signature(sim).burn, 0, 'powered engines are not a burning drive');

  go(sim, { type: 'helm.heading', heading: 180 });
  go(sim, { type: 'helm.burn', on: true });
  seconds(sim, 3);
  assert.ok(sim.state.helm.heading > 90 && sim.state.helm.heading < 180, `coming round: ${sim.state.helm.heading}`);
  assert.equal(signature(sim).burn, 0.5, 'one bar of two on a lit drive');
  seconds(sim, 40);
  assert.equal(sim.state.helm.heading, 180);
  const half = speedOf(sim);
  assert.ok(Math.abs(half - HELM.speed * 0.5) < 1e-6, `half the engines, half the speed: ${half}`);

  // More power, more speed.
  fullEngines(sim);
  seconds(sim, 30);
  assert.ok(Math.abs(speedOf(sim) - HELM.speed) < 1e-6, `flat out: ${speedOf(sim)}`);

  // Cut the drive: she drifts on exactly as she was going, and gives off no burn.
  go(sim, { type: 'helm.burn', on: false });
  const before = { ...sim.state.helm };
  seconds(sim, 20);
  assert.equal(sim.state.helm.vx, before.vx);
  assert.equal(sim.state.helm.vy, before.vy);
  assert.equal(signature(sim).burn, 0);
  assert.equal(scopeView(sim).burning, false);

  // Nobody at the helm: she will not come round, and the drive cannot be lit.
  go(sim, { type: 'crew.move', crew: 'ilse', room: 'quarters' });
  seconds(sim, 15);
  assert.match(sim.whyNot({ type: 'helm.heading', heading: 0 }), /nobody is at the helm/);
  assert.match(sim.whyNot({ type: 'helm.burn', on: true }), /nobody is at the helm/);
});

// ---------- the scope ----------

test('a return is worse from far off and better with the sensors up and someone on them', () => {
  const quality = (range, prepare = () => {}) => {
    const sim = quietSim('scope-quality');
    seconds(sim, 1);
    prepare(sim);
    spawn(sim, 'patrol-cutter', { range, bearing: 40 });
    return returnQuality(sim, first(sim));
  };
  const sensorsOff = (sim) => go(sim, { type: 'power.add', system: 'sensors', delta: -1 });
  const manned = (sim) => {
    go(sim, { type: 'crew.move', crew: 'okoro', room: 'sensors' });
    seconds(sim, 20);
    assert.equal(sim.state.crew.okoro.room, 'sensors');
  };
  const near = quality(40);
  const far = quality(95);
  assert.ok(far < near, `further is worse: ${far} against ${near}`);
  assert.ok(errorOf(far).bearing > errorOf(near).bearing && errorOf(far).range > errorOf(near).range, 'and the error grows with it');
  assert.ok(quality(95, sensorsOff) < far, 'sensors without power read worse');
  assert.ok(quality(95, manned) > far, 'someone in the sensors room reads better');
  assert.equal(quality(SCOPE.reach + 10), 0, 'past the reach of the scope there is nothing');
});

test('the scope shows a contact as a bearing and a range with an error the truth is always inside, and names it once it can', () => {
  const sim = quietSim('scope-view');
  seconds(sim, 1);
  go(sim, { type: 'power.add', system: 'sensors', delta: -1 }); // passive: a poor picture
  goDark(sim);
  const heard = [];
  for (const type of ['contact.sighted', 'contact.identified']) sim.events.on(type, (event) => heard.push([type, event.label]));
  spawn(sim, 'patrol-cutter', { range: 90, bearing: 300, miss: 60 });
  assert.equal(contactView(sim, first(sim)), null, 'nothing on the scope the moment it arrives');

  let named = null;
  let shown = 0;
  for (let i = 0; i < 200 * TICK_RATE && first(sim); i++) {
    sim.step();
    const contact = first(sim);
    if (!contact) break;
    const view = contactView(sim, contact);
    if (!view || view.stale) continue;
    shown += 1;
    const range = Math.hypot(contact.x, contact.y);
    const bearing = (Math.atan2(contact.x, contact.y) * 180) / Math.PI;
    const off = Math.abs(((view.bearing - bearing + 540) % 360) - 180);
    assert.ok(off <= view.bearingError + 1e-6, `bearing out by ${off}, error ${view.bearingError}`);
    assert.ok(Math.abs(view.range - range) <= view.rangeError * range + 1e-6, `range ${view.range} against ${range}`);
    if (!view.known) assert.equal(view.name, 'Unknown return');
    else named ??= view.name;
  }
  assert.ok(shown > 100, 'it was on the scope');
  assert.deepEqual(heard[0], ['contact.sighted', 'C1']);
  assert.equal(named, null, 'on passive sensors, in the dark, a far contact is never made out');

  // Sensors up: the same kind of contact, closer, is named.
  const lit = quietSim('scope-view-2');
  seconds(lit, 1);
  spawn(lit, 'patrol-cutter', { range: 50, bearing: 300, miss: 60 });
  seconds(lit, 10);
  const view = contactView(lit, first(lit));
  assert.equal(view.name, 'Patrol cutter');
  assert.ok(view.bearingError < 10, `a good return: ${view.bearingError}`);
  assert.ok(scopeView(lit).contacts.length === 1 && scopeView(lit).contacts[0].label === 'C1');
});

// ---------- the state machine ----------

test('a contact that finds us runs through every state: unseen, shadowing, closing, alongside, docked', () => {
  assert.deepEqual(STATES, ['unseen', 'shadowing', 'closing', 'alongside', 'docked', 'lost']);
  const sim = quietSim('states');
  seconds(sim, 1);
  spawn(sim, 'patrol-cutter', { range: 85, bearing: 0, miss: 20 });
  assert.equal(first(sim).state, 'unseen');
  const seen = [];
  const result = play(sim, 400, (s) => {
    const state = first(s)?.state;
    if (state && seen.at(-1) !== state) seen.push(state);
  });
  assert.deepEqual(seen, ['unseen', 'shadowing', 'closing', 'alongside']);
  assert.equal(result.outcome, 'docked');
  assert.deepEqual(result.heard.filter((type) => ['noticed', 'closing', 'alongside', 'docked'].includes(type)), ['noticed', 'closing', 'alongside', 'docked']);
  assert.equal(sim.state.scope.contacts.length, 0, 'a docked ship is no longer a contact');
  assert.equal(sim.state.scope.record.at(-1).outcome, 'docked');
});

test('a ship that docks puts its party at our lock (H.2), and a second one waits alongside until the first has gone', () => {
  const sim = newSim('dock-party');
  seconds(sim, 1);
  spawn(sim, 'patrol-cutter', { range: 30, bearing: 0, state: 'closing' });
  spawn(sim, 'raider-skiff', { range: 30, bearing: 180, state: 'closing' });
  const result = play(sim, 200);
  assert.equal(result.outcome, 'docked');
  assert.equal(sim.state.fight, undefined, 'no duel any more');
  assert.equal(sim.state.boarding?.phase, 'demand');
  const waiting = first(sim);
  seconds(sim, 30);
  assert.equal(waiting.state, 'alongside', 'the other one holds alongside while a party is at our lock');
  go(sim, { type: 'debug.boarding', clear: true });
  seconds(sim, 1);
  assert.equal(sim.state.boarding?.encounter, 'raider-skiff', 'and docks once the clamp is free');
});

test('no jump with a ship alongside, and a jump leaves every contact behind', () => {
  const sim = quietSim('jump', { sector: { ...SECTOR, contacts: {} } });
  seconds(sim, 1);
  const { run } = sim.state;
  const next = run.map.lanes.find((lane) => lane.a === run.at || lane.b === run.at);
  go(sim, { type: 'course.plot', to: next.a === run.at ? next.b : next.a });
  go(sim, { type: 'debug.run', fix: true });
  assert.equal(sim.whyNot({ type: 'course.jump' }), null);

  spawn(sim, 'raider-skiff', { range: ALONGSIDE, bearing: 0, state: 'closing' });
  seconds(sim, 2);
  assert.equal(first(sim).state, 'alongside');
  assert.match(sim.whyNot({ type: 'course.jump' }), /a ship is alongside/);

  go(sim, { type: 'debug.contact', clear: true });
  spawn(sim, 'raider-skiff', { range: 60, bearing: 0, state: 'closing' });
  go(sim, { type: 'helm.burn', on: true });
  go(sim, { type: 'debug.run', fix: true });
  const ended = [];
  sim.events.on('encounter.ended', (event) => ended.push(event.outcome));
  go(sim, { type: 'course.jump' });
  assert.deepEqual(ended, ['jumped']);
  assert.equal(sim.state.scope.contacts.length, 0);
  assert.equal(speedOf(sim), 0, 'and we arrive at rest, drive cold');
  assert.equal(sim.state.helm.burn, false);
});

test('arriving at a point can bring a contact, by the sector\'s chances and each encounter\'s `at`', () => {
  const always = { empty: 1, hazard: 1, derelict: 1, checkpoint: 1 };
  const sim = quietSim('arrivals', { sector: { ...SECTOR, contacts: always }, run: { pursuit: false } });
  const { run } = sim.state;
  const spawned = [];
  sim.events.on('contact.spawned', (event) => spawned.push(event.encounter));
  let kind = null;
  sim.events.on('sector.arrived', (event) => (kind = event.kind));
  for (let jumps = 0; jumps < 6 && !run.delivered; jumps++) {
    const lane = run.map.lanes.find((l) => l.a === run.at && !run.visited.includes(l.b));
    if (!lane) break;
    go(sim, { type: 'debug.run', fuel: run.fuelMax });
    go(sim, { type: 'course.plot', to: lane.b });
    go(sim, { type: 'debug.run', fix: true });
    const before = spawned.length;
    go(sim, { type: 'course.jump' });
    if (kind === 'port') assert.equal(spawned.length, before, 'nobody lies in wait at a port');
    else {
      assert.equal(spawned.length, before + 1, `a contact at a ${kind}`);
      const def = ENCOUNTERS.find((item) => item.id === spawned.at(-1));
      assert.ok(!def.at || def.at.includes(kind), `${def.id} at a ${kind}`);
      assert.equal(sim.state.scope.contacts.length, 1, 'the one before was left behind by the jump');
    }
  }
  assert.ok(spawned.length >= 2);

  // With no chances set, nothing turns up.
  const none = quietSim('arrivals', { sector: { ...SECTOR, contacts: {} }, run: { pursuit: false } });
  none.events.on('contact.spawned', () => assert.fail('a contact with no chance of one'));
  const lane = none.state.run.map.lanes.find((l) => l.a === none.state.run.at);
  go(none, { type: 'course.plot', to: lane.b });
  go(none, { type: 'debug.run', fix: true });
  go(none, { type: 'course.jump' });
});

// ---------- the four ways to slip a contact (the session's "done when") ----------

test('slipped by going quiet: a cutter that would have found us lit passes a dark ship, and one that has a sniff of us loses it', () => {
  const pass = (prepare) => {
    const sim = quietSim('quiet');
    seconds(sim, 1);
    prepare(sim);
    spawn(sim, 'patrol-cutter', { range: 85, bearing: 0, miss: 35 });
    return play(sim);
  };
  const lit = pass(() => {});
  assert.equal(lit.outcome, 'docked', 'lamps on, sensors pinging: it finds us');
  const dark = pass(goDark);
  assert.equal(dark.outcome, 'passed', 'dark and cold: it goes by');
  assert.ok(!dark.heard.includes('noticed'));

  // A raider that already has a sniff of us: go dark, and it searches the wrong patch of space and gives up.
  const shadowed = (prepare) => {
    const sim = quietSim('quiet-2');
    seconds(sim, 1);
    spawn(sim, 'raider-skiff', { range: 75, bearing: 0, state: 'shadowing' });
    prepare(sim);
    return play(sim);
  };
  assert.equal(shadowed(() => {}).outcome, 'docked');
  const lost = shadowed(goDark);
  assert.equal(lost.outcome, 'quiet');
  assert.ok(lost.heard.includes('lost'));
});

test('slipped by out-running it: a raider closing on us is left behind at full burn, and catches a ship that sits still', () => {
  const chase = (act) => {
    const sim = quietSim('outrun');
    seconds(sim, 1);
    spawn(sim, 'raider-skiff', { range: 45, bearing: 0, state: 'closing' });
    act(sim);
    return play(sim);
  };
  assert.equal(chase(() => {}).outcome, 'docked');
  const run = chase((sim) => {
    fullEngines(sim);
    go(sim, { type: 'helm.heading', heading: 180 });
    go(sim, { type: 'helm.burn', on: true });
  });
  assert.equal(run.outcome, 'outrun');
  // The cutter is faster than we are: the same run does not shake it.
  const sim = quietSim('outrun-cutter');
  seconds(sim, 1);
  spawn(sim, 'patrol-cutter', { range: 45, bearing: 0, state: 'closing' });
  fullEngines(sim);
  go(sim, { type: 'helm.heading', heading: 180 });
  go(sim, { type: 'helm.burn', on: true });
  assert.equal(play(sim).outcome, 'docked');
});

test('slipped with a decoy: a raider stops for a crate put out of the airlock, and a flare draws a cutter off a ship that then goes dark', () => {
  // The crate: what a ship after cargo came for.
  const raid = (act) => {
    const sim = quietSim('decoy-crate');
    seconds(sim, 1);
    spawn(sim, 'raider-skiff', { range: 70, bearing: 0, state: 'closing' });
    act(sim);
    return { ...play(sim), sim };
  };
  assert.equal(raid(() => {}).outcome, 'docked');
  const paid = raid((sim) => {
    const crate = Object.values(sim.state.crates).find((item) => item.kind === 'cargo');
    go(sim, { type: 'crate.jettison', crew: 'okoro', crate: crate.id });
  });
  assert.equal(paid.outcome, 'decoy');
  assert.ok(paid.heard.includes('fooled') && paid.heard.includes('took'), paid.heard.join(' '));
  assert.equal(Object.values(paid.sim.state.crates).filter((item) => item.kind === 'cargo').length, 7, 'and the crate is gone');

  // The flare: something bright to chase while we burn off and go cold. The same run without it is caught.
  const evade = (flare) => {
    const sim = quietSim('decoy-flare');
    seconds(sim, 1);
    spawn(sim, 'patrol-cutter', { range: 60, bearing: 0, state: 'closing' });
    go(sim, { type: 'lights.all', on: false });
    fullEngines(sim);
    go(sim, { type: 'helm.heading', heading: 200 });
    go(sim, { type: 'helm.burn', on: true });
    return play(sim, 900, (s, t) => {
      if (flare && t === 5) s.enqueue({ type: 'decoy.flare' });
      if (t === 35) {
        s.enqueue({ type: 'helm.burn', on: false });
        s.enqueue({ type: 'power.add', system: 'engines', delta: -1 });
      }
      if (t === 36) s.enqueue({ type: 'power.add', system: 'engines', delta: -1 });
    });
  };
  assert.equal(evade(false).outcome, 'docked');
  const fooled = evade(true);
  assert.equal(fooled.outcome, 'decoy');
  assert.ok(fooled.heard.includes('fooled') && fooled.heard.includes('wise'), fooled.heard.join(' '));

  // Flares run out.
  const sim = quietSim('flares');
  for (let i = 0; i < HELM.flares; i++) go(sim, { type: 'decoy.flare' });
  assert.match(sim.whyNot({ type: 'decoy.flare' }), /no flares left/);
  assert.equal(scopeView(sim).decoys.length, HELM.flares);
});

test('slipped by a bluff: a lie that works turns it away, one that does not brings it straight in, and it needs someone who can talk', () => {
  const base = ENCOUNTERS.find((item) => item.id === 'patrol-cutter');
  const withBluff = (chance) => [{ ...base, bluffs: { manifest: chance } }];
  const hail = (chance, seed = 'bluff') => {
    const sim = quietSim(seed, { encounters: withBluff(chance) });
    seconds(sim, 1);
    spawn(sim, 'patrol-cutter', { range: 70, bearing: 0, state: 'shadowing' });
    seconds(sim, 4);
    sim.enqueue({ type: 'contact.hail', contact: 1, bluff: 'manifest' });
    return { sim, ...play(sim) };
  };
  const good = hail(1);
  assert.equal(good.outcome, 'bluff');
  assert.equal(first(good.sim)?.state ?? 'lost', 'lost');

  const bad = hail(0);
  assert.equal(bad.outcome, 'docked', 'it knows where the transmission came from');
  assert.ok(!bad.heard.includes('lost'));

  // Caught in a lie, it stops listening; and it never hears the same lie twice.
  const sim = quietSim('bluff-2', { encounters: [{ ...base, bluffs: { manifest: 0, transponder: 1 } }] });
  seconds(sim, 1);
  spawn(sim, 'patrol-cutter', { range: 70, bearing: 0, state: 'shadowing' });
  seconds(sim, 4);
  assert.equal(bluffChance(sim, first(sim), 'manifest'), 0);
  assert.ok(bluffChance(sim, first(sim), 'transponder') === 1);
  go(sim, { type: 'contact.hail', contact: 1, bluff: 'manifest' });
  assert.equal(first(sim).state, 'closing');
  assert.match(sim.whyNot({ type: 'contact.hail', contact: 1, bluff: 'manifest' }), /heard that one/);
  assert.match(sim.whyNot({ type: 'contact.hail', contact: 1, bluff: 'transponder' }), /stopped listening/);

  // Nobody aboard with any negotiation: no hail.
  const mute = createSim({ seed: 'mute', ship: SHIP, crew: CREW.map((member) => ({ ...member, skills: {} })), ...CATALOG, ships: [], encounters: ENCOUNTERS });
  seconds(mute, 1);
  spawn(mute, 'patrol-cutter', { range: 60, bearing: 0, state: 'shadowing' });
  seconds(mute, 4);
  assert.match(mute.whyNot({ type: 'contact.hail', contact: 1, bluff: 'manifest' }), /nobody aboard can talk/);
  // A better negotiator is better at it.
  const smooth = createSim({ seed: 'smooth', ship: SHIP, crew: CREW.map((member) => ({ ...member, skills: { negotiation: 4 } })), ...CATALOG, ships: [], encounters: ENCOUNTERS });
  spawn(smooth, 'patrol-cutter', { range: 60, bearing: 0 });
  const plain = quietSim('plain');
  spawn(plain, 'patrol-cutter', { range: 60, bearing: 0 });
  assert.ok(bluffChance(smooth, first(smooth), 'manifest') > bluffChance(plain, first(plain), 'manifest'));
});

// ---------- every encounter ends, and replays ----------

test('every kind of contact, left alone or run from, ends in a named way within a quarter of an hour', () => {
  for (const def of ENCOUNTERS) {
    for (const tactic of ['nothing', 'dark', 'burn']) {
      const sim = quietSim(`ends:${def.id}:${tactic}`);
      seconds(sim, 1);
      spawn(sim, def.id, { range: 80, bearing: 120, miss: 15 });
      if (tactic === 'dark') goDark(sim);
      if (tactic === 'burn') {
        go(sim, { type: 'helm.heading', heading: 300 });
        go(sim, { type: 'helm.burn', on: true });
      }
      const { outcome } = play(sim, 15 * 60);
      assert.ok(ENDINGS[outcome], `${def.id}, ${tactic}: ended "${outcome}"`);
    }
  }
});

test('an encounter replays from its seed and survives a snapshot', () => {
  const script = (sim) => {
    seconds(sim, 1);
    spawn(sim, 'bounty-tender', { range: 70, bearing: 200, miss: 10 });
    go(sim, { type: 'helm.heading', heading: 20 });
    go(sim, { type: 'helm.burn', on: true });
    seconds(sim, 20);
    go(sim, { type: 'decoy.flare' });
    seconds(sim, 10);
  };
  const a = quietSim('replay');
  const b = quietSim('replay');
  script(a);
  script(b);
  assert.deepEqual(a.snapshot(), b.snapshot());
  const snap = a.snapshot();
  seconds(a, 30);
  const later = a.snapshot();
  a.restore(snap);
  seconds(a, 30);
  assert.deepEqual(a.snapshot(), later);
});
