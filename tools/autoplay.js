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
//   --only LIST    play only these modes, comma separated (chaos, scenario, fire, crossing, encounter,
//                  boarding); for tuning, the gate plays them all (H.8)
//   --once         play each seed once, with no replay check; for tuning only (H.8)
//
// Autoplay v1 (end of Stage 1) plays every seed twice over (S2.1 and S2.2 add modes below):
//   chaos      a bot that does everything at random, to find crashes
//   scenario   a seeded emergency (fires and breaches) and a bot that tries
//              to save the ship, to see whether the tools work
//   under fire shots land on the ship for two minutes and do what hits do
//              (S2.2); the same bot then has three minutes to clean up
//   crossings  a run's sector chart from origin to the drop (S3.1; routes and lanes
//              since H.6): in port the bot plots a route to the next port on the way,
//              the cheapest in fuel or now and then the quickest in hours, casts off and
//              flies it in ship time, then takes the fix off the port and jumps in; a ship closing on it gets the gun
//              laid on it, a toll gets paid when it can be, and the brace goes up when
//              rounds are in the air (H.3). Since S3.4 every crossing carries a
//              contract from the board (each type in turn): the bot works a salvage
//              claim on the way, refuels and patches the hull at ports when it can
//              pay, answers inspections like any event, and hands over at the drop.
//              Ships turn up on the scope by the risk of the lane it is on (H.6); it
//              flies on as before, and the report says how each of those ended
//   encounters every kind of contact from content/encounters/ in turn (H.1), put on the
//              scope at a seeded range and bearing, against a bot that tries one answer:
//              nothing, going quiet, running, a flare, a crate out of the airlock, a
//              bluff, the deterrent gun, or paying what is asked (H.3). The duels of
//              Stage 2 are gone with the enemy ship sim (H.3): this mode replaces them.
//              An encounter still going after ENCOUNTER_MINUTES is a failure. F.1: a contact is over in
//              about a minute and a half; the report gives the median and the longest, alone and on the crossings
//              F.2: going quiet is the lamps, sensors, drive and air plant all down; the report gives, kind by kind,
//              how often each answer gets away and what it cost, and fails no run over it (the target is a report line)
//   boardings  every kind of party from content/encounters/ at our lock in turn (H.2),
//              against a bot with one answer: nothing, a bribe at the lock, handing over
//              what they want, everyone hiding, everyone fighting at the lock, or venting
//              the rooms they come through. A party still aboard after its time is a failure.
//              On the crossings the bot pays at the lock when it can and opens it when not
//
// Chaos: the bot sends three crew around the ship to deal with whatever is
// worst, suits them up for breaches, works doors, airlocks and lights, stands
// stations down and to, posts crew, changes the watch bill and the reactor's
// output (H.4), starts fires and breaches, breaks systems and jams doors through the
// debug commands, puts contacts on the scope and lays the gun on them, now and
// then jettisons a room, and pauses at random. Its strategy and the
// report grow stage by stage (PLAN.md §4).

import { createClock } from '../src/engine/clock.js';
import { createContent } from '../src/engine/content.js';
import { eventView, nearestHand, situationViews } from '../src/narrative/events.js';
import { findBadNumbers, hashState } from '../src/engine/hash.js';
import { createRng } from '../src/engine/rng.js';
import { OUTPUT_LEVELS } from '../src/sim/power.js';
import { COVER_IDS, MANNER_IDS, MANNER_STATIONS, POSTS, STATION_IDS, rating, running } from '../src/sim/stations.js';
import { gunSlot, ourCrew } from '../src/sim/combat.js';
import { roundsInHold } from '../src/sim/hold.js';
import { MANUAL_DOOR_SECONDS, TICK_RATE, TICK_SECONDS, checkInvariants, createSim } from '../src/sim/sim.js';
import { COAST, bestRoute, cheapestRoute, heldReason, laneBetween, nodeOf, paceOf, routeTotals, whyNoRunIn } from '../src/sim/sector.js';
import { contractCrates } from '../src/sim/contracts.js';
import { burn } from '../src/sim/senses.js';
import { chill } from '../src/sim/cold.js';
import { BLUFFS, ENDINGS, HELM, SPAWN, STAGES_OF_AWARENESS, bearingOf, bluffChance, scopeView, tellsOf, whyNoHail, whyNoPay } from '../src/sim/encounters.js';
import { BOARD, GOALS, OUTCOMES as BOARD_OUTCOMES, REASONS, whyNoBribe } from '../src/sim/boarders.js';
import { hidingSpot, lockersFree } from '../src/sim/agents.js';
import { boardOffers } from '../src/sim/runflow.js';
import { createTempo } from '../src/sim/tempo.js';
import { writeFileSync } from 'node:fs';

import { readContentFiles } from './lib/load-content.js';

function option(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const runs = Number(option('runs', 100));
const minutes = Number(option('minutes', 10));
const baseSeed = String(option('seed', 'auto'));
const MODES = ['chaos', 'scenario', 'fire', 'crossing', 'encounter', 'boarding'];
const only = new Set(String(option('only', MODES.join(','))).split(','));
const once = process.argv.includes('--once');
for (const mode of only) if (!MODES.includes(mode)) {
  console.error(`Unknown mode "${mode}": use ${MODES.join(', ')}`);
  process.exit(2);
}
/** Play a mode twice and compare the hashes, or once with --once. */
function twice(play) {
  const first = play();
  if (once) return [first, first];
  return [first, play()];
}
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
const sectorDef = content.require('sectors', 'the-reach');
const contractTemplates = content.all('contracts');
const ports = content.all('ports');
const encounterDefs = content.all('encounters');

/** The longest anyone should stand still with somewhere to be: a hand-worked door, with a wide margin. */
const MAX_STILL_TICKS = 200;

/** The longest a door can take to finish moving, plus a margin. Longer means stuck. */
const MAX_DOOR_TICKS = Math.ceil(MANUAL_DOOR_SECONDS * TICK_RATE) + 3;

/** Play one run to the end. Returns its stats, or throws on any failure. */
function playRun(seed) {
  const sim = createSim({ seed, ship, crew: roster, watches: 2, margo: 'own', lines, weapons, rules: ruleSet, encounters: encounterDefs });
  const clock = createClock({ sim, tickSeconds: TICK_SECONDS });
  // The bot's own dice, kept apart from the sim's so its choices are not part of the game state.
  const bot = createRng(`bot:${seed}`);
  const endings = {}; // how chaos encounters ended, by outcome
  const stats = { orders: 0, refused: 0, dropped: 0, doorMoves: 0, pauses: 0, powerMoves: 0, brownouts: 0, darkTicks: 0, fires: 0, spreads: 0, firesOut: 0, scorched: 0, jettisons: 0, airlessTicks: 0, moves: 0, arrivals: 0, blocked: 0, deaths: 0, firesFought: 0, patches: 0, repairs: 0, contacts: 0, shots: 0, struck: 0, incoming: 0, hits: 0, absorbed: 0, missed: 0, warnings: 0, downed: 0, deterred: 0, boardedUs: 0, melee: 0, argued: 0, margoRefused: 0, overrides: 0, stoodDown: 0, lapsed: 0, crewRefused: 0, scares: 0, lamps: 0 };
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
  sim.events.on('station.stood', () => (stats.powerMoves += 1));
  sim.events.on('power.output', ({ reason }) => reason === 'order' && (stats.powerMoves += 1));
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
  sim.events.on('contact.spawned', () => (stats.contacts += 1));
  sim.events.on('enemy.crew.boarded', () => (stats.boardedUs += 1));
  sim.events.on('crew.died', ({ cause }) => cause === 'melee' && (stats.melee += 1));
  sim.events.on('enemy.crew.died', ({ cause }) => cause === 'melee' && (stats.melee += 1));
  sim.events.on('weapon.fired', () => (stats.shots += 1));
  sim.events.on('pod.downed', () => (stats.downed += 1));
  sim.events.on('drone.lost', ({ cause }) => cause === 'pd' && (stats.downed += 1));
  sim.events.on('shot.resolved', ({ at, result }) => {
    if (at === 'contact') stats.struck += result === 'hit' ? 1 : 0;
    else {
      stats.incoming += 1;
      stats[{ hit: 'hits', shield: 'absorbed', miss: 'missed', warning: 'warnings' }[result]] += 1;
    }
  });
  sim.events.on('ai.argued', () => (stats.argued += 1));
  sim.events.on('ai.refused', () => (stats.margoRefused += 1));
  sim.events.on('captain.overrode', () => (stats.overrides += 1));
  sim.events.on('captain.stood_down', () => (stats.stoodDown += 1));
  sim.events.on('ai.objection.lapsed', () => (stats.lapsed += 1));
  sim.events.on('crew.refused', () => (stats.crewRefused += 1));
  sim.events.on('crew.spooked', () => (stats.scares += 1));
  sim.events.on('crew.lit', () => (stats.lamps += 1));
  sim.events.on('encounter.ended', ({ outcome }) => {
    if (outcome === 'deterred') stats.deterred += 1;
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
    const { member } = bot.pick(alive);
    if (bot.chance(0.15)) return order({ type: 'crew.suit', crew: member.id, on: !member.suit });
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

  /** Put ships on the scope, lay the gun on them or take it off, pay, hail, brace, take a hit: in no sensible order. */
  function contactAct() {
    const contacts = sim.state.scope.contacts.filter((contact) => contact.state !== 'lost');
    if (!contacts.length || bot.chance(0.05)) return order(contacts.length && bot.chance(0.5) ? { type: 'debug.contact', clear: true } : { type: 'debug.contact', encounter: bot.pick(encounterDefs).id, state: bot.pick(['unseen', 'shadowing', 'closing']), range: bot.range(8, 60), bearing: bot.range(0, 360) });
    const contact = bot.pick(contacts);
    const roll = bot.next();
    if (roll < 0.45) return order({ type: 'gun.target', contact: bot.chance(0.85) ? contact.id : null });
    if (roll < 0.6) return order({ type: 'ship.brace' });
    if (roll < 0.7) return order({ type: 'contact.pay', contact: contact.id });
    if (roll < 0.8) return order({ type: 'contact.hail', contact: contact.id, bluff: bot.pick(Object.keys(BLUFFS)) });
    if (roll < 0.88) return order({ type: 'debug.gun', ...bot.pick([{ load: true }, { charge: true }, { money: true }]) });
    if (roll < 0.94) return order({ type: 'station.stand', station: bot.pick(['weapons', 'shields', 'engines']), down: false });
    // A shot out of nowhere, through the debug panel.
    return order({ type: 'debug.hit', at: 'us', room: null, weapon: bot.pick(weapons).id, force: bot.chance(0.5) });
  }

  function act() {
    if (bot.chance(0.3)) return crewAct();
    if (bot.chance(0.25)) return contactAct();
    const roll = bot.next();
    if (roll < 0.25) {
      // Like a player, it wants the doors working: half the time it tries to get door control back first.
      if (!running(sim, 'doors') && bot.chance(0.5)) {
        order({ type: 'debug.system', system: 'doors', damage: 0 });
        order({ type: 'station.stand', station: 'doors', down: false });
        order({ type: 'station.stand', station: 'ai_core', down: false });
      } else {
        // The switches and the watch bill (H.4): stand a station down or to, post someone, turn the reactor up or down.
        const pick = bot.next();
        // Margo's say over a station (H.5): hand it to her, keep it for the crew, or tell her how to run it.
        if (pick < 0.45) order({ type: 'station.stand', station: bot.pick(STATION_IDS), down: bot.chance(0.45) });
        else if (pick < 0.62) order({ type: 'crew.post', crew: bot.pick(ourCrew(sim)).member.id, station: bot.chance(0.15) ? null : bot.pick(POSTS) });
        else if (pick < 0.7) order({ type: 'station.cover', station: bot.pick(POSTS), cover: bot.pick(COVER_IDS) });
        else if (pick < 0.78) order({ type: 'station.order', station: bot.pick(MANNER_STATIONS), manner: bot.chance(0.3) ? null : bot.pick(MANNER_IDS) });
        else if (pick < 0.85) order({ type: 'power.output', level: bot.pick(OUTPUT_LEVELS) });
        else if (pick < 0.89) order({ type: 'power.lift', on: bot.chance(0.6) });
        else if (pick < 0.92) order({ type: 'roster.watches', count: bot.pick([1, 2, 3]) });
        else if (pick < 0.96) order({ type: 'crew.watch', crew: bot.pick(ourCrew(sim)).member.id, watch: bot.between(0, 2) });
        else order({ type: 'roster.muster' });
      }
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
      // Checked every eighth paused frame and on the last one before it resumes (DF-15: hashing every frame was
      // a sixth of the bot's time); anything that moved while paused is still moved by then.
      if ((pausedFor % 8 === 0 || pausedFor <= 1) && liveHash() !== pausedHash) throw new Error(`state changed while paused at tick ${sim.state.tick}`);
      if (--pausedFor <= 0) clock.resume();
      continue;
    }

    clock.advance(TICK_SECONDS);

    const problems = checkInvariants(sim);
    if (problems.length) throw new Error(`tick ${sim.state.tick}: ${problems.join('; ')}`);
    if (!running(sim, 'doors')) stats.darkTicks += 1;
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

/** Fail if anyone aboard with somewhere to be has not moved for too long. A boarder cutting a door is getting somewhere. Call once a tick. */
function stuckWatch(sim) {
  const stillSince = new Map();
  return () => {
    const { tick } = sim.state;
    for (const member of Object.values(sim.state.crew)) {
      const last = stillSince.get(member.id);
      const forcing = member.forcing ?? 0;
      if (!member.alive || !member.path.length || !last || last.x !== member.x || last.y !== member.y || last.forcing !== forcing) {
        stillSince.set(member.id, { tick, x: member.x, y: member.y, forcing });
      } else if (tick - last.tick > MAX_STILL_TICKS) {
        throw new Error(`${member.id} stuck on a path in ${member.room} since tick ${last.tick} (${member.task}, next ${JSON.stringify(member.path[0])}${member.path[0]?.door ? `, door ${JSON.stringify(sim.state.doors[member.path[0].door])}` : ''})`);
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

/**
 * One seeded emergency: a few seconds in, one to three fires and up to two
 * breaches open at once. The bot plays to win: it sends free hands to the
 * worst room, suits them for breaches, pulls back anyone badly hurt, and
 * leaves the doors alone. A mended system runs again by itself (H.4). Returns how it went, or throws on any failure.
 */
function playScenario(seed, { incoming = false } = {}) {
  const sim = createSim({ seed, ship, crew: roster, watches: 2, margo: 'own', lines, weapons, rules: ruleSet });
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

const CROSSING_MINUTES = 150;
/** Who runs the ship on a crossing, in turn (H.5): the crew; Margo, her way; the crew again; Margo, ordered by the book. */
const MARGO_MODES = Object.freeze(['crew', 'margo', 'crew', 'book']);
/** The chance the crossing bot takes the quickest route in hours over the cheapest in fuel, when the two differ and it can pay for it (H.6). */
const QUICK_CHANCE = 0.3;

/**
 * A crossing: the sector chart from the origin to the drop. Throws on any failure, including a chart
 * with no way across, a bot that cannot get a fix, or a crossing still going after CROSSING_MINUTES.
 */
function playCrossing(seed, index) {
  // The board for this seed, and the contract of the type whose turn it is (S3.4).
  const offers = boardOffers(contractTemplates, { seed });
  const offer = offers[index % offers.length];
  const sim = createSim({ seed, ship, crew: roster, watches: 2, margo: 'own', lines, weapons, rules: ruleSet, events: transitEvents, sector: sectorDef, contract: offer.template, ports, encounters: encounterDefs, run: { pursuit: offer.followed } });
  const bot = createRng(`crossing:${seed}`);
  // Who runs the ship (H.5): the crew at their posts on half the crossings; on the other half every station is
  // handed to Margo, left to her own way on one quarter and ordered run by the book on the last.
  const crewMode = MARGO_MODES[index % MARGO_MODES.length];
  if (crewMode !== 'crew') {
    for (const station of POSTS) sim.enqueue({ type: 'station.cover', station, cover: 'hers' });
    if (crewMode === 'book') for (const station of MANNER_STATIONS) sim.enqueue({ type: 'station.order', station, manner: 'book' });
    // Every other by-the-book crossing starts with her trust low, to see her run things her own way.
    if (crewMode === 'book' && index % (2 * MARGO_MODES.length) >= MARGO_MODES.length) sim.enqueue({ type: 'debug.ai', trust: 30 });
  }
  const { run } = sim.state;
  const contract = run.contract;
  const end = CROSSING_MINUTES * 60 * TICK_RATE;
  const tally = { caught: 0, escapes: 0, quick: 0, routes: 0, strikes: 0, risks: {}, time: { under: 0, coast: 0, held: 0, off: 0, port: 0, pace: 0 }, real: 0, fastTicks: 0, busy: {}, died: {}, sighted: 0, lines: 0, outcomes: {}, events: 0, lapsed: 0, placed: 0, attended: 0, sends: 0, eventContacts: 0, shots: 0, braces: 0, tolls: 0, hooks: 0, met: {}, picked: {}, locked: 0, offered: 0, inspections: 0, seized: 0, fuelBought: 0, fuelSpent: 0, fuelBurned: 0, repairSpent: 0, answers: {}, claimLeft: false, contacts: {}, contactKinds: {}, contactSeconds: [], stages: {}, pings: 0, pingsFound: 0, looks: { found: 0, blank: 0 }, boardings: {}, staff: { crew: 0, margo: 0, dark: 0, well: 0, samples: 0 }, tired: 0, watchChanges: 0, mode: crewMode, margo: { quiet: 0, book: 0, push: 0, rating: 0, held: 0, samples: 0, hunted: 0, found: 0, stretched: 0, ownWay: 0, doubt: 0, changes: 0 } };
  sim.events.on('margo.own_way', () => (tally.margo.ownWay += 1));
  sim.events.on('margo.doubt', () => (tally.margo.doubt += 1));
  sim.events.on('margo.manner', (event) => event.why !== 'order' && (tally.margo.changes += 1));
  sim.events.on('watch.changed', () => (tally.watchChanges += 1));
  sim.events.on('crew.died', (event) => (tally.died[event.cause] = (tally.died[event.cause] ?? 0) + 1));
  sim.events.on('cargo.seized', () => (tally.seized += 1));
  sim.events.on('port.refueled', (event) => {
    tally.fuelBought += event.bought;
    tally.fuelSpent += event.cost;
  });
  sim.events.on('port.repaired', (event) => (tally.repairSpent += event.cost));
  sim.events.on('fuel.burned', (event) => (tally.fuelBurned += event.spent));
  sim.events.on('event.opened', (event) => {
    if (event.event === 'checkpoint.inspection') tally.inspections += 1;
    tally.events += 1;
    tally.met[event.event] = (tally.met[event.event] ?? 0) + 1;
  });
  sim.events.on('event.chosen', (event) => (tally.picked[`${event.event}/${event.choice}`] = (tally.picked[`${event.event}/${event.choice}`] ?? 0) + 1));
  sim.events.on('event.lapsed', () => (tally.lapsed += 1));
  sim.events.on('event.opened', (event) => event.situation !== undefined && (tally.placed += 1));
  sim.events.on('situation.attended', () => (tally.attended += 1));
  const sent = new Map(); // situation number -> the tick somebody was last sent to it
  sim.events.on('effect.applied', (event) => {
    if (event.effect === 'contact') tally.eventContacts += 1;
    if (event.effect === 'scene' || event.effect === 'threat') tally.hooks += 1;
  });
  sim.events.on('boarding.ended', (event) => (tally.boardings[event.outcome] = (tally.boardings[event.outcome] ?? 0) + 1));
  // How long each ship was on our hands, by the clock a player would have (F.1): from turning up to its ending.
  const turnedUp = new Map();
  sim.events.on('contact.stage', (event) => (tally.stages[event.stage] = (tally.stages[event.stage] ?? 0) + 1));
  sim.events.on('contact.pinged', (event) => {
    tally.pings += 1;
    tally.pingsFound += event.found ? 1 : 0;
  });
  sim.events.on('contact.swept', (event) => !event.ping && (tally.looks[event.found ? 'found' : 'blank'] += 1));
  sim.events.on('encounter.ended', (event) => {
    if (turnedUp.has(event.contact)) tally.contactSeconds.push(tally.real - turnedUp.get(event.contact));
    turnedUp.delete(event.contact);
    tally.contacts[event.outcome] = (tally.contacts[event.outcome] ?? 0) + 1;
    tally.contactKinds[event.encounter] = (tally.contactKinds[event.encounter] ?? 0) + 1;
    // The pursuer is a contact now (H.3): how it ended is how the chase went this time.
    if (event.pursuer) {
      tally.outcomes[event.outcome] = (tally.outcomes[event.outcome] ?? 0) + 1;
      if (event.outcome !== 'docked') tally.escapes += 1;
    }
  });
  sim.events.on('weapon.fired', () => (tally.shots += 1));
  sim.events.on('ship.braced', () => (tally.braces += 1));
  sim.events.on('contact.paid', () => (tally.tolls += 1));
  sim.events.on('pursuit.caught', () => (tally.caught += 1));
  sim.events.on('pursuit.sighted', () => (tally.sighted += 1));
  sim.events.on('ai.line', (event) => event.trigger && ['route.sailed', 'route.passed', 'route.offport', 'sector.jumped', 'course.ready', 'pursuit.sighted', 'contract.late', 'sector.delivered', 'fuel.out', 'pursuit.ended'].includes(event.trigger) && (tally.lines += 1));
  sim.events.on('route.sailed', () => (tally.routes += 1));
  sim.events.on('shot.resolved', (event) => event.weapon === 'debris' && event.result === 'hit' && (tally.strikes += 1));
  // Ships met on the crossings, by the risk of the lane that brought them (H.6).
  sim.events.on('contact.spawned', (event) => {
    turnedUp.set(event.contact, tally.real);
    const risk = run.crossing ? (laneBetween(run.map, run.crossing.path[run.crossing.leg], run.crossing.path[run.crossing.leg + 1])?.risk ?? 'none') : 'none';
    tally.risks[risk] = (tally.risks[risk] ?? 0) + 1;
  });
  const give = (command) => !sim.whyNot(command) && sim.enqueue(command);
  /** Where the bot is making for: the salvage claim while it is still to be worked, then the drop. */
  const goal = () => (contract.status === 'active' && contract.claim && !contract.claim.done && !tally.claimLeft ? contract.claim.node : run.map.delivery);
  /** A route from here by way of `via` and on toward the drop, never crossing itself, cut at the first port it reaches. */
  function routeBy(via, by) {
    const there = bestRoute(run.map, run.at, via, { by }).path;
    const on = via === run.map.delivery ? [] : bestRoute(run.map, via, run.map.delivery, { by }).path.slice(1);
    let whole = [...there, ...on];
    const again = whole.findIndex((id, i) => whole.indexOf(id) !== i);
    if (again >= 0) whole = whole.slice(0, again);
    const stop = whole.findIndex((id, i) => i > 0 && nodeOf(run.map, id).kind === 'port');
    return stop >= 0 ? whole.slice(0, stop + 1) : null;
  }
  /** The route on (H.6): the cheapest in fuel, or now and then the quickest in hours if it can be paid for. */
  function nextRoute() {
    const cheap = routeBy(goal(), 'fuel') ?? routeBy(run.map.delivery, 'fuel');
    const quick = routeBy(goal(), 'hours');
    if (quick && cheap && quick.join() !== cheap.join() && routeTotals(run.map, quick).fuel <= run.fuel && bot.chance(QUICK_CHANCE)) {
      tally.quick += 1;
      return quick;
    }
    return cheap;
  }
  /** In port with nothing else on: refuel for the way on, patch a badly holed hull, sell loose salvage. */
  function portCall() {
    if (tally.lastPort === `${run.at}:${tally.routes}`) return;
    tally.lastPort = `${run.at}:${tally.routes}`;
    give({ type: 'port.sell', what: 'salvage' });
    if (sim.state.hull.points < sim.state.hull.max * 0.6) give({ type: 'port.repair', what: 'hull' });
    const need = cheapestRoute(run.map, run.at, goal()).fuel + (goal() === run.map.delivery ? 0 : cheapestRoute(run.map, goal(), run.map.delivery).fuel);
    if (run.fuel < Math.min(run.fuelMax, need + 2)) give({ type: 'port.refuel' });
    if (sim.state.helm.flares < HELM.flares && sim.state.money > 300) give({ type: 'port.flares' });
  }
  /**
   * A careful captain reads the scope (F.2): once Margo has made a hunting ship out, the answer its tells point to,
   * once for each ship: a story for one that listens, a crate for one after cargo, a flare for one that goes after
   * them, and the drive for one we can outrun, burning away from it until it gives up or gets close.
   */
  const answered = new Set();
  let runningFrom = null;
  function answer(live) {
    if (runningFrom !== null && !live.some((contact) => contact.id === runningFrom && (contact.state === 'shadowing' || contact.state === 'closing'))) {
      runningFrom = null;
      give({ type: 'helm.burn', on: false });
    }
    for (const contact of live) {
      if (answered.has(contact.id) || !contact.track.known || !(contact.state === 'shadowing' || contact.state === 'closing')) continue;
      const tells = new Set(tellsOf(sim.encounters.byId.get(contact.encounter)).map((tell) => tell.key));
      const best = Object.keys(BLUFFS).sort((a, b) => bluffChance(sim, contact, b) - bluffChance(sim, contact, a))[0];
      if (tells.has('talks') && !whyNoHail(sim, { contact: contact.id, bluff: best })) {
        give({ type: 'contact.hail', contact: contact.id, bluff: best });
        tally.answers.bluff = (tally.answers.bluff ?? 0) + 1;
      } else if (tells.has('cargo')) {
        // Loose cargo first; a crate of the contract's own only to save the rest of the hold from a ship that is sure of us.
        const crates = Object.values(sim.state.crates).filter((item) => item.kind === 'cargo' && item.room && !item.by);
        const crate = crates.find((item) => !item.contract) ?? (contact.state === 'closing' ? crates.find((item) => item.contract) : null);
        const hand = crate && ourCrew(sim).map(({ member }) => member).find((member) => member.alive && !member.job && member.task === 'idle' && sim.layout.room(member.room)?.kind !== 'helm');
        if (!crate || !hand) continue;
        give({ type: 'crate.jettison', crew: hand.id, crate: crate.id });
        tally.answers.crate = (tally.answers.crate ?? 0) + 1;
      } else if (tells.has('flare') && sim.state.helm.flares > 0 && contact.state === 'closing') {
        give({ type: 'decoy.flare' });
        tally.answers.flare = (tally.answers.flare ?? 0) + 1;
      } else if (tells.has('slow') && runningFrom === null && run.fuel > 2) {
        runningFrom = contact.id;
        give({ type: 'helm.heading', heading: (bearingOf(contact.x, contact.y) + 180) % 360 });
        give({ type: 'helm.burn', on: true });
        tally.answers.run = (tally.answers.run ?? 0) + 1;
      } else continue;
      answered.add(contact.id);
    }
  }
  let lost = false;
  let crewDead = false;
  let settled = false;
  // The tempo a player would get (H.8): every tick costs a tick of real time at normal speed, less in fast time.
  const tempo = createTempo();
  let rate = 1;
  while (!settled && sim.state.tick < end) {
    const view = eventView(sim);
    if (!ourCrew(sim).some(({ member }) => member.alive)) {
      crewDead = true;
      break;
    }
    if (sim.state.hull.points === 0) {
      lost = true;
      break;
    }
    // Ships on the scope (H.3), alongside whatever else is going on: brace into rounds in the air, pay a toll
    // if the money allows, and lay the gun on anything closing that is not a boarder we would rather pay.
    if (sim.state.shots.some((shot) => shot.at === 'us') || sim.state.scope.drones.some((drone) => drone.on)) give({ type: 'ship.brace' });
    if (sim.state.tick % TICK_RATE === 0) {
      const live = sim.state.scope.contacts.filter((contact) => contact.state !== 'lost' && contact.track.shown);
      for (const contact of live) if (contact.tolled && !whyNoPay(sim, contact.id)) give({ type: 'contact.pay', contact: contact.id });
      if (run.crossing) answer(live);
      const slot = gunSlot(sim);
      const threat = live.find((contact) => contact.state === 'closing' || contact.state === 'alongside' || contact.tolled);
      // A careful captain (F.1): the lamps go out the moment a search beam brushes us, and stay out until the
      // scope is clear again. Something closing: the guns and the shields stood to as well.
      const hunted = live.some((contact) => contact.state !== 'unseen' || contact.aware > 0);
      if (hunted) give({ type: 'lights.all', on: false });
      else if (!live.length && sim.state.tick % (10 * TICK_RATE) === 0) give({ type: 'lights.all', on: true });
      if (threat) {
        for (const station of ['weapons', 'shields']) if (sim.state.stations[station].down) give({ type: 'station.stand', station, down: false });
      }
      if (slot >= 0) {
        const want = threat?.id ?? null;
        if (sim.state.weapons[slot].target !== want) give({ type: 'gun.target', contact: want });
        const rounds = sim.state.weapons[slot].rounds;
        const hand = ourCrew(sim).map(({ member }) => member).find((member) => member.alive && !member.job && member.task === 'idle' && member.room !== 'bridge');
        if (threat && rounds !== null && rounds < 1 && roundsInHold(sim) && hand) give({ type: 'weapon.load', crew: hand.id, slot });
      }
    }
    // Situations aboard (H.7), alongside whatever else is going on: send the nearest hand to each one nobody is
    // at (again if they never got there), answer the ones somebody is at, and put the answered ones away.
    for (const item of situationViews(sim)) {
      if (item.state === 'answered') give({ type: 'event.dismiss', situation: item.n });
      else if (item.state === 'attended') {
        const open = item.choices.filter((choice) => choice.available);
        tally.offered += item.choices.length;
        tally.locked += item.choices.length - open.length;
        const pick = bot.pick(open).id;
        give({ type: 'event.choose', situation: item.n, choice: pick });
        if (contract.claim && item.id === contract.claim.event && pick === 'leave') tally.claimLeft = true;
      } else if (sim.state.tick - (sent.get(item.n) ?? -1e9) > 30 * TICK_RATE) {
        // Never whoever is flying her: the bot keeps the helm held (below), and would only call them back.
        // The last hand alive goes whoever they are: a ship standing by a claim with only her pilot left would wait for ever.
        const alone = ourCrew(sim).filter(({ member }) => member.alive).length === 1;
        const hand = nearestHand(sim, item.room, (member) => (alone || sim.layout.room(member.room)?.kind !== 'helm') && !item.about.includes(member.id));
        if (hand && give({ type: 'crew.move', crew: hand.id, room: item.room, ship: 'us' }) !== false) {
          sent.set(item.n, sim.state.tick);
          tally.sends += 1;
        }
      }
    }
    if (view) {
      // A decision over the radio (S3.3): answer it with any choice that is open to us, then put it away.
      if (view.result) give({ type: 'event.dismiss' });
      else {
        const open = view.choices.filter((choice) => choice.available);
        tally.offered += view.choices.length;
        tally.locked += view.choices.length - open.length;
        const pick = bot.pick(open).id;
        give({ type: 'event.choose', choice: pick });
        // Walking away from the claim (H.6: it is met by passing it): the bot makes for the drop instead.
        if (contract.claim && view.id === contract.claim.event && pick === 'leave') tally.claimLeft = true;
      }
    } else if (sim.state.boarding?.phase === 'demand') {
      // A party at the lock (H.2): pay if the money allows, otherwise let them get on with it.
      if (!whyNoBribe(sim)) give({ type: 'boarding.bribe' });
      else give({ type: 'boarding.admit' });
    } else if (!run.crossing && run.at === run.map.delivery) {
      // The drop: hand over whatever is left of the cargo, if there is a contract left to hand over.
      if (!sim.whyNot({ type: 'contract.deliver' })) give({ type: 'contract.deliver' });
      else {
        // Nothing to hand over (a claim left unworked): the captain walks away from the contract, as retiring would.
        give({ type: 'contract.abandon' });
        settled = true;
      }
    } else if (!run.crossing) {
      // In port (H.6): see to the ship, plot the route on, and cast off.
      portCall();
      const path = nextRoute();
      if (!path || sim.whyNot({ type: 'route.plot', path })) break; // stranded: nothing we can pay for
      give({ type: 'route.plot', path });
      give({ type: 'route.sail' });
    } else if (run.crossing.stalled) break; // out of fuel between ports
    else if (run.crossing.phase === 'off port' && !whyNoRunIn(sim)) give({ type: 'route.jump' });
    else if (sim.state.tick % TICK_RATE === 0) {
      // An event can leave the sensors or the engines down (S3.3), and the run in needs them: send whoever is
      // not flying to mend them. Mended, they run again by themselves (H.4). Margo's core too: with it broken
      // nobody runs the sensors unless someone sits at them, and the bot posts nobody there.
      const helm = sim.layout.rooms.find((room) => room.kind === 'helm')?.id;
      const hands = ourCrew(sim).map(({ member }) => member).filter((member) => member.alive);
      const bound = (room) => hands.some((member) => member.room === room || member.goal === room);
      // The last hand alive does the mending too, and goes back to the helm when there is none to do.
      const alone = hands.length === 1;
      const spare = (member) => alone || member.room !== helm;
      const toMend = alone && (Object.values(sim.state.rooms).some((r) => (r.fire > 0 || r.breach > 0) && !r.jettisoned) || ['ai_core', 'life_support', 'sensors', 'engines'].some((id) => sim.state.systems[id]?.damage > 0) || situationViews(sim).some((item) => item.state !== 'answered'));
      if (helm && !bound(helm) && hands.length && !toMend && hands[0].goal === null) give({ type: 'crew.move', crew: hands[0].id, room: helm });
      // A fire in the way stops the mending: whoever is idle and not flying goes to put it out. A hole lets the air
      // out of the ship, and on a long crossing that kills (H.8): whoever is free goes to patch it, suited.
      for (const [room, r] of Object.entries(sim.state.rooms)) {
        const free = hands.find((member) => spare(member) && member.goal === null && member.task === 'idle');
        if ((r.fire > 0 || r.breach > 0) && !r.jettisoned && free && !bound(room)) {
          if (r.breach > 0 && !free.suit) give({ type: 'crew.suit', crew: free.id, on: true });
          give({ type: 'crew.move', crew: free.id, room });
        }
      }
      // The doors come first: nobody walks anywhere quickly without them.
      // Then the air (H.8: a crossing is long enough now for a broken scrubber to kill everyone aboard).
      for (const id of ['doors', 'life_support', 'ai_core', 'sensors', 'engines']) {
        const system = sim.state.systems[id];
        if (sim.state.stations[id].down) give({ type: 'station.stand', station: id, down: false });
        if (running(sim, id)) continue;
        const room = sim.layout.rooms.find((item) => item.system === id)?.id;
        // Whoever is free, a different one every few seconds in case one refuses; suited if the air in there is thin.
        const free = hands.filter((member) => spare(member) && member.goal === null && member.task === 'idle');
        const hand = free.length ? free[Math.floor(sim.state.tick / (5 * TICK_RATE)) % free.length] : null;
        if (system.damage > 0 && room && hand && !bound(room)) {
          if (sim.state.rooms[room].oxygen < 0.5 && !hand.suit) give({ type: 'crew.suit', crew: hand.id, on: true });
          give({ type: 'crew.move', crew: hand.id, room });
        }
      }
    }
    rate = tempo.step(sim, TICK_SECONDS / rate);
    tally.real += TICK_SECONDS / rate;
    if (rate > 1) tally.fastTicks += 1;
    else if (run.crossing) tally.busy[tempo.reason ?? 'settling'] = (tally.busy[tempo.reason ?? 'settling'] ?? 0) + 1;
    sim.step();
    if (sim.state.tick % 20 === 0) {
      const problems = checkInvariants(sim);
      if (problems.length) throw new Error(`invariant broken at tick ${sim.state.tick}: ${problems[0]}`);
      // Who has each station this second (H.4): one of ours, Margo, or nobody.
      for (const id of POSTS) {
        const by = sim.state.stations[id].by;
        tally.staff[by === null ? 'dark' : by === 'margo' ? 'margo' : 'crew'] += 1;
        if (rating(sim, id) > 1) tally.staff.well += 1;
        tally.staff.samples += 1;
        // How Margo ran what she held (H.5).
        if (by === 'margo' && MANNER_STATIONS.includes(id)) {
          tally.margo[sim.state.stations[id].runs] += 1;
          tally.margo.rating += rating(sim, id);
          tally.margo.held += 1;
        }
      }
      const { ai } = sim.state;
      tally.margo.samples += 1;
      if (ai.alert === 'hunted') tally.margo.hunted += 1;
      if (ai.alert === 'found') tally.margo.found += 1;
      if (ai.stretched) tally.margo.stretched += 1;
      tally.tired = Math.max(tally.tired, ...ourCrew(sim).map(({ member }) => (member.alive ? member.fatigue : 0)));
      // Where the ship hours went (H.6): under way (and at what pace), held, off a port, or in port.
      const t = tally.time;
      if (!run.crossing) t.port += 1;
      else if (run.crossing.phase === 'off port') t.off += 1;
      else if (heldReason(sim)) t.held += 1;
      else {
        t.under += 1;
        t.pace += paceOf(sim);
        if (paceOf(sim) <= COAST) t.coast += 1;
      }
    }
  }
  if (!settled && !lost && !crewDead && sim.state.tick >= end) throw new Error(`still crossing after ${CROSSING_MINUTES} minutes, at ${run.at} with ${run.fuel} fuel (${run.crossing ? `${run.crossing.phase}, lane ${run.crossing.leg}: ${whyNoRunIn(sim)}` : `in port: ${sim.whyNot({ type: 'route.plot', path: nextRoute() })}`})`);
  const bad = findBadNumbers(sim.state);
  if (bad.length) throw new Error(`non-finite numbers at ${bad.join(', ')}`);
  if (Math.max(0, ...tally.contactSeconds) > CONTACT_MOST_SECONDS) throw new Error(`a ship was on our hands for ${Math.max(...tally.contactSeconds).toFixed(0)} s of the clock: the most is ${CONTACT_MOST_SECONDS}`);
  return {
    ...tally,
    nodes: run.map.nodes.length,
    lanes: run.map.lanes.length,
    cheapest: cheapestRoute(run.map, run.map.start, run.map.delivery).legs,
    cheapestHours: cheapestRoute(run.map, run.map.start, run.map.delivery).hours,
    deadline: run.deadline,
    followed: Boolean(run.pursuit),
    delivered: run.delivered,
    late: run.late,
    lost,
    crewDead,
    dead: ourCrew(sim).filter(({ member }) => !member.alive).length,
    trust: sim.state.ai.trust,
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
    legs: run.legs,
    hours: run.hours,
    fuelLeft: run.fuel,
    minutes: sim.state.tick / TICK_RATE / 60,
    clockMinutes: tally.real / 60,
    ticks: sim.state.tick,

    hash: hashState(sim.snapshot()),
  };
}

// A contact is over in about a minute and a half (F.1): one still going after three is a failure.
const ENCOUNTER_MINUTES = 3;
/** The longest a contact may last by the bot's clock, in seconds (PLAN F.1: "longest under 3 min"). */
const CONTACT_MOST_SECONDS = 180;
/** How far the deterrent gun reaches, in scope units (0 with no gun fitted). */
const gunReach = (sim) => (gunSlot(sim) >= 0 ? sim.catalog.weapon(sim.state.weapons[gunSlot(sim)].id).range : 0);
/** What the encounter bot can try. Each seed gives each kind of contact one of them, in turn. */
const TACTICS = Object.freeze(['nothing', 'quiet', 'run', 'flare', 'crate', 'bluff', 'gun', 'pay']);
/** No one answer may get away from more than this share of contacts in the encounter mode (PLAN F.2). */
const ANSWER_MOST = 0.8;

/**
 * One contact on the scope (H.1) and a bot with one idea. Throws on any failure, including an
 * encounter that has not ended after ENCOUNTER_MINUTES. The encounter is over when the contact is: a
 * party that docks goes on to its boarding (H.2), which the boardings below play out. Since H.3:
 *   gun   lay the deterrent gun on it the moment it closes, fetch rounds when empty, and brace into
 *         rounds coming the other way
 *   pay   pay a toll when one is called; otherwise sit tight (a party's price at the lock is the boardings' bribe)
 */
function playEncounter(seed, def, tactic) {
  const sim = createSim({ seed, ship, crew: roster, watches: 2, margo: 'own', lines, weapons, rules: ruleSet, encounters: encounterDefs });
  const bot = createRng(`encounter:${def.id}:${tactic}:${seed}`);
  const end = ENCOUNTER_MINUTES * 60 * TICK_RATE;
  const give = (command) => !sim.whyNot(command) && sim.enqueue(command);
  const tally = { encounter: def.id, wants: def.wants, tactic, outcome: null, seconds: 0, stages: [], pings: 0, sighted: null, named: false, noticed: false, fooled: 0, hails: 0, flares: 0, crates: 0, shots: 0, struck: 0, incoming: 0, hits: 0, braced: 0, downed: 0, hull: 0, wrecked: false, burned: 0, cold: 0, standing: 0, marks: 0, spent: 0 };
  sim.state.money = 200; // enough for a toll or a bribe, so paying is a real answer
  sim.events.on('weapon.fired', () => (tally.shots += 1));
  sim.events.on('pod.downed', () => (tally.downed += 1));
  sim.events.on('drone.lost', ({ cause }) => cause === 'pd' && (tally.downed += 1));
  sim.events.on('ship.wrecked', () => (tally.wrecked = true));
  sim.events.on('shot.resolved', ({ at, result }) => {
    if (at === 'contact') tally.struck += result === 'hit' ? 1 : 0;
    else if (result !== 'warning') {
      tally.incoming += 1;
      tally.hits += result === 'hit' ? 1 : 0;
      tally.braced += result === 'shield' ? 1 : 0;
    }
  });
  sim.events.on('contact.sighted', () => (tally.sighted ??= sim.state.tick / TICK_RATE));
  sim.events.on('contact.stage', (event) => tally.stages.push(event.stage));
  sim.events.on('contact.pinged', () => (tally.pings += 1));
  sim.events.on('contact.identified', () => (tally.named = true));
  sim.events.on('contact.noticed', () => (tally.noticed = true));
  sim.events.on('contact.fooled', () => (tally.fooled += 1));
  sim.events.on('contact.hailed', () => (tally.hails += 1));
  sim.events.on('reputation.changed', ({ from, to }) => (tally.standing += to - from));
  sim.events.on('encounter.ended', (event) => {
    tally.outcome ??= event.outcome;
    tally.seconds = event.seconds;
  });
  const spawn = { range: bot.range(SPAWN.near, SPAWN.far), bearing: bot.range(0, 360), miss: bot.range(0, SPAWN.miss) };
  const stand = (station, down) => sim.state.stations[station].down !== down && give({ type: 'station.stand', station, down });
  // Going quiet is everything off that shows (F.2): the lamps, the sensors, the drive and the air plant, so the ship goes cold.
  const dark = () => {
    give({ type: 'lights.all', on: false });
    for (const station of ['sensors', 'engines', 'life_support']) stand(station, true);
  };
  const fullBurn = (heading) => {
    // All the drive has: the engineer off the reactor and onto the engines.
    stand('engines', false);
    const engineer = ourCrew(sim).map(({ member }) => member).find((member) => member.alive && member.role === 'engineer');
    if (engineer && engineer.post !== 'engines') give({ type: 'crew.post', crew: engineer.id, station: 'engines' });
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
      } else if (tactic === 'gun') {
        // The lamps go off, and the guns and the shields are stood to.
        give({ type: 'lights.all', on: false });
        for (const station of ['weapons', 'shields']) stand(station, false);
        // Laid on anything that has found us and come inside the gun's reach, shadowing or closing (H.8: waiting
        // for it to close left one round, if that, before a skiff was alongside).
        if (view.state !== 'unseen' && (view.range <= gunReach(sim) || view.state === 'alongside' || sim.state.scope.contacts.find((item) => item.id === view.id)?.tolled)) give({ type: 'gun.target', contact: view.id });
        const slot = gunSlot(sim);
        const hand = ourCrew(sim).map(({ member }) => member).find((member) => member.alive && !member.job && member.task === 'idle' && member.room !== 'bridge');
        if (slot >= 0 && sim.state.weapons[slot].rounds === 0 && hand) give({ type: 'weapon.load', crew: hand.id, slot });
        if (sim.state.shots.some((shot) => shot.at === 'us')) give({ type: 'ship.brace' });
      } else if (tactic === 'pay') {
        give({ type: 'contact.pay', contact: view.id });
      } else if (tactic === 'bluff') {
        if (view.state === 'shadowing' || view.state === 'closing' || view.state === 'alongside') {
          const contact = sim.state.scope.contacts.find((item) => item.id === view.id);
          const best = Object.keys(BLUFFS).sort((a, b) => bluffChance(sim, contact, b) - bluffChance(sim, contact, a))[0];
          give({ type: 'contact.hail', contact: view.id, bluff: best });
        }
      }
    }
    sim.step();
    // What the answer costs (F.2): seconds of the drive at full push, and seconds with someone aboard slowed by the cold.
    tally.burned += burn(sim) * TICK_SECONDS;
    if (ourCrew(sim).some(({ member }) => member.alive && chill(sim, member) < 1)) tally.cold += TICK_SECONDS;
    if (sim.state.tick % 20 === 0) {
      const problems = checkInvariants(sim);
      if (problems.length) throw new Error(`invariant broken at tick ${sim.state.tick}: ${problems[0]}`);
    }
  }
  tally.marks = sim.state.scope.marks.length;
  tally.spent = 200 - sim.state.money;
  if (!tally.outcome) throw new Error(`the ${def.id} was still on the scope after ${ENCOUNTER_MINUTES} minutes (${sim.state.scope.contacts.map((contact) => contact.state).join(', ') || 'no contact'})`);
  tally.hull = sim.state.hull.points;
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
  const sim = createSim({ seed, ship, crew: roster, watches: 2, margo: 'own', lines, weapons, rules: ruleSet, encounters: encounterDefs });
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
const totals = { orders: 0, refused: 0, dropped: 0, doorMoves: 0, pauses: 0, powerMoves: 0, brownouts: 0, darkTicks: 0, fires: 0, spreads: 0, firesOut: 0, scorched: 0, jettisons: 0, airlessTicks: 0, moves: 0, arrivals: 0, blocked: 0, deaths: 0, firesFought: 0, patches: 0, repairs: 0, contacts: 0, shots: 0, struck: 0, incoming: 0, hits: 0, absorbed: 0, missed: 0, warnings: 0, downed: 0, deterred: 0, boardedUs: 0, melee: 0, said: 0, argued: 0, margoRefused: 0, overrides: 0, stoodDown: 0, lapsed: 0, crewRefused: 0, scares: 0, lamps: 0 };
const scenarios = [];
const chaosEndings = {};
const underFire = [];
const crossings = [];
const encounters = [];
const boardings = [];
for (let i = 1; i <= runs; i++) {
  const seed = `${baseSeed}-${i}`;
  if (only.has('crossing')) try {
    const [first, second] = twice(() => playCrossing(seed, i - 1));
    if (first.hash !== second.hash) failures.push({ seed, reason: `crossing replay mismatch (${first.hash} vs ${second.hash})` });
    crossings.push(first);
  } catch (err) {
    failures.push({ seed, reason: `crossing: ${err.message}` });
  }
  encounterDefs.forEach((def, index) => {
    const tactic = TACTICS[(i - 1 + index) % TACTICS.length];
    if (only.has('encounter')) try {
      const [first, second] = twice(() => playEncounter(seed, def, tactic));
      if (first.hash !== second.hash) failures.push({ seed, reason: `encounter with ${def.id}: replay mismatch (${first.hash} vs ${second.hash})` });
      encounters.push(first);
    } catch (err) {
      failures.push({ seed, reason: `encounter with ${def.id} (${tactic}): ${err.message}` });
    }
    if (!def.party || !only.has('boarding')) return;
    const answer = ANSWERS[(i - 1 + index) % ANSWERS.length];
    try {
      const [first, second] = twice(() => playBoarding(seed, def, answer));
      if (first.hash !== second.hash) failures.push({ seed, reason: `boarding by ${def.id}: replay mismatch (${first.hash} vs ${second.hash})` });
      boardings.push(first);
    } catch (err) {
      failures.push({ seed, reason: `boarding by ${def.id} (${answer}): ${err.message}` });
    }
  });
  if (only.has('chaos')) try {
    const [first, second] = twice(() => playRun(seed));
    if (first.hash !== second.hash) failures.push({ seed, reason: `chaos replay mismatch (${first.hash} vs ${second.hash})` });
    for (const key of Object.keys(totals)) totals[key] += first[key];
    for (const [outcome, n] of Object.entries(first.endings)) chaosEndings[outcome] = (chaosEndings[outcome] ?? 0) + n;
  } catch (err) {
    failures.push({ seed, reason: `chaos: ${err.message}` });
  }
  if (only.has('scenario')) try {
    const [first, second] = twice(() => playScenario(seed));
    if (first.hash !== second.hash) failures.push({ seed, reason: `scenario replay mismatch (${first.hash} vs ${second.hash})` });
    scenarios.push(first);
  } catch (err) {
    failures.push({ seed, reason: `scenario: ${err.message}` });
  }
  if (only.has('fire')) try {
    const [first, second] = twice(() => playScenario(seed, { incoming: true }));
    if (first.hash !== second.hash) failures.push({ seed, reason: `under fire replay mismatch (${first.hash} vs ${second.hash})` });
    underFire.push(first);
  } catch (err) {
    failures.push({ seed, reason: `under fire: ${err.message}` });
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
out.push(`  runs:              ${runs} (seeds ${baseSeed}-1 to ${baseSeed}-${runs}), each played as chaos, as a hazard scenario, under fire, as a sector crossing, as an encounter with every kind of contact and as a boarding by every kind of party, each twice`);
out.push(`  ship:              ${ship.name}, crew of ${roster.length}, ${lines.length} AI lines`);
out.push(`  crashed or bad:    ${failures.length}`);
out.push('');
out.push(`Chaos (${minutes} game minutes each, ${ticks} ticks): a bot doing everything at random`);
out.push(`  orders per run:    ${per(totals.orders)} given, ${per(totals.refused)} refused up front, ${per(totals.dropped)} dropped`);
out.push(`  door moves:        ${per(totals.doorMoves)} completed per run`);
out.push(`  power per run:     ${per(totals.powerMoves)} switches thrown, ${per(totals.brownouts)} brownouts, door control dark ${((100 * totals.darkTicks) / (runs * ticks)).toFixed(0)}% of the time`);
out.push(`  hazards per run:   ${per(totals.fires)} fires lit, ${per(totals.spreads)} spread, ${per(totals.firesOut)} went out, ${per(totals.scorched)} system bars burned, ${per(totals.jettisons)} rooms jettisoned`);
out.push(`  crew per run:      ${per(totals.moves)} sent, ${per(totals.arrivals)} arrived, ${per(totals.blocked)} blocked, ${per(totals.deaths)} of ${roster.length} died`);
out.push(`  crew work per run: ${per(totals.firesFought)} fires put out, ${per(totals.patches)} breaches patched, ${per(totals.repairs)} system bars repaired`);
out.push(`  air:               rooms were unbreathable ${((100 * totals.airlessTicks) / (runs * ticks * ship.rooms.length)).toFixed(0)}% of room-time`);
out.push(`  contacts per run:  ${per(totals.contacts)} put on the scope; our gun fired ${per(totals.shots)} times and struck ${per(totals.struck)}; ${per(totals.deterred)} driven off by it; point defence downed ${per(totals.downed)} drones and pods`);
out.push(`  incoming per run:  ${per(totals.incoming)} rounds and zaps at us: ${per(totals.hits)} hit, ${per(totals.absorbed)} stopped by a brace, ${per(totals.missed)} missed, ${per(totals.warnings)} warning shots`);
out.push(`  boarders per run:  ${per(totals.boardedUs)} came aboard, ${per(totals.melee)} killed hand to hand`);
out.push(`  contact endings:   ${Object.keys(ENDINGS).map((k) => `${ENDINGS[k].toLowerCase()} ${chaosEndings[k] ?? 0}`).join(', ')}`);
out.push(`  AI lines per run:  ${per(totals.said)} (about one every ${totals.said ? Math.round((runs * minutes * 60) / totals.said) : 0} seconds)`);
out.push(`  pauses per run:    ${per(totals.pauses)} (state checked every eighth paused frame and the last)`);
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
out.push(`  her trust:         ${mean(scenarios.map((s) => s.trust)).toFixed(0)} of 100 at the end of a hazard scenario, ${mean(underFire.map((s) => s.trust)).toFixed(0)} under fire (it starts at 50)`);
out.push('');
const followed = crossings.filter((c) => c.followed);
const sumOf = (key) => crossings.reduce((n, c) => n + c[key], 0);
const crossOutcomes = {};
for (const c of crossings) for (const [k, n] of Object.entries(c.outcomes)) crossOutcomes[k] = (crossOutcomes[k] ?? 0) + n;
out.push(`Crossings (S3.1; routes and lanes since H.6): the run's sector chart from the origin to the drop, port to port`);
out.push(`  charts:            ${mean(crossings.map((c) => c.nodes)).toFixed(1)} points and ${mean(crossings.map((c) => c.lanes)).toFixed(1)} lanes on average (${Math.min(...crossings.map((c) => c.nodes))} to ${Math.max(...crossings.map((c) => c.nodes))} points); cheapest way across ${mean(crossings.map((c) => c.cheapest)).toFixed(1)} lanes and ${mean(crossings.map((c) => c.cheapestHours)).toFixed(1)} hours, deadline ${mean(crossings.map((c) => c.deadline)).toFixed(1)} hours`);
out.push(`  delivered:         ${crossings.filter((c) => c.delivered).length} of ${crossings.length}, ${crossings.filter((c) => c.late).length} late; ship lost ${crossings.filter((c) => c.lost).length}, stranded ${crossings.filter((c) => c.stranded).length}`);
out.push(`  routes:            ${mean(crossings.map((c) => c.routes)).toFixed(1)} routes (port to port) and ${mean(crossings.map((c) => c.legs)).toFixed(1)} lanes a run, ${sumOf('quick')} of the routes the quickest rather than the cheapest; ${mean(crossings.map((c) => c.hours)).toFixed(1)} ship hours under way; ${mean(crossings.map((c) => c.fuelLeft)).toFixed(1)} fuel left; ${mean(crossings.map((c) => c.minutes)).toFixed(1)} game minutes`);
const time = crossings.reduce((sum, c) => Object.fromEntries(Object.entries(sum).map(([k, v]) => [k, v + c.time[k]])), { under: 0, coast: 0, held: 0, off: 0, port: 0, pace: 0 });
const allTime = time.under + time.held + time.off + time.port;
out.push(`  the clock:         under way ${pct(time.under, allTime)} of the time at ${(time.pace / Math.max(1, time.under)).toFixed(2)} of the lane's pace (coasting ${pct(time.coast, time.under)} of that), held ${pct(time.held, allTime)}, off a port working the fix ${pct(time.off, allTime)}, in port ${pct(time.port, allTime)}`);
{
  // The tempo (H.8): how long a crossing takes by hand, at the speed a player's clock would run it.
  const fastShare = crossings.reduce((n, c) => n + c.fastTicks, 0) / Math.max(1, crossings.reduce((n, c) => n + c.ticks, 0));
  const perRoute = crossings.map((c) => c.clockMinutes / Math.max(1, c.routes)).sort((a, b) => a - b);
  const busy = {};
  for (const c of crossings) for (const [k, n] of Object.entries(c.busy)) busy[k] = (busy[k] ?? 0) + n;
  const busyAll = Object.values(busy).reduce((a, b) => a + b, 0);
  out.push(`  by hand (H.8):     ${mean(crossings.map((c) => c.clockMinutes)).toFixed(1)} minutes of running clock a run with fast time (fast ${pct(fastShare, 1)} of ship time); a crossing port to port ${mean(perRoute).toFixed(1)} minutes (${perRoute.length ? perRoute[0].toFixed(1) : '-'} to ${perRoute.length ? perRoute.at(-1).toFixed(1) : '-'})`);
  const died = {};
  for (const c of crossings) for (const [k, n] of Object.entries(c.died)) died[k] = (died[k] ?? 0) + n;
  out.push(`  crew lost:         ${mean(crossings.map((c) => c.dead)).toFixed(2)} a run; by cause ${Object.entries(died).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}`);
  out.push(`  normal speed for:  ${Object.entries(busy).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${pct(n, busyAll)}`).join(', ') || 'nothing'}`);
}
const byRisk = {};
for (const c of crossings) for (const [k, n] of Object.entries(c.risks)) byRisk[k] = (byRisk[k] ?? 0) + n;
out.push(`  lanes:             ships met by the lane that brought them: ${Object.entries(byRisk).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}; ${sumOf('strikes')} hull strikes in hazard lanes`);
out.push(`  followed:          ${followed.length} of ${crossings.length}; the follower found us ${followed.reduce((n, c) => n + c.caught, 0)} times (in ${pct(followed.filter((c) => c.caught > 0).length, followed.length)} of followed runs), and Margo saw it on the scope in ${pct(followed.filter((c) => c.sighted > 0).length, followed.length)}`);
out.push(`  the pursuer:       ${Object.entries(crossOutcomes).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${ENDINGS[k].toLowerCase()} ${n}`).join(', ') || 'never closed'}`);
out.push(`  guns and braces:   ${mean(crossings.map((c) => c.shots)).toFixed(1)} rounds fired, ${mean(crossings.map((c) => c.braces)).toFixed(1)} braces and ${mean(crossings.map((c) => c.tolls)).toFixed(1)} tolls paid a crossing`);
out.push(`  Margo on the chart: ${mean(crossings.map((c) => c.lines)).toFixed(1)} lines a crossing`);
const merged = (key) => {
  const all = {};
  for (const c of crossings) for (const [k, n] of Object.entries(c[key])) all[k] = (all[k] ?? 0) + n;
  return Object.entries(all).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
};
out.push('');
out.push(`Events (S3.3): what the crossings met, from content/events/ (${transitEvents.length} events)`);
out.push(`  met:               ${mean(crossings.map((c) => c.events)).toFixed(1)} a crossing (${sumOf('events')} in all), ${sumOf('lapsed')} left behind unanswered; crew all dead in ${crossings.filter((c) => c.crewDead).length} crossings`);
out.push(`  aboard (H.7):      ${sumOf('placed')} situations put in a room, ${sumOf('attended')} had somebody get to them (the bot sent a hand ${sumOf('sends')} times)`);
out.push(`  choices:           ${sumOf('offered')} shown, ${sumOf('locked')} of them locked behind a requirement the crew did not meet (${pct(sumOf('locked'), sumOf('offered'))})`);
out.push(`  led to:            ${sumOf('eventContacts')} ships put on the scope, ${sumOf('hooks')} scene or threat hooks`);
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
{
  const answers = {};
  for (const c of crossings) for (const [k, n] of Object.entries(c.answers)) answers[k] = (answers[k] ?? 0) + n;
  out.push(`  careful answers:   from what the scope said of each hunting ship (F.2): ${Object.entries(answers).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}; ${sumOf('fuelBurned')} fuel burned running from them`);
}
out.push(`  standing:          ${mean(crossings.map((c) => c.standing)).toFixed(2)} a crossing on average, all factions together`);
out.push('');
const endingList = (list) => Object.keys(ENDINGS).map((k) => [k, list.filter((e) => e.outcome === k).length]).filter(([, n]) => n > 0).map(([k, n]) => `${ENDINGS[k].toLowerCase()} ${n}`).join(', ') || 'none';
/** A contact got what it came for: it docked, it finished its scan, it spent its drones on us, or an unpaid toll came out of our hull (F.2). */
const caught = (e) => ['docked', 'scanned', 'swarmed'].includes(e.outcome) || (e.wants === 'toll' && e.outcome !== 'paid' && e.hull < ship.hullPoints);
const slipped = (list) => list.filter((e) => !caught(e)).length;
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
{
  // Stations and shifts (H.4): who ran the ship on the crossings.
  const staff = crossings.reduce((sum, c) => ({ crew: sum.crew + c.staff.crew, margo: sum.margo + c.staff.margo, dark: sum.dark + c.staff.dark, well: sum.well + c.staff.well, samples: sum.samples + c.staff.samples }), { crew: 0, margo: 0, dark: 0, well: 0, samples: 0 });
  {
  // Being hunted (F.1): how long a ship is on our hands, and whether the stages of its awareness all turn up.
  const median = (values) => (values.length ? [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] : 0);
  const alone = encounters.map((e) => e.seconds);
  const lanes = crossings.flatMap((c) => c.contactSeconds);
  const met = (ok) => (ok ? 'met' : 'NOT MET');
  out.push(`Being hunted (F.1): how long a contact lasts, from turning up to its ending (target: median under 90 s, longest under ${CONTACT_MOST_SECONDS} s)`);
  out.push(`  one at a time:     median ${median(alone).toFixed(0)} s, mean ${mean(alone).toFixed(0)} s, longest ${Math.max(0, ...alone).toFixed(0)} s over ${alone.length} encounters at normal speed: ${alone.length ? met(median(alone) < 90 && Math.max(...alone) < CONTACT_MOST_SECONDS) : 'none played'}`);
  out.push(`  on the crossings:  median ${median(lanes).toFixed(0)} s, mean ${mean(lanes).toFixed(0)} s, longest ${Math.max(0, ...lanes).toFixed(0)} s over ${lanes.length} contacts by the bot's clock (fast time while nothing has noticed us): ${lanes.length ? met(median(lanes) < 90 && Math.max(...lanes) < CONTACT_MOST_SECONDS) : 'none met'}`);
  const stages = {};
  for (const e of encounters) for (const stage of new Set(e.stages)) stages[stage] = (stages[stage] ?? 0) + 1;
  out.push(`  its awareness:     of ${encounters.length} encounters, ${Object.keys(STAGES_OF_AWARENESS).filter((k) => k !== 'passing').map((k) => `${STAGES_OF_AWARENESS[k].toLowerCase()} in ${stages[k] ?? 0}`).join(', ')}; ${encounters.reduce((n, e) => n + e.pings, 0)} pings`);
  const looks = crossings.reduce((n, c) => ({ found: n.found + c.looks.found, blank: n.blank + c.looks.blank }), { found: 0, blank: 0 });
  out.push(`  its sweep:         on the crossings a search beam crossed us ${looks.found + looks.blank} times and read something ${pct(looks.found, looks.found + looks.blank)} of them; ${crossings.reduce((n, c) => n + c.pings, 0)} pings, ${crossings.reduce((n, c) => n + c.pingsFound, 0)} of which found us`);
}
out.push(`Stations and shifts (H.4): two watches on the crossings, ${POSTS.length} stations for ${roster.length} crew`);
  out.push(`  who had them:      crew ${pct(staff.crew, staff.samples)}, Margo ${pct(staff.margo, staff.samples)}, dark ${pct(staff.dark, staff.samples)} of station time; run better than the book ${pct(staff.well, staff.samples)}`);
  out.push(`  the watch:         ${mean(crossings.map((c) => c.watchChanges)).toFixed(1)} changes a crossing; the most tired hand reached ${Math.round(100 * mean(crossings.map((c) => c.tired)))}% on average (worst ${Math.round(100 * Math.max(...crossings.map((c) => c.tired)))}%)`);
}
{
  // Margo runs what nobody mans (H.5): the crossings side by side, by who ran the ship, and what she did with it.
  out.push(`Margo runs what nobody mans (H.5): the crossings by who ran the ship`);
  for (const mode of ['crew', 'margo', 'book']) {
    const of = crossings.filter((c) => c.mode === mode);
    if (!of.length) continue;
    const met = of.reduce((n, c) => n + Object.values(c.contacts).reduce((a, b) => a + b, 0), 0);
    const docked = of.reduce((n, c) => n + (c.contacts.docked ?? 0), 0);
    const label = { crew: 'crew at posts', margo: 'all to Margo', book: 'Margo, by book' }[mode];
    out.push(`  ${label.padEnd(17)}  ${of.length} crossings: delivered ${pct(of.filter((c) => c.delivered).length, of.length)} (${of.filter((c) => c.late).length} late), ship lost ${of.filter((c) => c.lost).length}; ${mean(of.map((c) => c.minutes)).toFixed(1)} min and ${mean(of.map((c) => c.hours)).toFixed(1)} ship hours; ${met} contacts, ${pct(docked, met)} docked with us; ${mean(of.map((c) => c.dead)).toFixed(1)} crew dead; trust ends at ${mean(of.map((c) => c.trust)).toFixed(0)}`);
  }
  const her = crossings.reduce((sum, c) => {
    for (const key of Object.keys(sum)) sum[key] += c.margo[key];
    return sum;
  }, { quiet: 0, book: 0, push: 0, rating: 0, held: 0, samples: 0, hunted: 0, found: 0, stretched: 0, ownWay: 0, doubt: 0, changes: 0 });
  out.push(`  her choices:       of the station time she held, quiet ${pct(her.quiet, her.held)}, by the book ${pct(her.book, her.held)}, pushed ${pct(her.push, her.held)}; her stations ran at ${(her.rating / Math.max(1, her.held)).toFixed(2)} on average`);
  out.push(`  her picture:       something hunting us ${pct(her.hunted, her.samples)} and on us ${pct(her.found, her.samples)} of the time; more to watch than she could ${pct(her.stretched, her.samples)}; ${(her.changes / Math.max(1, crossings.length)).toFixed(1)} changes of her own a crossing`);
  out.push(`  her orders:        on the by-the-book crossings (half of them begun at trust 30) she ran a station her own way ${crossings.reduce((n, c) => n + c.margo.ownWay, 0)} times and said she would not ${crossings.reduce((n, c) => n + c.margo.doubt, 0)} times`);
}
{
  // Every escape costs (F.2): which answer gets away from which kind of contact, and what it cost.
  out.push(`Every escape costs (F.2): got away, by kind of contact and the bot's one answer (target: no answer gets away from more than ${Math.round(100 * ANSWER_MOST)}%, and each is the best against at least one kind)`);
  const away = (list) => (list.length ? list.filter((e) => !caught(e)).length / list.length : null);
  const cell = (share) => (share === null ? '  -' : `${Math.round(100 * share)}`.padStart(3) + '%');
  out.push(`  ${''.padEnd(18)} ${TACTICS.map((t) => t.padStart(7)).join('')}`);
  const bestOf = {};
  for (const def of encounterDefs) {
    const shares = TACTICS.map((t) => away(encounters.filter((e) => e.encounter === def.id && e.tactic === t)));
    const top = Math.max(...shares.map((x) => x ?? -1));
    TACTICS.forEach((t, i) => { if (t !== 'nothing' && shares[i] !== null && shares[i] >= top - 1e-9) (bestOf[t] ??= []).push(def.id); });
    out.push(`  ${def.id.padEnd(18)} ${shares.map((x) => cell(x).padStart(7)).join('')}`);
  }
  const overall = TACTICS.map((t) => away(encounters.filter((e) => e.tactic === t)));
  out.push(`  ${'all kinds'.padEnd(18)} ${overall.map((x) => cell(x).padStart(7)).join('')}`);
  const tooGood = TACTICS.filter((t, i) => overall[i] !== null && overall[i] > ANSWER_MOST);
  const neverBest = TACTICS.filter((t) => t !== 'nothing' && !bestOf[t]);
  for (const t of TACTICS.filter((x) => x !== 'nothing')) {
    const of = encounters.filter((e) => e.tactic === t);
    const avg = (key) => mean(of.map((e) => e[key]));
    out.push(`  cost of ${t.padEnd(10)} drive ${avg('burned').toFixed(0)} s at full push, someone cold ${avg('cold').toFixed(0)} s, hull ${mean(of.map((e) => ship.hullPoints - e.hull)).toFixed(1)}, ${avg('spent').toFixed(0)} credits, standing ${avg('standing').toFixed(1)} (and ${of.reduce((n, e) => n + e.marks, 0)} lies to be found out), ${avg('flares').toFixed(1)} flares, ${avg('crates').toFixed(1)} crates, ${avg('shots').toFixed(1)} rounds`);
  }
  out.push(`  dominance:         ${tooGood.length ? `NOT MET: ${tooGood.join(', ')} get away from more than ${Math.round(100 * ANSWER_MOST)}%` : 'met'}; best against a kind: ${TACTICS.filter((t) => t !== 'nothing').map((t) => `${t} ${bestOf[t]?.join('/') ?? 'NONE'}`).join(', ')}${neverBest.length ? ` (NOT MET: ${neverBest.join(', ')})` : ''}`);
}
out.push(`Guns as deterrents (H.3): the same encounters, by what was fired and what it did`);
for (const def of encounterDefs) {
  const of = encounters.filter((e) => e.encounter === def.id);
  const sum = (key) => of.reduce((n, e) => n + e[key], 0);
  out.push(`  ${def.id.padEnd(18)} at us ${(sum('incoming') / Math.max(1, of.length)).toFixed(1)} a time (${pct(sum('hits'), sum('incoming'))} hit, ${pct(sum('braced'), sum('incoming'))} braced); hull lost ${mean(of.map((e) => ship.hullPoints - e.hull)).toFixed(1)}, wrecked ${of.filter((e) => e.wrecked).length}; our gun ${(sum('shots') / Math.max(1, of.length)).toFixed(1)} rounds, ${sum('struck')} struck; ${sum('downed')} drones and pods downed`);
}
const gunners = encounters.filter((e) => e.tactic === 'gun');
out.push(`  the gun bot:       fired ${mean(gunners.map((e) => e.shots)).toFixed(1)} rounds an encounter and drove off ${pct(gunners.filter((e) => e.outcome === 'deterred').length, gunners.length)} of what it met (${pct(gunners.filter((e) => e.outcome === 'deterred').length, gunners.filter((e) => e.outcome !== 'passed').length)} of those that ever noticed us); it never aims at a room`);
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
  : 'PASSED: no crashes, no stuck doors, no crew stuck on a path, no station run by nobody, no fire without air, no crossing left unfinished, no contact left on the scope, no party left aboard, nothing moved while paused, every run replays from its seed.';

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
