// Contracts (S3.4, D-113; brief §10). DOM-free.
//
// A contract is content (content/contracts/): a template the board offers and the run carries.
//
//   {
//     "id": "smuggling-cold-freight",
//     "type": "smuggling",                  one of CONTRACT_TYPES
//     "title": "...", "contact": "...", "text": "...", "note": "...",   words for the board
//     "client": "confederation",            the faction (content/factions/) whose standing it moves
//     "pay": 900,                           the whole fee: every crate handed over sealed and on time
//     "advance": 200,                       paid when it is taken, and taken off the fee at the drop
//     "latePay": 0.5,                       the share of the fee still paid when late; 0 fails it the moment it is late
//     "followed": 0.75,                     the chance somebody follows it (the pursuit hook, sector.js)
//     "slack": [1, 2],                      spare jumps on the deadline, instead of the sector's
//     "value": 160,                         what a port pays for one of its crates if you sell the cargo instead
//     "cargo": [ { "count": 4, "kind": "cargo", "label": "...", "contents": "...", "contraband": true } ],
//                                           the crates it puts in the hold: sealed manifest crates by
//                                           default, or "salvage" (no seal). Contraband is what an
//                                           inspection looks for
//     "claim": { "at": "derelict", "event": "claim.aphelion" },
//                                           a salvage claim: the cargo is not aboard at the start. A point
//                                           of that kind is picked on the chart, and standing there opens
//                                           the event until the claim is worked (the "contract.load" effect)
//     "reputation": { "deliver": 2, "fail": -3 },
//     "penalty": 100                        what the client takes back when it fails
//   }
//
// The run keeps its progress in `run.contract`. The crates are real crates in the hold (hold.js),
// marked `contract: true`, so they can be opened, carried, jettisoned, lost with a room, seized at
// an inspection or sold at a port, and the fee at the drop counts what is left of them:
//   earned = pay × (sealed crates + half of opened ones) ÷ the crates the contract is for, × latePay if late
// and what is paid there is what was earned less the advance. Every crate gone, a courier late, the
// cargo sold or the contract walked away from: it fails, the client's standing drops and the client
// takes its penalty. A failed contract does not end the run (brief §5).

import { addCrate } from './hold.js';
import { cheapestRoute, nodeOf } from './sector.js';

/** The kinds of contract, and what the board calls each. Prisoner transport, specimen haul and rescue come later (D-010). */
export const CONTRACT_TYPES = Object.freeze({ smuggling: 'Smuggling', courier: 'Courier', salvage: 'Salvage claim' });
/** What an opened crate is worth at the drop, against a sealed one. */
export const OPENED_SHARE = 0.5;
/** Standing with a faction stays within this range. */
export const REPUTATION_RANGE = Object.freeze([-10, 10]);
/** Why a contract can fail, in the words the summary uses. */
export const FAILURES = Object.freeze({
  lost: 'every crate of it is gone',
  seized: 'the cargo was seized',
  sold: 'the cargo was sold',
  late: 'it arrived too late to matter',
  abandoned: 'we walked away from it',
  nothing: 'there was nothing to hand over',
});

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

/** The crates of the contract aboard our ship: in a room or in someone's arms. */
export const contractCrates = (sim) => Object.values(sim.state.crates).filter((crate) => crate.contract);
/** Contraband aboard: what an inspection looks for. */
export const contrabandAboard = (sim) => Object.values(sim.state.crates).filter((crate) => crate.contraband).length;
/** How many crates a contract is for, from its cargo lines. */
export const cargoCount = (template) => (template.cargo ?? []).reduce((sum, line) => sum + (line.count ?? 1), 0);
/** The contract on this run, or null. */
export const contractOf = (sim) => sim.state.run?.contract ?? null;
/** Is the contract still to be done? */
export const contractActive = (sim) => contractOf(sim)?.status === 'active';

/** Move money and say so. Money never goes below 0. Returns what actually moved. */
export function addMoney(sim, amount, reason) {
  const from = sim.state.money;
  sim.state.money = Math.max(0, from + amount);
  if (sim.state.money !== from) sim.events.emit('money.changed', { from, to: sim.state.money, reason, tick: sim.state.tick });
  return sim.state.money - from;
}

/** Move standing with a faction. `faction` may be "client": the contract's client. */
export function changeReputation(sim, faction, add, reason) {
  const id = faction === 'client' ? contractOf(sim)?.client : faction;
  if (!id || !add) return;
  const from = sim.state.reputation[id] ?? 0;
  const to = clamp(from + add, ...REPUTATION_RANGE);
  if (to === from) return;
  sim.state.reputation[id] = to;
  const contract = contractOf(sim);
  if (contract) contract.standing[id] = (contract.standing[id] ?? 0) + (to - from);
  sim.events.emit('reputation.changed', { faction: id, from, to, reason, tick: sim.state.tick });
}

// ---------- setting a contract up ----------

/** The point a salvage claim sits at: the point of that kind that costs the least fuel to take in on the way across. */
function pickClaim(sim, kind) {
  const { map } = sim.state.run;
  const inner = map.nodes.filter((node) => node.id !== map.start && node.id !== map.delivery);
  const pool = inner.filter((node) => node.kind === kind);
  const cost = (node) => {
    const there = cheapestRoute(map, map.start, node.id);
    const on = cheapestRoute(map, node.id, map.delivery);
    return { fuel: there.fuel + on.fuel, jumps: there.jumps + on.jumps };
  };
  const scored = (pool.length ? pool : inner).map((node) => ({ node, ...cost(node) }));
  const best = Math.min(...scored.map((one) => one.fuel * 100 + one.jumps));
  return sim.rng.stream('map').pick(scored.filter((one) => one.fuel * 100 + one.jumps === best));
}

/** Rooms contract crates are stowed in: wherever the ship file keeps its manifest crates, else the first room. */
function stowage(sim) {
  const rooms = [...new Set(sim.layout.crates.filter((entry) => entry.kind === 'cargo').map((entry) => entry.room))].filter((id) => !sim.state.rooms[id]?.jettisoned);
  return rooms.length ? rooms : [sim.layout.rooms[0].id];
}

/** Put up to `count` more of the contract's crates aboard (all that are left with no count). Returns how many came aboard. */
export function loadCargo(sim, count = Infinity) {
  const contract = contractOf(sim);
  const template = sim.contract;
  if (!contract || !template) return 0;
  const lines = (template.cargo ?? []).flatMap((line) => Array.from({ length: line.count ?? 1 }, () => line));
  const rooms = stowage(sim);
  let added = 0;
  while (added < count && contract.loaded < lines.length) {
    const line = lines[contract.loaded];
    const room = rooms[contract.loaded % rooms.length];
    const crate = addCrate(sim, { kind: line.kind ?? 'cargo', room, label: line.label, contents: line.contents, contract: true, contraband: Boolean(line.contraband) });
    contract.loaded += 1;
    added += 1;
    sim.events.emit('crate.added', { crate: crate.id, kind: crate.kind, room, contract: true, tick: sim.state.tick });
  }
  if (added) sim.events.emit('contract.loaded', { count: added, aboard: contractCrates(sim).length, tick: sim.state.tick });
  return added;
}

/**
 * Take a contract on a new run (createSim calls this once the chart is drawn): the ship's standing manifest
 * crates make room for the contract's cargo, the advance is paid, and a salvage claim gets its point on the chart.
 */
export function setUpContract(sim, template) {
  const run = sim.state.run;
  if (!run) throw new Error('A contract needs a sector to be flown across');
  if (!CONTRACT_TYPES[template.type]) throw new Error(`Unknown contract type "${template.type}"`);
  for (const crate of Object.values(sim.state.crates)) if (crate.kind === 'cargo') delete sim.state.crates[crate.id];
  run.contract = {
    id: template.id,
    type: template.type,
    client: template.client,
    pay: template.pay,
    advance: template.advance ?? 0,
    expected: cargoCount(template),
    loaded: 0, // crates put aboard so far
    status: 'active', // active | delivered | failed
    reason: null, // why it failed: a key of FAILURES
    earned: 0, // what the drop judged the cargo worth
    paid: 0, // what was paid at the drop, after the advance
    seized: 0,
    sold: 0,
    standing: {}, // how standing with each faction moved during this contract
    claim: null, // a salvage claim: { node, event, done }
  };
  if (template.claim) {
    const pick = pickClaim(sim, template.claim.at);
    run.contract.claim = { node: pick.node.id, event: template.claim.event, done: false };
    // The deadline allows for the way round by the claim.
    const direct = cheapestRoute(run.map, run.map.start, run.map.delivery).jumps;
    run.deadline += Math.max(0, pick.jumps - direct);
  } else loadCargo(sim);
  addMoney(sim, run.contract.advance, 'advance');
}

// ---------- failing and delivering ----------

/** The contract fails: standing with the client drops, and the client takes back its penalty. */
export function failContract(sim, reason) {
  const contract = contractOf(sim);
  if (!contract || contract.status !== 'active') return;
  contract.status = 'failed';
  contract.reason = reason;
  changeReputation(sim, 'client', sim.contract.reputation?.fail ?? 0, 'failed');
  addMoney(sim, -(sim.contract.penalty ?? 0), 'penalty');
  sim.events.emit('contract.failed', { contract: contract.id, reason, tick: sim.state.tick });
}

/** Has every crate the contract put aboard gone over the side, with a room, or to somebody else? Then it has failed. */
export function checkCargo(sim, reason = 'lost') {
  const contract = contractOf(sim);
  if (contract?.status === 'active' && contract.loaded > 0 && contractCrates(sim).length === 0) failContract(sim, reason);
}

/** Take contraband (or, with `all`, every crate of the contract) off the ship. Returns how many went. */
export function seizeCargo(sim, { all = false } = {}) {
  const taken = Object.values(sim.state.crates).filter((crate) => (all ? crate.contract : crate.contraband));
  for (const crate of taken) {
    if (crate.by && sim.state.crew[crate.by]) sim.state.crew[crate.by].carry = null;
    delete sim.state.crates[crate.id];
  }
  const contract = contractOf(sim);
  if (contract) contract.seized += taken.filter((crate) => crate.contract).length;
  if (taken.length) sim.events.emit('cargo.seized', { count: taken.length, tick: sim.state.tick });
  checkCargo(sim, 'seized');
  return taken.length;
}

/**
 * What the drop would pay right now: { aboard, sealed, opened, share, late, earned, due, clean, standing }.
 * `due` is what changes hands at the drop: what was earned, less the advance.
 */
export function settlement(sim) {
  const contract = contractOf(sim);
  const template = sim.contract;
  const run = sim.state.run;
  const crates = contractCrates(sim);
  const opened = crates.filter((crate) => crate.kind === 'cargo' && !crate.sealed).length;
  const sealed = crates.length - opened;
  const share = contract.expected ? Math.min(1, (sealed + opened * OPENED_SHARE) / contract.expected) : 0;
  const late = Boolean(run.late);
  const earned = Math.round(contract.pay * share * (late ? (template.latePay ?? 0.5) : 1));
  const clean = sealed === contract.expected && !late;
  return { aboard: crates.length, sealed, opened, share, late, earned, due: Math.max(0, earned - contract.advance), clean, standing: clean ? (template.reputation?.deliver ?? 0) : 0 };
}

/** Why the cargo cannot be handed over right now, or null. */
export function whyNoDeliver(sim) {
  const contract = contractOf(sim);
  const run = sim.state.run;
  if (!contract) return 'there is no contract on this run';
  if (contract.status === 'delivered') return 'the cargo has been handed over';
  if (contract.status === 'failed') return `the contract has failed: ${FAILURES[contract.reason] ?? contract.reason}`;
  if (run.at !== run.map.delivery) return 'the cargo is handed over at the drop';
  if (sim.state.fight && !sim.state.fight.over) return 'not in a fight';
  if (!contractCrates(sim).length) return contract.claim && !contract.claim.done ? `nothing to hand over: the claim at ${nodeOf(run.map, contract.claim.node)?.name ?? 'the claim'} was never worked` : 'nothing of the contract is aboard';
  return null;
}

function deliver(sim) {
  const contract = contractOf(sim);
  const result = settlement(sim);
  for (const crate of contractCrates(sim)) {
    if (crate.by && sim.state.crew[crate.by]) sim.state.crew[crate.by].carry = null;
    delete sim.state.crates[crate.id];
  }
  contract.status = 'delivered';
  contract.earned = result.earned;
  contract.paid = addMoney(sim, result.due, 'delivery');
  changeReputation(sim, 'client', result.standing, 'delivered');
  sim.events.emit('contract.delivered', { contract: contract.id, earned: result.earned, paid: contract.paid, late: result.late, clean: result.clean, crates: result.aboard, tick: sim.state.tick });
}

/** Listen for the things that can fail a contract by themselves. Called once when the sim is created. */
export function attachContracts(sim) {
  if (!sim.contract) return;
  const gone = () => checkCargo(sim);
  sim.events.on('crate.jettisoned', gone);
  sim.events.on('crate.lost', gone);
  // A contract that pays nothing late fails the moment it is late.
  sim.events.on('contract.late', () => contractActive(sim) && !(sim.contract.latePay > 0) && failContract(sim, 'late'));
}

export const CONTRACT_COMMANDS = {
  // At the drop: hand over what is left of the cargo and be paid for it.
  'contract.deliver': {
    check: (sim) => whyNoDeliver(sim),
    apply: (sim) => deliver(sim),
  },
  // Walk away from the contract: it fails, whatever is aboard. Retiring with a contract in hand does this too.
  'contract.abandon': {
    check: (sim) => (contractActive(sim) ? null : 'there is no contract in hand to walk away from'),
    apply: (sim) => failContract(sim, 'abandoned'),
  },
  // Debug panel only: fail the contract, or (load) put the rest of its cargo aboard.
  'debug.contract': {
    check(sim, cmd) {
      if (!contractActive(sim)) return 'there is no contract in hand';
      if (cmd.fail !== undefined) return FAILURES[cmd.fail] ? null : `fail must be one of ${Object.keys(FAILURES).join(', ')}`;
      if (cmd.load !== true) return 'needs fail or load';
      return null;
    },
    apply(sim, cmd) {
      if (cmd.fail) failContract(sim, cmd.fail);
      else {
        loadCargo(sim);
        if (contractOf(sim).claim) contractOf(sim).claim.done = true;
      }
    },
  },
};

/** Contract problems that should never happen. */
export function checkContractInvariants(sim) {
  const contract = contractOf(sim);
  if (!contract) return [];
  const problems = [];
  if (!['active', 'delivered', 'failed'].includes(contract.status)) problems.push(`contract: status is ${contract.status}`);
  if (contract.loaded > contract.expected) problems.push(`contract: ${contract.loaded} crates loaded of ${contract.expected}`);
  if (contractCrates(sim).length > contract.loaded) problems.push('contract: more of its crates aboard than were ever loaded');
  if (contract.status === 'delivered' && contractCrates(sim).length) problems.push('contract: delivered, and its crates are still aboard');
  if (contract.claim && !nodeOf(sim.state.run.map, contract.claim.node)) problems.push('contract: the claim is not on the chart');
  if (!(Number.isFinite(sim.state.money) && sim.state.money >= 0)) problems.push(`money is ${sim.state.money}`);
  for (const [id, value] of Object.entries(sim.state.reputation)) if (!(value >= REPUTATION_RANGE[0] && value <= REPUTATION_RANGE[1])) problems.push(`reputation with ${id} is ${value}`);
  return problems;
}
