// Boot, frame loop and the top-level screen state machine (brief §4).
//
// The ship view is the one live screen so far. This file also wires the
// things that sit beside the simulation: sound, settings and auto-pause.

import { AI_SLOTS } from './ai/categories.js';
import { createAudio } from './audio/engine.js';
import { EVENT_SOUNDS } from './audio/patches.js';
import { createClock } from './engine/clock.js';
import { createTempo } from './sim/tempo.js';
import { loadContent } from './engine/content-browser.js';
import { createInput } from './engine/input.js';
import { createRng, newRunSeed } from './engine/rng.js';
import { createStateMachine } from './engine/state-machine.js';
import { findCrew, ourCrew } from './sim/combat.js';
import { eventView, waiting } from './narrative/events.js';
import { FAILURES, contractActive } from './sim/contracts.js';
import { boardOffers, lostEnding, portView, screenForArrival, summarize } from './sim/runflow.js';
import { nodeOf } from './sim/sector.js';
import { unseen } from './sim/senses.js';
import { TICK_SECONDS, createSim } from './sim/sim.js';
import { createBackdrop } from './ui/backdrop.js';
import { el, setPressBinder } from './ui/dom.js';
import { AUTO_PAUSE, createSettings } from './ui/settings.js';
import { createShipView } from './ui/shipview.js';
import { renderContracts, renderEvent, renderHub, renderPort, renderScene, renderSummary } from './ui/screens.js';
import { renderTitle } from './ui/title.js';

const VERSION = '0.37.0';

const params = new URLSearchParams(window.location.search);
const flags = {
  debug: params.get('debug') === '1',
  auto: params.get('auto') === '1',
  seed: params.get('seed') || newRunSeed(),
  // How many watches the crew starts in; ?watches=0 keeps no watch bill, so nobody walks off (for the browser tests).
  watches: ['0', '1', '2', '3'].includes(params.get('watches')) ? Number(params.get('watches')) : 2,
  // How Margo runs what nobody mans (H.5); ?margo=book has her run it all by the book, as H.4 did.
  margo: params.get('margo') === 'book' ? 'book' : 'own',
};
const onOff = (name) => (params.has(name) ? params.get(name) !== '0' : undefined);

function storage() {
  try {
    return window.localStorage;
  } catch {
    return null; // blocked (private mode, an embedded frame)
  }
}
const settings = createSettings({
  storage: storage(),
  touch: window.matchMedia('(pointer: coarse)').matches,
  // ?autopause=0, ?sound=0 and ?fast=0 override the saved settings for this visit (tests use them).
  overrides: { autoPause: onOff('autopause'), sound: onOff('sound'), fastTime: onOff('fast') },
});

const content = loadContent();
const root = document.getElementById('screen');
const viewCanvas = document.getElementById('view');
createBackdrop(document.getElementById('backdrop'), flags.seed);

// The one input module. Everything else asks it what happened.
const input = createInput({ canvas: viewCanvas });
setPressBinder(input.press);

// The simulation and the one clock that drives it. A run is one sim: a new run builds a new one (newGame),
// and everything that listens to a sim is wired there. The first is the sandbox the title's "Walk the ship"
// opens; it has no contract, so arriving in port does not open a screen.
// Placeholder crew until Stage 4 generates them (DECISIONS DF-03, DF-23).
const crew = content.all('crew').map(({ id, name, role, engineer, skills, traits }) => ({ id, name, role, engineer, skills, traits }));
// What the crew remember and refuse and what Margo objects to are content too (S3.3).
const rules = { memories: content.all('memories'), refusals: content.all('refusals'), risks: content.all('risks') };
// Contracts, the clients they are for, and what ports charge (S3.4).
const factions = content.all('factions');
const ports = content.all('ports');
const crewReplies = Object.fromEntries(content.all('crew').map(({ id, replies }) => [id, replies]));

// Sound. Nothing can play until the first touch or key press (an iOS rule, and a polite one).
const AudioContextClass = window.AudioContext || window.webkitAudioContext;
const audio = createAudio({ createContext: AudioContextClass ? () => new AudioContextClass() : null });
audio.muted = !settings.values.sound;
settings.onChange((values) => (audio.muted = !values.sound));
input.on('gesture', () => audio.unlock());
input.on('press', () => audio.play('click'));

const HIDDEN_ALARMS = new Set(['fire.started', 'breach.opened']);

/** Screens where the sim is live. Everywhere else the clock does not run. */
const LIVE_STATES = new Set(['ship']);

/** A greeting for the title screen: a seeded pick from lines that need no slots. */
function pickGreeting() {
  const lines = content
    .all('ai-lines')
    .filter((line) => line.category === 'greeting' && !AI_SLOTS.some((slot) => line.text.includes(`{${slot}}`)));
  if (!lines.length) return 'Core online.';
  return createRng(`title:${flags.seed}`).weighted(lines).text;
}

let stopTyping = () => {};

// Auto-pause (brief §7): stop the clock the moment something goes badly wrong, and say what.
const AUTO_PAUSE_TEXT = {
  fired: (event) => `${event.name} ${event.warn ? 'fires a warning shot' : 'is firing on us'}`,
  contact: (event) => `${event.name} closing on us`,
  boarded: (event) => `Boarders in ${sim.layout.room(event.room).name}`,
  fire: (event) => `Fire in ${sim.layout.room(event.room).name}`,
  breach: (event) => `Breach in ${sim.layout.room(event.room).name}`,
  death: (event) => `${findCrew(sim, event.crew)?.member.name ?? 'Someone'} is dead`,
  objection: (event) => (event.kind === 'refuse' ? 'Margo refuses' : 'Margo objects'),
  situation: (event) => `${event.title}: ${sim.layout.room(event.room)?.name ?? 'aboard'}`,
  refusal: (event) => `${findCrew(sim, event.crew)?.member.name ?? 'Someone'} refuses`,
};

// ---------- the run loop (S3.2, D-108) ----------

/** The run in progress, or null. `contract` (the board's offer) is null in the sandbox. */
let sim;
let clock;
/** Fast time on a quiet crossing (H.8): how many times normal speed the clock runs this frame. */
let tempo;
let shipView;
let runInfo = null;
/** Finished runs this visit, and the crew who died in them (the records hub; the real Wall is Stage 9). */
const history = [];
const wall = [];
let runCount = 0;

/** Build a sim, its clock and its ship view, and wire the sound, auto-pause and run events to them. */
function newGame(seed, { contract = null, pursuit } = {}) {
  // Only a run with a contract meets events: the sandbox has nowhere to show them.
  sim = createSim({ seed, ship: content.require('ships', 'margin-of-error'), crew, watches: flags.watches, margo: flags.margo, lines: content.all('ai-lines'), weapons: content.all('weapons'), rules, events: contract ? content.all('events') : [], sector: content.require('sectors', 'the-reach'), run: pursuit === undefined ? {} : { pursuit }, contract: contract?.template ?? null, ports, encounters: content.all('encounters') });
  clock = createClock({ sim, tickSeconds: TICK_SECONDS });
  tempo = createTempo();
  clock.onChange(() => audio.play('pause'));
  runInfo = { contract, seed, seen: new Set([sim.state.run.at]), pending: null, doom: null, handedOver: false };
  const mine = sim;
  const mineInfo = runInfo;
  for (const [type, sound] of Object.entries(EVENT_SOUNDS)) {
    sim.events.on(type, (event) => {
      const name = typeof sound === 'function' ? sound(event) : sound;
      // No alarm sounds for a fire or a hole nobody can see yet.
      if (name && !(HIDDEN_ALARMS.has(type) && unseen(mine, event))) audio.play(name);
    });
  }
  shipView = createShipView({ canvas: viewCanvas, root, input, sim, clock, tempo, audio, settings, debug: flags.debug, crewReplies, onBack: () => machine.go('title') });
  for (const item of AUTO_PAUSE) {
    const trip = (event) => {
      if (!settings.values.autoPause[item.id] || clock.paused) return;
      clock.pause(`auto:${item.id}`);
      shipView.announce(AUTO_PAUSE_TEXT[item.id](event));
    };
    sim.events.on(item.event, (event) => !(item.found && unseen(mine, event)) && trip(event));
    if (item.found) sim.events.on(item.found, trip);
  }
  // The jump into port at the end of a crossing opens the port, every time (H.6: nowhere else is arrived at).
  sim.events.on('sector.arrived', (event) => {
    if (!mineInfo.contract) return;
    mineInfo.seen.add(event.node);
    mineInfo.pending = screenForArrival(event.kind) ? { screen: screenForArrival(event.kind), node: event.node } : null;
  });
  sim.events.on('ship.wrecked', () => {
    mineInfo.doom = 'destroyed';
  });
  // A contract can fail out on the chart (the cargo over the side, a courier late): say so where the captain is looking.
  const view = shipView;
  sim.events.on('contract.failed', (event) => view.announce(`Contract failed: ${FAILURES[event.reason] ?? event.reason}`));
  sim.events.on('fuel.out', (event) => {
    if (nodeOf(mine.state.run.map, event.node).kind !== 'port') mineInfo.doom = 'stranded';
  });
}

newGame(flags.seed);

/** End the run: a summary on screen, and the records hub told about it. */
function finishRun(kind) {
  const info = runInfo;
  info.ended = kind;
  // Retiring with the contract still in hand walks away from it (S3.4).
  if (kind === 'retired' && contractActive(sim)) settle({ type: 'contract.abandon' });
  const summary = summarize(sim, kind, { factions });
  history.push({ kind, contract: info.contract?.id ?? null });
  for (const { member } of ourCrew(sim)) if (!member.alive) wall.push(`${member.name}, ${info.contract?.title ?? 'a run with no contract'}`);
  machine.go('summary', { summary });
}

/** Back to the ship with the chart up, unless the run is already lost. */
function backToShip() {
  const doom = runInfo.doom ?? lostEnding(sim);
  if (doom) finishRun(doom);
  else {
    machine.go('ship');
    // An event can put a ship on the scope coming for us: the chart stays down so the scope is what the captain sees.
    // Nor over something waiting aboard (H.7): its room and its card are what the captain needs to see.
    shipView.openChart(!waiting(sim).length && !sim.state.scope.contacts.some((contact) => contact.state === 'closing' || contact.state === 'alongside'));
  }
}

/** Once a frame, after the sim has run: lost runs end, and arrivals open their screen. */
function settleRun() {
  if (!runInfo?.contract || runInfo.ended || machine.state !== 'ship') return;
  const lost = runInfo.doom === 'destroyed' ? 'destroyed' : lostEnding(sim);
  if (lost) return finishRun(lost);
  // An event the sim has put on the table (S3.3) comes before anything else the arrival opens.
  if (eventView(sim)) return machine.go('event');
  if (!runInfo.pending) return;
  const { screen: next, node } = runInfo.pending;
  runInfo.pending = null;
  machine.go(next, { node });
}

/** Give an order on a screen where the clock is stopped: one tick carries it out. Returns false if it was refused. */
function settle(command) {
  if (sim.whyNot(command)) return false;
  sim.enqueue(command);
  sim.step();
  return true;
}

function startRun(offer) {
  runCount += 1;
  newGame(`${flags.seed}-run${runCount}`, { contract: offer, pursuit: offer.followed });
  machine.go('ship');
  shipView.openChart(true);
}

const toTitle = () => machine.go('title');
const toBoard = () => machine.go('contracts');
const toHub = () => machine.go('hub');
const portNode = (node) => nodeOf(sim.state.run.map, node);

const machine = createStateMachine({
  title: {
    enter() {
      stopTyping = renderTitle(root, {
        greeting: pickGreeting(),
        seed: flags.seed,
        version: VERSION,
        contentSummary: `${content.count('ai-lines')} lines loaded`,
        resume: Boolean(runInfo?.contract && !runInfo.ended),
        onNewRun: toBoard,
        onResume: () => {
          machine.go('ship');
          shipView.openChart(true);
        },
        onShip: () => machine.go('ship'),
        onHub: toHub,
      });
    },
    exit() {
      stopTyping();
    },
  },
  ship: {
    enter() {
      shipView.enter();
      audio.startLoop('hum');
    },
    exit() {
      shipView.exit();
      audio.stopLoop('hum');
    },
    update: (dt) => shipView.update(dt),
  },
  contracts: {
    enter() {
      // The board for the next run, drawn from its seed: the same seed shows the same contracts.
      const offers = boardOffers(content.all('contracts'), { seed: `${flags.seed}-run${runCount + 1}`, factions });
      renderContracts(root, { offers, onAccept: startRun, onBack: toTitle });
    },
  },
  hub: {
    enter() {
      renderHub(root, { history, wall, onBack: toTitle });
    },
  },
  port: {
    enter({ params }) {
      const draw = () =>
        renderPort(root, {
          view: portView(sim),
          // The clock is stopped on this screen; one tick settles each order.
          onService: (service) => {
            settle(service.command);
            draw();
          },
          onBar: () => machine.go('scene', { title: `The bar at ${portNode(params.node).name}`, back: () => machine.go('port', params) }),
          onDepart: backToShip,
          onHandOver: () => {
            const late = sim.state.run.late;
            if (settle({ type: 'contract.deliver' })) finishRun(late ? 'late' : 'delivered');
            else draw();
          },
          onRetire: () => finishRun('retired'),
        });
      draw();
    },
  },
  event: {
    enter() {
      // The clock is stopped on this screen; one tick carries out each answer (the same way the port refuels).
      const give = settle;
      const draw = () => {
        const view = eventView(sim);
        if (!view) return backToShip();
        renderEvent(root, {
          view,
          onChoose: (choice) => {
            give({ type: 'event.choose', choice: choice.id });
            draw();
          },
          onContinue: () => {
            give({ type: 'event.dismiss' });
            draw(); // a follow-up event, or back to the ship
          },
        });
      };
      draw();
    },
  },
  scene: {
    enter({ params }) {
      renderScene(root, { title: params.title, onBack: params.back });
    },
  },
  summary: {
    enter({ params }) {
      renderSummary(root, { summary: params.summary, onNewRun: toBoard, onHub: toHub, onTitle: toTitle });
    },
  },
});

// Pause is global: the space bar works on any live screen (brief §7).
input.on('key', ({ action }) => {
  if (action === 'pause' && LIVE_STATES.has(machine.state)) clock.toggle();
});

// Debug overlay (?debug=1). Grows a control for each system as it is built (PLAN.md §4).
const debug = flags.debug ? document.body.appendChild(el('div', { class: 'debug' })) : null;

let last = performance.now();
let frames = 0;
let fpsWindow = 0;
let fps = 0;

function frame(now) {
  // Real time since the last frame. A stall (background tab) is treated as a short frame.
  const dt = Math.min(0.25, Math.max(0, (now - last) / 1000));
  last = now;

  if (LIVE_STATES.has(machine.state)) {
    // Fast time when nothing is happening on a crossing (H.8, D-207); straight back to normal when anything does.
    if (clock.paused) tempo.reset();
    else clock.tempo = tempo.step(sim, dt, settings.values.fastTime !== false);
    if (clock.paused) clock.tempo = 1;
    clock.advance(dt);
  }
  settleRun();
  machine.update(dt);

  if (debug) {
    frames += 1;
    fpsWindow += dt;
    if (fpsWindow >= 0.5) {
      fps = Math.round(frames / fpsWindow);
      frames = 0;
      fpsWindow = 0;
      debug.textContent = [
        'DEBUG',
        `fps    ${fps}`,
        `state  ${machine.state}`,
        `tick   ${sim.state.tick}`,
        `clock  ${clock.paused ? 'paused' : 'running'}`,
        `seed   ${flags.seed}`,
        `auto   ${flags.auto ? 'on' : 'off'}`,
        `crew   ${ourCrew(sim).filter(({ member }) => member.alive).length} alive`,
        `fires  ${Object.values(sim.state.rooms).filter((r) => r.fire > 0).length}`,
        `scope  ${sim.state.scope.contacts.length} contacts, ${sim.state.scope.drones.length} drones, ${sim.state.shots.length} shots, hull ${sim.state.hull.points}`,
        `margo  ${sim.state.ai.said} said, ${sim.state.ai.queue.length} waiting`,
        `event  ${sim.state.run?.events.open ? `${sim.state.run.events.open.id}${sim.state.run.events.open.result ? ' (answered)' : ''}` : 'none'}, ${sim.state.run?.events.aboard.length ?? 0} aboard, ${sim.state.run?.events.count ?? 0} met`,
        `chart  ${sim.state.run ? `${sim.state.run.at}${sim.state.run.crossing ? `>${sim.state.run.crossing.path[sim.state.run.crossing.leg + 1]} ${sim.state.run.crossing.phase}` : ''} fuel ${sim.state.run.fuel} hours ${Math.floor(sim.state.run.hours)}/${sim.state.run.deadline}${sim.state.run.pursuit ? ` chase ${sim.state.run.pursuit.done ? 'done' : sim.state.run.pursuit.contact ?? Math.ceil(sim.state.run.pursuit.wait) + 'h'}` : ''}` : 'none'}`,
        `trust  ${Math.round(sim.state.ai.trust)}, refused ${sim.state.ai.refusals}${sim.state.ai.objection ? `, holding ${sim.state.ai.objection.command.type}` : ''}`,
        `sound  ${audio.muted ? 'off' : audio.unlocked ? 'on' : 'locked'}`,
      ].join('\n');
    }
  }
  requestAnimationFrame(frame);
}

machine.go('title');
requestAnimationFrame(frame);

// Handle for the browser console and for automated tests. The run changes, so these read the current one.
window.coldManifest = {
  version: VERSION,
  flags,
  machine,
  content,
  input,
  audio,
  settings,
  history,
  get sim() {
    return sim;
  },
  get clock() {
    return clock;
  },
  get tempo() {
    return tempo;
  },
  get shipView() {
    return shipView;
  },
  get run() {
    return runInfo;
  },
};
