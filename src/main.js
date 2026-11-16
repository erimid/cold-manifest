// Boot, frame loop and the top-level screen state machine (brief §4).
//
// S1.3: the ship view shows the Margin of Error's rooms and doors. Power, air,
// hazards and crew plug into it over the rest of Stage 1.

import { AI_SLOTS } from './ai/categories.js';
import { createClock } from './engine/clock.js';
import { loadContent } from './engine/content-browser.js';
import { createInput } from './engine/input.js';
import { createRng, newRunSeed } from './engine/rng.js';
import { createStateMachine } from './engine/state-machine.js';
import { TICK_SECONDS, createSim } from './sim/sim.js';
import { createBackdrop } from './ui/backdrop.js';
import { el, setPressBinder } from './ui/dom.js';
import { createShipView } from './ui/shipview.js';
import { renderStub, renderTitle } from './ui/title.js';

const VERSION = '0.5.0';

const params = new URLSearchParams(window.location.search);
const flags = {
  debug: params.get('debug') === '1',
  auto: params.get('auto') === '1',
  seed: params.get('seed') || newRunSeed(),
};

const content = loadContent();
const root = document.getElementById('screen');
const viewCanvas = document.getElementById('view');
createBackdrop(document.getElementById('backdrop'), flags.seed);

// The one input module. Everything else asks it what happened.
const input = createInput({ canvas: viewCanvas });
setPressBinder(input.press);

// The simulation and the one clock that drives it.
const sim = createSim({ seed: flags.seed, ship: content.require('ships', 'margin-of-error') });
const clock = createClock({ sim, tickSeconds: TICK_SECONDS });

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

const shipView = createShipView({ canvas: viewCanvas, root, input, sim, clock, debug: flags.debug, onBack: () => machine.go('title') });

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
  ship: shipView,
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
      ].join('\n');
    }
  }
  requestAnimationFrame(frame);
}

machine.go('title');
requestAnimationFrame(frame);

// Handle for the browser console and for automated tests.
window.coldManifest = { version: VERSION, flags, machine, content, sim, clock, input, shipView };
