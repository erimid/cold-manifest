// Ports (S3.4, D-114; brief §11, §12). DOM-free.
//
// A port is content (content/ports/): what its services cost. Every port on the chart uses the
// first port definition until S3.5 names the ports; a sim given none has a port that charges
// nothing, so the sandbox and old tests are unchanged. The services, all paid in credits and all
// settled at once (the clock is stopped on the port screen):
//   port.refuel   fill the tanks, or as much of them as the money buys
//   port.repair   mend the hull ("hull") or every damaged system ("systems"), as far as the money goes
//   port.sell     sell loose salvage at the yard ("salvage"), or the contract's own cargo ("contract"),
//                 which fails the contract (contracts.js)
// Hiring is a stub until Stage 4.

import { addMoney, contractActive, contractOf, failContract } from './contracts.js';
import { nodeOf } from './sector.js';

/** The port a sim with no port content uses: everything free, as it was before ports had prices. */
export const FREE_PORT = Object.freeze({ id: 'free', name: 'Port', text: 'A dock.', fuel: 0, hull: 0, system: 0, salvage: 0, services: Object.freeze(['refuel', 'repair', 'sell', 'hire']) });
export const SERVICES = Object.freeze(['refuel', 'repair', 'sell', 'hire']);
export const REPAIRS = Object.freeze(['hull', 'systems']);
export const SALES = Object.freeze(['salvage', 'contract']);

/** The port we are docked at: its definition, or null when we are not at a port. */
export function portHere(sim) {
  const run = sim.state.run;
  if (!run || nodeOf(run.map, run.at)?.kind !== 'port') return null;
  return sim.ports[0] ?? FREE_PORT;
}

/** Why no port service can be had right now, or null. */
function whyNoPort(sim, service) {
  const run = sim.state.run;
  if (!run) return 'there is no chart for this run';
  const port = portHere(sim);
  if (!port) return 'only a port has that';
  if (sim.state.fight && !sim.state.fight.over) return 'not in a fight';
  if (!(port.services ?? SERVICES).includes(service)) return `${port.name} does not offer that`;
  return null;
}

/** How many of `wanted` units at `price` each the money buys. */
const affordable = (sim, wanted, price) => (price > 0 ? Math.min(wanted, Math.floor(sim.state.money / price)) : wanted);

// ---------- fuel ----------

/** What filling up would buy and cost: { want, units, cost, price }. */
export function refuelQuote(sim) {
  const run = sim.state.run;
  const price = (portHere(sim) ?? FREE_PORT).fuel;
  const want = run ? run.fuelMax - run.fuel : 0;
  const units = affordable(sim, want, price);
  return { want, units, cost: units * price, price };
}

/** Why we cannot refuel right now, or null. */
export function whyNoRefuel(sim) {
  const problem = whyNoPort(sim, 'refuel');
  if (problem) return problem === 'only a port has that' ? 'only a port has fuel to sell' : problem;
  const quote = refuelQuote(sim);
  if (!quote.want) return 'the tanks are full';
  if (!quote.units) return `fuel is ${quote.price} credits a unit and we have ${sim.state.money}`;
  return null;
}

// ---------- repairs ----------

/** Systems a port gang can mend: damaged, and still there. */
const mendable = (sim) => Object.entries(sim.state.systems).filter(([, system]) => system.damage > 0 && !system.absent && !system.lost);

/** What mending the hull or the systems would do and cost: { want, units, cost, price }. */
export function repairQuote(sim, what) {
  const port = portHere(sim) ?? FREE_PORT;
  const price = what === 'hull' ? port.hull : port.system;
  const want = what === 'hull' ? sim.state.hull.max - sim.state.hull.points : mendable(sim).reduce((sum, [, system]) => sum + system.damage, 0);
  const units = affordable(sim, want, price);
  return { want, units, cost: units * price, price };
}

export function whyNoRepair(sim, what) {
  if (!REPAIRS.includes(what)) return `repairs are for ${REPAIRS.join(' or ')}`;
  const problem = whyNoPort(sim, 'repair');
  if (problem) return problem;
  const quote = repairQuote(sim, what);
  if (!quote.want) return what === 'hull' ? 'the hull is whole' : 'nothing aboard is damaged';
  if (!quote.units) return `that is ${quote.price} credits a ${what === 'hull' ? 'point' : 'bar'} and we have ${sim.state.money}`;
  return null;
}

function repair(sim, what) {
  const quote = repairQuote(sim, what);
  addMoney(sim, -quote.cost, `repair.${what}`);
  if (what === 'hull') {
    sim.state.hull.points += quote.units;
  } else {
    let left = quote.units;
    for (const [id, system] of mendable(sim)) {
      const mend = Math.min(left, system.damage);
      if (!mend) break;
      system.damage -= mend;
      if (system.damage === 0) delete system.stripped; // new parts fitted where a salvage crew cut the old ones out (H.2)
      left -= mend;
      sim.events.emit('system.repaired', { system: id, damage: system.damage, by: 'port', tick: sim.state.tick });
    }
  }
  sim.events.emit('port.repaired', { what, units: quote.units, cost: quote.cost, tick: sim.state.tick });
}

// ---------- selling ----------

/** The crates a sale would take: they must be sitting in a room, not in someone's arms. */
function forSale(sim, what) {
  const loose = Object.values(sim.state.crates).filter((crate) => crate.room !== null && !crate.by);
  return what === 'contract' ? loose.filter((crate) => crate.contract) : loose.filter((crate) => crate.kind === 'salvage' && !crate.contract);
}

/** What a sale would take and pay: { crates, price, value }. */
export function saleQuote(sim, what) {
  const price = what === 'contract' ? (sim.contract?.value ?? 0) : (portHere(sim) ?? FREE_PORT).salvage;
  const crates = forSale(sim, what);
  return { crates: crates.length, price, value: crates.length * price };
}

export function whyNoSell(sim, what) {
  if (!SALES.includes(what)) return `sales are of ${SALES.join(' or ')}`;
  const problem = whyNoPort(sim, 'sell');
  if (problem) return problem;
  if (what === 'contract') {
    if (!contractActive(sim)) return 'there is no contract cargo to sell';
    const run = sim.state.run;
    if (run.at === run.map.delivery) return 'this is the drop: hand it over instead';
  }
  if (!forSale(sim, what).length) return what === 'contract' ? 'none of the contract cargo is sitting in the hold' : 'there is no salvage of ours to sell';
  return null;
}

function sell(sim, what) {
  const quote = saleQuote(sim, what);
  for (const crate of forSale(sim, what)) delete sim.state.crates[crate.id];
  addMoney(sim, quote.value, `sale.${what}`);
  sim.events.emit('port.sold', { what, crates: quote.crates, value: quote.value, tick: sim.state.tick });
  if (what === 'contract') {
    contractOf(sim).sold += quote.crates;
    failContract(sim, 'sold');
  }
}

export const PORT_COMMANDS = {
  // Fill the tanks, as far as the money goes.
  'port.refuel': {
    check: (sim) => whyNoRefuel(sim),
    apply(sim) {
      const run = sim.state.run;
      const quote = refuelQuote(sim);
      addMoney(sim, -quote.cost, 'fuel');
      run.fuel += quote.units;
      sim.events.emit('port.refueled', { node: run.at, bought: quote.units, cost: quote.cost, fuel: run.fuel, tick: sim.state.tick });
    },
  },
  'port.repair': {
    check: (sim, cmd) => whyNoRepair(sim, cmd.what),
    apply: (sim, cmd) => repair(sim, cmd.what),
  },
  'port.sell': {
    check: (sim, cmd) => whyNoSell(sim, cmd.what),
    apply: (sim, cmd) => sell(sim, cmd.what),
  },
};

