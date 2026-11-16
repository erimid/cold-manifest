// The run loop around the sim (S3.2, D-108): the contract board, which screen an arrival opens,
// how a run ends, and what the run summary says. DOM-free, so Node tests and the bot can use it.
//
// Contracts are content since S3.4 (contracts.js, content/contracts/); the board offers one of each
// type. The saved run end and the career come in S3.6. Events are content since S3.3 (narrative/events.js).

import { createRng } from '../engine/rng.js';
import { ourCrew } from './combat.js';
import { CONTRACT_TYPES, FAILURES, cargoCount, contractCrates, contractOf, settlement } from './contracts.js';
import { FREE_PORT, portHere, refuelQuote, repairQuote, saleQuote } from './port.js';
import { nodeOf } from './sector.js';

/** How many contracts the board shows: one of each type there is. */
export const BOARD_SIZE = Object.keys(CONTRACT_TYPES).length;

/** The words for a contract's lateness rule on the board. */
function deadlineText(template) {
  const late = template.latePay ?? 0.5;
  if (late === 0) return 'Strict: late is failed';
  return `Late pays ${Math.round(late * 100)}%`;
}

/** The cargo, as the board says it: "4 crates: Manifest 0412 · Agricultural pumps". */
function cargoText(template) {
  const count = cargoCount(template);
  const first = template.cargo[0];
  const what = template.cargo.length === 1 ? first.label : `${first.label} and more`;
  return `${template.claim ? `Up to ${count}` : count} crate${count === 1 ? '' : 's'}: ${what}`;
}

/**
 * The contract board for a run: one offer of each type, picked from the templates by the seed, each with
 * the dice for whether it is followed already thrown (so the board can say so). `factions` gives the
 * clients their names. Returns [{ id, type, typeName, title, client, contact, text, note, cargo, pay, advance, deadline, followed, template }].
 */
export function boardOffers(templates, { seed, factions = [] }) {
  const rng = createRng(`board:${seed}`);
  const names = new Map(factions.map((faction) => [faction.id, faction.name]));
  const offers = [];
  for (const [type, typeName] of Object.entries(CONTRACT_TYPES)) {
    const pool = templates.filter((template) => template.type === type);
    if (!pool.length) continue;
    const template = rng.pick(pool);
    offers.push({
      id: template.id,
      type,
      typeName,
      title: template.title,
      client: names.get(template.client) ?? template.client,
      contact: template.contact,
      text: template.text,
      note: template.note ?? '',
      cargo: cargoText(template),
      pay: template.pay,
      advance: template.advance ?? 0,
      deadline: deadlineText(template),
      followed: rng.chance(template.followed ?? 0.5),
      claim: Boolean(template.claim),
      template,
    });
  }
  return offers;
}

/**
 * Which screen arriving at a point opens: 'port' or null. Since H.6 a crossing only ever ends at a port; events
 * come along the lanes when the dice and the content say so (narrative/events.js, S3.3), and the screen follows.
 */
export function screenForArrival(kind) {
  return kind === 'port' ? 'port' : null;
}

/** How a run can end, in the words the summary uses. */
export const ENDINGS = Object.freeze({
  delivered: 'Delivered',
  late: 'Delivered late',
  retired: 'Retired',
  destroyed: 'Ship lost',
  'crew-dead': 'Everyone is dead',
  stranded: 'Stranded',
});

/** Has the run been lost to the sim? 'destroyed', 'crew-dead' or null. */
export function lostEnding(sim) {
  if (sim.state.hull.points === 0) return 'destroyed';
  const crew = ourCrew(sim);
  if (crew.length && crew.every(({ member }) => !member.alive)) return 'crew-dead';
  return null;
}

const HEADLINES = Object.freeze({
  delivered: 'The cargo is signed for.',
  late: 'The cargo is signed for, and the client has noted the time.',
  retired: 'You stopped here.',
  destroyed: 'The Margin of Error is gone.',
  'crew-dead': 'Nobody is left aboard to read this.',
  stranded: 'The tanks are dry and no lane is in reach.',
});

/** What became of the contract, in the summary's words. */
function contractResult(contract) {
  if (contract.status === 'delivered') return contract.earned === contract.pay ? 'Delivered whole' : 'Delivered, short';
  if (contract.status === 'failed') return `Failed: ${FAILURES[contract.reason] ?? contract.reason}`;
  return 'Not delivered';
}

/** Standing that moved, in words: "The Free Confederation +2, The Receivers -2". */
function standingText(standing, names) {
  const moved = Object.entries(standing).filter(([, add]) => add);
  if (!moved.length) return 'Unchanged';
  return moved.map(([id, add]) => `${names.get(id) ?? id} ${add > 0 ? '+' : ''}${add}`).join(', ');
}

/**
 * What the run summary shows. `kind` is one of ENDINGS. Reads the sim only; `factions` gives names.
 * Returns { kind, title, headline, rows: [[label, value]], dead: [names] }.
 */
export function summarize(sim, kind, { factions = [] } = {}) {
  const run = sim.state.run;
  const contract = contractOf(sim);
  const template = sim.contract;
  const names = new Map(factions.map((faction) => [faction.id, faction.name]));
  const crew = ourCrew(sim);
  const dead = crew.filter(({ member }) => !member.alive).map(({ member }) => member.name);
  const place = run ? nodeOf(run.map, run.at) : null;
  const rows = [['Contract', template ? `${CONTRACT_TYPES[template.type]}: ${template.title}` : 'None']];
  if (contract) {
    rows.push(['Result', contractResult(contract)]);
    rows.push(['Paid', `${contract.advance} advance${contract.status === 'delivered' ? ` + ${contract.paid} at the drop` : ''}`]);
    rows.push(['Standing', standingText(contract.standing, names)]);
  }
  rows.push(['Money', String(sim.state.money)]);
  if (run) {
    rows.push(['Hours under way', `${Math.round(run.hours)} of ${run.deadline} allowed`]);
    rows.push(['Lanes flown', String(run.legs)]);
    rows.push(['Fuel left', `${run.fuel} of ${run.fuelMax}`]);
    rows.push(['Points visited', `${run.visited.length} of ${run.map.nodes.length}`]);
    rows.push(['Events met', String(run.events.count)]);
    if (place) rows.push(['Last at', place.name]);
  }
  rows.push(['Crew', `${crew.length - dead.length} of ${crew.length} alive`]);
  return { kind, title: ENDINGS[kind], headline: HEADLINES[kind], rows, dead };
}

// ---------- the port screen (S3.4, D-114) ----------

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One line about the contract for the port screen and the chart. */
export function contractLine(sim) {
  const contract = contractOf(sim);
  if (!contract) return 'No contract';
  const name = CONTRACT_TYPES[contract.type];
  if (contract.status === 'delivered') return `${name}: delivered`;
  if (contract.status === 'failed') return `${name}: failed, ${FAILURES[contract.reason] ?? contract.reason}`;
  const aboard = contractCrates(sim).length;
  if (contract.claim && !contract.claim.done) return `${name}: the claim at ${nodeOf(sim.state.run.map, contract.claim.node)?.name ?? '?'} is still to be worked on the way`;
  return `${name}: ${aboard} of ${contract.expected} crates aboard`;
}

/**
 * What the port screen shows, worked out from the sim alone: { name, text, isDrop, facts: [[label, value]],
 * services: [{ id, command, label, detail, why, danger }], deliver: { why, detail } | null, canRetire }.
 * Every service carries the order it gives and, if it cannot be had, why not.
 */
export function portView(sim) {
  const run = sim.state.run;
  const port = portHere(sim) ?? FREE_PORT;
  const node = nodeOf(run.map, run.at);
  const contract = contractOf(sim);
  const isDrop = run.at === run.map.delivery;
  const credits = (n) => (n ? `${n} credits` : 'free');
  const services = [];
  const add = (id, command, label, detail, extra = {}) => services.push({ id, command, label, detail, why: sim.whyNot(command), ...extra });

  const fuel = refuelQuote(sim);
  add('refuel', { type: 'port.refuel' }, 'Refuel', fuel.units < fuel.want && fuel.units ? `All we can pay for: ${fuel.units} of ${fuel.want}, ${credits(fuel.cost)}` : `${plural(fuel.want, 'unit')}, ${credits(fuel.want * fuel.price)}`);
  const hull = repairQuote(sim, 'hull');
  add('repair-hull', { type: 'port.repair', what: 'hull' }, 'Patch the hull', hull.units < hull.want && hull.units ? `${hull.units} of ${hull.want} points, ${credits(hull.cost)}` : `${plural(hull.want, 'point')}, ${credits(hull.want * hull.price)}`);
  const systems = repairQuote(sim, 'systems');
  add('repair-systems', { type: 'port.repair', what: 'systems' }, 'Mend the systems', systems.units < systems.want && systems.units ? `${systems.units} of ${systems.want} bars, ${credits(systems.cost)}` : `${plural(systems.want, 'bar')}, ${credits(systems.want * systems.price)}`);
  const salvage = saleQuote(sim, 'salvage');
  add('sell-salvage', { type: 'port.sell', what: 'salvage' }, 'Sell salvage', `${plural(salvage.crates, 'crate')} at ${salvage.price} each`);
  if (contract?.status === 'active' && !isDrop) {
    const cargo = saleQuote(sim, 'contract');
    add('sell-contract', { type: 'port.sell', what: 'contract' }, 'Sell the contract cargo', `${plural(cargo.crates, 'crate')} for ${cargo.value}. The contract fails`, { danger: true });
    add('abandon', { type: 'contract.abandon' }, 'Walk away from the contract', `The client takes ${sim.contract.penalty ?? 0} back`, { danger: true });
  }

  let deliver = null;
  if (isDrop && contract) {
    const why = sim.whyNot({ type: 'contract.deliver' });
    const result = why ? null : settlement(sim);
    deliver = { why, detail: result ? `${result.earned} earned, ${contract.advance} advanced: ${result.due} to collect${result.late ? ' (late)' : ''}` : why };
  }
  const facts = [
    ['Money', String(sim.state.money)],
    ['Fuel', `${run.fuel} of ${run.fuelMax}`],
    ['Hull', `${sim.state.hull.points} of ${sim.state.hull.max}`],
    ['Contract', contractLine(sim)],
  ];
  return { name: node.name, text: isDrop ? 'The consignee is waiting at the dock.' : port.text, isDrop, facts, services, deliver, canRetire: !deliver || Boolean(deliver.why) };
}
