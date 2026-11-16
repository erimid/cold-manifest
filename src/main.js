// Boot, frame loop and the top-level screen state machine (brief §4).
//
// The ship view is the one live screen so far. This file also wires the
// things that sit beside the simulation: sound, settings and auto-pause.

import { AI_SLOTS } from './ai/categories.js';
import { createAudio } from './audio/engine.js';
import { EVENT_SOUNDS } from './audio/patches.js';
import { createClock } from './engine/clock.js';
import { loadContent } from './engine/content-browser.js';
import { createInput } from './engine/input.js';
import { createRng, newRunSeed } from './engine/rng.js';
import { createStateMachine } from './engine/state-machine.js';
import { TICK_SECONDS, createSim } from './sim/sim.js';
import { createBackdrop } from './ui/backdrop.js';
import { el, setPressBinder } from './ui/dom.js';
import { AUTO_PAUSE, createSettings } from './ui/settings.js';
import { createShipView } from './ui/shipview.js';
import { renderStub, renderTitle } from './ui/title.js';

const VERSION = '0.8.0';

const params = new URLSearchParams(window.location.search);
const flags = {
  debug: params.get('debug') === '1',
  auto: params.get('auto') === '1',
  seed: params.get('seed') || newRunSeed(),
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
  // ?autopause=0 and ?sound=0 override the saved settings for this visit (tests use them).
  overrides: { autoPause: onOff('autopause'), sound: onOff('sound') },
});

const content = loadContent();
const root = document.getElementById('screen');
const viewCanvas = document.getElementById('view');
createBackdrop(document.getElementById('backdrop'), flags.seed);

// The one input module. Everything else asks it what happened.
const input = createInput({ canvas: viewCanvas });
setPressBinder(input.press);

// The simulation and the one clock that drives it.
// Placeholder crew until Stage 4 generates them (DECISIONS DF-03, DF-23).
const crew = content.all('crew').map(({ id, name }) => ({ id, name }));
const sim = createSim({ seed: flags.seed, ship: content.require('ships', 'margin-of-error'), crew, lines: content.all('ai-lines'), weapons: content.all('weapons'), ships: content.all('ships') });
const clock = createClock({ sim, tickSeconds: TICK_SECONDS });

// Sound. Nothing can play until the first touch or key press (an iOS rule, and a polite one).
const AudioContextClass = window.AudioContext || window.webkitAudioContext;
const audio = createAudio({ createContext: AudioContextClass ? () => new AudioContextClass() : null });
audio.muted = !settings.values.sound;
settings.onChange((values) => (audio.muted = !values.sound));
input.on('gesture', () => audio.unlock());
input.on('press', () => audio.play('click'));
for (const [type, sound] of Object.entries(EVENT_SOUNDS)) {
  sim.events.on(type, (event) => {
    const name = typeof sound === 'function' ? sound(event) : sound;
    if (name) audio.play(name);
  });
}
clock.onChange(() => audio.play('pause'));

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

const shipView = createShipView({ canvas: viewCanvas, root, input, sim, clock, audio, settings, debug: flags.debug, onBack: () => machine.go('title') });

// Auto-pause (brief §7): stop the clock the moment something goes badly wrong, and say what.
const AUTO_PAUSE_TEXT = {
  fire: (event) => `Fire in ${sim.layout.room(event.room).name}`,
  breach: (event) => `Breach in ${sim.layout.room(event.room).name}`,
  death: (event) => `${sim.state.crew[event.crew].name} is dead`,
};
for (const item of AUTO_PAUSE) {
  sim.events.on(item.event, (event) => {
    if (!settings.values.autoPause[item.id] || clock.paused) return;
    clock.pause(`auto:${item.id}`);
    shipView.announce(AUTO_PAUSE_TEXT[item.id](event));
  });
}

const machine = createStateMachine({
  title: {
    enter() {
      stopTyping = renderTitle(root, {
        greeting: pickGreeting(),
        seed: flags.seed,
        version: VERSION,
        contentSummary: `${content.count('ai-lines')} lines loaded`,
        onNewRun: () => machine.go('contracts'),
        onShip: () => machine.go('ship'),
        onHub: () => machine.go('hub'),
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
      renderStub(root, {
        heading: 'Contract board',
        body: 'Contracts arrive in Stage 3. The ship itself comes first: rooms, power, doors, fire and crew are the rest of Stage 1.',
        onBack: () => machine.go('title'),
      });
    },
  },
  hub: {
    enter() {
      renderStub(root, {
        heading: 'Records',
        body: 'The Wall, unlocks and the history of past runs arrive in Stage 9. Nobody has died yet. Give it time.',
        onBack: () => machine.go('title'),
      });
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

  if (LIVE_STATES.has(machine.state)) clock.advance(dt);
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
        `crew   ${Object.values(sim.state.crew).filter((c) => c.alive).length} alive`,
        `fires  ${Object.values(sim.state.rooms).filter((r) => r.fire > 0).length}`,
        `fight  ${sim.state.fight ? `${sim.state.fight.enemy.ship} ${sim.state.fight.enemy.hull.points}hp, ${sim.state.fight.shots.length} shots` : 'none'}`,
        `margo  ${sim.state.ai.said} said, ${sim.state.ai.queue.length} waiting`,
        `sound  ${audio.muted ? 'off' : audio.unlocked ? 'on' : 'locked'}`,
      ].join('\n');
    }
  }
  requestAnimationFrame(frame);
}

machine.go('title');
requestAnimationFrame(frame);

// Handle for the browser console and for automated tests.
window.coldManifest = { version: VERSION, flags, machine, content, sim, clock, input, shipView, audio, settings };
