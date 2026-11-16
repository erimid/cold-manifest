// The test bay: a temporary screen for trying the sim clock, pause, the
// command queue and the input layer by hand, on a PC and on an iPad.
// The ship view replaces it in S1.3.
//
// Three probes sit in an empty bay. Tap one to select it (or press 1 to 3),
// tap somewhere to send it there, or drag it. Long-press or right-click
// anything for info. A panel sits on top of one pad to show that taps on
// panels never reach what is underneath.

import { pickTarget } from '../engine/hit.js';
import { BAY } from '../sim/sim.js';
import { el } from './dom.js';

const PADS = Object.freeze([
  { id: 'pad-A', label: 'A', x: 70, y: 50, w: 130, h: 96 },
  { id: 'pad-B', label: 'B', x: 430, y: 40, w: 130, h: 96 },
  { id: 'pad-C', label: 'C', x: 110, y: 450, w: 130, h: 96 },
  { id: 'pad-D', label: 'D', x: 450, y: 460, w: 130, h: 96 },
  { id: 'pad-E', label: 'E', x: 690, y: 190, w: 270, h: 220, note: 'partly under the panel' },
  { id: 'latch', label: '', x: 318, y: 228, w: 30, h: 30, note: 'a small target: touch reaches a little past its edge' },
]);

const COLORS = {
  floor: '#141920',
  floorEdge: '#39414d',
  grid: 'rgba(255, 179, 71, 0.07)',
  pad: '#a8742c',
  padFill: 'rgba(255, 138, 43, 0.07)',
  amber: '#ffb347',
  sodium: '#ff8a2b',
  paper: '#e9dcc3',
  dark: '#0b0f15',
};
const MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', 'Courier New', monospace";

export function createTestBay({ canvas, root, input, sim, clock, onBack }) {
  const ctx = canvas.getContext('2d');
  let view = { scale: 1, ox: 0, oy: 0, w: 0, h: 0 };
  let selected = null; // probe id
  let dragging = null; // { probe, x, y } in canvas pixels
  let subscriptions = [];
  let nodes = null;
  const counts = { bayTaps: 0, panelPresses: 0, infos: 0, drags: 0 };
  const log = [];

  // ---------- coordinates ----------

  const toScreen = (wx, wy) => ({ x: view.ox + wx * view.scale, y: view.oy + wy * view.scale });
  const toWorld = (sx, sy) => ({ x: (sx - view.ox) / view.scale, y: (sy - view.oy) / view.scale });
  const inBay = (w) => w.x >= 0 && w.x <= BAY.width && w.y >= 0 && w.y <= BAY.height;

  function layout() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (w === view.w && h === view.h) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const margin = { top: 84, bottom: 116, side: 28 };
    const scale = Math.min((w - margin.side * 2) / BAY.width, (h - margin.top - margin.bottom) / BAY.height);
    view = {
      w,
      h,
      scale,
      ox: (w - BAY.width * scale) / 2,
      oy: margin.top + (h - margin.top - margin.bottom - BAY.height * scale) / 2,
    };
    // Park the test panel over pad E, so the pad pokes out around it.
    const pad = PADS.find((p) => p.id === 'pad-E');
    const centre = toScreen(pad.x + pad.w / 2, pad.y + pad.h / 2);
    nodes.panel.style.left = `${centre.x}px`;
    nodes.panel.style.top = `${centre.y}px`;
  }

  /** Everything tappable, in canvas pixels, for hit testing. Probes sit above pads. */
  function targets() {
    const out = [];
    for (const pad of PADS) {
      const p = toScreen(pad.x, pad.y);
      out.push({ id: pad.id, kind: 'pad', x: p.x, y: p.y, w: pad.w * view.scale, h: pad.h * view.scale, priority: pad.id === 'latch' ? 2 : 1 });
    }
    for (const probe of sim.state.probes) {
      const p = toScreen(probe.x, probe.y);
      out.push({ id: probe.id, kind: 'probe', cx: p.x, cy: p.y, r: BAY.probeRadius * view.scale, priority: 3 });
    }
    return out;
  }

  // ---------- actions ----------

  function note(text) {
    log.unshift(text);
    log.length = Math.min(log.length, 3);
    nodes.log.replaceChildren(...log.map((line, i) => el('div', { class: i === 0 ? 'bay-log__new' : '' }, line)));
  }

  function hideInfo() {
    nodes.info.hidden = true;
  }

  function select(id) {
    selected = id;
  }

  /** Send a probe to a spot given in canvas pixels. A pad pulls the order to its centre. */
  function order(probeId, sx, sy, target) {
    let world = toWorld(sx, sy);
    if (target?.kind === 'pad') {
      const pad = PADS.find((p) => p.id === target.id);
      world = { x: pad.x + pad.w / 2, y: pad.y + pad.h / 2 };
    } else if (!inBay(world)) {
      return false;
    }
    sim.enqueue({ type: 'probe.move', probe: probeId, x: world.x, y: world.y });
    return true;
  }

  const nameOf = (target) => (target ? (target.id === 'latch' ? 'the latch' : target.id.replace('-', ' ')) : 'the floor');

  function onTap({ x, y, pointerType }) {
    hideInfo();
    counts.bayTaps += 1;
    const target = pickTarget(targets(), x, y, pointerType);
    if (target?.kind === 'probe') {
      select(target.id);
      note(`tap (${pointerType}): selected ${nameOf(target)}`);
      return;
    }
    if (!selected) {
      note(`tap (${pointerType}): ${nameOf(target)}. Select a probe first.`);
      return;
    }
    if (order(selected, x, y, target)) {
      note(`tap (${pointerType}): ${selected.replace('-', ' ')} to ${nameOf(target)}${clock.paused ? ', queued' : ''}`);
    } else {
      select(null);
      note(`tap (${pointerType}): outside the bay, nothing selected`);
    }
  }

  function onDragStart({ startX, startY, x, y, pointerType }) {
    hideInfo();
    const target = pickTarget(targets(), startX, startY, pointerType);
    if (target?.kind !== 'probe') return;
    select(target.id);
    dragging = { probe: target.id, x, y };
  }

  function onDrag({ x, y }) {
    if (dragging) Object.assign(dragging, { x, y });
  }

  function onDragEnd({ x, y, pointerType, cancelled }) {
    counts.drags += 1;
    if (!dragging) {
      note(`drag (${pointerType}): not on a probe, ignored`);
      return;
    }
    const { probe } = dragging;
    dragging = null;
    if (cancelled) return;
    const target = pickTarget(targets().filter((t) => t.kind === 'pad'), x, y, pointerType);
    if (order(probe, x, y, target)) note(`drag (${pointerType}): ${probe.replace('-', ' ')} to ${nameOf(target)}${clock.paused ? ', queued' : ''}`);
    else note(`drag (${pointerType}): dropped outside the bay`);
  }

  function onInfo({ x, y, pointerType, source }) {
    counts.infos += 1;
    const target = pickTarget(targets(), x, y, pointerType);
    let text;
    if (target?.kind === 'probe') {
      const probe = sim.state.probes.find((p) => p.id === target.id);
      text = `${nameOf(target)}: ${probe.moving ? 'moving' : 'idle'} at ${Math.round(probe.x)}, ${Math.round(probe.y)}`;
    } else if (target) {
      const pad = PADS.find((p) => p.id === target.id);
      text = `${nameOf(target)}${pad.note ? `: ${pad.note}` : ''}`;
    } else {
      const world = toWorld(x, y);
      text = inBay(world) ? `bay floor at ${Math.round(world.x)}, ${Math.round(world.y)}` : 'open space';
    }
    nodes.info.textContent = text;
    nodes.info.hidden = false;
    nodes.info.style.left = `${Math.min(x + 14, view.w - 280)}px`;
    nodes.info.style.top = `${Math.max(8, y - 48)}px`;
    note(`${source} (${pointerType}): ${text}`);
  }

  function onKey({ action }) {
    const match = /^select-(\d)$/.exec(action);
    if (match) {
      const probe = sim.state.probes[Number(match[1]) - 1];
      if (probe) {
        select(probe.id);
        note(`key ${match[1]}: selected ${probe.id.replace('-', ' ')}`);
      }
    } else if (action === 'back') {
      onBack();
    }
  }

  // ---------- drawing ----------

  function draw(alpha) {
    const s = view.scale;
    ctx.clearRect(0, 0, view.w, view.h);

    // Floor
    const o = toScreen(0, 0);
    ctx.fillStyle = COLORS.floor;
    ctx.strokeStyle = COLORS.floorEdge;
    ctx.lineWidth = 2;
    ctx.fillRect(o.x, o.y, BAY.width * s, BAY.height * s);
    ctx.strokeRect(o.x, o.y, BAY.width * s, BAY.height * s);
    ctx.strokeStyle = COLORS.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let gx = 50; gx < BAY.width; gx += 50) {
      ctx.moveTo(o.x + gx * s, o.y);
      ctx.lineTo(o.x + gx * s, o.y + BAY.height * s);
    }
    for (let gy = 50; gy < BAY.height; gy += 50) {
      ctx.moveTo(o.x, o.y + gy * s);
      ctx.lineTo(o.x + BAY.width * s, o.y + gy * s);
    }
    ctx.stroke();

    // Pads
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const pad of PADS) {
      const p = toScreen(pad.x, pad.y);
      ctx.fillStyle = COLORS.padFill;
      ctx.strokeStyle = COLORS.pad;
      ctx.lineWidth = 2;
      ctx.setLineDash(pad.id === 'latch' ? [] : [10, 6]);
      ctx.fillRect(p.x, p.y, pad.w * s, pad.h * s);
      ctx.strokeRect(p.x, p.y, pad.w * s, pad.h * s);
      ctx.setLineDash([]);
      if (pad.label) {
        ctx.fillStyle = COLORS.pad;
        ctx.font = `700 ${Math.round(34 * s)}px ${MONO}`;
        // Pad E's letter sits in its top-left corner so the panel does not hide it.
        if (pad.id === 'pad-E') ctx.fillText(pad.label, p.x + 26 * s, p.y + 30 * s);
        else ctx.fillText(pad.label, p.x + (pad.w * s) / 2, p.y + (pad.h * s) / 2);
      }
    }

    // Orders: a line and a cross for each probe's destination. Queued orders
    // (given while paused, not started yet) are dashed.
    const queued = new Map(sim.state.commands.filter((c) => c.type === 'probe.move').map((c) => [c.probe, c]));
    for (const probe of sim.state.probes) {
      const from = toScreen(probe.px + (probe.x - probe.px) * alpha, probe.py + (probe.y - probe.py) * alpha);
      const pending = queued.get(probe.id);
      if (!pending && !probe.moving) continue;
      const to = pending ? toScreen(pending.x, pending.y) : toScreen(probe.tx, probe.ty);
      ctx.strokeStyle = pending ? COLORS.sodium : COLORS.amber;
      ctx.lineWidth = 2;
      ctx.setLineDash(pending ? [6, 6] : []);
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.moveTo(to.x - 8, to.y - 8);
      ctx.lineTo(to.x + 8, to.y + 8);
      ctx.moveTo(to.x + 8, to.y - 8);
      ctx.lineTo(to.x - 8, to.y + 8);
      ctx.stroke();
      ctx.setLineDash([]);
      if (pending) {
        ctx.fillStyle = COLORS.sodium;
        ctx.font = `700 ${Math.round(13 * Math.max(1, s))}px ${MONO}`;
        ctx.fillText('QUEUED', to.x, to.y - 20);
      }
    }

    // Probes, drawn between their last two ticks so movement is smooth at any frame rate.
    for (const [index, probe] of sim.state.probes.entries()) {
      const p = toScreen(probe.px + (probe.x - probe.px) * alpha, probe.py + (probe.y - probe.py) * alpha);
      const r = BAY.probeRadius * s;
      if (probe.id === selected) {
        ctx.strokeStyle = COLORS.paper;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r + 7, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.fillStyle = COLORS.amber;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = COLORS.dark;
      ctx.font = `700 ${Math.round(24 * s)}px ${MONO}`;
      ctx.fillText(String(index + 1), p.x, p.y + 1);
    }

    // Drag line
    if (dragging) {
      const probe = sim.state.probes.find((p) => p.id === dragging.probe);
      const from = toScreen(probe.x, probe.y);
      ctx.strokeStyle = COLORS.paper;
      ctx.lineWidth = 2;
      ctx.setLineDash([4, 6]);
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(dragging.x, dragging.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.arc(dragging.x, dragging.y, 10, 0, Math.PI * 2);
      ctx.stroke();
    }

    // Paused stamp
    if (clock.paused) {
      ctx.fillStyle = 'rgba(255, 138, 43, 0.9)';
      ctx.font = `700 ${Math.round(20 * Math.max(1, s))}px ${MONO}`;
      ctx.textAlign = 'left';
      ctx.fillText('PAUSED · ORDERS WILL START ON RESUME', o.x + 14, o.y + BAY.height * s - 18);
    }
  }

  let lastReadout = '';
  function updateReadout() {
    const waiting = sim.state.commands.length;
    const text = [
      `tick   ${String(sim.state.tick).padStart(6)}`,
      `time   ${sim.time.toFixed(1).padStart(6)}s`,
      `clock  ${clock.paused ? 'PAUSED' : 'running'}`,
      `queued ${String(waiting).padStart(6)}`,
    ].join('\n');
    if (text !== lastReadout) {
      lastReadout = text;
      nodes.readout.textContent = text;
    }
    const pauseLabel = clock.paused ? 'Resume' : 'Pause';
    if (nodes.pauseLabel.textContent !== pauseLabel) {
      nodes.pauseLabel.textContent = pauseLabel;
      nodes.pause.classList.toggle('is-paused', clock.paused);
    }
    const tally = `Panel presses: ${counts.panelPresses}\nBay taps: ${counts.bayTaps}`;
    if (nodes.tally.textContent !== tally) nodes.tally.textContent = tally;
  }

  // ---------- screen lifecycle ----------

  function build() {
    nodes = {
      readout: el('pre', { class: 'bay-readout__text', id: 'bay-readout' }),
      log: el('div', { class: 'bay-log__lines', id: 'bay-log' }),
      tally: el('pre', { class: 'bay-panel__tally', id: 'bay-tally' }),
      info: el('div', { class: 'bay-info', id: 'bay-info', hidden: true }),
      pauseLabel: el('span', {}, 'Pause'),
    };
    nodes.pause = el(
      'button',
      { class: 'btn btn--pause', type: 'button', id: 'btn-pause', press: () => clock.toggle() },
      nodes.pauseLabel,
      el('small', {}, 'Space bar'),
    );
    nodes.panel = el(
      'div',
      { class: 'panel bay-panel', id: 'bay-panel' },
      el('div', { class: 'stencil' }, 'Panel test'),
      nodes.tally,
      el(
        'button',
        {
          class: 'btn btn--small',
          type: 'button',
          id: 'btn-ping',
          press: () => {
            counts.panelPresses += 1;
            note('panel: Ping pressed. The pad underneath felt nothing.');
          },
        },
        'Ping',
      ),
    );
    root.replaceChildren(
      el(
        'section',
        { class: 'bay' },
        el('div', { class: 'panel bay-readout' }, el('div', { class: 'stencil' }, 'Test bay'), nodes.readout),
        el('button', { class: 'btn btn--small bay-back', type: 'button', id: 'btn-back', press: onBack }, 'Back'),
        el('div', { class: 'panel bay-log' }, el('div', { class: 'stencil' }, 'Input log'), nodes.log),
        nodes.panel,
        nodes.pause,
        nodes.info,
      ),
    );
    note('Tap a probe, then tap where it should go. Long-press for info.');
  }

  return {
    enter() {
      build();
      canvas.hidden = false;
      view.w = -1; // force a layout
      layout();
      subscriptions = [
        input.on('tap', onTap),
        input.on('dragstart', onDragStart),
        input.on('drag', onDrag),
        input.on('dragend', onDragEnd),
        input.on('info', onInfo),
        input.on('key', onKey),
      ];
    },
    exit() {
      for (const stop of subscriptions) stop();
      subscriptions = [];
      dragging = null;
      canvas.hidden = true;
    },
    /** Called every rendered frame, paused or not. */
    update() {
      layout();
      draw(clock.alpha);
      updateReadout();
    },
    /** For automated tests and the debug console. */
    debug: {
      targets,
      counts,
      get selected() {
        return selected;
      },
      get infoText() {
        return nodes && !nodes.info.hidden ? nodes.info.textContent : null;
      },
    },
  };
}
