// The run loop around the sim (S3.2, D-108): which screen an arrival opens, how a run ends,
// and what the run summary says. DOM-free, so Node tests and the bot can use it.
//
// Most of this is a stub with a real shape. The contracts become content in S3.4 and the saved
// run end and career in S3.6; until then the screens read their data from here. Events are
// content since S3.3 (narrative/events.js).

import { ourCrew } from './combat.js';
import { nodeOf } from './sector.js';

/** Stand-in contracts for the board (S3.4 makes contracts content). `followed` fixes the pursuit hook. */
export const STUB_CONTRACTS = Object.freeze([
  { id: 'stub-smuggling', type: 'Smuggling', title: 'Cold freight, no questions', client: 'A man who would not give a name', cargo: 'Eleven sealed crates, no manifest', pay: 900, followed: true, note: 'Margo flags it: somebody has already asked about this cargo.' },
  { id: 'stub-courier', type: 'Courier', title: 'Cold chain to the far dock', client: 'Reach Medical Cooperative', cargo: 'Four coolers of tissue culture', pay: 600, followed: false, note: 'Clean paperwork. The coolers rattle a little.' },
  { id: 'stub-salvage', type: 'Salvage claim', title: 'Claim on the Aphelion', client: 'Lowry & Sons Recovery', cargo: 'A claim token and a cutting rig', pay: 1200, followed: true, note: 'Two other crews hold the same claim. One of them has a ship.' },
]);

/**
 * Which screen arriving at a point opens: 'port' or null. Events are not decided here: the sim opens
 * one when the dice and the content say so (narrative/events.js, S3.3), and the screen follows.
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
  const crew = ourCrew(sim);
  if (crew.length && crew.every(({ member }) => !member.alive)) return 'crew-dead';
  return null;
}

/** Pay for an ending: the whole fee for a delivery on time, half when late, nothing otherwise. */
export function payFor(contract, kind) {
  if (!contract) return 0;
  if (kind === 'delivered') return contract.pay;
  if (kind === 'late') return Math.floor(contract.pay / 2);
  return 0;
}

const HEADLINES = Object.freeze({
  delivered: 'The cargo is signed for.',
  late: 'The cargo is signed for, and the client has noted the time.',
  retired: 'You stopped here.',
  destroyed: 'The Margin of Error is gone.',
  'crew-dead': 'Nobody is left aboard to read this.',
  stranded: 'The tanks are dry and no lane is in reach.',
});

/**
 * What the run summary shows. `kind` is one of ENDINGS. Reads the sim and the contract only.
 * Returns { kind, title, headline, rows: [[label, value]], dead: [names] }.
 */
export function summarize(sim, kind, contract = null) {
  const run = sim.state.run;
  const crew = ourCrew(sim);
  const dead = crew.filter(({ member }) => !member.alive).map(({ member }) => member.name);
  const place = run ? nodeOf(run.map, run.at) : null;
  const rows = [['Contract', contract ? `${contract.type}: ${contract.title}` : 'None']];
  if (run) {
    rows.push(['Jumps', `${run.jumps} of ${run.deadline} allowed`]);
    rows.push(['Fuel left', `${run.fuel} of ${run.fuelMax}`]);
    rows.push(['Points visited', `${run.visited.length} of ${run.map.nodes.length}`]);
    rows.push(['Events met', String(run.events.count)]);
    if (place) rows.push(['Last at', place.name]);
  }
  rows.push(['Crew', `${crew.length - dead.length} of ${crew.length} alive`]);
  rows.push(['Pay', contract ? `${payFor(contract, kind)} of ${contract.pay}` : '0']);
  return { kind, title: ENDINGS[kind], headline: HEADLINES[kind], rows, dead };
}
