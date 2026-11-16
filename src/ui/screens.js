// The screens around the ship (S3.2, brief §18): records hub, contract board, port,
// event view, scene view and run summary. Each is a plain function that fills `root`
// and calls back; main.js owns which one is up. All of them are working stubs: real
// content arrives with S3.3 (events), S3.4 (contracts, ports) and Stage 4 (scenes).

import { el } from './dom.js';

const tag = (text) => el('div', { class: 'stencil' }, text);

function screen(id, ...children) {
  return el('section', { class: 'stub stub--wide', id }, ...children);
}

const back = (label, press, id = 'btn-back') => el('button', { class: 'btn', type: 'button', id, press }, label);

function table(rows, id) {
  return el('dl', { class: 'facts', id }, rows.flatMap(([label, value]) => [el('dt', {}, label), el('dd', {}, String(value))]));
}

/** The records hub: ship select, the Wall, unlocks and stats. `history` is this visit's finished runs. */
export function renderHub(root, { history, wall, onBack }) {
  const delivered = history.filter((run) => run.kind === 'delivered' || run.kind === 'late').length;
  root.replaceChildren(
    screen(
      'hub',
      tag('Company records'),
      el('h2', {}, 'Records'),
      el(
        'div',
        { class: 'cards' },
        el('div', { class: 'panel card', id: 'hub-ship' }, tag('Ship'), el('p', {}, 'Margin of Error. Hauler, mostly hold. The only hull the company will lease you.'), el('p', { class: 'dim' }, 'More hulls arrive in Stage 9.')),
        el(
          'div',
          { class: 'panel card', id: 'hub-wall' },
          tag('The Wall'),
          wall.length ? el('ul', { class: 'list' }, wall.map((name) => el('li', {}, name))) : el('p', {}, 'Nobody has died yet. Give it time.'),
          el('p', { class: 'dim' }, 'Epitaphs and the permanent list arrive in Stage 9. This one lasts until you close the tab.'),
        ),
        el('div', { class: 'panel card', id: 'hub-unlocks' }, tag('Unlocks'), el('p', {}, 'None yet.'), el('p', { class: 'dim' }, 'Arrive in Stage 9.')),
        el('div', { class: 'panel card', id: 'hub-stats' }, tag('Stats'), table([['Runs this visit', history.length], ['Delivered', delivered], ['Lost or retired', history.length - delivered]])),
      ),
      back('Back', onBack),
    ),
  );
}

/** The contract board: pick one and the run starts. */
export function renderContracts(root, { contracts, onAccept, onBack }) {
  root.replaceChildren(
    screen(
      'board',
      tag('Contract board'),
      el('h2', {}, 'Contracts'),
      el('p', {}, 'Three on the board. Real ones arrive in S3.4; these are stand-ins with the right shape.'),
      el(
        'div',
        { class: 'cards' },
        contracts.map((contract) =>
          el(
            'div',
            { class: 'panel card', id: `contract-${contract.id}` },
            tag(contract.type),
            el('h3', {}, contract.title),
            table([['Client', contract.client], ['Cargo', contract.cargo], ['Pay', contract.pay]]),
            el('p', { class: 'dim' }, contract.note),
            el('button', { class: 'btn', type: 'button', id: `accept-${contract.id}`, press: () => onAccept(contract) }, 'Take it'),
          ),
        ),
      ),
      back('Back', onBack),
    ),
  );
}

/** A port: services as stubs, the bar (a scene), and leaving. At the drop, handing over the cargo ends the run. */
export function renderPort(root, { node, fuel, fuelMax, isDrop, onRefuel, onBar, onDepart, onHandOver, onRetire }) {
  const full = fuel >= fuelMax;
  root.replaceChildren(
    screen(
      'port',
      tag(isDrop ? 'The drop' : 'Port'),
      el('h2', {}, node.name),
      el('p', {}, isDrop ? 'The consignee is waiting at the dock.' : 'A company dock with a fuel line, a repair gang that is never on shift, and a bar.'),
      table([['Fuel', `${fuel} of ${fuelMax}`]], 'port-facts'),
      el(
        'div',
        { class: 'menu' },
        isDrop && el('button', { class: 'btn', type: 'button', id: 'btn-handover', press: onHandOver }, 'Hand over the cargo'),
        el('button', { class: 'btn', type: 'button', id: 'btn-refuel', disabled: full, press: onRefuel }, 'Refuel', el('small', {}, full ? 'The tanks are full' : 'Free for now')),
        el('button', { class: 'btn', type: 'button', id: 'btn-repair', disabled: true }, 'Repairs', el('small', {}, 'Arrive in S3.4')),
        el('button', { class: 'btn', type: 'button', id: 'btn-hire', disabled: true }, 'Hire crew', el('small', {}, 'Arrives in Stage 4')),
        el('button', { class: 'btn', type: 'button', id: 'btn-bar', press: onBar }, 'The bar', el('small', {}, 'Rumours and scenes')),
        el('button', { class: 'btn', type: 'button', id: 'btn-depart', press: onDepart }, 'Back to the ship', el('small', {}, 'Open the chart')),
        !isDrop && el('button', { class: 'btn btn--danger', type: 'button', id: 'btn-retire', press: onRetire }, 'Retire here', el('small', {}, 'End the run')),
      ),
    ),
  );
}

/** The event view: a title, some text and choices. Every choice does nothing yet. */
export function renderEvent(root, { event, onChoose }) {
  root.replaceChildren(
    screen(
      'event',
      tag('Event'),
      el('h2', {}, event.title),
      el('p', {}, event.text),
      el(
        'div',
        { class: 'menu' },
        event.choices.map((choice) => el('button', { class: 'btn', type: 'button', id: `choice-${choice.id}`, press: () => onChoose(choice) }, choice.label, choice.note && el('small', {}, choice.note))),
      ),
    ),
  );
}

/** The scene view: empty until Stage 4 gives crew something to say to each other. */
export function renderScene(root, { title, onBack }) {
  root.replaceChildren(screen('scene', tag('Scene'), el('h2', {}, title), el('p', {}, 'Nobody wants to talk yet. Scenes between crew arrive in Stage 4.'), back('Back', onBack)));
}

/** The run summary. `summary` comes from runflow.summarize. */
export function renderSummary(root, { summary, onNewRun, onHub, onTitle }) {
  root.replaceChildren(
    screen(
      'summary',
      tag('Run summary'),
      el('h2', { id: 'summary-title' }, summary.title),
      el('p', {}, summary.headline),
      table(summary.rows, 'summary-facts'),
      summary.dead.length ? el('p', { class: 'dim' }, `Lost: ${summary.dead.join(', ')}.`) : null,
      el(
        'div',
        { class: 'menu' },
        el('button', { class: 'btn', type: 'button', id: 'btn-again', press: onNewRun }, 'New run', el('small', {}, 'Back to the contract board')),
        el('button', { class: 'btn', type: 'button', id: 'btn-records', press: onHub }, 'Records'),
        el('button', { class: 'btn', type: 'button', id: 'btn-title', press: onTitle }, 'Title'),
      ),
    ),
  );
}
