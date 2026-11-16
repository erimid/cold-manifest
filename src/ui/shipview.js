// The ship view: the main gameplay screen (brief §18).
//
// S1.3: look around the ship. Tap a room to see its status, tap a door to
// open or close it, long-press (or right-click) anything for a description.
// Power, air, fire and crew arrive in the next sessions and plug into this
// screen.

import { pickTarget } from '../engine/hit.js';
import { SPACE, SYSTEMS } from '../sim/systems.js';
import { TICK_SECONDS } from '../sim/sim.js';
import { el } from './dom.js';
import { createShipRenderer } from './ship-render.js';

const percent = (value) => `${Math.round(value * 100)}%`;

export function createShipView({ canvas, root, input, sim, clock, onBack, debug = false }) {
  const { layout } = sim;
  const renderer = createShipRenderer(layout);
  const ctx = canvas.getContext('2d');
  let size = { w: 0, h: 0, dpr: 1 };
  let view = { scale: 1, ox: 0, oy: 0 };
  let selected = null; // { kind: 'room' | 'door', id }
  let showVents = false;
  let subscriptions = [];
  let nodes = null;
  let panel = null; // the status panel's live parts for the current selection
  const counts = { canvasTaps: 0, infos: 0 };

  // ---------- naming ----------

  const roomName = (id) => (id === SPACE ? 'space' : layout.room(id).name);

  function doorName(door) {
    return door.name ?? `Door, ${roomName(door.a)} to ${roomName(door.b)}`;
  }

  function describe(target) {
    if (target?.kind === 'room') {
      const room = layout.room(target.id);
      if (room.system) return `${room.name}. ${SYSTEMS[room.system].blurb}`;
      if (room.kind === 'helm') return `${room.name}. Where the ship is flown from.`;
      return `${room.name}. Gets you from one problem to the next.`;
    }
    if (target?.kind === 'door') {
      const door = layout.door(target.id);
      const state = sim.state.doors[door.id].state;
      return `${doorName(door)}: ${state}.${door.airlock ? ' Opens to space.' : ''}`;
    }
    return null;
  }

  // ---------- layout ----------

  function measure() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (w === size.w && h === size.h && dpr === size.dpr) return;
    size = { w, h, dpr };
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // The ship gets the space between the top bar and the bottom panel.
    const top = nodes.top.getBoundingClientRect().bottom + 10;
    const bottom = nodes.bottom.getBoundingClientRect().top - 10;
    view = renderer.fit({ x: 16, y: top, w: w - 32, h: Math.max(80, bottom - top) });
  }

  // ---------- orders ----------

  /** Give an order if the sim would accept it. Returns true if it was queued. */
  function order(command) {
    if (sim.whyNot(command)) return false;
    sim.enqueue(command);
    return true;
  }

  const queuedFor = (key, id) => sim.state.commands.some((c) => c[key] === id);

  // ---------- the status panel ----------

  function select(next) {
    selected = next;
    nodes.info.hidden = true;
    buildPanel();
  }

  function stat(label) {
    const value = el('span', { class: 'stat__value' });
    return { node: el('div', { class: 'stat' }, el('span', { class: 'stat__label' }, label), value), value };
  }

  function button(id, label, press, extraClass = '') {
    return el('button', { class: `btn btn--small ${extraClass}`, type: 'button', id, press }, label);
  }

  function buildPanel() {
    panel = null;
    if (!selected) {
      nodes.status.replaceChildren(
        el('div', { class: 'stencil' }, layout.name),
        el('p', { class: 'status__hint' }, 'Tap a room for its status. Tap a door to open or close it. Long-press anything to ask what it is.'),
      );
      return;
    }

    if (selected.kind === 'room') {
      const room = layout.room(selected.id);
      const stats = { oxygen: stat('Oxygen'), temperature: stat('Temp'), light: stat('Light'), noise: stat('Noise'), hull: stat('Hull'), fire: stat('Fire'), breach: stat('Breach') };
      const lights = button('btn-lights', 'Lights off', () => order({ type: 'room.lights', room: room.id, on: !sim.state.rooms[room.id].lightsOn }));
      const note = el('span', { class: 'status__note' });
      const controls = [lights];
      if (debug) {
        const set = (values) => () => order({ type: 'debug.room', room: room.id, set: values });
        controls.push(
          button('btn-dbg-fire', 'Fire', set({ fire: 0.7 }), 'btn--debug'),
          button('btn-dbg-breach', 'Breach', set({ breach: 0.6 }), 'btn--debug'),
          button('btn-dbg-air', 'Drain air', set({ oxygen: 0.2 }), 'btn--debug'),
          button('btn-dbg-reset', 'Reset', set({ fire: 0, breach: 0, oxygen: 1 }), 'btn--debug'),
        );
      }
      const system = room.system ? SYSTEMS[room.system].name : room.kind === 'helm' ? 'Helm' : 'Corridor';
      nodes.status.replaceChildren(
        el('div', { class: 'status__head' }, el('div', { class: 'status__title', id: 'status-title' }, room.name), system.toLowerCase() !== room.name.toLowerCase() && el('div', { class: 'stencil' }, system), note),
        el('div', { class: 'status__stats' }, Object.values(stats).map((s) => s.node)),
        el('div', { class: 'status__controls' }, controls),
      );
      panel = { kind: 'room', id: room.id, stats, lights, note };
    } else {
      const door = layout.door(selected.id);
      const stats = { state: stat('State'), opening: stat('Opening') };
      const set = (state) => () => order({ type: 'door.set', door: door.id, state });
      const buttons = { open: button('btn-door-open', 'Open', set('open')), closed: button('btn-door-close', 'Close', set('closed')), locked: button('btn-door-lock', 'Lock', set('locked')) };
      const note = el('span', { class: 'status__note' });
      const controls = Object.values(buttons);
      let jam = null;
      if (debug) {
        jam = button('btn-dbg-jam', 'Jam', () => order({ type: 'debug.door', door: door.id, jammed: sim.state.doors[door.id].state !== 'jammed' }), 'btn--debug');
        controls.push(jam);
      }
      nodes.status.replaceChildren(
        el(
          'div',
          { class: 'status__head' },
          el('div', { class: 'status__title', id: 'status-title' }, doorName(door)),
          el('div', { class: 'stencil' }, door.airlock ? 'Airlock · opens to space' : 'Interior door'),
          note,
        ),
        el('div', { class: 'status__stats' }, Object.values(stats).map((s) => s.node)),
        el('div', { class: 'status__controls' }, controls),
      );
      panel = { kind: 'door', id: door.id, stats, buttons, jam, note };
    }
    updatePanel();
  }

  function setText(node, text) {
    if (node.textContent !== text) node.textContent = text;
  }

  /** Refresh the numbers and button states in place. The panel's elements are never rebuilt mid-press. */
  function updatePanel() {
    if (!panel) return;
    if (panel.kind === 'room') {
      const r = sim.state.rooms[panel.id];
      setText(panel.stats.oxygen.value, percent(r.oxygen));
      setText(panel.stats.temperature.value, `${Math.round(r.temperature)}°C`);
      setText(panel.stats.light.value, percent(r.light));
      setText(panel.stats.noise.value, percent(r.noise));
      setText(panel.stats.hull.value, percent(r.hull));
      setText(panel.stats.fire.value, r.fire > 0 ? percent(r.fire) : 'none');
      setText(panel.stats.breach.value, r.breach > 0 ? percent(r.breach) : 'none');
      panel.stats.fire.node.classList.toggle('is-alarm', r.fire > 0);
      panel.stats.breach.node.classList.toggle('is-alarm', r.breach > 0);
      panel.stats.oxygen.node.classList.toggle('is-alarm', r.oxygen < 0.35);
      setText(panel.lights, r.lightsOn ? 'Lights off' : 'Lights on');
      setText(panel.note, queuedFor('room', panel.id) ? 'Order queued' : '');
    } else {
      const d = sim.state.doors[panel.id];
      setText(panel.stats.state.value, d.state);
      setText(panel.stats.opening.value, percent(d.openness));
      panel.stats.state.node.classList.toggle('is-alarm', d.state === 'jammed');
      const jammed = d.state === 'jammed';
      for (const [state, node] of Object.entries(panel.buttons)) node.disabled = jammed || d.state === state;
      if (panel.jam) setText(panel.jam, jammed ? 'Free' : 'Jam');
      setText(panel.note, queuedFor('door', panel.id) ? 'Order queued' : jammed ? 'Jammed. It will not move until it is repaired.' : '');
    }
  }

  // ---------- input ----------

  function onTap({ x, y, pointerType }) {
    counts.canvasTaps += 1;
    const target = pickTarget(renderer.targets(view), x, y, pointerType);
    if (!target) {
      select(null);
      return;
    }
    select({ kind: target.kind, id: target.id });
    if (target.kind === 'door') {
      // Tapping a door works it. Airlocks and locked doors are deliberate: use the panel.
      const door = layout.door(target.id);
      const { state } = sim.state.doors[door.id];
      if (!door.airlock && (state === 'open' || state === 'closed')) order({ type: 'door.set', door: door.id, state: state === 'open' ? 'closed' : 'open' });
    }
  }

  function onInfo({ x, y, pointerType }) {
    counts.infos += 1;
    const text = describe(pickTarget(renderer.targets(view), x, y, pointerType)) ?? 'Open space. Cold, and a long way from anywhere.';
    nodes.info.textContent = text;
    nodes.info.hidden = false;
    nodes.info.style.left = `${Math.max(8, Math.min(x + 14, size.w - 300))}px`;
    nodes.info.style.top = `${Math.max(8, y - 56)}px`;
  }

  function onKey({ action }) {
    if (action !== 'back') return;
    if (selected) select(null);
    else onBack();
  }

  // ---------- screen lifecycle ----------

  function build() {
    nodes = {
      clock: el('pre', { class: 'shipbar__clock', id: 'ship-clock' }),
      status: el('div', { class: 'panel status', id: 'status' }),
      info: el('div', { class: 'ship-info', id: 'ship-info', hidden: true }),
      pauseLabel: el('span', {}, 'Pause'),
    };
    nodes.pause = el('button', { class: 'btn btn--pause', type: 'button', id: 'btn-pause', press: () => clock.toggle() }, nodes.pauseLabel, el('small', {}, 'Space bar'));
    nodes.top = el(
      'div',
      { class: 'shipbar' },
      el('div', { class: 'panel shipbar__name' }, el('div', { class: 'stencil' }, layout.name), nodes.clock),
      el(
        'div',
        { class: 'shipbar__buttons' },
        debug &&
          button('btn-vents', 'Vents', () => {
            showVents = !showVents;
          }, 'btn--debug'),
        button('btn-back', 'Back', onBack),
      ),
    );
    nodes.bottom = el('div', { class: 'shipdock' }, nodes.status, nodes.pause);
    root.replaceChildren(el('section', { class: 'ship' }, nodes.top, nodes.bottom, nodes.info));
    buildPanel();
  }

  let lastClock = '';
  function updateClock() {
    const waiting = sim.state.commands.length;
    const text = `${clock.paused ? 'PAUSED' : 'running'} · ${sim.time.toFixed(1)}s${waiting ? ` · ${waiting} queued` : ''}`;
    if (text !== lastClock) {
      lastClock = text;
      nodes.clock.textContent = text;
    }
    const label = clock.paused ? 'Resume' : 'Pause';
    if (nodes.pauseLabel.textContent !== label) {
      nodes.pauseLabel.textContent = label;
      nodes.pause.classList.toggle('is-paused', clock.paused);
    }
  }

  return {
    enter() {
      build();
      canvas.hidden = false;
      size = { w: 0, h: 0, dpr: 1 }; // force a measure
      measure();
      subscriptions = [input.on('tap', onTap), input.on('info', onInfo), input.on('key', onKey), input.on('dragstart', () => (nodes.info.hidden = true))];
    },
    exit() {
      for (const stop of subscriptions) stop();
      subscriptions = [];
      canvas.hidden = true;
    },
    /** Called every rendered frame, paused or not. */
    update() {
      measure();
      renderer.draw(ctx, {
        view,
        width: size.w,
        height: size.h,
        dpr: size.dpr,
        state: sim.state,
        // Game time, so flames and alarms hold still while paused.
        time: (sim.state.tick + clock.alpha) * TICK_SECONDS,
        selected,
        showVents,
      });
      updateClock();
      updatePanel();
    },
    /** For automated tests and the debug console. */
    debug: {
      targets: () => renderer.targets(view),
      counts,
      get view() {
        return view;
      },
      get selected() {
        return selected;
      },
      get infoText() {
        return nodes && !nodes.info.hidden ? nodes.info.textContent : null;
      },
    },
  };
}
