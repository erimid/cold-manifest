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
//   2. aims: once every powered gun is charged, each gets a room of ours,
//      picked by the archetype's weights on the `tactics` random stream, so
//      they fire together. It picks again after every shot;
//   3. works its crew: one stays at the helm, the rest go to the worst
//      trouble aboard (suited for a breach, or to fight boarders), and back to
//      their posts after;
//   4. boards (S2.4), if the ship file says how: when our shields are down and
//      nobody of theirs is already over (and the guns have had BOARD_AFTER_SECONDS), a party crosses to a room picked by
//      the target weights. Aboard us they move on once a system is wrecked,
//      and come home hurt, or when the ship is running.

import { hostilesBeside, isHome, CREW_COMMANDS } from './crew.js';
import { sendAcross, whyNotCross } from './boarding.js';
import { POWERED, POWER_COMMANDS, free } from './power.js';
import { SYSTEM_IDS } from './systems.js';

/** Seconds between a captain's decisions. */
export const THINK_SECONDS = 0.5;

/**
 * Archetypes (brief §7: glass cannon, boarders, drone carriers, shield tanks, stealth).
 *   power    systems in the order bars go to them
 *   targets  weights for picking a room of ours to shoot: a system id, "helm", or "other" for anything else
 */
export const ARCHETYPES = Object.freeze({
  // Nobody aboard and no orders: a hulk that sits there and takes it.
  drone: { label: 'Drone', power: [], targets: {} },
  // Shoot first, shoot often: guns before shields, and at our guns and shields.
  gunner: {
    label: 'Glass cannon',
    power: ['weapons', 'engines', 'life_support', 'shields', 'doors', 'sensors', 'medbay', 'ai_core'],
    targets: { weapons: 4, shields: 3, engines: 1, helm: 1, other: 0.5 },
  },
  // Pirates: keep a shield up, then guns, and go for what lets us fight back or get away.
  raider: {
    label: 'Raider',
    power: ['shields', 'weapons', 'engines', 'life_support', 'doors', 'medbay', 'sensors', 'ai_core'],
    targets: { shields: 3, weapons: 3, engines: 2, helm: 1, other: 0.5 },
  },
  // Shields above all, and a slow grind at our guns.
  tank: {
    label: 'Shield tank',
    power: ['shields', 'life_support', 'weapons', 'engines', 'doors', 'medbay', 'sensors', 'ai_core'],
    targets: { weapons: 4, reactor: 2, other: 0.5 },
  },
  // Soften us up for a boarding party (S2.4): doors, medbay and shields.
  boarder: {
    label: 'Boarders',
    power: ['engines', 'shields', 'weapons', 'life_support', 'doors', 'medbay', 'sensors', 'ai_core'],
    targets: { doors: 3, medbay: 3, shields: 2, life_support: 1, other: 0.5 },
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
  const { hail, surrender, flee, board } = tactics;
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
  return { ...ARCHETYPES[tactics.archetype], archetype: tactics.archetype, hail: tactics.hail ?? null, surrender: tactics.surrender ?? null, flee: tactics.flee ?? null, board: tactics.board ?? null };
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

/** One stays at the helm; the rest put out fires, patch holes and mend systems, then go back to their posts. */
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
    if (member.path.length) return; // on the way somewhere
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
  // Guns fire together, so the first shot takes down a shield layer and the next gets through.
  // A gun that is ready waits, unaimed, for the others with power.
  const guns = ship.state.weapons.filter((slot) => slot.powered);
  const ready = (slot) => slot.charge >= ship.catalog.weapon(slot.id).charge - 1e-9;
  const volley = guns.length > 0 && guns.every(ready);
  ship.state.weapons.forEach((slot) => {
    if (!volley) {
      if (ready(slot)) slot.target = null;
      return;
    }
    if (slot.target !== null && foe.state.rooms[slot.target] && !foe.state.rooms[slot.target].jettisoned) return;
    slot.target = pickTarget(ship, foe, plan);
  });
  board(ship, foe, plan, { fleeing, boarding, battleSeconds });
  workCrew(ship);
}

export const TARGET_KEYS = Object.freeze([...SYSTEM_IDS, 'helm', 'other']);
