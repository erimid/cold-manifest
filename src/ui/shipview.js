// The ship view: the main gameplay screen (brief §18).
//
// Tap a room to see its status and what can be done there, tap a door to open
// or close it, long-press (or right-click) anything for a description.
//
// From S2.7 the screen shows what Margo knows, not what is so (senses.js): a
// room of ours she cannot see into is drawn as last seen, behind static, and
// with nothing selected the status panel breaks our signature down and has
// the Go dark button. Boarders are drawn red aboard ours and cannot be selected.
// From S2.8 heavy guns show their rounds and can send someone for more, and the
// crates in the holds are drawn and can be tapped: open, move (then tap a
// room), jettison, or load the gun. Each goes to the crew member selected
// last, or the nearest free hand.
// From H.1 (D-151) the corner of the monitor is the passive scope: contacts as patches of space they could
// be in. Tap a return to read it and hail it with a lie; tap anywhere else on the dial to come round to
// that heading. With nothing selected the status panel lights or cuts the drive and puts out a flare.
// From H.3 (D-152) there is no enemy ship on the screen and no weapons bar: a contact's panel lays the
// deterrent gun on it (or holds fire), pays a toll and shows our gun's rounds; point defence looks after
// itself; Brace sits with the helm controls; drones and pods are drawn on the scope.
// From H.9 (D-251 to D-254) the screen is built round people: the crew down the left (a card each: face, post,
// watch, what they are doing, how they are), Margo's channel down the right (her face, the stations she holds,
// a running transcript of her and the crew, and the captain's reply chips), and her monitor between them with
// the ship across its full width. The bottom panels are gone: the card for whatever is picked (a room's
// actions, with its station's switches; a crew member; a crate; a contact; or with nothing picked the helm)
// sits on the monitor under the ship, beside the scope.

import { REFUSALS_PER_RUN, trustWord } from '../ai/judgement.js';
import { pickTarget } from '../engine/hit.js';
import { braced, capacitorOf, capacity, chargeOf, findCrew, gunChance, gunSlot, ourCrew, pdSlot, whyNoBrace, whyNoGun } from '../sim/combat.js';
import { GOALS, REASONS, OUTCOMES as BOARDING_OUTCOMES, bribeChance, describeBoarder, partyOf, whyNoBribe, whyNoYield } from '../sim/boarders.js';
import { HIDING, compartmentsFree, whyNoHide } from '../sim/agents.js';
import { describeTask } from '../sim/crew.js';
import { chill } from '../sim/cold.js';
import { BLUFFS, ENDINGS, bluffChance, findContact, scopeView, whyNoHail, whyNoPay } from '../sim/encounters.js';
import { describeJob, magazineOf, pickHand, roundsInHold } from '../sim/hold.js';
import { feudsOf, nerveWord, regardOf, regardWord, topMemory } from '../sim/memory.js';
import { OUTPUT, OUTPUT_LEVELS, POWERED, aiCoreStatus, litRooms, outputLimit } from '../sim/power.js';
import { COVERS, COVER_IDS, MANNERS, MANNER_IDS, MANNER_STATIONS, POSTS, STATIONS, STATION_IDS, holderOf, margoLoad, rating, reactorLoad, roomOfStation, running, stationOfRoom } from '../sim/stations.js';
import { hungryWord, onWatch, tiredWord, watchLeft, watchName } from '../sim/watches.js';
import { roomView, sensorsUp, signature, unseen } from '../sim/senses.js';
import { SPACE, SYSTEMS } from '../sim/systems.js';
import { roleOf, skillWords } from '../sim/roles.js';
import { TICK_SECONDS } from '../sim/sim.js';
import { SHIP_HOUR, clockText, hoursText } from '../sim/shipclock.js';
import { nearestHand, situationViews } from '../narrative/events.js';
import { createChart } from './chart.js';
import { el } from './dom.js';
import { createIntercom } from './intercom.js';
import { AUTO_PAUSE } from './settings.js';
import { createShipRenderer } from './ship-render.js';
import { controlInfo } from './help.js';
import { drawBody, skinOf } from './crew-art.js';
import { crewCardView, heldStations, roomStation } from './people.js';
import { createSituationCards } from './situations.js';
import { bearingText, drawScope, hunter, hunterText, rangeText, scopeDial, scopeHit, scopeMarks } from './scope.js';

/** What the contact panel says until Margo has made the ship out (F.2: then what beats it). */
const CONTACT_HINT = 'A hail is a lie told once. The gun cannot sink anything; it can make a ship think twice, and every round tells everyone where we are.';

const percent = (value) => `${Math.round(value * 100)}%`;
/** How many lines Margo's channel keeps (H.9). */
const CHANNEL_LINES = 80;
/** How long a crew member's reason for refusing stays in the status panel: long enough to read a whole sentence. */
const REFUSAL_MS = 7000;
/** How long a shot's result stays on screen, in seconds of game time. */
const IMPACT_SECONDS = 0.9;
const IMPACT_TEXT = { hit: 'HIT', shield: 'SHIELD', miss: 'MISS', warning: 'WARNING SHOT' };
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
/** What a crate is, in a few words for its panel. */
const CRATE_KIND = { ammo: 'Ordnance · rounds for the heavy guns', cargo: 'Company manifest', salvage: 'Salvage' };
/** Start a sentence with a capital: the sim's reasons are written to follow "because". */
const sentence = (text) => `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;

/** Ticks as whole seconds, rounded up. */
const seconds = (ticks) => `${Math.max(0, Math.ceil(ticks * TICK_SECONDS))}s`;

/** How fast the AI's lines type out, in characters per second of real time, and how often a character blips. */
const TYPE_SPEED = 45;
const BLIP_EVERY = 3;

/** How far the canvas reaches past the monitor's edge, in CSS pixels: room for its bezel stroke and a jolt. */
const CANVAS_MARGIN = 10;

export function createShipView({ canvas, root, input, sim, clock, tempo = null, onBack, audio = null, settings = null, debug = false, crewReplies = {} }) {
  const { layout } = sim;
  const intercom = createIntercom(crewReplies);
  const renderer = createShipRenderer(layout);
  const ctx = canvas.getContext('2d');
  let size = { x: 0, y: 0, w: 0, h: 0, dpr: 1 }; // the canvas: where it sits on the page, in CSS pixels
  let view = { scale: 1, ox: 0, oy: 0 };
  let selected = null; // { kind: 'room' | 'door', id }
  let selectedCrew = null; // a crew id; while set, tapping a room sends them there
  let lastHand = null; // the crew member selected last: crate orders go to them if they can take them
  let movingCrate = null; // a crate id; while set, tapping a room of ours has it carried there
  let monitor = { x: 0, y: 0, w: 0, h: 0 }; // Margo's schematic screen, in CSS pixels
  let shipBox = { x: 0, y: 0, w: 0, h: 0 }; // where the ship is drawn on it
  let scopeBox = null; // the passive scope (H.1)
  let boardCall = null; // the boarding card's live parts (H.2)
  let tollCall = null; // the toll card's live parts (H.3)
  let impacts = []; // rounds that just landed on us, for a moment: { room, result, damage, effects, tick }
  let shake = null; // { tick, strength } the last hit on our ship, while the screen shakes
  let crewCards = null; // the crew column's live parts (H.9)
  const channel = []; // Margo's channel (H.9): every line in it, hers and the crew's, kept across visits to port
  let channelN = 0; // the last of her lines put in the channel
  let showCrawlways = false;
  let subscriptions = [];
  let nodes = null;
  let panel = null; // the status panel's live parts for the current selection
  let refusal = null; // { text, until } the last order the ship refused, shown briefly
  let notice = null; // why the game paused itself, shown on the pause button until it resumes
  let typed = { n: 0, start: 0, shown: -1 }; // the AI line being typed out
  let sheet = null; // which pop-up sheet is open: 'settings' | 'debug' | null
  let chart = null; // Margo's route chart (chart.js), while there is a run
  let chartOpen = false; // the chart is up on the monitor, over the schematic
  let situations = null; // the cards at the rooms where something wants dealing with (H.7)
  const counts = { canvasTaps: 0, infos: 0 };

  // ---------- naming ----------

  const roomName = (id) => (id === SPACE ? 'space' : layout.room(id).name);
  /** The hardest-hitting weapon we carry: what the debug Hit us button is struck with. */
  const heaviestGun = () => sim.state.weapons.map((slot) => sim.catalog.weapon(slot.id)).reduce((a, b) => (b.damage > a.damage ? b : a)).id;
  /** The deterrent gun's slot, or -1. */
  const gun = () => gunSlot(sim);
  const weaponOf = (slot) => sim.catalog.weapon(sim.state.weapons[slot].id);

  function doorName(door) {
    return door.name ?? `Door, ${roomName(door.a)} to ${roomName(door.b)}`;
  }

  function describe(target) {
    if (target?.kind === 'room') {
      const room = layout.room(target.id);
      if (room.system) return `${room.name}. ${SYSTEMS[room.system].blurb}`;
      if (room.kind === 'helm') return `${room.name}. Where the ship is flown from.`;
      if (room.kind === 'lift') return `${room.name}. Runs on the lift motor. With that switched off, whoever rides it cranks it by hand, slowly.`;
      if (room.kind === 'hold' || room.kind === 'cargo') return `${room.name}. Where the paying cargo goes, when there is any.`;
      return `${room.name}. Gets you from one problem to the next.`;
    }
    if (target?.kind === 'crate') {
      const crate = sim.state.crates[target.id];
      if (!crate) return null;
      if (crate.kind === 'ammo') return `${crate.label}: ${crate.rounds} rounds for the slug thrower. Tap it to load the gun.`;
      return `${crate.label}${crate.contract ? ' (contract cargo)' : ''}. ${crate.spoiled ? 'Spoiled.' : crate.sealed ? 'Under a company seal.' : crate.contents ?? 'Opened.'}`;
    }
    if (target?.kind === 'crew') {
      const { member, ship } = findCrew(sim, target.id);
      const role = roleOf(member);
      return `${member.name}${role ? `, ${role.name.toLowerCase()}` : ''}. ${describeTask(ship, member)}.${member.alive ? ` Health ${percent(member.health)}.` : ''}${role ? ` ${role.blurb}` : ''}`;
    }
    if (target?.kind === 'door') {
      const door = layout.door(target.id);
      const state = sim.state.doors[door.id].state;
      return `${doorName(door)}: ${state}.${door.airlock ? ' Opens to space.' : ''}`;
    }
    return null;
  }

  /** What a long press on the scope says. */
  function describeScope(hit) {
    const contact = hit.contact !== undefined ? scopeView(sim).contacts.find((item) => item.id === hit.contact) : null;
    if (contact) return `${contact.label}, ${contact.name.toLowerCase()}. ${contact.stage ? `${contact.stageText}${contact.stage === 'gone' ? '' : `: ${Math.round(contact.certainty * 100)}% sure`}. The fan is its search beam, and the ring round it fills as it gets surer` : contact.intent}. Bearing ${bearingText(contact.bearing)}, give or take ${Math.round(contact.bearingError)} degrees; about ${rangeText(contact.range, contact.rangeError)}. The patch is where it could be.`;
    return 'The scope. It only listens: what it shows is what other ships give off, and how well the sensors hear it. A fan from a contact is its search beam: when it crosses us it gets a look, and the ring round the contact fills as it gets surer. Tap the dial to turn the ship that way.';
  }

  // ---------- layout ----------

  /**
   * The people-first screen (H.9, D-251): the crew down the left, Margo's channel down the right, and between them
   * her monitor. The ship takes the monitor's full width along the top; under it the card for whatever is picked
   * (a room's actions, a crew member, a contact, or with nothing picked the helm) and the scope.
   */
  function measure() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const slot = nodes.monitor.getBoundingClientRect();
    const box = { x: Math.round(slot.left), y: Math.round(slot.top), w: Math.round(slot.width), h: Math.round(slot.height) };
    if (dpr === size.dpr && box.x === monitor.x && box.y === monitor.y && box.w === monitor.w && box.h === monitor.h) return;
    monitor = { ...box, h: Math.max(160, box.h) };
    // The canvas covers only the monitor, not the whole screen (H.10, D-256): everything it draws is on the glass,
    // and on a Retina iPad a full-screen canvas is twice the pixels to clear and fill every frame. Its drawing
    // coordinates stay the screen's, so a point on it is where it is on the page.
    const area = { x: monitor.x - CANVAS_MARGIN, y: monitor.y - CANVAS_MARGIN, w: monitor.w + 2 * CANVAS_MARGIN, h: monitor.h + 2 * CANVAS_MARGIN };
    if (area.w !== size.w || area.h !== size.h || dpr !== size.dpr) {
      canvas.width = Math.round(area.w * dpr);
      canvas.height = Math.round(area.h * dpr);
    }
    Object.assign(canvas.style, { left: `${area.x}px`, top: `${area.y}px`, width: `${area.w}px`, height: `${area.h}px` });
    ctx.setTransform(dpr, 0, 0, dpr, -area.x * dpr, -area.y * dpr);
    size = { ...area, dpr };
    // The chart and the settings sheet take the whole monitor when they are up (D-106).
    const whole = { left: `${monitor.x}px`, top: `${monitor.y}px`, width: `${monitor.w}px`, height: `${monitor.h}px` };
    if (chart) Object.assign(chart.node.style, whole);
    Object.assign(nodes.sheet.style, whole);
    // The ship along the top, as wide as the glass allows and never more than three fifths of its height.
    const inner = { x: monitor.x + 7, y: monitor.y + 8, w: monitor.w - 14, h: monitor.h - 30 };
    const fitted = renderer.fit({ ...inner, h: Math.round(inner.h * 0.6) });
    const tall = (layout.bounds.h + (layout.facing === 'up' ? 1.6 : 0)) * fitted.scale;
    const spare = Math.round(inner.h * 0.6) - tall;
    view = { ...fitted, oy: fitted.oy - spare / 2 };
    shipBox = { x: inner.x, y: inner.y, w: inner.w, h: Math.round(tall) };
    // Under it, the picked thing's card on the left and the scope on the right (H.1), as square as there is room for.
    const below = { y: inner.y + shipBox.h + 12, h: inner.h - shipBox.h - 12 };
    const side = Math.round(Math.max(200, Math.min(below.h, inner.w * 0.44, 380)));
    scopeBox = { x: inner.x + inner.w - side, y: below.y, w: side, h: below.h };
    Object.assign(nodes.status.style, { left: `${inner.x}px`, top: `${below.y}px`, width: `${inner.w - side - 12}px`, height: `${below.h}px` });
  }

  /** Our own people aboard a ship: the ones that can be tapped. Their boarders are only looked at. */
  const oursOn = (ship) => Object.values(ship.state.crew).filter((member) => member.owner === 'player');

  /** Everything tappable on the canvas: our ship, our crew and the crates. */
  function allTargets() {
    return renderer.targets(view, oursOn(sim), { crates: sim.state.crates });
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

  /** When a line was said, on the ship clock (H.8). */
  const stamp = (tick) => clockText(tick);

  /**
   * Her new lines go into the channel as she says them, and the newest types out a few characters a frame. Real
   * time, so a line finishes even if the game pauses on it.
   */
  function updateVoice() {
    for (const line of sim.state.ai.log) {
      if (line.n <= channelN) continue;
      channelN = line.n;
      addLine({ who: 'margo', n: line.n, tick: line.tick, text: line.text });
      typed = { n: line.n, start: performance.now(), shown: -1 };
    }
    const last = sim.state.ai.log.at(-1);
    if (!last || !nodes.aiText) return;
    const now = performance.now();
    if (last.n !== typed.n) return;
    const count = Math.min(last.text.length, Math.floor(((now - typed.start) / 1000) * TYPE_SPEED));
    if (count !== typed.shown) {
      if (count > typed.shown && count < last.text.length && count % BLIP_EVERY === 0) audio?.play('blip');
      typed.shown = count;
      nodes.aiText.textContent = last.text.slice(0, count);
      nodes.ai.classList.toggle('is-typing', count < last.text.length);
      if (count < last.text.length) nodes.log.scrollTop = nodes.log.scrollHeight;
    }
    nodes.ai.classList.toggle('is-urgent', last.priority >= 4 && Boolean(sim.state.ai.speaking));
  }

  /** What one of our crew just said over the intercom: a line in Margo's channel, in their name. */
  function hear(event, roomId) {
    const found = findCrew(sim, event.crew);
    if (!found) return;
    const said = intercom.reply(event, found.ship.layout.room(roomId)?.name ?? 'there');
    if (!said) return;
    addLine({ who: found.member.id, name: found.member.name, colour: renderer.crewColour(found.member.index), tick: sim.state.tick, text: said.text });
    audio?.play('blip');
  }

  /** An order Margo is holding (judgement.js): her box turns red and offers the captain's two answers, one tap each. */
  function updateObjection() {
    const held = sim.state.ai.objection;
    if (nodes.objection.hidden === Boolean(held)) {
      nodes.objection.hidden = !held;
      nodes.ai.classList.toggle('is-objecting', Boolean(held));
    }
    if (!held) return setText(nodes.aiName, 'M.A.R.G.O.');
    const left = Math.max(0, Math.ceil((held.expires - sim.state.tick) * TICK_SECONDS));
    setText(nodes.aiName, `M.A.R.G.O. ${held.kind === 'refuse' ? 'refuses' : 'objects'} · holding your order ${left}s`);
    setText(nodes.override, held.kind === 'refuse' ? "Captain's override" : 'Do it anyway');
    const answered = sim.state.commands.some((command) => command.type === 'captain.override' || command.type === 'captain.standDown');
    nodes.override.disabled = answered;
    nodes.standDown.disabled = answered;
  }

  function drawSettings() {
    const toggle = (id, label, path, on) => el('button', { class: `btn btn--small btn--toggle${on ? ' is-on' : ''}`, type: 'button', id, 'aria-pressed': String(on), press: () => {
      settings.set(path, !on);
      drawSettings();
    } }, label, el('small', {}, on ? 'On' : 'Off'));
    nodes.sheet.replaceChildren(
      el('div', { class: 'stencil' }, 'Settings'),
      el('div', { class: 'sheet__pairs sheet__pairs--four' }, toggle('set-sound', 'Sound', 'sound', settings.values.sound), toggle('set-shake', 'Screen shake', 'shake', settings.values.shake), toggle('set-scanlines', 'Scanlines', 'scanlines', settings.values.scanlines !== false), toggle('set-fast', 'Fast time', 'fastTime', settings.values.fastTime !== false)),
      el('div', { class: 'stencil sheet__sub' }, 'Pause the game when'),
      el('div', { class: 'sheet__pairs' }, ...AUTO_PAUSE.map((item) => toggle(`set-pause-${item.id}`, item.label, `autoPause.${item.id}`, settings.values.autoPause[item.id]))),
    );
  }

  function openSheet(which) {
    sheet = sheet === which ? null : which;
    nodes.sheet.hidden = sheet === null;
    nodes.sheet.className = `panel sheet sheet--${sheet}`;
    if (sheet === 'settings') drawSettings();
    if (sheet === 'debug') drawDebug();
  }

  /** Debug only: the gun, Margo, memories, the chart, the contract, events and the scope. */
  function drawDebug() {
    // Whose head the memory buttons write into: whoever was picked last, if they are aboard and alive.
    const mind = Object.values(sim.state.crew).find((member) => member.id === lastHand && member.alive && member.owner === 'player') ?? Object.values(sim.state.crew).find((member) => member.alive && member.owner === 'player') ?? null;
    const act = (fn) => () => {
      fn();
      openSheet('debug');
    };
    nodes.sheet.replaceChildren(
      el('div', { class: 'stencil' }, 'Debug: guns'),
      el(
        'div',
        { class: 'sheet__grid' },
        button('btn-dbg-gun-load', 'Load the gun', act(() => order({ type: 'debug.gun', load: true })), 'btn--debug'),
        button('btn-dbg-gun-charge', 'Charge the mounts', act(() => order({ type: 'debug.gun', charge: true })), 'btn--debug'),
        sim.state.run && button('btn-dbg-fix', 'Get our fix', act(() => order({ type: 'debug.run', fix: true })), 'btn--debug'),
      ),
      el('div', { class: 'stencil sheet__sub', id: 'dbg-trust' }, `Margo: trust ${Math.round(sim.state.ai.trust)} (${trustWord(sim.state.ai.trust)}), refused ${sim.state.ai.refusals} of ${REFUSALS_PER_RUN}`),
      el(
        'div',
        { class: 'sheet__grid' },
        button('btn-dbg-trust-down', 'Trust -20', act(() => order({ type: 'debug.ai', trust: Math.max(0, sim.state.ai.trust - 20) })), 'btn--debug'),
        button('btn-dbg-trust-up', 'Trust +20', act(() => order({ type: 'debug.ai', trust: Math.min(100, sim.state.ai.trust + 20) })), 'btn--debug'),
        button('btn-dbg-refusals', 'Refusals back', act(() => order({ type: 'debug.ai', refusals: 0 })), 'btn--debug'),
      ),
      mind && el('div', { class: 'stencil sheet__sub' }, `Memories for ${mind.name}${selected?.kind === 'room' ? `, about ${roomName(selected.id)}` : ''}`),
      mind &&
        el(
          'div',
          { class: 'sheet__grid' },
          ...[['death', 'A death there'], ['burn', 'Burns'], ['choke', 'No air'], ['scare', 'Scared of the dark'], ['override', 'Overridden']].map(([memory, label]) =>
            button(`btn-dbg-mem-${memory}`, label, act(() => order({ type: 'debug.memory', crew: mind.id, memory, room: selected?.kind === 'room' ? selected.id : mind.room })), 'btn--debug'),
          ),
          button('btn-dbg-dread', 'Nerves on edge', act(() => order({ type: 'debug.memory', crew: mind.id, dread: 0.97 })), 'btn--debug'),
        ),
      sim.state.run && el('div', { class: 'stencil sheet__sub' }, `Chart: fuel ${sim.state.run.fuel}, hour ${Math.floor(sim.state.run.hours)} of ${sim.state.run.deadline}, ${sim.state.run.crossing ? sim.state.run.crossing.phase : 'in port'}, ${sim.state.run.pursuit ? (sim.state.run.pursuit.done ? 'follower beaten' : 'followed') : 'nobody following'}`),
      sim.state.run &&
        el(
          'div',
          { class: 'sheet__grid' },
          button('btn-dbg-fuel', 'Fill the tanks', act(() => order({ type: 'debug.run', fuel: sim.state.run.fuelMax })), 'btn--debug'),
          button('btn-dbg-fuel-out', 'Empty the tanks', act(() => order({ type: 'debug.run', fuel: 0 })), 'btn--debug'),
          button('btn-dbg-chase', sim.state.run.pursuit ? 'Nobody follows' : 'Someone follows', act(() => order({ type: 'debug.run', pursuit: sim.state.run.pursuit ? 'off' : 'on' })), 'btn--debug'),
          button('btn-dbg-caught', 'Follower finds us', act(() => order({ type: 'debug.run', pursuit: 'catch' })), 'btn--debug'),
          // Under way (H.6): on along this lane to the next thing on it.
          button('btn-dbg-skip', 'Skip along the lane', act(() => order({ type: 'debug.run', skip: true })), 'btn--debug'),
        ),
      sim.state.run?.contract?.status === 'active' &&
        el(
          'div',
          { class: 'sheet__grid' },
          // The contract (S3.4): put the rest of its cargo aboard (works a claim), or fail it.
          button('btn-dbg-load', 'Load all the cargo', act(() => order({ type: 'debug.contract', load: true })), 'btn--debug'),
          button('btn-dbg-fail', 'Fail the contract', act(() => order({ type: 'debug.contract', fail: 'lost' })), 'btn--debug'),
          button('btn-dbg-rich', '+100 credits', act(() => order({ type: 'debug.gun', money: true })), 'btn--debug'),
        ),
      sim.transit.all.length > 0 && el('div', { class: 'stencil sheet__sub' }, `Events: ${sim.state.run?.events.count ?? 0} met this run`),
      sim.transit.all.length > 0 &&
        el(
          'div',
          { class: 'sheet__grid' },
          sim.transit.all.map((event) => button(`btn-dbg-event-${event.id.replace(/\./g, '-')}`, event.id, act(() => order({ type: 'debug.event', event: event.id })), 'btn--debug')),
        ),
      sim.encounters.all.length > 0 && el('div', { class: 'stencil sheet__sub', id: 'dbg-scope' }, `Scope: ${sim.state.scope.contacts.length} on it${sim.state.scope.record.length ? `, last ended "${ENDINGS[sim.state.scope.record.at(-1).outcome]}"` : ''}`),
      sim.encounters.all.length > 0 &&
        el(
          'div',
          { class: 'sheet__grid' },
          // A contact far out on its own course, or already closing from near; and an empty scope.
          sim.encounters.all.map((def) => button(`btn-dbg-contact-${def.id}`, def.name, act(() => order({ type: 'debug.contact', encounter: def.id, range: 95, bearing: 40, miss: 15 })), 'btn--debug')),
          sim.encounters.all.map((def) => button(`btn-dbg-closing-${def.id}`, `${def.name}, closing`, act(() => order({ type: 'debug.contact', encounter: def.id, range: 45, bearing: 300, state: 'closing' })), 'btn--debug')),
          button('btn-dbg-contact-clear', 'Clear the scope', act(() => order({ type: 'debug.contact', clear: true })), 'btn--debug'),
          // A party at our lock at once (H.2), as if its ship had just docked; and the clamp off again.
          sim.encounters.all.filter((def) => def.party).map((def) => button(`btn-dbg-board-${def.id}`, `${def.name} docks`, act(() => order({ type: 'debug.boarding', encounter: def.id })), 'btn--debug')),
          button('btn-dbg-board-clear', 'Cast them off', act(() => order({ type: 'debug.boarding', clear: true })), 'btn--debug'),
        ),
      el('div', { class: 'stencil sheet__sub' }, 'View'),
      el('div', { class: 'sheet__grid' }, button('btn-crawlways', showCrawlways ? 'Hide crawlways' : 'Show crawlways', () => {
        showCrawlways = !showCrawlways;
        drawDebug();
      }, 'btn--debug')),
    );
  }



  // ---------- a station's switches, on its room's card (H.9) ----------

  /**
   * What the old switch panel did for one station, now on the card of the room it is in (H.9, D-252): stand it
   * down or to, who runs it with nobody on it (Fill in, Hers, Crew only: the hand-off to Margo), and how she runs
   * it. The reactor's room adds its three outputs, the lift's the lift motor.
   */
  function buildStation(id) {
    const parts = { id };
    parts.stand = el('button', { class: 'btn btn--small station__stand', type: 'button', id: `btn-stand-${id}`, 'aria-label': `Stand ${STATIONS[id].name} down or to`, press: () => order({ type: 'station.stand', station: id, down: !sim.state.stations[id].down }) }, 'On');
    parts.who = el('span', { class: 'station__who', id: `station-${id}` });
    parts.covers = id === 'ai_core' ? [] : COVER_IDS.map((cover) => ({ cover, node: button(`btn-cover-${cover}`, COVERS[cover].name, () => order({ type: 'station.cover', station: id, cover })) }));
    parts.manners = MANNER_STATIONS.includes(id) ? [null, ...MANNER_IDS].map((manner) => ({ manner, node: button(`btn-manner-${manner ?? 'own'}`, manner ? MANNERS[manner].name : 'Her way', () => order({ type: 'station.order', station: id, manner })) })) : [];
    parts.note = el('div', { class: 'status__hint station__note', id: 'margo-note' });
    parts.outputs = id === 'reactor' ? OUTPUT_LEVELS.map((level) => ({ level, node: button(`btn-output-${level}`, OUTPUT[level].name, () => order({ type: 'power.output', level })) })) : [];
    parts.node = el(
      'div',
      { class: 'station', id: `station-card-${id}` },
      el('div', { class: 'station__head' }, el('span', { class: 'stencil' }, STATIONS[id].name), parts.who, parts.stand),
      parts.outputs.length ? el('div', { class: 'status__controls station__row', id: 'switch-output' }, el('span', { class: 'stencil station__rowname' }, 'Output'), parts.outputs.map((o) => o.node)) : null,
      parts.covers.length ? el('div', { class: 'status__controls station__row', id: 'switch-margo' }, el('span', { class: 'stencil station__rowname' }, 'Margo'), parts.covers.map((c) => c.node)) : null,
      parts.manners.length ? el('div', { class: 'status__controls station__row' }, el('span', { class: 'stencil station__rowname' }, 'Runs it'), parts.manners.map((m) => m.node)) : null,
      parts.note,
    );
    return parts;
  }

  /** A lift's card has the lift motor and nothing else to do with a station. */
  function updateLift(node) {
    node.classList.toggle('is-on', sim.state.power.lift);
    node.setAttribute('aria-pressed', String(sim.state.power.lift));
    setText(node, sim.state.power.lift ? 'Lift motor on' : 'Lift motor off');
    node.title = sim.state.power.lift ? 'The lift motor is running.' : 'The lift motor is off: the lifts are cranked by hand.';
  }

  function updateStation(parts) {
    const { id } = parts;
    const station = STATIONS[id];
    const system = station.system ? sim.state.systems[station.system] : null;
    const entry = sim.state.stations[id];
    const run = rating(sim, id);
    setText(parts.who, `${holderText(id)}${run > 0 ? ` ${run.toFixed(1)}` : ''}`);
    parts.who.classList.toggle('is-dead', run === 0);
    setText(parts.stand, entry.down ? 'Off' : 'On');
    parts.stand.classList.toggle('is-on', !entry.down);
    parts.stand.setAttribute('aria-pressed', String(!entry.down));
    parts.stand.disabled = Boolean(system?.lost);
    for (const { cover, node } of parts.covers) {
      node.classList.toggle('is-on', entry.cover === cover);
      node.setAttribute('aria-pressed', String(entry.cover === cover));
      const why = entry.cover === cover ? null : sim.whyNot({ type: 'station.cover', station: id, cover });
      node.classList.toggle('is-blocked', Boolean(why));
      node.title = why ? sentence(why) : COVERS[cover].blurb;
    }
    for (const { manner, node } of parts.manners) {
      node.classList.toggle('is-on', entry.order === manner);
      node.setAttribute('aria-pressed', String(entry.order === manner));
      node.title = manner ? MANNERS[manner].blurb : 'Leave it to her judgement.';
    }
    const limit = outputLimit(sim);
    const output = sim.state.power.output;
    for (const { level, node } of parts.outputs) {
      node.classList.toggle('is-on', output === level && limit !== null);
      node.setAttribute('aria-pressed', String(output === level));
      const why = level === output ? null : sim.whyNot({ type: 'power.output', level });
      node.title = why ? sentence(why) : level === 'low' ? 'Everything works slower, and she runs cool.' : level === 'hard' ? 'Everything works faster, and she glows. Needs a hand on the reactor.' : 'The book figure.';
      node.classList.toggle('is-blocked', Boolean(why));
    }
    const load = margoLoad(sim);
    const stretched = load.held > load.attention ? ` She has ${load.held} stations and attention for ${Math.floor(load.attention)}.` : '';
    setText(parts.note, `${id === 'ai_core' ? 'Her own core.' : MANNER_STATIONS.includes(id) ? margoText(id) : 'She keeps the reactor at its output.'}${stretched}`);
  }

  /** Who has a station, in a word or two. */
  function holderText(id) {
    const by = holderOf(sim, id);
    if (by === null) return sim.state.stations[id].down ? 'Stood down' : sim.state.stations[id].cover === 'crew' ? 'Crew only' : 'Dark';
    if (id === 'ai_core') return 'Margo';
    if (by !== 'margo') return sim.state.crew[by]?.name ?? by;
    const runs = sim.state.stations[id].runs;
    return MANNER_STATIONS.includes(id) && runs !== 'book' ? `Margo, ${MANNERS[runs].say}` : 'Margo';
  }

  /** Why Margo is running a station the way she is, in a sentence. */
  const WHY = { air: 'the air is thin somewhere', hurt: 'someone hurt is in the medbay', boarded: 'there are boarders aboard', hunted: 'something out there is looking for us', found: 'something out there has found us', calm: 'nothing is coming, so she keeps it cool' };
  function margoText(id) {
    const entry = sim.state.stations[id];
    const by = holderOf(sim, id);
    const order = entry.order ? `Her order: ${MANNERS[entry.order].say}.` : 'Left to her.';
    if (by !== 'margo') return `${order} ${by ? 'A hand is on it: it runs their way.' : entry.cover === 'crew' ? 'Kept for the crew: dark with nobody on it.' : 'It is dark.'}`;
    const how = `Running it ${MANNERS[entry.runs].say}`;
    if (entry.against === 'own') return `${order} ${how}, her own way: ${WHY[entry.why] ?? 'she has her reasons'}.`;
    if (entry.against === 'doubt') return `${order} ${how}, as ordered, though she would not.`;
    return `${order} ${how}${entry.why && entry.why !== 'order' ? `: ${WHY[entry.why]}` : ''}.`;
  }

  // ---------- the crew column (H.9) ----------

  /**
   * The crew down the left of the screen (H.9, D-251): a card each, with their face, name, role, post, watch, what
   * they are doing and how they are. Tap a card to pick them, then a room to send them. The watch bill sits at
   * the head of the column, where the switch panel kept it.
   */
  function buildCrewColumn() {
    const watchNote = el('div', { class: 'crewcol__watch', id: 'watch-note' });
    const watches = [1, 2, 3].map((count) => ({ count, node: button(`btn-watches-${count}`, count === 1 ? 'All' : `${count}`, () => order({ type: 'roster.watches', count }), 'crewcol__watchbtn') }));
    for (const { count, node } of watches) node.setAttribute('aria-label', count === 1 ? 'All hands' : `${count} watches`);
    const muster = button('btn-muster', 'To stations', () => order({ type: 'roster.muster' }), 'crewcol__muster');
    const cards = ourCrew(sim).map(({ member }) => {
      const face = el('canvas', { class: 'crewcard__face', width: 96, height: 96, 'aria-hidden': 'true' });
      const name = el('span', { class: 'crewcard__name' }, member.name);
      const watch = el('span', { class: 'crewcard__watch' });
      const role = el('span', { class: 'crewcard__role' });
      const doing = el('span', { class: 'crewcard__doing' });
      const mood = el('span', { class: 'crewcard__mood' });
      const health = el('i', { class: 'crewcard__health' });
      const node = el(
        'button',
        { class: 'btn crewcard', type: 'button', id: `crew-${member.id}`, press: () => selectCrew(selectedCrew === member.id ? null : member.id) },
        el('span', { class: 'crewcard__num', style: `background:${renderer.crewColour(member.index)}` }, String(member.index + 1)),
        face,
        el('span', { class: 'crewcard__body' }, el('span', { class: 'crewcard__top' }, name, watch), role, doing, mood, el('span', { class: 'crewcard__bar' }, health)),
      );
      return { id: member.id, node, face, role, watch, doing, mood, health, drawn: '' };
    });
    crewCards = { cards, watchNote, watches, muster };
    return el(
      'aside',
      { class: `crewcol${cards.length > 6 ? ' crewcol--many' : ''}`, id: 'crewbar', 'aria-label': 'Crew' },
      el('div', { class: 'panel crewcol__head' }, el('div', { class: 'stencil' }, 'Crew'), watchNote, el('div', { class: 'crewcol__watches', id: 'switch-watch' }, watches.map((w) => w.node), muster)),
      el('div', { class: 'crewcol__cards' }, cards.map((card) => card.node)),
    );
  }

  /** A head and shoulders for a crew card, drawn with the same body as on the decks (D-132). Redrawn only when it changes. */
  function drawFace(card, member, view) {
    const key = `${view.alive}|${view.flags.suit ?? false}|${view.flags.asleep ?? false}`;
    if (card.drawn === key) return;
    card.drawn = key;
    const c = card.face.getContext('2d');
    c.clearRect(0, 0, 96, 96);
    c.fillStyle = '#0b0f14';
    c.fillRect(0, 0, 96, 96);
    if (!member) return;
    drawBody(c, { x: 48, feet: 168, s: 74, colour: renderer.crewColour(member.index), skin: skinOf(member.index), role: member.role, facing: 1, pose: 'stand', suit: Boolean(member.suit), dim: !view.alive });
  }

  function updateCrewColumn() {
    const { roster } = sim.state;
    const left = watchLeft(sim);
    setText(crewCards.watchNote, roster.watches > 1 ? `${watchName(roster.on)} watch · ${hoursText(left / SHIP_HOUR)} left` : roster.watches === 1 ? 'All hands' : 'No watch bill');
    for (const { count, node } of crewCards.watches) {
      node.classList.toggle('is-on', roster.watches === count);
      node.setAttribute('aria-pressed', String(roster.watches === count));
    }
    for (const card of crewCards.cards) {
      const view = crewCardView(sim, card.id);
      drawFace(card, sim.state.crew[card.id] ?? findCrew(sim, card.id)?.member ?? null, view);
      setText(card.role, view.taken || !view.alive ? view.role ?? '' : `${view.role} · ${view.post}`);
      setText(card.watch, view.watchTag ?? '');
      card.watch.title = view.watch ? `${view.watch} watch` : '';
      card.watch.classList.toggle('is-below', Boolean(view.below));
      setText(card.doing, view.doing);
      setText(card.mood, view.mood);
      card.node.title = view.detail ?? '';
      card.mood.classList.toggle('is-alarm', Boolean(view.alarm));
      const width = `${Math.round(view.health * 100)}%`;
      if (card.health.style.width !== width) card.health.style.width = width;
      const flags = view.flags ?? {};
      card.node.classList.toggle('is-selected', selectedCrew === card.id && !view.taken);
      card.node.classList.toggle('is-dead', !view.alive);
      card.node.classList.toggle('is-asleep', Boolean(flags.asleep));
      card.node.classList.toggle('is-tired', Boolean(flags.tired));
      card.node.classList.toggle('is-hungry', Boolean(flags.hungry));
      card.node.classList.toggle('is-slipping', Boolean(flags.slipping));
      card.node.classList.toggle('is-away', Boolean(view.away));
      card.node.classList.toggle('is-hurt', view.alive && Boolean(flags.hurt));
      card.node.setAttribute('aria-pressed', String(selectedCrew === card.id));
    }
  }

  // ---------- Margo's channel (H.9) ----------

  /**
   * Margo's channel down the right of the screen (H.9, D-253): her face, which stations she is holding, and a
   * running transcript where she and the crew speak; the captain answers with the reply chips under it (her
   * objection, a party at the lock, a toll). It takes the place of her text box, her log and the cards over the dock.
   */
  function buildChannel() {
    nodes.aiName = el('span', { class: 'stencil channel__name', id: 'ai-name' }, 'M.A.R.G.O.');
    nodes.heldNote = el('span', { class: 'channel__heldnote', id: 'margo-holding' });
    nodes.held = el('div', { class: 'channel__held', id: 'margo-held' });
    nodes.log = el('ol', { class: 'channel__log ailog', id: 'ailog', 'aria-live': 'polite' });
    // The captain's two answers when she holds an order: chips under the transcript, only while she does.
    nodes.override = button('btn-override', 'Do it anyway', () => order({ type: 'captain.override' }), 'btn--danger chip');
    nodes.standDown = button('btn-stand-down', 'Stand down', () => order({ type: 'captain.standDown' }), 'chip');
    nodes.objection = el('div', { class: 'channel__chips', id: 'objection', hidden: true }, nodes.standDown, nodes.override);
    nodes.ai = el(
      'aside',
      { class: 'panel channel aibox', id: 'aibox', 'aria-label': "Margo's channel" },
      el(
        'div',
        { class: 'channel__head' },
        el('div', { class: 'margo-face', 'aria-hidden': 'true' }, el('div', { class: 'margo-face__eye' }, el('div', { class: 'margo-face__iris' })), el('div', { class: 'margo-face__mouth' })),
        el('div', { class: 'channel__who' }, nodes.aiName, nodes.heldNote),
      ),
      nodes.held,
      nodes.log,
      el('div', { class: 'channel__calls' }, buildCalls(), nodes.objection),
    );
    nodes.aiText = null;
    nodes.intercom = null;
    // The transcript outlives the screen: coming back from port or an event shows it as it was, whole.
    for (const line of channel) addLine(line, true);
    return nodes.ai;
  }

  /** Put a line in the transcript: Margo's (amber) or a crew member's (their colour, their name). */
  function addLine(line, replay = false) {
    const text = el('span', { class: 'channel__text' }, line.text);
    const item = el(
      'li',
      { class: `channel__line channel__line--${line.who === 'margo' ? 'margo' : line.who === 'note' ? 'note' : 'crew'}` },
      el('time', {}, stamp(line.tick)),
      ' ',
      line.who === 'margo' || line.who === 'note' ? null : el('span', { class: 'channel__speaker', style: line.colour ? `color:${line.colour}` : '' }, `${line.name}: `),
      text,
    );
    nodes.log.append(item);
    while (nodes.log.children.length > CHANNEL_LINES) nodes.log.firstElementChild.remove();
    if (line.who === 'margo') {
      nodes.aiText?.removeAttribute('id');
      text.id = 'ai-text';
      nodes.aiText = text;
    } else if (line.who !== 'note') {
      nodes.intercom?.removeAttribute('id');
      nodes.intercom?.querySelector('#intercom-text')?.removeAttribute('id');
      item.id = 'intercom';
      text.id = 'intercom-text';
      nodes.intercom = item;
    }
    if (!replay) channel.push(line);
    if (channel.length > CHANNEL_LINES) channel.shift();
    nodes.log.scrollTop = nodes.log.scrollHeight;
    return text;
  }

  /** The head of the channel: the stations she is holding, each a tap away from its room's card (the hand-offs). */
  let heldKey = '';
  function updateHeld() {
    const { held, attention, stretched } = heldStations(sim);
    const key = `${held.map((h) => h.id).join(',')}|${attention}|${stretched}`;
    if (key === heldKey) return;
    heldKey = key;
    setText(nodes.heldNote, held.length ? `Holding ${held.length} station${held.length === 1 ? '' : 's'}${stretched ? `, attention for ${attention}` : ''}` : 'Holding no stations');
    nodes.heldNote.classList.toggle('is-alarm', stretched);
    nodes.held.replaceChildren(
      ...held.map((item) => el('button', { class: 'btn chip chip--station', type: 'button', id: `btn-held-${item.id}`, title: `${item.name}: open its room`, press: () => select({ kind: 'room', id: item.room }) }, item.code)),
    );
  }

  // A weapon order names a room on their ship, which may share an id with one of ours.
  const queuedFor = (key, id) => sim.state.commands.some((c) => c[key] === id && (key === 'slot') === c.type.startsWith('weapon.'));

  /** What the room panel says about a broken system, or null if it is whole (D-118). */
  function repairNote(roomId, sys) {
    const system = sim.state.systems[sys];
    if (!system.damage || system.lost) return null;
    const broken = `${system.damage} of ${system.level} ${system.level === 1 ? 'bar' : 'bars'} broken`;
    const here = Object.values(sim.state.crew).filter((m) => m.alive && m.owner === 'player' && m.room === roomId && !m.path.length);
    const fixer = here.find((m) => m.task === 'repair');
    if (fixer) return { busy: true, text: `${broken}. ${fixer.name} is repairing it: ${Math.floor((system.repair ?? 0) * 100)}% of the next bar.` };
    if (here.length) return { busy: true, text: `${broken}. ${here[0].name} will repair it once the room is safe.` };
    const coming = Object.values(sim.state.crew).find((m) => m.alive && m.owner === 'player' && m.goal === roomId);
    if (coming) return { busy: true, text: `${broken}. ${coming.name} is on the way to repair it.` };
    return { busy: false, text: `${broken}. Anyone standing in this room repairs it, about 8 s a bar.` };
  }

  // ---------- the status panel ----------

  function select(next) {
    selected = next;
    if (next?.kind !== 'crate') movingCrate = null;
    if (next) selectedCrew = null;
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

  /** Who a crate order goes to: whoever was selected last, if they can take it, else the nearest free hand. */
  function handFor(command) {
    if (lastHand && !sim.whyNot({ ...command, crew: lastHand })) return lastHand;
    const room = command.crate ? (sim.state.crates[command.crate]?.room ?? null) : sim.layout.roomOfSystem('weapons')?.id;
    const near = pickHand(sim, room ?? sim.layout.rooms[0].id);
    if (near && !sim.whyNot({ ...command, crew: near })) return near;
    // Anyone at all who could do it.
    return ourCrew(sim).map(({ member }) => member.id).find((id) => !sim.whyNot({ ...command, crew: id })) ?? near ?? lastHand;
  }

  /** Give a crate order (crate.open, crate.jettison, weapon.load...) to the right pair of hands. */
  function crateOrder(command) {
    const crew = handFor(command);
    if (!crew) {
      refusal = { text: 'Nobody aboard can do that.', until: performance.now() + 2600 };
      audio?.play('deny');
      return false;
    }
    return order({ ...command, crew });
  }

  /** The heavy gun that most wants rounds: empty first, then lowest. */
  function hungriestGun() {
    let best = null;
    sim.state.weapons.forEach((slot, index) => {
      const magazine = magazineOf(sim, index);
      if (magazine === null || slot.rounds >= magazine) return;
      if (!best || slot.rounds < best.rounds) best = { index, rounds: slot.rounds };
    });
    return best?.index ?? null;
  }

  // ---------- the cards above the status panel: a party at the lock, a toll ----------

  function buildCalls() {
    boardCall = buildBoardCall();
    tollCall = buildTollCall();
    return el('div', { class: 'fightstack' }, boardCall.node, tollCall.node);
  }

  /** The toll card (H.3): a bulwark has called its toll. Pay it, or get out of its zone before its gun clears. */
  function buildTollCall() {
    const title = el('span', { class: 'stencil fightcall__title', id: 'tollcall-title' });
    const text = el('span', { class: 'fightcall__text', id: 'tollcall-text' });
    const clockText = el('small', { class: 'fightcall__clock', id: 'tollcall-clock' });
    const pay = button('btn-toll-pay', 'Pay', () => tollCall.contact !== null && order({ type: 'contact.pay', contact: tollCall.contact }));
    const node = el('div', { class: 'panel fightcall tollcall', id: 'tollcall', hidden: true }, el('div', { class: 'fightcall__words' }, title, text, clockText), el('div', { class: 'fightcall__buttons' }, pay));
    return { node, title, text, clock: clockText, pay, contact: null };
  }

  function updateToll() {
    const card = tollCall;
    const contact = sim.state.scope.contacts.find((item) => item.tolled && item.state !== 'lost');
    card.contact = contact?.id ?? null;
    if (card.node.hidden !== !contact) card.node.hidden = !contact;
    if (!contact) return;
    const def = sim.encounters.byId.get(contact.encounter);
    const range = Math.hypot(contact.x, contact.y);
    const inside = range <= def.toll.zone;
    setText(card.title, `C${contact.id} ${def.name} · toll ${def.toll.cost}`);
    setText(card.text, `"${def.toll.demand}"`);
    const left = contact.tollEnds - sim.state.tick;
    setText(card.clock, !inside ? 'Outside its zone: its gun holds' : left > 0 ? `Its gun clears in ${seconds(left)}` : 'Its gun is clear to fire');
    const why = whyNoPay(sim, contact.id);
    setText(card.pay, `Pay ${def.toll.cost} · have ${sim.state.money}`);
    card.pay.disabled = Boolean(why);
    card.pay.title = why ? sentence(why) : 'They let us through the lane.';
  }

  function updateCalls() {
    updateBoarding();
    updateToll();
  }

  /** The deterrent gun in a few words: stood to or not, rounds, charge, and what it is laid on. */
  function gunText() {
    const slot = gun();
    if (slot < 0) return 'No gun fitted';
    const state = sim.state.weapons[slot];
    const weapon = weaponOf(slot);
    if (!state.powered) return 'Guns stood down';
    if (state.rounds !== null && state.rounds < 1) return roundsInHold(sim) ? 'Out of rounds · fetch more' : 'Out of rounds';
    const rounds = state.rounds === null ? '' : ` · ${state.rounds} rds`;
    const on = state.target === null ? null : `C${state.target}`;
    if (chargeOf(sim, slot) < 1) return `Charging ${percent(chargeOf(sim, slot))}${on ? ` · on ${on}` : ''}${rounds}`;
    return `${on ? `Laid on ${on}` : 'Ready · not laid'}${rounds}`;
  }

  /** Point defence in a few words. */
  function pdText() {
    const slot = pdSlot(sim);
    if (slot < 0) return 'None fitted';
    const state = sim.state.weapons[slot];
    if (!state.powered) return 'Guns stood down';
    const { drones, pods } = sim.state.scope;
    const threats = drones.length + pods.length;
    return threats ? `Firing · ${drones.length ? `${drones.length} drone${drones.length === 1 ? '' : 's'}` : ''}${drones.length && pods.length ? ', ' : ''}${pods.length ? `${pods.length} pod${pods.length === 1 ? '' : 's'}` : ''}` : 'On watch';
  }

  /**
   * The boarding card (H.2): a party at our lock, what it wants, and our answers there (pay, hand it over,
   * open up); then, while they are aboard, how many and what they are at, and turning on a peaceful party.
   */
  function buildBoardCall() {
    const title = el('span', { class: 'stencil fightcall__title', id: 'boardcall-title' });
    const text = el('span', { class: 'fightcall__text', id: 'boardcall-text' });
    const clockText = el('small', { class: 'fightcall__clock', id: 'boardcall-clock' });
    const bribe = button('btn-board-bribe', 'Pay', () => order({ type: 'boarding.bribe' }));
    const give = button('btn-board-yield', 'Hand over', () => order({ type: 'boarding.yield' }), 'btn--danger');
    const admit = button('btn-board-admit', 'Open the lock', () => order({ type: 'boarding.admit' }));
    const fight = button('btn-board-fight', 'Fight them', () => order({ type: 'boarding.fight' }), 'btn--danger');
    const node = el('div', { class: 'panel fightcall boardcall', id: 'boardcall', hidden: true }, el('div', { class: 'fightcall__words' }, title, text, clockText), el('div', { class: 'fightcall__buttons' }, bribe, give, admit, fight));
    return { node, title, text, clock: clockText, bribe, give, admit, fight };
  }

  function updateBoarding() {
    const boarding = sim.state.boarding;
    const card = boardCall;
    if (card.node.hidden !== !boarding) card.node.hidden = !boarding;
    if (!boarding) return;
    const toggle = (node, on) => node.hidden !== !on && (node.hidden = !on);
    const atLock = boarding.phase === 'demand';
    const def = sim.encounters.byId.get(boarding.encounter);
    const lock = layout.room(boarding.dock)?.name ?? 'the';
    toggle(card.bribe, atLock && Boolean(def?.party.bribe));
    toggle(card.give, atLock && (boarding.wants === 'cargo' || boarding.wants === 'crew'));
    toggle(card.admit, atLock);
    toggle(card.fight, !atLock && !boarding.hostile && boarding.phase === 'aboard');
    if (atLock) {
      setText(card.title, `${boarding.name} at the ${lock.toLowerCase()} lock · ${GOALS[boarding.wants]}`);
      setText(card.text, `"${demandText(boarding, def)}"`);
      setText(card.clock, `They come through in ${seconds(boarding.demandEnds - sim.state.tick)}${boarding.suited ? ' · suited: venting will not stop them' : ' · no suits'}`);
      const why = whyNoBribe(sim);
      setText(card.bribe, def?.party.bribe ? `Pay ${def.party.bribe.cost} · ${percent(bribeChance(sim))}` : 'Pay');
      card.bribe.disabled = Boolean(why);
      card.bribe.title = why ? sentence(why) : 'They might take it and go. They might take it and come aboard anyway.';
      const target = boarding.target ? findCrew(sim, boarding.target)?.member : null;
      setText(card.give, boarding.wants === 'crew' ? `Hand over ${target?.name ?? 'them'}` : `Hand over ${def?.party.take ?? ''} crates`);
      card.give.disabled = Boolean(whyNoYield(sim));
      return;
    }
    const people = partyOf(sim);
    const up = people.filter((member) => member.alive);
    const doing = up.map((member) => describeBoarder(sim, member).toLowerCase());
    const counts = [...new Set(doing)].map((what) => `${doing.filter((d) => d === what).length} ${what}`).join(', ');
    setText(card.title, `${boarding.name}: ${up.length} aboard${boarding.hostile ? ' · hostile' : ''}`);
    setText(card.text, boarding.phase === 'leaving' ? `Going back to their ship: ${(REASONS[boarding.reason] ?? '').toLowerCase()}` : counts || 'Nobody left standing');
    setText(card.clock, boarding.phase === 'leaving' ? `Clamp off within ${seconds(boarding.leaveEnds - sim.state.tick)}` : `They give up in ${seconds(boarding.deadline - sim.state.tick)}`);
  }

  /** How many lamps are lit on a deck. */
  function deckLit(deck) {
    return layout.rooms.filter((room) => room.y < deck.y + deck.h && room.y + room.h > deck.y && sim.state.rooms[room.id].lightsOn).length;
  }

  /** What a party says at the lock, with the warrant's name and the wanted system filled in. */
  function demandText(boarding, def) {
    const target = boarding.target ? findCrew(sim, boarding.target)?.member.name ?? 'one of your crew' : 'one of your crew';
    return (def?.party.demand ?? '').replaceAll('{crew_name}', target).replaceAll('{system}', boarding.strip ? SYSTEMS[boarding.strip].name.toLowerCase() : 'your fittings');
  }

  // ---------- Margo's monitor ----------

  /** A cheap company CRT: a dark glass screen in a chunky bezel, behind the schematic. */
  function drawBezel() {
    const { x, y, w, h } = monitor;
    if (w <= 0) return;
    ctx.fillStyle = '#0b0f14';
    ctx.strokeStyle = '#3a414c';
    ctx.lineWidth = 6;
    roundRect(x, y, w, h, 18);
    ctx.fill();
    ctx.stroke();
    const glow = ctx.createRadialGradient(x + w / 2, y + h / 2, Math.min(w, h) * 0.2, x + w / 2, y + h / 2, Math.max(w, h) * 0.65);
    glow.addColorStop(0, 'rgba(255, 179, 71, 0.05)');
    glow.addColorStop(1, 'rgba(0, 0, 0, 0.35)');
    ctx.fillStyle = glow;
    roundRect(x + 3, y + 3, w - 6, h - 6, 16);
    ctx.fill();
    ctx.fillStyle = 'rgba(168, 116, 44, 0.75)';
    ctx.font = "700 10px ui-monospace, 'SF Mono', Menlo, Consolas, monospace";
    ctx.textBaseline = 'bottom';
    ctx.textAlign = 'right';
    ctx.fillText('M.A.R.G.O. SCHEMATIC · COMPANY ISSUE', x + w - 18, y + h - 6);
    if (scopeBox) drawScope(ctx, scopeBox, scopeView(sim), { selected: selected?.kind === 'contact' ? selected.id : null, active: sensorsUp(sim), reduce: reduceMotion(), marks: situationMarks() });
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }

  /**
   * What the situations aboard put on the scope (H.7): a hull we are standing by is close alongside, anything
   * else some way off. The bearing is the situation's own, so it holds still while it waits.
   */
  function situationMarks() {
    return situationViews(sim)
      .filter((item) => item.mark && !item.result)
      .map((item) => ({ label: item.mark, bearing: (item.n * 137 + 40) % 360, range: item.hold ? 0.09 : 0.55 }));
  }

  /** An amber frame round every room where something is waiting to be dealt with, so the room itself says so. */
  function drawSituationRooms() {
    const time = (sim.state.tick + clock.alpha) * TICK_SECONDS;
    for (const item of situationViews(sim)) {
      if (item.result) continue;
      const box = roomBox(layout, view, item.room);
      const beat = reduceMotion() ? 1 : 0.6 + 0.4 * Math.abs(Math.sin(time * 2.2));
      ctx.strokeStyle = `rgba(255, 179, 71, ${item.state === 'attended' ? 0.55 : beat})`;
      ctx.lineWidth = 3;
      ctx.setLineDash(item.state === 'attended' ? [] : [8, 5]);
      ctx.strokeRect(box.x + 3, box.y + 3, box.w - 6, box.h - 6);
      ctx.setLineDash([]);
    }
  }

  /** Faint scanlines and a vignette over the screen. Off in settings for anyone who finds them tiring. */
  let scanPattern = null;
  function drawScanlines() {
    const off = settings?.values.scanlines === false;
    if (document.body.classList.contains('no-scanlines') !== off) document.body.classList.toggle('no-scanlines', off);
    if (off) return;
    const { x, y, w, h } = monitor;
    if (w <= 0) return;
    if (!scanPattern) {
      const tile = document.createElement('canvas');
      tile.width = 4;
      tile.height = 3;
      const t = tile.getContext('2d');
      t.fillStyle = 'rgba(0, 0, 0, 0.22)';
      t.fillRect(0, 2, 4, 1);
      scanPattern = ctx.createPattern(tile, 'repeat');
    }
    ctx.save();
    roundRect(x + 3, y + 3, w - 6, h - 6, 16);
    ctx.clip();
    ctx.fillStyle = scanPattern;
    ctx.fillRect(x, y, w, h);
    ctx.restore();
  }

  const reduceMotion = () => Boolean(window.matchMedia?.('(prefers-reduced-motion: reduce)').matches);

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // ---------- rounds coming in, and what they did ----------

  /** A round or a zap on its way to one of our rooms: a streak from the side of the screen its ship is on. */
  function drawShots(alpha) {
    const now = sim.state.tick - 1 + alpha; // the frame sits between the last tick and this one, as crew do
    for (const shot of sim.state.shots) {
      if (shot.at !== 'us') continue;
      const to = renderer.roomCentre(view, shot.room);
      const contact = findContact(sim, shot.contact);
      const bearing = contact ? (Math.atan2(contact.x, contact.y) * 180) / Math.PI : 45;
      const reach = Math.max(size.w, size.h);
      const from = { x: to.x + Math.sin((bearing * Math.PI) / 180) * reach, y: to.y - Math.cos((bearing * Math.PI) / 180) * reach };
      const t = Math.max(0, Math.min(1, (now - shot.born) / (shot.lands - shot.born)));
      // Only the last stretch is drawn: it comes in from off the monitor.
      const k = 0.75 + 0.25 * t;
      const tail = Math.max(0.75, k - 0.05);
      const at = (u) => ({ x: from.x + (to.x - from.x) * u, y: from.y + (to.y - from.y) * u });
      const head = at(k);
      const back = at(tail);
      const kinetic = sim.catalog.weapon(shot.weapon).kind === 'kinetic';
      ctx.lineCap = 'round';
      ctx.strokeStyle = shot.warn ? 'rgba(233, 220, 195, 0.35)' : kinetic ? 'rgba(233, 220, 195, 0.55)' : 'rgba(255, 179, 71, 0.9)';
      ctx.lineWidth = kinetic ? 2 : 4;
      ctx.beginPath();
      ctx.moveTo(back.x, back.y);
      ctx.lineTo(head.x, head.y);
      ctx.stroke();
    }
    ctx.lineCap = 'butt';
  }

  /** The room's rectangle in CSS pixels. */
  const roomBox = (shipLayout, v, roomId) => {
    const room = shipLayout.room(roomId);
    return { x: v.ox + room.x * v.scale, y: v.oy + room.y * v.scale, w: room.w * v.scale, h: room.h * v.scale };
  };

  /**
   * What the last rounds did to us: a flash over a room that was hit, a ring where each one
   * landed, and words for the result and what it did, so it never rests on colour alone.
   */
  function drawImpacts(alpha) {
    const now = sim.state.tick - 1 + alpha;
    impacts = impacts.filter((impact) => (now - impact.tick) * TICK_SECONDS < IMPACT_SECONDS && now >= impact.tick - 1);
    for (const impact of impacts) {
      const age = Math.max(0, ((now - impact.tick) * TICK_SECONDS) / IMPACT_SECONDS);
      const r = renderer;
      const v = view;
      const shipLayout = layout;
      if (!shipLayout.room(impact.room)) continue;
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
      // What a hit did is only known if someone could see the room it landed in.
      const words = !unseen(sim, impact) ? effectWords(impact.effects) : impact.result === 'hit' ? '?' : '';
      if (words) {
        ctx.font = "700 10px ui-monospace, 'SF Mono', Menlo, Consolas, monospace";
        ctx.fillStyle = `rgba(255, 214, 150, ${fade})`;
        ctx.fillText(words, at.x, at.y + 2 - rise, Math.max(60, v.scale * shipLayout.room(impact.room).w + 30));
      }
    }
    // A hit on our ship: the edges of Margo's monitor flash red for a moment.
    const struck = shake ? 1 - ((now - shake.tick) * TICK_SECONDS) / FLASH_SECONDS : 0;
    if (struck > 0) {
      ctx.strokeStyle = `rgba(214, 64, 52, ${0.6 * struck})`;
      ctx.lineWidth = 10;
      ctx.strokeRect(monitor.x + 5, monitor.y + 5, monitor.w - 10, monitor.h - 10);
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

  function selectCrew(id) {
    selectedCrew = id;
    if (id) lastHand = id;
    if (id) selected = null;
    nodes.info.hidden = true;
    buildPanel();
  }

  function buildPanel() {
    panel = null;
    if (selectedCrew) {
      const { member } = findCrew(sim, selectedCrew);
      const stats = { health: stat('Health'), where: stat('In'), doing: stat('Doing'), skills: stat('Good at'), post: stat('Post'), watch: stat('Watch'), rest: stat('Rest'), suit: stat('Suit'), nerve: stat('Nerve'), regard: stat('Captain') };
      setText(stats.skills.value, skillWords(member) || 'Nothing special');
      const memory = el('span', { class: 'status__hint status__hint--inline', id: 'crew-memory' });
      const suit = button('btn-suit', 'Suit up', () => order({ type: 'crew.suit', crew: member.id, on: !findCrew(sim, member.id).member.suit }));
      // Hide where they stand (H.2): a locker, or a crawlway for an engineer.
      const hide = button('btn-hide', 'Hide', () => order({ type: 'crew.hide', crew: member.id, on: !findCrew(sim, member.id).member.hidden }));
      const note = el('span', { class: 'status__note' });
      // Their post (H.4): a station to stand, or none. Posting them sends them there.
      const posts = [...POSTS.filter((id) => roomOfStation(sim, id)), null].map((station) => ({
        station,
        node: button(`btn-post-${station ?? 'none'}`, station ? STATIONS[station].name : 'No post', () => order({ type: 'crew.post', crew: member.id, station }), 'btn--small'),
      }));
      const shift = button('btn-watch', 'Change watch', () => {
        const count = Math.max(1, sim.state.roster.watches);
        order({ type: 'crew.watch', crew: member.id, watch: (findCrew(sim, member.id).member.watch + 1) % count });
      }, 'btn--small');
      // The stations fold away under one button, so the panel stays short and the ship stays big.
      const postRow = el('div', { class: 'status__controls status__posts', id: 'crew-posts', hidden: true }, posts.map((p) => p.node));
      const choose = button('btn-posts', 'Post', () => {
        postRow.hidden = !postRow.hidden;
        choose.setAttribute('aria-expanded', String(!postRow.hidden));
      }, 'btn--small');
      choose.setAttribute('aria-expanded', 'false');
      nodes.status.replaceChildren(
        el('div', { class: 'status__head' }, el('div', { class: 'status__title', id: 'status-title' }, member.name), el('div', { class: 'stencil', id: 'crew-role' }, `${roleOf(member)?.name ?? 'Crew'} · ${member.index + 1}`), note),
        el('div', { class: 'status__stats' }, Object.values(stats).map((s) => s.node)),
        el(
          'div',
          { class: 'status__controls' },
          suit,
          hide,
          choose,
          shift,
          debug && button('btn-dbg-hurt', 'Hurt', () => order({ type: 'debug.crew', crew: member.id, health: Math.max(0.05, findCrew(sim, member.id).member.health - 0.3) }), 'btn--debug'),
          el('span', { class: 'status__hint status__hint--inline', id: 'crew-hint' }, 'Tap a room to send them there.'),
          memory,
        ),
        postRow,
      );
      panel = { kind: 'crew', id: member.id, stats, suit, hide, note, memory, posts, shift };
      updatePanel();
      return;
    }
    if (selected?.kind === 'crate') {
      const crate = sim.state.crates[selected.id];
      if (!crate) {
        selected = null;
        return buildPanel();
      }
      const stats = { where: stat('In'), contents: stat('Contents') };
      const id = crate.id;
      const open = button('btn-crate-open', 'Open', () => crateOrder({ type: 'crate.open', crate: id }));
      const move = button('btn-crate-move', 'Move', () => {
        movingCrate = movingCrate === id ? null : id;
      });
      const load = button('btn-crate-load', 'Load the gun', () => {
        const slot = hungriestGun();
        if (slot === null) {
          refusal = { text: 'The gun is fully loaded.', until: performance.now() + 2600 };
          return;
        }
        crateOrder({ type: 'weapon.load', slot, crate: id });
      });
      // Two presses, like a room: the first arms it, the second sends someone to the airlock with it.
      const jettison = button('btn-crate-jettison', 'Jettison', () => {
        if (panel.armedUntil > performance.now()) {
          panel.armedUntil = 0;
          crateOrder({ type: 'crate.jettison', crate: id });
        } else panel.armedUntil = performance.now() + 4000;
      }, 'btn--danger');
      // Under the deck plates of a compartment, out of a boarding party's sight (H.2).
      const stash = layout.rooms.some((room) => room.compartment) ? button('btn-crate-stash', 'Stash', () => crateOrder({ type: 'crate.stash', crate: id })) : null;
      const note = el('span', { class: 'status__note' });
      nodes.status.replaceChildren(
        el('div', { class: 'status__head' }, el('div', { class: 'status__title', id: 'status-title' }, crate.label), el('div', { class: 'stencil' }, CRATE_KIND[crate.kind]), note),
        el('div', { class: 'status__stats' }, Object.values(stats).map((s) => s.node)),
        el('div', { class: 'status__controls' }, crate.kind === 'ammo' ? load : open, move, stash, jettison),
      );
      panel = { kind: 'crate', id, stats, open, move, load, stash, jettison, armedUntil: 0, note };
      updatePanel();
      return;
    }
    if (!selected) {
      // Nothing picked: how loud the ship is and why (D-074), and the one switch that matters most to it.
      const stats = { total: stat('Signature'), light: stat('Light'), noise: stat('Noise'), heat: stat('Heat'), burn: stat('Burn'), trouble: stat('Trouble'), eyes: stat('Eyes'), reactor: stat('Reactor'), hull: stat('Hull'), gun: stat('Gun'), pd: stat('Point def.') };
      // The reactor's load is what a scope reads as our heat (H.4); its outputs are on the reactor room's card (H.9).
      stats.reactor.value.id = 'power-summary';
      const dark = button('btn-dark', 'Go dark', () => order({ type: 'lights.all', on: litRooms(sim) === 0 }));
      // The helm (H.1): light the drive or cut it and drift, and a flare for something to chase instead of us.
      const burn = button('btn-burn', 'Burn', () => order({ type: 'helm.burn', on: !sim.state.helm.burn }));
      const flare = button('btn-flare', 'Flare', () => order({ type: 'decoy.flare' }));
      // The brace (D-075): dump the capacitor to soak the next few seconds of incoming fire. B on a keyboard.
      const braceNote = el('small', { id: 'brace-note' }, '');
      const brace = el('button', { class: 'btn btn--small btn--brace', type: 'button', id: 'btn-brace', press: () => order({ type: 'ship.brace' }) }, el('span', {}, 'Brace'), braceNote);
      // Rounds for the gun come up from the hold by hand (S2.8): shown while its magazine is short.
      const fetch = gun() >= 0 && magazineOf(sim, gun()) !== null ? button('btn-fetch-rounds', 'Fetch rounds', () => crateOrder({ type: 'weapon.load', slot: gun() })) : null;
      const note = el('span', { class: 'status__note' });
      nodes.status.replaceChildren(
        el('div', { class: 'status__head' }, el('div', { class: 'status__title', id: 'status-title' }, layout.name), el('div', { class: 'stencil' }, 'What we give off'), note),
        el('div', { class: 'status__stats' }, Object.values(stats).map((s) => s.node)),
        el('div', { class: 'status__controls status__controls--row' }, dark, burn, flare, brace, fetch),
        el('p', { class: 'status__hint' }, 'Tap crew, then a room, to send them. Tap a room for what can be done there. Tap the scope to turn the ship, or a contact on it to read it. Long-press anything to ask what it is.'),
      );
      panel = { kind: 'ship', stats, dark, burn, flare, brace, braceNote, fetch, note };
      updatePanel();
      return;
    }

    if (selected.kind === 'contact') {
      // A return on the scope (H.1): what Margo makes of it, the lies we can hail it with, and (H.3) our gun.
      const stats = { bearing: stat('Bearing'), range: stat('Range'), intent: stat('Hunting us'), fix: stat('Return'), gun: stat('Our gun') };
      const title = el('div', { class: 'status__title', id: 'status-title' });
      const sub = el('div', { class: 'stencil' });
      const note = el('span', { class: 'status__note' });
      const id = selected.id;
      const hails = Object.fromEntries(Object.entries(BLUFFS).map(([bluff, label]) => [bluff, button(`btn-hail-${bluff}`, label, () => order({ type: 'contact.hail', contact: id, bluff }))]));
      // Lay the deterrent gun on it, or take it off; A on a keyboard. Rounds come up from the hold by hand.
      const lay = button('btn-gun', 'Lay the gun', () => order({ type: 'gun.target', contact: gun() >= 0 && sim.state.weapons[gun()].target === id ? null : id }), 'btn--danger');
      const fetch = gun() >= 0 && magazineOf(sim, gun()) !== null ? button('btn-fetch-rounds', 'Fetch rounds', () => crateOrder({ type: 'weapon.load', slot: gun() })) : null;
      const pay = button('btn-pay', 'Pay', () => order({ type: 'contact.pay', contact: id }));
      const hint = el('span', { class: 'status__hint status__hint--inline', id: 'contact-hint' }, CONTACT_HINT);
      nodes.status.replaceChildren(
        el('div', { class: 'status__head' }, title, sub, note),
        el('div', { class: 'status__stats' }, Object.values(stats).map((s) => s.node)),
        el('div', { class: 'status__controls status__controls--row' }, Object.values(hails), lay, fetch, pay, hint),
      );
      panel = { kind: 'contact', id, stats, title, sub, note, hails, lay, fetch, pay, hint };
      updatePanel();
      return;
    }

    if (selected.kind === 'room') {
      const room = layout.room(selected.id);
      const stats = { oxygen: stat('Oxygen'), temperature: stat('Temp'), light: stat('Light'), noise: stat('Noise'), hull: stat('Hull'), fire: stat('Fire'), breach: stat('Breach') };
      const sys = room.system ?? null;
      if (sys) stats.system = stat(sys === 'reactor' ? 'Output' : POWERED.includes(sys) ? 'Station' : 'System');
      else if (stationOfRoom(sim, room.id)) stats.system = stat('Station');
      const lights = button('btn-lights', 'Lights off', () => order({ type: 'room.lights', room: room.id, on: !sim.state.rooms[room.id].lightsOn }));
      const note = el('span', { class: 'status__note' });
      // A whole deck's lamps at once, and the room's emergency vent (H.2). The deck is the one its floor is on.
      const floor = room.y + room.h;
      const deck = layout.decks.find((item) => floor > item.y && floor <= item.y + item.h) ?? null;
      const deckLights = deck ? button('btn-deck-lights', 'Deck dark', () => order({ type: 'deck.lights', deck: deck.id, on: deckLit(deck) === 0 })) : null;
      const vent = room.kind !== 'lift' ? button('btn-vent', 'Vent', () => {
        const command = { type: 'room.vent', room: room.id, open: !sim.state.rooms[room.id].vent };
        if (!command.open || panel.ventArmed > performance.now()) {
          panel.ventArmed = 0;
          order(command);
        } else panel.ventArmed = wouldRefuse(command) ? 0 : performance.now() + 4000;
      }, 'btn--danger') : null;
      const controls = [lights, deckLights, vent].filter(Boolean);
      // A broken system is fixed by whoever stands in its room (D-118). This sends the nearest free hand.
      let repair = null;
      if (sys && !sim.state.systems[sys].absent) {
        repair = button('btn-repair', 'Send to repair', () => {
          const crew = pickHand(sim, room.id);
          if (!crew) {
            refusal = { text: 'Nobody aboard can get there.', until: performance.now() + 2600 };
            audio?.play('deny');
            return;
          }
          order({ type: 'crew.move', crew, room: room.id, ship: 'us' });
        });
        repair.hidden = true;
        controls.push(repair);
      }
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
      const system = room.system ? SYSTEMS[room.system].name : room.kind === 'helm' ? 'Helm' : room.kind === 'lift' ? 'Lift' : 'Corridor';
      // The station in the room (H.9): what the switch panel did for it, here where it is.
      const id = roomStation(sim, room.id);
      const station = id ? buildStation(id) : null;
      const lift = room.kind === 'lift' ? button('btn-lift', 'Lift motor', () => order({ type: 'power.lift', on: !sim.state.power.lift })) : null;
      if (lift) controls.unshift(lift);
      nodes.status.replaceChildren(
        el('div', { class: 'status__head' }, el('div', { class: 'status__title', id: 'status-title' }, room.name), system.toLowerCase() !== room.name.toLowerCase() && el('div', { class: 'stencil' }, system), note),
        el('div', { class: 'status__stats' }, Object.values(stats).map((s) => s.node)),
        el('div', { class: 'status__controls' }, controls),
        station?.node,
      );
      panel = { kind: 'room', id: room.id, sys, stats, lights, deckLights, deck, vent, ventArmed: 0, repair, jettison, armedUntil: 0, note, station, lift };
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
    if (panel.kind === 'crate') {
      const crate = sim.state.crates[panel.id];
      if (!crate) {
        // Loaded, broken down, or out of the airlock.
        selected = null;
        movingCrate = null;
        return buildPanel();
      }
      const carrier = crate.by ? findCrew(sim, crate.by)?.member : null;
      setText(panel.stats.where.value, carrier ? `${carrier.name}'s arms` : `${layout.room(crate.room).name}${crate.hidden ? ', under the deck plates' : ''}`);
      setText(panel.stats.contents.value, crate.kind === 'ammo' ? `${crate.rounds} rounds` : crate.spoiled ? 'spoiled' : crate.sealed ? 'sealed' : (crate.contents ?? 'opened'));
      panel.open.disabled = !crate.sealed;
      setText(panel.open, crate.sealed ? 'Open' : 'Opened');
      if (panel.stash) {
        setText(panel.stash, crate.hidden ? 'Stashed' : 'Stash');
        panel.stash.disabled = crate.hidden;
      }
      panel.move.classList.toggle('is-selected', movingCrate === panel.id);
      const armed = panel.armedUntil > performance.now();
      setText(panel.jettison, armed ? 'Confirm jettison' : 'Jettison');
      panel.jettison.classList.toggle('is-armed', armed);
      const worker = ourCrew(sim).find(({ member }) => member.job?.crate === panel.id)?.member;
      let note = refusalText();
      if (!note && movingCrate === panel.id) note = 'Tap a room of ours to carry it there.';
      else if (!note && armed) note = crate.contract ? 'Contract cargo: losing it costs the fee. Press again to confirm.' : 'It goes out of the nearest airlock. Press again to confirm.';
      else if (!note && worker) note = `${worker.name}: ${describeJob(sim, worker).toLowerCase()}.`;
      else if (!note && crate.hidden) note = 'Stashed under the deck plates. A careful search can still turn it up.';
      else if (!note && crate.sealed) note = crate.contract ? 'Contract cargo. The client will see a broken seal, and pay less for it.' : 'Breaking a company seal gets logged.';
      else if (!note && crate.contract && crate.spoiled) note = 'Spoiled. The drop will pay nothing for it.';
      else if (!note && crate.contract) note = 'Contract cargo: it is what the drop pays for.';
      setText(panel.note, queuedFor('crate', panel.id) ? 'Order queued' : note);
      return;
    }
    if (panel.kind === 'ship') {
      const sig = signature(sim);
      setText(panel.stats.total.value, percent(sig.total));
      for (const part of ['light', 'noise', 'heat', 'burn']) setText(panel.stats[part].value, percent(sig[part]));
      // Trouble aboard nobody has seen to (F.4): a fight, a leak, a loose load, heard and felt through the hull.
      setText(panel.stats.trouble.value, sig.trouble > 0 ? percent(sig.trouble) : 'none');
      panel.stats.trouble.node.classList.toggle('is-alarm', sig.trouble > 0);
      const blind = layout.rooms.filter((room) => !sim.state.seen[room.id].live).length;
      setText(panel.stats.eyes.value, blind ? `${blind} rooms unseen` : 'every room');
      panel.stats.eyes.node.classList.toggle('is-alarm', blind > 0);
      setText(panel.dark, litRooms(sim) === 0 ? 'Lights up' : 'Go dark');
      setText(panel.burn, sim.state.helm.burn ? 'Cut drive' : 'Burn');
      panel.burn.classList.toggle('is-on', sim.state.helm.burn);
      setText(panel.flare, `Flare (${sim.state.helm.flares})`);
      panel.flare.disabled = sim.state.helm.flares < 1;
      const limit = outputLimit(sim);
      setText(panel.stats.reactor.value, limit === null ? 'Reactor dead' : `${OUTPUT[sim.state.power.output].name} · load ${percent(reactorLoad(sim))}`);
      panel.stats.reactor.node.classList.toggle('is-alarm', limit !== 'hard');
      const { hull } = sim.state;
      setText(panel.stats.hull.value, `${hull.points} of ${hull.max}`);
      panel.stats.hull.node.classList.toggle('is-alarm', hull.points < hull.max / 2);
      setText(panel.stats.gun.value, gunText());
      setText(panel.stats.pd.value, pdText());
      const braceProblem = whyNoBrace(sim);
      setText(panel.braceNote, braced(sim) ? `Up ${seconds(sim.state.shield.until - sim.state.tick)}` : capacity(sim) ? percent(capacitorOf(sim)) : 'Shields dark');
      panel.brace.classList.toggle('is-ready', !braceProblem);
      panel.brace.classList.toggle('is-active', braced(sim));
      if (panel.fetch) {
        const slot = sim.state.weapons[gun()];
        const short = slot.rounds !== null && slot.rounds < magazineOf(sim, gun());
        panel.fetch.hidden = !short;
        panel.fetch.disabled = !roundsInHold(sim);
      }
      setText(panel.note, ['lights.all', 'helm.burn', 'helm.heading', 'decoy.flare'].some((type) => queuedFor('type', type)) ? 'Order queued' : refusalText() || (blind ? 'Static is a room nobody can see: lamps, sensors, or someone standing in it.' : ''));
      return;
    }
    if (panel.kind === 'contact') {
      const seen = scopeView(sim).contacts.find((item) => item.id === panel.id);
      if (!seen) {
        // Off the scope: gone, docked, or lost in the clutter for good.
        const last = sim.state.scope.record.at(-1);
        setText(panel.title, `C${panel.id}`);
        setText(panel.sub, 'No longer on the scope');
        for (const s of Object.values(panel.stats)) setText(s.value, 'none');
        for (const node of Object.values(panel.hails)) node.disabled = true;
        panel.lay.disabled = true;
        panel.pay.hidden = true;
        setText(panel.note, last ? `${ENDINGS[last.outcome]}.` : '');
        return;
      }
      setText(panel.title, `${seen.label} · ${seen.name}`);
      // What beats it (F.2): once Margo has made it out, what she knows of its kind.
      setText(panel.hint, seen.tells?.length ? `Margo: ${seen.tells.map((tell) => tell.text).join('. ')}.` : CONTACT_HINT);
      setText(panel.sub, seen.stale ? `Last seen ${seconds(seen.age)} ago` : 'On the scope');
      setText(panel.stats.bearing.value, `${bearingText(seen.bearing)} ±${Math.round(seen.bearingError)}°`);
      setText(panel.stats.range.value, `${rangeText(seen.range, seen.rangeError)} ±${Math.round(seen.rangeError * 100)}%`);
      // How close it is to finding us (F.1): the stage of its awareness in words, and how sure it is.
      setText(panel.stats.intent.value, seen.stage ? `${seen.stageText}${seen.stage === 'gone' ? '' : ` · ${Math.round(seen.certainty * 100)}% sure`}` : seen.intent);
      panel.stats.intent.node.classList.toggle('is-alarm', seen.stage === 'sure');
      setText(panel.stats.fix.value, seen.stale ? 'lost' : percent(seen.quality));
      const contact = sim.state.scope.contacts.find((item) => item.id === panel.id);
      for (const [bluff, node] of Object.entries(panel.hails)) {
        const why = whyNoHail(sim, { contact: panel.id, bluff });
        node.disabled = Boolean(why);
        node.title = why ? sentence(why) : `About ${percent(bluffChance(sim, contact, bluff))}, as far as Margo can judge`;
      }
      const slot = gun();
      const noGun = whyNoGun(sim, panel.id);
      const laid = slot >= 0 && sim.state.weapons[slot].target === panel.id;
      const reach = slot >= 0 ? weaponOf(slot).range : 0;
      setText(panel.stats.gun.value, noGun ? 'cannot bear' : seen.range > reach ? `out of reach (${reach})` : `${laid ? 'laid · ' : ''}about ${percent(gunChance(sim, contact))}`);
      panel.lay.disabled = Boolean(noGun) && !laid;
      panel.lay.title = noGun ? sentence(noGun) : 'Fire on it whenever the gun is charged and loaded. It does not sink anything: it scares.';
      setText(panel.lay, laid ? 'Hold fire' : 'Lay the gun');
      panel.lay.classList.toggle('is-on', laid);
      if (panel.fetch) panel.fetch.disabled = !roundsInHold(sim);
      const noPay = whyNoPay(sim, panel.id);
      panel.pay.hidden = !contact?.tolled;
      panel.pay.disabled = Boolean(noPay);
      if (contact?.tolled) setText(panel.pay, `Pay ${sim.encounters.byId.get(contact.encounter).toll.cost}`);
      const blocked = Object.keys(BLUFFS).map((bluff) => whyNoHail(sim, { contact: panel.id, bluff })).filter(Boolean);
      setText(panel.note, queuedFor('type', 'contact.hail') ? 'Hailing' : refusalText() || (blocked.length === Object.keys(BLUFFS).length ? sentence(blocked[0]) : ''));
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
      setText(panel.stats.doing.value, (ship === sim && describeJob(sim, member)) || describeTask(ship, member));
      setText(panel.stats.suit.value, member.suit ? 'on (slower)' : 'off');
      setText(panel.stats.post.value, member.post ? STATIONS[member.post].name : 'none');
      const { roster } = sim.state;
      setText(panel.stats.watch.value, roster.watches > 1 ? `${watchName(member.watch)}${onWatch(sim, member) ? ' · on' : ' · below'}` : roster.watches === 1 ? 'all hands' : 'none kept');
      const hungry = hungryWord(member);
      setText(panel.stats.rest.value, member.alive ? `${tiredWord(member)}${hungry ? ` · ${hungry.toLowerCase()}` : ''}${member.asleep ? ' · asleep' : member.eating ? ' · eating' : ''}${ship === sim && chill(sim, member) < 1 ? ' · cold' : ''}` : 'none');
      panel.stats.rest.node.classList.toggle('is-alarm', member.alive && (member.fatigue >= 0.9 || hungry === 'Starving'));
      for (const { station, node } of panel.posts) {
        node.classList.toggle('is-on', member.post === station);
        node.setAttribute('aria-pressed', String(member.post === station));
        node.disabled = !member.alive || ship !== sim;
      }
      panel.shift.disabled = !member.alive || roster.watches < 2;
      setText(panel.suit, member.suit ? 'Suit off' : 'Suit up');
      panel.suit.disabled = !member.alive;
      setText(panel.hide, member.hidden ? 'Come out' : 'Hide');
      const noHide = member.hidden || !member.alive || ship !== sim ? null : whyNoHide(sim, member);
      panel.hide.disabled = !member.alive || ship !== sim;
      panel.hide.title = noHide ? sentence(noHide) : member.hidden ? HIDING[member.hidden] : 'Into a locker, or a crawlway for an engineer, until someone looks hard enough.';
      panel.hide.classList.toggle('is-on', Boolean(member.hidden));
      setText(panel.stats.nerve.value, member.alive ? nerveWord(member) : 'none');
      panel.stats.nerve.node.classList.toggle('is-alarm', member.alive && member.dread >= 0.66);
      const remembered = member.alive ? topMemory(ship, member) : null;
      // What they think of the captain, and who they have fallen out with (F.6).
      setText(panel.stats.regard.value, member.alive && ship === sim ? regardWord(regardOf(member)) : 'none');
      panel.stats.regard.node.classList.toggle('is-alarm', member.alive && regardWord(regardOf(member)) === 'sour');
      const feuds = member.alive ? feudsOf(ship, member) : [];
      setText(panel.memory, [remembered ? `Remembers ${remembered}.` : '', feuds.length ? `Not speaking to ${feuds.join(' or ')}.` : ''].filter(Boolean).join(' '));
      setText(panel.note, queuedFor('crew', panel.id) ? 'Order queued' : refusalText());
      return;
    }
    if (panel.kind === 'room') {
      const r = roomView(sim, panel.id); // what Margo knows: live, or the last she saw
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
        let text = system.damage ? 'damaged' : 'working';
        if (panel.sys === 'reactor') text = `${OUTPUT[sim.state.power.output].name.toLowerCase()} · ${works} of ${system.level} bars`;
        else if (STATIONS[panel.sys]) {
          const run = rating(sim, panel.sys);
          text = run > 0 ? `${holderText(panel.sys)} · ${run.toFixed(1)}` : holderText(panel.sys).toLowerCase();
          if (system.damage) text += ` (${system.damage} of ${system.level} damaged)`;
        }
        if (panel.sys === 'ai_core') text += ` · ${aiCoreStatus(sim).state}`;
        setText(panel.stats.system.value, text);
        panel.stats.system.node.classList.toggle('is-alarm', system.damage > 0);
      } else if (panel.stats.system) {
        const id = stationOfRoom(sim, panel.id);
        const run = rating(sim, id);
        setText(panel.stats.system.value, run > 0 ? `${holderText(id)} · ${run.toFixed(1)}` : holderText(id).toLowerCase());
      }
      if (panel.station) updateStation(panel.station);
      if (panel.lift) updateLift(panel.lift);
      setText(panel.lights, r.lightsOn ? 'Lights off' : 'Lights on');
      panel.lights.disabled = r.jettisoned;
      if (panel.deckLights) {
        setText(panel.deckLights, deckLit(panel.deck) === 0 ? 'Deck lights up' : 'Deck dark');
        panel.deckLights.disabled = r.jettisoned;
      }
      const venting = Boolean(sim.state.rooms[panel.id].vent);
      const ventArmed = panel.ventArmed > performance.now();
      if (panel.vent) {
        setText(panel.vent, venting ? 'Seal vent' : ventArmed ? 'Confirm vent' : 'Vent');
        panel.vent.disabled = r.jettisoned;
        panel.vent.classList.toggle('is-armed', ventArmed);
        panel.vent.classList.toggle('is-on', venting);
      }
      const armed = panel.armedUntil > performance.now();
      if (panel.jettison) {
        setText(panel.jettison, r.jettisoned ? 'Jettisoned' : armed ? 'Confirm jettison' : 'Jettison');
        panel.jettison.disabled = r.jettisoned;
        panel.jettison.classList.toggle('is-armed', armed && !r.jettisoned);
      }
      let note = refusalText() || (r.live ? '' : `No eyes in here. This is what it looked like ${seconds(r.age)} ago.`);
      const fixing = panel.repair ? repairNote(panel.id, panel.sys) : null;
      if (panel.repair) {
        panel.repair.hidden = !fixing || r.jettisoned;
        panel.repair.disabled = Boolean(fixing?.busy);
        setText(panel.repair, fixing?.busy ? 'Repairing' : 'Send to repair');
      }
      if (fixing && !refusalText() && r.live) note = fixing.text;
      if (r.jettisoned) note = 'This section was cut loose. It is gone.';
      else if (queuedFor('room', panel.id)) note = 'Order queued';
      else if (armed) note = 'Everything inside will be lost. Press again to confirm.';
      else if (ventArmed) note = 'The air in here goes out into space. Anyone without a suit has to get out. Press again to confirm.';
      else if (venting && !refusalText()) note = 'The emergency vent is open: this room is losing its air.';
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
      const dark = !running(sim, 'doors');
      panel.stats.state.node.classList.toggle('is-alarm', jammed);
      if (panel.jam) setText(panel.jam, jammed ? 'Free' : 'Jam');
      setText(
        panel.note,
        queuedFor('door', panel.id) ? 'Order queued' : jammed ? 'Jammed. It will not move until it is repaired.' : refusalText() || (dark ? 'Door control is dark. Doors are worked by hand.' : ''),
      );
    }
  }

  // ---------- input ----------

  function onTap({ x, y, pointerType }) {
    counts.canvasTaps += 1;
    const onScope = scopeBox ? scopeHit(scopeBox, scopeView(sim), x, y, pointerType) : null;
    if (onScope) {
      // The scope: a return is read, anywhere else on the dial is a new heading.
      if (onScope.contact !== undefined) select({ kind: 'contact', id: onScope.contact });
      else if (onScope.heading !== undefined) order({ type: 'helm.heading', heading: Math.round(onScope.heading) });
      return;
    }
    let target = pickTarget(allTargets(), x, y, pointerType);
    if (!target) {
      selectedCrew = null;
      select(null);
      return;
    }
    // A crate with someone selected, or while a crate is being moved, stands for the room it is in.
    if (target.kind === 'crate' && (selectedCrew || movingCrate)) target = { kind: 'room', id: sim.state.crates[target.id]?.room ?? target.id };
    if (target.kind === 'room' && movingCrate) {
      const crate = movingCrate;
      if (crateOrder({ type: 'crate.move', crate, room: target.id })) movingCrate = null;
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

  function onInfo({ x, y, pointerType, control = null }) {
    counts.infos += 1;
    if (control) {
      // A long-press on a button or a crew card (H.10, D-257): what it is for, or why it is greyed out.
      nodes.info.textContent = controlInfo({ id: control.id, title: control.title, label: control.getAttribute('aria-label') || control.textContent, disabled: control.disabled });
      nodes.info.hidden = false;
      const box = control.getBoundingClientRect();
      const left = Math.max(8, Math.min(box.left, window.innerWidth - 308));
      nodes.info.style.left = `${left}px`;
      // Over the control if there is room, so the finger does not cover it; under it if not.
      nodes.info.style.top = '0px';
      const high = nodes.info.offsetHeight;
      nodes.info.style.top = `${box.top - high - 8 >= 8 ? box.top - high - 8 : Math.min(window.innerHeight - high - 8, box.bottom + 8)}px`;
      return;
    }
    const onScope = scopeBox ? scopeHit(scopeBox, scopeView(sim), x, y, pointerType) : null;
    const text = onScope ? describeScope(onScope) : (describe(pickTarget(allTargets(), x, y, pointerType)) ?? 'Open space. Cold, and a long way from anywhere.');
    nodes.info.textContent = text;
    nodes.info.hidden = false;
    nodes.info.style.left = `${Math.max(8, Math.min(x + 14, window.innerWidth - 300))}px`;
    nodes.info.style.top = `${Math.max(8, y - 56)}px`;
  }

  function onKey({ action, shift }) {
    if (action === 'muster') {
      order({ type: 'roster.muster' });
      return;
    }
    if (action === 'gun') {
      // Lay the gun on the contact being read, or hold fire if it is laid already.
      const slot = gun();
      if (slot < 0) return;
      const laid = sim.state.weapons[slot].target;
      const on = selected?.kind === 'contact' ? selected.id : null;
      order({ type: 'gun.target', contact: on === null || laid === on ? null : on });
      return;
    }
    if (action.startsWith('select-')) {
      const member = ourCrew(sim)[Number(action.slice(7)) - 1]?.member;
      if (member) selectCrew(selectedCrew === member.id ? null : member.id);
      return;
    }
    if (action === 'brace') {
      order({ type: 'ship.brace' });
      return;
    }
    if (action === 'burn') {
      order({ type: 'helm.burn', on: !sim.state.helm.burn });
      return;
    }
    if (action === 'flare') {
      order({ type: 'decoy.flare' });
      return;
    }
    if (action === 'skip') {
      skipAhead();
      return;
    }
    if (action === 'helm') {
      // The helm's card: nothing picked (H.9; P opened the switch panel before).
      selectCrew(null);
      select(null);
      return;
    }
    if (action === 'override') {
      if (sim.state.ai.objection) order({ type: 'captain.override' });
      return;
    }
    if (action === 'chart') {
      if (chart) openChart(!chartOpen);
      return;
    }
    if (action === 'jump') {
      if (chart) chart.jump();
      return;
    }
    if (action !== 'back') return;
    if (sim.state.ai.objection) order({ type: 'captain.standDown' });
    else if (sheet) openSheet(sheet);
    else if (chartOpen && chart.selected) chart.select(null);
    else if (chartOpen) openChart(false);
    else if (movingCrate) movingCrate = null;
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
      skipLabel: el('span', {}, 'Next'),
      skipNote: el('small', { id: 'skip-note' }, 'N key'),
      sheet: el('div', { class: 'panel sheet', id: 'sheet', hidden: true }),
      // The space Margo's monitor gets: nothing in it but what the canvas draws.
      monitor: el('div', { class: 'ship__monitor', id: 'monitor', 'aria-hidden': 'true' }),
    };
    nodes.pause = el('button', { class: 'btn btn--pause', type: 'button', id: 'btn-pause', press: () => clock.toggle() }, nodes.pauseLabel, nodes.pauseNote);
    // On to the next thing (F.3): skip ahead on a quiet crossing until something turns up.
    nodes.skip = el('button', { class: 'btn btn--skip', type: 'button', id: 'btn-skip', 'aria-label': 'On to the next thing', press: skipAhead }, nodes.skipLabel, nodes.skipNote);
    nodes.top = el(
      'div',
      { class: 'shipbar' },
      el('div', { class: 'panel shipbar__name' }, el('div', { class: 'stencil' }, layout.name), nodes.clock),
      el('div', { class: 'shipbar__clockbtns' }, nodes.pause, tempo && sim.state.run ? nodes.skip : null),
      el(
        'div',
        { class: 'shipbar__buttons' },
        debug && button('btn-dbg-step', 'Step', () => clock.stepOnce(), 'btn--debug'),
        debug && button('btn-dbg-hit', 'Hit us', () => order({ type: 'debug.hit', at: 'us', room: selected?.kind === 'room' ? selected.id : null, weapon: heaviestGun(), force: true }), 'btn--debug'),
        debug && button('btn-dbg-contact', 'Contact', () => order(sim.state.scope.contacts.length ? { type: 'debug.contact', clear: true } : { type: 'debug.contact', encounter: sim.encounters.all[0].id, state: 'closing', range: 25 }), 'btn--debug'),
        debug && button('btn-dbg-menu', 'More', () => openSheet('debug'), 'btn--debug'),
        sim.state.run && (nodes.chartButton = button('btn-chart', 'Chart', () => openChart(!chartOpen))),
        settings && button('btn-settings', 'Settings', () => openSheet('settings')),
        button('btn-back', 'Back', onBack),
      ),
    );
    chart = sim.state.run ? createChart({ sim, order, onClose: () => openChart(false) }) : null;
    const hand = (member) => (member ? { id: member.id, name: member.name } : null);
    situations = createSituationCards({ sim, order, nearest: (room, about = []) => hand(nearestHand(sim, room, (member) => !about.includes(member.id))), selected: () => hand(selectedCrew && sim.state.crew[selectedCrew]?.alive && !sim.state.crew[selectedCrew].asleep ? sim.state.crew[selectedCrew] : null) });
    root.replaceChildren(el('section', { class: 'ship ship--people' }, nodes.top, buildCrewColumn(), nodes.monitor, buildChannel(), nodes.status, situations.node, nodes.sheet, nodes.info, chart?.node));
    if (chart) chart.node.hidden = !chartOpen;
    buildPanel();
  }

  /** Put the route chart up on the monitor, or take it down. The ship carries on underneath. */
  function openChart(open) {
    if (!chart) return;
    chartOpen = open;
    chart.node.hidden = !open;
    chart.reset();
    nodes.chartButton?.classList.toggle('is-on', open);
    nodes.chartButton?.setAttribute('aria-pressed', String(open));
    if (open) {
      selectedCrew = null;
      movingCrate = null;
      nodes.info.hidden = true;
      chart.update();
    }
  }

  /** On to the next thing (F.3): skip ahead while the crossing is quiet, or stop skipping. A paused clock starts again. */
  function skipAhead() {
    if (!tempo || !sim.state.run) return;
    if (tempo.skipping) {
      tempo.stopSkip();
      return;
    }
    if (!tempo.canSkip(sim)) return;
    clock.resume();
    tempo.skip(sim);
  }

  let lastSkip = '';
  /** The skip button: ready on a quiet crossing, lit while skipping, and otherwise saying what holds the clock. */
  function updateSkip() {
    if (!tempo || !nodes.skip.isConnected) return;
    const on = tempo.skipping;
    const can = on || tempo.canSkip(sim);
    const note = on ? 'Skipping' : can ? 'N key' : 'Not now';
    const key = `${on}|${can}|${note}`;
    if (key === lastSkip) return;
    lastSkip = key;
    nodes.skip.disabled = !can;
    nodes.skip.classList.toggle('is-on', on);
    nodes.skip.setAttribute('aria-pressed', String(on));
    nodes.skip.title = on ? 'Skipping ahead to the next thing: press to stop' : can ? 'On to the next thing: skip ahead until something turns up' : `Normal speed: ${tempo.reason ?? 'something is going on'}`;
    setText(nodes.skipNote, note);
  }

  let lastClock = '';
  function updateClock() {
    // The ship clock (H.8): the day and the hour, and the watch with the deck when one is kept. Fixed width, so
    // the bar beside it never reflows as the time ticks; the state word says paused, running or fast time.
    const fast = !clock.paused && clock.tempo > 1;
    const state = clock.paused ? 'PAUSED ' : tempo?.skipping ? 'SKIP >>' : fast ? `FAST ${Math.round(clock.tempo)}x` : 'running';
    const watch = sim.state.roster.watches > 1 ? ` · ${watchName(sim.state.roster.on)} watch` : '';
    const text = `${state} ${clockText(sim.state.tick)}${watch}`;
    if (text !== lastClock) {
      lastClock = text;
      nodes.clock.textContent = text;
      nodes.clock.classList.toggle('is-fast', fast);
      nodes.clock.title = tempo?.skipping ? 'On to the next thing' : fast ? 'Fast time: nothing is happening' : clock.paused ? 'Paused' : tempo?.reason ? `Normal speed: ${tempo.reason}` : 'Normal speed';
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
      // Whatever she said before this screen opened goes into the channel whole, not typed again.
      updateVoice();
      const last = sim.state.ai.log.at(-1);
      typed = { n: last?.n ?? 0, start: -1e9, shown: -1 };
      canvas.hidden = false;
      size = { x: 0, y: 0, w: 0, h: 0, dpr: 0 }; // force a measure
      monitor = { x: -1, y: -1, w: 0, h: 0 };
      measure();
      subscriptions = [
        input.on('tap', onTap),
        input.on('info', onInfo),
        input.on('key', onKey),
        input.on('dragstart', () => (nodes.info.hidden = true)),
        input.on('press', () => (nodes.info.hidden = true)),
        // Our crew answer every order over the intercom (D-094).
        sim.events.on('crew.ordered', (event) => hear(event, event.room)),
        // They can say no (S2.10): their own words on the intercom, and the reason, naming what they remember, in the panel.
        sim.events.on('crew.refused', (event) => {
          hear(event, event.room);
          refusal = { text: event.reason, until: performance.now() + REFUSAL_MS };
          audio?.play('deny');
        }),
        // And they put lamps back on when the dark gets too much.
        sim.events.on('crew.lit', (event) => hear({ ...event, lamp: true }, event.room)),
        // Something aboard wants dealing with (H.7): the chart comes down so the room and its card are what the captain sees.
        sim.events.on('situation.placed', () => chartOpen && openChart(false)),
        sim.events.on('shot.resolved', (event) => {
          if (event.at !== 'us') return;
          impacts.push({ room: event.room, result: event.result, damage: event.damage, effects: event.effects, tick: event.tick });
          if (event.result === 'hit') shake = { tick: event.tick, strength: SHAKE_BASE + SHAKE_PER_DAMAGE * event.damage };
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
      updateCalls();
      measure();
      const jolt = shakeOffset(clock.alpha);
      ctx.clearRect(size.x, size.y, size.w, size.h);
      drawBezel();
      ctx.save();
      ctx.translate(jolt.x, jolt.y);
      renderer.draw(ctx, {
        clear: false,
        view,
        width: size.x + size.w,
        height: size.y + size.h,
        dpr: size.dpr,
        state: sim.state,
        // Game time, so flames and alarms hold still while paused.
        time: (sim.state.tick + clock.alpha) * TICK_SECONDS,
        alpha: clock.alpha,
        selected: selected?.kind === 'crate' || selected?.kind === 'contact' ? null : selected,
        selectedCrew,
        selectedCrate: selected?.kind === 'crate' ? selected.id : null,
        showCrawlways,
        charges: sim.state.weapons.map((_, slot) => chargeOf(sim, slot)),
        rooms: Object.fromEntries(layout.rooms.map((room) => [room.id, roomView(sim, room.id)])),
        reduceFlicker: reduceMotion(),
      });
      drawSituationRooms();
      drawShots(clock.alpha);
      drawImpacts(clock.alpha);
      ctx.restore();
      situations.update({ boxOf: (room) => roomBox(layout, view, room), bounds: { x: monitor.x, y: monitor.y, w: monitor.w, h: monitor.h }, hidden: chartOpen || Boolean(sheet) });
      drawScanlines();
      updateClock();
      updateSkip();
      updatePanel();
      updateCrewColumn();
      updateHeld();
      updateVoice();
      updateObjection();
      if (chartOpen) chart.update();
    },
    /** Open or fold the route chart (the title's New run opens it). */
    openChart: (open = true) => openChart(open),
    /** Say why the game just paused itself. Shown on the pause button until play resumes. */
    announce(text) {
      notice = text;
      if (nodes?.log) addLine({ who: 'note', tick: sim.state.tick, text: clock.paused ? `Paused: ${text}` : text });
    },
    /** For automated tests and the debug console. */
    debug: {
      targets: () => renderer.targets(view, oursOn(sim), { crates: sim.state.crates }),
      /** Pick something the way a tap would ({ kind, id }), or nothing for the helm's card; nobody stays picked. */
      pick(next = null) {
        movingCrate = null;
        selectCrew(null);
        select(next);
      },
      get movingCrate() {
        return movingCrate;
      },
      get shake() {
        return shake;
      },
      get impacts() {
        return impacts;
      },
      /** The scope's box and where each return is drawn on it. */
      get scope() {
        const hunting = scopeBox ? hunter(scopeView(sim)) : null;
        return scopeBox ? { box: scopeBox, dial: scopeDial(scopeBox), marks: scopeMarks(scopeBox, scopeView(sim)), hunting: hunting ? hunterText(hunting) : null } : null;
      },
      get selectedCrew() {
        return selectedCrew;
      },
      get sheet() {
        return sheet;
      },
      get chartOpen() {
        return chartOpen;
      },
      /** The number of the situation card that is open (H.7), or null. */
      get situationOpen() {
        return situations?.open ?? null;
      },
      get chartSelected() {
        return chart?.selected ?? null;
      },
      /** The route being drawn on the chart in port (H.6), or null. */
      get chartDraft() {
        return chart?.draft ?? null;
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
