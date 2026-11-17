#!/usr/bin/env node
// Browser tests for the ship view, the clock, pause, the AI's voice, sound, the gun and the input layer, on an emulated iPad
// (touch) and on a desktop (mouse and keyboard). Run with: npm run test:e2e
//
// Builds nothing itself: run `npm run build` first. Serves dist/ with
// `vite preview` and drives it with Playwright.

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { setTimeout as sleep } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright');

const PORT = 4179;
const URL = `http://localhost:${PORT}/?seed=E2E-TEST&watches=0&autopause=0`;

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ok    ${name}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`  FAIL  ${name}\n        ${String(err.message).split('\n').join('\n        ')}`);
  }
}

async function startServer() {
  const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try {
      const response = await fetch(URL);
      if (response.ok) return server;
    } catch {
      // not up yet
    }
    await sleep(250);
  }
  server.kill();
  throw new Error('vite preview did not start');
}

// ---------- helpers that run against the page ----------

/** Choices that cannot bring a ship down on us or kill anyone, in the order to prefer them, for flying through events (S3.3). */
const SAFE_CHOICES = ['leave', 'pass', 'note', 'thread', 'sweep', 'manifest', 'rest', 'keep', 'press-on', 'brig', 'reseal', 'tape', 'part'];
/** Answer whatever event is on the screen with a safe choice, read the outcome, and go on (a follow-up event is answered too). */
async function answerEvents(page) {
  for (let i = 0; i < 4 && (await page.evaluate(() => window.coldManifest.machine.state)) === 'event'; i++) {
    if (!(await page.isVisible('#btn-event-continue'))) {
      const open = await page.$$eval('#event-choices .btn:not([disabled])', (list) => list.map((b) => b.id.replace('choice-', '')));
      await page.tap(`#choice-${SAFE_CHOICES.find((id) => open.includes(id)) ?? open[0]}`);
    }
    await page.tap('#btn-event-continue');
  }
}

const game = (page, fn, arg) => page.evaluate(fn, arg);
/** The situations aboard still waiting for an answer (H.7): [{ n, id, room, node, hold, by }]. */
const situationsWaiting = (page) => game(page, () => (window.coldManifest.sim.state.run?.events.aboard ?? []).filter((one) => !one.result).map(({ n, id, room, node, hold, by }) => ({ n, id, room, node, hold, by })));
/**
 * Deal with every situation aboard through the sim, not its card (for suites that are about something else):
 * the last hand is stood in its room, a safe choice is taken, the card is put away and the hand put back.
 */
const settleSituations = (page) =>
  game(page, (safe) => {
    const { sim } = window.coldManifest;
    for (const one of sim.state.run?.events.aboard.filter((item) => !item.result) ?? []) {
      const about = Object.values(one.cast);
      const spare = Object.values(sim.state.crew).filter((member) => member.owner === 'player' && member.alive && !about.includes(member.id)).sort((a, b) => b.index - a.index)[0];
      const was = { room: spare.room, x: spare.x, y: spare.y, px: spare.px, py: spare.py, path: spare.path, goal: spare.goal, task: spare.task, asleep: spare.asleep };
      const room = sim.layout.room(one.room);
      Object.assign(spare, { room: one.room, x: room.x + room.w / 2, y: room.y + room.h - 0.5, px: room.x + room.w / 2, py: room.y + room.h - 0.5, path: [], goal: null, task: 'idle', asleep: false });
      sim.step();
      const choices = sim.transit.byId.get(one.id).choices.map((choice) => choice.id);
      const pick = [...safe.filter((id) => choices.includes(id)), ...choices].find((id) => !sim.whyNot({ type: 'event.choose', situation: one.n, choice: id }));
      sim.enqueue({ type: 'event.choose', situation: one.n, choice: pick });
      sim.step();
      sim.enqueue({ type: 'event.dismiss', situation: one.n });
      sim.step();
      Object.assign(spare, was);
    }
  }, SAFE_CHOICES);
const tick = (page) => game(page, () => window.coldManifest.sim.state.tick);
const door = (page, id) => game(page, (did) => ({ ...window.coldManifest.sim.state.doors[did] }), id);
const room = (page, id) => game(page, (rid) => ({ ...window.coldManifest.sim.state.rooms[rid] }), id);
const counts = (page) => game(page, () => ({ ...window.coldManifest.shipView.debug.counts }));
const selected = (page) => game(page, () => window.coldManifest.shipView.debug.selected);
const queued = (page) => game(page, () => window.coldManifest.sim.state.commands.length);
/** Is a station stood down? */
const down = (page, id) => game(page, (sid) => window.coldManifest.sim.state.stations[sid].down, id);
const downIs = (page, id, value) => page.waitForFunction(([sid, v]) => window.coldManifest.sim.state.stations[sid].down === v, [id, value], { timeout: 2000 });
const selectedCrew = (page) => game(page, () => window.coldManifest.shipView.debug.selectedCrew);
const crewTarget = async (page, id) => {
  const t = await game(page, (cid) => window.coldManifest.shipView.debug.targets().find((x) => x.kind === 'crew' && x.id === cid), id);
  assert.ok(t, `no crew target ${id}`);
  return t;
};
const paused = (page) => game(page, () => window.coldManifest.clock.paused);
/** The debug "Perfect lock": every room of theirs made out, and no shot goes wide for want of a lock. */
const infoText = (page) => game(page, () => window.coldManifest.shipView.debug.infoText);
const doorIs = (page, id, state, openness) =>
  page.waitForFunction(([did, st, op]) => {
    const d = window.coldManifest.sim.state.doors[did];
    return d.state === st && d.openness === op;
  }, [id, state, openness], { timeout: 3000 });

/**
 * A hit target's box and a point to tap it at, in page pixels. For a room that is its middle, or the nearest
 * point along its middle that no crew member's body covers (people stand in rooms, D-132).
 */
async function target(page, id) {
  const all = await game(page, () => window.coldManifest.shipView.debug.targets());
  const t = all.find((x) => x.id === id);
  assert.ok(t, `no target ${id}`);
  const mx = t.x + t.w / 2;
  const my = t.y + t.h / 2;
  if (t.kind !== 'room') return { ...t, mx, my };
  const covered = (x, y) => all.some((o) => o.priority > t.priority && x >= o.x - 16 && x <= o.x + o.w + 16 && y >= o.y - 16 && y <= o.y + o.h + 16);
  for (let d = 0; d <= t.w / 2; d += 4) for (const x of [mx - d, mx + d]) if (!covered(x, my)) return { ...t, mx: x, my };
  return { ...t, mx, my };
}

/** Raw touch through the browser, so holds and drags are real pointer streams. */
async function touch(page, points, { holdMs = 0 } = {}) {
  const cdp = await page.context().newCDPSession(page);
  const [first, ...rest] = points;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: first.x, y: first.y }] });
  if (holdMs) await sleep(holdMs);
  for (const p of rest) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: p.x, y: p.y }] });
    await sleep(16);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

async function openShip(page, press, extra = '') {
  await page.goto(URL + extra);
  await page.waitForFunction(() => window.coldManifest?.machine.state === 'title');
  await press('#btn-ship');
  await page.waitForFunction(() => window.coldManifest.machine.state === 'ship');
  await sleep(150);
}

// ---------- the tests ----------

async function touchTests(browser) {
  console.log('iPad, landscape, touch');
  const context = await browser.newContext({ ...devices['iPad (gen 7) landscape'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openShip(page, (sel) => page.tap(sel));

  await check('the clock runs on a live screen', async () => {
    const a = await tick(page);
    await sleep(400);
    const b = await tick(page);
    assert.ok(b - a >= 5 && b - a <= 11, `expected about 8 ticks in 0.4s, got ${b - a}`);
  });

  await check('the whole ship fits on screen between the bars', async () => {
    const all = await game(page, () => window.coldManifest.shipView.debug.targets());
    const top = (await page.locator('.shipbar').boundingBox()).y;
    const dock = (await page.locator('.shipdock').boundingBox()).y;
    for (const t of all.filter((x) => x.kind !== 'crew')) {
      assert.ok(t.x >= 0 && t.x + t.w <= 1080, `${t.id} is off the side`);
      assert.ok(t.y >= top && t.y + t.h <= dock, `${t.id} runs under a bar`);
    }
    assert.equal(all.filter((t) => t.kind === 'room').length, 17);
  });

  await check('tap a room to see its status', async () => {
    const t = await target(page, 'medbay');
    await page.touchscreen.tap(t.mx, t.my);
    assert.deepEqual(await selected(page), { kind: 'room', id: 'medbay' });
    assert.equal(await page.textContent('#status-title'), 'Medbay');
    assert.match(await page.textContent('#status'), /Oxygen\s*100%/);
  });

  await check('the lights button darkens only that room', async () => {
    await page.tap('#btn-lights');
    await page.waitForFunction(() => window.coldManifest.sim.state.rooms.medbay.light === 0, null, { timeout: 2000 });
    assert.equal((await room(page, 'quarters')).light, 1);
    assert.equal(await page.textContent('#btn-lights'), 'Lights on');
    await page.tap('#btn-lights');
    await page.waitForFunction(() => window.coldManifest.sim.state.rooms.medbay.light === 1, null, { timeout: 2000 });
  });

  await check('tap a door to open it, tap again to close it', async () => {
    const t = await target(page, 'd_medbay');
    await page.touchscreen.tap(t.mx, t.my);
    assert.deepEqual(await selected(page), { kind: 'door', id: 'd_medbay' });
    await doorIs(page, 'd_medbay', 'open', 1);
    await page.touchscreen.tap(t.mx, t.my);
    await doorIs(page, 'd_medbay', 'closed', 0);
  });

  await check('a touch just outside a door still hits the door, not the room', async () => {
    const t = await target(page, 'd_brig');
    await page.touchscreen.tap(t.mx, t.y + t.h + 9); // 9px below its edge, inside the brig
    assert.deepEqual(await selected(page), { kind: 'door', id: 'd_brig' });
    await doorIs(page, 'd_brig', 'open', 1);
  });

  await check('tapping an airlock selects it but does not open it', async () => {
    const t = await target(page, 'airlock_cargo');
    await page.touchscreen.tap(t.mx, t.my);
    assert.deepEqual(await selected(page), { kind: 'door', id: 'airlock_cargo' });
    await sleep(300);
    assert.deepEqual(await door(page, 'airlock_cargo'), { state: 'closed', openness: 0 });
    assert.match(await page.textContent('#status'), /opens to space/i);
  });

  await check('lock from the panel; a locked door ignores taps', async () => {
    const t = await target(page, 'd_brig');
    await page.touchscreen.tap(t.mx, t.my); // closes it
    await doorIs(page, 'd_brig', 'closed', 0);
    await page.tap('#btn-door-lock');
    await doorIs(page, 'd_brig', 'locked', 0);
    assert.equal(await page.isDisabled('#btn-door-lock'), true);
    await page.touchscreen.tap(t.mx, t.my);
    await sleep(300);
    assert.deepEqual(await door(page, 'd_brig'), { state: 'locked', openness: 0 });
    await page.tap('#btn-door-open');
    await doorIs(page, 'd_brig', 'open', 1);
  });

  await check('paused: nothing moves, orders queue, and they start on resume', async () => {
    await page.tap('#btn-pause');
    assert.equal(await paused(page), true);
    const snapshot = () => game(page, () => JSON.stringify(window.coldManifest.sim.snapshot().state));
    const t0 = await tick(page);
    const s0 = await snapshot();
    await sleep(400);
    assert.equal(await tick(page), t0, 'tick advanced while paused');
    assert.equal(await snapshot(), s0, 'sim state changed while paused');

    const t = await target(page, 'd_reactor');
    await page.touchscreen.tap(t.mx, t.my);
    assert.equal(await queued(page), 1, 'order should be waiting in the queue');
    await sleep(300);
    assert.deepEqual(await door(page, 'd_reactor'), { state: 'closed', openness: 0 }, 'door moved while paused');
    assert.match(await page.textContent('#status'), /Order queued/);
    assert.equal(await tick(page), t0);

    await page.tap('#btn-pause');
    assert.equal(await paused(page), false);
    await doorIs(page, 'd_reactor', 'open', 1);
    assert.equal(await queued(page), 0);
  });

  await check('a tap on a panel never reaches the canvas under it', async () => {
    const before = await counts(page);
    const sel = await selected(page);
    const box = await page.locator('#status').boundingBox();
    await page.touchscreen.tap(box.x + box.width - 30, box.y + 20); // the panel's background, not a control
    await sleep(100);
    assert.equal((await counts(page)).canvasTaps, before.canvasTaps, 'the canvas saw a tap that landed on the panel');
    assert.deepEqual(await selected(page), sel, 'a tap on the panel changed the selection');
  });

  await check('long-press describes a room and is not a tap', async () => {
    const t = await target(page, 'ai_core');
    const before = await counts(page);
    const sel = await selected(page);
    await touch(page, [{ x: t.mx, y: t.my }], { holdMs: 650 });
    await sleep(50);
    const after = await counts(page);
    assert.equal(after.infos, before.infos + 1);
    assert.equal(after.canvasTaps, before.canvasTaps, 'long-press also counted as a tap');
    assert.deepEqual(await selected(page), sel, 'long-press changed the selection');
    assert.match(await infoText(page), /^AI core\. M\.A\.R\.G\.O\./);
  });

  await check('a drag across the ship selects nothing and opens nothing', async () => {
    const from = await target(page, 'shields');
    const to = await target(page, 'weapons');
    const before = await counts(page);
    const sel = await selected(page);
    const hash = await game(page, () => JSON.stringify(window.coldManifest.sim.state.doors));
    const steps = Array.from({ length: 10 }, (_, i) => ({ x: from.mx + ((to.mx - from.mx) * (i + 1)) / 10, y: from.my }));
    await touch(page, [{ x: from.mx, y: from.my }, ...steps]);
    assert.equal((await counts(page)).canvasTaps, before.canvasTaps);
    assert.deepEqual(await selected(page), sel);
    assert.equal(await game(page, () => JSON.stringify(window.coldManifest.sim.state.doors)), hash);
  });

  await check('the switch panel starts folded to a strip of lamps, and Switches opens it (H.4)', async () => {
    assert.equal(await page.isVisible('#breaker-board'), false);
    assert.equal(await page.isVisible('#breakers-folded'), true);
    assert.equal(await page.locator('#power-mini-engines .pip--on').count(), 1);
    assert.equal(await page.locator('#power-mini-weapons .pip--on').count(), 0, 'the guns start stood down');
    await page.tap('#btn-breakers');
    await page.waitForSelector('#breaker-board', { state: 'visible', timeout: 2000 });
    assert.equal(await page.isVisible('#breakers-folded'), false);
    assert.match(await page.textContent('#station-life_support'), /Air plant/, 'each station is named');
    assert.match(await page.textContent('#station-sensors'), /Margo\s*1\.0/, 'and says who has it and how well');
    assert.equal(await page.locator('#breaker-board .pip, #btn-power-shields-plus').count(), 0, 'no bars to route');
    for (const id of await page.$$eval('#breaker-board .btn', (list) => list.filter((b) => b.offsetParent !== null).map((b) => b.id))) {
      const box = await page.locator(`#${id}`).boundingBox();
      assert.ok(box.width >= 44 && box.height >= 44, `${id} is ${box.width} by ${box.height}`);
    }
    if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/h4-switches-ipad.png` });
  });

  await check('stations: a tap stands one to or down, and the reactor load follows', async () => {
    const load = () => game(page, () => Number(document.querySelector('#power-summary').textContent.match(/load (\d+)%/)[1]));
    assert.match(await page.textContent('#power-summary'), /Steady · load \d+%/);
    const before = await load();
    await page.tap('#btn-stand-sensors');
    await downIs(page, 'sensors', true);
    await page.waitForFunction(() => /Stood down/.test(document.querySelector('#station-sensors').textContent));
    assert.ok((await load()) < before, 'a station stood down is load off the reactor');
    await page.tap('#btn-stand-sensors');
    await downIs(page, 'sensors', false);
    await page.tap('#btn-stand-shields');
    await downIs(page, 'shields', false);
    await page.tap('#btn-stand-shields');
    await downIs(page, 'shields', true);
  });

  await check("Margo's row: pick a station, hand it to her or keep it for the crew, and tell her how to run it (H.5)", async () => {
    const station = (id) => game(page, (key) => window.coldManifest.sim.state.stations[key], id);
    assert.equal(await page.isVisible('#switch-margo'), false, 'no row until a station is picked');
    await page.tap('#btn-station-sensors');
    await page.waitForFunction(() => /Sensors/.test(document.querySelector('#margo-station').textContent));
    assert.match(await page.textContent('#margo-note'), /Left to her/);
    await page.tap('#btn-cover-crew');
    await page.waitForFunction(() => window.coldManifest.sim.state.stations.sensors.cover === 'crew', null, { timeout: 2000 });
    await page.waitForFunction(() => /Crew only/.test(document.querySelector('#station-sensors').textContent), null, { timeout: 2000 });
    await page.tap('#btn-cover-fill');
    await page.waitForFunction(() => window.coldManifest.sim.state.stations.sensors.cover === 'fill', null, { timeout: 2000 });
    await page.tap('#btn-manner-quiet');
    await page.waitForFunction(() => window.coldManifest.sim.state.stations.sensors.runs === 'quiet', null, { timeout: 2000 });
    assert.match(await page.textContent('#margo-note'), /Her order: quiet/);
    assert.match(await page.textContent('#station-sensors'), /Margo, quiet/);
    await page.tap('#btn-manner-own');
    await page.waitForFunction(() => window.coldManifest.sim.state.stations.sensors.order === null, null, { timeout: 2000 });
    assert.equal((await station('sensors')).cover, 'fill');
    // The reactor takes no orders on how to run it, and cannot be left dark.
    await page.tap('#btn-station-reactor');
    await page.waitForFunction(() => document.querySelector('#btn-manner-quiet').hidden);
    assert.equal(await page.locator('#btn-cover-crew.is-blocked').count(), 1);
    // Picked again, the row folds away and the panel is its old height.
    await page.tap('#btn-station-reactor');
    await page.waitForFunction(() => document.querySelector('#switch-margo').hidden);
  });

  await check('the big switches: reactor output, lights by deck and the lift', async () => {
    await page.tap('#btn-output-low');
    await page.waitForFunction(() => window.coldManifest.sim.state.power.output === 'low', null, { timeout: 2000 });
    assert.match(await page.textContent('#power-summary'), /^Low/);
    await page.tap('#btn-output-steady');
    await page.waitForFunction(() => window.coldManifest.sim.state.power.output === 'steady', null, { timeout: 2000 });
    await page.tap('#btn-deck-hold');
    await page.waitForFunction(() => !window.coldManifest.sim.state.rooms.hold.lightsOn, null, { timeout: 2000 });
    assert.equal((await room(page, 'reactor')).lightsOn, true, 'only that deck');
    await page.tap('#btn-deck-hold');
    await page.waitForFunction(() => window.coldManifest.sim.state.rooms.hold.lightsOn, null, { timeout: 2000 });
    await page.tap('#btn-lift');
    await page.waitForFunction(() => window.coldManifest.sim.state.power.lift === false, null, { timeout: 2000 });
    await page.tap('#btn-lift');
    await page.waitForFunction(() => window.coldManifest.sim.state.power.lift === true, null, { timeout: 2000 });
  });

  await check('switches thrown while paused wait for resume', async () => {
    await page.tap('#btn-pause');
    await page.tap('#btn-stand-engines');
    await sleep(200);
    assert.equal(await down(page, 'engines'), false);
    assert.equal(await queued(page), 1);
    await page.tap('#btn-pause');
    await downIs(page, 'engines', true);
    await page.tap('#btn-stand-engines');
    await downIs(page, 'engines', false);
  });

  await check('doors: with door control stood down a tap does nothing and the panel says why', async () => {
    await page.tap('#btn-stand-doors');
    await downIs(page, 'doors', true);
    const before = await door(page, 'd_ai_core');
    const t = await target(page, 'd_ai_core');
    await page.touchscreen.tap(t.mx, t.my);
    await sleep(300);
    assert.deepEqual(await door(page, 'd_ai_core'), before);
    assert.match(await page.textContent('#status'), /by hand/);
    await page.tap('#btn-stand-doors');
    await downIs(page, 'doors', false);
    await page.touchscreen.tap(t.mx, t.my);
    await page.waitForFunction(([id, was]) => window.coldManifest.sim.state.doors[id].state !== was, ['d_ai_core', before.state], { timeout: 2000 });
    await page.touchscreen.tap(t.mx, t.my);
    await doorIs(page, 'd_ai_core', before.state, before.openness);
  });

  await check('crew: tap a crew member, then a room, and they walk there', async () => {
    const who = await crewTarget(page, 'okoro');
    await page.touchscreen.tap(who.cx, who.cy);
    assert.equal(await selectedCrew(page), 'okoro');
    assert.equal(await page.textContent('#status-title'), 'Okoro');
    const t = await target(page, 'medbay');
    await page.touchscreen.tap(t.mx, t.my);
    assert.equal(await selectedCrew(page), 'okoro', 'they stay selected for the next order');
    await page.waitForFunction(() => window.coldManifest.sim.state.crew.okoro.room === 'medbay' && window.coldManifest.sim.state.crew.okoro.task === 'idle', null, { timeout: 8000 });
    assert.match(await page.textContent('#status'), /In\s*Medbay/);
    assert.equal((await door(page, 'd_medbay_quarters')).state, 'closed', 'and shut the door behind them');
  });

  await check('intercom: every order gets a reply in the crew member\'s own words (S2.9)', async () => {
    const t = await target(page, 'quarters');
    await page.touchscreen.tap(t.mx, t.my);
    await page.waitForSelector('#intercom', { state: 'visible', timeout: 2000 });
    assert.match(await page.textContent('#intercom'), /Okoro/i);
    assert.ok((await page.textContent('#intercom-text')).length > 3);
    await page.waitForFunction(() => window.coldManifest.sim.state.crew.okoro.room === 'quarters' && !window.coldManifest.sim.state.crew.okoro.path.length, null, { timeout: 8000 });
    await page.waitForSelector('#intercom', { state: 'hidden', timeout: 6000 });
  });

  await check('crew: the crew bar selects too, and the suit button works', async () => {
    await page.tap('#crew-ilse');
    assert.equal(await selectedCrew(page), 'ilse');
    await page.tap('#btn-suit');
    await page.waitForFunction(() => window.coldManifest.sim.state.crew.ilse.suit === true, null, { timeout: 2000 });
    assert.equal(await page.textContent('#btn-suit'), 'Suit off');
    await page.tap('#btn-suit');
    await page.waitForFunction(() => window.coldManifest.sim.state.crew.ilse.suit === false, null, { timeout: 2000 });
    await page.tap('#crew-ilse');
    assert.equal(await selectedCrew(page), null, 'a second tap lets go of them');
  });

  await check('crew: an order given while paused starts on resume', async () => {
    await page.tap('#btn-pause');
    await page.tap('#crew-okoro');
    const t = await target(page, 'quarters');
    await page.touchscreen.tap(t.mx, t.my);
    await sleep(300);
    assert.equal(await queued(page), 1);
    assert.equal(await game(page, () => window.coldManifest.sim.state.crew.okoro.goal), null);
    await page.tap('#btn-pause');
    await page.waitForFunction(() => window.coldManifest.sim.state.crew.okoro.room === 'quarters' && window.coldManifest.sim.state.crew.okoro.task === 'idle', null, { timeout: 8000 });
    await page.tap('#crew-okoro');
  });

  await check('crew: a locked door on the only way refuses the order and says why', async () => {
    await game(page, () => window.coldManifest.sim.enqueue({ type: 'door.set', door: 'd_door_control', state: 'locked' }));
    await doorIs(page, 'd_door_control', 'locked', 0);
    // Okoro: Dace is the engineer, and would simply crawl in through the service way.
    await page.tap('#crew-okoro');
    const t = await target(page, 'door_control');
    await page.touchscreen.tap(t.mx, t.my);
    await sleep(200);
    assert.match(await page.textContent('#status'), /no way through/i);
    assert.equal(await game(page, () => window.coldManifest.sim.state.crew.okoro.goal), null);
    await game(page, () => window.coldManifest.sim.enqueue({ type: 'door.set', door: 'd_door_control', state: 'closed' }));
    await doorIs(page, 'd_door_control', 'closed', 0);
    await page.tap('#crew-okoro');
  });

  await check('venting: opening the airlock from the panel empties the room, closing it lets the air back', async () => {
    const t = await target(page, 'airlock_cargo');
    await page.touchscreen.tap(t.mx, t.my);
    await page.tap('#btn-door-open');
    await page.waitForFunction(() => window.coldManifest.sim.state.rooms.cargo.oxygen < 0.1, null, { timeout: 8000 });
    assert.ok((await room(page, 'aft_corridor')).oxygen > 0.9, 'the corridor behind the shut door keeps its air');
    await page.tap('#btn-door-close');
    await doorIs(page, 'airlock_cargo', 'closed', 0);
    const low = (await room(page, 'cargo')).oxygen;
    await sleep(1500);
    assert.ok((await room(page, 'cargo')).oxygen > low, 'life support is refilling it');
  });

  await check('jettison: the first press arms, the second cuts the room loose for good', async () => {
    // An earlier check left the brig door open; seal the room first.
    const brigDoor = await target(page, 'd_brig');
    await page.touchscreen.tap(brigDoor.mx, brigDoor.my);
    await doorIs(page, 'd_brig', 'closed', 0);
    const t = await target(page, 'brig');
    await page.touchscreen.tap(t.mx, t.my);
    await page.tap('#btn-jettison');
    await sleep(250);
    assert.equal((await room(page, 'brig')).jettisoned, false, 'one press does nothing yet');
    assert.equal(await page.textContent('#btn-jettison'), 'Confirm jettison');
    assert.match(await page.textContent('#status'), /Everything inside will be lost/);
    await page.tap('#btn-jettison');
    await page.waitForFunction(() => window.coldManifest.sim.state.rooms.brig.jettisoned, null, { timeout: 2000 });
    assert.equal(await page.isDisabled('#btn-jettison'), true);
    assert.equal(await page.isDisabled('#btn-lights'), true);
    const d = await target(page, 'd_brig');
    await page.touchscreen.tap(d.mx, d.my);
    await sleep(300);
    assert.deepEqual(await door(page, 'd_brig'), { state: 'locked', openness: 0, sealed: true });
    assert.match(await page.textContent('#status'), /Welded shut/);
  });

  await check('jettison: an unsealed room refuses and says why', async () => {
    const d = await target(page, 'd_door_control');
    await page.touchscreen.tap(d.mx, d.my);
    await doorIs(page, 'd_door_control', 'open', 1);
    const t = await target(page, 'door_control');
    await page.touchscreen.tap(t.mx, t.my);
    await page.tap('#btn-jettison');
    await sleep(200);
    assert.equal(await page.textContent('#btn-jettison'), 'Jettison');
    assert.match(await page.textContent('#status'), /Seal it first/);
    await page.touchscreen.tap(d.mx, d.my);
    await doorIs(page, 'd_door_control', 'closed', 0);
  });

  await check('tapping open space clears the selection', async () => {
    await page.touchscreen.tap(40, 200);
    assert.equal(await selected(page), null);
  });

  await check('every control is at least 44px tall and wide', async () => {
    const t = await target(page, 'd_brig');
    await page.touchscreen.tap(t.mx, t.my);
    const sizes = await page.$$eval('button', (list) => list.map((b) => ({ id: b.id, w: b.getBoundingClientRect().width, h: b.getBoundingClientRect().height })));
    assert.ok(sizes.length >= 5);
    // Buttons that are not on screen (a card with nothing to show) have no size to check.
    for (const s of sizes.filter((b) => b.w > 0)) assert.ok(s.w >= 44 && s.h >= 44, `${s.id} is ${Math.round(s.w)}x${Math.round(s.h)}`);
  });

  await check('back returns to the title and the clock stops', async () => {
    await page.tap('#btn-back');
    assert.equal(await game(page, () => window.coldManifest.machine.state), 'title');
    const a = await tick(page);
    await sleep(300);
    assert.equal(await tick(page), a);
  });

  await check('no page errors', async () => assert.deepEqual(errors, []));
  await context.close();
}

async function desktopTests(browser) {
  console.log('Desktop, mouse and keyboard');
  const context = await browser.newContext({ viewport: { width: 1600, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openShip(page, (sel) => page.click(sel), '&debug=1');

  await check('space pauses and resumes', async () => {
    await page.keyboard.press('Space');
    assert.equal(await paused(page), true);
    await page.keyboard.press('Space');
    assert.equal(await paused(page), false);
  });

  await check('click a door to open it; a click the same distance outside misses it', async () => {
    const t = await target(page, 'd_weapons');
    await page.mouse.click(t.mx, t.my);
    await doorIs(page, 'd_weapons', 'open', 1);
    await page.mouse.click(t.mx, t.y + t.h + 9);
    assert.deepEqual(await selected(page), { kind: 'room', id: 'weapons' });
    await sleep(200);
    assert.equal((await door(page, 'd_weapons')).state, 'open');
  });

  await check('space still pauses when a button has focus, and does not press it', async () => {
    await page.focus('#btn-lights');
    await page.keyboard.press('Space');
    assert.equal(await paused(page), true);
    assert.equal((await room(page, 'weapons')).lightsOn, true);
    assert.equal(await queued(page), 0);
    await page.keyboard.press('Enter');
    assert.equal(await queued(page), 1, 'Enter should press the focused control');
    await page.keyboard.press('Space');
    await page.waitForFunction(() => window.coldManifest.sim.state.rooms.weapons.light === 0, null, { timeout: 2000 });
  });

  await check('right-click describes a door and is not a tap', async () => {
    const t = await target(page, 'airlock_dorsal');
    const before = await counts(page);
    await page.mouse.click(t.mx, t.my, { button: 'right' });
    const after = await counts(page);
    assert.equal(after.infos, before.infos + 1);
    assert.equal(after.canvasTaps, before.canvasTaps);
    assert.equal(await infoText(page), 'Dorsal hatch: closed. Opens to space.');
  });

  await check('crew keys: a number key selects that crew member, a click sends them, escape lets go', async () => {
    await page.keyboard.press('Digit1');
    assert.equal(await selectedCrew(page), 'ilse');
    const t = await target(page, 'sensors');
    await page.mouse.click(t.mx, t.my);
    await page.waitForFunction(() => window.coldManifest.sim.state.crew.ilse.room === 'sensors', null, { timeout: 8000 });
    await page.keyboard.press('Digit2');
    assert.equal(await selectedCrew(page), 'dace');
    await page.keyboard.press('Escape');
    assert.equal(await selectedCrew(page), null);
    assert.equal(await game(page, () => window.coldManifest.machine.state), 'ship', 'escape let go of the crew member, it did not leave the screen');
  });

  await check('keys: the Q row no longer routes power, P opens the switch panel and G calls everyone to stations', async () => {
    assert.equal(await page.isVisible('#breaker-board'), false);
    const before = await game(page, () => JSON.stringify(window.coldManifest.sim.state.stations));
    await page.keyboard.press('KeyQ');
    await page.keyboard.press('Shift+KeyY');
    await sleep(200);
    assert.equal(await game(page, () => JSON.stringify(window.coldManifest.sim.state.stations)), before);
    assert.equal(await queued(page), 0);
    const mustered = page.evaluate(() => new Promise((resolve, reject) => {
      window.coldManifest.sim.events.on('roster.mustered', resolve);
      setTimeout(() => reject(new Error('no muster in 2s')), 2000);
    }));
    await page.keyboard.press('KeyG');
    await mustered;
  });

  await check('debug: reactor damage takes her outputs away and the panel shows it; mended, she holds what she was set to', async () => {
    const t = await target(page, 'reactor');
    await page.mouse.click(t.mx, t.my);
    await page.click('#btn-dbg-damage');
    await page.waitForFunction(() => window.coldManifest.sim.state.systems.reactor.damage === 1, null, { timeout: 2000 });
    assert.match(await page.textContent('#status'), /Output\s*steady · 7 of 8 bars/);
    await page.keyboard.press('KeyP');
    await page.waitForSelector('#breaker-board', { state: 'visible', timeout: 2000 });
    assert.match(await page.getAttribute('#btn-output-hard', 'title'), /damage/);
    await page.click('#btn-dbg-repair');
    await page.waitForFunction(() => window.coldManifest.sim.state.systems.reactor.damage === 0, null, { timeout: 2000 });
    assert.equal(await game(page, () => window.coldManifest.sim.state.power.output), 'steady');
  });

  await check('a damaged system says how to repair it, and Send to repair sends someone (D-118)', async () => {
    await game(page, () => window.coldManifest.sim.enqueue({ type: 'debug.system', system: 'sensors', damage: 1 }));
    const t = await target(page, 'sensors');
    await page.mouse.click(t.mx, t.my);
    await page.waitForSelector('#btn-repair', { state: 'visible', timeout: 2000 });
    assert.match(await page.textContent('#status'), /1 of 1 bar broken/);
    // Someone may already stand there (then the button says Repairing and is off); otherwise it sends the nearest hand.
    if (await page.isEnabled('#btn-repair')) await page.click('#btn-repair');
    else assert.match(await page.textContent('#status'), /is repairing it|will repair it|on the way/);
    await page.waitForFunction(() => Object.values(window.coldManifest.sim.state.crew).some((m) => m.goal === 'sensors' || (m.room === 'sensors' && m.task === 'repair')), null, { timeout: 2000 });
    await page.waitForFunction(() => window.coldManifest.sim.state.systems.sensors.damage === 0, null, { timeout: 30000 });
    await page.waitForSelector('#btn-repair', { state: 'hidden', timeout: 2000 });
  });

  await check('debug: fire, breach and thin air show in the status panel', async () => {
    const t = await target(page, 'reactor');
    await page.mouse.click(t.mx, t.my);
    await page.click('#btn-dbg-fire');
    await page.click('#btn-dbg-breach');
    await page.click('#btn-dbg-air');
    await page.waitForFunction(() => window.coldManifest.sim.state.rooms.reactor.oxygen < 0.3, null, { timeout: 2000 });
    const r = await room(page, 'reactor');
    assert.ok(r.fire > 0.6 && r.fire < 0.8, `the fire is live near 70% (Dace is in there fighting it), got ${r.fire}`);
    assert.equal(r.breach, 0.6);
    assert.ok(r.oxygen < 0.3, `the breach and the fire keep the air thin, got ${r.oxygen}`);
    const text = await page.textContent('#status');
    assert.match(text, /Fire\s*[67]\d%/);
    assert.match(text, /Breach\s*60%/);
    assert.equal(await page.locator('.stat.is-alarm').count(), 3);
    assert.equal(await page.locator('#btn-jettison').count(), 0, 'the reactor cannot be jettisoned');
    await page.click('#btn-dbg-reset');
    await page.waitForFunction(() => window.coldManifest.sim.state.rooms.reactor.fire === 0, null, { timeout: 2000 });
    await game(page, () => window.coldManifest.sim.enqueue({ type: 'debug.system', system: 'reactor', damage: 0 }));
  });

  // The brig door: nobody stands next to it to free it by hand (Halloran starts in the shields room).
  await check('debug: a jammed door refuses the panel and taps', async () => {
    const t = await target(page, 'd_brig');
    await page.mouse.click(t.mx, t.my);
    await doorIs(page, 'd_brig', 'open', 1);
    await page.click('#btn-dbg-jam');
    await doorIs(page, 'd_brig', 'jammed', 1);
    for (const id of ['#btn-door-open', '#btn-door-close', '#btn-door-lock']) assert.equal(await page.isDisabled(id), true);
    await page.mouse.click(t.mx, t.my);
    await sleep(250);
    assert.deepEqual(await door(page, 'd_brig'), { state: 'jammed', openness: 1 });
    assert.match(await page.textContent('#status'), /Jammed/);
  });

  await check('a click that slides off a button does not press it', async () => {
    const box = await page.locator('#btn-dbg-jam').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y - 160, { steps: 5 });
    await page.mouse.up();
    await sleep(200);
    assert.equal((await door(page, 'd_brig')).state, 'jammed');
  });

  await check('escape clears the selection, then goes back', async () => {
    await page.keyboard.press('Escape');
    assert.equal(await selected(page), null);
    assert.equal(await game(page, () => window.coldManifest.machine.state), 'ship');
    await page.keyboard.press('Escape');
    assert.equal(await game(page, () => window.coldManifest.machine.state), 'title');
  });

  await check('no page errors', async () => assert.deepEqual(errors, []));
  await context.close();
}

async function voiceTests(browser) {
  console.log('iPad: voice, sound and auto-pause');
  const context = await browser.newContext({ ...devices['iPad (gen 7) landscape'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // No ?autopause here: a touch device gets auto-pause by default.
  await page.goto(`http://localhost:${PORT}/?seed=E2E-VOICE&watches=0`);
  await page.waitForFunction(() => window.coldManifest?.machine.state === 'title');

  await check('sound is locked until the first tap, then the ship hum starts', async () => {
    assert.equal(await game(page, () => window.coldManifest.audio.unlocked), false);
    await page.tap('#btn-ship');
    await page.waitForFunction(() => window.coldManifest.machine.state === 'ship');
    await page.waitForFunction(() => window.coldManifest.audio.unlocked, null, { timeout: 3000 });
    await page.waitForFunction(() => window.coldManifest.audio.loops.includes('hum'), null, { timeout: 3000 });
  });

  await check('the AI greets the captain, typed out, and the line lands in her log', async () => {
    await page.waitForFunction(() => window.coldManifest.sim.state.ai.log.length === 1, null, { timeout: 3000 });
    const line = await game(page, () => window.coldManifest.sim.state.ai.log[0]);
    assert.equal(line.category, 'greeting');
    const early = await page.textContent('#ai-text');
    assert.ok(line.text.startsWith(early), 'the box shows the start of the line while it types');
    await page.waitForFunction((text) => document.querySelector('#ai-text').textContent === text, line.text, { timeout: 4000 });
    assert.ok((await game(page, () => window.coldManifest.audio.stats.played.blip ?? 0)) > 0, 'her voice blips as it types');
    await page.tap('#btn-log');
    assert.match(await page.textContent('#ailog'), new RegExp(`00:00\\s+${line.text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    await page.tap('#btn-log');
    assert.equal(await page.isHidden('#sheet'), true);
  });

  await check('auto-pause: a fire stops the clock and the pause button says why', async () => {
    assert.equal(await paused(page), false);
    await game(page, () => window.coldManifest.sim.enqueue({ type: 'debug.room', room: 'weapons', set: { fire: 0.3 } }));
    await page.waitForFunction(() => window.coldManifest.clock.paused, null, { timeout: 2000 });
    assert.equal(await page.textContent('#pause-note'), 'Fire in Weapons');
    const at = await tick(page);
    await sleep(300);
    assert.equal(await tick(page), at, 'and nothing moves until the captain is ready');
    await page.tap('#btn-pause');
    await page.waitForFunction(() => document.querySelector('#pause-note').textContent === 'Space bar');
    await page.waitForFunction(() => window.coldManifest.sim.state.ai.log.some((l) => l.category === 'hazard'), null, { timeout: 8000 });
    assert.ok((await game(page, () => window.coldManifest.audio.stats.played.alarm ?? 0)) > 0, 'the alarm sounded');
  });

  await check('settings: auto-pause on fire can be switched off, and the choice is kept', async () => {
    await page.tap('#btn-settings');
    assert.equal(await page.getAttribute('#set-pause-fire', 'aria-pressed'), 'true');
    await page.tap('#set-pause-fire');
    assert.equal(await page.getAttribute('#set-pause-fire', 'aria-pressed'), 'false');
    await page.tap('#btn-settings');
    await game(page, () => window.coldManifest.sim.enqueue({ type: 'debug.room', room: 'sensors', set: { fire: 0.3 } }));
    await page.waitForFunction(() => window.coldManifest.sim.state.rooms.sensors.fire > 0.3, null, { timeout: 2000 });
    assert.equal(await paused(page), false, 'no pause this time');
    const saved = await game(page, () => JSON.parse(window.localStorage.getItem('cold-manifest.settings.v1')));
    assert.deepEqual(saved.autoPause, { fired: true, boarded: true, fire: false, breach: true, death: true, objection: true, refusal: true, situation: true, contact: true });
  });

  await check('settings: sound off silences everything, sound on brings the hum back', async () => {
    await page.tap('#btn-settings');
    await page.tap('#set-sound');
    assert.equal(await game(page, () => window.coldManifest.audio.muted), true);
    assert.deepEqual(await game(page, () => window.coldManifest.audio.loops), []);
    const before = await game(page, () => window.coldManifest.audio.stats.played.click ?? 0);
    await page.tap('#set-sound');
    assert.equal(await game(page, () => window.coldManifest.audio.muted), false);
    assert.deepEqual(await game(page, () => window.coldManifest.audio.loops), ['hum']);
    await page.tap('#btn-settings');
    assert.ok((await game(page, () => window.coldManifest.audio.stats.played.click ?? 0)) > before, 'buttons click again');
  });

  await check('the ship still fits between the bars with the text box in place', async () => {
    const all = await game(page, () => window.coldManifest.shipView.debug.targets());
    const top = (await page.locator('.shipbar').boundingBox());
    const dock = (await page.locator('#aibox').boundingBox()).y;
    for (const t of all.filter((x) => x.kind === 'room')) assert.ok(t.y >= top.y + top.height && t.y + t.h <= dock, `${t.id} runs under a bar`);
  });

  await check('every control is at least 44px tall and wide, sheets included', async () => {
    await page.tap('#btn-settings');
    const small = await page.$$eval('.ship .btn', (nodes) => nodes.map((n) => ({ id: n.id, r: n.getBoundingClientRect() })).filter((n) => n.r.width > 0 && (n.r.width < 44 || n.r.height < 44)).map((n) => `${n.id} ${Math.round(n.r.width)}x${Math.round(n.r.height)}`));
    assert.deepEqual(small, []);
    await page.tap('#btn-settings');
  });

  await check('a reload keeps the settings', async () => {
    await page.reload();
    await page.waitForFunction(() => window.coldManifest?.machine.state === 'title');
    assert.deepEqual(await game(page, () => window.coldManifest.settings.values.autoPause), { fired: true, boarded: true, fire: false, breach: true, death: true, objection: true, refusal: true, situation: true, contact: true });
  });

  await check('no page errors', async () => assert.deepEqual(errors, []));
  await context.close();
}

async function hitTests(browser) {
  console.log('iPad: hits and what they do');
  const context = await browser.newContext({ ...devices['iPad (gen 7) landscape'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // No ?autopause: a touch device pauses by itself when a ship fires on us.
  await page.goto(`http://localhost:${PORT}/?seed=E2E-HITS&watches=0&debug=1`);
  await page.waitForFunction(() => window.coldManifest?.machine.state === 'title');
  await page.tap('#btn-ship');
  await page.waitForFunction(() => window.coldManifest.machine.state === 'ship');
  const resume = async () => {
    if (await paused(page)) await page.tap('#btn-pause');
    await page.waitForFunction(() => !window.coldManifest.clock.paused, null, { timeout: 2000 });
  };

  await check('auto-pause: a ship firing on us stops the clock and the pause button names it (H.3)', async () => {
    await resume();
    await game(page, () => window.coldManifest.sim.enqueue({ type: 'debug.contact', encounter: 'raider-skiff', state: 'closing', range: 12, bearing: 90 }));
    // Other pauses may come first (it closes on us); the bot captain waves each away until the shot.
    for (let i = 0; i < 40; i++) {
      if (/fires a warning shot/.test(await page.textContent('#pause-note'))) break;
      if (await paused(page)) await page.tap('#btn-pause');
      await sleep(250);
    }
    assert.equal(await page.textContent('#pause-note'), 'Raider skiff fires a warning shot');
    assert.equal(await paused(page), true);
    await game(page, () => window.coldManifest.sim.enqueue({ type: 'debug.contact', clear: true }));
  });

  await check('Hit us on a chosen room: the hull drops, the room\'s system breaks, the screen shakes and the room flashes', async () => {
    await resume();
    // Turn the other auto-pauses off so a fire from the hit does not stop the clock under the test.
    await game(page, () => {
      for (const key of ['fire', 'breach', 'death']) window.coldManifest.settings.set(`autoPause.${key}`, false);
    });
    const t = await target(page, 'weapons');
    await page.touchscreen.tap(t.mx, t.my);
    assert.deepEqual(await selected(page), { kind: 'room', id: 'weapons' });
    const landed = page.evaluate(() => new Promise((resolve) => window.coldManifest.sim.events.on('shot.resolved', resolve)));
    await page.tap('#btn-dbg-hit');
    const shot = await landed;
    assert.equal(shot.result, 'hit');
    assert.equal(shot.room, 'weapons');
    assert.equal(shot.effects.system, 2);
    assert.equal(await game(page, () => window.coldManifest.sim.state.systems.weapons.damage), 2);
    assert.equal(await game(page, () => window.coldManifest.sim.state.hull.points), 18);
    assert.ok(await game(page, () => window.coldManifest.shipView.debug.shake), 'the screen shook');
    assert.ok(await game(page, () => window.coldManifest.shipView.debug.impacts.some((i) => i.result === 'hit' && i.room === 'weapons')), 'the hit is drawn on our ship');
    // E2E_SHOTS=<folder> keeps a picture of the moment for the PR.
    if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/s2-2-hit-ipad.png` });
  });

  await check('hits land through the hazard code: enough of them on one room burn it or hole it', async () => {
    const before = await game(page, () => ({ ...window.coldManifest.sim.state.rooms.cargo }));
    for (let i = 0; i < 6; i++) {
      await game(page, () => window.coldManifest.sim.enqueue({ type: 'debug.hit', at: 'us', room: 'cargo', weapon: 'slug-thrower', force: true }));
      await page.waitForFunction((n) => window.coldManifest.sim.state.hull.points <= 18 - 2 * (n + 1), i, { timeout: 2000 });
    }
    const after = await game(page, () => ({ ...window.coldManifest.sim.state.rooms.cargo }));
    assert.ok(after.hull < before.hull, 'the room is worn');
    assert.ok(after.fire > 0 || after.breach > 0 || after.oxygen < before.oxygen, 'something caught or gave way');
  });

  await check('settings: screen shake can be turned off, and the choice is kept', async () => {
    await page.tap('#btn-settings');
    assert.equal(await page.getAttribute('#set-shake', 'aria-pressed'), 'true');
    assert.equal(await page.getAttribute('#set-pause-fired', 'aria-pressed'), 'true');
    await page.tap('#set-shake');
    assert.equal(await page.getAttribute('#set-shake', 'aria-pressed'), 'false');
    await page.tap('#btn-settings');
    const saved = await game(page, () => JSON.parse(window.localStorage.getItem('cold-manifest.settings.v1')));
    assert.equal(saved.shake, false);
  });

  await check('every control is at least 44px tall and wide with the debug Hit us button in the bar', async () => {
    const small = await page.$$eval('.ship .btn', (nodes) => nodes.map((n) => ({ id: n.id, r: n.getBoundingClientRect() })).filter((n) => n.r.width > 0 && (n.r.width < 44 || n.r.height < 44)).map((n) => `${n.id} ${Math.round(n.r.width)}x${Math.round(n.r.height)}`));
    assert.deepEqual(small, []);
  });

  await check('no page errors', async () => assert.deepEqual(errors, []));
  await context.close();
}

async function darkTests(browser) {
  console.log('iPad: what we can see, running dark, and the scan');
  const context = await browser.newContext({ ...devices['iPad (gen 7) landscape'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${PORT}/?seed=E2E-DARK&watches=0&autopause=0&debug=1`);
  await page.waitForFunction(() => window.coldManifest?.machine.state === 'title');
  await page.tap('#btn-ship');
  await page.waitForFunction(() => window.coldManifest.machine.state === 'ship');
  const shots = process.env.E2E_SHOTS;
  const seen = (id) => game(page, (rid) => ({ ...window.coldManifest.sim.state.seen[rid] }), id);
  const lit = () => game(page, () => Object.values(window.coldManifest.sim.state.rooms).filter((r) => r.lightsOn && !r.jettisoned).length);

  await check('nothing selected: the panel shows the ship\'s signature and a Go dark button', async () => {
    assert.match(await page.textContent('#status'), /Signature\s*\d+%/);
    assert.match(await page.textContent('#status'), /Light/);
    assert.match(await page.textContent('#status'), /Noise/);
    assert.match(await page.textContent('#status'), /Heat/);
    assert.equal(await page.textContent('#btn-dark'), 'Go dark');
  });

  let before = '';
  await check('Go dark puts every lamp out and the signature falls; with sensors up we still see every room', async () => {
    before = (await page.textContent('#status')).match(/Signature\s*(\d+)%/)[1];
    assert.ok((await lit()) > 0);
    await page.tap('#btn-dark');
    await page.waitForFunction(() => Object.values(window.coldManifest.sim.state.rooms).every((r) => !r.lightsOn), null, { timeout: 2000 });
    await page.waitForFunction(() => document.querySelector('#btn-dark').textContent === 'Lights up', null, { timeout: 2000 });
    await page.waitForFunction((was) => Number(document.querySelector('#status').textContent.match(/Signature\s*(\d+)%/)?.[1]) < Number(was), before, { timeout: 4000 });
    assert.equal((await seen('brig')).live, true);
  });

  await check('sensors off as well: an empty dark room goes to static, and a breach in it stays unknown', async () => {
    if (!(await page.isVisible('#breaker-board'))) await page.tap('#btn-breakers');
    if (!(await down(page, 'sensors'))) await page.tap('#btn-stand-sensors');
    await downIs(page, 'sensors', true);
    await page.waitForFunction(() => window.coldManifest.sim.state.seen.brig.live === false, null, { timeout: 3000 });
    await game(page, () => window.coldManifest.sim.enqueue({ type: 'debug.room', room: 'brig', set: { breach: 0.6 } }));
    await page.waitForFunction(() => window.coldManifest.sim.state.rooms.brig.breach > 0, null, { timeout: 2000 });
    const t = await target(page, 'brig');
    await page.touchscreen.tap(t.mx, t.my);
    assert.equal(await page.textContent('#status-title'), 'Brig');
    await page.waitForFunction(() => /No eyes in here/.test(document.querySelector('#status').textContent), null, { timeout: 2000 });
    await sleep(600);
    assert.equal((await seen('brig')).live, false);
    assert.equal((await seen('brig')).breach, 0, 'what we remember has no hole in it');
    assert.doesNotMatch(await page.textContent('#status'), /Breach\s*[1-9]/i, 'the panel does not give the breach away');
    if (shots) await page.screenshot({ path: `${shots}/s2-7-dark-room-ipad.png` });
  });

  await check('sensors back on: the room is seen again and the breach is found', async () => {
    const found = page.evaluate(() => new Promise((resolve, reject) => {
      window.coldManifest.sim.events.on('breach.found', resolve);
      setTimeout(() => reject(new Error('no breach.found in 4s')), 4000);
    }));
    found.catch(() => {});
    await page.tap('#btn-stand-sensors');
    assert.equal((await found).room, 'brig');
    await page.waitForFunction(() => window.coldManifest.sim.state.seen.brig.live === true, null, { timeout: 2000 });
    await page.waitForFunction(() => !/No eyes in here/.test(document.querySelector('#status').textContent), null, { timeout: 2000 });
    await game(page, () => window.coldManifest.sim.enqueue({ type: 'debug.room', room: 'brig', set: { breach: 0, oxygen: 1 } }));
  });

  await check('Lights up puts the lamps back', async () => {
    await page.touchscreen.tap(40, 200); // open space lets go of the room
    await page.waitForSelector('#btn-dark', { timeout: 2000 });
    await page.tap('#btn-dark');
    await page.waitForFunction(() => Object.values(window.coldManifest.sim.state.rooms).filter((r) => !r.jettisoned).every((r) => r.lightsOn), null, { timeout: 2000 });
    assert.equal(await page.textContent('#btn-dark'), 'Go dark');
  });

  await check('every control is at least 44px tall and wide with the Go dark button up', async () => {
    const small = await page.$$eval('.ship .btn', (nodes) => nodes.map((n) => ({ id: n.id, r: n.getBoundingClientRect() })).filter((n) => n.r.width > 0 && (n.r.width < 44 || n.r.height < 44)).map((n) => `${n.id} ${Math.round(n.r.width)}x${Math.round(n.r.height)}`));
    assert.deepEqual(small, []);
  });

  await check('no page errors', async () => assert.deepEqual(errors, []));
  await context.close();
}

async function holdTests(browser) {
  console.log('iPad: the brace, rounds for the heavy guns, and the crates in the hold (S2.8)');
  const context = await browser.newContext({ ...devices['iPad (gen 7) landscape'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${PORT}/?seed=E2E-HOLD&watches=0&autopause=0&debug=1`);
  await page.waitForFunction(() => window.coldManifest?.machine.state === 'title');
  await page.tap('#btn-ship');
  await page.waitForFunction(() => window.coldManifest.machine.state === 'ship');
  const shots = process.env.E2E_SHOTS;
  const settle = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const crateTargets = () => game(page, () => window.coldManifest.shipView.debug.targets().filter((x) => x.kind === 'crate'));
  const crate = (id) => game(page, (cid) => ({ ...window.coldManifest.sim.state.crates[cid] }), id);

  await check('the holds show their crates, each a target of its own', async () => {
    await settle();
    const crates = await crateTargets();
    const count = await game(page, () => Object.keys(window.coldManifest.sim.state.crates).length);
    assert.equal(crates.length, count);
    assert.ok(count >= 12);
    for (const t of crates) assert.ok(t.w >= 18 && t.h >= 12, `${t.id} is ${Math.round(t.w)}x${Math.round(t.h)}`);
    if (shots) await page.screenshot({ path: `${shots}/s2-8-hold-ipad.png` });
  });

  let sealed = null;
  await check('tap a sealed crate: its panel names it, and Open sends someone to break the seal', async () => {
    sealed = await game(page, () => Object.values(window.coldManifest.sim.state.crates).find((c) => c.sealed && c.room === 'hold').id);
    const t = (await crateTargets()).find((x) => x.id === sealed);
    await page.touchscreen.tap(t.x + t.w / 2, t.y + t.h / 2);
    assert.deepEqual(await selected(page), { kind: 'crate', id: sealed });
    assert.match(await page.textContent('#status-title'), /Manifest 7731/);
    assert.match(await page.textContent('#status'), /sealed/);
    await page.tap('#btn-crate-open');
    await page.waitForFunction((cid) => Object.values(window.coldManifest.sim.state.crew).some((m) => m.job?.crate === cid), sealed, { timeout: 2000 });
    await page.waitForFunction((cid) => !window.coldManifest.sim.state.crates[cid].sealed, sealed, { timeout: 40000 });
    await page.waitForFunction(() => !/sealed/.test(document.querySelector('#status').textContent), null, { timeout: 2000 });
  });

  await check('Move, then tap a room: the crate is carried there and set down', async () => {
    await page.tap('#btn-crate-move');
    assert.equal(await game(page, () => window.coldManifest.shipView.debug.movingCrate), sealed);
    assert.match(await page.textContent('#status'), /Tap a room of ours/);
    const t = await target(page, 'cargo');
    await page.touchscreen.tap(t.x + t.w * 0.75, t.y + t.h * 0.3); // high on the bulkhead, clear of the crates and the hatch
    await page.waitForFunction((cid) => window.coldManifest.sim.state.crates[cid].by !== null, sealed, { timeout: 40000 });
    await page.waitForFunction((cid) => window.coldManifest.sim.state.crates[cid].room === 'cargo', sealed, { timeout: 60000 });
  });

  await check('Jettison takes two presses, and the crate goes out of an airlock', async () => {
    // Whoever set it down steps away first, so the tap finds the crate and not them.
    await game(page, () => {
      const sim = window.coldManifest.sim;
      for (const m of Object.values(sim.state.crew)) if (m.room === 'cargo') sim.enqueue({ type: 'crew.move', crew: m.id, room: 'aft_corridor' });
    });
    await page.waitForFunction(() => Object.values(window.coldManifest.sim.state.crew).every((m) => m.room !== 'cargo' && !m.path.length), null, { timeout: 20000 });
    await settle();
    const t = (await crateTargets()).find((x) => x.id === sealed);
    await page.touchscreen.tap(t.x + t.w / 2, t.y + t.h / 2);
    assert.deepEqual(await selected(page), { kind: 'crate', id: sealed });
    await page.tap('#btn-crate-jettison');
    assert.equal(await page.textContent('#btn-crate-jettison'), 'Confirm jettison');
    await page.tap('#btn-crate-jettison');
    await page.waitForFunction((cid) => !window.coldManifest.sim.state.crates[cid], sealed, { timeout: 60000 });
  });

  await check('the Brace button counts the capacitor and braces whenever it is full, no fight needed (H.3)', async () => {
    await page.touchscreen.tap(40, 200); // open space: the ship's own panel
    await page.waitForSelector('#btn-brace', { state: 'visible', timeout: 2000 });
    assert.equal(await page.textContent('#brace-note'), 'Shields dark');
    if (!(await page.isVisible('#breaker-board'))) await page.tap('#btn-breakers');
    await page.tap('#btn-stand-shields');
    await downIs(page, 'shields', false);
    await page.waitForFunction(() => /^\d+%$/.test(document.querySelector('#brace-note').textContent), null, { timeout: 2000 });
    await page.waitForFunction(() => window.coldManifest.sim.state.shield.charge >= 1, null, { timeout: 12000 });
    await page.tap('#btn-brace');
    await page.waitForFunction(() => window.coldManifest.sim.state.shield.field > 0, null, { timeout: 2000 });
    await page.waitForFunction(() => /Up \d+s/.test(document.querySelector('#brace-note').textContent), null, { timeout: 2000 });
    if (shots) await page.screenshot({ path: `${shots}/h3-brace-ipad.png` });
  });

  await check('the gun shows its rounds on the ship panel; empty, Fetch rounds sends someone to the hold and back', async () => {
    await game(page, () => (window.coldManifest.sim.state.weapons[1].rounds = 0));
    await page.waitForSelector('#btn-fetch-rounds', { state: 'visible', timeout: 2000 });
    await page.tap('#btn-fetch-rounds');
    await page.waitForFunction(() => Object.values(window.coldManifest.sim.state.crew).some((m) => m.job?.kind === 'load'), null, { timeout: 2000 });
    await page.waitForFunction(() => window.coldManifest.sim.state.weapons[1].rounds === 3, null, { timeout: 90000 });
    await page.waitForSelector('#btn-fetch-rounds', { state: 'hidden', timeout: 2000 });
  });

  await check('every control is at least 44px tall and wide with a crate or a heavy gun picked', async () => {
    const small = await page.$$eval('.ship .btn', (nodes) => nodes.map((n) => ({ id: n.id, r: n.getBoundingClientRect() })).filter((n) => n.r.width > 0 && (n.r.width < 44 || n.r.height < 44)).map((n) => `${n.id} ${Math.round(n.r.width)}x${Math.round(n.r.height)}`));
    assert.deepEqual(small, []);
  });

  await check('no page errors', async () => assert.deepEqual(errors, []));
  await context.close();
}

async function margoTests(browser) {
  console.log('iPad: Margo holds an order, the captain overrides, and the crew refuse (S2.10)');
  const context = await browser.newContext({ ...devices['iPad (gen 7) landscape'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${PORT}/?seed=E2E-MARGO&watches=0&autopause=0&debug=1`);
  await page.waitForFunction(() => window.coldManifest?.machine.state === 'title');
  await page.tap('#btn-ship');
  await page.waitForFunction(() => window.coldManifest.machine.state === 'ship');
  const shots = process.env.E2E_SHOTS;
  const ai = (page) => game(page, () => ({ trust: window.coldManifest.sim.state.ai.trust, refusals: window.coldManifest.sim.state.ai.refusals, held: window.coldManifest.sim.state.ai.objection?.kind ?? null }));
  const give = (command) => game(page, (cmd) => window.coldManifest.sim.enqueue(cmd), command);
  const holding = (kind) => page.waitForFunction((k) => (window.coldManifest.sim.state.ai.objection?.kind ?? null) === k, kind, { timeout: 3000 });
  /** Shut the hatch and give Okoro his air back, so he is there to be argued over again. */
  const mend = async () => {
    await give({ type: 'door.set', door: 'airlock_dorsal', state: 'closed' });
    await doorIs(page, 'airlock_dorsal', 'closed', 0);
    await give({ type: 'debug.room', room: 'quarters', set: { oxygen: 1 } });
  };

  await check('opening the hatch on Okoro: Margo refuses, names him and the room, and offers the override in one tap', async () => {
    const t = await target(page, 'airlock_dorsal');
    await page.touchscreen.tap(t.mx, t.my);
    await page.tap('#btn-door-open');
    await holding('refuse');
    await page.waitForSelector('#objection', { state: 'visible', timeout: 2000 });
    assert.equal(await page.textContent('#btn-override'), "Captain's override");
    assert.match(await page.textContent('#ai-name'), /refuses · holding your order \d+s/);
    assert.equal(await page.isVisible('#btn-log'), false, 'her two answers take the place of Log and Settings');
    await page.waitForFunction(() => /Okoro/.test(document.querySelector('#ai-text').textContent) && /Quarters and mess/.test(document.querySelector('#ai-text').textContent), null, { timeout: 6000 });
    assert.deepEqual(await door(page, 'airlock_dorsal'), { state: 'closed', openness: 0 });
    for (const id of ['#btn-override', '#btn-stand-down']) {
      const box = await page.locator(id).boundingBox();
      assert.ok(box.width >= 44 && box.height >= 44, `${id} is ${Math.round(box.width)}x${Math.round(box.height)}`);
    }
    const fit = await game(page, () => {
      const v = window.coldManifest.shipView.debug.view;
      return { top: v.oy, bottom: document.querySelector('.shipdock').getBoundingClientRect().top };
    });
    assert.ok(fit.top > 0 && fit.bottom > 300, 'the ship still has its room');
    if (shots) await page.screenshot({ path: `${shots}/s2-10-refuses-ipad.png` });
  });

  await check('Stand down: the order is dropped, she trusts the captain a little more, and her buttons go away', async () => {
    await page.tap('#btn-stand-down');
    await holding(null);
    assert.deepEqual(await ai(page), { trust: 53, refusals: 1, held: null });
    await page.waitForSelector('#objection', { state: 'hidden', timeout: 2000 });
    assert.equal(await page.isVisible('#btn-log'), true);
    assert.equal(await page.textContent('#ai-name'), 'M.A.R.G.O.');
    assert.deepEqual(await door(page, 'airlock_dorsal'), { state: 'closed', openness: 0 });
  });

  await check("Captain's override: one tap, the hatch opens, and it costs her trust", async () => {
    await page.tap('#btn-door-open');
    await holding('refuse');
    await page.tap('#btn-override');
    await page.waitForFunction(() => window.coldManifest.sim.state.doors.airlock_dorsal.state === 'open', null, { timeout: 2000 });
    assert.deepEqual(await ai(page), { trust: 38, refusals: 2, held: null });
    await page.waitForFunction(() => window.coldManifest.sim.state.ai.log.at(-1).category === 'override', null, { timeout: 3000 });
    await mend();
  });

  await check('keys: Escape stands down; after three refusals she can only argue, and O does it anyway', async () => {
    // The hatch she was just overridden on she will not raise again for a while, so this time it is the whole room.
    await give({ type: 'room.jettison', room: 'quarters' });
    await holding('refuse');
    await page.keyboard.press('Escape');
    await holding(null);
    assert.equal((await ai(page)).refusals, 3);
    await give({ type: 'room.jettison', room: 'quarters' });
    await holding('argue');
    assert.equal(await page.textContent('#btn-override'), 'Do it anyway');
    assert.match(await page.textContent('#ai-name'), /objects/);
    await page.waitForFunction(() => window.coldManifest.sim.state.ai.log.at(-1).category === 'argument', null, { timeout: 3000 });
    await page.keyboard.press('KeyO');
    await page.waitForFunction(() => window.coldManifest.sim.state.rooms.quarters.jettisoned, null, { timeout: 2000 });
    assert.equal(await game(page, () => window.coldManifest.sim.state.crew.okoro.alive), false);
    // The two who are left remember who did it.
    assert.deepEqual(await game(page, () => window.coldManifest.sim.state.crew.ilse.memories.map((m) => m.type).slice(-2)), ['death', 'override']);
  });

  await check('the debug sheet shows her trust and moves it, and can put a memory in a crew member\'s head', async () => {
    const who = await crewTarget(page, 'dace');
    await page.touchscreen.tap(who.cx, who.cy);
    await page.tap('#btn-dbg-menu');
    const before = (await ai(page)).trust;
    assert.match(await page.textContent('#dbg-trust'), new RegExp(`trust ${before} .*refused 3 of 3`));
    for (const id of ['#btn-dbg-trust-down', '#btn-dbg-trust-up', '#btn-dbg-refusals', '#btn-dbg-mem-death', '#btn-dbg-mem-scare', '#btn-dbg-dread']) {
      await page.locator(id).scrollIntoViewIfNeeded();
      const box = await page.locator(id).boundingBox();
      assert.ok(box && box.width >= 44 && box.height >= 44, `${id} ${JSON.stringify(box)}`);
    }
    if (shots) await page.screenshot({ path: `${shots}/s2-10-debug-ipad.png` });
    // A debug button does its work and folds the sheet away.
    await page.tap('#btn-dbg-trust-up');
    await page.waitForFunction((t) => window.coldManifest.sim.state.ai.trust === t + 20, before, { timeout: 2000 });
    await page.tap('#btn-dbg-menu');
    await page.tap('#btn-dbg-mem-scare');
    await page.waitForFunction(() => window.coldManifest.sim.state.crew.dace.memories.some((m) => m.type === 'scare'), null, { timeout: 2000 });
    assert.match(await page.textContent('#crew-memory'), /Remembers the dark in Reactor\./);
  });

  await check('a crew member with a bad memory of the dark refuses an unlit room: their own "no" on the intercom, and the reason in the panel', async () => {
    await give({ type: 'room.lights', room: 'life_support', on: false });
    await page.waitForFunction(() => window.coldManifest.sim.state.rooms.life_support.light === 0, null, { timeout: 2000 });
    const t = await target(page, 'life_support');
    await page.touchscreen.tap(t.mx, t.my);
    await page.waitForSelector('#intercom', { state: 'visible', timeout: 2000 });
    assert.match(await page.textContent('#intercom'), /Dace/);
    assert.equal(await page.textContent('#intercom-text'), 'No. Not a chance.');
    assert.match(await page.textContent('#status'), /Dace won't go into Life support alone in the dark\. Not after the dark in Reactor\./);
    assert.equal(await game(page, () => window.coldManifest.sim.state.crew.dace.goal), null);
    if (shots) await page.screenshot({ path: `${shots}/s2-10-crew-refuses-ipad.png` });
    // With the lamp on, he goes.
    await give({ type: 'room.lights', room: 'life_support', on: true });
    await page.waitForFunction(() => window.coldManifest.sim.state.rooms.life_support.light === 1, null, { timeout: 2000 });
    await page.touchscreen.tap(t.mx, t.my);
    await page.waitForFunction(() => window.coldManifest.sim.state.crew.dace.goal === 'life_support' || window.coldManifest.sim.state.crew.dace.room === 'life_support', null, { timeout: 2000 });
  });

  await check('the dark gets to someone alone in it: they put the lamp on, say so, and the Lights button says why it stays on', async () => {
    await give({ type: 'room.lights', room: 'bridge', on: false });
    await give({ type: 'debug.memory', crew: 'ilse', dread: 0.97 });
    await page.waitForFunction(() => window.coldManifest.sim.state.rooms.bridge.lightsOn === true && window.coldManifest.sim.state.crew.ilse.lampUntil > 0, null, { timeout: 8000 });
    await page.waitForFunction(() => /Ilse/.test(document.querySelector('#intercom').textContent), null, { timeout: 2000 });
    assert.equal(await page.textContent('#intercom-text'), "Lamp's on. I'll answer for it.");
    await page.keyboard.press('Escape');
    const t = await target(page, 'bridge');
    await page.touchscreen.tap(t.mx, t.my);
    await page.tap('#btn-lights');
    assert.match(await page.textContent('#status'), /Ilse wants the lamp on\. Not after the dark in Bridge\./);
    assert.equal((await room(page, 'bridge')).lightsOn, true);
  });

  await check('settings list the two new auto-pauses, every control is big enough, and the sheet clears the buttons under it', async () => {
    await page.tap('#btn-settings');
    for (const id of ['#set-pause-objection', '#set-pause-refusal']) assert.equal(await page.isVisible(id), true, id);
    const sizes = await page.$$eval('button', (list) => list.map((b) => ({ id: b.id, w: b.getBoundingClientRect().width, h: b.getBoundingClientRect().height })));
    for (const s of sizes.filter((b) => b.w > 0)) assert.ok(s.w >= 44 && s.h >= 44, `${s.id} is ${Math.round(s.w)}x${Math.round(s.h)}`);
    if (shots) await page.screenshot({ path: `${shots}/s2-10-settings-ipad.png` });
    await page.tap('#btn-settings');
    await page.waitForSelector('#sheet', { state: 'hidden', timeout: 2000 });
  });

  await check('no page errors', async () => assert.deepEqual(errors, []));
  await context.close();

  // Auto-pause on by default on touch: the clock stops when she holds an order, and the pause button says why.
  const second = await browser.newContext({ ...devices['iPad (gen 7) landscape'] });
  const paged = await second.newPage();
  await paged.goto(`http://localhost:${PORT}/?seed=E2E-MARGO-PAUSE&watches=0&sound=0`);
  await paged.waitForFunction(() => window.coldManifest?.machine.state === 'title');
  await paged.tap('#btn-ship');
  await paged.waitForFunction(() => window.coldManifest.machine.state === 'ship');
  await check('auto-pause: Margo holding an order stops the clock and the pause button says so', async () => {
    await game(paged, () => window.coldManifest.sim.enqueue({ type: 'room.jettison', room: 'quarters' }));
    await paged.waitForFunction(() => window.coldManifest.clock.paused, null, { timeout: 3000 });
    assert.equal(await paged.textContent('#pause-note'), 'Margo refuses');
    assert.equal(await paged.isVisible('#btn-override'), true);
  });
  await second.close();
}

async function chartTests(browser) {
  console.log('iPad and desktop: Margo\'s route chart: plot a route at port, cast off, fly it, and jump in (H.6)');
  const context = await browser.newContext({ ...devices['iPad (gen 7) landscape'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${PORT}/?seed=E2E-CHART&watches=0&autopause=0&debug=1`);
  await page.waitForFunction(() => window.coldManifest?.machine.state === 'title');
  const shots = process.env.E2E_SHOTS;
  const run = () => game(page, () => JSON.parse(JSON.stringify(window.coldManifest.sim.state.run)));
  const nextFrom = (r, id = r.at) => r.map.lanes.filter((l) => l.a === id || l.b === id).map((l) => (l.a === id ? l.b : l.a));
  const kindOf = (r, id) => r.map.nodes.find((n) => n.id === id).kind;

  await check('New run puts the chart up on the monitor in port, every point a big enough target, every lane with its hours, and the ship still running', async () => {
    await page.tap('#btn-new-run');
    await page.tap('#accept-courier');
    await page.waitForFunction(() => window.coldManifest.machine.state === 'ship' && window.coldManifest.shipView.debug.chartOpen);
    assert.equal(await page.isVisible('#chart'), true);
    const r = await run();
    assert.ok(r.map.nodes.length >= 15 && r.map.nodes.length <= 25);
    assert.equal(await page.locator('.chartnode').count(), r.map.nodes.length);
    assert.equal(await page.locator('.chart__hours').count(), r.map.lanes.length, 'every lane says how long it is');
    const sizes = await page.$$eval('.chartnode', (list) => list.map((b) => ({ id: b.id, w: b.getBoundingClientRect().width, h: b.getBoundingClientRect().height })));
    for (const size of sizes) assert.ok(size.w >= 44 && size.h >= 44, `${size.id} is ${size.w}x${size.h}`);
    assert.match(await page.textContent('#chart-fuel'), /Fuel 10\/12/);
    assert.match(await page.textContent('#chart-clock'), /Hour 0 · \d+ h to deadline/);
    assert.match(await page.textContent('#btn-chart-action'), /Cast off\s*Plot a route/);
    assert.equal(await page.isDisabled('#btn-chart-action'), true);
    assert.equal(await page.isVisible('#chart-legend'), true, 'a key to the lanes');
    const t0 = await tick(page);
    await page.waitForFunction((t) => window.coldManifest.sim.state.tick > t + 5, t0);
    assert.equal(await page.textContent('#chart').then((text) => /null|undefined|NaN/.test(text)), false);
  });

  await check('tap a point a lane away and add it to the route: the card shows what the route costs and runs through', async () => {
    const r = await run();
    const to = nextFrom(r).find((id) => kindOf(r, id) !== 'port') ?? nextFrom(r)[0];
    await page.tap(`#node-${to}`);
    assert.equal(await game(page, () => window.coldManifest.shipView.debug.chartSelected), to);
    await page.tap('#btn-route-add');
    assert.deepEqual(await game(page, () => window.coldManifest.shipView.debug.chartDraft), [r.at, to]);
    assert.match(await page.textContent('#chart-route'), /Route: 1 lane to .*\d+ h at the lane's pace, \d fuel of 10/);
    if (kindOf(r, to) !== 'port') {
      assert.match(await page.textContent('#btn-chart-action'), /Ends at a port/);
      assert.equal(await page.isDisabled('#btn-chart-action'), true);
    }
    await page.tap('#btn-route-back');
    assert.equal(await game(page, () => window.coldManifest.shipView.debug.chartDraft), null);
  });

  await check('a point with no lane from the end of the route cannot be added, and says why', async () => {
    const r = await run();
    const near = new Set(nextFrom(r));
    const far = r.map.nodes.find((n) => n.id !== r.at && !near.has(n.id) && n.kind !== 'port');
    await page.tap(`#node-${far.id}`);
    assert.equal(await page.isDisabled('#btn-route-add'), true);
    assert.match(await page.textContent('#btn-route-add'), /no lane from the end of the route/);
  });

  await check('pick a port and let Margo plot the quickest way there; cast off, and the ship moves along her lane in ship time', async () => {
    const r = await run();
    // The nearest port by the fewest lanes that does not pass another port.
    const port = await game(page, () => {
      const r = window.coldManifest.sim.state.run;
      const ports = r.map.nodes.filter((n) => n.kind === 'port' && n.id !== r.at);
      return ports.sort((a, b) => a.x - b.x)[0].id;
    });
    await page.tap(`#node-${port}`);
    await page.tap('#btn-route-quick');
    const draft = await game(page, () => window.coldManifest.shipView.debug.chartDraft);
    assert.equal(draft[0], r.at);
    assert.equal(draft.at(-1), port);
    assert.match(await page.textContent('#btn-chart-action'), /Cast off\s*\d+ h/);
    if (shots) await page.screenshot({ path: `${shots}/h6-route-ipad.png` });
    await page.tap('#btn-chart-action');
    await page.waitForFunction(() => window.coldManifest.sim.state.run.crossing !== null, null, { timeout: 2000 });
    assert.match(await page.textContent('#btn-chart-action'), /Under way\s*.+to go/);
    assert.equal(await page.isVisible('#chart-ship'), true, 'the ship is on the chart');
    assert.match(await page.textContent('#chart-lane-title'), /Under way to/);
    const t0 = await game(page, () => window.coldManifest.sim.state.run.crossing.t);
    await page.waitForFunction((t) => window.coldManifest.sim.state.run.crossing.t > t, t0, { timeout: 3000 });
    const after = await run();
    assert.equal(after.fuel, r.fuel - after.map.lanes.find((l) => (l.a === draft[0] && l.b === draft[1]) || (l.b === draft[0] && l.a === draft[1])).fuel, 'the first lane\'s fuel is spent');
  });

  await check('the follower finds us under way: it comes in on the scope, and the chart says we are followed', async () => {
    await page.tap('#btn-dbg-menu');
    await page.tap('#btn-dbg-caught');
    await page.waitForFunction(() => window.coldManifest.sim.state.scope.contacts.some((c) => c.pursuer), null, { timeout: 2000 });
    if (await page.isVisible('#sheet')) await page.tap('#btn-dbg-menu');
    await page.waitForSelector('#sheet', { state: 'hidden', timeout: 2000 });
    if (!(await game(page, () => window.coldManifest.shipView.debug.chartOpen))) await page.tap('#btn-chart');
    await page.waitForFunction(() => /Followed/.test(document.querySelector('#chart-chase').textContent), null, { timeout: 2000 });
    await game(page, () => window.coldManifest.sim.enqueue({ type: 'debug.contact', clear: true }));
  });

  await check('off the port at the end of the route the one button takes the fix and jumps in; the port opens', async () => {
    for (let i = 0; i < 20; i++) {
      const phase = await game(page, () => window.coldManifest.sim.state.run.crossing?.phase ?? null);
      if (phase !== 'under way') break;
      if (await game(page, () => Boolean(window.coldManifest.sim.state.run.events.open))) {
        await page.waitForFunction(() => window.coldManifest.machine.state === 'event', null, { timeout: 2000 });
        await answerEvents(page);
        await page.waitForFunction(() => window.coldManifest.machine.state === 'ship');
        continue;
      }
      await settleSituations(page); // a hull alongside would hold her (H.7)
      await game(page, () => !window.coldManifest.sim.whyNot({ type: 'debug.run', skip: true }) && window.coldManifest.sim.enqueue({ type: 'debug.run', skip: true }));
      await sleep(150);
    }
    await page.waitForFunction(() => window.coldManifest.sim.state.run.crossing?.phase === 'off port', null, { timeout: 3000 });
    if ((await game(page, () => window.coldManifest.machine.state)) !== 'ship') await answerEvents(page);
    if (!(await game(page, () => window.coldManifest.shipView.debug.chartOpen))) await page.tap('#btn-chart');
    await page.waitForFunction(() => /Jump in/.test(document.querySelector('#btn-chart-action').textContent), null, { timeout: 2000 });
    await game(page, () => window.coldManifest.sim.enqueue({ type: 'debug.run', fix: true }));
    await page.waitForFunction(() => !document.querySelector('#btn-chart-action').disabled, null, { timeout: 3000 });
    if (shots) await page.screenshot({ path: `${shots}/h6-offport-ipad.png` });
    await page.tap('#btn-chart-action');
    await page.waitForFunction(() => window.coldManifest.machine.state === 'port', null, { timeout: 3000 });
    assert.equal(await game(page, () => window.coldManifest.sim.state.run.crossing), null);
    await page.tap('#btn-depart');
    await page.waitForFunction(() => window.coldManifest.machine.state === 'ship' && window.coldManifest.shipView.debug.chartOpen);
    assert.match(await page.textContent('#btn-chart-action'), /Cast off/);
  });

  await check('the Ship button and Escape fold the chart; the schematic is tappable again', async () => {
    await page.tap('#btn-chart-close');
    assert.equal(await page.isVisible('#chart'), false);
    await page.tap('#btn-chart');
    assert.equal(await page.isVisible('#chart'), true);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    assert.equal(await page.isVisible('#chart'), false);
  });

  await check('no page errors', async () => assert.deepEqual(errors, []));
  await context.close();

  // Desktop at 1024x768: M for the chart, a click to pick a port, J to cast off.
  const desk = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const pd = await desk.newPage();
  const deskErrors = [];
  pd.on('pageerror', (e) => deskErrors.push(e.message));
  await pd.goto(`http://localhost:${PORT}/?seed=E2E-CHART-DESK&watches=0&autopause=0`);
  await pd.waitForFunction(() => window.coldManifest?.machine.state === 'title');
  await pd.click('#btn-ship');
  await pd.waitForFunction(() => window.coldManifest.machine.state === 'ship');
  await check('desktop: M opens the chart, a click picks a port, Margo plots the way, J casts off, and the chart fits 1024x768', async () => {
    await pd.keyboard.press('KeyM');
    assert.equal(await pd.isVisible('#chart'), true);
    const box = await pd.locator('#chart').boundingBox();
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 1024 && box.y + box.height <= 768, JSON.stringify(box));
    const port = await pd.evaluate(() => {
      const r = window.coldManifest.sim.state.run;
      return r.map.nodes.filter((n) => n.kind === 'port' && n.id !== r.at).sort((a, b) => a.x - b.x)[0].id;
    });
    const nodeBox = await pd.locator(`#node-${port}`).boundingBox();
    assert.ok(nodeBox.x >= box.x && nodeBox.x + nodeBox.width <= box.x + box.width, 'point inside the chart');
    // Two points a lane apart can overlap at this size: click a part of ours that nothing covers.
    const spot = await pd.evaluate((id) => {
      const node = document.querySelector(`#node-${id}`);
      const r = node.getBoundingClientRect();
      for (let y = r.top + 4; y < r.bottom; y += 6) for (let x = r.left + 4; x < r.right; x += 6) if (node.contains(document.elementFromPoint(x, y))) return { x, y };
      return null;
    }, port);
    assert.ok(spot, 'some part of the point can be clicked');
    await pd.mouse.click(spot.x, spot.y);
    await pd.click('#btn-route-cheap');
    if (process.env.E2E_SHOTS) await pd.screenshot({ path: `${process.env.E2E_SHOTS}/h6-route-1024.png` });
    await pd.keyboard.press('KeyJ');
    await pd.waitForFunction(() => window.coldManifest.sim.state.run.crossing !== null, null, { timeout: 2000 });
  });
  await check('desktop: no page errors', async () => assert.deepEqual(deskErrors, []));
  await desk.close();
}

/** The whole run loop on screens: title, contract board, chart, ports and events, the drop, the summary, records (S3.2, D-108). */
async function loopTests(browser) {
  console.log('iPad: a run from the contract board to the summary (S3.2)');
  const context = await browser.newContext({ ...devices['iPad (gen 7) landscape'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${PORT}/?seed=E2E-LOOP&watches=0&autopause=0`);
  await page.waitForFunction(() => window.coldManifest?.machine.state === 'title');
  const shots = process.env.E2E_SHOTS;
  const state = () => game(page, () => window.coldManifest.machine.state);
  const shot = async (name) => shots && page.screenshot({ path: `${shots}/${name}.png` });
  const big = async (selector) => {
    const sizes = await page.$$eval(selector, (list) => list.map((b) => ({ id: b.id, w: b.getBoundingClientRect().width, h: b.getBoundingClientRect().height })));
    for (const size of sizes) assert.ok(size.w >= 44 && size.h >= 44, `${size.id} is ${size.w}x${size.h}`);
  };

  await check('the records hub opens from the title with its four panels and nothing in the Wall yet', async () => {
    await page.tap('#btn-hub');
    assert.equal(await state(), 'hub');
    for (const id of ['hub-ship', 'hub-wall', 'hub-unlocks', 'hub-stats']) assert.equal(await page.isVisible(`#${id}`), true, id);
    assert.match(await page.textContent('#hub-wall'), /Nobody has died yet/);
    await shot('s3-2-hub-ipad');
    await big('#screen button');
    await page.tap('#btn-back');
    assert.equal(await state(), 'title');
  });

  await check('New run opens the contract board with three contracts and no run until one is taken', async () => {
    assert.equal(await page.isVisible('#btn-resume'), false, 'nothing to resume yet');
    await page.tap('#btn-new-run');
    assert.equal(await state(), 'contracts');
    assert.equal(await page.locator('.card').count(), 3);
    await shot('s3-2-board-ipad');
    await big('#screen button');
    await page.tap('#accept-courier');
    await page.waitForFunction(() => window.coldManifest.machine.state === 'ship' && window.coldManifest.shipView.debug.chartOpen);
    assert.equal(await game(page, () => window.coldManifest.run.contract.id), 'courier-cold-chain');
  });

  await check('Back to the title and Resume run returns to the same run', async () => {
    const at = await game(page, () => window.coldManifest.sim.seed ?? window.coldManifest.run.seed);
    await page.keyboard.press('Escape'); // closes the chart
    await page.tap('#btn-back');
    assert.equal(await state(), 'title');
    await page.tap('#btn-resume');
    await page.waitForFunction(() => window.coldManifest.machine.state === 'ship');
    assert.equal(await game(page, () => window.coldManifest.run.seed), at);
  });

  /** The cheapest way across, cut into routes that each end at a port, worked out here from the run's chart. */
  const route = async () =>
    game(page, () => {
      const r = window.coldManifest.sim.state.run;
      const best = { [r.at]: { fuel: 0, path: [r.at] } };
      const open = [r.at];
      while (open.length) {
        open.sort((a, b) => best[a].fuel - best[b].fuel);
        const here = open.shift();
        for (const lane of r.map.lanes) {
          const next = lane.a === here ? lane.b : lane.b === here ? lane.a : null;
          if (!next) continue;
          const fuel = best[here].fuel + lane.fuel;
          if (!best[next] || fuel < best[next].fuel) {
            best[next] = { fuel, path: [...best[here].path, next] };
            open.push(next);
          }
        }
      }
      const way = best[r.map.delivery].path;
      const legs = [];
      let from = 0;
      way.forEach((id, i) => {
        if (i > 0 && r.map.nodes.find((n) => n.id === id).kind === 'port') {
          legs.push(way.slice(from, i + 1));
          from = i;
        }
      });
      return legs;
    });
  /**
   * Cast off on a route, skip along each lane (debug), and stop at whatever the crossing brings. Returns 'event' (a
   * decision over the radio), 'situation' (something waiting in a room, H.7), 'port' or 'ship'.
   */
  const flyOn = async () => {
    for (let i = 0; i < 60; i++) {
      const now = await state();
      if (now !== 'ship') return now;
      if ((await situationsWaiting(page)).length) return 'situation';
      const phase = await game(page, () => window.coldManifest.sim.state.run.crossing?.phase ?? null);
      if (phase === 'under way') await game(page, () => !window.coldManifest.sim.whyNot({ type: 'debug.run', skip: true }) && window.coldManifest.sim.enqueue({ type: 'debug.run', skip: true }));
      else if (phase === 'off port') {
        await game(page, () => window.coldManifest.sim.enqueue({ type: 'debug.run', fix: true }));
        await game(page, () => !window.coldManifest.sim.whyNot({ type: 'route.jump' }) && window.coldManifest.sim.enqueue({ type: 'route.jump' }));
      }
      await sleep(150);
    }
    return state();
  };
  let sawPort = false;
  let sawEvent = false;
  let sawSituation = false;
  const metKinds = new Set();
  /** Where an element sits on the screen. */
  const boxOf = (selector) => page.$eval(selector, (node) => (({ x, y, width, height }) => ({ x, y, w: width, h: height }))(node.getBoundingClientRect()));
  /** A room's rectangle on the screen, from the ship view's own fit. */
  const roomOnScreen = (id) =>
    game(page, (rid) => {
      const { sim, shipView } = window.coldManifest;
      const v = shipView.debug.view;
      const room = sim.layout.room(rid);
      return { x: v.ox + room.x * v.scale, y: v.oy + room.y * v.scale, w: room.w * v.scale, h: room.h * v.scale };
    }, id);
  /**
   * The first situation the crossing brings is played on its card, the way a captain would: the chip sits on its
   * room, the card says what is known and offers to send somebody, they walk there, and then it offers its choices.
   */
  const playSituation = async (one) => {
    assert.equal(await game(page, () => window.coldManifest.shipView.debug.chartOpen), false, 'the chart came down for it');
    await page.waitForSelector(`#sit-chip-${one.n}`, { timeout: 2000 });
    const chip = await boxOf(`#sit-chip-${one.n}`);
    const room = await roomOnScreen(one.room);
    assert.ok(chip.h >= 44 && chip.w >= 44, `the chip is ${chip.w}x${chip.h}`);
    assert.ok(chip.x >= room.x - 2 && chip.x <= room.x + room.w && chip.y >= room.y - 2 && chip.y <= room.y + room.h, `the chip (${Math.round(chip.x)}, ${Math.round(chip.y)}) is on its room ${JSON.stringify(room)}`);
    assert.equal(/[{}]/.test(await page.textContent(`#sit-${one.n}`)), false, 'every name on the card is filled in');
    if ((await page.getAttribute(`#sit-${one.n}`, 'data-state')) === 'waiting') {
      if ((await game(page, () => window.coldManifest.shipView.debug.situationOpen)) !== one.n) await page.tap(`#sit-chip-${one.n}`);
      assert.match(await page.textContent(`#sit-${one.n}`), /Nobody is in /);
      assert.equal(await page.locator(`#sit-choices-${one.n}`).count(), 0, 'no choices until somebody is there');
      await shot('h7-situation-waiting-ipad');
      await big(`#sit-${one.n} button`);
      await page.tap(`#sit-send-${one.n}`);
      await page.waitForFunction((n) => document.querySelector(`#sit-${n}`)?.dataset.state === 'attended', one.n, { timeout: 45000 });
    }
    assert.equal(await game(page, () => window.coldManifest.shipView.debug.situationOpen), one.n, 'the card opens when somebody is there');
    assert.match(await page.textContent(`#sit-chip-${one.n}`), / is there/i);
    assert.ok((await page.locator(`#sit-choices-${one.n} .btn`).count()) >= 2);
    assert.equal(/[{}]/.test(await page.textContent(`#sit-${one.n}`)), false, 'every name in the text is filled in');
    await shot('h7-situation-ipad');
    await big(`#sit-${one.n} button`);
    const open = await page.$$eval(`#sit-choices-${one.n} .btn:not([disabled])`, (list, n) => list.map((b) => b.id.replace(`sit-choice-${n}-`, '')), one.n);
    await page.tap(`#sit-choice-${one.n}-${SAFE_CHOICES.find((id) => open.includes(id)) ?? open[0]}`);
    await page.waitForSelector(`#sit-result-${one.n}`, { timeout: 3000 });
    assert.equal(await page.locator(`#sit-choices-${one.n}`).count(), 0, 'the choices are gone once one is made');
    await shot('h7-situation-outcome-ipad');
    await page.tap(`#sit-dismiss-${one.n}`);
    await page.waitForSelector(`#sit-${one.n}`, { state: 'detached', timeout: 3000 });
  };
  await check('every crossing ends in a port that opens its screen; the events on the lanes open theirs and leave for the ship again', async () => {
    const legs = await route();
    for (let leg = 0; leg < legs.length; leg++) {
      const path = legs[leg];
      await game(page, (p) => {
        const { sim } = window.coldManifest;
        sim.enqueue({ type: 'debug.run', fuel: sim.state.run.fuelMax });
        sim.step();
        sim.enqueue({ type: 'route.sail', path: p });
      }, path);
      for (let i = 0; i < 30; i++) {
        const now = await flyOn();
        if (now === 'port') break;
        if (now === 'situation') {
          // Something aboard (H.7): on the ship view, at its room. The first is played on its card; the rest are settled.
          for (const one of await situationsWaiting(page)) {
            const kind = await game(page, (id) => window.coldManifest.sim.state.run.map.nodes.find((n) => n.id === id).kind, one.node);
            metKinds.add(kind);
            assert.ok(await game(page, ([id, k]) => (window.coldManifest.content.get('events', id).at ?? []).includes(k) || id.startsWith('claim') || id === 'derelict.the-log', [one.id, kind]), `${one.id} belongs on the way to a ${kind}`);
            assert.equal(typeof (await game(page, (id) => window.coldManifest.content.get('events', id).place.room, one.id)) !== 'undefined', true, `${one.id} has a room`);
          }
          if (!sawSituation) {
            sawSituation = true;
            await playSituation((await situationsWaiting(page))[0]);
          }
          await settleSituations(page);
          continue;
        }
        assert.equal(now, 'event', 'the screen follows the sim');
        const view = await game(page, () => window.coldManifest.sim.state.run.events.open);
        const kind = await game(page, (id) => window.coldManifest.sim.state.run.map.nodes.find((n) => n.id === id).kind, view.node);
        metKinds.add(kind);
        assert.ok(await game(page, ([id, k]) => (window.coldManifest.content.get('events', id).at ?? []).includes(k), [view.id, kind]), `${view.id} belongs on the way to a ${kind}`);
        assert.equal(await game(page, (id) => window.coldManifest.content.get('events', id).place, view.id), 'radio', 'only a decision over the radio takes the screen');
        assert.ok((await page.locator('#event-choices .btn').count()) >= 2);
        assert.equal(/[{}]/.test(await page.textContent('#event')), false, 'every name in the text is filled in');
        if (!sawEvent) {
          sawEvent = true;
          await shot('s3-3-event-ipad');
          await big('#screen button');
        }
        await answerEvents(page);
        await page.waitForFunction(() => window.coldManifest.machine.state === 'ship');
      }
      assert.equal(await state(), 'port', 'a crossing ends in port');
      if (leg === legs.length - 1) break; // the drop
      if (!sawPort) {
        sawPort = true;
        await game(page, () => window.coldManifest.sim.state.run && window.coldManifest.sim.enqueue({ type: 'debug.run', fuel: 3 }));
        await game(page, () => window.coldManifest.sim.step());
        await page.tap('#btn-bar');
        assert.equal(await state(), 'scene');
        assert.match(await page.textContent('#scene'), /Scenes between crew arrive in Stage 4/);
        await page.tap('#btn-back');
        assert.equal(await state(), 'port');
        assert.match(await page.textContent('#port-facts'), /Fuel\s*3 of 12/);
        assert.match(await page.textContent('#btn-refuel'), /9 units, 108 credits/);
        const money = Number((await page.textContent('#port-facts')).match(/Money\s*(\d+)/)[1]);
        await page.tap('#btn-refuel');
        assert.match(await page.textContent('#port-facts'), /Fuel\s*12 of 12/);
        assert.match(await page.textContent('#port-facts'), new RegExp(`Money\\s*${money - 108}`), 'fuel is paid for');
        assert.match(await page.textContent('#port-facts'), /Contract\s*Courier: 2 of 2 crates aboard/);
        assert.equal(await page.isDisabled('#btn-hire'), true, 'hiring is a stub until Stage 4');
        assert.equal(await page.isDisabled('#btn-refuel'), true, 'full tanks, nothing to buy');
        await shot('s3-2-port-ipad');
        await big('#screen button');
      }
      await page.tap('#btn-depart');
      await page.waitForFunction(() => window.coldManifest.machine.state === 'ship');
      assert.equal(await page.isVisible('#chart'), true, 'back on the ship with the chart up');
    }
  });

  await check('a situation card shows who meets a choice and locks what the crew cannot do; a radio decision still takes the screen', async () => {
    assert.ok(sawSituation, 'the way across met at least one situation aboard');
    await page.tap('#btn-depart');
    await page.waitForFunction(() => window.coldManifest.machine.state === 'ship');
    // A leak in the cargo hold, where nobody is: the card says what is known and offers to send the nearest hand.
    await game(page, () => {
      const { sim, shipView } = window.coldManifest;
      shipView.openChart(false);
      sim.enqueue({ type: 'debug.event', event: 'cargo.leak' });
    });
    await page.waitForSelector('.sitcard[data-event="cargo.leak"]', { timeout: 3000 });
    const leak = Number((await page.getAttribute('.sitcard[data-event="cargo.leak"]', 'id')).replace('sit-', ''));
    assert.equal(await page.getAttribute(`#sit-${leak}`, 'data-state'), 'waiting');
    assert.match(await page.textContent(`#sit-chip-${leak}`), /Nobody there · \d+ h/i);
    assert.equal(await game(page, () => window.coldManifest.shipView.debug.situationOpen), leak, 'a new matter opens its card when nothing else is being read');
    assert.match(await page.textContent(`#sit-sign-${leak}`), /Something is dripping in Cargo hold/);
    assert.match(await game(page, () => window.coldManifest.sim.state.ai.log.at(-1).text), /Something is dripping/, 'Margo says the sign');
    assert.equal(await page.locator(`#sit-choices-${leak}`).count(), 0, 'no choices until somebody is there');
    assert.match(await page.textContent(`#sit-send-${leak}`), /^Send \w+Nearest hand awake$/);
    await shot('h7-situation-waiting-ipad');
    await big(`#sit-${leak} button`);
    // With one of the crew picked, the card sends them instead.
    const pick = await crewTarget(page, 'vesna');
    await page.touchscreen.tap(pick.x, pick.y);
    await page.waitForFunction((n) => /^Send Vesna/.test(document.querySelector(`#sit-send-${n}`)?.textContent ?? ''), leak, { timeout: 2000 });
    await page.tap(`#sit-send-${leak}`);
    await page.waitForFunction((n) => document.querySelector(`#sit-${n}`)?.dataset.state === 'attended', leak, { timeout: 45000 });
    assert.equal(await game(page, () => window.coldManifest.sim.state.crew.vesna.room), 'cargo');
    assert.match(await page.textContent(`#sit-text-${leak}`), /^Vesna follows the drip/);
    assert.match(await page.textContent(`#sit-choice-${leak}-reseal`), /^\[Dace, Engineering\] /);
    await page.tap(`#sit-choice-${leak}-reseal`);
    await page.waitForSelector(`#sit-result-${leak}`, { timeout: 3000 });
    assert.match(await page.textContent(`#sit-chip-${leak}`), /Dealt with/i);
    await page.tap(`#sit-dismiss-${leak}`);
    await page.waitForSelector(`#sit-${leak}`, { state: 'detached', timeout: 3000 });
    await page.touchscreen.tap(pick.x, pick.y).catch(() => {});
    await game(page, () => window.coldManifest.sim.state.run.flags.crate_resealed === true || Promise.reject(new Error('the outcome did not take')));

    // The hazard on the bridge with the sensors dark and Ilse at the helm: one choice is met by her, one is locked.
    await game(page, () => {
      const { sim, shipView } = window.coldManifest;
      shipView.openChart(false);
      if (!sim.state.stations.sensors.down) {
        sim.enqueue({ type: 'station.stand', station: 'sensors', down: true });
        sim.step();
      }
      sim.enqueue({ type: 'debug.event', event: 'hazard.loud-lane' });
    });
    await page.waitForSelector('.sitcard[data-event="hazard.loud-lane"][data-state="attended"]', { timeout: 3000 });
    const n = Number((await page.getAttribute('.sitcard[data-event="hazard.loud-lane"]', 'id')).replace('sit-', ''));
    assert.equal(await page.getAttribute(`#sit-${n}`, 'data-room'), 'bridge');
    assert.match(await page.textContent(`#sit-chip-${n}`), /Ilse is there/i);
    assert.match(await page.textContent(`#sit-choice-${n}-thread`), /^\[Ilse, Piloting\] /);
    assert.equal(await page.isDisabled(`#sit-choice-${n}-thread`), false);
    assert.match(await page.textContent(`#sit-choice-${n}-sweep`), /^\[Needs Sensors running\] /);
    assert.equal(await page.isDisabled(`#sit-choice-${n}-sweep`), true);
    assert.equal(await page.textContent(`#sit-choice-${n}-press-on`), 'Hold the course and take what comes');
    await shot('h7-situation-tags-ipad');
    await page.tap(`#sit-choice-${n}-sweep`, { force: true }); // locked: nothing happens
    assert.equal(await page.locator(`#sit-result-${n}`).count(), 0);
    // The chip folds the card and opens it again.
    await page.tap(`#sit-chip-${n}`);
    assert.equal(await page.locator(`#sit-choices-${n}`).count(), 0, 'folded');
    await page.tap(`#sit-chip-${n}`);
    await page.tap(`#sit-choice-${n}-thread`);
    await page.waitForSelector(`#sit-result-${n}`, { timeout: 3000 });
    assert.match(await page.textContent(`#sit-result-${n}`), /Ilse takes the helm/);
    await page.tap(`#sit-dismiss-${n}`);
    await page.waitForSelector(`#sit-${n}`, { state: 'detached', timeout: 3000 });
    assert.equal(await state(), 'ship', 'none of it left the ship view');

    // A patrol on the radio is a decision on the table: the event view, with the tags, as before.
    const money = await game(page, () => {
      const { sim } = window.coldManifest;
      const had = sim.state.money;
      sim.state.money = 0;
      sim.enqueue({ type: 'debug.event', event: 'checkpoint.patrol-line' });
      return had;
    });
    await page.waitForFunction(() => window.coldManifest.machine.state === 'event', null, { timeout: 3000 });
    sawEvent = true;
    assert.match(await page.textContent('#choice-talk'), /^\[\w+, Negotiation\] /);
    assert.equal(await page.isDisabled('#choice-talk'), false);
    assert.match(await page.textContent('#choice-pay'), /^\[Needs 60 credits\] /);
    assert.equal(await page.isDisabled('#choice-pay'), true);
    assert.equal(await page.textContent('#choice-manifest'), 'Send the manifest and wait');
    await shot('s3-3-event-tags-ipad');
    await big('#event-choices .btn');
    await page.tap('#choice-pay', { force: true }); // locked: nothing happens
    assert.equal(await page.isVisible('#btn-event-continue'), false);
    await page.tap('#choice-manifest');
    assert.match(await page.textContent('#event-result'), /Proceed/);
    assert.equal(await page.locator('#event-choices').count(), 0, 'the choices are gone once one is made');
    await shot('s3-3-event-outcome-ipad');
    await page.tap('#btn-event-continue');
    await page.waitForFunction(() => window.coldManifest.machine.state === 'ship');
    assert.equal(await game(page, () => window.coldManifest.sim.state.run.events.open), null);
    await game(page, (had) => (window.coldManifest.sim.state.money = had), money);
    // Back to the drop's port screen for the hand-over.
    await game(page, () => window.coldManifest.machine.go('port', { node: window.coldManifest.sim.state.run.at }));
  });

  await check('the drop: handing over the cargo ends the run with a summary that adds up', async () => {
    assert.equal(await page.isVisible('#btn-handover'), true);
    assert.equal(await page.isVisible('#btn-retire'), false, 'no retiring at the drop');
    await page.tap('#btn-handover');
    assert.equal(await state(), 'summary');
    const title = await page.textContent('#summary-title');
    assert.match(title, /Delivered/);
    const facts = await page.textContent('#summary-facts');
    assert.match(facts, /Courier/);
    assert.match(facts, /6 of 6 alive/);
    assert.match(facts, /Result\s*Delivered whole/);
    assert.match(facts, /Paid\s*150 advance \+ 450 at the drop/);
    assert.match(facts, /Standing\s*Reach Medical Cooperative \+2/);
    await shot('s3-2-summary-ipad');
    await big('#screen button');
  });

  await check('records remember the run, and Resume is gone once it has ended', async () => {
    await page.tap('#btn-records');
    assert.equal(await state(), 'hub');
    assert.match(await page.textContent('#hub-stats'), /Runs this visit\s*1/);
    assert.match(await page.textContent('#hub-stats'), /Delivered\s*1/);
    await page.tap('#btn-back');
    assert.equal(await page.isVisible('#btn-resume'), false);
  });

  await check('a second run starts fresh from the board; retiring at a port and losing the crew both end it with a summary', async () => {
    await page.tap('#btn-new-run');
    await page.tap('#accept-smuggling');
    await page.waitForFunction(() => window.coldManifest.machine.state === 'ship');
    assert.equal(await game(page, () => window.coldManifest.sim.state.run.legs), 0);
    assert.equal(await game(page, () => window.coldManifest.sim.state.run.pursuit !== null), await game(page, () => window.coldManifest.run.contract.followed), 'followed as the board said');
    assert.equal(await game(page, () => Object.values(window.coldManifest.sim.state.crates).filter((c) => c.contraband).length), 4, 'the contraband is in the hold');
    // Kill everyone on board: the run ends on the next frame.
    await game(page, () => Object.values(window.coldManifest.sim.state.crew).forEach((m) => (m.alive = false)));
    await page.waitForFunction(() => window.coldManifest.machine.state === 'summary', null, { timeout: 2000 });
    assert.match(await page.textContent('#summary-title'), /Everyone is dead/);
    await page.tap('#btn-title');
    await page.tap('#btn-hub');
    assert.match(await page.textContent('#hub-wall'), /Smuggling|Cold freight/);
    await page.tap('#btn-back');
    await page.tap('#btn-new-run');
    await page.tap('#accept-salvage');
    await page.waitForFunction(() => window.coldManifest.machine.state === 'ship');
    // At the origin port nothing opens, so reach the port screen through a debug arrival: retire from there.
    await game(page, () => window.coldManifest.machine.go('port', { node: window.coldManifest.sim.state.run.at }));
    assert.match(await page.textContent('#port-facts'), /Salvage claim: the claim at .* is still to be worked/);
    assert.equal(await page.isDisabled('#btn-sell-contract'), true);
    assert.match(await page.textContent('#btn-sell-contract'), /None of the contract cargo/);
    await page.tap('#btn-abandon');
    assert.match(await page.textContent('#port-facts'), /Salvage claim: failed, we walked away from it/);
    assert.equal(await page.isVisible('#btn-abandon'), false);
    await page.tap('#btn-retire');
    assert.match(await page.textContent('#summary-title'), /Retired/);
    assert.match(await page.textContent('#summary-facts'), /Result\s*Failed: we walked away from it/);
    assert.match(await page.textContent('#summary-facts'), /Standing\s*The Outer Stations Union -2/);
  });

  await check('no page errors', async () => assert.deepEqual(errors, []));
  await context.close();
}

const server = await startServer();
const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
async function scopeTests(browser) {
  console.log('iPad and desktop: the scope, the helm, a flare and a hail (H.1)');
  const errors = [];
  const scope = (page) => game(page, () => JSON.parse(JSON.stringify({ view: window.coldManifest.shipView.debug.scope, helm: window.coldManifest.sim.state.helm, contacts: window.coldManifest.sim.state.scope.contacts.map((c) => ({ id: c.id, state: c.state, tried: c.tried, shown: c.track.shown })), decoys: window.coldManifest.sim.state.scope.decoys.length, record: window.coldManifest.sim.state.scope.record })));
  for (const [name, options, press] of [
    ['iPad', devices['iPad (gen 7) landscape'], (page) => (selector) => page.tap(selector)],
    ['desktop', { viewport: { width: 1366, height: 1024 } }, (page) => (selector) => page.click(selector)],
  ]) {
    const context = await browser.newContext(options);
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    const tapAt = (x, y) => (name === 'iPad' ? page.touchscreen.tap(x, y) : page.mouse.click(x, y));
    await openShip(page, press(page), '&debug=1');

    await check(`${name}: the scope stands in the corner of the monitor, clear of the ship, and a tap on the dial brings her round`, async () => {
      const { view, helm } = await scope(page);
      assert.ok(view.box.w >= 240 && view.box.h >= 200, JSON.stringify(view.box));
      const rooms = (await game(page, () => window.coldManifest.shipView.debug.targets())).filter((t) => t.kind === 'room');
      for (const room of rooms) assert.ok(room.x + room.w <= view.box.x, `${room.id} runs under the scope`);
      assert.equal(view.marks.length, 0);
      assert.equal(helm.heading, 90);
      // Straight down the dial is a heading of 180.
      await tapAt(view.dial.cx, view.dial.cy + view.dial.r / 2);
      await page.waitForFunction(() => window.coldManifest.sim.state.helm.wanted === 180, null, { timeout: 2000 });
      await page.waitForFunction(() => window.coldManifest.sim.state.helm.heading > 100, null, { timeout: 4000 });
      assert.equal(await selected(page), null, 'a tap on the dial selects nothing');
    });

    await check(`${name}: Burn lights the drive and the ship gathers way; pressed again she drifts`, async () => {
      assert.match(await page.textContent('#btn-burn'), /Burn/);
      await press(page)('#btn-burn');
      await page.waitForFunction(() => window.coldManifest.sim.state.helm.burn === true, null, { timeout: 2000 });
      await page.waitForFunction(() => Math.hypot(window.coldManifest.sim.state.helm.vx, window.coldManifest.sim.state.helm.vy) > 0.05, null, { timeout: 5000 });
      assert.match(await page.textContent('#btn-burn'), /Cut drive/);
      await press(page)('#btn-burn');
      await page.waitForFunction(() => window.coldManifest.sim.state.helm.burn === false, null, { timeout: 2000 });
      const before = (await scope(page)).helm;
      await sleep(300);
      const after = (await scope(page)).helm;
      assert.equal(after.vx, before.vx, 'drifting on as she was');
    });

    await check(`${name}: a contact from the debug panel shows on the scope, and tapping it reads it in the panel`, async () => {
      await press(page)('#btn-dbg-menu');
      await press(page)('#btn-dbg-closing-patrol-cutter');
      if (await page.isVisible('#sheet')) await press(page)('#btn-dbg-menu');
      await page.waitForSelector('#sheet', { state: 'hidden', timeout: 2000 });
      await page.waitForFunction(() => window.coldManifest.shipView.debug.scope?.marks.length === 1, null, { timeout: 5000 });
      const { view } = await scope(page);
      const mark = view.marks[0];
      const dx = mark.x - (view.box.x + view.box.w / 2);
      assert.ok(mark.x > view.box.x && mark.x < view.box.x + view.box.w && dx < 0, 'bearing 300 is up and to the left of us');
      await tapAt(mark.x, mark.y);
      assert.deepEqual(await selected(page), { kind: 'contact', id: mark.id });
      await page.waitForFunction(() => /^C\d+ · /.test(document.querySelector('#status-title')?.textContent ?? ''), null, { timeout: 2000 });
      assert.match(await page.textContent('#status'), /Bearing\s*\d{3} ±\d+°/);
      assert.match(await page.textContent('#status'), /Range\s*\d+ km/);
      const size = await page.$eval('#btn-hail-manifest', (b) => ({ w: b.getBoundingClientRect().width, h: b.getBoundingClientRect().height }));
      assert.ok(size.w >= 44 && size.h >= 44, `the hail button is ${size.w}x${size.h}`);
    });

    await check(`${name}: a hail is told once, and a flare goes out astern`, async () => {
      await press(page)('#btn-hail-manifest');
      await page.waitForFunction(() => window.coldManifest.sim.state.scope.record.length + window.coldManifest.sim.state.scope.contacts.filter((c) => c.tried.length).length >= 1, null, { timeout: 3000 });
      const state = await scope(page);
      const worked = state.record.some((entry) => entry.outcome === 'bluff');
      if (!worked) {
        assert.deepEqual(state.contacts[0].tried, ['manifest']);
        assert.equal(await page.isDisabled('#btn-hail-manifest'), true, 'they have heard that one');
        assert.equal(await page.isDisabled('#btn-hail-transponder'), true, 'and have stopped listening');
      }
      // Back to the ship's own panel for the flare (Escape on a keyboard, a tap on open space by hand).
      const { view } = await scope(page);
      await tapAt(view.box.x - 20, view.box.y + view.box.h - 6);
      assert.equal(await selected(page), null);
      assert.match(await page.textContent('#btn-flare'), /Flare \(2\)/);
      await press(page)('#btn-flare');
      await page.waitForFunction(() => window.coldManifest.sim.state.helm.flares === 1 && window.coldManifest.sim.state.scope.decoys.length === 1, null, { timeout: 2000 });
      await page.waitForFunction(() => /Flare \(1\)/.test(document.querySelector('#btn-flare').textContent), null, { timeout: 2000 });
    });

    if (name === 'desktop') {
      await check('desktop: V lights and cuts the drive, X puts out the last flare, and a long look at the scope says what it is', async () => {
        await page.keyboard.press('v');
        await page.waitForFunction(() => window.coldManifest.sim.state.helm.burn === true, null, { timeout: 2000 });
        await page.keyboard.press('v');
        await page.waitForFunction(() => window.coldManifest.sim.state.helm.burn === false, null, { timeout: 2000 });
        await page.keyboard.press('x');
        await page.waitForFunction(() => window.coldManifest.sim.state.helm.flares === 0, null, { timeout: 2000 });
        assert.equal(await page.isDisabled('#btn-flare'), true);
        const { view } = await scope(page);
        await page.mouse.click(view.box.x + 30, view.box.y + view.box.h - 20, { button: 'right' });
        assert.match(await game(page, () => window.coldManifest.shipView.debug.infoText), /The scope\. It only listens/);
      });
    }
    await context.close();
  }
  await check('the scope: no page errors', async () => assert.deepEqual(errors, []));
}

async function boardedTests(browser) {
  console.log('iPad: a boarding party at the lock, hiding a hand and casting them off (H.2)');
  const context = await browser.newContext({ ...devices['iPad (gen 7) landscape'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${PORT}/?seed=E2E-BOARDED&watches=0&autopause=0&debug=1`);
  await page.waitForFunction(() => window.coldManifest?.machine.state === 'title');
  await page.tap('#btn-ship');
  await page.waitForFunction(() => window.coldManifest.machine.state === 'ship');
  const shots = process.env.E2E_SHOTS;
  const boarding = () => game(page, () => JSON.parse(JSON.stringify(window.coldManifest.sim.state.boarding)));
  const party = () => game(page, () => Object.values(window.coldManifest.sim.state.crew).filter((m) => m.party).length);

  await check('debug: a raider skiff docks, and the lock card asks what we do, every button 44px', async () => {
    await page.tap('#btn-dbg-menu');
    await page.tap('#btn-dbg-board-raider-skiff');
    if (await page.isVisible('#sheet')) await page.tap('#btn-dbg-menu');
    await page.waitForSelector('#boardcall', { state: 'visible', timeout: 3000 });
    assert.equal((await boarding()).phase, 'demand');
    assert.match(await page.textContent('#boardcall-text'), /crate|lock/i);
    assert.equal(await page.isVisible('#btn-board-fight'), false, 'nothing to fight until they are aboard');
    for (const id of ['#btn-board-bribe', '#btn-board-yield', '#btn-board-admit']) {
      const box = await page.locator(id).boundingBox();
      assert.ok(box && box.width >= 44 && box.height >= 44, `${id} is ${box && Math.round(box.width)}x${box && Math.round(box.height)}`);
    }
    if (shots) await page.screenshot({ path: `${shots}/h2-lock-ipad.png` });
  });

  await check('a crew member\'s panel has Hide, and the order puts them in a locker or a crawlway where they stand', async () => {
    const id = await game(page, () => {
      const { sim } = window.coldManifest;
      const free = (m) => m.owner === 'player' && m.alive && !m.party && !m.path.length && !m.carry;
      const can = (m) => sim.layout.room(m.room).hide || (m.engineer && sim.layout.crawlExits(m.room).length);
      return Object.values(sim.state.crew).find((m) => free(m) && can(m))?.id;
    });
    assert.ok(id, 'somebody stands where they could hide');
    const t = await game(page, (cid) => window.coldManifest.shipView.debug.targets().find((x) => x.kind === 'crew' && x.id === cid), id);
    await page.touchscreen.tap(t.x + t.w / 2, t.y + t.h / 2);
    await page.waitForSelector('#btn-hide', { state: 'visible', timeout: 2000 });
    await page.tap('#btn-hide');
    await page.waitForFunction((cid) => window.coldManifest.sim.state.crew[cid].hidden, id, { timeout: 3000 });
  });

  await check('Open the lock lets the party aboard, and Cast them off clears them and the card', async () => {
    await page.tap('#btn-board-admit');
    await page.waitForFunction(() => window.coldManifest.sim.state.boarding?.phase === 'aboard', null, { timeout: 3000 });
    assert.equal(await party(), 3);
    if (shots) await page.screenshot({ path: `${shots}/h2-aboard-ipad.png` });
    await page.tap('#btn-dbg-menu');
    await page.tap('#btn-dbg-board-clear');
    if (await page.isVisible('#sheet')) await page.tap('#btn-dbg-menu');
    await page.waitForFunction(() => window.coldManifest.sim.state.boarding === null, null, { timeout: 3000 });
    await page.waitForSelector('#boardcall', { state: 'hidden', timeout: 2000 });
    assert.equal(await party(), 0);
  });

  await context.close();
  await check('boarded: no page errors', async () => assert.deepEqual(errors, []));
}

async function gunTests(browser) {
  console.log('iPad: the deterrent gun, point defence and a toll (H.3)');
  const context = await browser.newContext({ ...devices['iPad (gen 7) landscape'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${PORT}/?seed=E2E-GUNS&watches=0&autopause=0&debug=1`);
  await page.waitForFunction(() => window.coldManifest?.machine.state === 'title');
  await page.tap('#btn-ship');
  await page.waitForFunction(() => window.coldManifest.machine.state === 'ship');
  const shots = process.env.E2E_SHOTS;
  const sim = (fn, arg) => game(page, fn, arg);
  // Lamps off for the bars, then point defence, the gun and the shields; the gun charged and ready.
  await sim(() => {
    const s = window.coldManifest.sim;
    s.enqueue({ type: 'lights.all', on: false });
  });
  await page.waitForFunction(() => Object.values(window.coldManifest.sim.state.rooms).every((r) => !r.lightsOn), null, { timeout: 2000 });
  await sim(() => {
    const s = window.coldManifest.sim;
    s.enqueue({ type: 'station.stand', station: 'weapons', down: false });
    s.enqueue({ type: 'station.stand', station: 'shields', down: false });
  });
  await page.waitForFunction(() => window.coldManifest.sim.state.stations.weapons.down === false, null, { timeout: 2000 });

  await check('the ship panel names both mounts: point defence on watch, the gun not laid', async () => {
    await page.waitForFunction(() => /Point def\.\s*On watch/.test(document.querySelector('#status').textContent), null, { timeout: 4000 }).catch(async () => assert.fail(await page.textContent('#status')));
    assert.match(await page.textContent('#status'), /Gun\s*(Charging|Ready)/);
    assert.match(await page.textContent('#status'), /Hull\s*20 of 20/);
  });

  await check('tap a contact on the scope, Lay the gun: it fires on the contact, never a room, and A holds fire', async () => {
    await sim(() => window.coldManifest.sim.enqueue({ type: 'debug.contact', encounter: 'raider-skiff', state: 'closing', range: 26, bearing: 60 }));
    await page.waitForFunction(() => window.coldManifest.shipView.debug.scope?.marks.length > 0, null, { timeout: 4000 });
    await sim(() => window.coldManifest.sim.enqueue({ type: 'debug.gun', charge: true }));
    const mark = (await sim(() => window.coldManifest.shipView.debug.scope.marks))[0];
    await page.touchscreen.tap(mark.x, mark.y);
    await page.waitForSelector('#btn-gun', { state: 'visible', timeout: 2000 });
    assert.match(await page.textContent('#status'), /Our gun/);
    const fired = page.evaluate(() => new Promise((resolve) => window.coldManifest.sim.events.on('weapon.fired', resolve)));
    await page.tap('#btn-gun');
    const shot = await fired;
    assert.equal(typeof shot.contact, 'number', 'the gun fires on a contact');
    assert.equal(shot.room, undefined, 'and names no room');
    await page.waitForFunction(() => document.querySelector('#btn-gun').textContent === 'Hold fire', null, { timeout: 2000 });
    if (shots) await page.screenshot({ path: `${shots}/h3-gun-ipad.png` });
    await page.keyboard.press('KeyA');
    await page.waitForFunction(() => window.coldManifest.sim.state.weapons[1].target === null, null, { timeout: 2000 });
    await sim(() => window.coldManifest.sim.enqueue({ type: 'debug.contact', clear: true }));
  });

  await check('a drone carrier: its drones show on the scope, and point defence shoots them down', async () => {
    await page.touchscreen.tap(40, 200);
    await sim(() => window.coldManifest.sim.enqueue({ type: 'debug.contact', encounter: 'drone-carrier', state: 'closing', range: 16, bearing: 200 }));
    await page.waitForFunction(() => window.coldManifest.sim.state.scope.drones.length > 0, null, { timeout: 20000 });
    assert.ok((await sim(() => window.coldManifest.sim.state.scope.incoming ?? null)) === null, 'the drones are state, drawn from the scope view');
    const downed = page.evaluate(() => new Promise((resolve) => window.coldManifest.sim.events.on('drone.lost', (e) => e.cause === 'pd' && resolve(e))));
    await downed;
    if (shots) await page.screenshot({ path: `${shots}/h3-drones-ipad.png` });
    await sim(() => window.coldManifest.sim.enqueue({ type: 'debug.contact', clear: true }));
  });

  await check('a bulwark calls its toll: a card says what and how long, and Pay pays it', async () => {
    await sim(() => {
      const s = window.coldManifest.sim;
      s.state.money = 200;
      s.enqueue({ type: 'debug.contact', encounter: 'bulwark', state: 'closing', range: 20, bearing: 300 });
    });
    await page.waitForSelector('#tollcall', { state: 'visible', timeout: 6000 });
    assert.match(await page.textContent('#tollcall'), /toll \d+/);
    assert.match(await page.textContent('#tollcall-clock'), /Its gun clears in \d+s|Outside its zone/);
    if (shots) await page.screenshot({ path: `${shots}/h3-toll-ipad.png` });
    await page.tap('#btn-toll-pay');
    await page.waitForSelector('#tollcall', { state: 'hidden', timeout: 2000 });
    assert.ok((await sim(() => window.coldManifest.sim.state.money)) < 200);
    assert.equal(await sim(() => window.coldManifest.sim.state.scope.record.at(-1).outcome), 'paid');
  });

  await check('every control is at least 44px tall and wide with the gun and toll controls up', async () => {
    const small = await page.$$eval('.ship .btn', (nodes) => nodes.map((n) => ({ id: n.id, r: n.getBoundingClientRect() })).filter((n) => n.r.width > 0 && (n.r.width < 44 || n.r.height < 44)).map((n) => `${n.id} ${Math.round(n.r.width)}x${Math.round(n.r.height)}`));
    assert.deepEqual(small, []);
  });

  await check('no page errors', async () => assert.deepEqual(errors, []));
  await context.close();
}

async function watchTests(browser) {
  console.log('iPad: the watch bill as the game deals it (H.4)');
  const context = await browser.newContext({ ...devices['iPad (gen 7) landscape'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${PORT}/?seed=E2E-WATCH&autopause=0`);
  await page.waitForFunction(() => window.coldManifest?.machine.state === 'title');
  await page.tap('#btn-ship');
  await page.waitForFunction(() => window.coldManifest.machine.state === 'ship');

  await check('a new run keeps two watches: the watch on deck walks to its posts and the watch below turns in', async () => {
    assert.equal(await game(page, () => window.coldManifest.sim.state.roster.watches), 2);
    await page.tap('#btn-breakers');
    assert.match(await page.textContent('#watch-note'), /First watch · \d:\d\d/);
    await page.waitForFunction(() => {
      const s = window.coldManifest.sim.state;
      const crew = Object.values(s.crew).filter((m) => m.owner === 'player');
      return crew.some((m) => m.watch !== s.roster.on && m.asleep) && crew.some((m) => m.watch === s.roster.on && m.post && !m.path.length && m.task === 'idle');
    }, null, { timeout: 45000 });
    await page.waitForFunction(() => /Asleep/.test(document.querySelector('.ship').textContent), null, { timeout: 4000 });
  });

  await check('the watch bill: three watches, all hands, and To stations', async () => {
    await page.tap('#btn-watches-3');
    await page.waitForFunction(() => window.coldManifest.sim.state.roster.watches === 3, null, { timeout: 2000 });
    await page.tap('#btn-watches-1');
    await page.waitForFunction(() => window.coldManifest.sim.state.roster.watches === 1, null, { timeout: 2000 });
    assert.equal(await page.textContent('#watch-note'), 'All hands');
    await page.tap('#btn-muster');
    // Everyone with a post walks to it: the gunner ends up on the guns' station, though they are stood down.
    await page.waitForFunction(() => window.coldManifest.sim.state.crew.pruitt.room === 'weapons' && window.coldManifest.sim.state.crew.halloran.room === 'door_control', null, { timeout: 45000 });
    await page.waitForFunction(() => /Halloran/.test(document.querySelector('#station-doors').textContent), null, { timeout: 4000 });
    if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/h4-switches-ipad.png` });
  });

  await check('the crew panel: Post unfolds the stations, a tap posts them there and they walk to it; Change watch moves them', async () => {
    await page.tap('#btn-watches-2');
    await page.waitForFunction(() => window.coldManifest.sim.state.roster.watches === 2, null, { timeout: 2000 });
    await page.tap('#crew-vesna');
    assert.equal(await page.isVisible('#crew-posts'), false, 'the stations start folded');
    await page.tap('#btn-posts');
    await page.waitForSelector('#btn-post-sensors', { state: 'visible', timeout: 2000 });
    const small = await page.$$eval('#status .btn', (nodes) => nodes.map((n) => ({ id: n.id, r: n.getBoundingClientRect() })).filter((n) => n.r.width > 0 && (n.r.width < 44 || n.r.height < 44)).map((n) => n.id));
    assert.deepEqual(small, []);
    await page.tap('#btn-post-sensors');
    await page.waitForFunction(() => window.coldManifest.sim.state.crew.vesna.post === 'sensors', null, { timeout: 2000 });
    assert.match(await page.textContent('#status'), /Post\s*Sensors/);
    await page.waitForFunction(() => window.coldManifest.sim.state.crew.vesna.room === 'sensors' && !window.coldManifest.sim.state.crew.vesna.path.length, null, { timeout: 45000 });
    await page.waitForFunction(() => /Vesna/.test(document.querySelector('#station-sensors').textContent), null, { timeout: 4000 });
    const was = await game(page, () => window.coldManifest.sim.state.crew.vesna.watch);
    await page.tap('#btn-watch');
    await page.waitForFunction((w) => window.coldManifest.sim.state.crew.vesna.watch !== w, was, { timeout: 2000 });
  });

  await check('no page errors', async () => assert.deepEqual(errors, []));
  await context.close();
}

// E2E_ONLY=boarding (or a comma list of suite names) runs just those suites, for chasing one failure.
const only = process.env.E2E_ONLY?.split(',');
const suites = { touch: touchTests, desktop: desktopTests, voice: voiceTests, hit: hitTests, dark: darkTests, hold: holdTests, guns: gunTests, watch: watchTests, margo: margoTests, chart: chartTests, loop: loopTests, scope: scopeTests, boarded: boardedTests };
try {
  for (const [name, run] of Object.entries(suites)) if (!only || only.includes(name)) await run(browser);
} finally {
  await browser.close();
  server.kill();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} of ${results.length} browser checks passed.`);
process.exit(failed ? 1 : 0);
