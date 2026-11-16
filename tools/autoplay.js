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
//   crossings  a run's sector chart from origin to the drop (S3.1): the bot plots
//              the cheapest course a lane at a time, sometimes turns off it for a
//              port, waits for the fix and jumps; if the pursuer catches it, it
//              fights back in a simple way and escapes down the next lane of its
//              course as soon as the fix allows. Since S3.4 every crossing carries a
//              contract from the board (each type in turn): the bot works a salvage
//              claim on the way, refuels and patches the hull at ports when it can
//              pay, answers inspections like any event, and hands over at the drop.
//              Since H.1 ships turn up on the scope at the points it arrives at; it
//              flies on as before, and the report says how each of those ended
//   encounters every kind of contact from content/encounters/ in turn (H.1), put on the
//              scope at a seeded range and bearing, against a bot that tries one answer:
//              nothing, going quiet, running, a flare, a crate out of the airlock, or a
//              bluff. An encounter still going after ENCOUNTER_MINUTES is a failure
//   boardings  every kind of party from content/encounters/ at our lock in turn (H.2),
//              against a bot with one answer: nothing, a bribe at the lock, handing over
//              what they want, everyone hiding, everyone fighting at the lock, or venting
//              the rooms they come through. A party still aboard after its time is a failure.
//              On the crossings the bot pays at the lock when it can and opens it when not
//
// Chaos: the bot sends three crew around the ship to deal with whatever is
// worst, suits them up for breaches, works doors, airlocks and lights, routes
// power, starts fires and breaches, breaks systems and jams doors through the
// debug commands, now and then jettisons a room, and pauses at random. Its strategy and the
// report grow stage by stage (PLAN.md §4).

import { createClock } from '../src/engine/clock.js';
import { createContent } from '../src/engine/content.js';
import { eventView } from '../src/narrative/events.js';
import { findBadNumbers, hashState } from '../src/engine/hash.js';
import { createRng } from '../src/engine/rng.js';
import { POWERED, used, supply } from '../src/sim/power.js';
import { BOARD_SECONDS } from '../src/sim/boarding.js';
import { JOB_SECONDS } from '../src/sim/hold.js';
import { DEBUG_ACTIONS, OUTCOMES, chargeOf, enemyOf, ourCrew } from '../src/sim/combat.js';
import { resolvedRooms, signature } from '../src/sim/senses.js';
import { MANUAL_DOOR_SECONDS, TICK_RATE, TICK_SECONDS, checkInvariants, createSim } from '../src/sim/sim.js';
import { cheapestRoute, laneBetween, neighbours, nodeOf, whyNoCourseJump } from '../src/sim/sector.js';
import { contractCrates } from '../src/sim/contracts.js';
import { BLUFFS, ENDINGS, SPAWN, bluffChance, scopeView } from '../src/sim/encounters.js';
import { BOARD, GOALS, OUTCOMES as BOARD_OUTCOMES, REASONS, whyNoBribe } from '../src/sim/boarders.js';
import { hidingSpot, lockersFree } from '../src/sim/agents.js';
import { boardOffers } from '../src/sim/runflow.js';
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
const roster = content.all('crew').map(({ id, name, role, engineer, skills, traits }) => ({ id, name, role, engineer, skills, traits }));
const ruleSet = { memories: content.all('memories'), refusals: content.all('refusals'), risks: content.all('risks') };
const transitEvents = content.all('events');
const lines = content.all('ai-lines');
const weapons = content.all('weapons');
const ships = content.all('ships');
const sectorDef = content.require('sectors', 'the-reach');
const contractTemplates = content.all('contracts');
const ports = content.all('ports');
const encounterDefs = content.all('encounters');

/** The longest anyone should stand still with somewhere to be: a hand-worked door, with a wide margin. */
const MAX_STILL_TICKS = 200;

/** The longest anyone may spend boarding, from the order to coming out the other side: a long walk, a wait, the tube. */
const MAX_BOARDING_TICKS = (60 + BOARD_SECONDS) * TICK_RATE;

/** The longest a door can take to finish moving, plus a margin. Longer means stuck. */
const MAX_DOOR_TICKS = Math.ceil(MANUAL_DOOR_SECONDS * TICK_RATE) + 3;

/** Play one run to the end. Returns its stats, or throws on any failure. */
function playRun(seed) {
  const sim = createSim({ seed, ship, crew: roster, lines, weapons, ships, rules: ruleSet });
  const clock = createClock({ sim, tickSeconds: TICK_SECONDS });
  // The bot's own dice, kept apart from the sim's so its choices are not part of the game state.
  const bot = createRng(`bot:${seed}`);
  const endings = {}; // how chaos fights ended, by outcome
  const stats = { orders: 0, refused: 0, dropped: 0, doorMoves: 0, pauses: 0, powerMoves: 0, brownouts: 0, darkTicks: 0, fires: 0, spreads: 0, firesOut: 0, scorched: 0, jettisons: 0, airlessTicks: 0, moves: 0, arrivals: 0, blocked: 0, deaths: 0, firesFought: 0, patches: 0, repairs: 0, fights: 0, shots: 0, hits: 0, absorbed: 0, missed: 0, kills: 0, boarded: 0, boardedUs: 0, melee: 0, captured: 0, argued: 0, margoRefused: 0, overrides: 0, stoodDown: 0, lapsed: 0, crewRefused: 0, scares: 0, lamps: 0 };
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
  sim.events.on('ai.argued', () => (stats.argued += 1));
  sim.events.on('ai.refused', () => (stats.margoRefused += 1));
  sim.events.on('captain.overrode', () => (stats.overrides += 1));
  sim.events.on('captain.stood_down', () => (stats.stoodDown += 1));
  sim.events.on('ai.objection.lapsed', () => (stats.lapsed += 1));
  sim.events.on('crew.refused', () => (stats.crewRefused += 1));
  sim.events.on('crew.spooked', () => (stats.scares += 1));
  sim.events.on('crew.lit', () => (stats.lamps += 1));
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
    // Now and then a crate job (S2.8): open one, carry it somewhere, throw it out, or fetch rounds for a gun.
    const crates = Object.keys(sim.state.crates);
    if (crates.length && bot.chance(0.25)) {
      const crate = bot.pick(crates);
      const kind = bot.pick(['crate.open', 'crate.move', 'crate.move', 'crate.jettison', 'weapon.load', 'weapon.load']);
      if (kind === 'weapon.load') return order({ type: kind, crew: member.id, slot: bot.between(0, sim.state.weapons.length) });
      if (kind === 'crate.move') return order({ type: kind, crew: member.id, crate, room: bot.pick(sim.layout.rooms).id });
      return order({ type: kind, crew: member.id, crate });
    }
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
    if (roll < 0.85) return order({ type: 'power.add', system: bot.pick(['weapons', 'shields', 'engines']), delta: 1 });
    if (roll < 0.9) return order({ type: 'ship.brace' });
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
    } else if (roll < 0.83) {
      order({ type: 'room.lights', room: bot.pick(sim.layout.rooms).id, on: bot.chance(0.5) });
    } else if (roll < 0.85) {
      order({ type: 'lights.all', on: bot.chance(0.5) });
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
  // The same data a snapshot holds, hashed in place: no copy is made for a check that runs every paused frame.
  const liveHash = () => hashState({ state: sim.state, rng: sim.rng.getState() });

  // One frame per tick: the bot sees and acts exactly as often as the sim steps.
  while (sim.state.tick < ticks) {
    // The bot gives an order now and then, paused or not.
    if (bot.chance(0.05)) {
      act();
      if (clock.paused) pausedHash = liveHash(); // the queue may have grown; that is allowed
    }
    // Margo is holding an order (S2.10): sooner or later the bot overrides her or stands down. Now and then it lets it lapse.
    if (sim.state.ai.objection && bot.chance(0.005)) {
      order({ type: bot.chance(0.6) ? 'captain.override' : 'captain.standDown' });
      if (clock.paused) pausedHash = liveHash();
    }

    if (clock.paused) {
      const ran = clock.advance(TICK_SECONDS);
      if (ran !== 0) throw new Error(`clock ran ${ran} tick(s) while paused`);
      if (liveHash() !== pausedHash) throw new Error(`state changed while paused at tick ${sim.state.tick}`);
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
      pausedHash = liveHash();
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

/**
 * How a careful bot answers Margo and the crew (S2.10). When she argues about
 * sending someone into a fire or an airless room, it stands down and has them
 * suit up, which is what she wanted. When a crew member refuses over burns,
 * thin air or an override, a suit answers that too; over the dark, it puts
 * that room's lamp on; over a room where someone died, it sends them
 * elsewhere. Returns what the bot now knows, and counts what happened.
 */
function carefulAnswers(sim, order) {
  const mind = { suits: new Set(), avoid: new Map(), lit: new Map(), counts: { argued: 0, margoRefused: 0, overrides: 0, stoodDown: 0, crewRefused: 0, scares: 0, lamps: 0, byRule: {} } };
  const { counts } = mind;
  sim.events.on('ai.objected', (event) => {
    counts[event.kind === 'refuse' ? 'margoRefused' : 'argued'] += 1;
    if (event.risk === 'into_fire' || event.risk === 'into_vacuum') {
      mind.suits.add(event.crew);
      order({ type: 'captain.standDown' });
    } else order({ type: 'captain.override' }); // nothing else it does should trip her; if something does, it means it
  });
  sim.events.on('captain.overrode', () => (counts.overrides += 1));
  sim.events.on('captain.stood_down', () => (counts.stoodDown += 1));
  sim.events.on('crew.spooked', () => (counts.scares += 1));
  sim.events.on('crew.lit', () => (counts.lamps += 1));
  sim.events.on('crew.refused', (event) => {
    counts.crewRefused += 1;
    counts.byRule[event.rule] = (counts.byRule[event.rule] ?? 0) + 1;
    // The dark: a lamp for them, if there is power for one. If not, like a room where someone died, they are sent elsewhere.
    if (event.rule === 'dark' && order({ type: 'room.lights', room: event.room, on: true })) mind.lit.set(event.room, sim.state.tick + 15 * TICK_RATE);
    else if (event.rule === 'dark' || event.rule === 'grave') {
      if (!mind.avoid.has(event.crew)) mind.avoid.set(event.crew, new Set());
      mind.avoid.get(event.crew).add(event.room);
    } else mind.suits.add(event.crew);
  });
  return mind;
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
  const sim = createSim({ seed, ship, crew: roster, lines, weapons, ships, rules: ruleSet });
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
  const mind = carefulAnswers(sim, order);
  let sent = 0;
  sim.events.on('crew.ordered', () => (sent += 1));
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
          if (mind.suits.has(member.id) && !member.suit) order({ type: 'crew.suit', crew: member.id, on: true });
          if (member.goal !== 'medbay' && member.room !== 'medbay') order({ type: 'crew.move', crew: member.id, room: 'medbay' });
          continue;
        }
        if (member.path.length || trouble(here) > 0) continue; // busy
        // Spread out: at most two to a room.
        const spot = spots.find((room) => (taken.get(room.id) ?? 0) < 2 && !mind.avoid.get(member.id)?.has(room.id) && !sim.whyNot({ type: 'crew.move', crew: member.id, room: room.id }));
        if (!spot) continue;
        taken.set(spot.id, (taken.get(spot.id) ?? 0) + 1);
        const needsSuit = sim.state.rooms[spot.id].breach > 0 || mind.suits.has(member.id);
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
    sent,
    mind: mind.counts,
    trust: sim.state.ai.trust,
    hash: hashState(sim.snapshot()),
  };
}

// Braces (S2.8) make some fights a long grind; the stalemate rule still ends every one, but slowly (each hull point lost buys up to 90 s).
const DUEL_MINUTES = 12;
/** Which way each ending went for us, for the enemy table. */
const OUTCOME_KIND = Object.freeze({ destroyed: 'won', 'crew-dead': 'won', surrendered: 'won', escaped: 'parted', fled: 'parted', talked: 'parted', bribed: 'parted', stalemate: 'parted', lost: 'lost' });

/**
 * A duel: one enemy alongside, and a bot that fights it. It answers a hail
 * (mostly by shooting, sometimes by talking or paying), feeds air, sensors
 * and guns, aims at their shields and then their guns once its sensors have
 * made those rooms out, keeps someone at the helm and sends the others to
 * trouble, takes most surrenders, and jumps out when the hull is low and the
 * sensors have a fix. It fights one of two ways (S2.7, D-074):
 *   lit   every lamp on and the drive burning, as a new player would
 *   dark  every lamp off and the drive cold until it is time to leave, with
 *         the spare power on shields
 * Returns
 * how it ended, or throws on any failure, including a fight still going at
 * the end (the stalemate rule should make that impossible).
 */
function playDuel(seed, enemyId, { boarding = false, dark = false } = {}) {
  const sim = createSim({ seed, ship, crew: roster, lines, weapons, ships, rules: ruleSet });
  const bot = createRng(`duel:${boarding ? 'board:' : ''}${dark ? 'dark:' : ''}${enemyId}:${seed}`);
  const end = DUEL_MINUTES * 60 * TICK_RATE;
  const watch = stuckWatch(sim);
  const tally = { shots: 0, hit: 0, shield: 0, miss: 0, incoming: 0, incomingHits: 0, incomingWide: 0, incomingBlind: 0, incomingBraced: 0, lockLost: 0, lockTicks: 0, signature: 0, battleTicks: 0, offers: 0, hail: null, boarded: 0, boardedUs: 0, killedAboard: 0, lostAboard: 0, captured: 0, braces: 0, theirBraces: 0, ammoRuns: 0, theirAmmoRuns: 0, dryTicks: 0 };
  sim.events.on('ship.braced', () => (tally.braces += 1));
  sim.events.on('enemy.ship.braced', () => (tally.theirBraces += 1));
  sim.events.on('weapon.loaded', () => (tally.ammoRuns += 1));
  sim.events.on('enemy.weapon.loaded', () => (tally.theirAmmoRuns += 1));
  // A crate job that ran out of time is someone stuck on an ammo run: that is a failure.
  const slow = ({ reason, crew }) => {
    if (reason === 'slow') throw new Error(`${crew} gave up a crate job after ${JOB_SECONDS}s at tick ${sim.state.tick}`);
  };
  sim.events.on('crew.blocked', slow);
  sim.events.on('enemy.crew.blocked', slow);
  sim.events.on('enemy.lock.lost', () => (tally.lockLost += 1));
  sim.events.on('crew.boarded', ({ onto }) => onto === 'enemy' && (tally.boarded += 1));
  sim.events.on('enemy.crew.boarded', ({ onto }) => onto === 'player' && (tally.boardedUs += 1));
  sim.events.on('enemy.crew.died', ({ cause }) => cause === 'melee' && (tally.killedAboard += 1));
  sim.events.on('crew.died', ({ cause }) => cause === 'melee' && (tally.lostAboard += 1));
  sim.events.on('crew.captured', () => (tally.captured += 1));
  sim.events.on('shot.resolved', ({ side, result, blind }) => {
    if (side === 'player') tally[result] += 1;
    else {
      tally.incoming += 1;
      if (result === 'hit') tally.incomingHits += 1;
      if (result === 'shield') tally.incomingBraced += 1;
      if (result === 'miss') tally.incomingWide += 1;
      if (blind) tally.incomingBlind += 1;
    }
  });
  sim.events.on('weapon.fired', ({ side }) => side === 'player' && (tally.shots += 1));
  sim.events.on('fight.offer', () => (tally.offers += 1));
  const order = (command) => !sim.whyNot(command) && sim.enqueue(command);
  const mind = carefulAnswers(sim, order);
  let sent = 0;
  let litTicks = 0; // room-seconds of lamp on a ship that is trying to run dark
  sim.events.on('crew.ordered', () => (sent += 1));
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
    // Brace timing (S2.8): the moment a volley of theirs is in the air, dump the capacitor into it.
    if (fight?.phase === 'battle' && fight.shots.some((shot) => shot.side === 'enemy') && !sim.whyNot({ type: 'ship.brace' })) order({ type: 'ship.brace' });
    if (fight?.phase === 'battle' && sim.state.weapons.some((slot) => slot.powered && slot.rounds === 0)) tally.dryTicks += 1;
    if (fight && tick % TICK_RATE === 0) {
      const enemy = sim.state.fight.enemy;
      if (fight.phase === 'hail' && tick > 2 * TICK_RATE) {
        tally.hail = answer < 0.2 ? 'talk' : answer < 0.3 ? 'pay' : 'fight';
        if (tally.hail === 'talk') order({ type: 'fight.talk' });
        else if (tally.hail === 'pay' && !order({ type: 'fight.bribe' })) order({ type: 'fight.engage' });
        else order({ type: 'fight.engage' });
      }
      if (fight.offer) order({ type: bot.chance(0.75) ? 'fight.accept' : 'fight.refuse' });
      // Running: once the hull is low the drive gets a bar, whatever it costs the guns, and we go when the sensors have a fix.
      const running = sim.state.hull.points <= sim.state.hull.max * 0.3;
      // Dark: every lamp off (S2.7). Lit: every lamp left on.
      // A lamp it lit for someone who would not walk into the dark gets a few seconds before it goes off again (S2.10).
      for (const [roomId, until] of mind.lit) if (until <= tick) mind.lit.delete(roomId);
      if (dark && !mind.lit.size && !sim.whyNot({ type: 'lights.all', on: false })) order({ type: 'lights.all', on: false });
      const systems = sim.state.systems;
      const room = (id) => systems[id].power < systems[id].level - systems[id].damage;
      for (const id of ['doors', 'medbay', 'ai_core']) if (systems[id].power > 0) order({ type: 'power.add', system: id, delta: -1 });
      if (dark && !running && systems.engines.power > 0) order({ type: 'power.add', system: 'engines', delta: -1 });
      // One bar at a time, top of the list first: air, sensors (for a lock, and the fix to leave by), every gun, then shields, then the drive.
      const wants = running ? ['life_support', 'sensors', 'engines', 'weapons', 'shields'] : ['life_support', 'sensors', 'weapons', 'shields', ...(dark ? [] : ['engines'])];
      const want = wants.find((id) => (id === 'sensors' || id === 'engines' ? systems[id].power < 1 && room(id) : room(id)));
      if (want) {
        if (!sim.whyNot({ type: 'power.add', system: want, delta: 1 })) order({ type: 'power.add', system: want, delta: 1 });
        else {
          // Nothing spare: take a bar from further down the list.
          const donor = [...wants.slice(wants.indexOf(want) + 1)].reverse().find((id) => systems[id].power > 0) ?? (!wants.includes('engines') && systems.engines.power > 0 ? 'engines' : null);
          if (donor) order({ type: 'power.add', system: donor, delta: -1 });
        }
      }
      // Their shields first; once those are broken, their guns. Only what the sensors have resolved can be aimed at.
      const known = resolvedRooms(sim);
      const shieldsDown = enemy.systems.shields.absent || enemy.systems.shields.damage >= enemy.systems.shields.level;
      const wanted = shieldsDown && enemy.rooms.weapons ? 'weapons' : enemy.rooms.shields ? 'shields' : null;
      const aim = known.includes(wanted) ? wanted : known.length ? bot.pick(known) : null;
      // Hold fire until every powered gun is charged, then fire them together.
      const guns = sim.state.weapons.map((slot, index) => ({ slot, index })).filter(({ slot }) => slot.powered);
      const volley = guns.length > 0 && guns.every(({ index }) => chargeOf(sim, index) >= 1);
      for (const { slot, index } of guns) {
        const want = volley ? aim : null;
        if (slot.target !== want) order({ type: 'weapon.target', slot: index, room: want });
      }
      // Get out if it is going badly.
      if (running) order({ type: 'ship.jump' });
      // Crew: the first stays at the helm, the others go to the worst trouble: boarders first.
      const crew = ourCrew(sim).filter(({ member }) => member.alive);
      // Ammo runs (S2.8): a heavy gun that is empty or nearly sends the last of the crew (never the pilot) for rounds.
      sim.state.weapons.forEach((slot, index) => {
        if (slot.rounds === null || slot.rounds > 1 || !slot.powered) return;
        if (crew.some(({ member }) => member.job?.kind === 'load')) return;
        const runner = [...crew].reverse().find(({ member, ship: aboard }, at) => aboard === sim && at < crew.length - 1 && !member.board && !member.job && !sim.whyNot({ type: 'weapon.load', crew: member.id, slot: index }));
        if (runner) order({ type: 'weapon.load', crew: runner.member.id, slot: index });
      });
      const spots = sim.layout.rooms.filter((room) => trouble(room) > 0).sort((a, b) => trouble(b) - trouble(a));
      const theirs = enemyOf(sim);
      const theirShieldsDown = theirs && theirs.state.shield.charge < 1 && !(theirs.state.shield.field > 0) && fight.phase === 'battle';
      const repelling = Object.values(sim.state.crew).some((m) => m.alive && m.owner === 'enemy');
      crew.forEach(({ member, ship: aboard }, index) => {
        if (member.path.length || member.board || member.job) return;
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
        const open = spots.filter((room) => !mind.avoid.get(member.id)?.has(room.id));
        const spot = open[(index - 1) % Math.max(1, open.length)];
        if (!spot) return;
        const needsSuit = sim.state.rooms[spot.id].breach > 0 || mind.suits.has(member.id);
        if (member.suit !== needsSuit) order({ type: 'crew.suit', crew: member.id, on: needsSuit });
        order({ type: 'crew.move', crew: member.id, room: spot.id });
      });
    }
    sim.step();
    const problems = checkInvariants(sim);
    if (problems.length) throw new Error(`tick ${sim.state.tick}: ${problems.join('; ')}`);
    watch();
    const now = sim.state.fight;
    // Sampled once a second: how loud we were, and whether they had us.
    if (now && !now.over && now.phase === 'battle' && sim.state.tick % TICK_RATE === 0) {
      tally.battleTicks += 1;
      tally.signature += signature(sim).total;
      litTicks += Object.values(sim.state.rooms).filter((r) => r.lightsOn).length;
      if (now.enemy.contact.locked) tally.lockTicks += 1;
    }
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
    dark,
    sent,
    litTicks,
    mind: mind.counts,
    hash: hashState(sim.snapshot()),
  };
}

const CROSSING_MINUTES = 30;
/** The chance the crossing bot turns off its route for a port a lane away, when it can spare the fuel and the jump. */
const DETOUR_CHANCE = 0.3;

/**
 * A crossing: the sector chart from the origin to the drop. Throws on any failure, including a chart
 * with no way across, a bot that cannot get a fix, or a crossing still going after CROSSING_MINUTES.
 */
function playCrossing(seed, index) {
  // The board for this seed, and the contract of the type whose turn it is (S3.4).
  const offers = boardOffers(contractTemplates, { seed });
  const offer = offers[index % offers.length];
  const sim = createSim({ seed, ship, crew: roster, lines, weapons, ships, rules: ruleSet, events: transitEvents, sector: sectorDef, contract: offer.template, ports, encounters: encounterDefs, run: { pursuit: offer.followed } });
  const bot = createRng(`crossing:${seed}`);
  const { run } = sim.state;
  const contract = run.contract;
  const end = CROSSING_MINUTES * 60 * TICK_RATE;
  const tally = { caught: 0, escapes: 0, detours: 0, sighted: 0, fightTicks: 0, lines: 0, outcomes: {}, events: 0, lapsed: 0, eventFights: 0, hooks: 0, met: {}, picked: {}, locked: 0, offered: 0, inspections: 0, seized: 0, fuelBought: 0, fuelSpent: 0, repairSpent: 0, claimLeft: false, contacts: {}, contactKinds: {}, boardings: {} };
  sim.events.on('cargo.seized', () => (tally.seized += 1));
  sim.events.on('port.refueled', (event) => {
    tally.fuelBought += event.bought;
    tally.fuelSpent += event.cost;
  });
  sim.events.on('port.repaired', (event) => (tally.repairSpent += event.cost));
  sim.events.on('event.opened', (event) => {
    if (event.event === 'checkpoint.inspection') tally.inspections += 1;
    tally.events += 1;
    tally.met[event.event] = (tally.met[event.event] ?? 0) + 1;
  });
  sim.events.on('event.chosen', (event) => (tally.picked[`${event.event}/${event.choice}`] = (tally.picked[`${event.event}/${event.choice}`] ?? 0) + 1));
  sim.events.on('event.lapsed', () => (tally.lapsed += 1));
  sim.events.on('effect.applied', (event) => {
    if (event.effect === 'fight') tally.eventFights += 1;
    if (event.effect === 'scene' || event.effect === 'threat') tally.hooks += 1;
  });
  sim.events.on('boarding.ended', (event) => (tally.boardings[event.outcome] = (tally.boardings[event.outcome] ?? 0) + 1));
  sim.events.on('encounter.ended', (event) => {
    tally.contacts[event.outcome] = (tally.contacts[event.outcome] ?? 0) + 1;
    tally.contactKinds[event.encounter] = (tally.contactKinds[event.encounter] ?? 0) + 1;
  });
  sim.events.on('pursuit.caught', () => (tally.caught += 1));
  sim.events.on('pursuit.sighted', () => (tally.sighted += 1));
  sim.events.on('ai.line', (event) => event.trigger && ['sector.jumped', 'course.ready', 'pursuit.sighted', 'contract.late', 'sector.delivered', 'fuel.out', 'pursuit.ended'].includes(event.trigger) && (tally.lines += 1));
  sim.events.on('fight.over', (event) => {
    tally.outcomes[event.outcome] = (tally.outcomes[event.outcome] ?? 0) + 1;
    if (event.outcome === 'escaped') tally.escapes += 1;
  });
  const give = (command) => !sim.whyNot(command) && sim.enqueue(command);
  /** Where the bot is making for: the salvage claim while it is still to be worked, then the drop. */
  const goal = () => (contract.status === 'active' && contract.claim && !contract.claim.done && !tally.claimLeft ? contract.claim.node : run.map.delivery);
  /** Where to go next: the cheapest way on, or now and then a port a lane off it if that still leaves the drop in reach. */
  function nextStop() {
    const route = cheapestRoute(run.map, run.at, goal());
    const ahead = route.path[1];
    if (!bot.chance(DETOUR_CHANCE)) return ahead;
    const ports = neighbours(run.map, run.at).filter((id) => id !== ahead && nodeOf(run.map, id).kind === 'port' && !run.visited.includes(id));
    for (const id of ports) {
      const on = cheapestRoute(run.map, id, run.map.delivery);
      if (laneBetween(run.map, run.at, id).fuel + on.fuel <= run.fuel && run.jumps + 1 + on.jumps <= run.deadline) {
        tally.detours += 1;
        return id;
      }
    }
    return ahead;
  }
  /** At a port with nothing else on: refuel for the way on, patch a badly holed hull, sell loose salvage. */
  function portCall() {
    if (nodeOf(run.map, run.at).kind !== 'port' || tally.lastPort === run.jumps) return;
    tally.lastPort = run.jumps;
    give({ type: 'port.sell', what: 'salvage' });
    if (sim.state.hull.points < sim.state.hull.max * 0.6) give({ type: 'port.repair', what: 'hull' });
    const need = cheapestRoute(run.map, run.at, goal()).fuel + (goal() === run.map.delivery ? 0 : cheapestRoute(run.map, goal(), run.map.delivery).fuel);
    if (run.fuel < Math.min(run.fuelMax, need + 2)) give({ type: 'port.refuel' });
  }
  let lost = false;
  let crewDead = false;
  let settled = false;
  while (!settled && sim.state.tick < end) {
    const fight = sim.state.fight;
    const view = eventView(sim);
    if (!ourCrew(sim).some(({ member }) => member.alive)) {
      crewDead = true;
      break;
    }
    if (view) {
      // An event on the table (S3.3): answer it with any choice that is open to us, then put it away.
      if (view.result) give({ type: 'event.dismiss' });
      else {
        const open = view.choices.filter((choice) => choice.available);
        tally.offered += view.choices.length;
        tally.locked += view.choices.length - open.length;
        give({ type: 'event.choose', choice: bot.pick(open).id });
      }
    } else if (sim.state.boarding?.phase === 'demand') {
      // A party at the lock (H.2): pay if the money allows, otherwise let them get on with it.
      if (!whyNoBribe(sim)) give({ type: 'boarding.bribe' });
      else give({ type: 'boarding.admit' });
    } else if (fight?.over) {
      if (fight.over.outcome === 'lost') {
        lost = true;
        break;
      }
      give({ type: 'fight.dismiss' });
    } else if (fight) {
      tally.fightTicks += 1;
      // A short fight: answer the hail by shooting, take a surrender, run dark, strip the doors, medbay and core
      // for guns and shields, brace when it can, aim at their shields and then their guns in volleys, and go
      // the moment the fix allows. Fleeing alone does not work: every hit shakes the fix (D-087).
      if (fight.phase === 'hail') give({ type: 'fight.engage' });
      if (fight.offer) give({ type: 'fight.accept' });
      give({ type: 'lights.all', on: false });
      const systems = sim.state.systems;
      for (const id of ['doors', 'medbay', 'ai_core']) if (systems[id].power > 0) give({ type: 'power.add', system: id, delta: -1 });
      for (const id of ['weapons', 'shields']) give({ type: 'power.add', system: id, delta: 1 });
      give({ type: 'ship.brace' });
      const enemy = enemyOf(sim).state;
      const known = resolvedRooms(sim);
      const shieldsDown = enemy.systems.shields.absent || enemy.systems.shields.damage >= enemy.systems.shields.level;
      const wanted = shieldsDown && enemy.rooms.weapons ? 'weapons' : enemy.rooms.shields ? 'shields' : null;
      const aim = known.includes(wanted) ? wanted : (known[0] ?? null);
      const guns = sim.state.weapons.map((slot, index) => ({ slot, index })).filter(({ slot }) => slot.powered);
      const volley = guns.length > 0 && guns.every(({ index }) => chargeOf(sim, index) >= 1);
      for (const { slot, index } of guns) if (slot.target !== (volley ? aim : null)) give({ type: 'weapon.target', slot: index, room: volley ? aim : null });
      if (!run.plot) give({ type: 'course.plot', to: cheapestRoute(run.map, run.at, run.map.delivery).path[1] });
      give({ type: 'ship.jump' });
    } else if (run.at === run.map.delivery) {
      // The drop: hand over whatever is left of the cargo, if there is a contract left to hand over.
      if (!sim.whyNot({ type: 'contract.deliver' })) give({ type: 'contract.deliver' });
      else {
        // Nothing to hand over (a claim left unworked): the captain walks away from the contract, as retiring would.
        give({ type: 'contract.abandon' });
        settled = true;
      }
    } else if (!run.plot) {
      if (contract.claim && run.at === contract.claim.node && !contract.claim.done) tally.claimLeft = true; // it walked away from the claim
      portCall();
      if (run.fuel < Math.min(...run.map.lanes.filter((l) => l.a === run.at || l.b === run.at).map((l) => l.fuel))) break; // stranded
      give({ type: 'course.plot', to: nextStop() });
    } else if (!whyNoCourseJump(sim)) give({ type: 'course.jump' });
    else if (sim.state.tick % TICK_RATE === 0) {
      // An event can leave the sensors or the engines down (S3.3): send whoever is not flying to mend
      // them, and put the power back when they are mended.
      const helm = sim.layout.rooms.find((room) => room.kind === 'helm')?.id;
      const hands = ourCrew(sim).map(({ member }) => member).filter((member) => member.alive);
      const bound = (room) => hands.some((member) => member.room === room || member.goal === room);
      if (helm && !bound(helm) && hands.length) give({ type: 'crew.move', crew: hands[0].id, room: helm });
      // A fire in the way stops the mending: whoever is idle and not flying goes to put it out.
      for (const [room, r] of Object.entries(sim.state.rooms)) {
        const free = hands.find((member) => member.room !== helm && member.goal === null && member.task === 'idle');
        if (r.fire > 0 && !r.jettisoned && free && !bound(room)) give({ type: 'crew.move', crew: free.id, room });
      }
      // The doors come first: the bot strips their power in a fight, and nobody walks anywhere without them.
      for (const id of ['doors', 'sensors', 'engines']) {
        const system = sim.state.systems[id];
        if (system.power >= 1) continue;
        const room = sim.layout.rooms.find((item) => item.system === id)?.id;
        // Whoever is free, a different one every few seconds in case one refuses; suited if the air in there is thin.
        const free = hands.filter((member) => member.room !== helm && member.goal === null && member.task === 'idle');
        const hand = free.length ? free[Math.floor(sim.state.tick / (5 * TICK_RATE)) % free.length] : null;
        if (system.damage > 0 && room && hand && !bound(room)) {
          if (sim.state.rooms[room].oxygen < 0.5 && !hand.suit) give({ type: 'crew.suit', crew: hand.id, on: true });
          give({ type: 'crew.move', crew: hand.id, room });
        }
        // Out of a fight the guns can give a bar back for the drive and the sensors.
        if (/no spare power/.test(sim.whyNot({ type: 'power.add', system: id, delta: 1 }) ?? '')) {
          const spare = ['weapons', 'shields', 'medbay'].find((other) => sim.state.systems[other].power > 0);
          if (spare) give({ type: 'power.add', system: spare, delta: -1 });
        }
        give({ type: 'power.add', system: id, delta: 1 });
      }
    }
    sim.step();
    if (sim.state.tick % 20 === 0) {
      const problems = checkInvariants(sim);
      if (problems.length) throw new Error(`invariant broken at tick ${sim.state.tick}: ${problems[0]}`);
    }
  }
  if (!settled && !lost && !crewDead && sim.state.tick >= end) throw new Error(`still crossing after ${CROSSING_MINUTES} minutes, at ${run.at} with ${run.fuel} fuel (${run.plot ? whyNoCourseJump(sim) : `no course: ${sim.whyNot({ type: "course.plot", to: nextStop() })}`})`);
  const bad = findBadNumbers(sim.state);
  if (bad.length) throw new Error(`non-finite numbers at ${bad.join(', ')}`);
  return {
    ...tally,
    nodes: run.map.nodes.length,
    lanes: run.map.lanes.length,
    cheapest: cheapestRoute(run.map, run.map.start, run.map.delivery).jumps,
    deadline: run.deadline,
    followed: Boolean(run.pursuit),
    delivered: run.delivered,
    late: run.late,
    lost,
    crewDead,
    stranded: !run.delivered && !lost && !crewDead,
    type: contract.type,
    status: contract.status,
    reason: contract.reason,
    earned: contract.earned,
    paid: contract.paid,
    advance: contract.advance,
    pay: contract.pay,
    crates: contractCrates(sim).length,
    money: sim.state.money,
    standing: Object.values(contract.standing).reduce((sum, add) => sum + add, 0),
    jumps: run.jumps,
    fuelLeft: run.fuel,
    minutes: sim.state.tick / TICK_RATE / 60,
    hash: hashState(sim.snapshot()),
  };
}

const ENCOUNTER_MINUTES = 20;
/** What the encounter bot can try. Each seed gives each kind of contact one of them, in turn. */
const TACTICS = Object.freeze(['nothing', 'quiet', 'run', 'flare', 'crate', 'bluff']);

/**
 * One contact on the scope (H.1) and a bot with one idea. Throws on any failure, including an
 * encounter that has not ended after ENCOUNTER_MINUTES. No enemy ships are loaded, so a docking is
 * only a docking: what a boarding party does is H.2.
 */
function playEncounter(seed, def, tactic) {
  const sim = createSim({ seed, ship, crew: roster, lines, weapons, ships: [], rules: ruleSet, encounters: encounterDefs });
  const bot = createRng(`encounter:${def.id}:${tactic}:${seed}`);
  const end = ENCOUNTER_MINUTES * 60 * TICK_RATE;
  const give = (command) => !sim.whyNot(command) && sim.enqueue(command);
  const tally = { encounter: def.id, tactic, outcome: null, seconds: 0, sighted: null, named: false, noticed: false, fooled: 0, hails: 0, flares: 0, crates: 0 };
  sim.events.on('contact.sighted', () => (tally.sighted ??= sim.state.tick / TICK_RATE));
  sim.events.on('contact.identified', () => (tally.named = true));
  sim.events.on('contact.noticed', () => (tally.noticed = true));
  sim.events.on('contact.fooled', () => (tally.fooled += 1));
  sim.events.on('contact.hailed', () => (tally.hails += 1));
  sim.events.on('encounter.ended', (event) => {
    tally.outcome ??= event.outcome;
    tally.seconds = event.seconds;
  });
  const spawn = { range: bot.range(SPAWN.near, SPAWN.far), bearing: bot.range(0, 360), miss: bot.range(0, SPAWN.miss) };
  const power = (system, delta) => give({ type: 'power.add', system, delta });
  const dark = () => {
    give({ type: 'lights.all', on: false });
    for (const system of ['sensors', 'engines']) if (sim.state.systems[system].power > 0) power(system, -1);
  };
  const fullBurn = (heading) => {
    if (sim.state.systems.engines.power < sim.state.systems.engines.level && !power('engines', 1)) power('sensors', -1);
    give({ type: 'helm.heading', heading });
    give({ type: 'helm.burn', on: true });
  };
  let acted = null; // the second the bot made its move
  while (sim.state.tick < end && !tally.outcome) {
    const { tick } = sim.state;
    if (tick === TICK_RATE) give({ type: 'debug.contact', encounter: def.id, ...spawn });
    const view = scopeView(sim).contacts.find((contact) => !contact.stale) ?? null;
    const now = tick / TICK_RATE;
    if (view && tick % 4 === 0) {
      const away = (view.bearing + 180) % 360;
      if (tactic === 'quiet') dark();
      else if (tactic === 'run') fullBurn(away);
      else if (tactic === 'flare') {
        // Something bright astern, a hard burn off to one side while it looks, then cold.
        if (acted === null && view.state === 'closing' && view.range < 60) {
          acted = now;
          tally.flares += give({ type: 'decoy.flare' }) ? 1 : 0;
        }
        if (acted !== null && now - acted < 30) {
          give({ type: 'lights.all', on: false });
          fullBurn((view.bearing + 110) % 360);
        } else if (acted !== null) {
          give({ type: 'helm.burn', on: false });
          dark();
        }
      } else if (tactic === 'crate') {
        if (acted === null && (view.state === 'closing' || view.state === 'shadowing')) {
          const crate = Object.values(sim.state.crates).find((item) => item.kind === 'cargo' && item.room);
          const hand = ourCrew(sim).map(({ member }) => member).find((member) => member.alive && member.task === 'idle' && member.room !== 'bridge');
          if (crate && hand && give({ type: 'crate.jettison', crew: hand.id, crate: crate.id })) {
            acted = now;
            tally.crates += 1;
          }
        }
      } else if (tactic === 'bluff') {
        if (view.state === 'shadowing' || view.state === 'closing' || view.state === 'alongside') {
          const contact = sim.state.scope.contacts.find((item) => item.id === view.id);
          const best = Object.keys(BLUFFS).sort((a, b) => bluffChance(sim, contact, b) - bluffChance(sim, contact, a))[0];
          give({ type: 'contact.hail', contact: view.id, bluff: best });
        }
      }
    }
    sim.step();
    if (sim.state.tick % 20 === 0) {
      const problems = checkInvariants(sim);
      if (problems.length) throw new Error(`invariant broken at tick ${sim.state.tick}: ${problems[0]}`);
    }
  }
  if (!tally.outcome) throw new Error(`the ${def.id} was still on the scope after ${ENCOUNTER_MINUTES} minutes (${sim.state.scope.contacts.map((contact) => contact.state).join(', ') || 'no contact'})`);
  if (!ENDINGS[tally.outcome]) throw new Error(`the ${def.id} ended in no known way: "${tally.outcome}"`);
  const bad = findBadNumbers(sim.state);
  if (bad.length) throw new Error(`non-finite numbers at ${bad.join(', ')}`);
  return { ...tally, hash: hashState(sim.snapshot()) };
}

/** What the boarding bot can try. Each seed gives each kind of party one of them, in turn. */
const ANSWERS = Object.freeze(['nothing', 'bribe', 'yield', 'hide', 'fight', 'vent']);

/**
 * One party at our lock (H.2) and a bot with one answer. Throws on any failure, including a party that is
 * still aboard after its demand, its stay and its leaving are all up.
 */
function playBoarding(seed, def, answer) {
  const sim = createSim({ seed, ship, crew: roster, lines, weapons, ships: [], rules: ruleSet, encounters: encounterDefs });
  sim.state.money = 500;
  // Something for an inspection to find.
  const smuggled = Object.values(sim.state.crates).find((crate) => crate.label.includes('7731-D'));
  if (smuggled) smuggled.contraband = true;
  const give = (command) => !sim.whyNot(command) && sim.enqueue(command);
  const tally = { encounter: def.id, wants: def.wants, answer, outcome: null, reason: null, seconds: 0, ourDead: 0, theirDead: 0, found: 0, forced: 0, took: 0 };
  sim.events.on('crew.died', () => (tally.ourDead += 1));
  sim.events.on('enemy.crew.died', () => (tally.theirDead += 1));
  sim.events.on('crew.found', () => (tally.found += 1));
  sim.events.on('door.forced', () => (tally.forced += 1));
  sim.events.on('boarding.ended', (event) => {
    tally.outcome ??= event.outcome;
    tally.reason ??= event.reason;
    tally.seconds = event.seconds;
    tally.took = event.took + event.seized;
  });
  sim.enqueue({ type: 'debug.boarding', encounter: def.id });
  const limit = (BOARD.demand + def.party.stay + BOARD.leave + 5) * TICK_RATE;
  const ours = () => Object.values(sim.state.crew).filter((member) => member.owner === 'player' && member.alive);
  let vented = [];
  while (sim.state.tick < limit && !tally.outcome) {
    const boarding = sim.state.boarding;
    if (boarding && sim.state.tick % 10 === 0) {
      const dock = boarding.dock;
      if (answer === 'bribe' && boarding.phase === 'demand') give({ type: 'boarding.bribe' });
      else if (answer === 'yield' && boarding.phase === 'demand') give({ type: 'boarding.yield' });
      else if (answer === 'hide') {
        // Everyone to somewhere with a locker or a crawlway, and in.
        for (const member of ours()) {
          if (member.hidden || member.path.length) continue;
          if (hidingSpot(sim, member)) give({ type: 'crew.hide', crew: member.id, on: true });
          else {
            const room = ship.rooms.find((item) => item.hide && lockersFree(sim, item.id) > 0 && !Object.values(sim.state.crew).some((other) => other !== member && other.goal === item.id));
            if (room) give({ type: 'crew.move', crew: member.id, room: room.id });
          }
        }
      } else if (answer === 'fight') {
        // Everyone to the lock, and at them.
        for (const member of ours()) if (member.room !== dock && member.goal !== dock) give({ type: 'crew.move', crew: member.id, room: dock });
        if (boarding.phase === 'aboard' && !boarding.hostile) give({ type: 'boarding.fight' });
      } else if (answer === 'vent' && boarding.phase === 'demand') {
        // Clear the lock room and the rooms beside it, shut them off, and open the vents before the lock opens.
        const near = [dock, ...sim.layout.exits(dock).filter((exit) => exit.to !== 'space' && sim.layout.room(exit.to).kind !== 'lift').map((exit) => exit.to)];
        const safe = ship.rooms.find((room) => !near.includes(room.id) && room.kind !== 'lift' && room.kind !== 'corridor')?.id;
        for (const member of ours()) if (near.includes(member.room) && member.goal !== safe) give({ type: 'crew.move', crew: member.id, room: safe });
        if (!ours().some((member) => near.includes(member.room) || member.path.length)) {
          for (const room of near) if (give({ type: 'room.vent', room, open: true })) vented.push(room);
        }
      }
    }
    if (!boarding && vented.length) {
      for (const room of vented) give({ type: 'room.vent', room, open: false });
      vented = [];
    }
    sim.step();
    if (sim.state.tick % 20 === 0) {
      const problems = checkInvariants(sim);
      if (problems.length) throw new Error(`invariant broken at tick ${sim.state.tick}: ${problems[0]}`);
    }
  }
  if (!tally.outcome) throw new Error(`the ${def.id} party was still aboard after ${(limit / TICK_RATE).toFixed(0)}s (${sim.state.boarding?.phase})`);
  if (!BOARD_OUTCOMES[tally.outcome] || !REASONS[tally.reason]) throw new Error(`the ${def.id} boarding ended in no known way: "${tally.outcome}/${tally.reason}"`);
  if (Object.values(sim.state.crew).some((member) => member.party)) throw new Error(`a ${def.id} boarder was left aboard`);
  const bad = findBadNumbers(sim.state);
  if (bad.length) throw new Error(`non-finite numbers at ${bad.join(', ')}`);
  return { ...tally, hash: hashState(sim.snapshot()) };
}

const started = performance.now();
const failures = [];
const totals = { orders: 0, refused: 0, dropped: 0, doorMoves: 0, pauses: 0, powerMoves: 0, brownouts: 0, darkTicks: 0, fires: 0, spreads: 0, firesOut: 0, scorched: 0, jettisons: 0, airlessTicks: 0, moves: 0, arrivals: 0, blocked: 0, deaths: 0, firesFought: 0, patches: 0, repairs: 0, fights: 0, shots: 0, hits: 0, absorbed: 0, missed: 0, kills: 0, boarded: 0, boardedUs: 0, melee: 0, captured: 0, said: 0, argued: 0, margoRefused: 0, overrides: 0, stoodDown: 0, lapsed: 0, crewRefused: 0, scares: 0, lamps: 0 };
const scenarios = [];
const duels = [];
const chaosEndings = {};
const enemyIds = ships.filter((item) => item.enemy === true).map((item) => item.id);
const crewedIds = ships.filter((item) => item.enemy === true && item.crew?.length).map((item) => item.id);
const underFire = [];
const crossings = [];
const encounters = [];
const boardings = [];
for (let i = 1; i <= runs; i++) {
  const seed = `${baseSeed}-${i}`;
  try {
    const first = playCrossing(seed, i - 1);
    const second = playCrossing(seed, i - 1);
    if (first.hash !== second.hash) failures.push({ seed, reason: `crossing replay mismatch (${first.hash} vs ${second.hash})` });
    crossings.push(first);
  } catch (err) {
    failures.push({ seed, reason: `crossing: ${err.message}` });
  }
  encounterDefs.forEach((def, index) => {
    const tactic = TACTICS[(i - 1 + index) % TACTICS.length];
    try {
      const first = playEncounter(seed, def, tactic);
      const second = playEncounter(seed, def, tactic);
      if (first.hash !== second.hash) failures.push({ seed, reason: `encounter with ${def.id}: replay mismatch (${first.hash} vs ${second.hash})` });
      encounters.push(first);
    } catch (err) {
      failures.push({ seed, reason: `encounter with ${def.id} (${tactic}): ${err.message}` });
    }
    if (!def.party) return;
    const answer = ANSWERS[(i - 1 + index) % ANSWERS.length];
    try {
      const first = playBoarding(seed, def, answer);
      const second = playBoarding(seed, def, answer);
      if (first.hash !== second.hash) failures.push({ seed, reason: `boarding by ${def.id}: replay mismatch (${first.hash} vs ${second.hash})` });
      boardings.push(first);
    } catch (err) {
      failures.push({ seed, reason: `boarding by ${def.id} (${answer}): ${err.message}` });
    }
  });
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
        // Odd seeds fight lit, even seeds run dark, so the report can set the two side by side.
        const dark = i % 2 === 0;
        const first = playDuel(seed, enemyId, { boarding, dark });
        const second = playDuel(seed, enemyId, { boarding, dark });
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
out.push(`  runs:              ${runs} (seeds ${baseSeed}-1 to ${baseSeed}-${runs}), each played as chaos, as a hazard scenario, under fire, as a duel with every enemy, as a sector crossing and as an encounter with every kind of contact, each twice`);
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
out.push(`  fights per run:    ${per(totals.fights)} started, ${per(totals.shots)} shots fired (${per(totals.hits)} hit, ${per(totals.absorbed)} stopped by a brace, ${per(totals.missed)} missed), ${per(totals.kills)} enemies destroyed`);
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
  out.push(`    our shots:      ${mean(mine.map((d) => d.shots)).toFixed(1)} per fight; ${pct(mine.reduce((n, d) => n + d.hit, 0), fired)} hit, ${pct(mine.reduce((n, d) => n + d.shield, 0), fired)} stopped by a brace, ${pct(mine.reduce((n, d) => n + d.miss, 0), fired)} missed`);
  out.push(`    braces:         we braced ${mean(mine.map((d) => d.braces)).toFixed(1)} times a fight and stopped ${pct(mine.reduce((n, d) => n + d.incomingBraced, 0), mine.reduce((n, d) => n + d.incoming, 0))} of their shots; they braced ${mean(mine.map((d) => d.theirBraces)).toFixed(1)} times`);
  out.push(`    ammo:           ${mean(mine.map((d) => d.ammoRuns)).toFixed(1)} runs to the hold per fight (theirs ${mean(mine.map((d) => d.theirAmmoRuns)).toFixed(1)}); a heavy gun of ours sat empty ${pct(mine.reduce((n, d) => n + d.dryTicks, 0), mine.reduce((n, d) => n + d.seconds * TICK_RATE, 0))} of the fight`);
  out.push(`    their shots:    ${mean(mine.map((d) => d.incoming)).toFixed(1)} per fight, ${mean(mine.map((d) => d.incomingHits)).toFixed(1)} hit; our hull at the end ${mean(mine.map((d) => d.ourHull)).toFixed(1)} of ${ship.hullPoints}, crew alive ${mean(mine.map((d) => d.alive)).toFixed(2)} of ${roster.length}`);
  if (crewedIds.includes(enemyId)) out.push(`    boarding:       ${mean(mine.map((d) => d.boardedUs)).toFixed(1)} of theirs crossed to us, ${mean(mine.map((d) => d.boarded)).toFixed(1)} of ours to them per fight; ${mine.reduce((n, d) => n + d.killedAboard, 0)} of theirs and ${mine.reduce((n, d) => n + d.lostAboard, 0)} of ours killed hand to hand, ${mine.reduce((n, d) => n + d.captured, 0)} captured`);
  if (Object.keys(hails).length) out.push(`    hails answered: ${Object.entries(hails).map(([k, n]) => `${k} ${n}`).join(', ')}; ${mine.reduce((n, d) => n + d.offers, 0)} surrender offers made`);
}
out.push('');
out.push('Enemy types (S2.5): the plain duels side by side, lit and dark together');
out.push('  enemy              won   parted  lost   median length   our hull lost   their shots that hit');
for (const enemyId of enemyIds) {
  const mine = duels.filter((d) => d.enemy === enemyId && !d.boarding);
  if (!mine.length) continue;
  const kinds = { won: 0, parted: 0, lost: 0 };
  for (const d of mine) kinds[OUTCOME_KIND[d.outcome]] += 1;
  const times = mine.map((d) => d.seconds).sort((a, b) => a - b);
  const median = Math.round(times[Math.floor(times.length / 2)]);
  const name = ships.find((item) => item.id === enemyId).name;
  const shots = mine.reduce((n, d) => n + d.incoming, 0);
  out.push(`  ${name.padEnd(18)} ${pct(kinds.won, mine.length).padStart(4)}  ${pct(kinds.parted, mine.length).padStart(5)}  ${pct(kinds.lost, mine.length).padStart(5)}   ${`${median}s`.padStart(13)}   ${mean(mine.map((d) => ship.hullPoints - d.ourHull)).toFixed(1).padStart(13)}   ${shots ? pct(mine.reduce((n, d) => n + d.incomingHits, 0), shots) : 'never fired'}`);
}
out.push('');
out.push('Running dark (S2.7): the same duels, split by how the bot fought. Odd seeds lit (every lamp on, drive burning), even seeds dark (lamps off, drive cold)');
for (const enemyId of enemyIds) {
  const name = ships.find((item) => item.id === enemyId).name;
  for (const dark of [false, true]) {
    const mine = duels.filter((d) => d.enemy === enemyId && d.dark === dark);
    const shots = mine.reduce((n, d) => n + d.incoming, 0);
    const battle = mine.reduce((n, d) => n + d.battleTicks, 0);
    const won = mine.filter((d) => ['destroyed', 'crew-dead', 'surrendered'].includes(d.outcome)).length;
    const lost = mine.filter((d) => d.outcome === 'lost').length;
    if (!shots) {
      out.push(`  ${name}, ${dark ? 'dark' : 'lit '}: ${mine.length} fights; it never fired. Our signature ${pct(mine.reduce((n, d) => n + d.signature, 0), battle)} on average`);
      continue;
    }
    out.push(`  ${name}, ${dark ? 'dark' : 'lit '}: ${mine.length} fights; their shots ${pct(mine.reduce((n, d) => n + d.incomingHits, 0), shots)} hit, ${pct(mine.reduce((n, d) => n + d.incomingWide, 0), shots)} went wide, ${pct(mine.reduce((n, d) => n + d.incomingBlind, 0), shots)} were fired blind`);
    out.push(`    ${' '.repeat(name.length)}      our signature ${pct(mine.reduce((n, d) => n + d.signature, 0), battle)} on average; they held a lock ${pct(mine.reduce((n, d) => n + d.lockTicks, 0), battle)} of the fight and lost it ${mean(mine.map((d) => d.lockLost)).toFixed(1)} times; we won ${pct(won, mine.length)}, lost the ship ${pct(lost, mine.length)}, hull left ${mean(mine.map((d) => d.ourHull)).toFixed(1)}`);
  }
}
out.push('');
// S2.10: how often Margo and the crew say no. The plan wants both above zero and neither the main event.
const sumMind = (list, key) => list.reduce((n, item) => n + item.mind[key], 0);
const ruleNames = { grave: 'a room where someone died', burn: 'burns', choke: 'thin air', dark: 'the dark', override: 'an override' };
const rules = (list) => {
  const all = {};
  for (const item of list) for (const [rule, n] of Object.entries(item.mind.byRule)) all[rule] = (all[rule] ?? 0) + n;
  return Object.entries(all).sort((a, b) => b[1] - a[1]).map(([rule, n]) => `${ruleNames[rule] ?? rule} ${n}`).join(', ') || 'none';
};
const withAny = (list, key) => pct(list.filter((item) => item.mind[key] > 0).length, list.length);
out.push('Margo and the crew (S2.10): orders she held, and orders the crew would not take');
out.push(`  chaos, per run:    she argued ${per(totals.argued)} times and refused ${per(totals.margoRefused)}; the bot overrode her ${per(totals.overrides)} times, stood down ${per(totals.stoodDown)}, let ${per(totals.lapsed)} lapse`);
out.push(`                     crew refused ${per(totals.crewRefused)} of ${per(totals.moves + totals.crewRefused)} orders to move (${pct(totals.crewRefused, totals.moves + totals.crewRefused)}); the dark got to someone ${per(totals.scares)} times and ${per(totals.lamps)} lamps went on by a crew hand`);
for (const [label, list] of [['hazard scenarios', scenarios], ['under fire', underFire]]) {
  const orders = list.reduce((n, item) => n + item.sent, 0) + sumMind(list, 'crewRefused') + sumMind(list, 'argued');
  out.push(`  ${`${label}:`.padEnd(18)} she argued in ${withAny(list, 'argued')} of runs (${pct(sumMind(list, 'argued'), orders)} of orders to move); crew refused in ${withAny(list, 'crewRefused')} of runs (${pct(sumMind(list, 'crewRefused'), orders)} of orders): ${rules(list)}`);
}
for (const dark of [false, true]) {
  const list = duels.filter((d) => d.dark === dark);
  const orders = list.reduce((n, item) => n + item.sent, 0) + sumMind(list, 'crewRefused');
  const battle = list.reduce((n, d) => n + d.battleTicks, 0);
  out.push(`  duels, ${dark ? 'dark' : 'lit '}:       the dark got to someone ${(sumMind(list, 'scares') / Math.max(1, list.length)).toFixed(1)} times a fight and ${(sumMind(list, 'lamps') / Math.max(1, list.length)).toFixed(1)} lamps went on by a crew hand; ${(list.reduce((n, d) => n + d.litTicks, 0) / Math.max(1, battle)).toFixed(1)} of ${ship.rooms.length} rooms lit on average`);
  out.push(`                     crew refused in ${withAny(list, 'crewRefused')} of fights (${pct(sumMind(list, 'crewRefused'), orders)} of orders to move): ${rules(list)}`);
}
out.push(`  her trust:         ${mean(scenarios.map((s) => s.trust)).toFixed(0)} of 100 at the end of a hazard scenario, ${mean(underFire.map((s) => s.trust)).toFixed(0)} under fire (it starts at 50)`);
out.push('');
const followed = crossings.filter((c) => c.followed);
const crossOutcomes = {};
for (const c of crossings) for (const [k, n] of Object.entries(c.outcomes)) crossOutcomes[k] = (crossOutcomes[k] ?? 0) + n;
out.push(`Crossings (S3.1): the run's sector chart from the origin to the drop, a lane at a time`);
out.push(`  charts:            ${mean(crossings.map((c) => c.nodes)).toFixed(1)} points and ${mean(crossings.map((c) => c.lanes)).toFixed(1)} lanes on average (${Math.min(...crossings.map((c) => c.nodes))} to ${Math.max(...crossings.map((c) => c.nodes))} points); cheapest way across ${mean(crossings.map((c) => c.cheapest)).toFixed(1)} jumps, deadline ${mean(crossings.map((c) => c.deadline)).toFixed(1)}`);
out.push(`  delivered:         ${crossings.filter((c) => c.delivered).length} of ${crossings.length}, ${crossings.filter((c) => c.late).length} late; ship lost ${crossings.filter((c) => c.lost).length}, stranded ${crossings.filter((c) => c.stranded).length}`);
out.push(`  jumps:             ${mean(crossings.map((c) => c.jumps)).toFixed(1)} per crossing, ${mean(crossings.map((c) => c.detours)).toFixed(1)} of them detours to a port; ${mean(crossings.map((c) => c.fuelLeft)).toFixed(1)} fuel left; ${mean(crossings.map((c) => c.minutes)).toFixed(1)} game minutes`);
out.push(`  followed:          ${followed.length} of ${crossings.length}; Margo saw the pursuer in ${pct(followed.filter((c) => c.sighted > 0).length, followed.length)} of those; it caught us ${followed.reduce((n, c) => n + c.caught, 0)} times (${pct(followed.filter((c) => c.caught > 0).length, followed.length)} of followed crossings)`);
out.push(`  pursuit fights:    ${Object.entries(crossOutcomes).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${OUTCOMES[k].toLowerCase()} ${n}`).join(', ') || 'none'}`);
out.push(`  Margo on the chart: ${mean(crossings.map((c) => c.lines)).toFixed(1)} lines a crossing`);
const sumOf = (key) => crossings.reduce((n, c) => n + c[key], 0);
const merged = (key) => {
  const all = {};
  for (const c of crossings) for (const [k, n] of Object.entries(c[key])) all[k] = (all[k] ?? 0) + n;
  return Object.entries(all).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
};
out.push('');
out.push(`Events (S3.3): what the crossings met, from content/events/ (${transitEvents.length} events)`);
out.push(`  met:               ${mean(crossings.map((c) => c.events)).toFixed(1)} a crossing (${sumOf('events')} in all), ${sumOf('lapsed')} left behind unanswered; crew all dead in ${crossings.filter((c) => c.crewDead).length} crossings`);
out.push(`  choices:           ${sumOf('offered')} shown, ${sumOf('locked')} of them locked behind a requirement the crew did not meet (${pct(sumOf('locked'), sumOf('offered'))})`);
out.push(`  led to:            ${sumOf('eventFights')} fights, ${sumOf('hooks')} scene or threat hooks`);
out.push(`  by event:          ${merged('met').map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);
out.push(`  never met:         ${transitEvents.filter((event) => !merged('met').some(([k]) => k === event.id)).map((event) => event.id).join(', ') || 'none'}`);
out.push(`  by choice:         ${merged('picked').map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);
out.push('');
out.push('Contracts (S3.4): every crossing carries one from the board, each type in turn');
for (const type of [...new Set(crossings.map((c) => c.type))]) {
  const of = crossings.filter((c) => c.type === type);
  const done = of.filter((c) => c.status === 'delivered');
  const whole = done.filter((c) => c.earned === c.pay).length;
  const reasons = {};
  for (const c of of) if (c.status === 'failed') reasons[c.reason] = (reasons[c.reason] ?? 0) + 1;
  const unsettled = of.filter((c) => c.status === 'active').length;
  out.push(`  ${type.padEnd(18)} ${of.length} taken: delivered ${done.length} (${whole} whole, ${done.filter((c) => c.late).length} late), failed ${of.length - done.length - unsettled} (${Object.entries(reasons).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}), unfinished (ship or crew lost) ${unsettled}; earned ${done.length ? mean(done.map((c) => c.earned)).toFixed(0) : '-'} of ${of[0].pay} on average when delivered`);
}
out.push(`  inspections:       ${sumOf('inspections')} met, ${sumOf('seized')} found the contraband; ${crossings.filter((c) => c.type === 'salvage' && c.claimLeft).length} salvage claims walked away from`);
out.push(`  ports:             ${sumOf('fuelBought')} fuel bought for ${sumOf('fuelSpent')} credits, ${sumOf('repairSpent')} credits on repairs; money at the end ${mean(crossings.map((c) => c.money)).toFixed(0)} on average (${Math.min(...crossings.map((c) => c.money))} to ${Math.max(...crossings.map((c) => c.money))})`);
out.push(`  standing:          ${mean(crossings.map((c) => c.standing)).toFixed(2)} a crossing on average, all factions together`);
out.push('');
const endingList = (list) => Object.keys(ENDINGS).map((k) => [k, list.filter((e) => e.outcome === k).length]).filter(([, n]) => n > 0).map(([k, n]) => `${ENDINGS[k].toLowerCase()} ${n}`).join(', ') || 'none';
const slipped = (list) => list.filter((e) => e.outcome !== 'docked').length;
out.push(`Encounters (H.1): ${encounters.length} contacts on the scope, every kind from content/encounters/ (${encounterDefs.length}) against a bot with one idea each`);
out.push(`  how they ended:    ${endingList(encounters)}`);
out.push(`  the scope:         a contact showed after ${mean(encounters.filter((e) => e.sighted !== null).map((e) => e.sighted)).toFixed(1)}s on average, ${pct(encounters.filter((e) => e.named).length, encounters.length)} were made out by name, ${pct(encounters.filter((e) => e.noticed).length, encounters.length)} noticed us; ${mean(encounters.map((e) => e.seconds)).toFixed(0)}s an encounter (longest ${Math.max(0, ...encounters.map((e) => e.seconds)).toFixed(0)}s)`);
for (const def of encounterDefs) {
  const of = encounters.filter((e) => e.encounter === def.id);
  out.push(`  ${def.id.padEnd(18)} got away ${pct(slipped(of), of.length)}: ${endingList(of)}`);
}
for (const tactic of TACTICS) {
  const of = encounters.filter((e) => e.tactic === tactic);
  out.push(`  bot: ${tactic.padEnd(13)} got away ${pct(slipped(of), of.length)}: ${endingList(of)}`);
}
const crossContacts = {};
const crossKinds = {};
for (const c of crossings) {
  for (const [k, n] of Object.entries(c.contacts)) crossContacts[k] = (crossContacts[k] ?? 0) + n;
  for (const [k, n] of Object.entries(c.contactKinds)) crossKinds[k] = (crossKinds[k] ?? 0) + n;
}
const crossTotal = Object.values(crossContacts).reduce((a, b) => a + b, 0);
out.push(`  on the crossings:  ${crossTotal} contacts met (${(crossTotal / Math.max(1, crossings.length)).toFixed(1)} a crossing): ${Object.keys(ENDINGS).filter((k) => crossContacts[k]).map((k) => `${ENDINGS[k].toLowerCase()} ${crossContacts[k]}`).join(', ') || 'none'}; ${Object.entries(crossKinds).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);
const boardList = (list) => Object.keys(BOARD_OUTCOMES).map((k) => [k, list.filter((b) => b.outcome === k).length]).filter(([, n]) => n > 0).map(([k, n]) => `${BOARD_OUTCOMES[k].toLowerCase()} ${n}`).join(', ') || 'none';
const whyList = (list) => Object.keys(REASONS).map((k) => [k, list.filter((b) => b.reason === k).length]).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join(', ');
out.push(`Boardings (H.2): ${boardings.length} parties at our lock, every kind from content/encounters/ against a bot with one answer each`);
out.push(`  how they ended:    ${boardList(boardings)} (${whyList(boardings)}); ${mean(boardings.map((b) => b.seconds)).toFixed(0)}s a boarding (longest ${Math.max(0, ...boardings.map((b) => b.seconds)).toFixed(0)}s)`);
out.push(`  the cost:          ${boardings.reduce((n, b) => n + b.ourDead, 0)} of ours dead, ${boardings.reduce((n, b) => n + b.theirDead, 0)} of theirs; ${boardings.reduce((n, b) => n + b.found, 0)} found hiding; ${boardings.reduce((n, b) => n + b.forced, 0)} doors forced`);
for (const goal of Object.keys(GOALS)) {
  const of = boardings.filter((b) => b.wants === goal);
  if (of.length) out.push(`  ${GOALS[goal].toLowerCase().padEnd(18)} ${boardList(of)} (${whyList(of)})`);
}
for (const answer of ANSWERS) {
  const of = boardings.filter((b) => b.answer === answer);
  if (of.length) out.push(`  bot: ${answer.padEnd(13)} ${boardList(of)}; ${of.reduce((n, b) => n + b.ourDead, 0)} of ours dead`);
}
const crossBoard = {};
for (const c of crossings) for (const [k, n] of Object.entries(c.boardings)) crossBoard[k] = (crossBoard[k] ?? 0) + n;
out.push(`  on the crossings:  ${Object.entries(crossBoard).map(([k, n]) => `${BOARD_OUTCOMES[k].toLowerCase()} ${n}`).join(', ') || 'no boardings'}`);
out.push('');
out.push(`  wall time:         ${seconds.toFixed(2)}s`);
const verdict = failures.length
  ? `FAILED: ${failures.length} problem(s).`
  : 'PASSED: no crashes, no stuck doors, no crew stuck on a path, power never over supply, no fire without air, no fight left hanging, no crossing left unfinished, no contact left on the scope, no party left aboard, nothing moved while paused, every run replays from its seed.';

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
