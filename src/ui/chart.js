// Margo's route chart (S3.1, D-106; a route planner since H.6, D-197): the
// sector map, drawn on her monitor over the ship schematic. The ship keeps
// running underneath, and the space bar still pauses.
//
// In port the captain plots a route: tap points one lane at a time from here
// (or let Margo plot the quickest or the cheapest way to a port), see what the
// route costs in fuel and hours and which risks it runs through, and cast off.
// Under way the chart shows the ship on her lane and what the lane holds; off
// the port at the end, the one button takes the fix and jumps in.
//
// Points are DOM buttons (44 px or more), lanes an SVG layer under them.
// Everything shown is read from sim.state.run; every change is a command.

import { contractLine } from '../sim/runflow.js';
import { fixOf } from '../sim/combat.js';
import { NODE_KINDS, bestRoute, hoursLeft, inUnionSpace, laneBetween, laneNow, nodeOf, paceOf, riskOf, routeTotals, whyNoRoute, whyNoRunIn, whyNoSail } from '../sim/sector.js';
import { el } from './dom.js';

const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
};

/** A letter in each glyph as well as its shape and colour, so the kinds read without colour (brief §17). */
const GLYPH = Object.freeze({ port: 'P', empty: '·', hazard: '!', derelict: 'D', checkpoint: 'C' });
/** A letter on each lane's tag for its risk, so the risks read without colour too. An open lane has none. */
const RISK_LETTER = Object.freeze({ patrol: 'P', wreck: 'W', hazard: '!', beacon: 'B', union: 'U', clear: '' });
const percent = (value) => `${Math.floor(value * 100)}%`;
const hoursText = (h) => (h < 1 ? 'under an hour' : `${Math.round(h)} h`);

/**
 * The chart. `order(command)` gives an order and returns whether it was taken; `onClose()` folds the chart.
 * Returns { node, update(), select(id), selected, jump(), draft }.
 */
export function createChart({ sim, order, onClose }) {
  const run = () => sim.state.run;
  let selected = null; // a point id
  let draft = null; // the route being drawn in port: point ids from where we are
  let drawnFor = ''; // what the static layer was last drawn for
  let adopted = ''; // the plotted route last taken up as the draft

  const lanes = svg('svg', { class: 'chart__lanes', viewBox: '0 0 100 100', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  const points = el('div', { class: 'chart__points' });
  const ship = el('span', { class: 'chart__ship', id: 'chart-ship', hidden: true }, 'Us');
  const plot = el('div', { class: 'chart__plot' }, lanes, points, ship);
  const readout = {
    fuel: el('span', { class: 'chart__stat', id: 'chart-fuel' }),
    clock: el('span', { class: 'chart__stat', id: 'chart-clock' }),
    chase: el('span', { class: 'chart__stat', id: 'chart-chase' }),
  };
  const card = el('div', { class: 'chart__card', id: 'chart-card' });
  const actionNote = el('small', { id: 'chart-action-note' });
  const action = el('button', { class: 'btn btn--small chart__jump', type: 'button', id: 'btn-chart-action', press: () => act() }, el('span', { id: 'chart-action-label' }, 'Cast off'), actionNote);
  const node = el(
    'div',
    { class: 'panel chart', id: 'chart', hidden: true },
    el(
      'div',
      { class: 'chart__head' },
      el('div', { class: 'stencil chart__title', id: 'chart-title' }, 'Route chart'),
      readout.fuel,
      readout.clock,
      readout.chase,
      action,
      el('button', { class: 'btn btn--small', type: 'button', id: 'btn-chart-close', press: () => onClose() }, 'Ship'),
    ),
    el('div', { class: 'chart__body' }, plot, card),
  );

  /** The route as it stands: the one being drawn, else the one plotted, else just here. */
  const route = () => {
    const r = run();
    if (r.crossing) return r.crossing.path;
    return draft ?? r.route ?? [r.at];
  };
  const inPort = () => !run().crossing;

  /** The one button: cast off in port, jump in off the port. */
  function act() {
    const r = run();
    if (!r.crossing) {
      if (order({ type: 'route.sail', path: route() })) {
        draft = null;
        selected = null;
        drawnFor = '';
      }
    } else if (r.crossing.phase === 'off port') order({ type: 'route.jump' });
  }

  /** Change the route being drawn, and forget what was drawn. */
  function setDraft(path) {
    draft = path && path.length > 1 ? path : null;
    if (run().route) order({ type: 'route.plot', path: null });
    adopted = run().route?.join() ?? '';
    drawnFor = '';
    draw();
  }

  // ---------- the static layer: lanes and points, redrawn only when something on it changes ----------

  function draw() {
    const r = run();
    const path = route();
    const c = r.crossing;
    const key = `${r.at}|${path.join(',')}|${c?.leg ?? ''}|${c?.phase ?? ''}|${r.visited.length}|${selected}|${contractLine(sim)}`;
    if (key === drawnFor) return;
    drawnFor = key;
    const { map } = r;
    const claim = r.contract?.status === 'active' && r.contract.claim && !r.contract.claim.done ? r.contract.claim.node : null;
    const onRoute = new Set();
    for (let i = 0; i + 1 < path.length; i++) onRoute.add(laneBetween(map, path[i], path[i + 1]));
    const end = path.at(-1);
    const next = inPort() && (path.length === 1 || nodeOf(map, end).kind !== 'port') ? new Set(map.lanes.filter((lane) => lane.a === end || lane.b === end).map((lane) => (lane.a === end ? lane.b : lane.a)).filter((id) => !path.includes(id))) : new Set();

    lanes.replaceChildren();
    // Union space: a band along the top or the bottom of the chart.
    if (map.union?.depth) {
      const top = map.union.side === 'top' ? 0 : (1 - map.union.depth) * 100;
      lanes.append(svg('rect', { x: -4, y: top, width: 108, height: map.union.depth * 100, class: 'chart__union' }));
    }
    const here = laneNow(r);
    for (const lane of map.lanes) {
      const a = nodeOf(map, lane.a);
      const b = nodeOf(map, lane.b);
      const fromEnd = next.has(lane.a === end ? lane.b : lane.b === end ? lane.a : '');
      const classes = ['chart__lane', `chart__lane--${lane.risk ?? 'clear'}`, lane.fuel > 1 && 'is-long', fromEnd && 'is-open', onRoute.has(lane) && 'is-plotted', lane === here && 'is-here'].filter(Boolean).join(' ');
      lanes.append(svg('line', { x1: a.x * 100, y1: a.y * 100, x2: b.x * 100, y2: b.y * 100, class: classes, 'vector-effect': 'non-scaling-stroke' }));
    }
    const tags = map.lanes.map((lane) => {
      const a = nodeOf(map, lane.a);
      const b = nodeOf(map, lane.b);
      const letter = RISK_LETTER[lane.risk] ?? '';
      return el('span', { class: `chart__hours${onRoute.has(lane) ? ' is-plotted' : ''}`, style: `left:${((a.x + b.x) / 2) * 100}%;top:${((a.y + b.y) / 2) * 100}%` }, `${lane.hours}h${lane.fuel > 1 ? ' 2F' : ''}${letter ? ` ${letter}` : ''}`);
    });
    points.replaceChildren(
      ...tags,
      ...map.nodes.map((point) => {
        const classes = [
          'chartnode',
          `chartnode--${point.kind}`,
          point.id === r.at && 'is-here',
          next.has(point.id) && 'is-next',
          r.visited.includes(point.id) && 'is-visited',
          path.includes(point.id) && point.id !== r.at && 'is-plotted',
          point.id === selected && 'is-selected',
          point.id === map.delivery && 'is-delivery',
        ].filter(Boolean).join(' ');
        return el(
          'button',
          { class: classes, type: 'button', id: `node-${point.id}`, style: `left:${point.x * 100}%;top:${point.y * 100}%`, 'aria-label': `${point.name}, ${NODE_KINDS[point.kind]}`, press: () => select(point.id === selected ? null : point.id) },
          el('span', { class: 'chartnode__glyph', 'aria-hidden': 'true' }, GLYPH[point.kind]),
          el('span', { class: 'chartnode__name' }, point.name),
          point.id === r.at && !c && el('span', { class: 'chartnode__tag' }, 'Here'),
          point.id === map.delivery && point.id !== r.at && el('span', { class: 'chartnode__tag chartnode__tag--drop' }, 'Drop'),
          point.id === claim && point.id !== r.at && el('span', { class: 'chartnode__tag chartnode__tag--drop', id: 'chart-claim' }, 'Claim'),
          point.beacon && point.id !== claim && el('span', { class: 'chartnode__tag chartnode__tag--beacon' }, 'Beacon'),
        );
      }),
    );
    drawCard();
  }

  // ---------- the card: what is selected, the route, and what we can do about it ----------

  /** One line about a lane: its risk, its hours and its fuel. */
  const laneLine = (lane) => {
    const risk = riskOf(run(), lane);
    return `${lane.hazard ?? risk?.name ?? 'Open lane'}: ${lane.hours} h, ${lane.fuel} fuel.`;
  };

  /** What the route being drawn adds up to, and what it runs through. */
  function routeSummary() {
    const r = run();
    const path = route();
    if (path.length < 2) return el('p', { class: 'status__hint', id: 'chart-route' }, 'No route yet. Tap a point a lane away to start one, or pick a port and let Margo plot it.');
    const totals = routeTotals(r.map, path);
    const risks = {};
    for (let i = 0; i + 1 < path.length; i++) {
      const risk = riskOf(r, laneBetween(r.map, path[i], path[i + 1]));
      if (risk && risk.id !== 'clear') risks[risk.name] = (risks[risk.name] ?? 0) + 1;
    }
    const through = Object.entries(risks).map(([name, n]) => (n > 1 ? `${name} ×${n}` : name)).join(', ');
    const endsAt = nodeOf(r.map, path.at(-1));
    const left = r.deadline - r.hours;
    return el(
      'p',
      { class: 'status__hint', id: 'chart-route' },
      `Route: ${totals.legs} lane${totals.legs === 1 ? '' : 's'} to ${endsAt.name}${endsAt.kind === 'port' ? '' : ' (not a port yet)'}, ${totals.hours} h at the lane's pace, ${totals.fuel} fuel of ${r.fuel}. `,
      through ? `Through ${through}. ` : 'Nothing on the chart along it. ',
      r.delivered ? '' : left >= totals.hours ? `${Math.floor(left)} h to the deadline.` : `The deadline is ${Math.floor(left)} h off.`,
    );
  }

  function drawCard() {
    const r = run();
    const point = selected ? nodeOf(r.map, selected) : null;
    const parts = [];
    if (r.crossing) {
      // Under way: the lane we are on, and what it holds.
      const lane = laneNow(r);
      const risk = riskOf(r, lane);
      const to = nodeOf(r.map, r.crossing.path[r.crossing.leg + 1]);
      const port = nodeOf(r.map, r.crossing.path.at(-1));
      parts.push(
        el('div', { class: 'stencil', id: 'chart-lane-title' }, r.crossing.phase === 'off port' ? `Off ${port.name}` : `Under way to ${port.name}`),
        el('p', { class: 'status__hint', id: 'chart-lane' }, r.crossing.phase === 'off port' ? `The run in needs a sensor fix and someone at the helm.` : `On the lane to ${to.name}. ${laneLine(lane)} ${risk?.text ?? ''}`),
      );
    } else parts.push(el('div', { class: 'stencil' }, r.map.name), routeSummary());
    if (point) parts.push(...pointCard(point));
    else if (!r.crossing) parts.push(legend());
    if (r.contract) parts.push(el('p', { class: 'status__hint', id: 'chart-contract' }, contractLine(sim)));
    card.replaceChildren(...parts);
  }

  /** The key to the lanes: each risk, its letter and what it tends to bring. */
  function legend() {
    const risks = Object.values(run().risks);
    return el('div', { class: 'chart__legend', id: 'chart-legend' }, ...risks.map((risk) => el('div', { class: `chart__key chart__key--${risk.id}` }, el('span', { class: 'chart__swatch', 'aria-hidden': 'true' }), `${risk.label}${RISK_LETTER[risk.id] ? ` (${RISK_LETTER[risk.id]})` : ''}`)));
  }

  /** The selected point: what it is, how it joins the route, and the buttons to change the route. */
  function pointCard(point) {
    const r = run();
    const path = route();
    const end = path.at(-1);
    const kind = point.kind === 'hazard' ? `${NODE_KINDS.hazard}: ${point.hazard}` : point.role === 'origin' ? 'Port · where we set out' : point.role === 'delivery' ? 'Port · the drop' : NODE_KINDS[point.kind];
    const lane = laneBetween(r.map, end, point.id);
    const facts = [
      point.beacon && 'An old company beacon still calls here.',
      inUnionSpace(r.map, point) && 'In Union space.',
      point.id === r.at ? (r.crossing ? 'The last point we passed.' : 'We are here.') : lane && !path.includes(point.id) ? `A lane from ${point.id === end ? 'here' : nodeOf(r.map, end).name}: ${laneLine(lane)}` : null,
      r.visited.includes(point.id) && point.id !== r.at && 'Visited.',
    ].filter(Boolean);
    const out = [el('div', { class: 'status__title', id: 'chart-card-title' }, point.name), el('div', { class: 'stencil' }, kind), facts.length && el('p', { class: 'status__hint' }, facts.join(' '))];
    if (!inPort()) return out;
    const buttons = [];
    const button = (id, label, why, press) => buttons.push(el('button', { class: 'btn btn--small', type: 'button', id, disabled: why ? true : undefined, press }, label, why ? el('small', {}, why) : null));
    // Add the next lane by hand, when the route does not already end at a port.
    if (point.id !== r.at && !path.includes(point.id) && (path.length === 1 || nodeOf(r.map, end).kind !== 'port')) {
      const why = !lane ? 'no lane from the end of the route' : routeTotals(r.map, [...path, point.id]).fuel > r.fuel ? 'not enough fuel' : null;
      button('btn-route-add', 'Add to route', why, () => setDraft([...path, point.id]));
    }
    // Margo plots the way to a port: the quickest, or the cheapest.
    if (point.kind === 'port' && point.id !== r.at) {
      for (const [id, label, by] of [['btn-route-quick', 'Quickest way here', 'hours'], ['btn-route-cheap', 'Cheapest way here', 'fuel']]) {
        const way = bestRoute(r.map, r.at, point.id, { by, ports: false });
        const why = !way.path ? 'no way here that does not stop at a port first' : whyNoRoute(sim, way.path);
        button(id, label, why && /fuel/.test(why) ? 'not enough fuel' : why, () => setDraft(way.path));
      }
    }
    if (path.length > 1 && path.at(-1) === point.id) button('btn-route-back', 'Undo last lane', null, () => setDraft(path.slice(0, -1)));
    if (path.length > 1) button('btn-route-clear', 'Clear route', null, () => setDraft(null));
    return [...out, el('div', { class: 'chart__buttons' }, ...buttons)];
  }

  function select(id) {
    selected = id;
    drawnFor = '';
    draw();
  }

  // ---------- the live readouts, every frame ----------

  let lastText = '';
  function update() {
    const r = run();
    if (!r) return;
    // A route the ship plotted itself (the bot, a test, a debug order) shows as the draft.
    if (!r.crossing && r.route && r.route.join() !== adopted) {
      draft = [...r.route];
      adopted = r.route.join();
    }
    if (r.crossing && draft) draft = null;
    draw();
    const c = r.crossing;
    // Where the ship is: along the lane she is on.
    if (c) {
      const a = nodeOf(r.map, c.path[c.leg]);
      const b = nodeOf(r.map, c.path[c.leg + 1]);
      const f = Math.min(1, c.t / Math.max(c.length, 1e-9));
      Object.assign(ship.style, { left: `${(a.x + (b.x - a.x) * f) * 100}%`, top: `${(a.y + (b.y - a.y) * f) * 100}%` });
    }
    ship.hidden = !c;
    const chase = r.pursuit && !r.pursuit.done ? r.pursuit : null;
    const left = r.deadline - r.hours;
    let label = 'Cast off';
    let note = '';
    let problem = null;
    if (!c) {
      problem = whyNoSail(sim, route().length > 1 ? route() : null);
      note = route().length < 2 ? 'Plot a route' : problem ? (/port/.test(problem) ? 'Ends at a port' : /fuel/.test(problem) ? 'No fuel' : /alongside|clamped/.test(problem) ? 'Ship alongside' : 'Not now') : `${routeTotals(r.map, route()).hours} h`;
    } else if (c.phase === 'under way') {
      label = 'Under way';
      problem = 'under way';
      note = `${hoursText(hoursLeft(r))} to go${paceOf(sim) < 0.99 ? ` at ${percent(paceOf(sim))}` : ''}`;
    } else {
      label = 'Jump in';
      problem = whyNoRunIn(sim);
      note = fixOf(sim) < 1 && /fix/.test(problem ?? '') ? `Fix ${percent(fixOf(sim))}` : problem ? (/helm/.test(problem) ? 'No pilot' : /engines/.test(problem) ? 'No drive' : /fix|sensors/.test(problem) ? 'No sensors' : /alongside|clamped/.test(problem) ? 'Ship alongside' : 'Not now') : 'Ready';
    }
    const text = [
      `Fuel ${r.fuel}/${r.fuelMax}`,
      r.delivered ? `Delivered at hour ${Math.floor(r.hours)}` : left >= 0 ? `Hour ${Math.floor(r.hours)} · ${Math.floor(left)} h to deadline` : `Hour ${Math.floor(r.hours)} · ${Math.ceil(-left)} h late`,
      !chase ? 'No one following' : chase.contact !== null && chase.seen ? 'Followed · on the scope' : chase.caught ? 'Followed · lost them' : 'Followed',
      label,
      note,
      String(!problem),
    ].join('|');
    if (text === lastText) return;
    lastText = text;
    const [fuel, clock, chaseText] = text.split('|');
    readout.fuel.textContent = fuel;
    readout.fuel.classList.toggle('is-low', r.fuel <= 2);
    readout.clock.textContent = clock;
    readout.clock.classList.toggle('is-late', r.late);
    readout.chase.textContent = chaseText;
    readout.chase.classList.toggle('is-warn', Boolean(chase && chase.contact !== null));
    action.querySelector('#chart-action-label').textContent = label;
    actionNote.textContent = note;
    action.disabled = Boolean(problem);
    action.classList.toggle('is-ready', !problem);
  }

  return {
    node,
    update,
    select,
    jump: act,
    get selected() {
      return selected;
    },
    get draft() {
      return draft;
    },
    /** Forget what was drawn, so the next update draws it all again (the chart was folded, or a run began). */
    reset() {
      drawnFor = '';
      lastText = '';
    },
  };
}
