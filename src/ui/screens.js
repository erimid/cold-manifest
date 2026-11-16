// The screens around the ship (S3.2, brief §18): records hub, contract board, port,
// event view, scene view and run summary. Each is a plain function that fills `root`
// and calls back; main.js owns which one is up. The event view is real since S3.3, and the
// contract board and the port since S3.4; scenes arrive in Stage 4.

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

/** The contract board (S3.4): one contract of each type from content; take one and the run starts. `offers` come from runflow.boardOffers. */
export function renderContracts(root, { offers, onAccept, onBack }) {
  root.replaceChildren(
    screen(
      'board',
      tag('Contract board'),
      el('h2', {}, 'Contracts'),
      el('p', {}, 'Three jobs on the board. The advance is paid when you sign, and comes off the fee at the drop.'),
      el(
        'div',
        { class: 'cards' },
        offers.map((offer) =>
          el(
            'div',
            { class: 'panel card', id: `contract-${offer.type}` },
            tag(offer.typeName),
            el('h3', {}, offer.title),
            el('p', {}, offer.text),
            table([['Client', offer.client], ['Contact', offer.contact], ['Cargo', offer.cargo], ['Pay', `${offer.pay} (${offer.advance} up front)`], ['Deadline', offer.deadline]]),
            el('p', { class: 'dim' }, offer.followed ? `${offer.note} Margo: somebody is already asking where this cargo is going.` : offer.note),
            el('button', { class: 'btn', type: 'button', id: `accept-${offer.type}`, press: () => onAccept(offer) }, 'Take it'),
          ),
        ),
      ),
      back('Back', onBack),
    ),
  );
}

/**
 * A port (S3.4): what is here and what it costs, the bar (a scene), and leaving. `view` comes from
 * runflow.portView; every service is a button that says what it would buy, or why it cannot.
 * At the drop, handing over the cargo ends the run.
 */
export function renderPort(root, { view, onService, onHandOver, onBar, onDepart, onRetire }) {
  const service = (one) =>
    el('button', { class: `btn${one.danger ? ' btn--danger' : ''}`, type: 'button', id: `btn-${one.id}`, disabled: Boolean(one.why), press: () => onService(one) }, one.label, el('small', {}, one.why ? capital(one.why) : one.detail));
  root.replaceChildren(
    screen(
      'port',
      tag(view.isDrop ? 'The drop' : 'Port'),
      el('h2', {}, view.name),
      el('p', {}, view.text),
      table(view.facts, 'port-facts'),
      el(
        'div',
        { class: 'menu' },
        view.deliver && el('button', { class: 'btn', type: 'button', id: 'btn-handover', disabled: Boolean(view.deliver.why), press: onHandOver }, 'Hand over the cargo', el('small', {}, capital(view.deliver.detail))),
        view.services.map(service),
        el('button', { class: 'btn', type: 'button', id: 'btn-hire', disabled: true }, 'Hire crew', el('small', {}, 'Arrives in Stage 4')),
        el('button', { class: 'btn', type: 'button', id: 'btn-bar', press: onBar }, 'The bar', el('small', {}, 'Rumours and scenes')),
        el('button', { class: 'btn', type: 'button', id: 'btn-depart', press: onDepart }, 'Back to the ship', el('small', {}, 'Open the chart')),
        view.canRetire && el('button', { class: 'btn btn--danger', type: 'button', id: 'btn-retire', press: onRetire }, 'Retire here', el('small', {}, 'End the run')),
      ),
    ),
  );
}

const capital = (text) => (text ? text[0].toUpperCase() + text.slice(1) : text);

/**
 * The event view (S3.3, brief §15, §18). `view` comes from narrative/events.js eventView: the title,
 * the text, and the choices, each with the tag for what it requires ("[Ilse, Piloting]") and locked
 * when the requirement is not met. Once a choice is made the outcome is told and one button goes on.
 */
export function renderEvent(root, { view, onChoose, onContinue }) {
  const choice = (one) =>
    el(
      'button',
      { class: `btn choice${one.available ? '' : ' choice--locked'}`, type: 'button', id: `choice-${one.id}`, disabled: !one.available, press: () => onChoose(one) },
      one.tag && el('span', { class: 'choice__tag' }, one.tag, ' '),
      one.label,
    );
  root.replaceChildren(
    screen(
      'event',
      tag('Event'),
      el('h2', { id: 'event-title' }, view.title),
      el('p', { id: 'event-text' }, view.text),
      view.result
        ? el('div', { class: 'event__result' }, el('p', { id: 'event-result' }, view.result.text), el('div', { class: 'menu' }, el('button', { class: 'btn', type: 'button', id: 'btn-event-continue', press: onContinue }, 'Continue')))
        : el('div', { class: 'menu', id: 'event-choices' }, view.choices.map(choice)),
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
