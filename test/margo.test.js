// Margo runs what nobody mans (H.5, D-154, D-187 to D-192): how much attention
// she has, how she runs what she holds and why, what the captain can hand her
// or keep from her, and how far she follows his standing orders.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ALERT, OWN_WAY, alertNow, herWay } from '../src/ai/margo.js';
import { TRUST } from '../src/ai/judgement.js';
import { spotIn } from '../src/sim/crew.js';
import { sensorGain, signature } from '../src/sim/senses.js';
import { TICK_RATE, checkInvariants, createSim } from '../src/sim/sim.js';
import { MANNERS, MARGO, POSTS, holderOf, margoAttention, margoLoad, operatorOf, rating, reactorLoad } from '../src/sim/stations.js';
import { CATALOG, CREW, LINES, SHIP, content } from './helpers.js';

const ENCOUNTERS = content.all('encounters');
/** A sim whose Margo has a mind of her own. `crew` false: nobody aboard. */
const ownSim = (seed, { crew = true, lines = false, margo = 'own' } = {}) => createSim({ seed, ship: SHIP, crew: crew ? CREW : [], ...CATALOG, encounters: ENCOUNTERS, lines: lines ? LINES : [], margo });

function seconds(sim, n) {
  for (let i = 0; i < Math.round(n * TICK_RATE); i++) {
    sim.step();
    const problems = checkInvariants(sim);
    assert.deepEqual(problems, [], `tick ${sim.state.tick}`);
  }
}
const go = (sim, ...commands) => {
  for (const command of commands) sim.enqueue(command);
  sim.step();
};
function place(sim, id, room) {
  const member = sim.state.crew[id];
  const at = spotIn(sim.layout.room(room), member.index);
  Object.assign(member, { room, x: at.x, y: at.y, px: at.x, py: at.y, path: [], goal: null, task: 'idle' });
  return member;
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
/** Every hand off their post. */
function unpostAll(sim) {
  for (const member of Object.values(sim.state.crew)) member.post = null;
}

test('a bare sim keeps H.4 Margo: by the book everywhere, and a standing order takes at once', () => {
  const sim = ownSim('book', { crew: false, margo: 'book' });
  sim.step();
  assert.equal(margoAttention(sim), Infinity);
  for (const id of ['helm', 'sensors', 'life_support', 'doors', 'engines']) assert.equal(rating(sim, id), 1, id);
  go(sim, { type: 'station.order', station: 'sensors', manner: 'quiet' });
  assert.equal(sim.state.stations.sensors.runs, 'quiet');
  assert.ok(near(rating(sim, 'sensors'), MANNERS.quiet.rating));
  assert.throws(() => createSim({ seed: 'x', ship: SHIP, ...CATALOG, margo: 'wise' }), /margo must be/);
});

test('her attention goes to what needs her: an idle station gets what is left, and too many jobs leave the last at the floor', () => {
  const sim = ownSim('attention', { crew: false });
  seconds(sim, 1);
  // Nobody aboard: she holds the helm, the air, the sensors, the doors and the engines (the rest start stood down).
  const load = margoLoad(sim);
  assert.equal(load.attention, MARGO.attention);
  assert.equal(load.held, 5);
  // The drive is cut, so the engines need nothing: four jobs, four stations' worth of her, and the engines idle at the floor.
  assert.equal(load.jobs, 4);
  for (const id of ['life_support', 'helm', 'sensors', 'doors']) assert.equal(rating(sim, id), 1, id);
  assert.ok(near(rating(sim, 'engines'), MARGO.floor));
  // Light the drive: five jobs, and the doors, last of them in her priorities, drop to the floor.
  go(sim, { type: 'helm.burn', on: true });
  seconds(sim, 1);
  assert.equal(margoLoad(sim).jobs, 5);
  assert.equal(rating(sim, 'engines'), 1);
  assert.ok(near(rating(sim, 'doors'), MARGO.floor));
  // A station handed to her comes before its equals: the doors, handed over, put the engines at the floor instead.
  go(sim, { type: 'station.cover', station: 'doors', cover: 'hers' });
  seconds(sim, 1);
  assert.equal(rating(sim, 'doors'), 1);
  assert.ok(near(rating(sim, 'engines'), MARGO.floor));
});

test('a damaged core has less attention to give', () => {
  const sim = ownSim('damage', { crew: false });
  go(sim, { type: 'helm.burn', on: true });
  seconds(sim, 1);
  const whole = ['life_support', 'helm', 'sensors', 'engines', 'doors'].reduce((sum, id) => sum + rating(sim, id), 0);
  // The starting ship's core is a single bar, whole or dead: a fire in its room is what knocks her about.
  sim.state.rooms.ai_core.fire = 0.6;
  sim.step();
  assert.ok(margoAttention(sim) < MARGO.attention);
  const hurt = ['life_support', 'helm', 'sensors', 'engines', 'doors'].reduce((sum, id) => sum + rating(sim, id), 0);
  assert.ok(hurt < whole, `${hurt} < ${whole}`);
  // The air still comes first.
  assert.equal(rating(sim, 'life_support'), 1);
});

test('hand a station to her, leave her to fill in, or keep it for the crew', () => {
  const sim = ownSim('cover');
  sim.step();
  assert.equal(operatorOf(sim, 'helm')?.id, 'ilse');
  // Handed to her: Ilse loses the post (and stays where she is), and Margo has the helm.
  go(sim, { type: 'station.cover', station: 'helm', cover: 'hers' });
  assert.equal(sim.state.crew.ilse.post, null);
  assert.equal(sim.state.crew.ilse.room, 'bridge');
  sim.step();
  assert.equal(holderOf(sim, 'helm'), 'margo');
  // Posting someone there takes it back from her.
  go(sim, { type: 'crew.post', crew: 'ilse', station: 'helm' });
  assert.equal(sim.state.stations.helm.cover, 'fill');
  sim.step();
  assert.equal(holderOf(sim, 'helm'), 'ilse');
  // Kept for the crew: with nobody on it, the sensors are dark, cool and quiet.
  const before = reactorLoad(sim);
  go(sim, { type: 'station.cover', station: 'sensors', cover: 'crew' });
  sim.step();
  assert.equal(holderOf(sim, 'sensors'), null);
  assert.equal(rating(sim, 'sensors'), 0);
  assert.ok(reactorLoad(sim) < before);
  // Someone on it, it runs again.
  sim.state.crew.vesna.post = 'sensors';
  place(sim, 'vesna', 'sensors');
  sim.step();
  assert.equal(holderOf(sim, 'sensors'), 'vesna');
  // She will not leave her own supply, and the AI core is hers already.
  assert.match(sim.whyNot({ type: 'station.cover', station: 'reactor', cover: 'crew' }), /her own supply/);
  assert.match(sim.whyNot({ type: 'station.cover', station: 'ai_core', cover: 'hers' }), /Margo already/);
  assert.match(sim.whyNot({ type: 'station.cover', station: 'helm', cover: 'mine' }), /cover must be/);
});

test('quiet runs cooler and does less; pushed runs hotter and does more', () => {
  const sim = ownSim('manner', { crew: false, margo: 'book' });
  seconds(sim, 2);
  const book = { load: reactorLoad(sim), gain: sensorGain(sim), heat: signature(sim).heat };
  go(sim, { type: 'station.order', station: 'sensors', manner: 'quiet' }, { type: 'station.order', station: 'life_support', manner: 'quiet' });
  seconds(sim, 2);
  assert.ok(reactorLoad(sim) < book.load);
  assert.ok(signature(sim).heat < book.heat);
  assert.ok(sensorGain(sim) < book.gain);
  go(sim, { type: 'station.order', station: 'sensors', manner: 'push' }, { type: 'station.order', station: 'life_support', manner: 'push' });
  seconds(sim, 2);
  assert.ok(reactorLoad(sim) > book.load);
  assert.ok(sensorGain(sim) > book.gain);
  // A hand on the station runs it their way: her standing order is for when she has it.
  assert.match(sim.whyNot({ type: 'station.order', station: 'reactor', manner: 'quiet' }), /one way only/);
});

test('her own way: quiet when something is looking for us, the drive pushed once it has found us, the hurt and the air first', () => {
  const sim = ownSim('way', { crew: false });
  go(sim, { type: 'station.stand', station: 'medbay', down: false }, { type: 'station.stand', station: 'weapons', down: false });
  seconds(sim, 1);
  assert.equal(sim.state.ai.alert, 'calm');
  assert.equal(sim.state.stations.engines.runs, 'book');
  // Calm, the guns are kept cool all the same.
  assert.equal(sim.state.stations.weapons.runs, 'quiet');
  const said = [];
  for (const type of ['margo.hush', 'margo.push', 'margo.easy']) sim.events.on(type, () => said.push(type));
  // A cutter looking for something, near and loud enough to read.
  go(sim, { type: 'debug.contact', encounter: 'patrol-cutter', range: 75, bearing: 30, state: 'shadowing' });
  seconds(sim, 6);
  assert.equal(alertNow(sim), 'hunted');
  assert.equal(sim.state.ai.alert, 'hunted');
  for (const id of ['sensors', 'engines', 'doors']) assert.equal(sim.state.stations[id].runs, 'quiet', id);
  assert.equal(sim.state.stations.helm.runs, 'book', 'she still steers by the book');
  assert.ok(said.includes('margo.hush'));
  // It closes: no point hiding now. She pushes the drive and readies the guns.
  sim.state.scope.contacts[0].state = 'closing';
  seconds(sim, 1);
  assert.equal(sim.state.ai.alert, 'found');
  assert.equal(sim.state.stations.engines.runs, 'push');
  assert.equal(sim.state.stations.weapons.runs, 'book');
  assert.ok(said.includes('margo.push'));
  // It goes: she stands down from the alert only after it has held for a while.
  go(sim, { type: 'debug.contact', clear: true });
  seconds(sim, ALERT.hold / 2);
  assert.equal(sim.state.ai.alert, 'found');
  seconds(sim, ALERT.hold);
  assert.equal(sim.state.ai.alert, 'calm');
  assert.equal(sim.state.stations.engines.runs, 'book');
  // Thin air and the hurt come first whatever else is going on.
  sim.state.rooms.quarters.oxygen = 0.5;
  assert.deepEqual(herWay(sim, 'life_support', 'hunted'), { manner: 'push', why: 'air' });
});

test('she reads the scope, not the sky: an unreadable return near us scares her, a ship she cannot see does not', () => {
  const sim = ownSim('wrong', { crew: false });
  seconds(sim, 1);
  // A quiet drone on its own course, near: the scope shows a return it cannot read, and she takes it for a hunter.
  go(sim, { type: 'debug.contact', encounter: 'gunnery-drone', range: 30, bearing: 90, state: 'unseen' });
  let scared = false;
  for (let i = 0; i < 20 * TICK_RATE && !scared; i++) {
    sim.step();
    const contact = sim.state.scope.contacts[0];
    if (contact?.track.shown && contact.track.q < 0.35 && contact.state === 'unseen') scared = alertNow(sim) === 'hunted';
  }
  assert.ok(scared, 'an unread return near us is something hunting us, as far as she can tell');
  // With the sensors stood down nothing shows on the scope, and a ship that really is shadowing us is nothing to her.
  go(sim, { type: 'debug.contact', clear: true }, { type: 'station.stand', station: 'sensors', down: true });
  go(sim, { type: 'debug.contact', encounter: 'bounty-tender', range: 100, bearing: 200, state: 'shadowing' });
  seconds(sim, 3);
  assert.equal(alertNow(sim), 'calm');
});

test('her trust decides whether she follows a standing order she disagrees with', () => {
  const sim = ownSim('trust', { crew: false });
  sim.step();
  const events = [];
  for (const type of ['margo.doubt', 'margo.own_way']) sim.events.on(type, (event) => events.push({ type, ...event }));
  go(sim, { type: 'debug.contact', encounter: 'patrol-cutter', range: 75, bearing: 30, state: 'shadowing' });
  seconds(sim, 6);
  assert.equal(sim.state.ai.alert, 'hunted');
  // Trust in the middle: told to push the engines while hunted, she does, and says she would not.
  sim.state.ai.trust = 50;
  go(sim, { type: 'station.order', station: 'engines', manner: 'push' });
  sim.step();
  assert.equal(sim.state.stations.engines.runs, 'push');
  assert.equal(sim.state.stations.engines.against, 'doubt');
  assert.equal(events.at(-1).type, 'margo.doubt');
  assert.equal(events.at(-1).speak, true);
  // Trust low: she runs it her own way while she disagrees.
  sim.state.ai.trust = OWN_WAY - 1;
  sim.step();
  assert.equal(sim.state.stations.engines.runs, 'quiet');
  assert.equal(sim.state.stations.engines.against, 'own');
  assert.equal(events.at(-1).type, 'margo.own_way');
  // The reason passes: the order comes back.
  go(sim, { type: 'debug.contact', clear: true });
  seconds(sim, ALERT.hold + 1);
  assert.equal(sim.state.stations.engines.runs, 'push');
  assert.equal(sim.state.stations.engines.against, null);
  // Trusting the captain, she goes along without a word.
  sim.state.ai.trust = TRUST.goesAlong;
  go(sim, { type: 'debug.contact', encounter: 'patrol-cutter', range: 75, bearing: 30, state: 'shadowing' });
  seconds(sim, 6);
  assert.equal(sim.state.stations.engines.runs, 'push');
  assert.equal(events.at(-1).speak, false);
  // A hand on the station takes it out of her say altogether.
  go(sim, { type: 'station.order', station: 'engines', manner: null });
  sim.step();
  assert.equal(sim.state.stations.engines.runs, 'quiet');
});

test('handing her everything frees every hand, and costs the ship how well it is run when it is busy', () => {
  const crewed = ownSim('all-crew');
  const handed = ownSim('all-margo');
  for (const sim of [crewed, handed]) {
    // Everyone at a post on the stations that matter here: the pilot at the helm, the engineer on the engines.
    sim.state.crew.dace.post = 'engines';
    place(sim, 'dace', 'engines');
    go(sim, { type: 'helm.burn', on: true }, { type: 'station.stand', station: 'shields', down: false }, { type: 'station.stand', station: 'medbay', down: false }, { type: 'station.stand', station: 'weapons', down: false });
  }
  for (const id of POSTS) go(handed, { type: 'station.cover', station: id, cover: 'hers' });
  seconds(crewed, 2);
  seconds(handed, 2);
  // Nobody holds a post: every hand is free for the fires and the patches.
  assert.ok(Object.values(handed.state.crew).every((member) => member.post === null));
  for (const id of POSTS) assert.equal(holderOf(handed, id), 'margo', id);
  // She is good at the book figure and no better: the pilot and the engineer beat her at their own stations.
  assert.ok(rating(crewed, 'helm') > rating(handed, 'helm'));
  assert.ok(rating(crewed, 'engines') > rating(handed, 'engines'));
  // In a bad minute she has more to watch than she can, and the lowest of her priorities get the minimum.
  handed.state.rooms.cargo.breach = 0.3;
  handed.state.shield.charge = 0;
  handed.state.crew.okoro.health = 0.5;
  place(handed, 'okoro', 'medbay');
  seconds(handed, 1);
  assert.ok(margoLoad(handed).jobs > margoLoad(handed).attention);
  assert.equal(handed.state.ai.stretched, true);
  assert.equal(rating(handed, 'medbay'), MANNERS.push.rating, 'the hurt come first, and pushed');
  assert.ok(near(rating(handed, 'shields'), MANNERS.quiet.rating * MARGO.floor), 'the shields get what is left, and kept cool');
});

test('she says what she is doing, in her own lines', () => {
  const sim = ownSim('talk', { crew: true, lines: true });
  const heard = [];
  sim.events.on('ai.line', (event) => heard.push(event.trigger));
  seconds(sim, 3);
  go(sim, { type: 'station.cover', station: 'sensors', cover: 'hers' });
  seconds(sim, 6);
  assert.ok(heard.includes('station.handed'), heard.join());
  go(sim, { type: 'debug.contact', encounter: 'patrol-cutter', range: 75, bearing: 30, state: 'shadowing' });
  seconds(sim, 15);
  assert.ok(heard.includes('margo.hush'), heard.join());
});

test('the station table settles once a tick, matches a fresh reading, and survives a snapshot', () => {
  const sim = ownSim('table');
  for (const id of POSTS) if (id !== 'helm') go(sim, { type: 'station.cover', station: id, cover: 'hers' });
  go(sim, { type: 'helm.burn', on: true });
  seconds(sim, 5);
  const settled = POSTS.map((id) => [id, holderOf(sim, id), rating(sim, id)]);
  const snap = sim.snapshot();
  const copy = ownSim('table');
  copy.restore(snap);
  assert.deepEqual(POSTS.map((id) => [id, holderOf(copy, id), rating(copy, id)]), settled);
  assert.equal(copy.state.ai.mind, 'own');
  assert.equal(copy.state.stations.sensors.cover, 'hers');
});

test('under way on a crossing the drive needs her, so it gets her attention before the doors (H.8)', async () => {
  const { needOf } = await import('../src/sim/stations.js');
  const { castOff } = await import('./helpers.js');
  const { bestRoute } = await import('../src/sim/sector.js');
  const sim = createSim({ seed: 'drive', ship: SHIP, crew: CREW, ...CATALOG, margo: 'own', sector: content.require('sectors', 'the-reach'), run: { pursuit: false } });
  assert.equal(needOf(sim, 'engines'), 0, 'in port the drive is idle');
  const { run } = sim.state;
  const port = run.map.nodes.find((node) => node.kind === 'port' && node.id !== run.at && bestRoute(run.map, run.at, node.id, { ports: false }).path);
  castOff(sim, bestRoute(run.map, run.at, port.id, { ports: false }).path);
  assert.equal(needOf(sim, 'engines'), 1, 'under way it is in use');
});
