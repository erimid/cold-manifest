// How an enemy ship fights (brief §7). DOM-free.
//
// An enemy captain gives the same orders a player does (power.add, crew.move,
// crew.suit), applied straight to its own ship on its own tick, and aims its
// guns by setting their targets. What it wants comes from its archetype, a
// small table below; a ship file names one and may add when it hails,
// surrenders or runs (`tactics` in content/ships/).
//
// Every half second the captain:
//   1. routes power: bars go to its systems in the archetype's order, taken
//      from the bottom of the list when the top wants more (engines go first
//      when it is running away);
//   2. aims: once every powered gun is charged, each gets a room of ours
//      that its sensors have resolved (senses.js),
//      picked by the archetype's weights on the `tactics` random stream, so
//      they fire together. It picks again after every shot;
//   3. works its crew: one stays at the helm, the rest go to the worst
//      trouble aboard (suited for a breach, or to fight boarders), and back to
//      their posts after;
//   4. sends someone to the hold for rounds when a heavy gun runs dry (S2.8);
//   5. boards (S2.4), if the ship file says how: when our shields are down and
//      nobody of theirs is already over (and the guns have had BOARD_AFTER_SECONDS), a party crosses to a room picked by
//      the target weights. Aboard us they move on once a system is wrecked,
//      and come home hurt, or when the ship is running.
// Between decisions it watches our guns: when a volley of ours is in the air
// it may brace (S2.8), as often as its archetype's `brace` chance says.

import { hostilesBeside, isHome, CREW_COMMANDS } from './crew.js';
import { sendAcross, whyNotCross } from './boarding.js';
import { POWERED, POWER_COMMANDS, free } from './power.js';
import { HOLD_COMMANDS, roundsInHold } from './hold.js';
import { contactView } from './senses.js';
import { SYSTEM_IDS } from './systems.js';

/** Seconds between a captain's decisions. */
export const THINK_SECONDS = 0.5;

/**
 * Archetypes (brief §7: glass cannon, boarders, drone carriers, shield tanks, stealth).
 * A carrier's ship file adds `drones: { every, max, fire }` (S2.5, combat.js).
 *   power    systems in the order bars go to them
 *   targets  weights for picking a room of ours to shoot: a system id, "helm", or "other" for anything else
 *   brace    the chance it braces against a volley of ours, when its capacitor can (S2.8)
 *   volley   false: each gun fires as soon as it is charged, instead of waiting to fire together (S2.5)
 */
export const ARCHETYPES = Object.freeze({
  // Nobody aboard and no orders: a hulk that sits there and takes it. Its point defence braces on a coin toss.
  drone: { label: 'Drone', power: [], targets: {}, brace: 0.5 },
  // Shoot first, shoot often: guns before shields, and at our guns and shields.
  gunner: {
    label: 'Glass cannon',
    volley: false,
    power: ['weapons', 'engines', 'life_support', 'shields', 'doors', 'sensors', 'medbay', 'ai_core'],
    targets: { weapons: 4, shields: 3, engines: 1, helm: 1, other: 0.5 },
    brace: 0.3,
  },
  // Pirates: keep a shield up, then guns, and go for what lets us fight back or get away.
  raider: {
    label: 'Raider',
    power: ['shields', 'weapons', 'engines', 'life_support', 'doors', 'medbay', 'sensors', 'ai_core'],
    targets: { shields: 3, weapons: 3, engines: 2, helm: 1, other: 0.5 },
    brace: 0.6,
  },
  // Shields above all, and a slow grind at our guns.
  tank: {
    label: 'Shield tank',
    power: ['shields', 'life_support', 'weapons', 'engines', 'doors', 'medbay', 'sensors', 'ai_core'],
    targets: { weapons: 4, reactor: 2, other: 0.5 },
    brace: 0.9,
  },
  // Drones do the shooting (S2.5): the bay before everything, and the drones go for our guns and shields.
  carrier: {
    label: 'Drone carrier',
    power: ['weapons', 'shields', 'engines', 'life_support', 'doors', 'medbay', 'sensors', 'ai_core'],
    targets: { weapons: 3, shields: 3, sensors: 1, other: 1 },
    brace: 0.4,
  },
  // Soften us up for a boarding party (S2.4): doors, medbay and shields.
  boarder: {
    label: 'Boarders',
    power: ['engines', 'shields', 'weapons', 'life_support', 'doors', 'medbay', 'sensors', 'ai_core'],
    targets: { doors: 3, medbay: 3, shields: 2, life_support: 1, other: 0.5 },
    brace: 0.5,
  },
});

/** Seconds of shooting before a first boarding party, unless the ship file says otherwise. */
export const BOARD_AFTER_SECONDS = 20;
/** A boarder this hurt heads home. */
export const RETREAT_HEALTH = 0.35;
/** A crew member fit to join a boarding party. */
const FIT_TO_BOARD = 0.6;

const OFFER_KINDS = ['money', 'cargo', 'info'];
const isRange = (v) => Array.isArray(v) && v.length === 2 && v.every(Number.isInteger) && v[0] >= 0 && v[0] <= v[1];
const isShare = (v) => typeof v === 'number' && v >= 0 && v <= 1;

/** Problems with a ship's `tactics` block (enemies only). */
export function validateTactics(tactics, { crewed }) {
  if (tactics === undefined) return [];
  if (!tactics || typeof tactics !== 'object') return ['"tactics" must be an object'];
  const problems = [];
  if (!ARCHETYPES[tactics.archetype]) problems.push(`tactics.archetype must be one of ${Object.keys(ARCHETYPES).join(', ')}`);
  const { hail, surrender, flee, board, drones } = tactics;
  if (drones !== undefined) {
    const positive = (v) => typeof v === 'number' && v > 0;
    if (!positive(drones?.every)) problems.push('tactics.drones.every must be seconds between launches, above 0');
    if (!Number.isInteger(drones?.max) || drones.max < 1) problems.push('tactics.drones.max must be a whole number of drones, at least 1');
    if (!positive(drones?.fire)) problems.push('tactics.drones.fire must be seconds between a drone\'s shots, above 0');
  }
  if (board !== undefined) {
    if (!crewed) problems.push('tactics.board: a ship needs crew to send a boarding party');
    if (!Number.isInteger(board?.party) || board.party < 1) problems.push('tactics.board.party must be a whole number of crew, at least 1');
    if (board?.after !== undefined && !(typeof board.after === 'number' && board.after >= 0)) problems.push('tactics.board.after must be a number of seconds, 0 or more');
  }
  if (hail !== undefined) {
    if (!crewed) problems.push('tactics.hail: only a ship with crew aboard can hail');
    if (typeof hail?.text !== 'string' || !hail.text.trim()) problems.push('tactics.hail.text is missing');
    if (!isShare(hail?.talk)) problems.push('tactics.hail.talk must be a chance from 0 to 1');
    if (!Number.isInteger(hail?.bribe) || hail.bribe < 1) problems.push('tactics.hail.bribe must be a whole amount of money, at least 1');
  }
  if (surrender !== undefined) {
    if (!crewed) problems.push('tactics.surrender: only a ship with crew aboard can surrender');
    if (!isShare(surrender?.at)) problems.push('tactics.surrender.at must be a share of hull from 0 to 1');
    if (!Array.isArray(surrender?.offers) || !surrender.offers.length) problems.push('tactics.surrender.offers must list at least one offer');
    else {
      for (const [i, offer] of surrender.offers.entries()) {
        const label = `tactics.surrender.offers[${i}]`;
        if (!OFFER_KINDS.includes(offer?.kind)) problems.push(`${label}.kind must be one of ${OFFER_KINDS.join(', ')}`);
        else if (offer.kind === 'money' && !isRange(offer.amount)) problems.push(`${label}.amount must be [min, max]`);
        else if (offer.kind === 'cargo' && (typeof offer.name !== 'string' || !offer.name || !isRange(offer.qty) || offer.qty[0] < 1)) problems.push(`${label} needs a name and qty [min, max], at least 1`);
        else if (offer.kind === 'info' && (typeof offer.text !== 'string' || !offer.text)) problems.push(`${label}.text is missing`);
      }
    }
  }
  if (flee !== undefined) {
    if (!crewed) problems.push('tactics.flee: a ship needs a pilot to run');
    if (!isShare(flee?.at)) problems.push('tactics.flee.at must be a share of hull from 0 to 1');
    if (surrender && isShare(flee?.at) && isShare(surrender?.at) && flee.at >= surrender.at) problems.push('tactics.flee.at must be below tactics.surrender.at, or it runs before it can give up');
  }
  return problems;
}

/** The fight plan for a ship: its archetype's power order and target weights, with its own hail, surrender and flee rules. */
export function planOf(layout) {
  const tactics = layout.tactics ?? { archetype: 'drone' };
  return { ...ARCHETYPES[tactics.archetype], archetype: tactics.archetype, hail: tactics.hail ?? null, surrender: tactics.surrender ?? null, flee: tactics.flee ?? null, board: tactics.board ?? null, drones: tactics.drones ?? null };
}

/** A room of `foe` for a drone to zap: one the carrier's sensors have made out, by the plan's weights, or null if none. */
export function droneTarget(ship, foe) {
  return pickTarget(ship, foe, planOf(ship.layout), (room) => contactView(ship, room.id)?.resolved);
}

// ---------- the captain's decisions ----------

/** Route bars down the order; when the top wants more and nothing is free, take one from the bottom. */
function routePower(ship, order) {
  const systems = ship.state.systems;
  const wants = (id) => !systems[id].absent && !systems[id].lost && systems[id].power < systems[id].level - systems[id].damage;
  const add = (id, delta) => POWER_COMMANDS['power.add'].apply(ship, { type: 'power.add', system: id, delta });
  const listed = order.filter((id) => POWERED.includes(id));
  for (let i = 0; i < listed.length; i++) {
    const id = listed[i];
    while (wants(id)) {
      if (free(ship) >= 1) {
        add(id, 1);
        continue;
      }
      const donor = [...listed.slice(i + 1)].reverse().find((other) => systems[other].power > 0);
      if (!donor) break;
      add(donor, -1);
    }
  }
}

/** A room of `foe` to shoot at (or board), by the plan's weights. `keep` narrows the rooms. */
function pickTarget(ship, foe, plan, keep = () => true) {
  const rooms = foe.layout.rooms.filter((room) => !foe.state.rooms[room.id].jettisoned && keep(room));
  if (!rooms.length) return null;
  const weight = (room) => {
    const key = room.system ?? (room.kind === 'helm' ? 'helm' : null);
    return (key !== null && plan.targets[key] !== undefined ? plan.targets[key] : plan.targets.other) ?? 0;
  };
  if (!rooms.some((room) => weight(room) > 0)) return null;
  return ship.rng.stream('tactics').weighted(rooms, weight).id;
}

/** How bad things are in a room, for deciding where crew go. */
function trouble(ship, room) {
  const r = ship.state.rooms[room.id];
  if (r.jettisoned) return 0;
  const system = room.system ? ship.state.systems[room.system] : null;
  const boarders = Object.values(ship.state.crew).filter((member) => member.alive && member.room === room.id && !isHome(ship, member)).length;
  return boarders * 4 + r.fire * 3 + r.breach * 2 + (system && !system.lost ? system.damage * 0.5 : 0);
}

function order(ship, type, cmd) {
  const handler = CREW_COMMANDS[type];
  const full = { type, ...cmd };
  if (handler.check(ship, full)) return false;
  handler.apply(ship, full);
  return true;
}

/** A heavy gun with no rounds: send the nearest spare hand (never the pilot) to the hold for more. */
function feedGuns(ship) {
  if (roundsInHold(ship) < 1) return;
  const crew = Object.values(ship.state.crew).filter((member) => member.alive && isHome(ship, member) && !member.board);
  ship.state.weapons.forEach((slot, index) => {
    if (slot.rounds === null || slot.rounds > 0) return;
    if (crew.some((member) => member.job?.kind === 'load' && member.job.slot === index)) return; // someone is on it
    const hand = crew.slice(1).find((member) => !member.job && !member.path.length && trouble(ship, ship.layout.room(member.room)) === 0) ?? crew.slice(1).find((member) => !member.job);
    if (!hand) return;
    const cmd = { type: 'weapon.load', crew: hand.id, slot: index };
    if (!HOLD_COMMANDS['weapon.load'].check(ship, cmd)) HOLD_COMMANDS['weapon.load'].apply(ship, cmd);
  });
}

/**
 * A volley of ours is in the air: should this captain brace? Only if the
 * capacitor can, and the archetype's nerve holds. One roll per volley (every
 * shot fired on one tick); combat.js does the bracing.
 */
export function braceAgainst(ship) {
  const { tick } = ship.state;
  if (ship.state.braceRoll === tick) return false;
  ship.state.braceRoll = tick;
  const { shield } = ship.state;
  if (shield.field > 0 || shield.charge < 1 - 1e-9 || ship.state.hull.points === 0) return false;
  return ship.rng.stream('tactics').chance(planOf(ship.layout).brace ?? 0);
}

/** One stays at the helm; the rest put out fires, patch holes and mend systems, then go back to their posts. A crate job is left to run. */
function workCrew(ship) {
  const crew = Object.values(ship.state.crew).filter((member) => member.alive && isHome(ship, member) && !member.board);
  if (!crew.length) return;
  const helm = ship.layout.rooms.find((room) => room.kind === 'helm');
  const spots = ship.layout.rooms.filter((room) => trouble(ship, room) > 0).sort((a, b) => trouble(ship, b) - trouble(ship, a));
  const heading = new Map();
  for (const member of crew) if (member.goal) heading.set(member.goal, (heading.get(member.goal) ?? 0) + 1);
  crew.forEach((member, index) => {
    const post = ship.layout.crewStart[member.index % ship.layout.crewStart.length];
    const here = ship.layout.room(member.room);
    if (member.path.length || member.job) return; // on the way somewhere, or carrying rounds
    if (trouble(ship, here) > 0) return; // busy where they stand
    const pilot = index === 0 && helm;
    const spot = pilot ? null : spots.find((room) => (heading.get(room.id) ?? 0) < 2 && room.id !== member.room);
    if (spot) {
      heading.set(spot.id, (heading.get(spot.id) ?? 0) + 1);
      const needsSuit = ship.state.rooms[spot.id].breach > 0 || ship.state.rooms[spot.id].oxygen < 0.3;
      if (member.suit !== needsSuit) order(ship, 'crew.suit', { crew: member.id, on: needsSuit });
      order(ship, 'crew.move', { crew: member.id, room: spot.id });
      return;
    }
    const home = pilot ? helm.id : post;
    if (member.room !== home) {
      if (member.suit && ship.state.rooms[home].breach === 0) order(ship, 'crew.suit', { crew: member.id, on: false });
      order(ship, 'crew.move', { crew: member.id, room: home });
    }
  });
}

/** Something there still to wreck? */
const breakable = (foe) => (room) => {
  const system = room.system ? foe.state.systems[room.system] : null;
  return Boolean(system) && !system.lost && system.damage < system.level;
};

/** Send a party across, and run the ones already aboard `foe`. */
function board(ship, foe, plan, { fleeing, boarding, battleSeconds }) {
  const home = Object.values(ship.state.crew).filter((member) => member.alive && isHome(ship, member));
  const away = Object.values(foe.state.crew).filter((member) => member.alive && member.owner === ship.side);
  const leaving = home.filter((member) => member.board);
  // The ones aboard us: home when hurt or running, on to the next system when this one is wrecked.
  for (const member of away) {
    if (member.task === 'crossing' || (member.board && member.path.length)) continue;
    if ((fleeing || !boarding || member.health < RETREAT_HEALTH) && !member.board) {
      if (!whyNotCross(foe, ship, member)) sendAcross(foe, ship, member, ship.layout.crewStart[member.index % ship.layout.crewStart.length]);
      continue;
    }
    if (member.path.length || hostilesBeside(foe, member).length || breakable(foe)(foe.layout.room(member.room))) continue;
    const next = pickTarget(ship, foe, plan, breakable(foe));
    if (next && next !== member.room) {
      const cmd = { type: 'crew.move', crew: member.id, room: next };
      if (!CREW_COMMANDS['crew.move'].check(foe, cmd)) CREW_COMMANDS['crew.move'].apply(foe, cmd);
    }
  }
  if (!plan.board || fleeing || !boarding || away.length || leaving.length) return;
  if (battleSeconds < (plan.board.after ?? BOARD_AFTER_SECONDS)) return; // give the guns a chance first, and us a chance to raise shields
  // One stays at the helm; the party is the fittest of the rest.
  const spare = home.slice(1).filter((member) => member.health >= FIT_TO_BOARD && member.task !== 'crossing' && !whyNotCross(ship, foe, member));
  if (spare.length < plan.board.party) return;
  const room = pickTarget(ship, foe, plan, breakable(foe)) ?? pickTarget(ship, foe, plan);
  if (!room) return;
  for (const member of spare.slice(0, plan.board.party)) {
    sendAcross(ship, foe, member, room);
  }
}

/**
 * One decision round for the enemy captain. `foe` is the ship it is fighting.
 * `fleeing` puts the engines first; `boarding` says a party may go across now.
 */
export function think(ship, foe, { fleeing = false, boarding = false, battleSeconds = 0 } = {}) {
  const plan = planOf(ship.layout);
  if (plan.archetype === 'drone') return;
  routePower(ship, fleeing ? ['engines', ...plan.power.filter((id) => id !== 'engines')] : plan.power);
  // Guns fire together, so the first shot drains a brace and the next gets through.
  // A gun that is ready waits, unaimed, for the others with power. A glass cannon
  // (`volley: false`) does not wait: every gun fires the moment it is charged.
  const guns = ship.state.weapons.filter((slot) => slot.powered && (slot.rounds === null || slot.rounds > 0)); // a dry gun waits for its rounds
  const ready = (slot) => slot.charge >= ship.catalog.weapon(slot.id).charge - 1e-9;
  const volley = guns.length > 0 && guns.every(ready);
  ship.state.weapons.forEach((slot) => {
    if (!volley && !(plan.volley === false && guns.includes(slot) && ready(slot))) {
      if (ready(slot)) slot.target = null;
      return;
    }
    if (slot.target !== null && foe.state.rooms[slot.target] && !foe.state.rooms[slot.target].jettisoned) return;
    // Guns are laid on what the sensors have made out; a room they have not resolved is not there to aim at.
    slot.target = pickTarget(ship, foe, plan, (room) => contactView(ship, room.id)?.resolved);
  });
  board(ship, foe, plan, { fleeing, boarding, battleSeconds });
  feedGuns(ship);
  workCrew(ship);
}

export const TARGET_KEYS = Object.freeze([...SYSTEM_IDS, 'helm', 'other']);
