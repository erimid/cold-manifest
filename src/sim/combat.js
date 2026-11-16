// Ship-to-ship fighting (brief §7). DOM-free.
//
// A fight is the player's ship against one enemy ship. The enemy is a whole
// ship of its own: the same rooms, doors, systems, air and fire, stepped by
// the same code, held in `state.fight.enemy`. `enemyOf(sim)` wraps that state
// so every function written for "a ship" works on either side.
//
// Each ship has:
//   hull     { points, max }: at 0 the ship breaks up
//   shield   { charge }: whole numbers are layers that are up. Each layer
//            stops one shot, then recharges. The most a ship can hold is the
//            power routed to its shields system.
//   weapons  one per fitted hardpoint: { id, charge, target, powered }.
//            The weapons system's bars go to weapons in hardpoint order; a
//            weapon with its bars charges, one without loses its charge.
//
// A charged weapon with a target fires by itself and starts charging again.
// The shot is in the air for the weapon's flight time, then lands: it misses
// (the target's evasion), is stopped by a shield layer, or hits.
//
// A hit (S2.2) takes hull points and wears the room it lands in. Then, rolled
// on the `combat` stream: it breaks a bar of the room's system for every point
// of damage, may start a fire, may hole the hull (more likely the more worn the
// room already is), and may hurt each person standing there. Fires and breaches
// are only set on the room; from then on the Stage 1 hazard code (atmosphere.js)
// runs them exactly as it runs any other fire or breach.

import { FIRE_CATCH_O2, FIRE_START, harmCrew } from './atmosphere.js';
import { stepPower } from './power.js';

export const SHIELD_RECHARGE_SECONDS = 6;
/** Chance a shot misses: nothing with the engines off, then a base, more per engine bar, more with someone at the helm. */
export const EVASION = Object.freeze({ base: 0.05, perBar: 0.06, pilot: 0.08, max: 0.45 });
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
const MAX_SHOTS = 64;
const EPS = 1e-9;

// ---------- reading a ship ----------

/** Shield layers that are up right now. */
export const shieldLayers = (ship) => Math.floor(ship.state.shield.charge + EPS);
/** The most layers the ship can hold: one per bar routed to shields. */
export const shieldMax = (ship) => ship.state.systems.shields.power;

/** Is someone alive at the helm? */
export function hasPilot(ship) {
  const helm = ship.layout.rooms.find((room) => room.kind === 'helm');
  return Boolean(helm) && Object.values(ship.state.crew).some((member) => member.alive && member.room === helm.id);
}

/** The chance, 0 to 1, that a shot at this ship misses. */
export function evasion(ship) {
  const bars = ship.state.systems.engines.power;
  if (bars === 0) return 0;
  return Math.min(EVASION.max, EVASION.base + EVASION.perBar * bars + (hasPilot(ship) ? EVASION.pilot : 0));
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

/** A weapon's charge as a fraction, 0 to 1. */
export const chargeOf = (ship, slot) => Math.min(1, ship.state.weapons[slot].charge / ship.catalog.weapon(ship.state.weapons[slot].id).charge);

// ---------- state ----------

/** The fighting part of a new ship's state. */
export function newCombatState(layout, systems) {
  return {
    hull: { points: layout.hullPoints, max: layout.hullPoints },
    shield: { charge: systems.shields.power }, // a ship that starts with shields powered starts with them up
    weapons: layout.weapons.map((id) => ({ id, charge: 0, target: null, powered: false })),
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
      // What happens aboard the enemy is announced apart from the player's ship, so alarms and the AI are not fooled.
      events: { emit: (type, payload) => sim.events.emit(`enemy.${type}`, payload) },
      get state() {
        return sim.state.fight.enemy;
      },
    };
    contexts.set(sim, ship);
  }
  return ship;
}

function clearTargets(ship) {
  for (const slot of ship.state.weapons) slot.target = null;
}

/** Begin a fight with an enemy ship from the catalog. `newShipState` comes from sim.js. */
export function startFight(sim, enemyId, newShipState) {
  const layout = sim.catalog.layout(enemyId);
  sim.state.fight = {
    enemy: { ship: layout.id, tick: sim.state.tick, ...newShipState(layout, []) },
    shots: [], // in the air: { id, side, slot, weapon, room, born, lands }
    nextShot: 1,
    started: sim.state.tick,
    over: null, // { outcome: 'destroyed' | 'lost', tick } once it is decided
  };
  sim.events.emit('fight.started', { enemy: layout.id, name: layout.name, tick: sim.state.tick });
}

export function endFight(sim) {
  clearTargets(sim);
  sim.state.fight = null;
  sim.events.emit('fight.ended', { tick: sim.state.tick });
}

// ---------- orders ----------

export function combatCommands(newShipState) {
  return {
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
        return null;
      },
      apply(sim, cmd) {
        const slot = sim.state.weapons[cmd.slot];
        if (slot.target === cmd.room) return;
        slot.target = cmd.room;
        sim.events.emit('weapon.targeted', { slot: cmd.slot, weapon: slot.id, room: cmd.room, tick: sim.state.tick });
      },
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

function stepShield(ship, dt) {
  const { shield } = ship.state;
  const max = ship.state.hull.points === 0 ? 0 : shieldMax(ship); // a wreck holds no shield
  shield.charge = shield.charge >= max ? max : Math.min(max, shield.charge + dt / SHIELD_RECHARGE_SECONDS);
}

function stepWeapons(sim, ship, side, dt) {
  const fight = sim.state.fight;
  const powered = weaponsPowered(ship);
  ship.state.weapons.forEach((slot, index) => {
    const weapon = ship.catalog.weapon(slot.id);
    const wasReady = slot.charge >= weapon.charge - EPS;
    slot.powered = powered[index];
    slot.charge = slot.powered ? Math.min(weapon.charge, slot.charge + dt) : Math.max(0, slot.charge - dt * DISCHARGE_RATE);
    const ready = slot.charge >= weapon.charge - EPS;
    if (ready && !wasReady && side === 'player') sim.events.emit('weapon.ready', { slot: index, weapon: slot.id, tick: sim.state.tick });
    if (!ready || slot.target === null || !fight || fight.over || fight.shots.length >= MAX_SHOTS) return;
    slot.charge = 0;
    const shot = { id: fight.nextShot++, side, slot: index, weapon: slot.id, room: slot.target, born: sim.state.tick, lands: sim.state.tick + Math.max(1, Math.round(weapon.flight * 20)) };
    fight.shots.push(shot);
    sim.events.emit('weapon.fired', { ...shot, tick: sim.state.tick });
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
  room.hull = Math.max(0, room.hull - ROOM_HULL_PER_DAMAGE * weapon.damage);

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
  const dodged = sim.rng.stream('combat').chance(evasion(target));
  if (!room || room.jettisoned || (dodged && !force)) result = 'miss';
  else if (shieldLayers(target) > weapon.pierce && !force) {
    result = 'shield';
    target.state.shield.charge = Math.max(0, target.state.shield.charge - 1);
  } else effects = applyHit(sim, target, shot.room, weapon);
  sim.events.emit('shot.resolved', { id: shot.id, side: shot.side, slot: shot.slot, weapon: shot.weapon, room: shot.room, result, damage: result === 'hit' ? weapon.damage : 0, effects, tick: sim.state.tick });
  if (fight && target.state.hull.points === 0 && !fight.over) {
    fight.over = { outcome: shot.side === 'player' ? 'destroyed' : 'lost', tick: sim.state.tick };
    sim.events.emit('fight.over', { ...fight.over, enemy: fight.enemy.ship });
  }
}

/** Shields, weapons and shots in the air, for both ships. */
export function stepCombat(sim, dt) {
  const enemy = enemyOf(sim);
  stepShield(sim, dt);
  stepWeapons(sim, sim, 'player', dt);
  if (!enemy) return;
  stepShield(enemy, dt);
  stepWeapons(sim, enemy, 'enemy', dt);
  const fight = sim.state.fight;
  const flying = [];
  for (const shot of fight.shots) {
    if (fight.over) break; // it is decided: whatever was in the air is lost in the wreckage
    if (sim.state.tick >= shot.lands) land(sim, shot);
    else flying.push(shot);
  }
  fight.shots = fight.over ? [] : flying;
  if (fight.over) {
    clearTargets(sim);
    clearTargets(enemy);
  }
}

// ---------- invariants ----------

/** Fighting problems aboard one ship that should never happen. */
export function checkCombatInvariants(ship, foe = null) {
  const problems = [];
  const { hull, shield, weapons, systems } = ship.state;
  if (!Number.isInteger(hull.points) || hull.points < 0 || hull.points > hull.max) problems.push(`hull is ${hull.points} of ${hull.max}`);
  if (!(shield.charge >= 0 && shield.charge <= systems.shields.level + EPS)) problems.push(`shield charge is ${shield.charge} with a level ${systems.shields.level} system`);
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
  return problems;
}
