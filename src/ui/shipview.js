// The ship view: the main gameplay screen (brief §18).
//
// Tap a room to see its status, tap a door to open or close it, long-press
// (or right-click) anything for a description. The power panel along the
// bottom routes the reactor's bars between systems (S1.4). Air, fire and crew
// arrive in the next sessions and plug into this screen.

import { pickTarget } from '../engine/hit.js';
import { POWERED, aiCoreStatus, free, lightsDraw, litRooms, supply, usable } from '../sim/power.js';
import { SPACE, SYSTEMS } from '../sim/systems.js';
import { TICK_SECONDS } from '../sim/sim.js';
import { el } from './dom.js';
import { createShipRenderer } from './ship-render.js';

const percent = (value) => `${Math.round(value * 100)}%`;
const POWER_KEYS = 'QWERTYUI';
/** Start a sentence with a capital: the sim's reasons are written to follow "because". */
const sentence = (text) => `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;

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
  let power = null; // the power panel's live parts
  let refusal = null; // { text, until } the last order the ship refused, shown briefly
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
    const problem = sim.whyNot(command);
    if (problem) {
      refusal = { text: sentence(problem), until: performance.now() + 2600 };
      return false;
    }
    refusal = null;
    sim.enqueue(command);
    return true;
  }

  /** Check an order without giving it; shows the reason if the ship would refuse. */
  function wouldRefuse(command) {
    const problem = sim.whyNot(command);
    if (problem) refusal = { text: sentence(problem), until: performance.now() + 2600 };
    return Boolean(problem);
  }

  /** The last refusal, while it is still fresh. Wall-clock time, so it also fades while paused. */
  function refusalText() {
    if (refusal && performance.now() > refusal.until) refusal = null;
    return refusal ? refusal.text : '';
  }

  // ---------- the power panel ----------

  function pips(count) {
    return Array.from({ length: count }, () => el('i', { class: 'pip' }));
  }

  function setPip(node, kind) {
    const name = `pip pip--${kind}`;
    if (node.className !== name) node.className = name;
  }

  function buildPower() {
    const reactorPips = pips(sim.state.systems.reactor.level);
    const summary = el('div', { class: 'power__summary', id: 'power-summary' });
    const lights = el('div', { class: 'power__lights', id: 'power-lights' });
    const tiles = POWERED.map((id, i) => {
      const add = (delta) => () => order({ type: 'power.add', system: id, delta });
      const minus = el('button', { class: 'btn power__btn', type: 'button', id: `btn-power-${id}-minus`, 'aria-label': `Less power to ${SYSTEMS[id].name}`, press: add(-1) }, '−');
      const plus = el('button', { class: 'btn power__btn', type: 'button', id: `btn-power-${id}-plus`, 'aria-label': `More power to ${SYSTEMS[id].name}`, press: add(1) }, '+');
      const bars = pips(sim.state.systems[id].level);
      const node = el(
        'div',
        { class: 'power__tile', id: `power-${id}`, title: SYSTEMS[id].name },
        el('div', { class: 'power__label' }, el('span', { class: 'power__code' }, SYSTEMS[id].code), el('span', { class: 'power__key' }, POWER_KEYS[i])),
        el('div', { class: 'power__pips' }, bars),
        el('div', { class: 'power__buttons' }, minus, plus),
      );
      return { id, node, minus, plus, bars };
    });
    power = { reactorPips, summary, lights, tiles };
    return el(
      'div',
      { class: 'panel power', id: 'power' },
      el('div', { class: 'power__reactor' }, el('div', { class: 'stencil' }, 'Reactor'), el('div', { class: 'power__pips power__pips--reactor' }, reactorPips), summary, lights),
      el('div', { class: 'power__tiles' }, tiles.map((t) => t.node)),
    );
  }

  function updatePower() {
    const made = supply(sim);
    const spare = free(sim);
    const inUse = made - spare;
    power.reactorPips.forEach((node, i) => setPip(node, i >= made ? 'broken' : i < inUse ? 'on' : 'off'));
    setText(power.summary, `${spare} of ${made} spare`);
    power.summary.classList.toggle('is-alarm', made < sim.state.systems.reactor.level);
    setText(power.lights, `Lights ${lightsDraw(sim)} · ${litRooms(sim)} rooms`);
    for (const tile of power.tiles) {
      const system = sim.state.systems[tile.id];
      const works = usable(sim, tile.id);
      tile.bars.forEach((node, i) => setPip(node, i >= works ? 'broken' : i < system.power ? 'on' : 'off'));
      tile.node.classList.toggle('is-dead', system.power === 0);
      tile.node.classList.toggle('is-damaged', system.damage > 0);
      tile.minus.disabled = system.power === 0;
      tile.plus.disabled = system.power >= works || spare < 1;
    }
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
      const sys = room.system ?? null;
      if (sys) stats.system = stat(sys === 'reactor' ? 'Output' : POWERED.includes(sys) ? 'Power' : 'System');
      const lights = button('btn-lights', 'Lights off', () => order({ type: 'room.lights', room: room.id, on: !sim.state.rooms[room.id].lightsOn }));
      const note = el('span', { class: 'status__note' });
      const controls = [lights];
      let jettison = null;
      if (room.jettison) {
        // Two presses: the first arms it for a few seconds, the second cuts the room loose.
        jettison = button('btn-jettison', 'Jettison', () => {
          const command = { type: 'room.jettison', room: room.id };
          if (panel.armedUntil > performance.now()) {
            panel.armedUntil = 0;
            order(command);
          } else panel.armedUntil = wouldRefuse(command) ? 0 : performance.now() + 4000;
        }, 'btn--danger');
        controls.push(jettison);
      }
      if (debug) {
        const set = (values) => () => order({ type: 'debug.room', room: room.id, set: values });
        controls.push(
          button('btn-dbg-fire', 'Fire', set({ fire: 0.7 }), 'btn--debug'),
          button('btn-dbg-breach', 'Breach', set({ breach: 0.6 }), 'btn--debug'),
          button('btn-dbg-air', 'Drain air', set({ oxygen: 0.2 }), 'btn--debug'),
          button('btn-dbg-reset', 'Reset', set({ fire: 0, breach: 0, oxygen: 1 }), 'btn--debug'),
        );
        if (sys) {
          const hurt = (by) => () => {
            const { damage, level } = sim.state.systems[sys];
            order({ type: 'debug.system', system: sys, damage: Math.max(0, Math.min(level, damage + by)) });
          };
          controls.push(button('btn-dbg-damage', 'Damage', hurt(1), 'btn--debug'), button('btn-dbg-repair', 'Repair', hurt(-1), 'btn--debug'));
        }
      }
      const system = room.system ? SYSTEMS[room.system].name : room.kind === 'helm' ? 'Helm' : 'Corridor';
      nodes.status.replaceChildren(
        el('div', { class: 'status__head' }, el('div', { class: 'status__title', id: 'status-title' }, room.name), system.toLowerCase() !== room.name.toLowerCase() && el('div', { class: 'stencil' }, system), note),
        el('div', { class: 'status__stats' }, Object.values(stats).map((s) => s.node)),
        el('div', { class: 'status__controls' }, controls),
      );
      panel = { kind: 'room', id: room.id, sys, stats, lights, jettison, armedUntil: 0, note };
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
      if (panel.sys) {
        const system = sim.state.systems[panel.sys];
        const works = system.level - system.damage;
        let text = panel.sys === 'reactor' ? `${works} of ${system.level} bars` : POWERED.includes(panel.sys) ? `${system.power} of ${works}` : system.damage ? 'damaged' : 'working';
        if (system.damage && POWERED.includes(panel.sys)) text += ` (${system.damage} damaged)`;
        if (panel.sys === 'ai_core') text += ` · ${aiCoreStatus(sim).state}`;
        setText(panel.stats.system.value, text);
        panel.stats.system.node.classList.toggle('is-alarm', system.damage > 0);
      }
      setText(panel.lights, r.lightsOn ? 'Lights off' : 'Lights on');
      panel.lights.disabled = r.jettisoned;
      const armed = panel.armedUntil > performance.now();
      if (panel.jettison) {
        setText(panel.jettison, r.jettisoned ? 'Jettisoned' : armed ? 'Confirm jettison' : 'Jettison');
        panel.jettison.disabled = r.jettisoned;
        panel.jettison.classList.toggle('is-armed', armed && !r.jettisoned);
      }
      let note = refusalText();
      if (r.jettisoned) note = 'This section was cut loose. It is gone.';
      else if (queuedFor('room', panel.id)) note = 'Order queued';
      else if (armed) note = 'Everything inside will be lost. Press again to confirm.';
      setText(panel.note, note);
    } else {
      const d = sim.state.doors[panel.id];
      setText(panel.stats.state.value, d.state);
      setText(panel.stats.opening.value, percent(d.openness));
      panel.stats.state.node.classList.toggle('is-alarm', d.state === 'jammed');
      const jammed = d.state === 'jammed';
      if (d.sealed) {
        setText(panel.stats.state.value, 'sealed');
        for (const node of Object.values(panel.buttons)) node.disabled = true;
        if (panel.jam) panel.jam.disabled = true;
        setText(panel.note, 'Welded shut. There is nothing on the other side.');
        return;
      }
      // Buttons stay pressable when door control is dark, so a press can say why nothing moved.
      for (const [state, node] of Object.entries(panel.buttons)) node.disabled = jammed || d.state === state;
      const dark = sim.state.systems.doors.power === 0;
      panel.stats.state.node.classList.toggle('is-alarm', jammed);
      if (panel.jam) setText(panel.jam, jammed ? 'Free' : 'Jam');
      setText(
        panel.note,
        queuedFor('door', panel.id) ? 'Order queued' : jammed ? 'Jammed. It will not move until it is repaired.' : refusalText() || (dark ? 'Door control has no power. Doors are worked by hand.' : ''),
      );
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
      if (!door.airlock && !sim.state.doors[door.id].sealed && (state === 'open' || state === 'closed')) order({ type: 'door.set', door: door.id, state: state === 'open' ? 'closed' : 'open' });
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

  function onKey({ action, shift }) {
    if (action.startsWith('power-')) {
      const system = POWERED[Number(action.slice(6)) - 1];
      if (system) order({ type: 'power.add', system, delta: shift ? -1 : 1 });
      return;
    }
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
    nodes.bottom = el('div', { class: 'shipdock' }, el('div', { class: 'shipdock__row' }, nodes.status, nodes.pause), buildPower());
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
      updatePower();
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
