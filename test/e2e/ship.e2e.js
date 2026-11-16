#!/usr/bin/env node
// Browser tests for the ship view, the clock, pause and the input layer, on an emulated iPad
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
const URL = `http://localhost:${PORT}/?seed=E2E-TEST`;

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

const game = (page, fn, arg) => page.evaluate(fn, arg);
const tick = (page) => game(page, () => window.coldManifest.sim.state.tick);
const door = (page, id) => game(page, (did) => ({ ...window.coldManifest.sim.state.doors[did] }), id);
const room = (page, id) => game(page, (rid) => ({ ...window.coldManifest.sim.state.rooms[rid] }), id);
const counts = (page) => game(page, () => ({ ...window.coldManifest.shipView.debug.counts }));
const selected = (page) => game(page, () => window.coldManifest.shipView.debug.selected);
const queued = (page) => game(page, () => window.coldManifest.sim.state.commands.length);
const power = (page, id) => game(page, (sid) => window.coldManifest.sim.state.systems[sid].power, id);
const powerIs = (page, id, bars) => page.waitForFunction(([sid, n]) => window.coldManifest.sim.state.systems[sid].power === n, [id, bars], { timeout: 2000 });
const paused = (page) => game(page, () => window.coldManifest.clock.paused);
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
    for (const t of all) {
      assert.ok(t.x >= 0 && t.x + t.w <= 1080, `${t.id} is off the side`);
      assert.ok(t.y >= top && t.y + t.h <= dock, `${t.id} runs under a bar`);
    }
    assert.equal(all.filter((t) => t.kind === 'room').length, 15);
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
    for (const s of sizes) assert.ok(s.w >= 44 && s.h >= 44, `${s.id} is ${Math.round(s.w)}x${Math.round(s.h)}`);
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

  await check('power keys: a Q-row key adds a bar, Shift with it takes one back', async () => {
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
    await page.click('#btn-power-sensors-plus');
    await powerIs(page, 'sensors', 1);
  });

  await check('debug: fire, breach and thin air show in the status panel', async () => {
    const t = await target(page, 'reactor');
    await page.mouse.click(t.mx, t.my);
    await page.click('#btn-dbg-fire');
    await page.click('#btn-dbg-breach');
    await page.click('#btn-dbg-air');
    await page.waitForFunction(() => window.coldManifest.sim.state.rooms.reactor.oxygen < 0.3, null, { timeout: 2000 });
    const r = await room(page, 'reactor');
    assert.ok(r.fire >= 0.7 && r.fire < 0.8, `the fire is live and growing from 70%, got ${r.fire}`);
    assert.equal(r.breach, 0.6);
    assert.ok(r.oxygen < 0.3, `the breach and the fire keep the air thin, got ${r.oxygen}`);
    const text = await page.textContent('#status');
    assert.match(text, /Fire\s*7\d%/);
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

const server = await startServer();
const browser = await chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
try {
  await touchTests(browser);
  await desktopTests(browser);
} finally {
  await browser.close();
  server.kill();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed} of ${results.length} browser checks passed.`);
process.exit(failed ? 1 : 0);
