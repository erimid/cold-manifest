// The ship view: the main gameplay screen (brief §18).
//
// Tap a room to see its status, tap a door to open or close it, long-press
// (or right-click) anything for a description. The power panel along the
// bottom routes the reactor's bars between systems (S1.4). Air, fire and crew
// arrive in the next sessions and plug into this screen.
//
// In a fight (S2.1) the enemy ship stands in a column on the right and a
// weapons bar appears above the status panel: tap a weapon, then a room on
// their ship, to aim it. It all works while paused. From S2.3 a card above the
// weapons bar answers a hail (talk, pay, open fire) or a surrender (accept,
// refuse), and the weapons bar has a Jump button that fills as the drive charges.
// From S2.4, with one of ours selected, a tap on a room of theirs sends them
// across to board; a tap on a room of ours brings them home. Ours aboard them
// are drawn on their ship and say so on their chip; their boarders are drawn
// red aboard ours and cannot be selected.

import { pickTarget } from '../engine/hit.js';
import { DEBUG_ACTIONS, OUTCOMES, OFFER_SECONDS, bribePrice, chargeOf, enemyOf, evasion, findCrew, jumpCharge, offerText, ourCrew, shieldLayers, shieldMax, talkChance } from '../sim/combat.js';
import { describeTask } from '../sim/crew.js';
import { POWERED, aiCoreStatus, free, lightsDraw, litRooms, supply, usable } from '../sim/power.js';
import { SPACE, SYSTEMS } from '../sim/systems.js';
import { TICK_SECONDS } from '../sim/sim.js';
import { el } from './dom.js';
import { AUTO_PAUSE } from './settings.js';
import { createShipRenderer } from './ship-render.js';

const percent = (value) => `${Math.round(value * 100)}%`;
const POWER_KEYS = 'QWERTYUI';
const WEAPON_KEYS = 'ASDF';
/** How long a shot's result stays on screen, in seconds of game time. */
const IMPACT_SECONDS = 0.9;
const IMPACT_TEXT = { hit: 'HIT', shield: 'SHIELD', miss: 'MISS' };
/** A hit lights up the room it lands in for this long, and shakes the screen for this long when it is ours (brief §17). */
const FLASH_SECONDS = 0.3;
const SHAKE_SECONDS = 0.45;
/** Pixels of shake: a base, and more per point of damage. */
const SHAKE_BASE = 3;
const SHAKE_PER_DAMAGE = 2.5;

/** What a hit did, in a few words under the result: "FIRE  BREACH  SYS -1  CREW". */
function effectWords(effects) {
  if (!effects) return '';
  const words = [];
  if (effects.system) words.push(`SYS -${effects.system}`);
  if (effects.fire) words.push('FIRE');
  if (effects.breach) words.push('BREACH');
  if (effects.crew.length) words.push(effects.crew.length > 1 ? `CREW x${effects.crew.length}` : 'CREW');
  return words.join('  ');
}
/** Short task names for the crew bar, where there is no room for a sentence. */
const CHIP_TASKS = { walking: 'Walking', waiting: 'At a door', extinguish: 'Fighting fire', patch: 'Patching hull', repair: 'Repairing', unjam: 'Freeing door', idle: 'Standing by', fighting: 'Fighting', sabotage: 'Wrecking', crossing: 'In the tube' };
/** Start a sentence with a capital: the sim's reasons are written to follow "because". */
const sentence = (text) => `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;

/** What each debug ending button is called (DEBUG_ACTIONS in combat.js). */
const DEBUG_LABELS = { cripple: 'Cripple them', killCrew: 'Kill their crew', surrender: 'They surrender', flee: 'They run', chargeJump: 'Charge our jump', stalemate: 'Stalemate now', sinkUs: 'Sink us', money: '+100 money', boardUs: 'They board us' };
const seconds = (ticks) => `${Math.max(0, Math.ceil(ticks * TICK_SECONDS))}s`;

/** How fast the AI's lines type out, in characters per second of real time, and how often a character blips. */
const TYPE_SPEED = 45;
const BLIP_EVERY = 3;

export function createShipView({ canvas, root, input, sim, clock, onBack, audio = null, settings = null, debug = false }) {
  const { layout } = sim;
  const renderer = createShipRenderer(layout);
  const ctx = canvas.getContext('2d');
  let size = { w: 0, h: 0, dpr: 1 };
  let view = { scale: 1, ox: 0, oy: 0 };
  let selected = null; // { kind: 'room' | 'door', id }
  let selectedCrew = null; // a crew id; while set, tapping a room sends them there
  let selectedWeapon = null; // a weapon slot; while set, tapping a room on the enemy ship aims it there
  let foe = null; // the enemy ship's renderer, while there is one: { id, renderer }
  let foeView = null; // where the enemy ship is drawn
  let fightBar = null; // the weapons bar's live parts
  let impacts = []; // shots that just landed, for a moment: { side, room, result, damage, effects, tick }
  let shake = null; // { tick, strength } the last hit on our ship, while the screen shakes
  let roster = null; // the crew bar's live parts
  let showVents = false;
  let subscriptions = [];
  let nodes = null;
  let panel = null; // the status panel's live parts for the current selection
  let power = null; // the power panel's live parts
  let refusal = null; // { text, until } the last order the ship refused, shown briefly
  let notice = null; // why the game paused itself, shown on the pause button until it resumes
  let typed = { n: 0, start: 0, shown: -1 }; // the AI line being typed out
  let sheet = null; // which pop-up sheet is open: 'log' | 'settings' | null
  let logShown = -1; // the last line number the open log has drawn
  const counts = { canvasTaps: 0, infos: 0 };

  // ---------- naming ----------

  const roomName = (id) => (id === SPACE ? 'space' : layout.room(id).name);
  /** The hardest-hitting weapon we carry: what the debug Hit us button is struck with. */
  const heaviestGun = () => sim.state.weapons.map((slot) => sim.catalog.weapon(slot.id)).reduce((a, b) => (b.damage > a.damage ? b : a)).id;
  const weaponOf = (slot) => sim.catalog.weapon(sim.state.weapons[slot].id);

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
    if (target?.kind === 'foe') {
      const enemy = enemyOf(sim);
      const room = enemy.layout.room(target.id);
      return `${enemy.layout.name}: ${room.name}. ${room.system ? SYSTEMS[room.system].blurb : 'Part of their ship.'}`;
    }
    if (target?.kind === 'crew') {
      const { member, ship } = findCrew(sim, target.id);
      return `${member.name}${ship === sim ? '' : `, aboard the ${ship.layout.name}`}. ${describeTask(ship, member)}.${member.alive ? ` Health ${percent(member.health)}.` : ''}`;
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
    // The ship gets the space between the top bar and the bottom panels, and is refitted if either moves.
    const top = Math.round(nodes.top.getBoundingClientRect().bottom) + 10;
    const bottom = Math.round(nodes.bottom.getBoundingClientRect().top) - 10;
    const enemyId = sim.state.fight?.enemy.ship ?? null;
    if (w === size.w && h === size.h && dpr === size.dpr && top === size.top && bottom === size.bottom && enemyId === size.enemyId) return;
    if (w !== size.w || h !== size.h || dpr !== size.dpr) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    size = { w, h, dpr, top, bottom, enemyId };
    const area = { x: 16, y: top, w: w - 32, h: Math.max(80, bottom - top) };
    if (!enemyId) {
      foe = null;
      foeView = null;
      view = renderer.fit(area);
      return;
    }
    // A fight: their ship stands in a column on the right, under its name; ours keeps the rest.
    if (foe?.id !== enemyId) foe = { id: enemyId, renderer: createShipRenderer(enemyOf(sim).layout) };
    const column = Math.round(area.w * 0.27);
    view = renderer.fit({ ...area, w: area.w - column - 14 });
    foeView = foe.renderer.fit({ x: area.x + area.w - column, y: area.y + 24, w: column, h: area.h - 28 });
  }

  /** Our own people aboard a ship: the ones that can be tapped. Their boarders are only looked at. */
  const oursOn = (ship) => Object.values(ship.state.crew).filter((member) => member.owner === 'player');

  /** Everything tappable on the canvas: our ship and our crew, and in a fight the rooms of theirs and any of ours aboard. */
  function allTargets() {
    const own = renderer.targets(view, oursOn(sim));
    const enemy = enemyOf(sim);
    return foe && foeView && enemy ? [...own, ...foe.renderer.targets(foeView, oursOn(enemy), { foe: true })] : own;
  }

  // ---------- orders ----------

  /** Give an order if the sim would accept it. Returns true if it was queued. */
  function order(command) {
    const problem = sim.whyNot(command);
    if (problem) {
      refusal = { text: sentence(problem), until: performance.now() + 2600 };
      audio?.play('deny');
      return false;
    }
    refusal = null;
    sim.enqueue(command);
    return true;
  }

  /** Check an order without giving it; shows the reason if the ship would refuse. */
  function wouldRefuse(command) {
    const problem = sim.whyNot(command);
    if (problem) {
      refusal = { text: sentence(problem), until: performance.now() + 2600 };
      audio?.play('deny');
    }
    return Boolean(problem);
  }

  /** The last refusal, while it is still fresh. Wall-clock time, so it also fades while paused. */
  function refusalText() {
    if (refusal && performance.now() > refusal.until) refusal = null;
    return refusal ? refusal.text : '';
  }

  // ---------- the AI's text box, her log, and settings ----------

  const stamp = (tick) => {
    const s = Math.floor(tick * TICK_SECONDS);
    return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  };

  /** Type the newest line out a few characters a frame. Real time, so a line finishes even if the game pauses on it. */
  function updateVoice() {
    const last = sim.state.ai.log.at(-1);
    if (!last) return;
    const now = performance.now();
    if (last.n !== typed.n) typed = { n: last.n, start: now, shown: -1 };
    const count = Math.min(last.text.length, Math.floor(((now - typed.start) / 1000) * TYPE_SPEED));
    if (count !== typed.shown) {
      if (count > typed.shown && count < last.text.length && count % BLIP_EVERY === 0) audio?.play('blip');
      typed.shown = count;
      nodes.aiText.textContent = last.text.slice(0, count);
      nodes.ai.classList.toggle('is-typing', count < last.text.length);
    }
    nodes.ai.classList.toggle('is-urgent', last.priority >= 4 && Boolean(sim.state.ai.speaking));
    if (sheet === 'log' && logShown !== last.n) drawLog();
  }

  function drawLog() {
    const { log } = sim.state.ai;
    logShown = log.at(-1)?.n ?? 0;
    nodes.sheet.replaceChildren(
      el('div', { class: 'stencil' }, 'M.A.R.G.O. log'),
      log.length
        ? el('ol', { class: 'ailog', id: 'ailog' }, log.map((line) => el('li', {}, el('time', {}, stamp(line.tick)), ' ', line.text)))
        : el('p', { class: 'status__hint' }, 'She has not said anything yet.'),
    );
    const list = nodes.sheet.querySelector('.ailog');
    if (list) list.scrollTop = list.scrollHeight;
  }

  function drawSettings() {
    const toggle = (id, label, path, on) => el('button', { class: `btn btn--small btn--toggle${on ? ' is-on' : ''}`, type: 'button', id, 'aria-pressed': String(on), press: () => {
      settings.set(path, !on);
      drawSettings();
    } }, label, el('small', {}, on ? 'On' : 'Off'));
    nodes.sheet.replaceChildren(
      el('div', { class: 'stencil' }, 'Settings'),
      el('div', { class: 'sheet__pairs' }, toggle('set-sound', 'Sound', 'sound', settings.values.sound), toggle('set-shake', 'Screen shake', 'shake', settings.values.shake)),
      el('div', { class: 'stencil sheet__sub' }, 'Pause the game when'),
      el('div', { class: 'sheet__pairs' }, ...AUTO_PAUSE.map((item) => toggle(`set-pause-${item.id}`, item.label, `autoPause.${item.id}`, settings.values.autoPause[item.id]))),
    );
  }

  function openSheet(which) {
    sheet = sheet === which ? null : which;
    nodes.sheet.hidden = sheet === null;
    nodes.sheet.className = `panel sheet sheet--${sheet}`;
    if (sheet === 'log') drawLog();
    if (sheet === 'settings') drawSettings();
    if (sheet === 'debug') drawDebug();
  }

  /** Debug only: start a fight with any enemy, and push one toward each ending (brief §7). */
  function drawDebug() {
    const fight = sim.state.fight;
    const act = (fn) => () => {
      fn();
      openSheet('debug');
    };
    nodes.sheet.replaceChildren(
      el('div', { class: 'stencil' }, 'Debug: fights'),
      el(
        'div',
        { class: 'sheet__grid' },
        sim.catalog.enemies.map((id) => button(`btn-dbg-fight-${id}`, sim.catalog.layout(id).name, act(() => order({ type: 'debug.fight', enemy: id })), 'btn--debug')),
        fight && button('btn-dbg-away', 'Send away', act(() => order({ type: 'debug.fight', enemy: null })), 'btn--debug'),
      ),
      el('div', { class: 'stencil sheet__sub' }, 'Push the fight to an ending'),
      el('div', { class: 'sheet__grid' }, DEBUG_ACTIONS.map((action) => button(`btn-dbg-end-${action}`, DEBUG_LABELS[action], act(() => order({ type: 'debug.combat', action })), 'btn--debug'))),
      el('div', { class: 'stencil sheet__sub' }, 'View'),
      el('div', { class: 'sheet__grid' }, button('btn-vents', showVents ? 'Hide vents' : 'Show vents', () => {
        showVents = !showVents;
        drawDebug();
      }, 'btn--debug')),
    );
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

  // A weapon order names a room on their ship, which may share an id with one of ours.
  const queuedFor = (key, id) => sim.state.commands.some((c) => c[key] === id && (key === 'slot') === c.type.startsWith('weapon.'));

  // ---------- the status panel ----------

  function select(next) {
    selected = next;
    if (next) selectedCrew = null;
    if (next) selectedWeapon = null;
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

  function selectWeapon(slot) {
    selectedWeapon = slot;
    if (slot !== null) {
      selected = null;
      selectedCrew = null;
    }
    nodes.info.hidden = true;
    buildPanel();
  }

  // ---------- the weapons bar (fights only) ----------

  function sideStats(id, title) {
    const fill = el('i', {});
    const hull = el('span', { class: 'fightside__hull', id: `${id}-hull` });
    const line = el('span', { class: 'fightside__line', id: `${id}-line` });
    const name = el('span', { class: 'stencil' }, title);
    return { node: el('div', { class: 'fightside', id }, el('div', { class: 'fightside__head' }, name, hull), el('span', { class: 'fightside__bar' }, fill), line), fill, hull, line, name };
  }

  function buildFightBar() {
    const tiles = sim.state.weapons.map((slot, index) => {
      const weapon = sim.catalog.weapon(slot.id);
      const charge = el('i', { class: 'crewchip__health' });
      const state = el('span', { class: 'crewchip__task' });
      const node = el(
        'button',
        { class: 'btn crewchip weapon', type: 'button', id: `weapon-${index}`, 'aria-label': `Aim the ${weapon.name}`, press: () => selectWeapon(selectedWeapon === index ? null : index) },
        el('span', { class: 'crewchip__num weapon__num' }, WEAPON_KEYS[index]),
        el('span', { class: 'crewchip__body' }, el('span', { class: 'crewchip__name' }, `${index + 1} ${weapon.short}`), state, el('span', { class: 'crewchip__bar' }, charge)),
      );
      return { index, node, charge, state };
    });
    const own = sideStats('fight-own', 'Our hull');
    const theirs = sideStats('fight-foe', 'Their hull');
    const leave = button('btn-fight-leave', 'Leave it', () => order({ type: 'fight.dismiss' }));
    const jumpLabel = el('span', {}, 'Jump');
    const jumpNote = el('small', { id: 'jump-note' }, '');
    const jump = el('button', { class: 'btn btn--small btn--jump', type: 'button', id: 'btn-jump', press: () => order({ type: 'ship.jump' }) }, jumpLabel, jumpNote);
    fightBar = { tiles, own, theirs, leave, jump, jumpNote, call: buildCall() };
    fightBar.node = el('div', { class: 'panel fightbar', id: 'fightbar', hidden: true }, own.node, el('div', { class: 'fightbar__weapons' }, tiles.map((t) => t.node)), theirs.node, jump, leave);
    return el('div', { class: 'fightstack' }, fightBar.call.node, fightBar.node);
  }

  /** The card that answers a hail or a surrender. Its buttons are built once and shown or hidden. */
  function buildCall() {
    const title = el('span', { class: 'stencil fightcall__title', id: 'fightcall-title' });
    const text = el('span', { class: 'fightcall__text', id: 'fightcall-text' });
    const clockText = el('small', { class: 'fightcall__clock', id: 'fightcall-clock' });
    const talk = button('btn-talk', 'Talk', () => order({ type: 'fight.talk' }));
    const bribe = button('btn-bribe', 'Pay', () => order({ type: 'fight.bribe' }));
    const engage = button('btn-engage', 'Open fire', () => order({ type: 'fight.engage' }), 'btn--danger');
    const accept = button('btn-accept', 'Accept', () => order({ type: 'fight.accept' }));
    const refuse = button('btn-refuse', 'Refuse', () => order({ type: 'fight.refuse' }), 'btn--danger');
    const node = el('div', { class: 'panel fightcall', id: 'fightcall', hidden: true }, el('div', { class: 'fightcall__words' }, title, text, clockText), el('div', { class: 'fightcall__buttons' }, talk, bribe, engage, accept, refuse));
    return { node, title, text, clock: clockText, talk, bribe, engage, accept, refuse };
  }

  function updateCall(fight, enemy) {
    const call = fightBar.call;
    const hailing = !fight.over && fight.phase === 'hail';
    const offer = !fight.over ? fight.offer : null;
    const show = hailing || Boolean(offer);
    if (call.node.hidden !== !show) call.node.hidden = !show;
    if (!show) return;
    const name = enemy.layout.name;
    const toggle = (node, on) => node.hidden !== !on && (node.hidden = !on);
    toggle(call.talk, hailing && !fight.talked);
    toggle(call.bribe, hailing);
    toggle(call.engage, hailing);
    toggle(call.accept, Boolean(offer));
    toggle(call.refuse, Boolean(offer));
    if (hailing) {
      const hail = enemy.layout.tactics.hail;
      setText(call.title, `${name} hails us`);
      setText(call.text, `"${hail.text}"`);
      setText(call.clock, `They open fire in ${seconds(fight.hailEnds - sim.state.tick)}`);
      setText(call.talk, `Talk · ${percent(talkChance(sim))}`);
      setText(call.bribe, `Pay ${bribePrice(sim)} · have ${sim.state.money}`);
    } else {
      setText(call.title, `${name} surrenders`);
      setText(call.text, `They offer ${offerText(offer)}.`);
      setText(call.clock, `Offer stands ${seconds(offer.expires - sim.state.tick)}`);
    }
  }

  function updateSide(part, ship) {
    const { hull } = ship.state;
    setText(part.hull, `${hull.points}/${hull.max}`);
    const width = `${Math.round((hull.points / hull.max) * 100)}%`;
    if (part.fill.style.width !== width) part.fill.style.width = width;
    part.node.classList.toggle('is-alarm', hull.points <= hull.max * 0.3);
    setText(part.line, `Shields ${shieldLayers(ship)}/${shieldMax(ship)} · Evade ${percent(evasion(ship))}`);
  }

  function weaponStatus(slot) {
    const state = sim.state.weapons[slot];
    const weapon = weaponOf(slot);
    if (!state.powered) return `No power: needs ${weapon.power}`;
    const aim = state.target ? enemyOf(sim)?.layout.room(state.target)?.name : null;
    if (chargeOf(sim, slot) < 1) return aim ? `Charging · ${aim}` : 'Charging · no target';
    const fight = sim.state.fight;
    if (fight && !fight.over && fight.phase === 'hail') return 'Holding fire: talking';
    return aim ? `Firing · ${aim}` : 'Ready · no target';
  }

  function updateFight() {
    const fight = sim.state.fight;
    if (fightBar.node.hidden !== !fight) fightBar.node.hidden = !fight;
    if (!fight && !fightBar.call.node.hidden) fightBar.call.node.hidden = true;
    if (!fight) {
      // The fight is gone: let go of anything that pointed at it.
      if (selectedWeapon !== null) selectWeapon(null);
      if (selected?.kind === 'foe') select(null);
      impacts = [];
      return;
    }
    const enemy = enemyOf(sim);
    updateSide(fightBar.own, sim);
    updateSide(fightBar.theirs, enemy);
    if (fight.fleeing && !fight.over) setText(fightBar.theirs.line, `Running · jump ${percent(jumpCharge(enemy))}`);
    setText(fightBar.theirs.name, fight.over ? OUTCOMES[fight.over.outcome] : enemy.layout.name);
    fightBar.leave.hidden = !fight.over;
    fightBar.jump.hidden = Boolean(fight.over);
    const charged = jumpCharge(sim);
    setText(fightBar.jumpNote, charged >= 1 ? 'Ready' : percent(charged));
    fightBar.jump.classList.toggle('is-ready', charged >= 1);
    updateCall(fight, enemy);
    for (const tile of fightBar.tiles) {
      const state = sim.state.weapons[tile.index];
      setText(tile.state, weaponStatus(tile.index));
      const width = `${Math.round(chargeOf(sim, tile.index) * 100)}%`;
      if (tile.charge.style.width !== width) tile.charge.style.width = width;
      tile.node.classList.toggle('is-selected', selectedWeapon === tile.index);
      tile.node.classList.toggle('is-dead', !state.powered);
      tile.node.classList.toggle('is-ready', state.powered && chargeOf(sim, tile.index) >= 1);
    }
  }

  // ---------- shots and their results, drawn over both ships ----------

  function drawFight(alpha) {
    const fight = sim.state.fight;
    if (!fight || !foe) return;
    const enemy = enemyOf(sim);
    // Their name, over their ship.
    ctx.fillStyle = 'rgba(233, 220, 195, 0.8)';
    ctx.font = "700 12px ui-monospace, 'SF Mono', Menlo, Consolas, monospace";
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const mid = foeView.ox + (enemy.layout.bounds.x + enemy.layout.bounds.w / 2) * foeView.scale;
    ctx.fillText(enemy.layout.name.toUpperCase(), mid, size.top + 4);

    const now = sim.state.tick - 1 + alpha; // the frame sits between the last tick and this one, as crew do
    for (const shot of fight.shots) {
      const ours = shot.side === 'player';
      const from = ours ? renderer.hardpointAt(view, shot.slot) : foe.renderer.hardpointAt(foeView, shot.slot);
      const to = ours ? foe.renderer.roomCentre(foeView, shot.room) : renderer.roomCentre(view, shot.room);
      const t = Math.max(0, Math.min(1, (now - shot.born) / (shot.lands - shot.born)));
      const tail = Math.max(0, t - 0.12);
      const at = (k) => ({ x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k });
      const head = at(t);
      const back = at(tail);
      const kinetic = sim.catalog.weapon(shot.weapon).kind === 'kinetic';
      ctx.lineCap = 'round';
      ctx.strokeStyle = kinetic ? 'rgba(233, 220, 195, 0.55)' : 'rgba(255, 179, 71, 0.9)';
      ctx.lineWidth = kinetic ? 2 : 4;
      ctx.beginPath();
      ctx.moveTo(back.x, back.y);
      ctx.lineTo(head.x, head.y);
      ctx.stroke();
      ctx.fillStyle = kinetic ? '#e9dcc3' : '#fff3d6';
      ctx.beginPath();
      ctx.arc(head.x, head.y, kinetic ? 4 : 3, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
    ctx.lineCap = 'butt';
  }

  /** The room's rectangle in CSS pixels. */
  const roomBox = (shipLayout, v, roomId) => {
    const room = shipLayout.room(roomId);
    return { x: v.ox + room.x * v.scale, y: v.oy + room.y * v.scale, w: room.w * v.scale, h: room.h * v.scale };
  };

  /**
   * What the last shots did, on either ship: a flash over a room that was hit, a ring where
   * each shot landed, and words for the result and what it did, so it never rests on colour alone.
   */
  function drawImpacts(alpha) {
    const now = sim.state.tick - 1 + alpha;
    impacts = impacts.filter((impact) => (now - impact.tick) * TICK_SECONDS < IMPACT_SECONDS && now >= impact.tick - 1);
    const enemy = enemyOf(sim);
    for (const impact of impacts) {
      const age = Math.max(0, ((now - impact.tick) * TICK_SECONDS) / IMPACT_SECONDS);
      const ours = impact.side === 'player'; // our shot, so it landed on them
      const r = ours ? foe?.renderer : renderer;
      const v = ours ? foeView : view;
      const shipLayout = ours ? enemy?.layout : layout;
      if (!r || !v || !shipLayout?.room(impact.room)) continue;
      const at = r.roomCentre(v, impact.room);
      const colour = impact.result === 'hit' ? '255, 120, 40' : impact.result === 'shield' ? '127, 212, 255' : '233, 220, 195';
      const flash = impact.result === 'hit' ? 1 - (age * IMPACT_SECONDS) / FLASH_SECONDS : 0;
      if (flash > 0) {
        const box = roomBox(shipLayout, v, impact.room);
        ctx.fillStyle = `rgba(255, 214, 150, ${0.55 * flash})`;
        ctx.fillRect(box.x, box.y, box.w, box.h);
      }
      if (impact.result !== 'miss') {
        ctx.strokeStyle = `rgba(${colour}, ${1 - age})`;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(at.x, at.y, 6 + age * v.scale * 1.4, 0, Math.PI * 2);
        ctx.stroke();
      }
      const fade = 1 - age * age;
      ctx.fillStyle = `rgba(${colour}, ${fade})`;
      ctx.font = "700 13px ui-monospace, 'SF Mono', Menlo, Consolas, monospace";
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const rise = age * 14;
      ctx.fillText(impact.result === 'hit' ? `${IMPACT_TEXT.hit} ${impact.damage}` : IMPACT_TEXT[impact.result], at.x, at.y - 14 - rise);
      const words = effectWords(impact.effects);
      if (words) {
        ctx.font = "700 10px ui-monospace, 'SF Mono', Menlo, Consolas, monospace";
        ctx.fillStyle = `rgba(255, 214, 150, ${fade})`;
        ctx.fillText(words, at.x, at.y + 2 - rise, Math.max(60, v.scale * shipLayout.room(impact.room).w + 30));
      }
    }
    // A hit on our ship: the edges of the screen flash red for a moment.
    const struck = shake ? 1 - ((now - shake.tick) * TICK_SECONDS) / FLASH_SECONDS : 0;
    if (struck > 0) {
      ctx.strokeStyle = `rgba(214, 64, 52, ${0.6 * struck})`;
      ctx.lineWidth = 10;
      ctx.strokeRect(5, 5, size.w - 10, size.h - 10);
    }
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }

  /** How far to shake the screen this frame, in pixels: nothing while paused or with shake turned off. */
  function shakeOffset(alpha) {
    if (!shake || clock.paused || settings?.values.shake === false) return { x: 0, y: 0 };
    const t = (sim.state.tick - 1 + alpha - shake.tick) * TICK_SECONDS;
    if (t < 0 || t > SHAKE_SECONDS) return { x: 0, y: 0 };
    const k = shake.strength * (1 - t / SHAKE_SECONDS) ** 2;
    // A fixed wobble, not dice: the screen is not part of the game, and all randomness goes through the seeded generator.
    return { x: k * Math.sin(t * 71), y: k * Math.cos(t * 53) };
  }

  /** Which rooms the weapons of `ship` are pointed at: Map of room id -> [slots]. */
  function aimedBy(ship) {
    const aimed = new Map();
    ship.state.weapons.forEach((slot, index) => {
      if (slot.target !== null) aimed.set(slot.target, [...(aimed.get(slot.target) ?? []), index]);
    });
    return aimed;
  }

  function selectCrew(id) {
    selectedCrew = id;
    if (id) selected = null;
    if (id) selectedWeapon = null;
    nodes.info.hidden = true;
    buildPanel();
  }

  function buildRoster() {
    const chips = ourCrew(sim).map(({ member }) => {
      const health = el('i', { class: 'crewchip__health' });
      const task = el('span', { class: 'crewchip__task' });
      const node = el(
        'button',
        { class: 'btn crewchip', type: 'button', id: `crew-${member.id}`, press: () => selectCrew(selectedCrew === member.id ? null : member.id) },
        el('span', { class: 'crewchip__num', style: `background:${renderer.crewColour(member.index)}` }, String(member.index + 1)),
        el('span', { class: 'crewchip__body' }, el('span', { class: 'crewchip__name' }, member.name), task, el('span', { class: 'crewchip__bar' }, health)),
      );
      return { id: member.id, node, health, task };
    });
    roster = chips;
    return el('div', { class: 'crewbar', id: 'crewbar' }, chips.map((chip) => chip.node));
  }

  function updateRoster() {
    for (const chip of roster) {
      const found = findCrew(sim, chip.id);
      if (!found) continue;
      const { member, ship } = found;
      const away = ship !== sim && member.alive;
      setText(chip.task, member.alive ? `${away ? 'Aboard: ' : ''}${CHIP_TASKS[member.task] ?? 'Standing by'}` : 'Dead');
      chip.node.classList.toggle('is-away', away);
      const width = `${Math.round(member.health * 100)}%`;
      if (chip.health.style.width !== width) chip.health.style.width = width;
      chip.node.classList.toggle('is-selected', selectedCrew === chip.id);
      chip.node.classList.toggle('is-dead', !member.alive);
      chip.node.classList.toggle('is-hurt', member.alive && member.health < 0.35);
    }
  }

  function buildPanel() {
    panel = null;
    if (selectedCrew) {
      const { member } = findCrew(sim, selectedCrew);
      const stats = { health: stat('Health'), where: stat('In'), doing: stat('Doing'), suit: stat('Suit') };
      const suit = button('btn-suit', 'Suit up', () => order({ type: 'crew.suit', crew: member.id, on: !findCrew(sim, member.id).member.suit }));
      const note = el('span', { class: 'status__note' });
      nodes.status.replaceChildren(
        el('div', { class: 'status__head' }, el('div', { class: 'status__title', id: 'status-title' }, member.name), el('div', { class: 'stencil' }, `Crew ${member.index + 1}`), note),
        el('div', { class: 'status__stats' }, Object.values(stats).map((s) => s.node)),
        el(
          'div',
          { class: 'status__controls' },
          suit,
          debug && button('btn-dbg-hurt', 'Hurt', () => order({ type: 'debug.crew', crew: member.id, health: Math.max(0.05, findCrew(sim, member.id).member.health - 0.3) }), 'btn--debug'),
          el('span', { class: 'status__hint status__hint--inline', id: 'crew-hint' }, sim.state.fight ? 'Tap a room to send them there, or a room of theirs to board.' : 'Tap a room to send them there.'),
        ),
      );
      panel = { kind: 'crew', id: member.id, stats, suit, note };
      updatePanel();
      return;
    }
    if (selectedWeapon !== null) {
      const weapon = weaponOf(selectedWeapon);
      const stats = { needs: stat('Needs'), charge: stat('Charge'), damage: stat('Damage'), target: stat('Aimed at') };
      setText(stats.needs.value, `${weapon.power} ${weapon.power === 1 ? 'bar' : 'bars'}`);
      setText(stats.damage.value, `${weapon.damage}${weapon.pierce ? `, ignores ${weapon.pierce} shield` : ''}`);
      const slot = selectedWeapon;
      const clear = button('btn-clear-target', 'Hold fire', () => order({ type: 'weapon.target', slot, room: null }));
      const note = el('span', { class: 'status__note' });
      nodes.status.replaceChildren(
        el('div', { class: 'status__head' }, el('div', { class: 'status__title', id: 'status-title' }, weapon.name), el('div', { class: 'stencil' }, `Weapon ${slot + 1}`), note),
        el('div', { class: 'status__stats' }, Object.values(stats).map((s) => s.node)),
        el('div', { class: 'status__controls' }, clear, el('span', { class: 'status__hint status__hint--inline', id: 'weapon-hint' }, 'Tap a room on their ship to aim it there.')),
      );
      panel = { kind: 'weapon', slot, stats, clear, note };
      updatePanel();
      return;
    }
    if (selected?.kind === 'foe') {
      const enemy = enemyOf(sim);
      const room = enemy.layout.room(selected.id);
      const stats = { system: stat(room.system ? SYSTEMS[room.system].name : 'Room'), hull: stat('Hull'), fire: stat('Fire'), breach: stat('Breach'), oxygen: stat('Oxygen') };
      const note = el('span', { class: 'status__note' });
      nodes.status.replaceChildren(
        el('div', { class: 'status__head' }, el('div', { class: 'status__title', id: 'status-title' }, room.name), el('div', { class: 'stencil' }, enemy.layout.name), note),
        el('div', { class: 'status__stats' }, Object.values(stats).map((s) => s.node)),
        el('p', { class: 'status__hint' }, 'Their ship. Tap a weapon, then a room here, to aim at it.'),
      );
      panel = { kind: 'foe', id: room.id, sys: room.system ?? null, stats, note };
      updatePanel();
      return;
    }
    if (!selected) {
      nodes.status.replaceChildren(
        el('div', { class: 'stencil' }, layout.name),
        el('p', { class: 'status__hint' }, 'Tap a crew member, then a room, to send them there. Tap a room for its status, or a door to open or close it. Long-press anything to ask what it is.'),
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
    if (panel.kind === 'weapon') {
      const state = sim.state.weapons[panel.slot];
      const weapon = weaponOf(panel.slot);
      setText(panel.stats.charge.value, state.powered ? `${Math.floor(state.charge)} of ${weapon.charge}s` : 'no power');
      panel.stats.charge.node.classList.toggle('is-alarm', !state.powered);
      setText(panel.stats.target.value, state.target ? (enemyOf(sim)?.layout.room(state.target)?.name ?? 'nothing') : 'nothing');
      panel.clear.disabled = state.target === null;
      setText(panel.note, queuedFor('slot', panel.slot) ? 'Order queued' : refusalText() || (state.powered ? '' : 'Route power to weapons (WPN) to charge it.'));
      return;
    }
    if (panel.kind === 'foe') {
      const enemy = enemyOf(sim);
      if (!enemy) return;
      const r = enemy.state.rooms[panel.id];
      if (panel.sys) {
        const system = enemy.state.systems[panel.sys];
        const works = system.level - system.damage;
        setText(panel.stats.system.value, panel.sys === 'reactor' ? `${works} of ${system.level} bars` : POWERED.includes(panel.sys) ? `power ${system.power} of ${works}` : system.damage ? 'damaged' : 'working');
        panel.stats.system.node.classList.toggle('is-alarm', system.damage > 0);
      } else setText(panel.stats.system.value, 'no system');
      setText(panel.stats.hull.value, percent(r.hull));
      setText(panel.stats.fire.value, r.fire > 0 ? percent(r.fire) : 'none');
      setText(panel.stats.breach.value, r.breach > 0 ? percent(r.breach) : 'none');
      setText(panel.stats.oxygen.value, percent(r.oxygen));
      setText(panel.note, refusalText());
      return;
    }
    if (panel.kind === 'crew') {
      const found = findCrew(sim, panel.id);
      if (!found) return;
      const { member, ship } = found;
      setText(panel.stats.health.value, member.alive ? percent(member.health) : 'dead');
      panel.stats.health.node.classList.toggle('is-alarm', !member.alive || member.health < 0.35);
      setText(panel.stats.where.value, ship === sim ? layout.room(member.room).name : `Their ${ship.layout.room(member.room).name.toLowerCase()}`);
      panel.stats.where.node.classList.toggle('is-alarm', ship !== sim);
      setText(panel.stats.doing.value, describeTask(ship, member));
      setText(panel.stats.suit.value, member.suit ? 'on (slower)' : 'off');
      setText(panel.suit, member.suit ? 'Suit off' : 'Suit up');
      panel.suit.disabled = !member.alive;
      setText(panel.note, queuedFor('crew', panel.id) ? 'Order queued' : refusalText());
      return;
    }
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
    const target = pickTarget(allTargets(), x, y, pointerType);
    if (!target) {
      selectedCrew = null;
      selectedWeapon = null;
      select(null);
      return;
    }
    if (target.kind === 'foe') {
      // A weapon is selected: a room of theirs is what it should shoot. It stays selected, to change its mind.
      if (selectedWeapon !== null) order({ type: 'weapon.target', slot: selectedWeapon, room: target.id });
      // Someone of ours is selected: that is where they board (or, aboard already, go next).
      else if (selectedCrew) order({ type: 'crew.move', crew: selectedCrew, room: target.id, ship: 'them' });
      else select({ kind: 'foe', id: target.id });
      return;
    }
    if (target.kind === 'crew') {
      selectCrew(selectedCrew === target.id ? null : target.id);
      return;
    }
    if (target.kind === 'room' && selectedCrew) {
      // Someone is selected: a room is where they should go. They stay selected for the next order.
      order({ type: 'crew.move', crew: selectedCrew, room: target.id, ship: 'us' });
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
    const text = describe(pickTarget(allTargets(), x, y, pointerType)) ?? 'Open space. Cold, and a long way from anywhere.';
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
    if (action.startsWith('weapon-')) {
      const slot = Number(action.slice(7)) - 1;
      if (sim.state.fight && sim.state.weapons[slot]) selectWeapon(selectedWeapon === slot ? null : slot);
      return;
    }
    if (action.startsWith('select-')) {
      const member = ourCrew(sim)[Number(action.slice(7)) - 1]?.member;
      if (member) selectCrew(selectedCrew === member.id ? null : member.id);
      return;
    }
    if (action !== 'back') return;
    if (sheet) openSheet(sheet);
    else if (selectedWeapon !== null) selectWeapon(null);
    else if (selectedCrew) selectCrew(null);
    else if (selected) select(null);
    else onBack();
  }

  // ---------- screen lifecycle ----------

  function build() {
    nodes = {
      clock: el('pre', { class: 'shipbar__clock', id: 'ship-clock' }),
      status: el('div', { class: 'panel status', id: 'status' }),
      info: el('div', { class: 'ship-info', id: 'ship-info', hidden: true }),
      pauseLabel: el('span', {}, 'Pause'),
      pauseNote: el('small', { id: 'pause-note' }, 'Space bar'),
      aiText: el('span', { class: 'aibox__text', id: 'ai-text' }),
      sheet: el('div', { class: 'panel sheet', id: 'sheet', hidden: true }),
    };
    nodes.ai = el(
      'div',
      { class: 'panel aibox', id: 'aibox' },
      el('span', { class: 'stencil aibox__name' }, 'M.A.R.G.O.'),
      nodes.aiText,
      button('btn-log', 'Log', () => openSheet('log')),
      settings && button('btn-settings', 'Settings', () => openSheet('settings')),
    );
    nodes.pause = el('button', { class: 'btn btn--pause', type: 'button', id: 'btn-pause', press: () => clock.toggle() }, nodes.pauseLabel, nodes.pauseNote);
    nodes.top = el(
      'div',
      { class: 'shipbar' },
      el('div', { class: 'panel shipbar__name' }, el('div', { class: 'stencil' }, layout.name), nodes.clock),
      buildRoster(),
      el(
        'div',
        { class: 'shipbar__buttons' },
        debug && button('btn-dbg-step', 'Step', () => clock.stepOnce(), 'btn--debug'),
        debug && button('btn-dbg-hit', 'Hit us', () => order({ type: 'debug.hit', at: 'us', room: selected?.kind === 'room' ? selected.id : null, weapon: heaviestGun(), force: true }), 'btn--debug'),
        debug && button('btn-dbg-fight', 'Fight', () => order({ type: 'debug.fight', enemy: sim.state.fight ? null : sim.catalog.enemies[0] }), 'btn--debug'),
        debug && button('btn-dbg-menu', 'More', () => openSheet('debug'), 'btn--debug'),
        button('btn-back', 'Back', onBack),
      ),
    );
    nodes.bottom = el('div', { class: 'shipdock' }, nodes.sheet, nodes.ai, buildFightBar(), el('div', { class: 'shipdock__row' }, nodes.status, nodes.pause), buildPower());
    root.replaceChildren(el('section', { class: 'ship' }, nodes.top, nodes.bottom, nodes.info));
    buildPanel();
  }

  let lastClock = '';
  function updateClock() {
    // Fixed width, so the bar beside it never reflows as the time ticks.
    const text = `${clock.paused ? 'PAUSED ' : 'running'} ${stamp(sim.state.tick)}`;
    if (text !== lastClock) {
      lastClock = text;
      nodes.clock.textContent = text;
    }
    const label = clock.paused ? 'Resume' : 'Pause';
    if (nodes.pauseLabel.textContent !== label) {
      nodes.pauseLabel.textContent = label;
      nodes.pause.classList.toggle('is-paused', clock.paused);
    }
    if (!clock.paused) notice = null;
    setText(nodes.pauseNote, notice ?? 'Space bar');
    nodes.pause.classList.toggle('is-auto', Boolean(notice));
  }

  return {
    enter() {
      sheet = null;
      build();
      // Whatever she said before this screen opened is shown whole, not typed again.
      const last = sim.state.ai.log.at(-1);
      typed = { n: last?.n ?? 0, start: -1e9, shown: -1 };
      canvas.hidden = false;
      size = { w: 0, h: 0, dpr: 1 }; // force a measure
      measure();
      subscriptions = [
        input.on('tap', onTap),
        input.on('info', onInfo),
        input.on('key', onKey),
        input.on('dragstart', () => (nodes.info.hidden = true)),
        sim.events.on('shot.resolved', (event) => {
          impacts.push({ side: event.side, room: event.room, result: event.result, damage: event.damage, effects: event.effects, tick: event.tick });
          if (event.side === 'enemy' && event.result === 'hit') shake = { tick: event.tick, strength: SHAKE_BASE + SHAKE_PER_DAMAGE * event.damage };
        }),
      ];
    },
    exit() {
      for (const stop of subscriptions) stop();
      subscriptions = [];
      canvas.hidden = true;
    },
    /** Called every rendered frame, paused or not. */
    update() {
      updateFight(); // first: the weapons bar coming or going moves the space the ships are fitted to
      measure();
      const enemy = enemyOf(sim);
      const jolt = shakeOffset(clock.alpha);
      ctx.clearRect(0, 0, size.w, size.h);
      ctx.save();
      ctx.translate(jolt.x, jolt.y);
      renderer.draw(ctx, {
        clear: false,
        view,
        width: size.w,
        height: size.h,
        dpr: size.dpr,
        state: sim.state,
        // Game time, so flames and alarms hold still while paused.
        time: (sim.state.tick + clock.alpha) * TICK_SECONDS,
        alpha: clock.alpha,
        selected: selected?.kind === 'foe' ? null : selected,
        selectedCrew,
        showVents,
        charges: sim.state.weapons.map((_, slot) => chargeOf(sim, slot)),
        chosenWeapon: selectedWeapon,
        aimed: enemy ? aimedBy(enemy) : null,
      });
      if (enemy && foe) {
        foe.renderer.draw(ctx, {
          view: foeView,
          width: size.w,
          height: size.h,
          dpr: size.dpr,
          state: enemy.state,
          time: (sim.state.tick + clock.alpha) * TICK_SECONDS,
          alpha: clock.alpha,
          selected: selected?.kind === 'foe' ? selected : null,
          clear: false,
          charges: enemy.state.weapons.map((_, slot) => chargeOf(enemy, slot)),
          aimed: aimedBy(sim),
          inviting: selectedWeapon !== null && !sim.state.fight.over,
          selectedCrew,
        });
        drawFight(clock.alpha);
      }
      drawImpacts(clock.alpha);
      ctx.restore();
      updateClock();
      updatePanel();
      updatePower();
      updateRoster();
      updateVoice();
    },
    /** Say why the game just paused itself. Shown on the pause button until play resumes. */
    announce(text) {
      notice = text;
    },
    /** For automated tests and the debug console. */
    debug: {
      targets: () => renderer.targets(view, oursOn(sim)),
      foeTargets: () => (foe && foeView && enemyOf(sim) ? foe.renderer.targets(foeView, oursOn(enemyOf(sim)), { foe: true }) : []),
      get shake() {
        return shake;
      },
      get impacts() {
        return impacts;
      },
      get selectedWeapon() {
        return selectedWeapon;
      },
      get foeView() {
        return foeView;
      },
      get selectedCrew() {
        return selectedCrew;
      },
      get sheet() {
        return sheet;
      },
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
