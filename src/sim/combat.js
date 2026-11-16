// Ship-to-ship fighting (brief §7). DOM-free.
//
// A fight is the player's ship against one enemy ship. The enemy is a whole
// ship of its own: the same rooms, doors, systems, air and fire, stepped by
// the same code, held in `state.fight.enemy`. `enemyOf(sim)` wraps that state
// so every function written for "a ship" works on either side.
//
// Each ship has:
//   hull     { points, max }: at 0 the ship breaks up
//   shield   a capacitor (D-075, S2.8): { charge, field, until }. Power in the
//            shields system charges it, up to one unit a bar. Nothing stops a
//            shot until the crew BRACE: the whole charge is dumped into a field
//            that lasts BRACE.seconds, and each shot that lands in it costs a
//            unit (more for a gun that pierces). Bracing lights the ship up.
//   weapons  one per fitted hardpoint: { id, charge, target, powered, rounds }.
//            The weapons system's bars go to weapons in hardpoint order; a
//            weapon with its bars charges, one without loses its charge.
//            Heavy guns fire rounds that crew carry up from the hold (D-076,
//            hold.js); `rounds` is what is loaded, null for a gun that needs none.
//
// A charged weapon with a target fires by itself and starts charging again.
// The shot is in the air for the weapon's flight time, then lands: it misses
// (the shooter's lock was poor: senses.js, D-074), is stopped by a brace, or
// hits. A heavy gun with no rounds loaded holds its charge and waits. A gun fired with no lock at all goes wide: it is aimed at
// nothing, and comes down wherever it comes down. Firing lights the ship up
// for a few seconds, which is what the other side locks on to.
//
// Jumping away (S2.7) needs a sensor fix, not a charged drive: sensors with
// power and someone at the helm take the fix, every hit we take and every gun
// we fire knocks it back, and the drive needs a bar when the moment comes.
//
// A hit (S2.2) takes hull points and wears the room it lands in. Then, rolled
// on the `combat` stream: it breaks a bar of the room's system for every point
// of damage, may start a fire, may hole the hull (more likely the more worn the
// room already is), and may hurt each person standing there. Fires and breaches
// are only set on the room; from then on the Stage 1 hazard code (atmosphere.js)
// runs them exactly as it runs any other fire or breach.
//
// A fight (S2.3) can open with a hail: neither side fires while the enemy
// talks, and the player can talk, bribe or open fire. Once shooting starts
// the enemy captain (tactics.js) routes power, aims and works its crew. A
// fight ends one of nine ways (brief §7), each through `decide`:
//   destroyed    their hull is gone          lost        ours is
//   crew-dead    nobody alive aboard them    surrendered we took their offer
//   escaped      we jumped away              fled        they jumped away
//   talked       talked out of it            bribed      paid off
//   stalemate    nobody has hurt anybody for STALEMATE_SECONDS: they break away
// The stalemate rule means no fight runs forever: each hull point lost buys
// at most STALEMATE_SECONDS more, and hull points never come back mid-fight.
//
// Crew can board (S2.4, boarding.js): either side's people can cross to the
// other ship once its shields are down, and fight hand to hand there. Killing
// everyone of theirs, on either ship, is the crew-dead ending. When a fight is
// decided, boarders go home, except ours aboard a ship that is destroyed (they
// go with it) and theirs aboard ours when their ship does not take them back
// (they are captured).

import { FIRE_CATCH_O2, FIRE_START, harmCrew, killCrew } from './atmosphere.js';
import { airlockRooms, everyone, moveAboard, sendAcross, stepBoarding, whyNotCross } from './boarding.js';
import { addCrate } from './hold.js';
import { CREW_COMMANDS, isHome, spotIn } from './crew.js';
import { bestSkillAboard, bestSkillIn, skillFactor } from './roles.js';
import { stepPower } from './power.js';
import { FLARE, NOISE, bang, contactView, flare, missChance, newContact, stepContact } from './senses.js';
import { THINK_SECONDS, braceAgainst, droneTarget, planOf, think } from './tactics.js';

/** The shield capacitor (D-075): each bar routed to shields puts one unit in over `seconds`, and holds one unit. */
export const CAPACITOR = Object.freeze({ seconds: 8 });
/**
 * A brace: needs at least `min` units, dumps them all into a field that lasts `seconds`,
 * and lights the ship up (`flare`) and rings the shields room (`noise`). A shot costs 1 + its pierce to stop.
 */
export const BRACE = Object.freeze({ min: 1, seconds: 2.5, flare: 0.35, noise: 0.8 });
/** An unpowered weapon loses charge this many times faster than it gained it. */
export const DISCHARGE_RATE = 2;
/** How much of a room's hull integrity one point of damage takes. */
export const ROOM_HULL_PER_DAMAGE = 0.15;
/** What a hit does besides hull points. Starting values, to tune from the bot's fight report (DF-34). */
export const HIT = Object.freeze({
  wearBreach: 0.6, // extra breach chance per unit of the room's hull integrity already lost
  breachPerDamage: 0.3, // size of the hole per point of damage
  crewHarmPerDamage: 0.2, // health taken from someone caught in the room, per point of damage
});
/** Seconds the enemy waits on a hail before it opens fire, and on a surrender offer before it takes the silence as a no. */
/**
 * Running dark has a price (S2.5, D-096): crew at a station in an unlit room
 * work it at this share of the pace. A gun charges, a capacitor fills and a
 * sensor fix builds slower when the gun deck, the shield room or the bridge
 * is dark. A ship with nobody aboard does not care.
 */
export const DARK_STATION = 0.6;
/** Light enough to work a station by. */
export const STATION_LIGHT = 0.5;
export function stationPace(ship, room) {
  if (!room || !Object.keys(ship.state.crew).length) return 1;
  return ship.state.rooms[room.id].light >= STATION_LIGHT ? 1 : DARK_STATION;
}
const helmOf = (ship) => ship.layout.rooms.find((room) => room.kind === 'helm');
export const HAIL_SECONDS = 30;
export const OFFER_SECONDS = 30;
/** Seconds of shooting with no hull damage on either side before the fight is called off. */
export const STALEMATE_SECONDS = 90;
/**
 * A jump needs a sensor fix (D-074): `seconds` of sensors with one bar and someone at the helm, quicker with more bars.
 * A hit on the ship knocks `hit` off the fix and each gun it fires `shot`; with the sensors dark or the helm empty it drains away.
 */
export const FIX = Object.freeze({ seconds: 25, hit: 0.25, shot: 0.1, drain: 0.05 });
/** Stand-in for our reputation until factions (Stage 7) exist (DF-06): talk is judged at this, moved by the best talker aboard (D-131). */
export const NEGOTIATION_PLACEHOLDER = 0.5;
/** Each level of negotiation in our best talker adds this to the chance that talking works. */
export const NEGOTIATION_STEP = 0.05;
/** Money aboard at the start, until runs and contracts set it (Stage 3). */
export const START_MONEY = 120;

/** How each ending reads, for the UI and the bot's report. */
export const OUTCOMES = Object.freeze({
  destroyed: 'Destroyed',
  lost: 'Our hull gave out',
  'crew-dead': 'Their crew is dead',
  surrendered: 'Surrendered',
  escaped: 'We jumped away',
  fled: 'They jumped away',
  talked: 'Talked down',
  bribed: 'Paid off',
  stalemate: 'Broke off',
});
const MAX_SHOTS = 64;
const EPS = 1e-9;

// ---------- reading a ship ----------

/** The most the capacitor can hold: one unit per bar routed to shields (none on a wreck). */
export const capacity = (ship) => (ship.state.hull.points === 0 ? 0 : ship.state.systems.shields.power);
/** The capacitor as a fraction of what it can hold, 0 to 1. */
export const capacitorOf = (ship) => (capacity(ship) > 0 ? Math.min(1, ship.state.shield.charge / capacity(ship)) : 0);
/** Is a brace up? */
export const braced = (ship) => ship.state.shield.field > EPS;
/** Why this ship cannot brace now, or null. */
export function whyNoBrace(ship) {
  if (braced(ship)) return 'already braced';
  if (capacity(ship) === 0) return 'the shields have no power';
  if (ship.state.shield.charge < BRACE.min - EPS) return `the capacitor is at ${Math.floor(capacitorOf(ship) * 100)}%: a brace needs a full bar`;
  return null;
}
/** Loaded and ready to go: a gun that needs no rounds always is. */
export const hasRounds = (ship, slot) => ship.state.weapons[slot].rounds === null || ship.state.weapons[slot].rounds > 0;

/** Is one of the ship's own crew alive at the helm? A boarder standing there flies nothing. */
export function hasPilot(ship) {
  const helm = ship.layout.rooms.find((room) => room.kind === 'helm');
  return Boolean(helm) && Object.values(ship.state.crew).some((member) => member.alive && member.room === helm.id && isHome(ship, member) && member.task !== 'crossing');
}

/** Which weapons have their bars, by slot: the weapons system's power is dealt out in hardpoint order. */
export function weaponsPowered(ship) {
  let budget = ship.state.systems.weapons.power;
  return ship.state.weapons.map((slot) => {
    const need = ship.catalog.weapon(slot.id).power;
    if (need > budget) return false;
    budget -= need;
    return true;
  });
}

/** Sensor bars working on a fix: a ship built without a sensors room has a fixed navigation set worth one. */
const fixBars = (ship) => (ship.state.systems.sensors.absent ? 1 : ship.state.systems.sensors.power);
/** Can this ship take a sensor fix right now? Sensors running and someone at the helm. */
export const canFix = (ship) => fixBars(ship) > 0 && hasPilot(ship);
/** The sensor fix as a fraction, 0 to 1. */
export const fixOf = (ship) => Math.min(1, ship.state.fix);
/** Why this ship cannot jump this instant, or null: the fix, the helm, then the drive. */
export function whyNoJump(ship) {
  if (fixOf(ship) < 1) return fixBars(ship) > 0 ? `the sensor fix is at ${Math.floor(fixOf(ship) * 100)}%` : 'the sensors have no power to take a fix';
  if (!hasPilot(ship)) return 'nobody is at the helm';
  if (ship.state.systems.engines.power < 1) return 'the engines have no power';
  return null;
}
/** A ship's own crew, alive and aboard it. */
export const livingCrew = (ship) => Object.values(ship.state.crew).filter((member) => member.alive && isHome(ship, member));
/** Everyone of `owner`'s crew still alive, on either ship: 'player' or 'enemy'. */
export const crewLeft = (sim, owner) => everyone(sim, enemyOf(sim), owner).filter(({ member }) => member.alive);

/** Find a crew member on either ship: { member, ship }, or null. */
export function findCrew(sim, id) {
  if (sim.state.crew[id]) return { member: sim.state.crew[id], ship: sim };
  const enemy = enemyOf(sim);
  if (enemy?.state.crew[id]) return { member: enemy.state.crew[id], ship: enemy };
  return null;
}

/** Our crew, wherever they are, in roster order: [{ member, ship }]. */
export const ourCrew = (sim) => everyone(sim, enemyOf(sim), 'player');

/** The chance that talking works on the enemy in this fight, 0 to 1. */
export function talkChance(sim) {
  const hail = sim.state.fight ? planOf(enemyOf(sim).layout).hail : null;
  if (!hail) return 0;
  const talker = bestSkillAboard(ourCrew(sim).map(({ member }) => member), 'negotiation');
  const skill = talker * NEGOTIATION_STEP;
  return Math.max(0, Math.min(1, hail.talk + (NEGOTIATION_PLACEHOLDER - 0.5) * 0.6 + skill));
}

/** What the enemy wants to be paid to leave, or null if it is not asking. */
export function bribePrice(sim) {
  const fight = sim.state.fight;
  if (!fight || fight.phase !== 'hail') return null;
  return planOf(enemyOf(sim).layout).hail?.bribe ?? null;
}

/** A weapon's charge as a fraction, 0 to 1. */
export const chargeOf = (ship, slot) => Math.min(1, ship.state.weapons[slot].charge / ship.catalog.weapon(ship.state.weapons[slot].id).charge);

// ---------- state ----------

/** The fighting part of a new ship's state. */
export function newCombatState(layout, systems, catalog) {
  return {
    hull: { points: layout.hullPoints, max: layout.hullPoints },
    shield: { charge: systems.shields.power, field: 0, until: 0 }, // a ship that starts with shields powered starts with the capacitor full
    // Heavy guns start with a full magazine; what is in the hold is for after.
    weapons: layout.weapons.map((id) => ({ id, charge: 0, target: null, powered: false, rounds: catalog.weapon(id).ammo?.magazine ?? null })),
    fix: 0, // the sensor fix a jump needs, 0 to 1 (FIX)
  };
}

/** The enemy as a ship: the same shape as the sim itself, so ship code runs on it unchanged. Null outside a fight. */
const contexts = new WeakMap();
export function enemyOf(sim) {
  const fight = sim.state.fight;
  if (!fight) return null;
  let ship = contexts.get(sim);
  if (!ship || ship.layout.id !== fight.enemy.ship) {
    ship = {
      side: 'enemy',
      layout: sim.catalog.layout(fight.enemy.ship),
      catalog: sim.catalog,
      rng: sim.rng,
      lines: [],
      rules: sim.rules, // our boarders remember aboard their ship as they do aboard ours
      // What happens aboard the enemy is announced apart from the player's ship, so alarms and the AI are not fooled.
      // News about a crew member goes straight to the bus, named by whose crew they are (crewEmit).
      events: { emit: (type, payload) => sim.events.emit(`enemy.${type}`, payload), bus: sim.events },
      get state() {
        return sim.state.fight.enemy;
      },
    };
    contexts.set(sim, ship);
  }
  return ship;
}

/** Debug actions that lead to each ending (brief §7). */
export const DEBUG_ACTIONS = Object.freeze(['cripple', 'killCrew', 'surrender', 'flee', 'chargeJump', 'stalemate', 'sinkUs', 'money', 'boardUs', 'scan']);

const inHail = (sim) => (!sim.state.fight || sim.state.fight.over ? 'there is no fight' : sim.state.fight.phase !== 'hail' ? 'the shooting has already started' : null);

function clearTargets(ship) {
  for (const slot of ship.state.weapons) slot.target = null;
}

/** Begin a fight with an enemy ship from the catalog. `newShipState` comes from sim.js. */
export function startFight(sim, enemyId, newShipState) {
  const layout = sim.catalog.layout(enemyId);
  const plan = planOf(layout);
  const { tick } = sim.state;
  sim.state.fix = 0; // a fix is taken for this fight, from nothing
  // Their people may share an id with ours; two ships' crews can mix, so theirs give way.
  const roster = layout.crew.map((person) => (sim.state.crew[person.id] ? { ...person, id: `foe-${person.id}` } : person));
  sim.state.fight = {
    enemy: { ship: layout.id, tick, ...newShipState(layout, roster, 'enemy', sim.catalog) },
    shots: [], // in the air: { id, side, slot, weapon, room, born, lands }
    nextShot: 1,
    started: tick,
    phase: plan.hail ? 'hail' : 'battle', // hail: nobody fires while they talk
    hailEnds: plan.hail ? tick + HAIL_SECONDS * 20 : tick,
    talked: false, // we have tried talking
    offer: null, // their surrender terms while they stand: { kind, amount | name, qty | text, expires }
    offered: false, // they have offered once already
    fleeing: false, // they are charging their jump to get away
    lastHarm: tick, // the last tick either hull lost a point
    engaged: tick, // when the shooting started (or will have: set again when a hail ends)
    over: null, // { outcome, tick, ... } once it is decided (OUTCOMES)
    drones: [], // a carrier's drones out (S2.5): { id, next } where next is the tick it fires again
    nextDrone: 1,
    droneAt: tick, // the last launch
  };
  // Neither ship knows the other yet: no lock, and nothing of its rooms made out.
  const enemy = enemyOf(sim);
  sim.state.contact = newContact(enemy);
  enemy.state.contact = newContact(sim);
  sim.events.emit('fight.started', { enemy: layout.id, name: layout.name, hailing: Boolean(plan.hail), tick });
  if (plan.hail) sim.events.emit('fight.hail', { enemy: layout.id, name: layout.name, text: plan.hail.text, bribe: plan.hail.bribe, tick });
}

/**
 * Boarders when a fight ends. Ours come home, unless the ship they are on is
 * destroyed. Theirs go home if their ship takes them back (it parted from us
 * on terms), or are captured: left aboard a ship that is not theirs.
 */
const TAKEN_BACK = new Set(['surrendered', 'talked', 'bribed', 'stalemate', 'recalled']);
function settleBoarders(sim, outcome) {
  const enemy = enemyOf(sim);
  const { tick } = sim.state;
  const dock = (ship) => airlockRooms(ship)[0] ?? ship.layout.rooms.find((room) => !ship.state.rooms[room.id].jettisoned)?.id ?? ship.layout.rooms[0].id;
  for (const member of Object.values(enemy.state.crew)) {
    if (member.owner === 'player') {
      if (outcome === 'destroyed' && member.alive) killCrew(enemy, member.id, 'wreck');
      moveAboard(enemy, sim, member, dock(sim));
      if (!member.alive) Object.assign(member, { task: 'dead' });
    } else if (member.board) Object.assign(member, { board: null, crossEnds: null, task: 'idle' });
  }
  for (const member of Object.values(sim.state.crew)) {
    if (member.party) continue; // a boarding party off a docked contact (H.2) is not the fight's
    if (member.owner === 'player') {
      // Called back on their way to the airlock: they step back to their spot in whatever room they are in, off any lift or doorway.
      if (member.board) Object.assign(member, { board: null, crossEnds: null, task: 'idle', goal: null, path: [spotIn(sim.layout.room(member.room), member.index)] });
      continue;
    }
    if (TAKEN_BACK.has(outcome) && member.alive) {
      moveAboard(sim, enemy, member, dock(enemy));
      continue;
    }
    delete sim.state.crew[member.id];
    if (member.alive) sim.events.emit('crew.captured', { crew: member.id, name: member.name, tick });
  }
}

export function endFight(sim) {
  settleBoarders(sim, 'recalled'); // anyone still across (after our hull went, say) goes home
  clearTargets(sim);
  sim.state.fight = null;
  sim.state.contact = null;
  sim.state.fix = 0;
  sim.events.emit('fight.ended', { tick: sim.state.tick });
}

/** The fight is over, one of the OUTCOMES ways. Guns stop and whatever is in the air is lost. */
export function decide(sim, outcome, extra = {}) {
  const fight = sim.state.fight;
  if (!fight || fight.over) return;
  fight.over = { outcome, tick: sim.state.tick, ...extra };
  fight.offer = null;
  fight.shots = [];
  if (outcome !== 'lost') settleBoarders(sim, outcome); // when ours is lost, nobody is going anywhere
  clearTargets(sim);
  clearTargets(enemyOf(sim));
  sim.events.emit('fight.over', { ...fight.over, enemy: fight.enemy.ship });
  // And how it went, in a word, for whoever only cares about that (Margo, for now).
  sim.events.emit(`fight.${ENDING_KIND[outcome]}`, { outcome, enemy: fight.enemy.ship, tick: sim.state.tick });
}

/** Each ending as a win, a parting of ways, or a loss. */
const ENDING_KIND = Object.freeze({ destroyed: 'won', 'crew-dead': 'won', surrendered: 'won', escaped: 'parted', fled: 'parted', talked: 'parted', bribed: 'parted', stalemate: 'parted', lost: 'lost' });

/** Shooting starts: from a failed talk, our order, or their patience running out. */
function engage(sim, by) {
  const fight = sim.state.fight;
  if (fight.phase === 'battle') return;
  fight.phase = 'battle';
  fight.lastHarm = sim.state.tick;
  fight.engaged = sim.state.tick;
  sim.events.emit('fight.engaged', { by, tick: sim.state.tick });
}

/** They give up: roll what they offer from their list. */
function makeOffer(sim) {
  const fight = sim.state.fight;
  const plan = planOf(enemyOf(sim).layout);
  const dice = sim.rng.stream('tactics');
  const terms = dice.pick(plan.surrender.offers);
  const offer = { kind: terms.kind, expires: sim.state.tick + OFFER_SECONDS * 20 };
  if (terms.kind === 'money') offer.amount = dice.between(terms.amount[0], terms.amount[1]);
  if (terms.kind === 'cargo') Object.assign(offer, { name: terms.name, qty: dice.between(terms.qty[0], terms.qty[1]) });
  if (terms.kind === 'info') offer.text = terms.text;
  fight.offer = offer;
  fight.offered = true;
  sim.events.emit('fight.offer', { ...offer, enemy: fight.enemy.ship, tick: sim.state.tick });
}

/** What an accepted offer puts in our hands. */
function collect(sim, offer) {
  if (offer.kind === 'money') sim.state.money += offer.amount;
  if (offer.kind === 'cargo') {
    sim.state.cargo.push({ name: offer.name, qty: offer.qty, from: sim.state.fight.enemy.ship });
    // It comes across as crates, set down at the airlock nearest the hold, for someone to stow.
    const dock = airlockRooms(sim).find((id) => sim.layout.room(id).kind === 'hold' || sim.layout.room(id).system === 'cargo') ?? airlockRooms(sim)[0] ?? sim.layout.rooms[0].id;
    for (let i = 0; i < offer.qty; i++) addCrate(sim, { kind: 'salvage', room: dock, label: offer.name, contents: `${offer.name}, handed over by the ${sim.catalog.layout(sim.state.fight.enemy.ship).name}` });
  }
  if (offer.kind === 'info') sim.state.intel.push({ text: offer.text, from: sim.state.fight.enemy.ship, tick: sim.state.tick });
}

/** Describe an offer in a few words: "75 money", "2 x Crate of machine parts", "a tip". */
export function offerText(offer) {
  if (offer.kind === 'money') return `${offer.amount} money`;
  if (offer.kind === 'cargo') return `${offer.qty} x ${offer.name}`;
  return `what they know: "${offer.text}"`;
}

// ---------- orders ----------

/** Find one of our own crew for an order: { member, ship }, or a reason string. */
function ours(sim, id) {
  const found = findCrew(sim, id);
  if (!found) return `no crew member "${id}"`;
  if (found.member.owner !== 'player') return `${found.member.name} is not one of ours`;
  return found;
}

/** A crew order, carried out on whichever ship the crew member is aboard. */
function aboard(type) {
  return {
    check(sim, cmd) {
      const found = ours(sim, cmd.crew);
      return typeof found === 'string' ? found : CREW_COMMANDS[type].check(found.ship, cmd);
    },
    apply(sim, cmd) {
      CREW_COMMANDS[type].apply(findCrew(sim, cmd.crew).ship, cmd);
    },
  };
}

export function combatCommands(newShipState) {
  return {
    // Send someone to a room: on the ship they are aboard, or across to the other one (ship: 'us' or 'them').
    'crew.move': {
      check(sim, cmd) {
        const found = ours(sim, cmd.crew);
        if (typeof found === 'string') return found;
        const { member, ship } = found;
        if (cmd.ship !== undefined && !['us', 'them'].includes(cmd.ship)) return 'ship must be "us" or "them"';
        const to = cmd.ship === 'them' ? enemyOf(sim) : sim;
        if (!to) return 'there is no other ship';
        if (member.task === 'crossing') return `${member.name} is in the docking tube`;
        if (to === ship) return CREW_COMMANDS['crew.move'].check(ship, cmd);
        if (!member.alive) return `${member.name} is dead`;
        const fight = sim.state.fight;
        if (fight.over) return 'the fight is over';
        if (fight.phase !== 'battle' && to !== sim) return 'nobody boards while they are still talking';
        const room = to.state.rooms[cmd.room];
        if (!room) return `no room "${cmd.room}" on that ship`;
        if (room.jettisoned) return 'that section is gone';
        return whyNotCross(ship, to, member);
      },
      apply(sim, cmd) {
        const { member, ship } = findCrew(sim, cmd.crew);
        const to = cmd.ship === 'them' ? enemyOf(sim) : sim;
        if (to === ship) {
          member.board = null;
          CREW_COMMANDS['crew.move'].apply(ship, cmd);
        } else sendAcross(ship, to, member, cmd.room);
      },
    },
    'crew.suit': aboard('crew.suit'),
    'debug.crew': aboard('debug.crew'),
    // Aim a weapon at a room on the enemy ship, or at nothing (room: null). Works paused, like every order.
    'weapon.target': {
      check(sim, cmd) {
        if (!Number.isInteger(cmd.slot) || !sim.state.weapons[cmd.slot]) return `no weapon in slot ${cmd.slot}`;
        if (cmd.room === null) return null;
        const fight = sim.state.fight;
        if (!fight || fight.over) return 'there is nothing to shoot at';
        const room = fight.enemy.rooms[cmd.room];
        if (!room) return `no room "${cmd.room}" on their ship`;
        if (room.jettisoned) return 'that section is gone';
        if (!contactView(sim, cmd.room)?.resolved) return 'the sensors have not made that part of them out yet';
        return null;
      },
      apply(sim, cmd) {
        const slot = sim.state.weapons[cmd.slot];
        if (slot.target === cmd.room) return;
        slot.target = cmd.room;
        sim.events.emit('weapon.targeted', { slot: cmd.slot, weapon: slot.id, room: cmd.room, tick: sim.state.tick });
      },
    },
    // Dump the shield capacitor into a brace: it soaks what lands in the next BRACE.seconds, and lights us up.
    'ship.brace': {
      check(sim) {
        const fight = sim.state.fight;
        if (!fight || fight.over) return 'there is nothing to brace against';
        return whyNoBrace(sim);
      },
      apply: (sim) => brace(sim),
    },
    // Before shooting starts: try talking them out of it. One go.
    'fight.talk': {
      check(sim) {
        const problem = inHail(sim);
        if (problem) return problem;
        if (sim.state.fight.talked) return 'they have heard enough talk';
        return null;
      },
      apply(sim) {
        const fight = sim.state.fight;
        fight.talked = true;
        const chance = talkChance(sim);
        const worked = sim.rng.stream('tactics').chance(chance);
        sim.events.emit('fight.talked', { worked, chance, tick: sim.state.tick });
        if (worked) decide(sim, 'talked');
        else engage(sim, 'talk');
      },
    },
    // Before shooting starts: pay them to leave.
    'fight.bribe': {
      check(sim) {
        const problem = inHail(sim);
        if (problem) return problem;
        const price = bribePrice(sim);
        if (sim.state.money < price) return `they want ${price} and we have ${sim.state.money}`;
        return null;
      },
      apply(sim) {
        const price = bribePrice(sim);
        sim.state.money -= price;
        decide(sim, 'bribed', { paid: price });
      },
    },
    // Before shooting starts: stop talking and shoot.
    'fight.engage': {
      check: (sim) => inHail(sim),
      apply: (sim) => engage(sim, 'us'),
    },
    // Take their surrender, and what they offer for it.
    'fight.accept': {
      check: (sim) => (!sim.state.fight?.offer || sim.state.fight.over ? 'nobody is offering to surrender' : null),
      apply(sim) {
        const { offer } = sim.state.fight;
        collect(sim, offer);
        decide(sim, 'surrendered', { offer });
      },
    },
    // Turn their surrender down and keep shooting.
    'fight.refuse': {
      check: (sim) => (!sim.state.fight?.offer || sim.state.fight.over ? 'nobody is offering to surrender' : null),
      apply(sim) {
        sim.state.fight.offer = null;
        sim.events.emit('fight.refused', { tick: sim.state.tick });
      },
    },
    // Jump away once the sensors have a fix.
    'ship.jump': {
      check(sim) {
        const fight = sim.state.fight;
        if (!fight) return sim.state.run ? 'out of a fight, plot a course on the chart and jump from there' : 'there is nowhere to jump to';
        if (fight.over) return 'the fight is over';
        const problem = whyNoJump(sim);
        if (problem) return problem;
        const away = ourCrew(sim).find(({ member, ship }) => member.alive && (ship !== sim || member.task === 'crossing'));
        if (away) return `${away.member.name} is still aboard them`;
        return null;
      },
      apply: (sim) => decide(sim, 'escaped'),
    },
    // Leave a fight that has been decided.
    'fight.dismiss': {
      check: (sim) => (!sim.state.fight ? 'there is no fight' : sim.state.fight.over ? null : 'the fight is not over'),
      apply: (sim) => endFight(sim),
    },
    // Debug panel only: a shot lands at once. at: 'us' or 'them'; room: a room on that ship, or null for any;
    // weapon: what it is; force: true to make it a hit whatever the shields and evasion say.
    'debug.hit': {
      check(sim, cmd) {
        if (!['us', 'them'].includes(cmd.at)) return 'at must be "us" or "them"';
        const ship = cmd.at === 'us' ? sim : enemyOf(sim);
        if (!ship) return 'there is no enemy ship';
        if (sim.state.fight?.over) return 'the fight is over';
        if (!sim.catalog.hasWeapon(cmd.weapon)) return `no weapon "${cmd.weapon}"`;
        if (cmd.room === null || cmd.room === undefined) return null;
        const room = ship.state.rooms[cmd.room];
        if (!room) return `no room "${cmd.room}" on that ship`;
        if (room.jettisoned) return 'that section is gone';
        return null;
      },
      apply(sim, cmd) {
        const ship = cmd.at === 'us' ? sim : enemyOf(sim);
        let room = cmd.room ?? null;
        if (room === null) {
          const standing = ship.layout.rooms.filter((r) => !ship.state.rooms[r.id].jettisoned);
          if (!standing.length) return;
          room = sim.rng.stream('combat').pick(standing).id;
        }
        const fight = sim.state.fight;
        const id = fight ? fight.nextShot++ : 0;
        land(sim, { id, side: cmd.at === 'us' ? 'enemy' : 'player', slot: 0, weapon: cmd.weapon, room, born: sim.state.tick, lands: sim.state.tick }, { force: Boolean(cmd.force) });
      },
    },
    // Debug panel only: push a fight toward one of its endings, through the normal code.
    'debug.combat': {
      check(sim, cmd) {
        if (!DEBUG_ACTIONS.includes(cmd.action)) return `no debug action "${cmd.action}"`;
        if (cmd.action === 'money') return null;
        const fight = sim.state.fight;
        if (!fight) return 'there is no fight';
        if (fight.over) return 'the fight is over';
        const enemy = enemyOf(sim);
        const plan = planOf(enemy.layout);
        if (cmd.action === 'killCrew' && !crewLeft(sim, 'enemy').length) return 'there is nobody aboard them, or anywhere';
        if (cmd.action === 'surrender' && (!plan.surrender || !crewLeft(sim, 'enemy').length)) return 'they have nobody to surrender';
        if (cmd.action === 'boardUs' && livingCrew(enemy).length < 2) return 'they have nobody to spare for a boarding party';
        if (cmd.action === 'surrender' && fight.offer) return 'they are already offering';
        if (cmd.action === 'flee' && (!plan.flee || !hasPilot(enemy))) return 'they have no way to run';
        return null;
      },
      apply(sim, cmd) {
        const fight = sim.state.fight;
        const enemy = enemyOf(sim);
        const { tick } = sim.state;
        if (cmd.action === 'money') sim.state.money += 100;
        if (cmd.action === 'cripple') Object.assign(enemy.state, { hull: { ...enemy.state.hull, points: 1 }, shield: { charge: 0, field: 0, until: 0 } });
        if (cmd.action === 'sinkUs') Object.assign(sim.state, { hull: { ...sim.state.hull, points: 1 }, shield: { charge: 0, field: 0, until: 0 } });
        if (cmd.action === 'killCrew') for (const { member, ship } of crewLeft(sim, 'enemy')) killCrew(ship, member.id, 'debug');
        if (cmd.action === 'boardUs') {
          // Everyone but their first crew member comes straight through our nearest airlock to the helm, or wherever they can.
          engage(sim, 'debug');
          const helm = sim.layout.rooms.find((room) => room.kind === 'helm') ?? sim.layout.rooms[0];
          const party = livingCrew(enemy).filter((member) => member.task !== 'crossing').slice(1);
          for (const member of party) {
            member.board = { room: helm.id };
            member.task = 'crossing';
            member.crossEnds = tick;
          }
        }
        if (cmd.action === 'surrender') {
          engage(sim, 'debug');
          makeOffer(sim);
        }
        if (cmd.action === 'flee') {
          engage(sim, 'debug');
          fight.fleeing = true;
          enemy.state.fix = 1;
        }
        if (cmd.action === 'chargeJump') sim.state.fix = 1;
        if (cmd.action === 'scan') {
          // Our sensors have all they could want, and keep it: a perfect lock, and every room of theirs made out.
          Object.assign(sim.state.contact, { lock: 1, locked: true, pinned: true });
          for (const entry of Object.values(sim.state.contact.rooms)) entry.resolve = 1;
        }
        if (cmd.action === 'stalemate') {
          engage(sim, 'debug');
          fight.lastHarm = tick - STALEMATE_SECONDS * 20;
        }
      },
    },
    // Debug panel only: put an enemy ship alongside, or send it away (enemy: null).
    'debug.fight': {
      check(sim, cmd) {
        if (cmd.enemy === null) return sim.state.fight ? null : 'there is no fight to end';
        if (!sim.catalog.enemies.includes(cmd.enemy)) return `no enemy ship "${cmd.enemy}"`;
        if (sim.state.fight && !sim.state.fight.over) return 'already in a fight';
        return null;
      },
      apply(sim, cmd) {
        if (sim.state.fight) endFight(sim);
        if (cmd.enemy !== null) startFight(sim, cmd.enemy, newShipState);
      },
    },
  };
}

// ---------- each tick ----------

/** Dump the capacitor into a brace. Check whyNoBrace first. */
export function brace(ship) {
  const { shield } = ship.state;
  const { tick } = ship.state;
  shield.field = shield.charge;
  shield.charge = 0;
  shield.until = tick + Math.round(BRACE.seconds * 20);
  // A field going up is the brightest thing for a long way: the other side's sensors see it.
  flare(ship, BRACE.flare);
  const room = ship.layout.roomOfSystem('shields');
  if (room) bang(ship, room.id, BRACE.noise);
  ship.events.emit('ship.braced', { field: shield.field, until: shield.until, tick });
}

/** The capacitor charges while no brace is up; a brace runs its time and is gone. */
function stepShield(ship, dt) {
  const { shield } = ship.state;
  const { tick } = ship.state;
  const max = capacity(ship);
  if (shield.field > 0 && (tick >= shield.until || max === 0)) {
    ship.events.emit('brace.ended', { left: shield.field, tick });
    shield.field = 0;
  }
  if (shield.field > 0) shield.charge = Math.min(shield.charge, max);
  else shield.charge = shield.charge >= max ? max : Math.min(max, shield.charge + (dt * stationPace(ship, ship.layout.roomOfSystem('shields')) * ship.state.systems.shields.power) / CAPACITOR.seconds);
}

function stepWeapons(sim, ship, side, dt) {
  const fight = sim.state.fight;
  const powered = weaponsPowered(ship);
  const gunRoom = ship.layout.roomOfSystem('weapons');
  // A gunner in the weapons room charges the guns faster (D-131).
  const pace = stationPace(ship, gunRoom) * (gunRoom ? skillFactor(bestSkillIn(ship, gunRoom.id, 'weapons')) : 1);
  ship.state.weapons.forEach((slot, index) => {
    const weapon = ship.catalog.weapon(slot.id);
    const wasReady = slot.charge >= weapon.charge - EPS;
    slot.powered = powered[index];
    slot.charge = slot.powered ? Math.min(weapon.charge, slot.charge + dt * pace) : Math.max(0, slot.charge - dt * DISCHARGE_RATE);
    const ready = slot.charge >= weapon.charge - EPS;
    if (ready && !wasReady && side === 'player') sim.events.emit('weapon.ready', { slot: index, weapon: slot.id, tick: sim.state.tick });
    if (!ready || slot.target === null || !fight || fight.over || fight.shots.length >= MAX_SHOTS) return;
    // Nobody fires while they talk, and they hold their fire while offering to give up.
    if (fight.phase !== 'battle' || (side === 'enemy' && fight.offer)) return;
    // A heavy gun with nothing in the breech waits, charged, for someone to bring rounds up from the hold.
    if (slot.rounds !== null && slot.rounds < 1) {
      if (!slot.dry) {
        slot.dry = true;
        ship.events.emit('weapon.empty', { slot: index, weapon: slot.id, tick: sim.state.tick });
      }
      return;
    }
    slot.dry = false;
    if (slot.rounds !== null) slot.rounds -= 1;
    slot.charge = 0;
    // With no lock the gun is aimed at nothing: the shot goes wherever it goes. The dice are thrown either way.
    const foe = side === 'player' ? enemyOf(sim) : sim;
    const standing = foe.layout.rooms.filter((room) => !foe.state.rooms[room.id].jettisoned);
    const stray = sim.rng.stream('combat').pick(standing.length ? standing : foe.layout.rooms).id;
    const blind = !ship.state.contact?.locked;
    const shot = { id: fight.nextShot++, side, slot: index, weapon: slot.id, room: blind ? stray : slot.target, blind, born: sim.state.tick, lands: sim.state.tick + Math.max(1, Math.round(weapon.flight * 20)) };
    fight.shots.push(shot);
    // A gun going off is loud aboard, lights the ship up for the other side, and shakes the sensor fix.
    const gunRoom = ship.layout.roomOfSystem('weapons');
    if (gunRoom) bang(ship, gunRoom.id, NOISE.gun);
    flare(ship, FLARE.perBar * weapon.power);
    ship.state.fix = Math.max(0, ship.state.fix - FIX.shot);
    sim.events.emit('weapon.fired', { ...shot, rounds: slot.rounds, tick: sim.state.tick });
    if (side === 'enemy') slot.target = null; // their captain picks a fresh room for every shot
    else if (braceAgainst(foe)) brace(foe); // they see it coming, and may brace
  });
}

/**
 * What a hit does to the room it lands in. `ship` is the ship that was hit.
 * Every roll is made whatever the room holds, so a seed rolls the same dice
 * however the fight has gone. Returns what happened, for the shot's event.
 */
export function applyHit(sim, ship, roomId, weapon) {
  const dice = sim.rng.stream('combat');
  const room = ship.state.rooms[roomId];
  const { tick } = sim.state;
  const effects = { system: 0, fire: false, breach: false, crew: [] };
  const { hull } = ship.state;
  hull.points = Math.max(0, hull.points - weapon.damage);
  if (sim.state.fight && weapon.damage > 0) sim.state.fight.lastHarm = tick;
  room.hull = Math.max(0, room.hull - ROOM_HULL_PER_DAMAGE * weapon.damage);
  bang(ship, roomId, NOISE.hit);
  ship.state.fix = Math.max(0, ship.state.fix - FIX.hit); // the sensors lose their place

  // The room's system loses a bar for each point of damage.
  const systemId = ship.layout.room(roomId).system;
  const system = systemId ? ship.state.systems[systemId] : null;
  if (system && !system.lost && system.damage < system.level) {
    const from = system.damage;
    system.damage = Math.min(system.level, from + weapon.damage);
    effects.system = system.damage - from;
    ship.events.emit('system.damage', { system: systemId, from, to: system.damage, cause: 'hit', tick });
  }

  // Fire, where there is air for it to catch. The hazard code announces it and runs it from here.
  const fire = dice.chance(weapon.effects.fire);
  if (fire && room.oxygen >= FIRE_CATCH_O2) {
    room.fire = Math.min(1, room.fire + FIRE_START);
    effects.fire = true;
  }

  // A hole in the hull: some weapons are made for it, and a worn room gives way more easily.
  const breach = dice.chance(Math.min(1, weapon.effects.breach + HIT.wearBreach * (1 - room.hull)));
  if (breach) {
    room.breach = Math.min(1, room.breach + HIT.breachPerDamage * weapon.damage);
    effects.breach = true;
  }

  // Anyone standing there may be caught by it.
  for (const member of Object.values(ship.state.crew)) {
    if (member.room !== roomId || member.alive === false) continue;
    if (!dice.chance(weapon.effects.crew)) continue;
    effects.crew.push(member.id);
    harmCrew(ship, member.id, HIT.crewHarmPerDamage * weapon.damage, 'hit');
  }

  // A broken system lets go of its power now, not next tick (D-037).
  if (effects.system) stepPower(ship);
  ship.events.emit('hull.hit', { room: roomId, weapon: weapon.id, damage: weapon.damage, ...effects, tick });
  return effects;
}

/** Land a shot: a miss, a shield layer lost, or a hit. `force` (debug only) makes it a hit whatever the odds. */
function land(sim, shot, { force = false } = {}) {
  const fight = sim.state.fight;
  const target = shot.side === 'player' ? enemyOf(sim) : sim;
  const weapon = sim.catalog.weapon(shot.weapon);
  const room = target.state.rooms[shot.room];
  let result = 'hit';
  let effects = null;
  const shooter = shot.side === 'player' ? sim : enemyOf(sim);
  const wide = sim.rng.stream('combat').chance(shooter ? missChance(shooter) : 0); // a debug shot with nobody alongside has no gunner to miss
  const { shield } = target.state;
  const cost = 1 + weapon.pierce; // a gun made to pierce takes more of a brace to stop
  if (!room || room.jettisoned || (wide && !force)) result = 'miss';
  else if (shield.field >= cost - EPS && !force) {
    result = 'shield';
    shield.field = Math.max(0, shield.field - cost);
  } else {
    if (!force) shield.field = 0; // what is left of a brace is not enough: it gives way, and the shot gets through
    effects = applyHit(sim, target, shot.room, weapon);
  }
  // A drone that flies its zap into a brace burns itself out.
  if (shot.drone && result === 'shield' && fight?.drones.some((d) => d.id === shot.drone)) {
    fight.drones = fight.drones.filter((d) => d.id !== shot.drone);
    sim.events.emit('drone.lost', { drone: shot.drone, cause: 'brace', tick: sim.state.tick });
  }
  sim.events.emit('shot.resolved', { id: shot.id, side: shot.side, slot: shot.slot, drone: shot.drone ?? null, weapon: shot.weapon, room: shot.room, blind: Boolean(shot.blind), result, damage: result === 'hit' ? weapon.damage : 0, effects, tick: sim.state.tick });
  if (fight && target.state.hull.points === 0) decide(sim, shot.side === 'player' ? 'destroyed' : 'lost');
}

/**
 * The sensors work on a fix while they have power and someone is at the helm; otherwise it slips away.
 * The same fix plots a course on the sector chart out of a fight (sector.js), which names its own events.
 */
export function stepFix(ship, dt, { ready = 'fix.ready', lost = 'fix.lost' } = {}) {
  const before = ship.state.fix;
  const helm = helmOf(ship);
  const pilot = helm ? skillFactor(bestSkillIn(ship, helm.id, 'piloting')) : 1; // a pilot at the helm takes the fix faster (D-131)
  ship.state.fix = canFix(ship) ? Math.min(1, before + (dt * stationPace(ship, helm) * pilot * fixBars(ship)) / FIX.seconds) : Math.max(0, before - FIX.drain * dt);
  if (before < 1 && ship.state.fix >= 1) ship.events.emit(ready, { tick: ship.state.tick });
  if (before >= 1 && ship.state.fix < 1) ship.events.emit(lost, { tick: ship.state.tick });
}

/** The enemy captain's turn, and the rules that end a fight without a last shot. */
function stepFight(sim, enemy, dt) {
  const fight = sim.state.fight;
  const { tick } = sim.state;
  const plan = planOf(enemy.layout);
  const { hull } = enemy.state;

  if (fight.phase === 'hail' && tick >= fight.hailEnds) engage(sim, 'them');
  if ((tick - fight.started) % Math.round(THINK_SECONDS * 20) === 0) think(enemy, sim, { fleeing: fight.fleeing, boarding: fight.phase === 'battle' && !fight.offer, battleSeconds: (tick - fight.engaged) / 20 });

  if (fight.offer && tick >= fight.offer.expires) {
    fight.offer = null;
    sim.events.emit('fight.refused', { expired: true, tick });
  }
  const crewed = enemy.layout.crew.length > 0;
  const alive = crewLeft(sim, 'enemy').length > 0;
  if (fight.phase === 'battle' && livingCrew(enemy).length > 0 && hull.points > 0) {
    if (plan.surrender && !fight.offered && hull.points <= plan.surrender.at * hull.max) makeOffer(sim);
    if (plan.flee && !fight.fleeing && !fight.offer && hull.points <= plan.flee.at * hull.max) {
      fight.fleeing = true;
      sim.events.emit('fight.fleeing', { enemy: fight.enemy.ship, tick });
    }
  }
  if (fight.fleeing) stepFix(enemy, dt);

  if (crewed && !alive) decide(sim, 'crew-dead');
  else if (fight.fleeing && !whyNoJump(enemy)) decide(sim, 'fled');
  else if (fight.phase === 'battle' && !fight.offer && tick - fight.lastHarm >= STALEMATE_SECONDS * 20) decide(sim, 'stalemate');
}

/**
 * A carrier's drones (S2.5, D-097). While its bay (the weapons system) has
 * power and the shooting is on, it launches one every `every` seconds, up to
 * `max`. Each drone zaps a room of ours it has made out every `fire` seconds.
 * A zap that a brace stops burns the drone out, and the drones fall dead when
 * the bay loses its power.
 */
export const DRONE_WEAPON = 'drone-zap';
function stepDrones(sim, enemy) {
  const fight = sim.state.fight;
  const spec = planOf(enemy.layout).drones;
  if (!spec) return;
  const { tick } = sim.state;
  const bay = enemy.state.systems.weapons;
  if (fight.drones.length && (!bay || bay.power === 0 || enemy.state.hull.points === 0)) {
    for (const drone of fight.drones) sim.events.emit('drone.lost', { drone: drone.id, cause: 'bay', tick });
    fight.drones = [];
  }
  if (fight.phase !== 'battle' || fight.offer || fight.fleeing || !bay || bay.power === 0) return;
  if (fight.drones.length < spec.max && tick - fight.droneAt >= Math.round(spec.every * 20)) {
    fight.droneAt = tick;
    const drone = { id: fight.nextDrone++, next: tick + Math.round(spec.fire * 20) };
    fight.drones.push(drone);
    sim.events.emit('drone.launched', { drone: drone.id, out: fight.drones.length, tick });
  }
  const zap = sim.catalog.weapon(DRONE_WEAPON);
  for (const drone of fight.drones) {
    if (tick < drone.next || fight.shots.length >= MAX_SHOTS) continue;
    drone.next = tick + Math.round(spec.fire * 20);
    const standing = sim.layout.rooms.filter((room) => !sim.state.rooms[room.id].jettisoned);
    const stray = sim.rng.stream('combat').pick(standing.length ? standing : sim.layout.rooms).id;
    const aimed = droneTarget(enemy, sim);
    const blind = !enemy.state.contact?.locked || !aimed;
    const shot = { id: fight.nextShot++, side: 'enemy', slot: -1, drone: drone.id, weapon: DRONE_WEAPON, room: blind ? stray : aimed, blind, born: tick, lands: tick + Math.max(1, Math.round(zap.flight * 20)) };
    fight.shots.push(shot);
    sim.events.emit('drone.fired', { ...shot, tick });
  }
}

/** Shields, weapons and shots in the air for both ships, then the enemy's turn. */
export function stepCombat(sim, dt) {
  const enemy = enemyOf(sim);
  stepShield(sim, dt);
  stepWeapons(sim, sim, 'player', dt);
  if (!enemy) return;
  const fight = sim.state.fight;
  if (!fight.over) {
    stepFix(sim, dt);
    stepContact(sim, enemy, dt);
    stepContact(enemy, sim, dt);
  }
  stepShield(enemy, dt);
  stepWeapons(sim, enemy, 'enemy', dt);
  if (!fight.over) stepDrones(sim, enemy);
  const flying = [];
  for (const shot of fight.shots) {
    if (fight.over) break; // it is decided: whatever was in the air is lost in the wreckage
    if (sim.state.tick >= shot.lands) land(sim, shot);
    else flying.push(shot);
  }
  if (!fight.over) fight.shots = flying;
  if (!fight.over) stepBoarding(sim, enemy);
  if (!fight.over) stepFight(sim, enemy, dt);
}

// ---------- invariants ----------

/** Fighting problems aboard one ship that should never happen. */
export function checkCombatInvariants(ship, foe = null) {
  const problems = [];
  const { hull, shield, weapons, systems } = ship.state;
  if (!Number.isInteger(hull.points) || hull.points < 0 || hull.points > hull.max) problems.push(`hull is ${hull.points} of ${hull.max}`);
  if (!(shield.charge >= 0 && shield.charge <= systems.shields.level + EPS)) problems.push(`shield charge is ${shield.charge} with a level ${systems.shields.level} system`);
  if (!(shield.field >= 0 && shield.field <= systems.shields.level + EPS)) problems.push(`brace field is ${shield.field} with a level ${systems.shields.level} system`);
  if (shield.field > 0 && ship.state.tick > shield.until) problems.push(`a brace is still up after tick ${shield.until}`);
  if (!(ship.state.fix >= 0 && ship.state.fix <= 1 + EPS)) problems.push(`the sensor fix is ${ship.state.fix}`);
  if (weapons.length > ship.layout.hardpoints.length) problems.push(`${weapons.length} weapons on ${ship.layout.hardpoints.length} hardpoints`);
  weapons.forEach((slot, index) => {
    const weapon = ship.catalog.weapon(slot.id);
    if (!(slot.charge >= 0 && slot.charge <= weapon.charge + EPS)) problems.push(`weapon ${index} charge is ${slot.charge} of ${weapon.charge}`);
    if (slot.target !== null && !foe) problems.push(`weapon ${index} is aimed at "${slot.target}" with nobody to shoot at`);
    else if (slot.target !== null && !foe.state.rooms[slot.target]) problems.push(`weapon ${index} is aimed at a room that does not exist: "${slot.target}"`);
  });
  return problems;
}

export function checkFightInvariants(sim) {
  const fight = sim.state.fight;
  if (!fight) return [];
  const problems = [];
  if (fight.shots.length > MAX_SHOTS) problems.push(`${fight.shots.length} shots in the air`);
  for (const shot of fight.shots) {
    if (!(shot.lands > shot.born)) problems.push(`shot ${shot.id} lands at ${shot.lands}, fired at ${shot.born}`);
    if (shot.lands < sim.state.tick) problems.push(`shot ${shot.id} should have landed at tick ${shot.lands}`);
  }
  if (fight.over && fight.shots.length) problems.push('shots are still flying after the fight was decided');
  const spec = sim.state.fight.enemy && planOf(sim.catalog.layout(fight.enemy.ship)).drones;
  if (fight.drones.length > (spec?.max ?? 0)) problems.push(`${fight.drones.length} drones out`);
  if (fight.over && !OUTCOMES[fight.over.outcome]) problems.push(`the fight ended an unknown way: "${fight.over.outcome}"`);
  if (!['hail', 'battle'].includes(fight.phase)) problems.push(`fight phase is "${fight.phase}"`);
  if (fight.offer && !fight.offered) problems.push('an offer stands that was never made');
  if (fight.offer && fight.over) problems.push('an offer stands after the fight was decided');
  if (!fight.over && fight.phase === 'battle' && sim.state.tick - fight.lastHarm > STALEMATE_SECONDS * 20 && !fight.offer) problems.push('the stalemate rule did not end the fight');
  if (!(sim.state.money >= 0) || !Number.isInteger(sim.state.money)) problems.push(`money is ${sim.state.money}`);
  return problems;
}
