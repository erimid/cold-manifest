#!/usr/bin/env node
// Browser tests for the clock, pause and the input layer, on an emulated iPad
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
const probe = (page, id) => game(page, (pid) => ({ ...window.coldManifest.sim.state.probes.find((p) => p.id === pid) }), id);
const counts = (page) => game(page, () => ({ ...window.coldManifest.testBay.debug.counts }));
const selected = (page) => game(page, () => window.coldManifest.testBay.debug.selected);
const queued = (page) => game(page, () => window.coldManifest.sim.state.commands.length);
const paused = (page) => game(page, () => window.coldManifest.clock.paused);

/** A hit target's box and centre in page pixels. */
async function target(page, id) {
  const t = await game(page, (tid) => window.coldManifest.testBay.debug.targets().find((x) => x.id === tid), id);
  assert.ok(t, `no target ${id}`);
  if (t.r !== undefined) return { ...t, mx: t.cx, my: t.cy };
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

async function openBay(page, press) {
  await page.goto(URL);
  await page.waitForFunction(() => window.coldManifest?.machine.state === 'title');
  await press('#btn-test-bay');
  await page.waitForFunction(() => window.coldManifest.machine.state === 'testbay');
  await sleep(100);
}

// ---------- the tests ----------

async function touchTests(browser) {
  console.log('iPad, landscape, touch');
  const context = await browser.newContext({ ...devices['iPad (gen 7) landscape'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openBay(page, (sel) => page.tap(sel));

  await check('the clock runs on a live screen', async () => {
    const a = await tick(page);
    await sleep(400);
    const b = await tick(page);
    assert.ok(b - a >= 5 && b - a <= 11, `expected about 8 ticks in 0.4s, got ${b - a}`);
  });

  await check('tap selects a probe, tap on a pad sends it there', async () => {
    const p1 = await target(page, 'probe-1');
    await page.touchscreen.tap(p1.mx, p1.my);
    assert.equal(await selected(page), 'probe-1');
    const pad = await target(page, 'pad-A');
    await page.touchscreen.tap(pad.mx, pad.my);
    await page.waitForFunction(() => {
      const p = window.coldManifest.sim.state.probes[0];
      return !p.moving && p.x === 135 && p.y === 98;
    }, null, { timeout: 5000 });
  });

  await check('a touch just outside a small target still hits it', async () => {
    const latch = await target(page, 'latch');
    const before = await probe(page, 'probe-1');
    await page.touchscreen.tap(latch.x + latch.w + 10, latch.my); // 10px past its right edge
    await page.waitForFunction(() => window.coldManifest.sim.state.probes[0].moving === false && window.coldManifest.sim.state.probes[0].x === 333, null, { timeout: 5000 });
    const after = await probe(page, 'probe-1');
    assert.notDeepEqual([before.x, before.y], [after.x, after.y]);
    assert.deepEqual([after.x, after.y], [333, 243], 'probe should be at the latch centre, not at the tap point');
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

    const pad = await target(page, 'pad-C');
    await page.touchscreen.tap(pad.mx, pad.my);
    assert.equal(await queued(page), 1, 'order should be waiting in the queue');
    await sleep(300);
    const waiting = await probe(page, 'probe-1');
    assert.equal(waiting.moving, false, 'probe started moving while paused');
    assert.equal(await tick(page), t0);

    await page.tap('#btn-pause');
    assert.equal(await paused(page), false);
    await page.waitForFunction(() => window.coldManifest.sim.state.probes[0].moving, null, { timeout: 2000 });
    assert.equal(await queued(page), 0);
  });

  await check('a tap on a panel never reaches the canvas under it', async () => {
    const pad = await target(page, 'pad-E'); // its centre is under the panel
    const before = await counts(page);
    const p1 = await probe(page, 'probe-1');
    await page.touchscreen.tap(pad.mx, pad.my - 40); // the panel's background, not a control
    await page.tap('#btn-ping');
    await sleep(100);
    const after = await counts(page);
    assert.equal(after.bayTaps, before.bayTaps, 'the bay saw a tap that landed on the panel');
    assert.equal(after.panelPresses, before.panelPresses + 1);
    const p1After = await probe(page, 'probe-1');
    assert.deepEqual([p1After.tx, p1After.ty], [p1.tx, p1.ty], 'probe was re-ordered by a tap on the panel');
  });

  await check('long-press shows info and is not a tap', async () => {
    const p2 = await target(page, 'probe-2');
    const before = await counts(page);
    const sel = await selected(page);
    await touch(page, [{ x: p2.mx, y: p2.my }], { holdMs: 650 });
    await sleep(50);
    const after = await counts(page);
    assert.equal(after.infos, before.infos + 1);
    assert.equal(after.bayTaps, before.bayTaps, 'long-press also counted as a tap');
    assert.equal(await selected(page), sel, 'long-press changed the selection');
    assert.match(await game(page, () => window.coldManifest.testBay.debug.infoText), /^probe 2: idle/);
  });

  await check('a drag moves a probe and is not a tap', async () => {
    const p3 = await target(page, 'probe-3');
    const pad = await target(page, 'pad-D');
    const before = await counts(page);
    const steps = Array.from({ length: 12 }, (_, i) => ({
      x: p3.mx + ((pad.mx - p3.mx) * (i + 1)) / 12,
      y: p3.my + ((pad.my - p3.my) * (i + 1)) / 12,
    }));
    await touch(page, [{ x: p3.mx, y: p3.my }, ...steps]);
    const after = await counts(page);
    assert.equal(after.drags, before.drags + 1);
    assert.equal(after.bayTaps, before.bayTaps, 'drag also counted as a tap');
    await page.waitForFunction(() => {
      const p = window.coldManifest.sim.state.probes[2];
      return !p.moving && p.x === 515 && p.y === 508;
    }, null, { timeout: 6000 });
  });

  await check('every control is at least 44px tall and wide', async () => {
    const sizes = await page.$$eval('button', (list) => list.map((b) => ({ id: b.id, w: b.getBoundingClientRect().width, h: b.getBoundingClientRect().height })));
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
  await openBay(page, (sel) => page.click(sel));

  await check('space pauses and resumes', async () => {
    await page.keyboard.press('Space');
    assert.equal(await paused(page), true);
    await page.keyboard.press('Space');
    assert.equal(await paused(page), false);
  });

  await check('space still pauses when a button has focus, and does not press it', async () => {
    await page.focus('#btn-ping');
    const before = await counts(page);
    await page.keyboard.press('Space');
    assert.equal(await paused(page), true);
    assert.equal((await counts(page)).panelPresses, before.panelPresses);
    await page.keyboard.press('Enter');
    assert.equal((await counts(page)).panelPresses, before.panelPresses + 1, 'Enter should press the focused control');
    await page.keyboard.press('Space');
    assert.equal(await paused(page), false);
  });

  await check('number keys select, click orders', async () => {
    await page.keyboard.press('Digit2');
    assert.equal(await selected(page), 'probe-2');
    const pad = await target(page, 'pad-B');
    await page.mouse.click(pad.mx, pad.my);
    await page.waitForFunction(() => {
      const p = window.coldManifest.sim.state.probes[1];
      return !p.moving && p.x === 495 && p.y === 88;
    }, null, { timeout: 5000 });
  });

  await check('a mouse click the same distance outside a target misses it', async () => {
    const latch = await target(page, 'latch');
    await page.mouse.click(latch.x + latch.w + 10, latch.my);
    await sleep(100);
    const p2 = await probe(page, 'probe-2');
    // The order goes to the clicked floor point, not to the latch centre.
    assert.notDeepEqual([p2.tx, p2.ty], [333, 243]);
  });

  await check('right-click shows info and is not a tap', async () => {
    const pad = await target(page, 'pad-A');
    const before = await counts(page);
    await page.mouse.click(pad.mx, pad.my, { button: 'right' });
    const after = await counts(page);
    assert.equal(after.infos, before.infos + 1);
    assert.equal(after.bayTaps, before.bayTaps);
    assert.match(await game(page, () => window.coldManifest.testBay.debug.infoText), /^pad A/);
  });

  await check('a click that slides off a button does not press it', async () => {
    const box = await page.locator('#btn-ping').boundingBox();
    const before = await counts(page);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y - 120, { steps: 5 });
    await page.mouse.up();
    assert.equal((await counts(page)).panelPresses, before.panelPresses);
  });

  await check('escape goes back', async () => {
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
