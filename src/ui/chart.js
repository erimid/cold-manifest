// Margo's route chart (S3.1, D-106): the sector map, drawn on her monitor
// over the ship schematic. The ship keeps running underneath: plotting a
// course and taking the fix happen in ship time, and the space bar still
// pauses. Points are DOM buttons (44 px or more), lanes an SVG layer under
// them. Everything shown is read from sim.state.run; every change is a command.

import { contractLine } from '../sim/runflow.js';
import { fixOf } from '../sim/combat.js';
import { NODE_KINDS, cheapestRoute, distance, laneBetween, nodeOf, whyNoCourseJump, whyNoPlot } from '../sim/sector.js';
import { el } from './dom.js';

const SVG = 'http://www.w3.org/2000/svg';
const svg = (tag, attrs = {}) => {
  const node = document.createElementNS(SVG, tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
  return node;
};

/** A letter in each glyph as well as its shape and colour, so the kinds read without colour (brief §17). */
const GLYPH = Object.freeze({ port: 'P', empty: '·', hazard: '!', derelict: 'D', checkpoint: 'C' });
const percent = (value) => `${Math.floor(value * 100)}%`;

/**
 * The chart. `order(command)` gives an order and returns whether it was taken; `onClose()` folds the chart.
 * Returns { node, update(), select(id), selected }.
 */
export function createChart({ sim, order, onClose }) {
  const run = () => sim.state.run;
  let selected = null; // a point id
  let drawnFor = ''; // what the static layer was last drawn for

  const lanes = svg('svg', { class: 'chart__lanes', viewBox: '0 0 100 100', preserveAspectRatio: 'none', 'aria-hidden': 'true' });
  const points = el('div', { class: 'chart__points' });
  const plot = el('div', { class: 'chart__plot' }, lanes, points);
  const readout = {
    fuel: el('span', { class: 'chart__stat', id: 'chart-fuel' }),
    jumps: el('span', { class: 'chart__stat', id: 'chart-jumps' }),
    chase: el('span', { class: 'chart__stat', id: 'chart-chase' }),
  };
  const card = el('div', { class: 'chart__card', id: 'chart-card' });
  const jumpNote = el('small', { id: 'chart-jump-note' });
  const jump = el('button', { class: 'btn btn--small chart__jump', type: 'button', id: 'btn-chart-jump', press: () => doJump() }, 'Jump', jumpNote);
  const node = el(
    'div',
    { class: 'panel chart', id: 'chart', hidden: true },
    el(
      'div',
      { class: 'chart__head' },
      el('div', { class: 'stencil chart__title', id: 'chart-title' }, 'Route chart'),
      readout.fuel,
      readout.jumps,
      readout.chase,
      jump,
      el('button', { class: 'btn btn--small', type: 'button', id: 'btn-chart-close', press: () => onClose() }, 'Ship'),
    ),
    el('div', { class: 'chart__body' }, plot, card),
  );

  function doJump() {
    order({ type: 'course.jump' });
  }

  // ---------- the static layer: lanes and points, redrawn only when the run moves ----------

  function draw() {
    const r = run();
    const key = `${r.at}|${r.plot}|${r.visited.length}|${selected}|${r.pursuit?.lastSeen?.node ?? ''}|${r.pursuit?.seen}|${r.pursuit?.done}|${contractLine(sim)}`;
    const claim = r.contract?.status === 'active' && r.contract.claim && !r.contract.claim.done ? r.contract.claim.node : null;
    if (key === drawnFor) return;
    drawnFor = key;
    const { map } = r;
    lanes.replaceChildren();
    for (const lane of map.lanes) {
      const a = nodeOf(map, lane.a);
      const b = nodeOf(map, lane.b);
      const fromHere = lane.a === r.at || lane.b === r.at;
      const plotted = r.plot && fromHere && (lane.a === r.plot || lane.b === r.plot);
      const classes = ['chart__lane', lane.fuel > 1 && 'is-long', fromHere && 'is-open', plotted && 'is-plotted'].filter(Boolean).join(' ');
      lanes.append(svg('line', { x1: a.x * 100, y1: a.y * 100, x2: b.x * 100, y2: b.y * 100, class: classes, 'vector-effect': 'non-scaling-stroke' }));
    }
    const next = new Set(map.lanes.filter((lane) => lane.a === r.at || lane.b === r.at).map((lane) => (lane.a === r.at ? lane.b : lane.a)));
    const tags = [];
    for (const lane of map.lanes) {
      if (lane.fuel < 2) continue;
      const a = nodeOf(map, lane.a);
      const b = nodeOf(map, lane.b);
      tags.push(el('span', { class: 'chart__fuel', style: `left:${((a.x + b.x) / 2) * 100}%;top:${((a.y + b.y) / 2) * 100}%` }, `${lane.fuel}F`));
    }
    const chase = r.pursuit && !r.pursuit.done && r.pursuit.lastSeen ? r.pursuit : null;
    points.replaceChildren(
      ...tags,
      ...map.nodes.map((point) => {
        const classes = [
          'chartnode',
          `chartnode--${point.kind}`,
          point.id === r.at && 'is-here',
          next.has(point.id) && 'is-next',
          r.visited.includes(point.id) && 'is-visited',
          point.id === r.plot && 'is-plotted',
          point.id === selected && 'is-selected',
          point.id === map.delivery && 'is-delivery',
        ].filter(Boolean).join(' ');
        return el(
          'button',
          { class: classes, type: 'button', id: `node-${point.id}`, style: `left:${point.x * 100}%;top:${point.y * 100}%`, 'aria-label': `${point.name}, ${NODE_KINDS[point.kind]}`, press: () => select(point.id === selected ? null : point.id) },
          el('span', { class: 'chartnode__glyph', 'aria-hidden': 'true' }, GLYPH[point.kind]),
          el('span', { class: 'chartnode__name' }, point.name),
          point.id === r.at && el('span', { class: 'chartnode__tag' }, 'Here'),
          point.id === map.delivery && point.id !== r.at && el('span', { class: 'chartnode__tag chartnode__tag--drop' }, 'Drop'),
          point.id === claim && point.id !== r.at && el('span', { class: 'chartnode__tag chartnode__tag--drop', id: 'chart-claim' }, 'Claim'),
        );
      }),
      ...(chase ? [el('span', { class: `chart__contact${chase.seen ? ' is-seen' : ''}`, id: 'chart-contact', style: `left:${nodeOf(map, chase.lastSeen.node).x * 100}%;top:${nodeOf(map, chase.lastSeen.node).y * 100}%` }, chase.seen ? 'Contact' : 'Last seen')] : []),
    );
    drawCard();
  }

  // ---------- the card: the selected point, and what we can do about it ----------

  function drawCard() {
    const r = run();
    const point = selected ? nodeOf(r.map, selected) : null;
    if (!point) {
      card.replaceChildren(
        el('div', { class: 'stencil' }, r.map.name),
        el('p', { class: 'status__hint' }, `Tap a point a lane away to plot a course. Every jump spends fuel and counts against the deadline. ${r.delivered ? 'The cargo is at the drop.' : `The drop is ${distance(r.map, r.at, r.map.delivery)} jumps away at the fewest.`}`),
        r.contract && el('p', { class: 'status__hint', id: 'chart-contract' }, contractLine(sim)),
      );
      return;
    }
    const lane = laneBetween(r.map, r.at, point.id);
    const route = cheapestRoute(r.map, point.id, r.map.delivery);
    const kind = point.kind === 'hazard' ? `${NODE_KINDS.hazard}: ${point.hazard}` : point.role === 'origin' ? 'Port · where we set out' : point.role === 'delivery' ? 'Port · the drop' : NODE_KINDS[point.kind];
    const facts = [
      point.id === r.at ? 'We are here.' : lane ? `One lane from here, ${lane.fuel} fuel.` : `${distance(r.map, r.at, point.id)} jumps from here.`,
      point.id !== r.map.delivery && `${route.jumps} jumps on to the drop, ${route.fuel} fuel at the cheapest.`,
      r.visited.includes(point.id) && point.id !== r.at && 'Visited.',
    ].filter(Boolean);
    const plotted = r.plot === point.id;
    const why = plotted ? whyNoPlot(sim, null) : whyNoPlot(sim, point.id);
    const action = point.id === r.at ? null : el('button', { class: 'btn btn--small', type: 'button', id: 'btn-plot', disabled: why ? true : undefined, press: () => order({ type: 'course.plot', to: plotted ? null : point.id }) && (drawnFor = '') }, plotted ? 'Clear course' : 'Plot course', why && !plotted ? el('small', {}, why) : null);
    card.replaceChildren(el('div', { class: 'status__title', id: 'chart-card-title' }, point.name), el('div', { class: 'stencil' }, kind), el('p', { class: 'status__hint' }, facts.join(' ')), action);
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
    draw();
    const chase = r.pursuit && !r.pursuit.done ? r.pursuit : null;
    const left = r.deadline - r.jumps;
    const problem = whyNoCourseJump(sim);
    const note = !r.plot ? 'Plot a course' : fixOf(sim) < 1 && /fix/.test(problem ?? '') ? `Fix ${percent(fixOf(sim))}` : problem ? (/helm/.test(problem) ? 'No pilot' : /engines/.test(problem) ? 'No drive' : /fuel/.test(problem) ? 'No fuel' : /fix|sensors/.test(problem) ? 'No sensors' : /alongside|clamped/.test(problem) ? 'Ship alongside' : 'Not now') : 'Ready';
    const text = [
      `Fuel ${r.fuel}/${r.fuelMax}`,
      r.delivered ? `Delivered in ${r.jumps}` : left >= 0 ? `Jump ${r.jumps} · ${left} to deadline` : `Jump ${r.jumps} · ${-left} late`,
      !chase ? 'No one following' : chase.seen ? `Followed · ${distance(r.map, chase.at, r.at)} lanes back` : chase.lastSeen ? `Followed · seen ${r.jumps - chase.lastSeen.jump} jumps ago` : 'No contact',
      note,
      String(!problem),
    ].join('|');
    if (text === lastText) return;
    lastText = text;
    const [fuel, jumps, chaseText] = text.split('|');
    readout.fuel.textContent = fuel;
    readout.fuel.classList.toggle('is-low', r.fuel <= 2);
    readout.jumps.textContent = jumps;
    readout.jumps.classList.toggle('is-late', r.late);
    readout.chase.textContent = chaseText;
    readout.chase.classList.toggle('is-warn', Boolean(chase?.seen));
    jumpNote.textContent = note;
    jump.disabled = Boolean(problem);
    jump.classList.toggle('is-ready', !problem);
  }

  return {
    node,
    update,
    select,
    jump: doJump,
    get selected() {
      return selected;
    },
    /** Forget what was drawn, so the next update draws it all again (the chart was folded, or a run began). */
    reset() {
      drawnFor = '';
      lastText = '';
    },
  };
}
