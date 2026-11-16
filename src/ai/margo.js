// Margo runs what nobody mans (H.5, D-154, D-187 to D-192). DOM-free.
//
// H.4 gave every system a station and let Margo run, by the book, any
// station nobody was on. Here she runs them her own way. Three things decide
// what she does with a station she holds:
//
//   her priorities  the personality file: the same number of crew at the end
//                   as at the start, then the route, and the guns last. When
//                   something is hunting us (as far as she can tell) she runs
//                   what she holds quiet; when it has found us she pushes the
//                   drive; thin air and the hurt come first whatever is out
//                   there. Her attention (stations.js, MARGO) goes the same
//                   way.
//   her trust       the captain may give a standing order for a station:
//                   quiet, by the book, or push. With trust at TRUST.goesAlong
//                   or more she does it without a word; from OWN_WAY up she
//                   does it and says she would not; below OWN_WAY she runs it
//                   her own way while she disagrees, says so, and goes back
//                   to the order when her reason has passed. She disagrees
//                   only when she has a reason (something out there, thin
//                   air, the hurt, boarders): otherwise she does as told.
//   her damage      a damaged core has less attention to go round (stations.js).
//
// She can be wrong (S6.4 later makes her sensor reports wrong): she reads the
// scope as it shows, not the contacts as they are. A return whose intent
// cannot be read, near enough, is something hunting us as far as she is
// concerned; a ship on its own course that the scope cannot see is nothing.
//
// A bare test sim's Margo (`ai.mind` 'book') has no way of her own: she runs
// everything by the book, or as she is told, at once.

import { contactView } from '../sim/encounters.js';
import { MANNER_STATIONS, margoLoad, needOf, roomOfStation } from '../sim/stations.js';
import { TRUST } from './judgement.js';

const TICKS = 20; // per second (DECISIONS D-002)

/** Below this trust she runs a station her own way against the captain's standing order (D-190). */
export const OWN_WAY = 40;
/** An unreadable return nearer than this she takes for something hunting us; a scare lasts at least HOLD seconds. */
export const ALERT = Object.freeze({ suspect: 70, hold: 10 });
/** What she believes is going on outside, in rising order. */
export const ALERTS = Object.freeze(['calm', 'hunted', 'found']);

export function newMargoState(mind = 'book') {
  return {
    mind, // 'own': she runs what nobody mans her own way (H.5). 'book': by the book, or as ordered (a bare sim)
    alert: 'calm', // what she believes is going on outside: calm, hunted, found
    alertUntil: 0, // she does not stand down from an alert before this tick
    stretched: false, // more of her stations need her than she has attention for
  };
}

/** What she makes of the scope and the ship: 'calm', 'hunted' (something is looking for us) or 'found' (it is on us). */
export function alertNow(sim) {
  const { state } = sim;
  if (state.boarding || state.shots.some((shot) => shot.at === 'us') || state.scope.drones.some((drone) => drone.on)) return 'found';
  let alert = 'calm';
  for (const contact of state.scope.contacts) {
    if (contact.state === 'lost') continue;
    // She reads the scope, not the sky: what it shows, where it shows it.
    const view = contactView(sim, contact);
    if (!view || view.stale) continue;
    if (view.state === 'closing' || view.state === 'alongside' || view.state === 'docked') return 'found';
    if (view.state === 'shadowing' || (view.state === null && view.range < ALERT.suspect)) alert = 'hunted';
  }
  return alert;
}

/**
 * How she would run a station if it were left to her: { manner, why }. `why` is her reason when it is not
 * plain book: air, hurt, boarded, hunted, found, calm.
 */
export function herWay(sim, id, alert = sim.state.ai.alert) {
  const hunted = alert === 'hunted';
  switch (id) {
    case 'life_support':
      if (needOf(sim, id) === 2) return { manner: 'push', why: 'air' };
      return hunted ? { manner: 'quiet', why: 'hunted' } : { manner: 'book', why: null };
    case 'medbay':
      if (needOf(sim, id) === 2) return { manner: 'push', why: 'hurt' };
      return hunted ? { manner: 'quiet', why: 'hunted' } : { manner: 'book', why: null };
    case 'doors':
      if (sim.state.boarding) return { manner: 'push', why: 'boarded' };
      return hunted ? { manner: 'quiet', why: 'hunted' } : { manner: 'book', why: null };
    case 'sensors':
      return hunted ? { manner: 'quiet', why: 'hunted' } : { manner: 'book', why: null };
    case 'engines':
      if (alert === 'found') return { manner: 'push', why: 'found' };
      return hunted ? { manner: 'quiet', why: 'hunted' } : { manner: 'book', why: null };
    case 'shields':
    case 'weapons':
      // An auditor, not a gunner: kept cool until something is on us.
      if (alert === 'found') return { manner: 'book', why: 'found' };
      return { manner: 'quiet', why: hunted ? 'hunted' : 'calm' };
    default:
      return { manner: 'book', why: null };
  }
}

/** Settle her alert: up at once, down only once it has held for ALERT.hold seconds. */
function settleAlert(sim) {
  const ai = sim.state.ai;
  const now = alertNow(sim);
  const { tick } = sim.state;
  if (ALERTS.indexOf(now) >= ALERTS.indexOf(ai.alert)) {
    if (now !== 'calm') ai.alertUntil = tick + ALERT.hold * TICKS;
    if (now !== ai.alert) {
      const from = ai.alert;
      ai.alert = now;
      sim.events.emit('margo.alert', { from, to: now, tick });
    }
  } else if (tick >= ai.alertUntil) {
    const from = ai.alert;
    ai.alert = now;
    if (now !== 'calm') ai.alertUntil = tick + ALERT.hold * TICKS;
    sim.events.emit('margo.alert', { from, to: now, tick });
  }
}

/**
 * One tick, after the stations are settled: how she runs each station she holds. What she changes takes
 * effect when the stations are settled again at the end of the tick.
 */
export function stepMargo(sim) {
  const ai = sim.state.ai;
  const { stations, tick } = sim.state;
  const own = ai.mind === 'own';
  if (own) settleAlert(sim);
  let hush = null;
  let push = null;
  let easy = null;
  for (const id of MANNER_STATIONS) {
    const entry = stations[id];
    if (entry.by !== 'margo') {
      if (entry.against) entry.against = null;
      continue;
    }
    if (!own) {
      entry.runs = entry.order ?? 'book';
      entry.why = entry.order ? 'order' : null;
      continue;
    }
    const mine = herWay(sim, id, ai.alert);
    let runs = mine.manner;
    let why = mine.why;
    let against = null;
    // She disagrees only when she has a reason of her own: by the book, or kept cool out of habit, she does as she is told.
    if (entry.order !== null && entry.order !== mine.manner && mine.why !== null && mine.why !== 'calm') {
      if (ai.trust < OWN_WAY) against = 'own';
      else {
        runs = entry.order;
        why = 'order';
        against = 'doubt';
      }
    } else if (entry.order !== null) {
      runs = entry.order;
      why = 'order';
    }
    const room = roomOfStation(sim, id)?.id;
    if (against !== entry.against) {
      // She says so when she starts to disagree: not a word above TRUST.goesAlong when she goes along.
      if (against === 'own') sim.events.emit('margo.own_way', { station: id, order: entry.order, manner: runs, why: mine.why, room, tick });
      else if (against === 'doubt') sim.events.emit('margo.doubt', { station: id, order: entry.order, would: mine.manner, why: mine.why, room, speak: ai.trust < TRUST.goesAlong, tick });
      entry.against = against;
    }
    entry.why = why;
    if (runs === entry.runs) continue;
    const from = entry.runs;
    entry.runs = runs;
    sim.events.emit('margo.manner', { station: id, from, to: runs, why, against, room, tick });
    // What she says about it, once a tick at most (voice.js): only her own changes, not the captain's orders.
    if (why === 'order' || against) continue;
    if (runs === 'quiet' && why === 'hunted') hush ??= { station: id, room, tick };
    else if (runs === 'push') push ??= { station: id, room, why, tick };
    else if (runs === 'book' && from === 'quiet') easy ??= { station: id, room, tick };
  }
  if (hush) sim.events.emit('margo.hush', hush);
  if (push) sim.events.emit('margo.push', push);
  if (easy) sim.events.emit('margo.easy', easy);
  if (own) {
    // Only worth counting her jobs when she holds more than she can watch.
    const load = margoLoad(sim);
    const stretched = load.held > load.attention && load.jobs > load.attention; // jobs are counted only past the first test
    if (stretched !== ai.stretched) {
      ai.stretched = stretched;
      if (stretched) sim.events.emit('margo.stretched', { jobs: load.jobs, attention: load.attention, tick });
    }
  }
}

/** What happens elsewhere that she answers. Called once when the sim is created. */
export function attachMargo(sim) {
  // A station handed to her, or taken back: she knows at once, and says so (voice.js).
  sim.events.on('station.cover', (event) => {
    if (event.to === 'hers') sim.events.emit('station.handed', event);
    else if (event.to === 'crew') sim.events.emit('station.kept', event);
  });
}

/** Problems with how she runs the stations that should never happen. */
export function checkMargoInvariants(sim) {
  const problems = [];
  const ai = sim.state.ai;
  if (ai.mind !== 'own' && ai.mind !== 'book') problems.push(`Margo's mind is "${ai.mind}"`);
  if (!ALERTS.includes(ai.alert)) problems.push(`Margo's alert is "${ai.alert}"`);
  for (const id of MANNER_STATIONS) {
    const entry = sim.state.stations[id];
    if (entry.against !== null && entry.against !== 'own' && entry.against !== 'doubt') problems.push(`station ${id} is against its order as "${entry.against}"`);
    if (entry.against && entry.order === null) problems.push(`station ${id} is against an order nobody gave`);
  }
  return problems;
}
