// Boot, frame loop and the top-level screen state machine (brief §4).
//
// S1.1: title screen plus stub screens. The sim clock, pause and the input
// layer arrive in S1.2; until then the only input is DOM buttons.

import { AI_SLOTS } from './ai/categories.js';
import { loadContent } from './engine/content-browser.js';
import { createRng, newRunSeed } from './engine/rng.js';
import { createStateMachine } from './engine/state-machine.js';
import { createBackdrop } from './ui/backdrop.js';
import { el } from './ui/dom.js';
import { renderStub, renderTitle } from './ui/title.js';

const VERSION = '0.1.0';

const params = new URLSearchParams(window.location.search);
const flags = {
  debug: params.get('debug') === '1',
  auto: params.get('auto') === '1',
  seed: params.get('seed') || newRunSeed(),
};

const content = loadContent();
const root = document.getElementById('screen');
createBackdrop(document.getElementById('backdrop'), flags.seed);

/** A greeting for the title screen: a seeded pick from lines that need no slots. */
function pickGreeting() {
  const lines = content
    .all('ai-lines')
    .filter((line) => line.category === 'greeting' && !AI_SLOTS.some((slot) => line.text.includes(`{${slot}}`)));
  if (!lines.length) return 'Core online.';
  return createRng(`title:${flags.seed}`).weighted(lines).text;
}

let stopTyping = () => {};

const machine = createStateMachine({
  title: {
    enter() {
      stopTyping = renderTitle(root, {
        greeting: pickGreeting(),
        seed: flags.seed,
        version: VERSION,
        contentSummary: `${content.count('ai-lines')} lines loaded`,
        onNewRun: () => machine.go('contracts'),
        onHub: () => machine.go('hub'),
      });
    },
    exit() {
      stopTyping();
    },
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

// Debug overlay (?debug=1). Grows a control for each system as it is built (PLAN.md §4).
const debug = flags.debug ? document.body.appendChild(el('div', { class: 'debug' })) : null;

let last = performance.now();
let frames = 0;
let fpsWindow = 0;
let fps = 0;

function frame(now) {
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  machine.update(dt);

  if (debug) {
    frames += 1;
    fpsWindow += dt;
    if (fpsWindow >= 0.5) {
      fps = Math.round(frames / fpsWindow);
      frames = 0;
      fpsWindow = 0;
      debug.textContent = `DEBUG\nfps    ${fps}\nstate  ${machine.state}\nseed   ${flags.seed}\nauto   ${flags.auto ? 'on' : 'off'}`;
    }
  }
  requestAnimationFrame(frame);
}

machine.go('title');
requestAnimationFrame(frame);

// Handle for the browser console and for automated tests.
window.coldManifest = { version: VERSION, flags, machine, content };
