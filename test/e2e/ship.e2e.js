#!/usr/bin/env node
// Browser tests for the ship view, the clock, pause, the AI's voice, sound, fights and the input layer, on an emulated iPad
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
const URL = `http://localhost:${PORT}/?seed=E2E-TEST&autopause=0`;

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

/** Choices that cannot start a fight or kill anyone, in the order to prefer them, for flying through events (S3.3). */
const SAFE_CHOICES = ['leave', 'pass', 'note', 'thread', 'sweep', 'manifest', 'rest', 'keep', 'press-on'];
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
const tick = (page) => game(page, () => window.coldManifest.sim.state.tick);
const door = (page, id) => game(page, (did) => ({ ...window.coldManifest.sim.state.doors[did] }), id);
const room = (page, id) => game(page, (rid) => ({ ...window.coldManifest.sim.state.rooms[rid] }), id);
const counts = (page) => game(page, () => ({ ...window.coldManifest.shipView.debug.counts }));
const selected = (page) => game(page, () => window.coldManifest.shipView.debug.selected);
const queued = (page) => game(page, () => window.coldManifest.sim.state.commands.length);
const power = (page, id) => game(page, (sid) => window.coldManifest.sim.state.systems[sid].power, id);
const powerIs = (page, id, bars) => page.waitForFunction(([sid, n]) => window.coldManifest.sim.state.systems[sid].power === n, [id, bars], { timeout: 2000 });
const selectedCrew = (page) => game(page, () => window.coldManifest.shipView.debug.selectedCrew);
const crewTarget = async (page, id) => {
  const t = await game(page, (cid) => window.coldManifest.shipView.debug.targets().find((x) => x.kind === 'crew' && x.id === cid), id);
  assert.ok(t, `no crew target ${id}`);
  return t;
};
const paused = (page) => game(page, () => window.coldManifest.clock.paused);
/** The debug "Perfect lock": every room of theirs made out, and no shot goes wide for want of a lock. */
const scan = async (page) => {
  await game(page, () => window.coldManifest.sim.enqueue({ type: 'debug.combat', action: 'scan' }));
  await page.waitForFunction(() => window.coldManifest.sim.state.contact?.pinned, null, { timeout: 2000 });
};
const infoText = (page) => game(page, () => window.coldManifest.shipView.debug.infoText);
const doorIs = (page, id, state, openness) =>
  page.waitForFunction(([did, st, op]) => {
    const d = window.coldManifest.sim.state.doors[did];
    return d.state === st && d.openness === op;
  }, [id, state, openness], { timeout: 3000 });

/** A hit target's box and centre in page pixels. */
async function target(page, id) {
  const t = await game(page, (tid) => window.coldManifest.shipView.debug.targets().find((x) => x.id === tid), id);
  assert.ok(t, `no target ${id}`);
  return { ...t, mx: t.x + t.w / 2, my: t.y + t.h / 2 };
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

  await check('the breaker board starts folded to a strip of lamps, and Breakers opens it (S2.9)', async () => {
    assert.equal(await page.isVisible('#breaker-board'), false);
    assert.equal(await page.isVisible('#breakers-folded'), true);
    assert.equal(await page.locator('#power-mini-engines .pip--on').count(), 1);
    await page.tap('#btn-breakers');
    await page.waitForSelector('#breaker-board', { state: 'visible', timeout: 2000 });
    assert.equal(await page.isVisible('#breakers-folded'), false);
    assert.match(await page.textContent('#power-life_support'), /Life support/, 'each breaker names its system');
    if (process.env.E2E_SHOTS) await page.screenshot({ path: `${process.env.E2E_SHOTS}/s2-9-breakers-ipad.png` });
  });

  await check('power: minus frees a bar, plus spends it, and the panel keeps count', async () => {
    assert.match(await page.textContent('#power-summary'), /0 of 8 spare/);
    assert.equal(await page.isDisabled('#btn-power-shields-plus'), true, 'nothing spare, so plus is off');
    await page.tap('#btn-power-sensors-minus');
    await powerIs(page, 'sensors', 0);
    await page.waitForFunction(() => document.querySelector('#power-summary').textContent.startsWith('1 of 8'));
    assert.equal(await page.isDisabled('#btn-power-sensors-minus'), true);
    await page.tap('#btn-power-shields-plus');
    await powerIs(page, 'shields', 1);
    assert.equal(await page.locator('#power-shields .pip--on').count(), 1);
    assert.equal(await page.locator('#power-shields .pip--off').count(), 1);
    await page.tap('#btn-power-shields-minus');
    await powerIs(page, 'shields', 0);
    await page.tap('#btn-power-sensors-plus');
    await powerIs(page, 'sensors', 1);
  });

  await check('power: routing while paused waits for resume', async () => {
    await page.tap('#btn-pause');
    await page.tap('#btn-power-engines-minus');
    await sleep(200);
    assert.equal(await power(page, 'engines'), 1);
    assert.equal(await queued(page), 1);
    await page.tap('#btn-pause');
    await powerIs(page, 'engines', 0);
    await page.tap('#btn-power-engines-plus');
    await powerIs(page, 'engines', 1);
  });

  await check('doors: with door control unpowered a tap does nothing and the panel says why', async () => {
    await page.tap('#btn-power-doors-minus');
    await powerIs(page, 'doors', 0);
    const before = await door(page, 'd_ai_core');
    const t = await target(page, 'd_ai_core');
    await page.touchscreen.tap(t.mx, t.my);
    await sleep(300);
    assert.deepEqual(await door(page, 'd_ai_core'), before);
    assert.match(await page.textContent('#status'), /by hand/);
    await page.tap('#btn-power-doors-plus');
    await powerIs(page, 'doors', 1);
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
    // Buttons that are not on screen (the weapons bar outside a fight) have no size to check.
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

  await check('power keys: a Q-row key adds a bar, Shift with it takes one back, with the board folded', async () => {
    assert.equal(await page.isVisible('#breaker-board'), false);
    await page.keyboard.press('Shift+KeyY');
    await powerIs(page, 'sensors', 0);
    await page.keyboard.press('KeyQ');
    await powerIs(page, 'shields', 1);
    await page.keyboard.press('KeyQ');
    await sleep(200);
    assert.equal(await power(page, 'shields'), 1, 'no spare power, so the second press is refused');
    await page.keyboard.press('Shift+KeyQ');
    await powerIs(page, 'shields', 0);
    await page.keyboard.press('KeyY');
    await powerIs(page, 'sensors', 1);
  });

  await check('debug: reactor damage browns the ship out and the panel shows it', async () => {
    const t = await target(page, 'reactor');
    await page.mouse.click(t.mx, t.my);
    await page.click('#btn-dbg-damage');
    await powerIs(page, 'sensors', 0);
    await page.waitForFunction(() => /of 7 spare/.test(document.querySelector('#power-summary').textContent));
    assert.equal(await page.locator('.power__pips--reactor .pip--broken').count(), 1);
    assert.match(await page.textContent('#status'), /Output\s*7 of 8 bars/);
    await page.click('#btn-dbg-repair');
    await page.waitForFunction(() => /of 8 spare/.test(document.querySelector('#power-summary').textContent));
    assert.equal(await power(page, 'sensors'), 0, 'power does not come back by itself');
    await page.keyboard.press('KeyP');
    await page.waitForSelector('#breaker-board', { state: 'visible', timeout: 2000 });
    await page.click('#btn-power-sensors-plus');
    await powerIs(page, 'sensors', 1);
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

  await check('debug: a jammed door refuses the panel and taps', async () => {
    const t = await target(page, 'd_shields');
    await page.mouse.click(t.mx, t.my);
    await doorIs(page, 'd_shields', 'open', 1);
    await page.click('#btn-dbg-jam');
    await doorIs(page, 'd_shields', 'jammed', 1);
    for (const id of ['#btn-door-open', '#btn-door-close', '#btn-door-lock']) assert.equal(await page.isDisabled(id), true);
    await page.mouse.click(t.mx, t.my);
    await sleep(250);
    assert.deepEqual(await door(page, 'd_shields'), { state: 'jammed', openness: 1 });
    assert.match(await page.textContent('#status'), /Jammed/);
  });

  await check('a click that slides off a button does not press it', async () => {
    const box = await page.locator('#btn-dbg-jam').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y - 160, { steps: 5 });
    await page.mouse.up();
    await sleep(200);
    assert.equal((await door(page, 'd_shields')).state, 'jammed');
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
  await page.goto(`http://localhost:${PORT}/?seed=E2E-VOICE`);
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
    assert.deepEqual(saved.autoPause, { fight: true, boarded: true, fire: false, breach: true, death: true, objection: true, refusal: true });
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
    assert.deepEqual(await game(page, () => window.coldManifest.settings.values.autoPause), { fight: true, boarded: true, fire: false, breach: true, death: true, objection: true, refusal: true });
  });

  await check('no page errors', async () => assert.deepEqual(errors, []));
  await context.close();
}

async function fightTests(browser) {
  console.log('iPad: a fight with the gunnery drone');
  const context = await browser.newContext({ ...devices['iPad (gen 7) landscape'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${PORT}/?seed=E2E-FIGHT&autopause=0&debug=1`);
  await page.waitForFunction(() => window.coldManifest?.machine.state === 'title');
  await page.tap('#btn-ship');
  await page.waitForFunction(() => window.coldManifest.machine.state === 'ship');
  const fight = () => game(page, () => window.coldManifest.sim.state.fight);
  const weapon = (slot) => game(page, (i) => ({ ...window.coldManifest.sim.state.weapons[i] }), slot);
  const foeRoom = async (id) => {
    // The ships are refitted when a panel changes height; let that frame pass before reading where things are.
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    const t = await game(page, (rid) => window.coldManifest.shipView.debug.foeTargets().find((x) => x.id === rid), id);
    assert.ok(t, `no enemy room ${id}`);
    return t;
  };
  const tapFoe = async (id) => {
    const t = await foeRoom(id);
    await page.touchscreen.tap(t.x + t.w / 2, t.y + t.h / 2);
  };

  await check('no fight: no weapons bar, and the ship has the whole width', async () => {
    assert.equal(await page.isHidden('#fightbar'), true);
    assert.deepEqual(await game(page, () => window.coldManifest.shipView.debug.foeTargets()), []);
  });

  let widthBefore = 0;
  await check('debug Fight brings the drone alongside: weapons bar, their ship on the right, ours still between the bars', async () => {
    widthBefore = await game(page, () => window.coldManifest.shipView.debug.view.scale);
    await page.tap('#btn-dbg-fight');
    await page.waitForFunction(() => window.coldManifest.sim.state.fight, null, { timeout: 2000 });
    await page.waitForFunction(() => window.coldManifest.shipView.debug.foeTargets().length === 5, null, { timeout: 2000 });
    // The scan has its own checks below (darkTests); here a perfect lock keeps these about the controls.
    await scan(page);
    assert.equal(await page.isVisible('#fightbar'), true);
    assert.equal(await page.isVisible('#breaker-board'), true, 'a fight opens the breaker board');
    assert.match(await page.textContent('#fight-foe'), /Gunnery drone\s*8\/8/);
    assert.match(await page.textContent('#fight-own'), /20\/20/);
    const own = await game(page, () => window.coldManifest.shipView.debug.targets().filter((x) => x.kind === 'room'));
    const theirs = await game(page, () => window.coldManifest.shipView.debug.foeTargets());
    const top = await page.locator('.shipbar').boundingBox();
    const dock = (await page.locator('#aibox').boundingBox()).y;
    for (const t of [...own, ...theirs]) assert.ok(t.y >= top.y + top.height && t.y + t.h <= dock, `${t.id} runs under a bar`);
    const ourRight = Math.max(...own.map((t) => t.x + t.w));
    const theirLeft = Math.min(...theirs.map((t) => t.x));
    assert.ok(theirLeft > ourRight, 'the two ships do not overlap');
    for (const t of theirs) assert.ok(t.w >= 44 && t.h >= 30, `enemy room ${t.id} is ${Math.round(t.w)}x${Math.round(t.h)}: too small to tap`);
  });

  await check('a weapon with no power says so, and says what it needs', async () => {
    assert.match(await page.textContent('#weapon-0'), /No power: needs 1/);
    assert.match(await page.textContent('#weapon-1'), /No power: needs 2/);
  });

  await check('routing a bar to weapons starts the laser charging, paused or not', async () => {
    await page.tap('#btn-power-sensors-minus');
    await powerIs(page, 'sensors', 0);
    await page.tap('#btn-power-weapons-plus');
    await powerIs(page, 'weapons', 1);
    await page.waitForFunction(() => window.coldManifest.sim.state.weapons[0].charge > 0, null, { timeout: 2000 });
    assert.match(await page.textContent('#weapon-0'), /Charging · no target/);
    assert.equal((await weapon(1)).powered, false);
  });

  await check('tap a weapon, then a room on their ship: the order waits out a pause, then the weapon is aimed', async () => {
    await page.tap('#btn-pause');
    assert.equal(await paused(page), true);
    await page.tap('#weapon-0');
    assert.equal(await game(page, () => window.coldManifest.shipView.debug.selectedWeapon), 0);
    assert.equal(await page.textContent('#status-title'), 'Pulse laser');
    await tapFoe('shields');
    assert.equal((await weapon(0)).target, null, 'nothing changes while paused');
    assert.equal(await queued(page), 1);
    await page.tap('#btn-pause');
    await page.waitForFunction(() => window.coldManifest.sim.state.weapons[0].target === 'shields', null, { timeout: 2000 });
    assert.match(await page.textContent('#weapon-0'), /Shields/);
    assert.equal(await game(page, () => window.coldManifest.shipView.debug.selectedWeapon), 0, 'the weapon stays selected, to change its mind');
  });

  await check('tapping one of our own rooms lets go of the weapon and does not aim at it', async () => {
    const own = await game(page, () => window.coldManifest.shipView.debug.targets().find((x) => x.id === 'cargo'));
    await page.touchscreen.tap(own.x + own.w / 2, own.y + own.h / 2);
    assert.equal(await game(page, () => window.coldManifest.shipView.debug.selectedWeapon), null);
    assert.deepEqual(await selected(page), { kind: 'room', id: 'cargo' });
    assert.equal((await weapon(0)).target, 'shields');
  });

  await check('tapping their room with no weapon picked shows that room', async () => {
    await tapFoe('reactor');
    assert.deepEqual(await selected(page), { kind: 'foe', id: 'reactor' });
    assert.equal(await page.textContent('#status-title'), 'Reactor');
    assert.match(await page.textContent('#status'), /Gunnery drone/);
    assert.equal(await game(page, () => window.coldManifest.sim.state.weapons.some((w) => w.target === 'reactor')), false);
  });

  await check('long-press on their ship says what the room is', async () => {
    const t = await foeRoom('engines');
    await page.touchscreen.tap(t.x + t.w / 2, t.y + t.h / 2); // warm up the pointer
    const cdp = await context.newCDPSession(page);
    const point = { x: t.x + t.w / 2, y: t.y + t.h / 2 };
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await sleep(700);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    assert.match(await infoText(page), /Gunnery drone: Engines/);
  });

  await check('the laser fires by itself when charged, and lands or is stopped by the drone\'s brace', async () => {
    const result = await page.evaluate(() => new Promise((resolve) => window.coldManifest.sim.events.on('shot.resolved', resolve)));
    assert.equal(result.weapon, 'pulse-laser');
    assert.equal(result.room, 'shields');
    assert.ok(['shield', 'miss', 'hit'].includes(result.result), `first shot: ${result.result}`);
    assert.equal((await fight()).enemy.hull.points, result.result === 'hit' ? 7 : 8);
    assert.ok((await game(page, () => window.coldManifest.audio.stats.played.shot ?? 0)) > 0, 'the shot was heard');
  });

  await check('Hold fire clears the target; a hit on a bare hull ends the fight; Leave it sends the wreck away', async () => {
    await page.tap('#weapon-0');
    await page.tap('#btn-clear-target');
    await page.waitForFunction(() => window.coldManifest.sim.state.weapons[0].target === null, null, { timeout: 2000 });
    assert.equal(await page.isHidden('#btn-fight-leave'), true);
    // Leave the drone one hull point, no shield and no engines, so the next shot is the last.
    await game(page, () => {
      const enemy = window.coldManifest.sim.state.fight.enemy;
      enemy.hull.points = 1;
      enemy.systems.shields.power = 0;
      enemy.systems.engines.power = 0;
      enemy.shield.charge = 0;
    });
    await tapFoe('core');
    await page.waitForFunction(() => window.coldManifest.sim.state.fight.over, null, { timeout: 12000 });
    assert.equal((await fight()).over.outcome, 'destroyed');
    await page.waitForFunction(() => /Destroyed/.test(document.querySelector('#fight-foe').textContent), null, { timeout: 2000 });
    assert.equal((await weapon(0)).target, null);
    await page.tap('#btn-fight-leave');
    await page.waitForFunction(() => window.coldManifest.sim.state.fight === null, null, { timeout: 2000 });
    await page.waitForFunction(() => document.querySelector('#fightbar').hidden, null, { timeout: 2000 });
    assert.equal(await game(page, () => window.coldManifest.shipView.debug.selectedWeapon), null);
    await page.waitForFunction((scale) => window.coldManifest.shipView.debug.view.scale === scale, widthBefore, { timeout: 2000 });
  });

  await check('every control is at least 44px tall and wide in a fight', async () => {
    await page.tap('#btn-dbg-fight');
    await page.waitForFunction(() => window.coldManifest.sim.state.fight, null, { timeout: 2000 });
    await page.waitForFunction(() => !document.querySelector('#fightbar').hidden);
    const small = await page.$$eval('.ship .btn', (nodes) => nodes.map((n) => ({ id: n.id, r: n.getBoundingClientRect() })).filter((n) => n.r.width > 0 && (n.r.width < 44 || n.r.height < 44)).map((n) => `${n.id} ${Math.round(n.r.width)}x${Math.round(n.r.height)}`));
    assert.deepEqual(small, []);
  });

  await check('no page errors', async () => assert.deepEqual(errors, []));
  await context.close();

  console.log('Desktop: weapon keys');
  const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const pc = await desktop.newPage();
  const pcErrors = [];
  pc.on('pageerror', (e) => pcErrors.push(e.message));
  await pc.goto(`http://localhost:${PORT}/?seed=E2E-FIGHT-PC&autopause=0`);
  await pc.waitForFunction(() => window.coldManifest?.machine.state === 'title');
  await pc.click('#btn-ship');
  await pc.waitForFunction(() => window.coldManifest.machine.state === 'ship');

  await check('weapon keys: A picks weapon 1, a click on their room aims it, Escape lets go', async () => {
    await pc.keyboard.press('KeyA');
    assert.equal(await game(pc, () => window.coldManifest.shipView.debug.selectedWeapon), null, 'no fight, nothing to aim');
    await game(pc, () => window.coldManifest.sim.enqueue({ type: 'debug.fight', enemy: 'target-drone' }));
    await pc.waitForFunction(() => window.coldManifest.shipView.debug.foeTargets().length === 5, null, { timeout: 2000 });
    await scan(pc);
    await pc.keyboard.press('KeyS');
    assert.equal(await game(pc, () => window.coldManifest.shipView.debug.selectedWeapon), 1);
    await pc.keyboard.press('KeyA');
    assert.equal(await game(pc, () => window.coldManifest.shipView.debug.selectedWeapon), 0);
    const t = await game(pc, () => window.coldManifest.shipView.debug.foeTargets().find((x) => x.id === 'weapons'));
    await pc.mouse.click(t.x + t.w / 2, t.y + t.h / 2);
    await pc.waitForFunction(() => window.coldManifest.sim.state.weapons[0].target === 'weapons', null, { timeout: 2000 });
    await pc.keyboard.press('Escape');
    assert.equal(await game(pc, () => window.coldManifest.shipView.debug.selectedWeapon), null);
    assert.equal(await game(pc, () => window.coldManifest.machine.state), 'ship', 'Escape let go of the weapon; it did not leave the screen');
  });
  await check('no page errors on desktop', async () => assert.deepEqual(pcErrors, []));
  await desktop.close();
}

async function hitTests(browser) {
  console.log('iPad: hits and what they do');
  const context = await browser.newContext({ ...devices['iPad (gen 7) landscape'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // No ?autopause: a touch device pauses by itself when a fight starts.
  await page.goto(`http://localhost:${PORT}/?seed=E2E-HITS&debug=1`);
  await page.waitForFunction(() => window.coldManifest?.machine.state === 'title');
  await page.tap('#btn-ship');
  await page.waitForFunction(() => window.coldManifest.machine.state === 'ship');
  const resume = async () => {
    if (await paused(page)) await page.tap('#btn-pause');
    await page.waitForFunction(() => !window.coldManifest.clock.paused, null, { timeout: 2000 });
  };

  await check('auto-pause: a fight starting stops the clock and the pause button names the ship', async () => {
    await resume();
    await page.tap('#btn-dbg-fight');
    await page.waitForFunction(() => window.coldManifest.clock.paused, null, { timeout: 2000 });
    assert.equal(await page.textContent('#pause-note'), 'Gunnery drone alongside');
    assert.ok(await game(page, () => window.coldManifest.sim.state.fight));
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
    await page.waitForFunction(() => /18\/20/.test(document.querySelector('#fight-own').textContent), null, { timeout: 2000 });
    assert.ok(await game(page, () => window.coldManifest.shipView.debug.shake), 'the screen shook');
    assert.ok(await game(page, () => window.coldManifest.shipView.debug.impacts.some((i) => i.result === 'hit' && i.side === 'enemy')), 'the hit is drawn on our ship');
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
    assert.equal(await page.getAttribute('#set-pause-fight', 'aria-pressed'), 'true');
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

async function endingTests(browser) {
  console.log('iPad: hails, surrenders, jumps and every ending');
  const context = await browser.newContext({ ...devices['iPad (gen 7) landscape'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${PORT}/?seed=E2E-ENDINGS&autopause=0&debug=1`);
  await page.waitForFunction(() => window.coldManifest?.machine.state === 'title');
  await page.tap('#btn-ship');
  await page.waitForFunction(() => window.coldManifest.machine.state === 'ship');
  const shots = process.env.E2E_SHOTS;
  const outcome = () => game(page, () => window.coldManifest.sim.state.fight?.over?.outcome ?? null);
  const outcomeIs = (want) => page.waitForFunction((w) => window.coldManifest.sim.state.fight?.over?.outcome === w, want, { timeout: 4000 });
  /** Open the debug sheet and start a fight with the skiff, ending any decided one first. */
  const startSkiff = async () => {
    if (await game(page, () => window.coldManifest.sim.state.fight?.over)) {
      await page.tap('#btn-fight-leave');
      await page.waitForFunction(() => window.coldManifest.sim.state.fight === null, null, { timeout: 2000 });
    }
    await page.tap('#btn-dbg-menu');
    await page.tap('#btn-dbg-fight-salvager-skiff');
    await page.waitForFunction(() => window.coldManifest.sim.state.fight?.enemy.ship === 'salvager-skiff' && !window.coldManifest.sim.state.fight.over, null, { timeout: 2000 });
    assert.equal(await game(page, () => window.coldManifest.shipView.debug.sheet), null, 'the sheet closes after a press');
  };
  const debugEnd = async (action) => {
    await page.tap('#btn-dbg-menu');
    await page.tap(`#btn-dbg-end-${action}`);
  };

  await check('a hail: the card says what they want, with Talk, Pay and Open fire, and our guns hold', async () => {
    await startSkiff();
    await page.waitForSelector('#fightcall:not([hidden])', { timeout: 2000 });
    assert.match(await page.textContent('#fightcall-title'), /Salvager skiff hails us/);
    assert.match(await page.textContent('#btn-talk'), /Talk · 35%/);
    assert.match(await page.textContent('#btn-bribe'), /Pay 80 · have 120/);
    assert.equal(await page.isVisible('#btn-engage'), true);
    assert.equal(await page.isVisible('#btn-accept'), false);
    if (shots) await page.screenshot({ path: `${shots}/s2-3-hail-ipad.png` });
  });

  await check('every control is at least 44px tall and wide with the hail card up', async () => {
    const small = await page.$$eval('.ship .btn', (nodes) => nodes.map((n) => ({ id: n.id, r: n.getBoundingClientRect() })).filter((n) => n.r.width > 0 && (n.r.width < 44 || n.r.height < 44)).map((n) => `${n.id} ${Math.round(n.r.width)}x${Math.round(n.r.height)}`));
    assert.deepEqual(small, []);
  });

  await check('Pay: the money goes, the fight ends, and the bar says how', async () => {
    await page.tap('#btn-bribe');
    await outcomeIs('bribed');
    assert.equal(await game(page, () => window.coldManifest.sim.state.money), 40);
    await page.waitForFunction(() => /Paid off/.test(document.querySelector('#fight-foe').textContent), null, { timeout: 2000 });
    assert.equal(await page.isHidden('#fightcall'), true);
    assert.equal(await page.isVisible('#btn-fight-leave'), true);
  });

  await check('Talk: either they let us go, or the shooting starts and Talk is gone', async () => {
    await startSkiff();
    await page.waitForSelector('#btn-talk:not([hidden])', { timeout: 2000 });
    await page.tap('#btn-talk');
    await page.waitForFunction(() => window.coldManifest.sim.state.fight.over || window.coldManifest.sim.state.fight.phase === 'battle', null, { timeout: 2000 });
    if ((await outcome()) === 'talked') assert.match(await page.textContent('#fight-foe'), /Talked down/);
    else assert.equal(await page.isHidden('#fightcall'), true, 'no card once the shooting starts');
  });

  await check('a surrender: the card shows their terms; Accept takes them and ends it', async () => {
    await startSkiff();
    await page.tap('#btn-engage');
    await debugEnd('surrender');
    await page.waitForSelector('#btn-accept:not([hidden])', { timeout: 2000 });
    assert.match(await page.textContent('#fightcall-title'), /surrenders/);
    assert.match(await page.textContent('#fightcall-text'), /They offer/);
    if (shots) await page.screenshot({ path: `${shots}/s2-3-surrender-ipad.png` });
    await page.tap('#btn-accept');
    await outcomeIs('surrendered');
  });

  await check('our jump: the button fills, and once ready a tap jumps us out', async () => {
    await startSkiff();
    await page.tap('#btn-engage');
    assert.match(await page.textContent('#jump-note'), /%/);
    await debugEnd('chargeJump');
    await page.waitForFunction(() => document.querySelector('#jump-note').textContent === 'Ready', null, { timeout: 2000 });
    await page.tap('#btn-jump');
    await outcomeIs('escaped');
    assert.match(await page.textContent('#fight-foe'), /We jumped away/);
  });

  for (const [action, want, label] of [['flee', 'fled', /They jumped away/], ['stalemate', 'stalemate', /Broke off/], ['killCrew', 'crew-dead', /Their crew is dead/]]) {
    await check(`debug ${action}: the fight ends as "${want}"`, async () => {
      await startSkiff();
      await debugEnd(action);
      await outcomeIs(want);
      await page.waitForFunction((re) => new RegExp(re).test(document.querySelector('#fight-foe').textContent), label.source, { timeout: 2000 });
    });
  }

  await check('debug cripple then a hit destroys them; sink us then a hit loses the ship', async () => {
    await startSkiff();
    await debugEnd('cripple');
    await game(page, () => window.coldManifest.sim.enqueue({ type: 'debug.hit', at: 'them', room: 'reactor', weapon: 'pulse-laser', force: true }));
    await outcomeIs('destroyed');
    await startSkiff();
    await debugEnd('sinkUs');
    await page.tap('#btn-dbg-hit');
    await outcomeIs('lost');
  });

  await check('no page errors', async () => assert.deepEqual(errors, []));
  await context.close();
}

async function boardingTests(browser) {
  console.log('iPad: boarding');
  const context = await browser.newContext({ ...devices['iPad (gen 7) landscape'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${PORT}/?seed=E2E-BOARD&autopause=0&debug=1`);
  await page.waitForFunction(() => window.coldManifest?.machine.state === 'title');
  await page.tap('#btn-ship');
  await page.waitForFunction(() => window.coldManifest.machine.state === 'ship');
  const shots = process.env.E2E_SHOTS;
  const frame = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
  const aboardThem = (id) => game(page, (cid) => Boolean(window.coldManifest.sim.state.fight?.enemy.crew[cid]), id);
  const tapFoe = async (id) => {
    await frame();
    const t = await game(page, (rid) => window.coldManifest.shipView.debug.foeTargets().find((x) => x.kind === 'foe' && x.id === rid), id);
    assert.ok(t, `no enemy room ${id}`);
    await page.touchscreen.tap(t.x + t.w / 2, t.y + t.h / 2);
  };
  const tapOurs = async (id) => {
    await frame();
    const t = await target(page, id);
    await page.touchscreen.tap(t.x + t.w / 2, t.y + t.h / 2);
  };

  await check('with their shields up, a boarding order is refused and the panel says why', async () => {
    await page.tap('#btn-dbg-menu');
    await page.tap('#btn-dbg-fight-salvager-skiff');
    await page.waitForSelector('#btn-engage:not([hidden])', { timeout: 2000 });
    await page.tap('#btn-engage');
    await page.tap('#crew-okoro');
    await tapFoe('bridge');
    await page.waitForFunction(() => /shields are up/.test(document.querySelector('.status__note')?.textContent ?? ''), null, { timeout: 2000 });
    assert.match(await page.textContent('#crew-hint'), /a room of theirs to board/);
  });

  await check('their shields down: tap one of ours, then a room of theirs, and they cross over', async () => {
    // Hits on their shield room break its bar.
    for (let i = 0; i < 2; i++) await game(page, () => window.coldManifest.sim.enqueue({ type: 'debug.hit', at: 'them', room: 'shields', weapon: 'pulse-laser', force: true }));
    await page.waitForFunction(() => window.coldManifest.sim.state.fight.enemy.shield.charge < 1 && window.coldManifest.sim.state.fight.enemy.systems.shields.damage >= window.coldManifest.sim.state.fight.enemy.systems.shields.level, null, { timeout: 3000 });
    await tapFoe('bridge');
    await page.waitForFunction(() => window.coldManifest.sim.state.crew.okoro?.board?.room === 'bridge' || window.coldManifest.sim.state.crew.okoro?.task === 'crossing', null, { timeout: 2000 });
    await page.waitForFunction(() => /In the tube/.test(document.querySelector('#crew-okoro').textContent), null, { timeout: 8000 });
    await page.waitForFunction(() => Boolean(window.coldManifest.sim.state.fight.enemy.crew.okoro), null, { timeout: 12000 });
    await page.waitForFunction(() => /Aboard/.test(document.querySelector('#crew-okoro').textContent), null, { timeout: 2000 });
    assert.equal(await game(page, () => document.querySelector('#crew-okoro').classList.contains('is-away')), true);
    await frame();
    const onTheirs = await game(page, () => window.coldManifest.shipView.debug.foeTargets().filter((x) => x.kind === 'crew').map((x) => x.id));
    assert.deepEqual(onTheirs, ['okoro'], 'drawn, and tappable, on their ship');
    assert.match(await page.textContent('.status__stats'), /Their /);
    if (shots) await page.screenshot({ path: `${shots}/s2-4-aboard-ipad.png` });
  });

  await check('aboard them, a tap on a room of ours brings them home', async () => {
    await tapOurs('medbay');
    await page.waitForFunction(() => window.coldManifest.sim.state.crew.okoro?.room === 'medbay', null, { timeout: 25000 });
    assert.equal(await aboardThem('okoro'), false);
    assert.equal(await game(page, () => document.querySelector('#crew-okoro').classList.contains('is-away')), false);
  });

  await check('they board us: red boarders appear in our ship, and only ours can be tapped', async () => {
    await page.tap('#btn-dbg-menu');
    await page.tap('#btn-dbg-end-boardUs');
    // (Their captain may have sent a party of its own already: our shields start unpowered.)
    await page.waitForFunction(() => Object.values(window.coldManifest.sim.state.crew).some((m) => m.owner === 'enemy' && m.alive), null, { timeout: 4000 }).catch(async (err) => {
      const why = await game(page, () => ({ status: document.querySelector('#status')?.textContent, them: Object.values(window.coldManifest.sim.state.fight?.enemy.crew ?? {}).map((m) => `${m.id}:${m.room}:${m.task}:${m.alive}`) }));
      throw new Error(`${err.message}\n${JSON.stringify(why)}`);
    });
    const tappable = await game(page, () => window.coldManifest.shipView.debug.targets().filter((x) => x.kind === 'crew').map((x) => x.id).sort());
    assert.deepEqual(tappable, ['dace', 'ilse', 'okoro']);
    assert.equal(await page.$$eval('.crewchip:not(.weapon)', (nodes) => nodes.length), 3, 'no chips for their crew');
    if (shots) {
      await page.waitForTimeout(1500);
      await page.screenshot({ path: `${shots}/s2-4-boarders-ipad.png` });
    }
  });

  await check('every control is at least 44px tall and wide in a boarding fight', async () => {
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
  await page.goto(`http://localhost:${PORT}/?seed=E2E-DARK&autopause=0&debug=1`);
  await page.waitForFunction(() => window.coldManifest?.machine.state === 'title');
  await page.tap('#btn-ship');
  await page.waitForFunction(() => window.coldManifest.machine.state === 'ship');
  const shots = process.env.E2E_SHOTS;
  const seen = (id) => game(page, (rid) => ({ ...window.coldManifest.sim.state.seen[rid] }), id);
  const contact = () => game(page, () => JSON.parse(JSON.stringify(window.coldManifest.sim.state.contact)));
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
    for (let i = await power(page, 'sensors'); i > 0; i--) await page.tap('#btn-power-sensors-minus');
    await powerIs(page, 'sensors', 0);
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
    await page.tap('#btn-power-sensors-plus');
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

  await check('a fight: their ship starts as an unresolved return, with both locks on the fight bar', async () => {
    await page.tap('#btn-pause');
    await page.tap('#btn-dbg-fight');
    await page.tap('#btn-pause');
    await page.waitForFunction(() => window.coldManifest.sim.state.fight, null, { timeout: 2000 });
    await page.tap('#btn-pause');
    assert.equal(await paused(page), true);
    await page.waitForFunction(() => window.coldManifest.shipView.debug.foeTargets().length === 5, null, { timeout: 2000 });
    const c = await contact();
    assert.ok(Object.values(c.rooms).some((r) => r.resolve < 1), 'not everything is made out at once');
    const unresolved = Object.entries(c.rooms).find(([, r]) => r.resolve < 1)[0];
    // The ships are refitted when the fight bar appears; let that frame pass before reading where things are.
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
    const t = await game(page, (rid) => window.coldManifest.shipView.debug.foeTargets().find((x) => x.id === rid), unresolved);
    await page.touchscreen.tap(t.x + t.w / 2, t.y + t.h / 2);
    assert.deepEqual(await selected(page), { kind: 'foe', id: unresolved });
    assert.equal(await page.textContent('#status-title'), 'Unresolved return');
    assert.match(await page.textContent('#status'), /Resolving: \d+%/);
    assert.match(await page.textContent('#fight-own'), /Signature \d+%/);
    assert.match(await page.textContent('#fight-foe-lock'), /lock/i);
    assert.match(await page.textContent('#fight-own-lock'), /lock/i);
    if (shots) await page.screenshot({ path: `${shots}/s2-7-unresolved-ipad.png` });
  });

  await check('the scan resolves their rooms one by one, and then a weapon can be aimed', async () => {
    await page.tap('#btn-pause');
    await page.waitForFunction(() => Object.values(window.coldManifest.sim.state.contact.rooms).every((r) => r.resolve >= 1), null, { timeout: 20000 });
    await page.waitForFunction(() => document.querySelector('#status-title').textContent !== 'Unresolved return', null, { timeout: 2000 });
    assert.equal((await contact()).locked, true);
    await page.tap('#weapon-0');
    const t = await game(page, () => window.coldManifest.shipView.debug.foeTargets().find((x) => x.id === 'shields'));
    await page.touchscreen.tap(t.x + t.w / 2, t.y + t.h / 2);
    await page.waitForFunction(() => window.coldManifest.sim.state.weapons[0].target === 'shields', null, { timeout: 2000 });
    if (shots) await page.screenshot({ path: `${shots}/s2-7-resolved-ipad.png` });
  });

  await check('the Jump button counts the sensor fix, and says so when the sensors are off', async () => {
    assert.match(await page.textContent('#jump-note'), /Fix \d+%|Ready|No pilot|No drive/);
    for (let i = await power(page, 'sensors'); i > 0; i--) await page.tap('#btn-power-sensors-minus');
    await powerIs(page, 'sensors', 0);
    await page.waitForFunction(() => /No sensors|No pilot|No drive/.test(document.querySelector('#jump-note').textContent), null, { timeout: 2000 });
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
  await page.goto(`http://localhost:${PORT}/?seed=E2E-HOLD&autopause=0&debug=1`);
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

  await check('a fight: the Brace button counts the capacitor, and B braces', async () => {
    await page.tap('#btn-dbg-fight');
    await page.waitForFunction(() => window.coldManifest.sim.state.fight, null, { timeout: 2000 });
    await scan(page);
    await page.waitForSelector('#btn-brace', { state: 'visible', timeout: 2000 });
    assert.equal(await page.textContent('#brace-note'), 'No power');
    await page.tap('#btn-power-doors-minus');
    await powerIs(page, 'doors', 0);
    await page.tap('#btn-power-shields-plus');
    await powerIs(page, 'shields', 1);
    await page.waitForFunction(() => /^\d+%$/.test(document.querySelector('#brace-note').textContent), null, { timeout: 2000 });
    await page.waitForFunction(() => window.coldManifest.sim.state.shield.charge >= 1, null, { timeout: 12000 });
    assert.match(await page.textContent('#fight-own'), /Capacitor 100%/);
    await page.tap('#btn-brace');
    await page.waitForFunction(() => window.coldManifest.sim.state.shield.field > 0, null, { timeout: 2000 });
    await page.waitForFunction(() => /Braced/.test(document.querySelector('#fight-own').textContent), null, { timeout: 2000 });
    assert.match(await page.textContent('#brace-note'), /Up \d+s/);
    if (shots) await page.screenshot({ path: `${shots}/s2-8-brace-ipad.png` });
  });

  await check('the slug thrower shows its rounds; empty, Fetch rounds sends someone to the hold and back', async () => {
    await game(page, () => (window.coldManifest.sim.state.weapons[1].rounds = 0));
    await page.tap('#weapon-1');
    assert.equal(await page.textContent('#status-title'), 'Slug thrower');
    await page.waitForFunction(() => /0 of 3 · 16 in the hold/.test(document.querySelector('#status').textContent), null, { timeout: 2000 }).catch(async () => assert.fail(await page.textContent('#status')));
    await page.tap('#btn-fetch-rounds');
    await page.waitForFunction(() => Object.values(window.coldManifest.sim.state.crew).some((m) => m.job?.kind === 'load'), null, { timeout: 2000 });
    await page.waitForFunction(() => /fetching rounds|lifting|carrying rounds/i.test(document.querySelector('#status').textContent), null, { timeout: 8000 });
    await page.waitForFunction(() => window.coldManifest.sim.state.weapons[1].rounds === 3, null, { timeout: 90000 });
    await page.waitForFunction(() => /3 of 3/.test(document.querySelector('#status').textContent), null, { timeout: 2000 });
  });

  await check('every control is at least 44px tall and wide with a crate or a heavy gun picked', async () => {
    const small = await page.$$eval('.ship .btn', (nodes) => nodes.map((n) => ({ id: n.id, r: n.getBoundingClientRect() })).filter((n) => n.r.width > 0 && (n.r.width < 44 || n.r.height < 44)).map((n) => `${n.id} ${Math.round(n.r.width)}x${Math.round(n.r.height)}`));
    assert.deepEqual(small, []);
  });

  await check('no page errors', async () => assert.deepEqual(errors, []));
  await context.close();
}

async function enemyTests(browser) {
  console.log('iPad: four new enemy types, and a carrier\'s drones (S2.5)');
  const context = await browser.newContext({ ...devices['iPad (gen 7) landscape'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${PORT}/?seed=E2E-ENEMIES&autopause=0&debug=1`);
  await page.waitForFunction(() => window.coldManifest?.machine.state === 'title');
  await page.tap('#btn-ship');
  await page.waitForFunction(() => window.coldManifest.machine.state === 'ship');
  const shots = process.env.E2E_SHOTS;

  await check('the debug sheet can start a fight with every enemy, each button big enough to tap', async () => {
    await page.tap('#btn-dbg-menu');
    const ids = await game(page, () => window.coldManifest.sim.catalog.enemies);
    for (const id of ['knife-cutter', 'grapple-tender', 'bulwark', 'drone-carrier']) assert.ok(ids.includes(id), `no ${id}`);
    for (const id of ids) {
      const box = await page.locator(`#btn-dbg-fight-${id}`).boundingBox();
      assert.ok(box && box.width >= 44 && box.height >= 44, `${id} button ${JSON.stringify(box)}`);
    }
  });

  await check('the drone carrier launches drones, and the fight bar counts them', async () => {
    await page.tap('#btn-dbg-fight-drone-carrier');
    await page.waitForFunction(() => window.coldManifest.sim.state.fight?.enemy.ship === 'drone-carrier', null, { timeout: 2000 });
    await scan(page);
    await page.waitForFunction(() => /\d drones? out/.test(document.querySelector('#fight-foe').textContent), null, { timeout: 15000 });
    if (shots) await page.screenshot({ path: `${shots}/s2-5-carrier-ipad.png` });
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
  await page.goto(`http://localhost:${PORT}/?seed=E2E-MARGO&autopause=0&debug=1`);
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
  await paged.goto(`http://localhost:${PORT}/?seed=E2E-MARGO-PAUSE&sound=0`);
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
  console.log('iPad and desktop: Margo\'s route chart, a course, the fix and the jump (S3.1)');
  const context = await browser.newContext({ ...devices['iPad (gen 7) landscape'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${PORT}/?seed=E2E-CHART&autopause=0&debug=1`);
  await page.waitForFunction(() => window.coldManifest?.machine.state === 'title');
  const shots = process.env.E2E_SHOTS;
  const run = () => game(page, () => JSON.parse(JSON.stringify(window.coldManifest.sim.state.run)));
  const nextFrom = (r) => r.map.lanes.filter((l) => l.a === r.at || l.b === r.at).map((l) => (l.a === r.at ? l.b : l.a));

  await check('New run puts the chart up on the monitor, with every point a big enough target and the ship still running under it', async () => {
    await page.tap('#btn-new-run');
    await page.tap('#accept-courier');
    await page.waitForFunction(() => window.coldManifest.machine.state === 'ship' && window.coldManifest.shipView.debug.chartOpen);
    assert.equal(await page.isVisible('#chart'), true);
    const r = await run();
    assert.ok(r.map.nodes.length >= 15 && r.map.nodes.length <= 25);
    assert.equal(await page.locator('.chartnode').count(), r.map.nodes.length);
    const sizes = await page.$$eval('.chartnode', (list) => list.map((b) => ({ id: b.id, w: b.getBoundingClientRect().width, h: b.getBoundingClientRect().height })));
    for (const size of sizes) assert.ok(size.w >= 44 && size.h >= 44, `${size.id} is ${size.w}x${size.h}`);
    assert.match(await page.textContent('#chart-fuel'), /Fuel 10\/12/);
    assert.match(await page.textContent('#btn-chart-jump'), /Plot a course/);
    assert.equal(await page.isDisabled('#btn-chart-jump'), true);
    const t0 = await tick(page);
    await page.waitForFunction((t) => window.coldManifest.sim.state.tick > t + 5, t0);
    assert.equal(await page.textContent('#chart').then((text) => text.includes('null')), false);
  });

  await check('tap a point a lane away, plot the course, watch the fix build, and jump: fuel and the jump count move', async () => {
    const r = await run();
    const to = nextFrom(r)[0];
    await page.tap(`#node-${to}`);
    assert.equal(await game(page, () => window.coldManifest.shipView.debug.chartSelected), to);
    await page.tap('#btn-plot');
    await page.waitForFunction((id) => window.coldManifest.sim.state.run.plot === id, to);
    await page.waitForFunction(() => /Fix \d+%/.test(document.querySelector('#chart-jump-note').textContent), null, { timeout: 2000 });
    if (shots) await page.screenshot({ path: `${shots}/s3-1-chart-ipad.png` });
    await game(page, () => window.coldManifest.sim.enqueue({ type: 'debug.run', fix: true }));
    await page.waitForFunction(() => !document.querySelector('#btn-chart-jump').disabled, null, { timeout: 3000 });
    const lane = r.map.lanes.find((l) => (l.a === r.at && l.b === to) || (l.b === r.at && l.a === to));
    await page.tap('#btn-chart-jump');
    await page.waitForFunction((id) => window.coldManifest.sim.state.run.at === id, to, { timeout: 2000 });
    // On a contract the arrival may open a port or an event (S3.2): leave it, and the chart is back up.
    await sleep(300);
    if ((await game(page, () => window.coldManifest.machine.state)) !== 'ship') {
      if ((await game(page, () => window.coldManifest.machine.state)) === 'event') await answerEvents(page);
      else await page.tap('#btn-depart');
      await page.waitForFunction(() => window.coldManifest.machine.state === 'ship');
    }
    const after = await run();
    assert.equal(after.fuel, r.fuel - lane.fuel);
    assert.equal(after.jumps, 1);
    assert.match(await page.textContent('#chart-jumps'), /Jump 1/);
    assert.equal(await page.isVisible(`#node-${to} .chartnode__tag`), true, 'Here moved');
  });

  await check('a point with no lane from here cannot be plotted, and says why', async () => {
    const r = await run();
    const near = new Set(nextFrom(r));
    const far = r.map.nodes.find((n) => n.id !== r.at && !near.has(n.id));
    await page.tap(`#node-${far.id}`);
    assert.equal(await page.isDisabled('#btn-plot'), true);
    assert.match(await page.textContent('#btn-plot'), /no lane runs there/);
  });

  await check('the pursuer shows on the chart where Margo saw it, and catching up starts a fight', async () => {
    await page.tap('#btn-dbg-menu');
    await page.tap('#btn-dbg-caught');
    await page.waitForFunction(() => window.coldManifest.sim.state.fight?.pursuer === true, null, { timeout: 2000 });
    if (await page.isVisible('#sheet')) await page.tap('#btn-dbg-menu');
    await page.waitForSelector('#sheet', { state: 'hidden', timeout: 2000 });
    if (!(await game(page, () => window.coldManifest.shipView.debug.chartOpen))) await page.tap('#btn-chart');
    await page.waitForSelector('#chart-contact', { timeout: 2000 });
    assert.match(await page.textContent('#chart-contact'), /Contact|Last seen/);
    assert.match(await page.textContent('#btn-chart-jump'), /Escape|Fix|No/);
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

  // Desktop at 1024x768: M for the chart, J to jump.
  const desk = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const pd = await desk.newPage();
  const deskErrors = [];
  pd.on('pageerror', (e) => deskErrors.push(e.message));
  await pd.goto(`http://localhost:${PORT}/?seed=E2E-CHART-DESK&autopause=0`);
  await pd.waitForFunction(() => window.coldManifest?.machine.state === 'title');
  await pd.click('#btn-ship');
  await pd.waitForFunction(() => window.coldManifest.machine.state === 'ship');
  await check('desktop: M opens the chart, a click plots, J jumps once the fix is in, and the chart fits 1024x768', async () => {
    await pd.keyboard.press('KeyM');
    assert.equal(await pd.isVisible('#chart'), true);
    const box = await pd.locator('#chart').boundingBox();
    assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= 1024 && box.y + box.height <= 768, JSON.stringify(box));
    const r = await game(pd, () => JSON.parse(JSON.stringify(window.coldManifest.sim.state.run)));
    const to = r.map.lanes.filter((l) => l.a === r.at || l.b === r.at).map((l) => (l.a === r.at ? l.b : l.a))[0];
    const nodeBox = await pd.locator(`#node-${to}`).boundingBox();
    assert.ok(nodeBox.x >= box.x && nodeBox.x + nodeBox.width <= box.x + box.width, 'point inside the chart');
    await pd.click(`#node-${to}`);
    await pd.click('#btn-plot');
    await game(pd, () => window.coldManifest.sim.enqueue({ type: 'debug.run', fix: true }));
    await pd.waitForFunction(() => !document.querySelector('#btn-chart-jump').disabled, null, { timeout: 3000 });
    if (process.env.E2E_SHOTS) await pd.screenshot({ path: `${process.env.E2E_SHOTS}/s3-1-chart-1024.png` });
    await pd.keyboard.press('KeyJ');
    await pd.waitForFunction((id) => window.coldManifest.sim.state.run.at === id, to, { timeout: 2000 });
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
  await page.goto(`http://localhost:${PORT}/?seed=E2E-LOOP&autopause=0`);
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

  /** Fly one lane: plot, fix, jump. Leaves the screen the arrival opened. */
  const fly = async (to) => {
    await game(page, (id) => window.coldManifest.sim.enqueue({ type: 'course.plot', to: id }), to);
    await game(page, () => window.coldManifest.sim.enqueue({ type: 'debug.run', fix: true }));
    await page.waitForFunction(() => window.coldManifest.sim.state.fix >= 1, null, { timeout: 4000 });
    await game(page, () => window.coldManifest.sim.enqueue({ type: 'course.jump' }));
    await page.waitForFunction((id) => window.coldManifest.sim.state.run.at === id, to, { timeout: 4000 });
    await sleep(200);
  };
  /** The cheapest way across, as a list of points, worked out here from the run's chart. */
  const route = async () =>
    game(page, () => {
      const r = window.coldManifest.sim.state.run;
      const best = { [r.at]: { fuel: 0, path: [] } };
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
      return best[r.map.delivery].path;
    });

  let sawPort = false;
  let sawEvent = false;
  const metKinds = new Set();
  await check('every arrival opens its screen and leaves for the ship again: events, ports with refuel and the bar, open space quiet', async () => {
    const path = await route();
    for (let i = 0; i < path.length; i++) {
      const to = path[i];
      const last = i === path.length - 1;
      await fly(to);
      const kind = await game(page, (id) => window.coldManifest.sim.state.run.map.nodes.find((n) => n.id === id).kind, to);
      const now = await state();
      if (last) {
        assert.equal(now, 'port', 'the drop is a port');
        break;
      }
      if (kind === 'port') {
        assert.equal(now, 'port');
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
      } else {
        // Hazards, derelicts and checkpoints always bring an event from content (S3.3); open space sometimes does.
        // (A kind of point whose events have all been met this run is quiet too, until S3.5 writes more.)
        const open = await game(page, () => Boolean(window.coldManifest.sim.state.run.events.open));
        assert.equal(now, open ? 'event' : 'ship', `at a ${kind}: the screen follows the sim`);
        if (['hazard', 'derelict', 'checkpoint'].includes(kind) && !metKinds.has(kind)) assert.equal(now, 'event', `the first ${kind} opens an event`);
        metKinds.add(kind);
        if (now === 'event') {
          const view = await game(page, () => window.coldManifest.sim.state.run.events.open.id);
          assert.ok(await game(page, ([id, k]) => window.coldManifest.content.get('events', id).at.includes(k), [view, kind]), `${view} belongs at a ${kind}`);
          assert.ok((await page.locator('#event-choices .btn').count()) >= 2);
          assert.equal(/[{}]/.test(await page.textContent('#event')), false, 'every name in the text is filled in');
          if (!sawEvent) {
            sawEvent = true;
            await shot('s3-3-event-ipad');
            await big('#screen button');
          }
          await answerEvents(page);
        }
      }
      await page.waitForFunction(() => window.coldManifest.machine.state === 'ship');
      assert.equal(await page.isVisible('#chart'), true, 'back on the ship with the chart up');
    }
  });

  await check('an event shows who meets a choice, locks what the crew cannot do, tells the outcome and goes back to the ship', async () => {
    assert.ok(sawEvent, 'the way across met at least one event');
    await page.tap('#btn-depart');
    await page.waitForFunction(() => window.coldManifest.machine.state === 'ship');
    // Put the hazard event on the table with the sensors dark: one choice is met by Ilse, one is locked.
    await game(page, () => {
      const { sim } = window.coldManifest;
      while (sim.state.systems.sensors.power > 0) {
        sim.enqueue({ type: 'power.add', system: 'sensors', delta: -1 });
        sim.step();
      }
      sim.enqueue({ type: 'debug.event', event: 'hazard.loud-lane' });
    });
    await page.waitForFunction(() => window.coldManifest.machine.state === 'event', null, { timeout: 3000 });
    assert.match(await page.textContent('#choice-thread'), /^\[Ilse, Piloting\] /);
    assert.equal(await page.isDisabled('#choice-thread'), false);
    assert.match(await page.textContent('#choice-sweep'), /^\[Needs Sensors powered\] /);
    assert.equal(await page.isDisabled('#choice-sweep'), true);
    assert.equal(await page.textContent('#choice-press-on'), 'Hold the course and take what comes');
    await shot('s3-3-event-tags-ipad');
    await big('#event-choices .btn');
    await page.tap('#choice-sweep', { force: true }); // locked: nothing happens
    assert.equal(await page.isVisible('#btn-event-continue'), false);
    await page.tap('#choice-thread');
    assert.match(await page.textContent('#event-result'), /Ilse takes the helm/);
    assert.equal(await page.locator('#event-choices').count(), 0, 'the choices are gone once one is made');
    await shot('s3-3-event-outcome-ipad');
    await page.tap('#btn-event-continue');
    await page.waitForFunction(() => window.coldManifest.machine.state === 'ship');
    assert.equal(await game(page, () => window.coldManifest.sim.state.run.events.open), null);
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
    assert.match(facts, /3 of 3 alive/);
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
    assert.equal(await game(page, () => window.coldManifest.sim.state.run.jumps), 0);
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
// E2E_ONLY=boarding (or a comma list of suite names) runs just those suites, for chasing one failure.
const only = process.env.E2E_ONLY?.split(',');
const suites = { touch: touchTests, desktop: desktopTests, voice: voiceTests, fight: fightTests, hit: hitTests, ending: endingTests, boarding: boardingTests, dark: darkTests, hold: holdTests, enemies: enemyTests, margo: margoTests, chart: chartTests, loop: loopTests };
try {
  for (const [name, run] of Object.entries(suites)) if (!only || only.includes(name)) await run(browser);
} finally {
  await browser.close();
  server.kill();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} of ${results.length} browser checks passed.`);
process.exit(failed ? 1 : 0);
