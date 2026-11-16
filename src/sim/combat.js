// Guns, hits and the brace (brief §7; reworked in H.3, D-152, D-172 to D-178). DOM-free.
//
// There are no ship duels any more. A hauler cannot win a gunfight, and the
// skill is not being caught (encounters.js). What is left of the old fight is
// what a hauler really carries:
//
//   hull     { points, max }: every hit takes some. At 0 the run is lost.
//   shield   a capacitor (D-075): { charge, field, until }. Power in the
//            shields system charges it, one unit a bar. Nothing stops a shot
//            until the crew BRACE: the whole charge is dumped into a field
//            that lasts BRACE.seconds, and each shot that lands in it costs a
//            unit. Bracing lights the ship up.
//   weapons  one per fitted hardpoint: { id, charge, target, powered, rounds }.
//            The weapons system's bars go to them in hardpoint order. Two
//            kinds (a weapon's `role` in content/weapons/):
//              pd    point defence. Automatic: whenever it is charged it fires
//                    a burst at a drone on the hull or a boarding pod in the
//                    air (encounters.js). Nobody aims it.
//              gun   the deterrent gun (the slug thrower, hand-loaded, D-090).
//                    Aimed at a CONTACT on the scope, never at a room: a
//                    target is a contact's id. It fires when it is charged,
//                    loaded and the contact is on the scope inside its range.
//                    A round that lands puts the fear into the contact, and a
//                    miss is still a warning shot across its bow; enough of
//                    either breaks its approach (its `nerve`). Every shot tells
//                    every ship around where we are.
//   shots    what is in the air: our rounds on their way to a contact, and a
//            contact's rounds (or a drone's zaps) on their way to us. Theirs
//            land on one of our rooms through the S2.2 hit code (applyHit).
//
// Jumping away needs a sensor fix (D-087): sensors with power and someone at
// the helm take it, every hit we take and every round we fire knocks it back.

import { FIRE_CATCH_O2, FIRE_START, harmCrew } from './atmosphere.js';
import { isHome } from './crew.js';
import { bars, rating, running } from './stations.js';
import { stepPower } from './power.js';
import { FLARE, NOISE, bang, flare } from './senses.js';
import { contactView, findContact, pdShot, pdTarget, shotAt, struck } from './encounters.js';

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
/** What a hit does besides hull points. Starting values, to tune from the bot's report (DF-34). */
export const HIT = Object.freeze({
  wearBreach: 0.6, // extra breach chance per unit of the room's hull integrity already lost
  breachPerDamage: 0.3, // size of the hole per point of damage
  crewHarmPerDamage: 0.2, // health taken from someone caught in the room, per point of damage
});
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
/**
 * A jump needs a sensor fix (D-074): `seconds` of the sensors and the helm both run by the book, quicker with a
 * pilot at the helm or a trained hand on the sensors (their ratings multiply, stations.js).
 * A hit on the ship knocks `hit` off the fix and each round we fire `shot`; with the sensors or the helm dark it drains away.
 */
export const FIX = Object.freeze({ seconds: 25, hit: 0.25, shot: 0.1, drain: 0.05 });
/** Money aboard at the start, until runs and contracts set it (Stage 3). */
export const START_MONEY = 120;

/**
 * The deterrent gun (D-173). A round lands with chance `hit`, times `floor` plus the rest of the return's
 * quality (a poor return is a poor aim), less up to `far` of it at the edge of the gun's range. It is in the
 * air for the weapon's flight plus `flightPerUnit` seconds a scope unit. A hit puts `fear.hit` into the
 * contact and a miss `fear.miss`; at the contact's `nerve` it breaks off. Firing lights us up by `flare`
 * on top of the gun's own flash, and costs `standing` with the faction of a ship that answers to one.
 */
export const GUN = Object.freeze({ hit: 0.85, floor: 0.35, far: 0.5, flightPerUnit: 0.08, fear: Object.freeze({ hit: 1, miss: 0.35 }), flare: 0.35, standing: -2 });
/** Point defence (D-174): each charged burst downs what it is aimed at with chance `hit`, and `edge` more for each point the guns' station is rated over the book (a gunner on it), less under. */
export const PD = Object.freeze({ hit: 0.45, edge: 0.6 });
/** What a carrier's drones spit at our hull (S2.5, D-097; content/weapons/). */
export const DRONE_WEAPON = 'drone-zap';

const MAX_SHOTS = 64;
const EPS = 1e-9;
const TICKS = 20;

// ---------- reading the ship ----------

/** The most the capacitor can hold: one unit per working bar of the shields while their station runs (none on a wreck). */
export const capacity = (ship) => (ship.state.hull.points === 0 ? 0 : bars(ship, 'shields'));
/** The capacitor as a fraction of what it can hold, 0 to 1. */
export const capacitorOf = (ship) => (capacity(ship) > 0 ? Math.min(1, ship.state.shield.charge / capacity(ship)) : 0);
/** Is a brace up? */
export const braced = (ship) => ship.state.shield.field > EPS;
/** Why this ship cannot brace now, or null. */
export function whyNoBrace(ship) {
  if (braced(ship)) return 'already braced';
  if (capacity(ship) === 0) return 'the shields are dark';
  if (ship.state.shield.charge < BRACE.min - EPS) return `the capacitor is at ${Math.floor(capacitorOf(ship) * 100)}%: a brace needs a full bar`;
  return null;
}
/** Loaded and ready to go: a gun that needs no rounds always is. */
export const hasRounds = (ship, slot) => ship.state.weapons[slot].rounds === null || ship.state.weapons[slot].rounds > 0;
/** What a fitted weapon is for: 'pd' (point defence, automatic) or 'gun' (the deterrent gun, aimed at a contact). */
export const roleOf = (ship, slot) => (ship.catalog.weapon(ship.state.weapons[slot].id).role === 'pd' ? 'pd' : 'gun');
/** The slot of the deterrent gun, or -1 if none is fitted. */
export const gunSlot = (ship) => ship.state.weapons.findIndex((_, index) => roleOf(ship, index) === 'gun');
/** The slot of the point-defence mount, or -1 if none is fitted. */
export const pdSlot = (ship) => ship.state.weapons.findIndex((_, index) => roleOf(ship, index) === 'pd');

/** Does anyone have the helm: a pilot posted to it, or Margo? A boarder standing there flies nothing. */
export const hasPilot = (ship) => running(ship, 'helm');

/** Which mounts are live, by slot: all of them while the guns' station runs, none while it is dark. */
export function weaponsPowered(ship) {
  const live = running(ship, 'weapons');
  return ship.state.weapons.map(() => live);
}

/** How well the sensors are working on a fix: their station's rating; a ship built without a sensors room has a fixed navigation set worth one. */
const fixBars = (ship) => (ship.state.systems.sensors.absent ? 1 : rating(ship, 'sensors'));
/** Can this ship take a sensor fix right now? Sensors running and the helm held. */
export const canFix = (ship) => fixBars(ship) > 0 && hasPilot(ship);
/** The sensor fix as a fraction, 0 to 1. */
export const fixOf = (ship) => Math.min(1, ship.state.fix);
/** Why this ship cannot jump this instant, or null: the fix, the helm, then the drive. */
export function whyNoJump(ship) {
  if (fixOf(ship) < 1) return fixBars(ship) > 0 ? `the sensor fix is at ${Math.floor(fixOf(ship) * 100)}%` : 'the sensors are dark and cannot take a fix';
  if (!hasPilot(ship)) return 'nobody has the helm';
  if (!running(ship, 'engines')) return 'the engines are stood down';
  return null;
}
/** A ship's own crew, alive and aboard it. */
export const livingCrew = (ship) => Object.values(ship.state.crew).filter((member) => member.alive && isHome(ship, member));

/** Find someone aboard, ours or a boarder: { member, ship }, or null. */
export function findCrew(sim, id) {
  const member = sim.state.crew[id];
  return member ? { member, ship: sim } : null;
}

/** Our crew, alive or dead, in roster order: [{ member, ship }]. */
export const ourCrew = (sim) =>
  Object.values(sim.state.crew)
    .filter((member) => member.owner === 'player')
    .sort((a, b) => a.index - b.index)
    .map((member) => ({ member, ship: sim }));

/** A weapon's charge as a fraction, 0 to 1. */
export const chargeOf = (ship, slot) => Math.min(1, ship.state.weapons[slot].charge / ship.catalog.weapon(ship.state.weapons[slot].id).charge);

/** The deterrent gun's chance of landing a round on a contact as things stand, 0 to 1, or 0 if it cannot fire on it. */
export function gunChance(sim, contact) {
  const slot = gunSlot(sim);
  if (slot < 0 || !contact) return 0;
  const weapon = sim.catalog.weapon(sim.state.weapons[slot].id);
  const range = Math.hypot(contact.x, contact.y);
  if (range > weapon.range) return 0;
  return Math.max(0, Math.min(1, GUN.hit * (GUN.floor + (1 - GUN.floor) * contact.track.q) * (1 - (GUN.far * range) / weapon.range)));
}

/** Why the deterrent gun cannot be laid on contact `id`, or null. */
export function whyNoGun(sim, id) {
  const slot = gunSlot(sim);
  if (slot < 0) return 'no gun is fitted';
  const contact = findContact(sim, id);
  if (!contact) return `no contact "${id}" on the scope`;
  if (contact.state === 'lost') return 'it is already breaking off';
  if (!contact.track.shown) return 'there is nothing on the scope to aim at';
  return null;
}

// ---------- state ----------

/** The fighting part of a new ship's state. */
export function newCombatState(layout, systems, catalog) {
  return {
    hull: { points: layout.hullPoints, max: layout.hullPoints },
    shield: { charge: (layout.power.down ?? []).includes('shields') || systems.shields.absent ? 0 : systems.shields.level, field: 0, until: 0 }, // a ship that starts with its shields stood to starts with the capacitor full
    // Heavy guns start with a full magazine; what is in the hold is for after.
    weapons: layout.weapons.map((id) => ({ id, charge: 0, target: null, powered: false, rounds: catalog.weapon(id).ammo?.magazine ?? null })),
    fix: 0, // the sensor fix a jump needs, 0 to 1 (FIX)
    shots: [], // in the air: { id, at: 'us' | 'contact', contact, weapon, room, born, lands, chance, warn, drone }
    nextShot: 1,
  };
}

/** Put a contact's round (or a drone's zap) in the air at us. It lands on one of our rooms, picked now. */
export function fireOn(sim, { contact, weapon, miss = 0, warn = false, drone = null }) {
  const { tick } = sim.state;
  if (sim.state.shots.length >= MAX_SHOTS) return null;
  const standing = sim.layout.rooms.filter((room) => !sim.state.rooms[room.id].jettisoned && room.kind !== 'lift');
  const room = sim.rng.stream('combat').pick(standing.length ? standing : sim.layout.rooms).id;
  const shot = { id: sim.state.nextShot++, at: 'us', contact, weapon, room, born: tick, lands: tick + Math.max(1, Math.round(sim.catalog.weapon(weapon).flight * TICKS)), chance: 1 - miss, warn, drone };
  sim.state.shots.push(shot);
  return shot;
}

// ---------- orders ----------

export const COMBAT_COMMANDS = {
  // Lay the deterrent gun on a contact (contact: its id), or hold fire (contact: null). Works paused, like every order.
  'gun.target': {
    check(sim, cmd) {
      if (cmd.contact === null) return gunSlot(sim) < 0 ? 'no gun is fitted' : sim.state.weapons[gunSlot(sim)].target === null ? 'the gun is not laid on anything' : null;
      return whyNoGun(sim, cmd.contact);
    },
    apply(sim, cmd) {
      const slot = gunSlot(sim);
      const state = sim.state.weapons[slot];
      if (state.target === cmd.contact) return;
      state.target = cmd.contact;
      sim.events.emit('weapon.targeted', { slot, weapon: state.id, contact: cmd.contact, tick: sim.state.tick });
    },
  },
  // Dump the shield capacitor into a brace: it soaks what lands in the next BRACE.seconds, and lights us up.
  'ship.brace': {
    check: (sim) => whyNoBrace(sim),
    apply: (sim) => brace(sim),
  },
  // Debug panel only: a shot lands on us at once. room: one of ours, or null for any; weapon: what it is;
  // force: true to make it a hit whatever the brace says. (`at` must be 'us': there is nobody else to hit.)
  'debug.hit': {
    check(sim, cmd) {
      if (cmd.at !== undefined && cmd.at !== 'us') return 'at must be "us": there is no other ship to hit';
      if (!sim.catalog.hasWeapon(cmd.weapon)) return `no weapon "${cmd.weapon}"`;
      if (cmd.room === null || cmd.room === undefined) return null;
      const room = sim.state.rooms[cmd.room];
      if (!room) return `no room "${cmd.room}"`;
      if (room.jettisoned) return 'that section is gone';
      return null;
    },
    apply(sim, cmd) {
      let room = cmd.room ?? null;
      if (room === null) {
        const standing = sim.layout.rooms.filter((r) => !sim.state.rooms[r.id].jettisoned);
        if (!standing.length) return;
        room = sim.rng.stream('combat').pick(standing).id;
      }
      landOnUs(sim, { id: sim.state.nextShot++, at: 'us', contact: null, weapon: cmd.weapon, room, born: sim.state.tick, lands: sim.state.tick, chance: 1, warn: false, drone: null }, { force: Boolean(cmd.force) });
    },
  },
  // Debug panel and tests: fill every magazine (load), charge every weapon (charge), or money for a bribe.
  'debug.gun': {
    check: (sim, cmd) => (cmd.load === true || cmd.charge === true || cmd.money === true ? null : 'needs load, charge or money'),
    apply(sim, cmd) {
      if (cmd.money) sim.state.money += 100;
      sim.state.weapons.forEach((slot) => {
        const weapon = sim.catalog.weapon(slot.id);
        if (cmd.load && weapon.ammo) slot.rounds = weapon.ammo.magazine;
        if (cmd.charge) slot.charge = weapon.charge;
      });
    },
  },
};

// ---------- each tick ----------

/** Dump the capacitor into a brace. Check whyNoBrace first. */
export function brace(ship) {
  const { shield } = ship.state;
  const { tick } = ship.state;
  shield.field = shield.charge;
  shield.charge = 0;
  shield.until = tick + Math.round(BRACE.seconds * TICKS);
  // A field going up is the brightest thing for a long way: anything out there sees it.
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
  else shield.charge = shield.charge >= max ? max : Math.min(max, shield.charge + (dt * stationPace(ship, ship.layout.roomOfSystem('shields')) * max * rating(ship, 'shields')) / CAPACITOR.seconds);
}

/** Charge the mounts; point defence shoots whatever is coming, and the gun fires on its contact. */
function stepWeapons(sim, dt) {
  const powered = weaponsPowered(sim);
  const gunRoom = sim.layout.roomOfSystem('weapons');
  // The mounts come ready at the rating of the guns' station: a gunner on it charges them faster (D-131, H.4).
  const run = rating(sim, 'weapons');
  const pace = stationPace(sim, gunRoom) * run;
  const { tick } = sim.state;
  sim.state.weapons.forEach((slot, index) => {
    const weapon = sim.catalog.weapon(slot.id);
    const role = roleOf(sim, index);
    const wasReady = slot.charge >= weapon.charge - EPS;
    slot.powered = powered[index] && sim.state.hull.points > 0;
    slot.charge = slot.powered ? Math.min(weapon.charge, slot.charge + dt * pace) : Math.max(0, slot.charge - dt * DISCHARGE_RATE);
    const ready = slot.charge >= weapon.charge - EPS;
    if (ready && !wasReady && role === 'gun') sim.events.emit('weapon.ready', { slot: index, weapon: slot.id, tick });
    if (role === 'gun' && slot.target !== null) {
      const on = findContact(sim, slot.target);
      if (!on || on.state === 'lost') {
        // It has gone (docked, left, broke off): the gun comes off it.
        slot.target = null;
        sim.events.emit('weapon.targeted', { slot: index, weapon: slot.id, contact: null, tick });
      }
    }
    if (!ready) return;

    if (role === 'pd') {
      const target = pdTarget(sim);
      if (!target) return;
      slot.charge = 0;
      const hit = sim.rng.stream('combat').chance(Math.max(0, Math.min(1, PD.hit + PD.edge * (run - 1))) * stationPace(sim, gunRoom));
      if (gunRoom) bang(sim, gunRoom.id, NOISE.gun * 0.5);
      sim.events.emit('pd.fired', { slot: index, target: target.kind, id: target.item.id, hit, tick });
      if (hit) pdShot(sim, target);
      return;
    }

    if (slot.target === null) return;
    const contact = findContact(sim, slot.target);
    const view = contactView(sim, contact);
    const range = Math.hypot(contact.x, contact.y);
    if (!view || view.stale || range > weapon.range || sim.state.shots.length >= MAX_SHOTS) return; // nothing to lay on, or out of reach: it holds
    // A heavy gun with nothing in the breech waits, charged, for someone to bring rounds up from the hold.
    if (slot.rounds !== null && slot.rounds < 1) {
      if (!slot.dry) {
        slot.dry = true;
        sim.events.emit('weapon.empty', { slot: index, weapon: slot.id, tick });
      }
      return;
    }
    slot.dry = false;
    if (slot.rounds !== null) slot.rounds -= 1;
    slot.charge = 0;
    const shot = { id: sim.state.nextShot++, at: 'contact', contact: contact.id, weapon: slot.id, room: null, born: tick, lands: tick + Math.max(1, Math.round((weapon.flight + range * GUN.flightPerUnit) * TICKS)), chance: gunChance(sim, contact), warn: false, drone: null };
    sim.state.shots.push(shot);
    // A gun going off is loud aboard, lights us up for everything out there, and shakes the sensor fix.
    if (gunRoom) bang(sim, gunRoom.id, NOISE.gun);
    flare(sim, FLARE.perBar * weapon.power + GUN.flare);
    sim.state.fix = Math.max(0, sim.state.fix - FIX.shot);
    sim.events.emit('weapon.fired', { slot: index, weapon: slot.id, contact: contact.id, chance: shot.chance, rounds: slot.rounds, lands: shot.lands, tick });
    shotAt(sim, contact);
  });
}

/**
 * What a hit does to the room it lands in. `ship` is the ship that was hit.
 * Every roll is made whatever the room holds, so a seed rolls the same dice
 * however things have gone. Returns what happened, for the shot's event.
 */
export function applyHit(sim, ship, roomId, weapon) {
  const dice = sim.rng.stream('combat');
  const room = ship.state.rooms[roomId];
  const { tick } = sim.state;
  const effects = { system: 0, fire: false, breach: false, crew: [] };
  const { hull } = ship.state;
  hull.points = Math.max(0, hull.points - weapon.damage);
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

/** A round or a zap lands on us: a warning shot, a miss, stopped by a brace, or a hit. `force` (debug only) makes it a hit. */
function landOnUs(sim, shot, { force = false } = {}) {
  const weapon = sim.catalog.weapon(shot.weapon);
  const room = sim.state.rooms[shot.room];
  const { shield } = sim.state;
  const cost = 1 + weapon.pierce; // a gun made to pierce takes more of a brace to stop
  const dice = sim.rng.stream('combat');
  const wide = !dice.chance(shot.chance);
  let result = 'hit';
  let effects = null;
  if (shot.warn && !force) result = 'warning';
  else if (!room || room.jettisoned || (wide && !force)) result = 'miss';
  else if (shield.field >= cost - EPS && !force) {
    result = 'shield';
    shield.field = Math.max(0, shield.field - cost);
  } else {
    if (!force) shield.field = 0; // what is left of a brace is not enough: it gives way, and the shot gets through
    effects = applyHit(sim, sim, shot.room, weapon);
  }
  sim.events.emit('shot.resolved', { id: shot.id, at: 'us', contact: shot.contact, drone: shot.drone, weapon: shot.weapon, room: shot.room, result, damage: result === 'hit' ? weapon.damage : 0, effects, tick: sim.state.tick });
  // A drone that flies its zap into a brace burns itself out.
  if (shot.drone !== null && result === 'shield') pdShot(sim, { kind: 'drone', item: { id: shot.drone } }, 'brace');
  if (result === 'hit' && sim.state.hull.points === 0) sim.events.emit('ship.wrecked', { tick: sim.state.tick });
}

/**
 * Something strikes the hull out of a hazard lane (H.6): `weapon` (a content weapon such as "debris") lands now
 * on a room picked at random. A brace stops it like a round; nobody aimed it, so it never misses.
 */
export function strike(sim, weapon) {
  const standing = sim.layout.rooms.filter((room) => !sim.state.rooms[room.id].jettisoned);
  if (!standing.length || !sim.catalog.hasWeapon(weapon)) return;
  const room = sim.rng.stream('combat').pick(standing).id;
  landOnUs(sim, { id: sim.state.nextShot++, at: 'us', contact: null, weapon, room, born: sim.state.tick, lands: sim.state.tick, chance: 1, warn: false, drone: null });
}

/** Our round lands near a contact: a hit, or a warning shot across its bow. Either way it is a message. */
function landOnContact(sim, shot) {
  const contact = findContact(sim, shot.contact);
  const hit = Boolean(contact) && contact.state !== 'lost' && sim.rng.stream('combat').chance(shot.chance);
  sim.events.emit('shot.resolved', { id: shot.id, at: 'contact', contact: shot.contact, weapon: shot.weapon, result: hit ? 'hit' : 'miss', tick: sim.state.tick });
  if (contact && contact.state !== 'lost') struck(sim, contact, hit);
}

/**
 * The sensors work on a fix while they have power and someone is at the helm; otherwise it slips away.
 * The fix is the run into port at the end of a crossing (sector.js), which names its own events.
 */
export function stepFix(ship, dt, { ready = 'fix.ready', lost = 'fix.lost' } = {}) {
  const before = ship.state.fix;
  const helm = helmOf(ship);
  const pilot = rating(ship, 'helm'); // a pilot at the helm takes the fix faster than Margo does (D-131, H.4)
  ship.state.fix = canFix(ship) ? Math.min(1, before + (dt * stationPace(ship, helm) * pilot * fixBars(ship)) / FIX.seconds) : Math.max(0, before - FIX.drain * dt);
  if (before < 1 && ship.state.fix >= 1) ship.events.emit(ready, { tick: ship.state.tick });
  if (before >= 1 && ship.state.fix < 1) ship.events.emit(lost, { tick: ship.state.tick });
}

/** The brace, the mounts, and whatever is in the air. */
export function stepCombat(sim, dt) {
  stepShield(sim, dt);
  stepWeapons(sim, dt);
  const { tick } = sim.state;
  if (!sim.state.shots.length) return;
  const flying = [];
  for (const shot of sim.state.shots) {
    if (tick < shot.lands) flying.push(shot);
    else if (shot.at === 'us') landOnUs(sim, shot);
    else landOnContact(sim, shot);
  }
  sim.state.shots = flying;
}

// ---------- invariants ----------

/** Problems with the guns, the brace and the shots that should never happen. */
export function checkCombatInvariants(ship) {
  const problems = [];
  const { hull, shield, weapons, systems, shots } = ship.state;
  if (!Number.isInteger(hull.points) || hull.points < 0 || hull.points > hull.max) problems.push(`hull is ${hull.points} of ${hull.max}`);
  if (!(shield.charge >= 0 && shield.charge <= systems.shields.level + EPS)) problems.push(`shield charge is ${shield.charge} with a level ${systems.shields.level} system`);
  if (!(shield.field >= 0 && shield.field <= systems.shields.level + EPS)) problems.push(`brace field is ${shield.field} with a level ${systems.shields.level} system`);
  if (shield.field > 0 && ship.state.tick > shield.until) problems.push(`a brace is still up after tick ${shield.until}`);
  if (!(ship.state.fix >= 0 && ship.state.fix <= 1 + EPS)) problems.push(`the sensor fix is ${ship.state.fix}`);
  if (weapons.length > ship.layout.hardpoints.length) problems.push(`${weapons.length} weapons on ${ship.layout.hardpoints.length} hardpoints`);
  weapons.forEach((slot, index) => {
    const weapon = ship.catalog.weapon(slot.id);
    if (!(slot.charge >= 0 && slot.charge <= weapon.charge + EPS)) problems.push(`weapon ${index} charge is ${slot.charge} of ${weapon.charge}`);
    // A gun is laid on a contact or on nothing: no weapon has a room of anybody's to aim at (H.3).
    if (slot.target !== null && (!Number.isInteger(slot.target) || roleOf(ship, index) !== 'gun')) problems.push(`weapon ${index} is aimed at "${slot.target}"`);
    if (slot.rounds !== null && !(Number.isInteger(slot.rounds) && slot.rounds >= 0 && slot.rounds <= (weapon.ammo?.magazine ?? 0))) problems.push(`weapon ${index} holds ${slot.rounds} rounds`);
  });
  if (shots.length > MAX_SHOTS) problems.push(`${shots.length} shots in the air`);
  for (const shot of shots) {
    if (!(shot.lands > shot.born)) problems.push(`shot ${shot.id} lands at ${shot.lands}, fired at ${shot.born}`);
    if (shot.lands < ship.state.tick) problems.push(`shot ${shot.id} should have landed at tick ${shot.lands}`);
    if (!['us', 'contact'].includes(shot.at)) problems.push(`shot ${shot.id} is aimed at "${shot.at}"`);
    if (shot.at === 'us' && !ship.state.rooms[shot.room]) problems.push(`shot ${shot.id} is coming down on a room that does not exist: "${shot.room}"`);
  }
  if (!(ship.state.money >= 0) || !Number.isInteger(ship.state.money)) problems.push(`money is ${ship.state.money}`);
  return problems;
}
