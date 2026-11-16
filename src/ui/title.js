// Title screen, plus the stub screen that stands in for screens not built yet.

import { el } from './dom.js';

/** Type `text` into `node` one character at a time. Returns a function that stops it. */
function typeOut(node, text, msPerChar = 28) {
  const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  if (reduce) {
    node.textContent = text;
    return () => {};
  }
  let shown = 0;
  node.textContent = '';
  const timer = setInterval(() => {
    shown += 1;
    node.textContent = text.slice(0, shown);
    if (shown >= text.length) clearInterval(timer);
  }, msPerChar);
  return () => clearInterval(timer);
}

export function renderTitle(root, { greeting, seed, version, contentSummary, onNewRun, onHub, onShip }) {
  const line = el('p', { class: 'margo__line', 'aria-live': 'polite' });

  root.replaceChildren(
    el(
      'section',
      { class: 'title' },
      el(
        'div',
        { class: 'title__mark' },
        el('div', { class: 'stencil' }, 'Freighter Margin of Error'),
        el('h1', {}, 'Cold', el('span', {}, 'Manifest')),
        el('p', { class: 'title__tag' }, 'Carry what nobody else will touch. Keep your crew alive. Mind what is in the hold.'),
      ),
      el(
        'div',
        { class: 'title__side' },
        el(
          'div',
          { class: 'panel margo' },
          el('div', { class: 'margo__who' }, el('span', { class: 'stencil' }, 'M.A.R.G.O.'), el('span', { class: 'stencil' }, 'Core online')),
          line,
        ),
        el(
          'nav',
          { class: 'title__menu' },
          el('button', { class: 'btn', type: 'button', id: 'btn-new-run', press: onNewRun }, 'New run', el('small', {}, 'Open the chart and cross the Reach')),
          el('button', { class: 'btn', type: 'button', id: 'btn-ship', press: onShip }, 'Walk the ship', el('small', {}, 'Three crew, power, air, fire and doors')),
          el('button', { class: 'btn', type: 'button', id: 'btn-hub', press: onHub }, 'Records', el('small', {}, 'The Wall, unlocks, past runs')),
        ),
      ),
      el(
        'footer',
        { class: 'title__foot' },
        el('span', {}, `Build ${version} · Stage 3, session 1`),
        el('span', {}, contentSummary),
        el('span', {}, `Seed ${seed}`),
      ),
    ),
  );

  return typeOut(line, greeting);
}

export function renderStub(root, { heading, body, onBack }) {
  root.replaceChildren(
    el(
      'section',
      { class: 'stub' },
      el('div', { class: 'stencil' }, 'Not built yet'),
      el('h2', {}, heading),
      el('p', {}, body),
      el('button', { class: 'btn', type: 'button', id: 'btn-back', press: onBack }, 'Back'),
    ),
  );
}
