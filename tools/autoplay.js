#!/usr/bin/env node
// Headless autoplay (brief §19). Run with: npm run autoplay -- --runs 100
//
// A bot plays seeded runs of the simulation with no browser, through the same
// clock and command queue a player uses. A crash, a broken invariant, a stuck
// state, anything changing while paused, or a run that does not replay
// identically from its seed is a failure.
//
//   --runs N       how many seeded runs (default 100)
//   --minutes M    game minutes per run (default 10)
//   --seed S       base seed; run i uses "S-i" (default "auto")
//   --ship ID      ship layout to fly (default "margin-of-error")
//
//   --report FILE  also write the report to FILE as Markdown
//
// Autoplay v1 (end of Stage 1) plays every seed twice over (S2.1 and S2.2 add modes below):
//   chaos      a bot that does everything at random, to find crashes
//   scenario   a seeded emergency (fires and breaches) and a bot that tries
//              to save the ship, to see whether the tools work
//   under fire shots land on the ship for two minutes and do what hits do
//              (S2.2); the same bot then has three minutes to clean up
//   duels      every enemy in turn against a bot that fights (S2.3; it replaced
//              S2.1's target practice), and fights off boarders (S2.4)
//   boarding   every crewed enemy again, with the bot sending its own boarding
//              party once their shields are down (S2.4)
//
// Chaos: the bot sends three crew around the ship to deal with whatever is
// worst, suits them up for breaches, works doors, airlocks and lights, routes
// power, starts fires and breaches, breaks systems and jams doors through the
// debug commands, now and then jettisons a room, and pauses at random. Its strategy and the
// report grow stage by stage (PLAN.md §4).

import { createClock } from '../src/engine/clock.js';
import { createContent } from '../src/engine/content.js';
import { findBadNumbers, hashState } from '../src/engine/hash.js';
import { createRng } from '../src/engine/rng.js';
import { POWERED, used, supply } from '../src/sim/power.js';
import { BOARD_SECONDS } from '../src/sim/boarding.js';
import { DEBUG_ACTIONS, OUTCOMES, chargeOf, enemyOf, ourCrew } from '../src/sim/combat.js';
import { MANUAL_DOOR_SECONDS, TICK_RATE, TICK_SECONDS, checkInvariants, createSim } from '../src/sim/sim.js';
import { writeFileSync } from 'node:fs';

import { readContentFiles } from './lib/load-content.js';

function option(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const runs = Number(option('runs', 100));
const minutes = Number(option('minutes', 10));
const baseSeed = String(option('seed', 'auto'));
if (!Number.isInteger(runs) || runs <= 0 || !(minutes > 0)) {
  console.error('Usage: node tools/autoplay.js [--runs N] [--minutes M] [--seed S] [--ship ID]');
  process.exit(2);
}
const ticks = Math.round(minutes * 60 * TICK_RATE);

const content = createContent(readContentFiles());
const shipId = String(option('ship', 'margin-of-error'));
const ship = content.require('ships', shipId);
const roster = content.all('crew').map(({ id, name }) => ({ id, name }));
const lines = content.all('ai-lines');
const weapons = content.all('weapons');
const ships = content.all('ships');

/** The longest anyone should stand still with somewhere to be: a hand-worked door, with a wide margin. */
const MAX_STILL_TICKS = 200;

/** The longest anyone may spend boarding, from the order to coming out the other side: a long walk, a wait, the tube. */
const MAX_BOARDING_TICKS = (60 + BOARD_SECONDS) * TICK_RATE;

/** The longest a door can take to finish moving, plus a margin. Longer means stuck. */
const MAX_DOOR_TICKS = Math.ceil(MANUAL_DOOR_SECONDS * TICK_RATE) + 3;

/** Play one run to the end. Returns its stats, or throws on any failure. */
function playRun(seed) {
  const sim = createSim({ seed, ship, crew: roster, lines, weapons, ships });
  const clock = createClock({ sim, tickSeconds: TICK_SECONDS });
  // The bot's own dice, kept apart from the sim's so its choices are not part of the game state.
  const bot = createRng(`bot:${seed}`);
  const endings = {}; // how chaos fights ended, by outcome
  const stats = { orders: 0, refused: 0, dropped: 0, doorMoves: 0, pauses: 0, powerMoves: 0, brownouts: 0, darkTicks: 0, fires: 0, spreads: 0, firesOut: 0, scorched: 0, jettisons: 0, airlessTicks: 0, moves: 0, arrivals: 0, blocked: 0, deaths: 0, firesFought: 0, patches: 0, repairs: 0, fights: 0, shots: 0, hits: 0, absorbed: 0, missed: 0, kills: 0, boarded: 0, boardedUs: 0, melee: 0, captured: 0 };
  const watch = stuckWatch(sim);
  const movingSince = new Map(); // door id -> tick its last order was applied

  sim.events.on('door.changed', ({ door, tick }) => movingSince.set(door, tick));
  sim.events.on('door.opened', ({ door }) => {
    stats.doorMoves += 1;
    movingSince.delete(door);
  });
  sim.events.on('door.closed', ({ door }) => {
    stats.doorMoves += 1;
    movingSince.delete(door);
  });
  sim.events.on('command.dropped', () => (stats.dropped += 1));
  sim.events.on('power.changed', ({ reason }) => reason === 'order' && (stats.powerMoves += 1));
  sim.events.on('power.brownout', () => (stats.brownouts += 1));
  sim.events.on('fire.started', ({ cause }) => (cause === 'spread' ? (stats.spreads += 1) : (stats.fires += 1)));
  sim.events.on('fire.out', () => (stats.firesOut += 1));
  sim.events.on('system.damage', ({ cause }) => cause === 'fire' && (stats.scorched += 1));
  sim.events.on('room.jettisoned', () => (stats.jettisons += 1));
  sim.events.on('crew.ordered', () => (stats.moves += 1));
  sim.events.on('crew.arrived', () => (stats.arrivals += 1));
  sim.events.on('crew.blocked', () => (stats.blocked += 1));
  sim.events.on('crew.died', () => (stats.deaths += 1));
  sim.events.on('fire.out', ({ by }) => by && (stats.firesFought += 1));
  sim.events.on('breach.sealed', () => (stats.patches += 1));
  sim.events.on('system.repaired', () => (stats.repairs += 1));
  sim.events.on('fight.started', () => (stats.fights += 1));
  sim.events.on('crew.boarded', () => (stats.boarded += 1));
  sim.events.on('enemy.crew.boarded', () => (stats.boardedUs += 1));
  sim.events.on('crew.died', ({ cause }) => cause === 'melee' && (stats.melee += 1));
  sim.events.on('enemy.crew.died', ({ cause }) => cause === 'melee' && (stats.melee += 1));
  sim.events.on('crew.captured', () => (stats.captured += 1));
  sim.events.on('weapon.fired', () => (stats.shots += 1));
  sim.events.on('shot.resolved', ({ result }) => (stats[result === 'hit' ? 'hits' : result === 'shield' ? 'absorbed' : 'missed'] += 1));
  sim.events.on('fight.over', ({ outcome }) => {
    if (outcome === 'destroyed') stats.kills += 1;
    endings[outcome] = (endings[outcome] ?? 0) + 1;
  });

  /** Give an order the way a player would: only if the game would accept it. */
  function order(command) {
    if (sim.whyNot(command)) {
      stats.refused += 1;
      return;
    }
    sim.enqueue(command);
    stats.orders += 1;
  }

  /** The room that most needs someone: fire, then a breach, then damage. Sometimes just anywhere. */
  function troubleSpot() {
    const rooms = sim.layout.rooms.filter((room) => !sim.state.rooms[room.id].jettisoned);
    if (bot.chance(0.25)) return bot.pick(rooms);
    const score = (room) => {
      const r = sim.state.rooms[room.id];
      const system = room.system ? sim.state.systems[room.system] : null;
      return r.fire * 3 + r.breach * 2 + (system && !system.lost ? system.damage : 0);
    };
    const worst = rooms.reduce((a, b) => (score(b) > score(a) ? b : a));
    return score(worst) > 0 ? worst : bot.pick(rooms);
  }

  function crewAct() {
    const alive = ourCrew(sim).filter(({ member }) => member.alive);
    if (!alive.length) return;
    const { member, ship: aboard } = bot.pick(alive);
    if (bot.chance(0.15)) return order({ type: 'crew.suit', crew: member.id, on: !member.suit });
    // In a fight, now and then: over to their ship, or back home.
    const enemy = enemyOf(sim);
    if (enemy && bot.chance(0.2)) {
      const there = bot.chance(0.6) ? enemy : sim;
      const rooms = there.layout.rooms.filter((room) => !there.state.rooms[room.id].jettisoned);
      if (rooms.length) return order({ type: 'crew.move', crew: member.id, room: bot.pick(rooms).id, ship: there === sim ? 'us' : 'them' });
    }
    if (aboard !== sim) return;
    const room = troubleSpot();
    if (sim.state.rooms[room.id].breach > 0 && !member.suit) order({ type: 'crew.suit', crew: member.id, on: true });
    order({ type: 'crew.move', crew: member.id, room: room.id });
  }

  /** Pick a fight, aim at things, set fire to the other ship, walk away: in no sensible order. */
  function fightAct() {
    const fight = sim.state.fight;
    if (!fight) return order({ type: 'debug.fight', enemy: bot.pick(sim.catalog.enemies) });
    if (fight.over) return order({ type: bot.chance(0.7) ? 'fight.dismiss' : 'debug.fight', enemy: null });
    const roll = bot.next();
    const enemyRooms = Object.keys(fight.enemy.rooms);
    if (roll < 0.7) return order({ type: 'weapon.target', slot: bot.between(0, sim.state.weapons.length), room: bot.chance(0.85) ? bot.pick(enemyRooms) : null });
    if (roll < 0.9) return order({ type: 'power.add', system: bot.pick(['weapons', 'shields', 'engines']), delta: 1 });
    if (roll < 0.93) {
      // Answer whatever is being asked, push toward an ending, or try to leave.
      const pick = bot.pick(['fight.talk', 'fight.bribe', 'fight.engage', 'fight.accept', 'fight.refuse', 'ship.jump', 'debug.combat', 'debug.combat']);
      return order(pick === 'debug.combat' ? { type: pick, action: bot.pick(DEBUG_ACTIONS) } : { type: pick });
    }
    if (roll < 0.97) {
      // A shot out of nowhere, on either ship, through the debug panel.
      return order({ type: 'debug.hit', at: bot.chance(0.5) ? 'us' : 'them', room: null, weapon: bot.pick(weapons).id, force: bot.chance(0.5) });
    }
    return order({ type: 'debug.fight', enemy: null });
  }

  function act() {
    if (bot.chance(0.3)) return crewAct();
    if (bot.chance(0.25)) return fightAct();
    const roll = bot.next();
    if (roll < 0.25) {
      // Like a player, it wants the doors working: half the time it tries to get door control back first.
      if (sim.state.systems.doors.power === 0 && bot.chance(0.5)) {
        order({ type: 'debug.system', system: 'doors', damage: 0 });
        if (!sim.whyNot({ type: 'power.add', system: 'doors', delta: 1 })) order({ type: 'power.add', system: 'doors', delta: 1 });
        else order({ type: 'power.add', system: bot.pick(POWERED.filter((id) => id !== 'doors')), delta: -1 });
      } else order({ type: 'power.add', system: bot.pick(POWERED), delta: bot.chance(0.55) ? 1 : -1 });
    } else if (roll < 0.32) {
      const system = bot.pick(Object.keys(sim.state.systems));
      order({ type: 'debug.system', system, damage: bot.chance(0.5) ? 0 : bot.between(0, sim.state.systems[system].level) });
    } else if (roll < 0.6) {
      order({ type: 'door.set', door: bot.pick(sim.layout.doors).id, state: bot.pick(['open', 'closed', 'locked']) });
    } else if (roll < 0.85) {
      order({ type: 'room.lights', room: bot.pick(sim.layout.rooms).id, on: bot.chance(0.5) });
    } else if (roll < 0.95) {
      const door = bot.pick(sim.layout.doors).id;
      order({ type: 'debug.door', door, jammed: sim.state.doors[door].state !== 'jammed' });
    } else if (roll < 0.985) {
      // Trouble: usually a fire or a breach, sometimes both, and sometimes it gets patched.
      const set = bot.chance(0.3) ? { fire: 0, breach: 0 } : bot.chance(0.5) ? { fire: bot.next() } : { breach: bot.next() };
      order({ type: 'debug.room', room: bot.pick(sim.layout.rooms).id, set });
    } else {
      order({ type: 'room.jettison', room: bot.pick(sim.layout.rooms).id });
    }
  }

  let pausedFor = 0;
  let pausedHash = null;

  // One frame per tick: the bot sees and acts exactly as often as the sim steps.
  while (sim.state.tick < ticks) {
    // The bot gives an order now and then, paused or not.
    if (bot.chance(0.05)) {
      act();
      if (clock.paused) pausedHash = hashState(sim.snapshot()); // the queue may have grown; that is allowed
    }

    if (clock.paused) {
      const ran = clock.advance(TICK_SECONDS);
      if (ran !== 0) throw new Error(`clock ran ${ran} tick(s) while paused`);
      if (hashState(sim.snapshot()) !== pausedHash) throw new Error(`state changed while paused at tick ${sim.state.tick}`);
      if (--pausedFor <= 0) clock.resume();
      continue;
    }

    clock.advance(TICK_SECONDS);

    const problems = checkInvariants(sim);
    if (problems.length) throw new Error(`tick ${sim.state.tick}: ${problems.join('; ')}`);
    if (used(sim) > supply(sim)) throw new Error(`tick ${sim.state.tick}: ${used(sim)} bars in use of ${supply(sim)}`);
    if (sim.state.systems.doors.power === 0) stats.darkTicks += 1;
    for (const room of Object.values(sim.state.rooms)) if (!room.jettisoned && room.oxygen < 0.15) stats.airlessTicks += 1;
    watch();
    for (const [door, since] of movingSince) {
      const d = sim.state.doors[door];
      const settled = d.state === 'jammed' || d.openness === (d.state === 'open' ? 1 : 0);
      if (settled) movingSince.delete(door);
      else if (sim.state.tick - since > MAX_DOOR_TICKS) throw new Error(`${door} stuck: ${d.state} at ${d.openness} since tick ${since}, now ${sim.state.tick}`);
    }

    if (bot.chance(0.004)) {
      clock.pause('bot');
      pausedFor = bot.between(1, 60);
      pausedHash = hashState(sim.snapshot());
      stats.pauses += 1;
    }
  }

  const bad = findBadNumbers(sim.state);
  if (bad.length) throw new Error(`non-finite numbers at ${bad.join(', ')}`);
  stats.said = sim.state.ai.said;
  return { ...stats, endings, hash: hashState(sim.snapshot()) };
}

/**
 * Fail if anyone with somewhere to be has not moved for too long, on either
 * ship, or anyone has been boarding (walking to an airlock, waiting, in the
 * tube) for longer than MAX_BOARDING_TICKS. Call once a tick.
 */
function stuckWatch(sim) {
  const stillSince = new Map();
  const boardingSince = new Map();
  return () => {
    const enemy = enemyOf(sim);
    const { tick } = sim.state;
    for (const ship of enemy ? [sim, enemy] : [sim]) {
      for (const member of Object.values(ship.state.crew)) {
        const last = stillSince.get(member.id);
        if (!member.alive || !member.path.length || !last || last.side !== ship.side || last.x !== member.x || last.y !== member.y) {
          stillSince.set(member.id, { tick, side: ship.side, x: member.x, y: member.y });
        } else if (tick - last.tick > MAX_STILL_TICKS) {
          throw new Error(`${member.id} stuck on a path in ${member.room} aboard the ${ship.side} ship since tick ${last.tick} (${member.task}, next ${JSON.stringify(member.path[0])}${member.path[0]?.door ? `, door ${JSON.stringify(ship.state.doors[member.path[0].door])}` : ""})`);
        }
        if (!member.board) boardingSince.delete(member.id);
        else if (!boardingSince.has(member.id)) boardingSince.set(member.id, tick);
        else if (tick - boardingSince.get(member.id) > MAX_BOARDING_TICKS) throw new Error(`${member.id} has been boarding since tick ${boardingSince.get(member.id)} (${member.task} in ${member.room})`);
      }
    }
  };
}

const SCENARIO_MINUTES = 5;
/** Under fire: how long the shooting goes on before the bot gets the rest of the five minutes to clean up. */
const INCOMING_SECONDS = 120;
/** Which systems the scenario bot gives power back to first, after a repair or a brownout. */
const RESTORE_ORDER = ['life_support', 'ai_core', 'doors', 'engines', 'sensors', 'shields', 'medbay'];

/**
 * One seeded emergency: a few seconds in, one to three fires and up to two
 * breaches open at once. The bot plays to win: it sends free hands to the
 * worst room, suits them for breaches, pulls back anyone badly hurt, and
 * leaves the doors alone. Each second it gives power back to whatever was
 * running at the start, air first. Returns how it went, or throws on any failure.
 */
function playScenario(seed, { incoming = false } = {}) {
  const sim = createSim({ seed, ship, crew: roster, lines, weapons, ships });
  const bot = createRng(`${incoming ? 'incoming' : 'scenario'}:${seed}`);
  const watch = stuckWatch(sim);
  const rooms = bot.shuffle(sim.layout.rooms.map((room) => room.id));
  const fires = incoming ? [] : rooms.slice(0, bot.between(1, 3));
  const breaches = incoming ? [] : rooms.slice(3, 3 + bot.between(0, 2));
  const end = SCENARIO_MINUTES * 60 * TICK_RATE;
  let clearedAt = null;
  let worstFires = 0;
  // Under fire: shots land on the ship every few seconds until INCOMING_SECONDS, and do what hits do.
  const hits = { landed: 0, fires: 0, breaches: 0, bars: 0, hurt: 0 };
  const deaths = {};
  sim.events.on('crew.died', ({ cause }) => (deaths[cause] = (deaths[cause] ?? 0) + 1));
  let nextShot = 3 * TICK_RATE;
  sim.events.on('hull.hit', (event) => {
    hits.landed += 1;
    hits.fires += event.fire ? 1 : 0;
    hits.breaches += event.breach ? 1 : 0;
    hits.bars += event.system;
    hits.hurt += event.crew.length;
  });
  const lastShot = INCOMING_SECONDS * TICK_RATE;
  const startPower = Object.fromEntries(Object.entries(sim.state.systems).map(([id, system]) => [id, system.power]));

  const order = (command) => !sim.whyNot(command) && sim.enqueue(command);
  const trouble = (room) => {
    const r = sim.state.rooms[room.id];
    const system = room.system ? sim.state.systems[room.system] : null;
    return r.jettisoned ? 0 : r.fire * 3 + r.breach * 2 + (system && !system.lost ? system.damage * 0.5 : 0);
  };

  while (sim.state.tick < end) {
    if (incoming && sim.state.tick === nextShot && nextShot <= lastShot) {
      order({ type: 'debug.hit', at: 'us', room: null, weapon: bot.pick(weapons).id });
      nextShot += bot.between(6, 13) * TICK_RATE;
    }
    if (sim.state.tick === 3 * TICK_RATE) {
      for (const room of fires) order({ type: 'debug.room', room, set: { fire: bot.range(0.3, 0.8) } });
      for (const room of breaches) order({ type: 'debug.room', room, set: { breach: bot.range(0.2, 0.7) } });
    }
    // Once a second, the bot looks the ship over.
    if (sim.state.tick > 3 * TICK_RATE && sim.state.tick % TICK_RATE === 0) {
      // Power comes back to a repaired system only when someone routes it (D-030): air first.
      for (const id of RESTORE_ORDER) {
        if (sim.state.systems[id].power < startPower[id]) order({ type: 'power.add', system: id, delta: 1 });
      }
      const spots = sim.layout.rooms.filter((room) => trouble(room) > 0).sort((a, b) => trouble(b) - trouble(a));
      const taken = new Map();
      for (const member of Object.values(sim.state.crew)) {
        if (!member.alive) continue;
        const here = sim.layout.room(member.room);
        // Badly hurt: get out of danger and into the medbay.
        if (member.health < 0.35) {
          if (member.goal !== 'medbay' && member.room !== 'medbay') order({ type: 'crew.move', crew: member.id, room: 'medbay' });
          continue;
        }
        if (member.path.length || trouble(here) > 0) continue; // busy
        // Spread out: at most two to a room.
        const spot = spots.find((room) => (taken.get(room.id) ?? 0) < 2 && !sim.whyNot({ type: 'crew.move', crew: member.id, room: room.id }));
        if (!spot) continue;
        taken.set(spot.id, (taken.get(spot.id) ?? 0) + 1);
        const needsSuit = sim.state.rooms[spot.id].breach > 0;
        if (member.suit !== needsSuit) order({ type: 'crew.suit', crew: member.id, on: needsSuit });
        order({ type: 'crew.move', crew: member.id, room: spot.id });
      }
    }

    sim.step();
    const problems = checkInvariants(sim);
    if (problems.length) throw new Error(`tick ${sim.state.tick}: ${problems.join('; ')}`);
    watch();

    const burning = Object.values(sim.state.rooms).filter((r) => r.fire > 0).length;
    worstFires = Math.max(worstFires, burning);
    const holed = Object.values(sim.state.rooms).some((r) => r.breach > 0);
    if (sim.state.tick > (incoming ? lastShot : 3 * TICK_RATE + 1)) {
      if (!burning && !holed) clearedAt ??= sim.state.tick;
      else clearedAt = null;
    }
  }

  const bad = findBadNumbers(sim.state);
  if (bad.length) throw new Error(`non-finite numbers at ${bad.join(', ')}`);
  const crew = Object.values(sim.state.crew);
  return {
    fires: fires.length,
    breaches: breaches.length,
    cleared: clearedAt !== null,
    clearSeconds: clearedAt === null ? null : clearedAt / TICK_RATE - (incoming ? INCOMING_SECONDS : 3),
    hits,
    deaths,
    hull: sim.state.hull.points,
    worstFires,
    alive: crew.filter((member) => member.alive).length,
    damage: Object.values(sim.state.systems).reduce((sum, system) => sum + system.damage, 0),
    said: sim.state.ai.said,
    hash: hashState(sim.snapshot()),
  };
}

const DUEL_MINUTES = 8;
/** Rooms the duel bot keeps lit; the rest go dark to free a bar for shields (brief §6: lights draw power). */
const DUEL_LIT = ['bridge', 'weapons', 'shields', 'engines', 'reactor'];

/**
 * A duel: one enemy alongside, and a bot that fights it. It answers a hail
 * (mostly by shooting, sometimes by talking or paying), turns off the lights
 * it does not need, feeds guns, shields and engines, aims at their shields
 * and then their guns, keeps someone at the helm and sends the others to
 * trouble, takes most surrenders, and jumps out when the hull is low. Returns
 * how it ended, or throws on any failure, including a fight still going at
 * the end (the stalemate rule should make that impossible).
 */
function playDuel(seed, enemyId, { boarding = false } = {}) {
  const sim = createSim({ seed, ship, crew: roster, lines, weapons, ships });
  const bot = createRng(`duel:${boarding ? 'board:' : ''}${enemyId}:${seed}`);
  const end = DUEL_MINUTES * 60 * TICK_RATE;
  const watch = stuckWatch(sim);
  const tally = { shots: 0, hit: 0, shield: 0, miss: 0, incoming: 0, incomingHits: 0, offers: 0, hail: null, boarded: 0, boardedUs: 0, killedAboard: 0, lostAboard: 0, captured: 0 };
  sim.events.on('crew.boarded', ({ onto }) => onto === 'enemy' && (tally.boarded += 1));
  sim.events.on('enemy.crew.boarded', ({ onto }) => onto === 'player' && (tally.boardedUs += 1));
  sim.events.on('enemy.crew.died', ({ cause }) => cause === 'melee' && (tally.killedAboard += 1));
  sim.events.on('crew.died', ({ cause }) => cause === 'melee' && (tally.lostAboard += 1));
  sim.events.on('crew.captured', () => (tally.captured += 1));
  sim.events.on('shot.resolved', ({ side, result }) => {
    if (side === 'player') tally[result] += 1;
    else {
      tally.incoming += 1;
      if (result === 'hit') tally.incomingHits += 1;
    }
  });
  sim.events.on('weapon.fired', ({ side }) => side === 'player' && (tally.shots += 1));
  sim.events.on('fight.offer', () => (tally.offers += 1));
  const order = (command) => !sim.whyNot(command) && sim.enqueue(command);
  const answer = bot.next(); // how it answers a hail: talk, pay, or shoot
  const trouble = (room) => {
    const r = sim.state.rooms[room.id];
    const system = room.system ? sim.state.systems[room.system] : null;
    const boarders = Object.values(sim.state.crew).filter((member) => member.alive && member.owner === 'enemy' && member.room === room.id).length;
    return r.jettisoned ? 0 : boarders * 4 + r.fire * 3 + r.breach * 2 + (system && !system.lost ? system.damage * 0.5 : 0);
  };

  while (sim.state.tick < end && !sim.state.fight?.over) {
    const { tick } = sim.state;
    if (tick === TICK_RATE) order({ type: 'debug.fight', enemy: enemyId });
    const fight = sim.state.fight;
    if (fight && tick % TICK_RATE === 0) {
      const enemy = sim.state.fight.enemy;
      if (fight.phase === 'hail' && tick > 2 * TICK_RATE) {
        tally.hail = answer < 0.2 ? 'talk' : answer < 0.3 ? 'pay' : 'fight';
        if (tally.hail === 'talk') order({ type: 'fight.talk' });
        else if (tally.hail === 'pay' && !order({ type: 'fight.bribe' })) order({ type: 'fight.engage' });
        else order({ type: 'fight.engage' });
      }
      if (fight.offer) order({ type: bot.chance(0.75) ? 'fight.accept' : 'fight.refuse' });
      // Lights out where nobody needs them, then guns, shields and engines.
      for (const room of sim.layout.rooms) {
        if (!DUEL_LIT.includes(room.id) && sim.state.rooms[room.id].lightsOn) order({ type: 'room.lights', room: room.id, on: false });
      }
      for (const id of ['sensors', 'doors', 'medbay', 'ai_core']) if (sim.state.systems[id].power > 0) order({ type: 'power.add', system: id, delta: -1 });
      // One bar at a time, top of the list first: air, every gun, shields, then engines with what is left.
      const want = ['life_support', 'weapons', 'shields', 'engines'].find((id) => !sim.whyNot({ type: 'power.add', system: id, delta: 1 }) || (sim.state.systems[id].power < sim.state.systems[id].level - sim.state.systems[id].damage && id !== 'engines'));
      if (want) {
        if (sim.whyNot({ type: 'power.add', system: want, delta: 1 }) && want !== 'engines' && sim.state.systems.engines.power > 1) order({ type: 'power.add', system: 'engines', delta: -1 });
        else order({ type: 'power.add', system: want, delta: 1 });
      }
      // Their shields first; once those are broken, their guns.
      const shieldsDown = enemy.systems.shields.absent || enemy.systems.shields.damage >= enemy.systems.shields.level;
      const aim = shieldsDown && enemy.rooms.weapons ? 'weapons' : enemy.rooms.shields ? 'shields' : bot.pick(Object.keys(enemy.rooms));
      // Hold fire until every powered gun is charged, then fire them together.
      const guns = sim.state.weapons.map((slot, index) => ({ slot, index })).filter(({ slot }) => slot.powered);
      const volley = guns.length > 0 && guns.every(({ index }) => chargeOf(sim, index) >= 1);
      for (const { slot, index } of guns) {
        const want = volley ? aim : null;
        if (slot.target !== want) order({ type: 'weapon.target', slot: index, room: want });
      }
      // Get out if it is going badly.
      if (sim.state.hull.points <= sim.state.hull.max * 0.3) order({ type: 'ship.jump' });
      // Crew: the first stays at the helm, the others go to the worst trouble: boarders first.
      const crew = ourCrew(sim).filter(({ member }) => member.alive);
      const spots = sim.layout.rooms.filter((room) => trouble(room) > 0).sort((a, b) => trouble(b) - trouble(a));
      const theirs = enemyOf(sim);
      const theirShieldsDown = theirs && theirs.state.shield.charge < 1 && fight.phase === 'battle';
      const repelling = Object.values(sim.state.crew).some((m) => m.alive && m.owner === 'enemy');
      crew.forEach(({ member, ship: aboard }, index) => {
        if (member.path.length || member.board) return;
        if (aboard !== sim) {
          // Aboard them: home when hurt, or when we are being boarded; otherwise to wherever their crew are.
          if (member.health < 0.35 || repelling) return order({ type: 'crew.move', crew: member.id, room: 'medbay', ship: 'us' });
          const foes = Object.values(theirs.state.crew).filter((m) => m.alive && m.owner === 'enemy');
          const at = foes.find((m) => m.room === member.room) ?? foes[0];
          if (at && at.room !== member.room && !at.path.length) order({ type: 'crew.move', crew: member.id, room: at.room, ship: 'them' });
          return;
        }
        if (boarding && index > 0 && theirShieldsDown && !repelling && member.health >= 0.7) {
          const bridge = theirs.layout.rooms.find((room) => room.kind === 'helm') ?? theirs.layout.rooms[0];
          return order({ type: 'crew.move', crew: member.id, room: bridge.id, ship: 'them' });
        }
        if (index === 0) {
          if (member.room !== 'bridge') order({ type: 'crew.move', crew: member.id, room: 'bridge' });
          return;
        }
        if (trouble(sim.layout.room(member.room)) > 0) return;
        const spot = spots[(index - 1) % Math.max(1, spots.length)];
        if (!spot) return;
        const needsSuit = sim.state.rooms[spot.id].breach > 0;
        if (member.suit !== needsSuit) order({ type: 'crew.suit', crew: member.id, on: needsSuit });
        order({ type: 'crew.move', crew: member.id, room: spot.id });
      });
    }
    sim.step();
    const problems = checkInvariants(sim);
    if (problems.length) throw new Error(`tick ${sim.state.tick}: ${problems.join('; ')}`);
    watch();
  }
  const bad = findBadNumbers(sim.state);
  if (bad.length) throw new Error(`non-finite numbers at ${bad.join(', ')}`);
  const over = sim.state.fight?.over ?? null;
  if (!over) throw new Error(`the fight with the ${enemyId} was still going after ${DUEL_MINUTES} minutes`);
  if (tally.shots < tally.hit + tally.shield + tally.miss) throw new Error('more shots landed than were fired');
  return {
    ...tally,
    enemy: enemyId,
    outcome: over.outcome,
    seconds: (over.tick - sim.state.fight.started) / TICK_RATE,
    ourHull: sim.state.hull.points,
    alive: Object.values(sim.state.crew).filter((member) => member.alive && member.owner === 'player').length,
    boarding,
    hash: hashState(sim.snapshot()),
  };
}

const started = performance.now();
const failures = [];
const totals = { orders: 0, refused: 0, dropped: 0, doorMoves: 0, pauses: 0, powerMoves: 0, brownouts: 0, darkTicks: 0, fires: 0, spreads: 0, firesOut: 0, scorched: 0, jettisons: 0, airlessTicks: 0, moves: 0, arrivals: 0, blocked: 0, deaths: 0, firesFought: 0, patches: 0, repairs: 0, fights: 0, shots: 0, hits: 0, absorbed: 0, missed: 0, kills: 0, boarded: 0, boardedUs: 0, melee: 0, captured: 0, said: 0 };
const scenarios = [];
const duels = [];
const chaosEndings = {};
const enemyIds = ships.filter((item) => item.enemy === true).map((item) => item.id);
const crewedIds = ships.filter((item) => item.enemy === true && item.crew?.length).map((item) => item.id);
const underFire = [];
for (let i = 1; i <= runs; i++) {
  const seed = `${baseSeed}-${i}`;
  try {
    const first = playRun(seed);
    const second = playRun(seed);
    if (first.hash !== second.hash) failures.push({ seed, reason: `chaos replay mismatch (${first.hash} vs ${second.hash})` });
    for (const key of Object.keys(totals)) totals[key] += first[key];
    for (const [outcome, n] of Object.entries(first.endings)) chaosEndings[outcome] = (chaosEndings[outcome] ?? 0) + n;
  } catch (err) {
    failures.push({ seed, reason: `chaos: ${err.message}` });
  }
  try {
    const first = playScenario(seed);
    const second = playScenario(seed);
    if (first.hash !== second.hash) failures.push({ seed, reason: `scenario replay mismatch (${first.hash} vs ${second.hash})` });
    scenarios.push(first);
  } catch (err) {
    failures.push({ seed, reason: `scenario: ${err.message}` });
  }
  try {
    const first = playScenario(seed, { incoming: true });
    const second = playScenario(seed, { incoming: true });
    if (first.hash !== second.hash) failures.push({ seed, reason: `under fire replay mismatch (${first.hash} vs ${second.hash})` });
    underFire.push(first);
  } catch (err) {
    failures.push({ seed, reason: `under fire: ${err.message}` });
  }
  for (const enemyId of enemyIds) {
    for (const boarding of crewedIds.includes(enemyId) ? [false, true] : [false]) {
      const label = `${boarding ? 'boarding duel' : 'duel'} with ${enemyId}`;
      try {
        const first = playDuel(seed, enemyId, { boarding });
        const second = playDuel(seed, enemyId, { boarding });
        if (first.hash !== second.hash) failures.push({ seed, reason: `${label}: replay mismatch (${first.hash} vs ${second.hash})` });
        duels.push(first);
      } catch (err) {
        failures.push({ seed, reason: `${label}: ${err.message}` });
      }
    }
  }
}
const seconds = (performance.now() - started) / 1000;
const per = (n) => (n / runs).toFixed(1);
const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0);
const cleared = scenarios.filter((s) => s.cleared);
const clearTimes = cleared.map((s) => s.clearSeconds).sort((a, b) => a - b);
const pct = (n, of) => (of ? `${Math.round((100 * n) / of)}%` : 'n/a');

const out = [];
out.push('Cold Manifest autoplay');
out.push(`  runs:              ${runs} (seeds ${baseSeed}-1 to ${baseSeed}-${runs}), each played as chaos, as a hazard scenario, under fire and as a duel with every enemy, each twice`);
out.push(`  ship:              ${ship.name}, crew of ${roster.length}, ${lines.length} AI lines`);
out.push(`  crashed or bad:    ${failures.length}`);
out.push('');
out.push(`Chaos (${minutes} game minutes each, ${ticks} ticks): a bot doing everything at random`);
out.push(`  orders per run:    ${per(totals.orders)} given, ${per(totals.refused)} refused up front, ${per(totals.dropped)} dropped`);
out.push(`  door moves:        ${per(totals.doorMoves)} completed per run`);
out.push(`  power per run:     ${per(totals.powerMoves)} bars routed, ${per(totals.brownouts)} brownouts, door control dark ${((100 * totals.darkTicks) / (runs * ticks)).toFixed(0)}% of the time`);
out.push(`  hazards per run:   ${per(totals.fires)} fires lit, ${per(totals.spreads)} spread, ${per(totals.firesOut)} went out, ${per(totals.scorched)} system bars burned, ${per(totals.jettisons)} rooms jettisoned`);
out.push(`  crew per run:      ${per(totals.moves)} sent, ${per(totals.arrivals)} arrived, ${per(totals.blocked)} blocked, ${per(totals.deaths)} of ${roster.length} died`);
out.push(`  crew work per run: ${per(totals.firesFought)} fires put out, ${per(totals.patches)} breaches patched, ${per(totals.repairs)} system bars repaired`);
out.push(`  air:               rooms were unbreathable ${((100 * totals.airlessTicks) / (runs * ticks * ship.rooms.length)).toFixed(0)}% of room-time`);
out.push(`  fights per run:    ${per(totals.fights)} started, ${per(totals.shots)} shots fired (${per(totals.hits)} hit, ${per(totals.absorbed)} stopped by shields, ${per(totals.missed)} missed), ${per(totals.kills)} enemies destroyed`);
out.push(`  boarding per run:  ${per(totals.boarded)} of ours crossed, ${per(totals.boardedUs)} of theirs crossed, ${per(totals.melee)} killed hand to hand, ${per(totals.captured)} captured`);
out.push(`  fight endings:     ${Object.keys(OUTCOMES).map((k) => `${OUTCOMES[k].toLowerCase()} ${chaosEndings[k] ?? 0}`).join(', ')}`);
out.push(`  AI lines per run:  ${per(totals.said)} (about one every ${totals.said ? Math.round((runs * minutes * 60) / totals.said) : 0} seconds)`);
out.push(`  pauses per run:    ${per(totals.pauses)} (state checked every paused frame)`);
out.push('');
out.push(`Hazard scenarios (${SCENARIO_MINUTES} game minutes each): fires and breaches at once, and a bot trying to save the ship`);
out.push(`  completed:         ${scenarios.length} of ${runs}`);
out.push(`  emergencies:       ${mean(scenarios.map((s) => s.fires)).toFixed(1)} fires and ${mean(scenarios.map((s) => s.breaches)).toFixed(1)} breaches at the start; at worst ${mean(scenarios.map((s) => s.worstFires)).toFixed(1)} rooms burning at once`);
out.push(`  ship saved:        ${cleared.length} of ${scenarios.length} (${pct(cleared.length, scenarios.length)}) ended with no fire and no breach`);
out.push(`  time to clear:     median ${clearTimes.length ? Math.round(clearTimes[Math.floor(clearTimes.length / 2)]) : 'n/a'}s, slowest ${clearTimes.length ? Math.round(clearTimes.at(-1)) : 'n/a'}s`);
out.push(`  crew alive at end: ${mean(scenarios.map((s) => s.alive)).toFixed(2)} of ${roster.length} on average; everyone lived in ${pct(scenarios.filter((s) => s.alive === roster.length).length, scenarios.length)} of runs, nobody in ${pct(scenarios.filter((s) => s.alive === 0).length, scenarios.length)}`);
out.push(`  system damage:     ${mean(scenarios.map((s) => s.damage)).toFixed(1)} bars left broken at the end`);
out.push(`  AI lines:          ${mean(scenarios.map((s) => s.said)).toFixed(1)} per scenario`);
out.push('');
const saved = underFire.filter((s) => s.cleared);
const savedTimes = saved.map((s) => s.clearSeconds).sort((a, b) => a - b);
const hitSum = (key) => underFire.reduce((sum, s) => sum + s.hits[key], 0);
out.push(`Under fire (${SCENARIO_MINUTES} game minutes each): shots land on the ship for ${INCOMING_SECONDS / 60} minutes, then the same bot cleans up`);
out.push(`  completed:         ${underFire.length} of ${runs}`);
out.push(`  hits per run:      ${mean(underFire.map((s) => s.hits.landed)).toFixed(1)} landed; between them ${(hitSum('fires') / runs).toFixed(1)} fires, ${(hitSum('breaches') / runs).toFixed(1)} breaches, ${(hitSum('bars') / runs).toFixed(1)} system bars broken, ${(hitSum('hurt') / runs).toFixed(1)} crew hurt`);
out.push(`  ship saved:        ${saved.length} of ${underFire.length} (${pct(saved.length, underFire.length)}) ended with no fire and no breach; median ${savedTimes.length ? Math.round(savedTimes[Math.floor(savedTimes.length / 2)]) : 'n/a'}s after the last shot`);
out.push(`  crew alive at end: ${mean(underFire.map((s) => s.alive)).toFixed(2)} of ${roster.length} on average; everyone lived in ${pct(underFire.filter((s) => s.alive === roster.length).length, underFire.length)} of runs`);
const causes = {};
for (const s of underFire) for (const [cause, n] of Object.entries(s.deaths)) causes[cause] = (causes[cause] ?? 0) + n;
out.push(`  deaths by cause:   ${Object.entries(causes).sort((a, b) => b[1] - a[1]).map(([cause, n]) => `${cause} ${n}`).join(', ') || 'none'}`);
out.push(`  hull left:         ${mean(underFire.map((s) => s.hull)).toFixed(1)} of ${ship.hullPoints} on average; ${mean(underFire.map((s) => s.damage)).toFixed(1)} system bars still broken at the end`);
out.push('');
out.push(`Duels (up to ${DUEL_MINUTES} game minutes each): every enemy in turn, and a bot fighting it`);
for (const [enemyId, boarding] of enemyIds.flatMap((id) => (crewedIds.includes(id) ? [[id, false], [id, true]] : [[id, false]]))) {
  const mine = duels.filter((d) => d.enemy === enemyId && d.boarding === boarding);
  const name = `${ships.find((item) => item.id === enemyId).name}${boarding ? ', and we board them' : ''}`;
  const counts = {};
  for (const d of mine) counts[d.outcome] = (counts[d.outcome] ?? 0) + 1;
  const times = mine.map((d) => d.seconds).sort((a, b) => a - b);
  const fired = mine.reduce((n, d) => n + d.shots, 0);
  const hails = {};
  for (const d of mine) if (d.hail) hails[d.hail] = (hails[d.hail] ?? 0) + 1;
  out.push(`  ${name}: ${mine.length} fights`);
  out.push(`    endings:        ${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${OUTCOMES[k].toLowerCase()} ${n}`).join(', ')}`);
  out.push(`    length:         median ${times.length ? Math.round(times[Math.floor(times.length / 2)]) : 'n/a'}s, longest ${times.length ? Math.round(times.at(-1)) : 'n/a'}s`);
  out.push(`    our shots:      ${mean(mine.map((d) => d.shots)).toFixed(1)} per fight; ${pct(mine.reduce((n, d) => n + d.hit, 0), fired)} hit, ${pct(mine.reduce((n, d) => n + d.shield, 0), fired)} stopped by shields, ${pct(mine.reduce((n, d) => n + d.miss, 0), fired)} missed`);
  out.push(`    their shots:    ${mean(mine.map((d) => d.incoming)).toFixed(1)} per fight, ${mean(mine.map((d) => d.incomingHits)).toFixed(1)} hit; our hull at the end ${mean(mine.map((d) => d.ourHull)).toFixed(1)} of ${ship.hullPoints}, crew alive ${mean(mine.map((d) => d.alive)).toFixed(2)} of ${roster.length}`);
  if (crewedIds.includes(enemyId)) out.push(`    boarding:       ${mean(mine.map((d) => d.boardedUs)).toFixed(1)} of theirs crossed to us, ${mean(mine.map((d) => d.boarded)).toFixed(1)} of ours to them per fight; ${mine.reduce((n, d) => n + d.killedAboard, 0)} of theirs and ${mine.reduce((n, d) => n + d.lostAboard, 0)} of ours killed hand to hand, ${mine.reduce((n, d) => n + d.captured, 0)} captured`);
  if (Object.keys(hails).length) out.push(`    hails answered: ${Object.entries(hails).map(([k, n]) => `${k} ${n}`).join(', ')}; ${mine.reduce((n, d) => n + d.offers, 0)} surrender offers made`);
}
out.push('');
out.push(`  wall time:         ${seconds.toFixed(2)}s`);
const verdict = failures.length
  ? `FAILED: ${failures.length} problem(s).`
  : 'PASSED: no crashes, no stuck doors, no crew stuck on a path, power never over supply, no fire without air, no fight left hanging, nothing moved while paused, every run replays from its seed.';

console.log(out.join('\n'));
const reportPath = option('report', null);
if (reportPath) {
  const body = ['# Autoplay report', '', `Command: \`node tools/autoplay.js --runs ${runs} --minutes ${minutes} --seed ${baseSeed}\``, '', '```', ...out.filter((line) => !line.includes('wall time')), '```', '', verdict, ...failures.slice(0, 20).map((f) => `- seed ${f.seed}: ${f.reason}`), ''];
  writeFileSync(reportPath, body.join('\n'));
  console.log(`\nReport written to ${reportPath}`);
}

if (failures.length) {
  for (const failure of failures.slice(0, 20)) console.error(`FAILED seed ${failure.seed}: ${failure.reason}`);
  if (failures.length > 20) console.error(`...and ${failures.length - 20} more`);
  process.exit(1);
}
console.log(`\n${verdict}`);
