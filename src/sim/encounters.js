// The scope and its contacts (Stage H, H.1; D-151). DOM-free.
//
// Other ships are not opponents in a duel: they are contacts on a passive
// scope, and the skill is not being caught. This file holds
//   - the helm: our heading, whether the drive is burning, and the velocity
//     that leaves us with (cut the drive and the ship drifts on as it was);
//   - the contacts: each a ship somewhere around us, run by an encounter
//     definition from content/encounters/ (what it is looking for, how hard
//     it looks, when it gives up, what it does alongside);
//   - what each side knows of the other, read through the one senses model
//     (senses.js, D-074) both ways: a contact reads OUR signature to notice,
//     track and close on us, and Margo reads ITS signature to put a return on
//     the scope, with a bearing and a range that are only as good as the
//     sensors and the distance allow;
//   - decoys: a flare, or a crate put out of an airlock, for a contact to
//     chase instead of us;
//   - the hail: a bluff that turns a contact away, or tells it where we are.
//
// A contact is always in one state (STATES):
//   unseen     it has not noticed us and flies its own course
//   shadowing  it has a sniff of something and comes to look
//   closing    it is sure, and burns to intercept
//   alongside  it has matched us and is about to put a clamp on
//   docked     the clamp is on: what its party does aboard is H.2
//   lost       it has given up and is leaving
//
// What a contact wants (`wants`) decides what it does once it has us (H.3,
// D-175). Four come aboard (boarders.js): an inspection, a raid for cargo, a
// bounty on one of the crew, a wrecker after a system; a grapple tender puts
// its party across in pods that point defence can shoot down. Three never
// dock: a bulwark holds a lane and charges a toll (`toll`), a drone carrier
// sits off and swarms the hull with drones (`drones`), and a gunnery drone
// scans us and calls in someone who will (`scan`). Some carry a gun (`guns`)
// and fire on us when we run, when we shoot, or when we will not pay; and
// any of them can be shot at with our deterrent gun (combat.js) until its
// `nerve` breaks.
//
// Positions are kept relative to our ship (we are always the origin), x to
// the right of the scope and y up it, in scope units (KM_PER_UNIT km each).
// Velocities are absolute, so cutting our drive changes nothing about how the
// picture moves. Bearings are degrees clockwise from the top of the scope.

import { validateParty, startBoarding } from './boarders.js';
import { DRONE_WEAPON, GUN, fireOn, hasPilot } from './combat.js';
import { changeReputation } from './contracts.js';
import { isHome } from './crew.js';
import { flare as flash, sensorGain, signature } from './senses.js';

/** The states a contact can be in, in the order an encounter usually runs. */
export const STATES = Object.freeze(['unseen', 'shadowing', 'closing', 'alongside', 'docked', 'lost']);
/** How an encounter can end, as the bot's report and the debug panel name it. */
export const ENDINGS = Object.freeze({
  passed: 'Never noticed us',
  quiet: 'Lost us in the dark',
  outrun: 'Outrun',
  decoy: 'Went after a decoy',
  bluff: 'Bluffed',
  jumped: 'Left behind by a jump',
  docked: 'Docked with us',
  deterred: 'Driven off by the gun',
  paid: 'Paid the toll',
  scanned: 'Scanned us and called it in',
  swarmed: 'Spent its drones on us',
});
/** What a contact can be looking for. The first four send a boarding party with that goal (H.2); the rest never dock (H.3). */
export const WANTS = Object.freeze(['inspect', 'cargo', 'crew', 'salvage', 'toll', 'hull', 'scan']);
/** The goals a boarding party comes aboard for. */
export const BOARDING_WANTS = Object.freeze(['inspect', 'cargo', 'crew', 'salvage']);
/** When a contact's gun opens up on us (`guns.when`): we run from it, we shoot at it, it is closing, or we will not pay its toll. */
export const GUN_WHEN = Object.freeze(['running', 'shot', 'closing', 'toll']);
/** The lies a hail can tell. */
export const BLUFFS = Object.freeze({ transponder: 'False transponder', manifest: 'False manifest' });
/** The kinds of decoy. */
export const DECOY_KINDS = Object.freeze(['flare', 'crate']);

/** One scope unit, for the readouts. */
export const KM_PER_UNIT = 10;

/** The helm: degrees a second she turns, speed and acceleration at full engine power, and flares carried. */
export const HELM = Object.freeze({ turn: 15, accel: 0.06, speed: 1, flares: 2 });

/**
 * The scope. `range` is the edge of the display. A return's quality, 0 to 1, is the contact's signature
 * times our sensor gain, falling to nothing at `reach`, over `clear`. It is drawn from `show` (and dropped
 * below `fade`), its intent can be read from `intent` and what it is from `identify`. The bearing is out by
 * up to `bearingError` degrees and the range by up to `rangeError` of itself at quality 0, down to the
 * floors at quality 1. Someone in the sensors room reads it `station` times better.
 */
export const SCOPE = Object.freeze({ range: 120, reach: 150, clear: 0.45, show: 0.1, fade: 0.04, intent: 0.35, identify: 0.55, gain: 0.25, loss: 0.1, bearingError: 35, rangeError: 0.45, floorBearing: 1.5, floorRange: 0.02, station: 1.25, jitterSeconds: 3, wander: 0.6, ghostSeconds: 30 });

/**
 * A contact's awareness of us, 0 to 1: it settles toward how far our signature, through its sensors and
 * the distance, sits between the encounter's `notice` and `sure`. From `notice` it comes to look, from
 * `close` it burns to intercept, below `drop` an intercept falls back to a search.
 */
export const AWARE = Object.freeze({ notice: 0.25, close: 0.7, drop: 0.2, gain: 0.08, loss: 0.06, track: 0.5 });

/** Inside this range a ship is seen by eye, however dark it runs: added to what the sensors read. */
export const EYES = Object.freeze({ range: 6, strength: 0.3 });

/** How close is alongside, and how close a contact gets to a decoy before it knows what it is. */
export const ALONGSIDE = 3;
/** What a decoy gives off, how long it lasts and how fast it leaves us. A flare also lights us up for a moment. */
export const DECOYS = Object.freeze({
  flare: Object.freeze({ strength: 0.9, seconds: 40, kick: 0.5, flash: 0.3 }),
  crate: Object.freeze({ strength: 0.3, seconds: 180, kick: 0.12, flash: 0 }),
});
const DECOY_REACH = 4;
/** A drone takes `flight` seconds to cross to our hull, its zaps miss `miss` of the time, and its cell is flat `life` seconds after it lands. */
export const DRONE = Object.freeze({ flight: 6, miss: 0.25, life: 24 });
/** A scan that is out of reach unwinds at this share of the rate it builds. */
const SCAN_DECAY = 0.5;
/** A searching contact is 'there' within this of where it thinks we are; on the way its patience runs at this share. */
const SEARCH_RADIUS = 8;
const SEARCH_ON_THE_WAY = 0.25;
/** How far out its idea of where we are is when it loses us: a share of the range, and the least. */
const SEARCH_ERROR = Object.freeze({ ofRange: 0.3, least: 6 });
/** A contact that has not noticed us goes on its way after this long, wherever it is. */
const PASS_SECONDS = 900;
/** Where a contact turns up when we arrive somewhere: how far out, and how wide of us its course may pass. */
export const SPAWN = Object.freeze({ near: 105, far: 125, miss: 40 });
/** A contact that has given up is taken off the scope this long after, or once it is well off the edge. */
const LEAVE_SECONDS = 90;
/** The most ended encounters kept on record. */
const RECORD_MAX = 40;
/** Each point of negotiation above the first adds this to a bluff's chance. */
const BLUFF_PER_SKILL = 0.06;

const clamp01 = (value) => Math.max(0, Math.min(1, value));
const RAD = Math.PI / 180;
const norm360 = (deg) => ((deg % 360) + 360) % 360;
/** The bearing of a point from us, degrees clockwise from the top of the scope. */
export const bearingOf = (x, y) => norm360(Math.atan2(x, y) / RAD);
const rangeOf = (x, y) => Math.hypot(x, y);
const unit = (deg) => ({ x: Math.sin(deg * RAD), y: Math.cos(deg * RAD) });
/** The shortest turn from one heading to another, -180 to 180. */
const turnBetween = (from, to) => ((to - from + 540) % 360) - 180;

// ---------- content ----------

/** Problems with an encounter definition (content/encounters/), as readable strings. `refs` holds weapons, encounters, factions and node kinds by id. */
export function validateEncounter(item, refs = {}) {
  const problems = [];
  const allowed = ['id', 'note', 'name', 'class', 'blurb', 'wants', 'at', 'weight', 'signature', 'sensors', 'reach', 'keen', 'notice', 'sure', 'speed', 'accel', 'standoff', 'shadow', 'patience', 'chase', 'decoys', 'bluffs', 'alongside', 'party', 'nerve', 'guns', 'drones', 'pods', 'toll', 'scan'];
  for (const key of Object.keys(item)) if (!allowed.includes(key) && key !== '_file') problems.push(`unknown key "${key}"`);
  const text = (v) => typeof v === 'string' && v.trim().length > 0;
  const positive = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;
  const share = (v) => typeof v === 'number' && v >= 0 && v <= 1;
  for (const key of ['name', 'class', 'blurb']) if (!text(item[key])) problems.push(`needs "${key}"`);
  if (!WANTS.includes(item.wants)) problems.push(`wants must be one of ${WANTS.join(', ')}: what it is looking for`);
  if (item.at !== undefined && !(Array.isArray(item.at) && item.at.length && item.at.every(text))) problems.push('at must be a list of kinds of point it can turn up at');
  else if (refs.nodeKinds) for (const kind of item.at ?? []) if (!refs.nodeKinds.has(kind) || kind === 'port') problems.push(`at: "${kind}" is not a kind of point a contact can turn up at`);
  if (item.weight !== undefined && !(typeof item.weight === 'number' && item.weight >= 0)) problems.push('weight must be a number, 0 or more');
  if (!share(item.signature?.cruise) || !share(item.signature?.chase)) problems.push('signature must be { cruise, chase }, each 0 to 1: what it gives off on its own course and burning after us');
  for (const key of ['sensors', 'reach', 'patience', 'chase']) if (!positive(item[key])) problems.push(`${key} must be a number above 0`);
  for (const key of ['keen', 'accel', 'standoff', 'shadow']) if (item[key] !== undefined && !positive(item[key])) problems.push(`${key} must be a number above 0`);
  if (!share(item.notice) || !share(item.sure) || !(item.notice < item.sure)) problems.push('notice and sure must be 0 to 1, notice below sure: how much of us it needs to get interested, and to be certain');
  if (!positive(item.speed?.cruise) || !positive(item.speed?.chase)) problems.push('speed must be { cruise, chase }, each above 0');
  if (item.decoys !== undefined) {
    if (!item.decoys || typeof item.decoys !== 'object' || Array.isArray(item.decoys)) problems.push('decoys must be an object of kind: pull');
    else
      for (const [kind, pull] of Object.entries(item.decoys)) {
        if (!DECOY_KINDS.includes(kind)) problems.push(`decoys: no decoy "${kind}" (${DECOY_KINDS.join(', ')})`);
        if (!(typeof pull === 'number' && pull >= 0)) problems.push(`decoys.${kind} must be a number, 0 or more`);
      }
  }
  if (item.bluffs !== undefined) {
    if (!item.bluffs || typeof item.bluffs !== 'object' || Array.isArray(item.bluffs)) problems.push('bluffs must be an object of bluff: chance');
    else
      for (const [bluff, chance] of Object.entries(item.bluffs)) {
        if (!BLUFFS[bluff]) problems.push(`bluffs: no bluff "${bluff}" (${Object.keys(BLUFFS).join(', ')})`);
        if (!share(chance)) problems.push(`bluffs.${bluff} must be a chance, 0 to 1`);
      }
  }
  const boards = BOARDING_WANTS.includes(item.wants);
  const side = item.alongside;
  if (side !== undefined || boards) {
    if (!side || typeof side !== 'object' || !positive(side.seconds) || !text(side.hail)) problems.push('alongside must be { seconds, hail }: how long before the clamp goes on, and what it says first');
    else for (const key of Object.keys(side)) if (!['seconds', 'hail'].includes(key)) problems.push(`alongside: unknown key "${key}"`);
  }
  if (boards) {
    if (item.party === undefined) problems.push(`a ship that wants ${item.wants} needs a party: who comes aboard when it docks`);
    else problems.push(...validateParty(item.party, item.wants));
  } else {
    if (item.party !== undefined) problems.push(`a ship that wants ${item.wants} never docks, so it has no party`);
    if (!positive(item.standoff)) problems.push('a ship that never docks needs a standoff: how far off it holds once it has us');
  }
  if (item.party?.faction && refs.factions && !refs.factions.has(item.party.faction)) problems.push(`party.faction: no faction "${item.party.faction}"`);
  if (item.nerve !== undefined && !(typeof item.nerve === 'number' && item.nerve >= 0)) problems.push('nerve must be a number, 0 or more: how much of our gun it takes to break off (0: it never does)');
  const guns = item.guns;
  if (guns !== undefined) {
    if (!guns || typeof guns !== 'object' || Array.isArray(guns)) problems.push('guns must be { weapon, range, every, hit, warn, when }');
    else {
      for (const key of Object.keys(guns)) if (!['weapon', 'range', 'every', 'hit', 'warn', 'when'].includes(key)) problems.push(`guns: unknown key "${key}"`);
      if (!text(guns.weapon)) problems.push('guns.weapon must name a weapon');
      else if (refs.weapons && !refs.weapons.has(guns.weapon)) problems.push(`guns.weapon: no weapon "${guns.weapon}"`);
      for (const key of ['range', 'every']) if (!positive(guns[key])) problems.push(`guns.${key} must be a number above 0`);
      if (!share(guns.hit)) problems.push('guns.hit must be a chance, 0 to 1: how often a round finds us when it has us cold');
      if (guns.warn !== undefined && !(Number.isInteger(guns.warn) && guns.warn >= 0)) problems.push('guns.warn must be how many warning shots it fires first');
      if (!(Array.isArray(guns.when) && guns.when.length && guns.when.every((w) => GUN_WHEN.includes(w)))) problems.push(`guns.when must be a list of ${GUN_WHEN.join(', ')}`);
      if (guns.when?.includes('toll') && !item.toll) problems.push('guns.when: "toll" needs a toll');
    }
  }
  const drones = item.drones;
  if (item.wants === 'hull' && drones === undefined) problems.push('a ship that wants our hull needs drones');
  if (drones !== undefined && !(drones && ['every', 'fire', 'range'].every((key) => positive(drones[key])) && Number.isInteger(drones.max) && drones.max >= 1 && Number.isInteger(drones.total) && drones.total >= drones.max)) problems.push('drones must be { every, max, total, fire, range }: seconds between launches, the most out at once, how many it carries, seconds between zaps, and how close it launches');
  const pods = item.pods;
  if (pods !== undefined) {
    if (!(pods && positive(pods.range) && positive(pods.flight))) problems.push('pods must be { range, flight }: how close it puts its party across, and seconds in the air');
    if (!boards) problems.push('pods carry a boarding party: only a ship that boards has them');
  }
  const toll = item.toll;
  if (item.wants === 'toll' && toll === undefined) problems.push('a ship that wants a toll needs a toll');
  if (toll !== undefined && !(toll && Number.isInteger(toll.cost) && toll.cost > 0 && positive(toll.zone) && positive(toll.grace) && text(toll.demand))) problems.push('toll must be { cost, zone, grace, demand }: credits, how close it calls, seconds to pay before it shoots, and what it says');
  const scan = item.scan;
  if (item.wants === 'scan' && scan === undefined) problems.push('a ship that wants a scan needs a scan');
  if (scan !== undefined) {
    if (!(scan && positive(scan.range) && positive(scan.seconds))) problems.push('scan must be { range, seconds, calls }: how close it has to be, how long it takes, and the encounter it calls in');
    else if (scan.calls !== undefined && !text(scan.calls)) problems.push('scan.calls must name an encounter');
    else if (scan.calls !== undefined && refs.encounters && !refs.encounters.has(scan.calls)) problems.push(`scan.calls: no encounter "${scan.calls}"`);
  }
  return problems;
}

/** The encounters the sim can meet, by id. */
export function buildEncounters(items = []) {
  return { all: items, byId: new Map(items.map((item) => [item.id, item])) };
}

// ---------- state ----------

export function newHelmState() {
  return {
    heading: 90, // degrees clockwise from the top of the scope: the way the bow points
    wanted: 90, // the heading she is coming round to
    burn: false, // the drive is lit (it only pushes while the engines have power)
    vx: 0, // our velocity, scope units a second
    vy: 0,
    flares: HELM.flares,
  };
}

export function newScopeState() {
  return {
    contacts: [], // ships around us (newContact)
    decoys: [], // { id, kind, x, y, vx, vy, left }
    drones: [], // a carrier's drones: { id, contact, lands, on, next, dies }; on the hull once `on`
    pods: [], // boarding pods in the air: { id, contact, encounter, lands }
    next: 1, // the next contact, decoy, drone or pod number
    record: [], // encounters that have ended: { encounter, outcome, seconds, tick }
  };
}

const defOf = (sim, contact) => sim.encounters.byId.get(contact.encounter);
/** Is the drive pushing right now? Lit, with power in the engines. */
export const burning = (sim) => sim.state.helm.burn && sim.state.systems.engines.power > 0;
/** The share of the drive's full push the engines' power allows, 0 to 1. */
const driveShare = (sim) => {
  const { engines } = sim.state.systems;
  return engines.absent || engines.level <= 0 ? 0 : engines.power / engines.level;
};
/** Our speed, scope units a second. */
export const speedOf = (sim) => Math.hypot(sim.state.helm.vx, sim.state.helm.vy);
/** The contacts still in play: not docked, not gone. */
export const liveContacts = (sim) => sim.state.scope.contacts.filter((contact) => contact.state !== 'lost' && contact.state !== 'docked');
/** Is a ship alongside us, about to put a clamp on? */
export const heldAlongside = (sim) => sim.state.scope.contacts.some((contact) => contact.state === 'alongside');

/** The best negotiator alive aboard: their skill, 0 if nobody has any. */
export function negotiation(sim) {
  let best = 0;
  for (const member of Object.values(sim.state.crew)) if (member.alive && isHome(sim, member)) best = Math.max(best, member.skills?.negotiation ?? 0);
  return best;
}

/** The chance a bluff works on a contact, 0 to 1. */
export function bluffChance(sim, contact, bluff) {
  const base = defOf(sim, contact).bluffs?.[bluff] ?? 0;
  return base <= 0 ? 0 : clamp01(base + BLUFF_PER_SKILL * (negotiation(sim) - 1));
}

/**
 * Put a contact on the board. `range` and `bearing` are where it is from us; it flies a straight course
 * that passes `miss` units from where we are now (0 comes straight over us). `state: 'closing'` starts it
 * already sure of us.
 */
export function spawnContact(sim, def, { range = 80, bearing = 0, miss = 20, side = 1, state = 'unseen' } = {}) {
  const { scope, helm, tick } = { ...sim.state, tick: sim.state.tick };
  const at = unit(bearing);
  const x = at.x * range;
  const y = at.y * range;
  // Its course: toward a point `miss` off to one side of us.
  const across = unit(bearing + 90 * side);
  const aim = { x: across.x * miss - x, y: across.y * miss - y };
  const length = Math.hypot(aim.x, aim.y) || 1;
  const course = { vx: (aim.x / length) * def.speed.cruise, vy: (aim.y / length) * def.speed.cruise };
  const sure = state === 'closing' || state === 'shadowing';
  const rng = sim.rng.stream('encounters');
  const contact = {
    id: scope.next++,
    encounter: def.id,
    state: sure ? state : 'unseen',
    x,
    y,
    vx: course.vx,
    vy: course.vy,
    course,
    aware: state === 'closing' ? 1 : state === 'shadowing' ? 0.4 : 0, // how well it has us, 0 to 1
    est: { x: 0, y: 0, vx: helm.vx, vy: helm.vy }, // where it thinks we are (relative to where we really are) and how we are moving
    target: null, // a decoy id while it is chasing one
    wise: [], // decoys it has seen through
    fooled: false, // a decoy has drawn it off at least once
    lostFor: 0, // seconds searching with nothing to go on
    burnFor: 0, // of those, seconds we were burning
    watch: 0, // seconds it has shadowed us
    searching: false, // it is looking for us with nothing to go on
    sprint: false, // it had us firmly and lost us: it runs to where we were
    chased: 0, // seconds it has spent closing
    held: 0, // seconds alongside
    left: 0, // seconds since it gave up
    tried: [], // bluffs it has heard
    wary: false, // it has caught us in a lie, or been shot at
    shotAt: false, // we have fired on it (H.3)
    fear: 0, // how much of our gun it has taken, against its nerve
    fired: 0, // rounds it has fired at us
    reload: null, // seconds until its gun fires again, once it has opened up
    launched: 0, // drones put out, or boarding pods
    podsOut: 0, // pods of its party still in the air
    podsLanded: 0, // pods that got there
    tolled: false, // it has called its toll
    tollEnds: null, // the tick its patience with an unpaid toll runs out
    scan: 0, // seconds of a scan it has built up
    lastLaunch: null, // the tick it last put a drone out
    born: tick,
    // Margo's return on it: quality 0 to 1, and the slow wander of the reading inside its error.
    track: { q: 0, shown: false, known: false, jb: 0, jr: 0, nb: rng.range(-1, 1), nr: rng.range(-1, 1), t: 0, ghost: null },
  };
  scope.contacts.push(contact);
  sim.events.emit('contact.spawned', { contact: contact.id, encounter: def.id, tick });
  return contact;
}

function record(sim, contact, outcome) {
  const { scope, tick } = sim.state;
  const seconds = (tick - contact.born) / 20;
  scope.record.push({ encounter: contact.encounter, outcome, seconds, fired: contact.fired, fear: contact.fear, tick });
  if (scope.record.length > RECORD_MAX) scope.record.shift();
  sim.events.emit('encounter.ended', { contact: contact.id, encounter: contact.encounter, name: defOf(sim, contact).name, outcome, seconds, pursuer: Boolean(contact.pursuer), tick });
}

/** It gives up on us: `how` is quiet, outrun, decoy or bluff. It stays on the scope a while, leaving. */
function lose(sim, contact, how) {
  contact.state = 'lost';
  contact.target = null;
  contact.left = 0;
  sim.events.emit('contact.lost', { contact: contact.id, encounter: contact.encounter, name: defOf(sim, contact).name, how, tick: sim.state.tick });
  record(sim, contact, how);
}

function remove(sim, contact) {
  const { contacts } = sim.state.scope;
  const index = contacts.indexOf(contact);
  if (index >= 0) contacts.splice(index, 1);
}

// ---------- what Margo makes of it ----------

/** The error on a return of quality `q`: degrees either side of the bearing, and the share of the range either way. */
export const errorOf = (q) => ({ bearing: SCOPE.floorBearing + SCOPE.bearingError * (1 - q), range: SCOPE.floorRange + SCOPE.rangeError * (1 - q) });

/** How well our sensors read things outside the ship: the sensors' gain, better with someone in the sensors room. */
export function scopeGain(sim) {
  const room = sim.layout.roomOfSystem?.('sensors');
  const manned = room && Object.values(sim.state.crew).some((member) => member.alive && member.room === room.id && isHome(sim, member));
  return sensorGain(sim) * (manned ? SCOPE.station : 1);
}

/** The quality a return on this contact would settle to as things stand, 0 to 1. */
export function returnQuality(sim, contact) {
  const def = defOf(sim, contact);
  const loud = contact.state === 'closing' ? def.signature.chase : def.signature.cruise;
  const reading = loud * scopeGain(sim) * Math.max(0, 1 - rangeOf(contact.x, contact.y) / SCOPE.reach);
  return clamp01(reading / SCOPE.clear);
}

const INTENT = Object.freeze({ unseen: 'On its own course', shadowing: 'Looking for something', closing: 'Closing on us', alongside: 'Alongside', docked: 'Docked', lost: 'Breaking off' });

/**
 * A contact as the scope shows it, or null if there is nothing on the scope for it: { id, label, name,
 * known, intent, state (null until its intent can be read), bearing, range, bearingError, rangeError,
 * quality, stale, age }. The true position is always inside the error; the reading wanders within it.
 */
export function contactView(sim, contact) {
  const { track } = contact;
  const label = `C${contact.id}`;
  if (!track.shown) {
    if (!track.ghost) return null;
    const { ghost } = track;
    return { id: contact.id, label, name: ghost.name, known: ghost.known, intent: 'Lost in the clutter', state: null, bearing: ghost.bearing, range: ghost.range, bearingError: ghost.bearingError, rangeError: ghost.rangeError, quality: 0, stale: true, age: sim.state.tick - ghost.tick };
  }
  const def = defOf(sim, contact);
  const error = errorOf(track.q);
  const reads = track.q >= SCOPE.intent;
  return {
    id: contact.id,
    label,
    name: track.known ? def.name : 'Unknown return',
    known: track.known,
    intent: reads ? INTENT[contact.state] : 'Intent unknown',
    state: reads ? contact.state : null,
    bearing: norm360(bearingOf(contact.x, contact.y) + track.jb * error.bearing * SCOPE.wander),
    range: rangeOf(contact.x, contact.y) * (1 + track.jr * error.range * SCOPE.wander),
    bearingError: error.bearing,
    rangeError: error.range,
    quality: track.q,
    stale: false,
    age: 0,
  };
}

/** Everything the scope shows: our own helm, the returns, and our decoys (those we put out ourselves, so we know them exactly). */
export function scopeView(sim) {
  const { helm, scope } = sim.state;
  const speed = speedOf(sim);
  return {
    range: SCOPE.range,
    heading: helm.heading,
    wanted: helm.wanted,
    speed,
    course: speed > 1e-6 ? bearingOf(helm.vx, helm.vy) : helm.heading,
    burning: burning(sim),
    flares: helm.flares,
    contacts: scope.contacts.map((contact) => contactView(sim, contact)).filter(Boolean),
    decoys: scope.decoys.map((decoy) => ({ id: decoy.id, kind: decoy.kind, bearing: bearingOf(decoy.x, decoy.y), range: rangeOf(decoy.x, decoy.y), left: decoy.left })),
    incoming: incomingView(sim),
  };
}

/**
 * Drones and pods on their way in (H.3), for the scope: on the line from whoever launched them to us, as far
 * along it as their flight is. Close and loud, so they are drawn where they are. A drone on the hull is at the centre.
 */
function incomingView(sim) {
  const { scope, tick } = sim.state;
  const along = (item, seconds, kind) => {
    const from = findContact(sim, item.contact);
    if (!from) return null;
    const left = item.on ? 0 : Math.max(0, Math.min(1, (item.lands - tick) / (seconds * 20)));
    return { id: item.id, kind, on: Boolean(item.on), bearing: bearingOf(from.x, from.y), range: rangeOf(from.x, from.y) * left };
  };
  return [
    ...scope.drones.map((drone) => along(drone, DRONE.flight, 'drone')),
    ...scope.pods.map((pod) => along(pod, sim.encounters.byId.get(pod.encounter).pods.flight, 'pod')),
  ].filter(Boolean);
}

function stepTrack(sim, contact, dt, rng) {
  const { track } = contact;
  const { tick } = sim.state;
  const goal = contact.state === 'docked' ? 1 : returnQuality(sim, contact);
  track.q = goal > track.q ? Math.min(goal, track.q + SCOPE.gain * dt) : Math.max(goal, track.q - SCOPE.loss * dt);
  // The reading wanders inside its error: a new place to drift toward every few seconds.
  track.t += dt / SCOPE.jitterSeconds;
  if (track.t >= 1) {
    track.t -= 1;
    track.jb = track.nb;
    track.jr = track.nr;
    track.nb = rng.range(-1, 1);
    track.nr = rng.range(-1, 1);
  } else {
    track.jb += (track.nb - track.jb) * Math.min(1, dt / SCOPE.jitterSeconds);
    track.jr += (track.nr - track.jr) * Math.min(1, dt / SCOPE.jitterSeconds);
  }
  const label = `C${contact.id}`;
  if (!track.shown && track.q >= SCOPE.show) {
    track.shown = true;
    track.ghost = null;
    const view = contactView(sim, contact);
    sim.events.emit('contact.sighted', { contact: contact.id, label, bearing: view.bearing, range: view.range, tick });
  } else if (track.shown && track.q < SCOPE.fade) {
    const view = contactView(sim, contact);
    track.shown = false;
    track.ghost = { bearing: view.bearing, range: view.range, bearingError: view.bearingError, rangeError: view.rangeError, name: view.name, known: view.known, tick };
    sim.events.emit('contact.faded', { contact: contact.id, label, tick });
  }
  if (track.ghost && (tick - track.ghost.tick) / 20 > SCOPE.ghostSeconds) track.ghost = null;
  if (track.shown && !track.known && track.q >= SCOPE.identify) {
    track.known = true;
    const def = defOf(sim, contact);
    sim.events.emit('contact.identified', { contact: contact.id, label, encounter: def.id, name: def.name, wants: def.wants, tick });
  }
}

// ---------- what a contact makes of us, and what it does about it ----------

const falloff = (distance, reach) => Math.max(0, 1 - distance / reach);

/** How strongly a contact reads us right now: our signature through its sensors and the distance. */
export function readingOf(sim, contact, loud = signature(sim).total) {
  const def = defOf(sim, contact);
  const range = rangeOf(contact.x, contact.y);
  // Close enough, a hull is seen by eye whatever it gives off.
  return loud * def.sensors * falloff(range, def.reach) + EYES.strength * falloff(range, EYES.range);
}

/** The decoy a contact would rather chase than us, or null. */
function lure(sim, contact, def, ours) {
  let best = null;
  let most = Math.max(ours, def.notice);
  for (const decoy of sim.state.scope.decoys) {
    if (contact.wise.includes(decoy.id)) continue;
    const pull = DECOYS[decoy.kind].strength * (def.decoys?.[decoy.kind] ?? 0) * def.sensors * falloff(Math.hypot(decoy.x - contact.x, decoy.y - contact.y), def.reach);
    if (pull > most) {
      most = pull;
      best = decoy;
    }
  }
  return best ? { decoy: best, pull: most } : null;
}

/** Turn a contact's velocity toward (vx, vy), as fast as its drive allows. */
function steer(contact, def, vx, vy, dt) {
  const dx = vx - contact.vx;
  const dy = vy - contact.vy;
  const gap = Math.hypot(dx, dy);
  const step = (def.accel ?? 0.12) * dt;
  if (gap <= step) {
    contact.vx = vx;
    contact.vy = vy;
  } else {
    contact.vx += (dx / gap) * step;
    contact.vy += (dy / gap) * step;
  }
}

/** Head for a point (relative to us) at `speed`, slowing to a stop at it. */
function headFor(contact, def, x, y, speed, dt, helm, stopAt = 0) {
  const dx = x - contact.x;
  const dy = y - contact.y;
  const gap = Math.hypot(dx, dy);
  if (gap <= stopAt + 1e-6) return steer(contact, def, helm.vx, helm.vy, dt);
  // The point moves with us, so it leads it by our own velocity, as far as its drive can keep that up.
  let vx = helm.vx + (dx / gap) * speed;
  let vy = helm.vy + (dy / gap) * speed;
  const fast = Math.hypot(vx, vy);
  if (fast > speed) {
    vx *= speed / fast;
    vy *= speed / fast;
  }
  steer(contact, def, vx, vy, dt);
}

function stepContact(sim, contact, dt, loud) {
  const def = defOf(sim, contact);
  const { helm, tick } = { helm: sim.state.helm, tick: sim.state.tick };
  const info = { contact: contact.id, encounter: def.id, name: def.name, tick };
  const range = rangeOf(contact.x, contact.y);

  if (contact.state === 'lost') {
    // Leaving: back on its own course, and off the board once it is well clear.
    steer(contact, def, contact.course.vx, contact.course.vy, dt);
    contact.left += dt;
    if (contact.left >= LEAVE_SECONDS || range > SCOPE.range * 1.4) remove(sim, contact);
    return;
  }

  // What it reads: us, or a decoy it likes better.
  const ours = readingOf(sim, contact, loud);
  const drawn = contact.state === 'unseen' || contact.state === 'alongside' ? null : lure(sim, contact, def, ours);
  if (drawn && contact.target !== drawn.decoy.id) {
    contact.target = drawn.decoy.id;
    sim.events.emit('contact.fooled', { ...info, decoy: drawn.decoy.id, kind: drawn.decoy.kind });
  } else if (!drawn) contact.target = null;
  const reading = drawn ? drawn.pull : ours;
  const goal = clamp01((reading - def.notice) / (def.sure - def.notice));
  contact.aware = goal > contact.aware ? Math.min(goal, contact.aware + AWARE.gain * (def.keen ?? 1) * dt) : Math.max(goal, contact.aware - AWARE.loss * dt);

  // Where it thinks we are. With a track it follows us; without one it can only carry on along the
  // way we were going: a ship that drifts on in a straight line is found where it was expected.
  const { est } = contact;
  if (drawn) Object.assign(est, { x: drawn.decoy.x, y: drawn.decoy.y, vx: drawn.decoy.vx, vy: drawn.decoy.vy });
  else {
    const pull = Math.min(1, contact.aware * AWARE.track * dt);
    est.x -= est.x * pull;
    est.y -= est.y * pull;
    est.vx += (helm.vx - est.vx) * pull;
    est.vy += (helm.vy - est.vy) * pull;
    est.x += (est.vx - helm.vx) * dt;
    est.y += (est.vy - helm.vy) * dt;
  }

  // A decoy reached: it knows what it is now. A crate is what a ship after cargo came for.
  if (drawn && Math.hypot(drawn.decoy.x - contact.x, drawn.decoy.y - contact.y) <= DECOY_REACH) {
    contact.wise.push(drawn.decoy.id);
    contact.fooled = true;
    contact.target = null;
    contact.aware = 0;
    if (drawn.decoy.kind === 'crate' && def.wants === 'cargo') {
      sim.state.scope.decoys.splice(sim.state.scope.decoys.indexOf(drawn.decoy), 1);
      sim.events.emit('contact.took', { ...info, decoy: drawn.decoy.id });
      return lose(sim, contact, 'decoy');
    }
    sim.events.emit('contact.wise', { ...info, decoy: drawn.decoy.id });
  }

  if (contact.state === 'unseen') {
    steer(contact, def, contact.course.vx, contact.course.vy, dt);
    if (contact.aware >= AWARE.notice) {
      contact.state = 'shadowing';
      sim.events.emit('contact.noticed', info);
    } else if ((range > SCOPE.range && contact.x * (contact.vx - helm.vx) + contact.y * (contact.vy - helm.vy) > 0) || (tick - contact.born) / 20 > PASS_SECONDS) {
      // Off the edge of the scope and still opening: it never knew we were here.
      sim.events.emit('contact.passed', info);
      record(sim, contact, 'passed');
      remove(sim, contact);
    }
    return;
  }

  if (contact.state === 'shadowing') {
    contact.watch += dt;
    if (contact.aware >= AWARE.notice || drawn) {
      // It has something: it hangs off it and watches.
      headFor(contact, def, est.x, est.y, def.speed.cruise, dt, helm, drawn ? 0 : (def.standoff ?? 25));
      contact.lostFor = Math.max(0, contact.lostFor - 2 * dt);
      contact.searching = false;
    } else {
      // Nothing to go on: it goes to where we ought to be (at a run, if it had us a moment ago) and looks
      // around. Its patience is mostly spent there, a little on the way. Its fix on a ship it has just lost
      // is only so good, and worse from far off.
      if (!contact.searching) {
        contact.searching = true;
        const off = unit(sim.rng.stream('encounters').range(0, 360));
        const by = Math.max(SEARCH_ERROR.least, SEARCH_ERROR.ofRange * range) * sim.rng.stream('encounters').range(0.5, 1);
        est.x += off.x * by;
        est.y += off.y * by;
      }
      headFor(contact, def, est.x, est.y, contact.sprint ? def.speed.chase : def.speed.cruise, dt, helm, 1);
      const there = Math.hypot(est.x - contact.x, est.y - contact.y) <= SEARCH_RADIUS;
      const spent = there ? dt : dt * SEARCH_ON_THE_WAY;
      contact.lostFor += spent;
      if (burning(sim)) contact.burnFor += spent;
    }
    if (contact.lostFor >= def.patience) return lose(sim, contact, contact.fooled ? 'decoy' : contact.burnFor > contact.lostFor / 2 ? 'outrun' : 'quiet');
    // Sure of us, or it has looked long enough and comes in anyway.
    if (contact.aware >= AWARE.close || (contact.aware >= AWARE.notice && contact.watch >= (def.shadow ?? 40))) {
      contact.state = 'closing';
      sim.events.emit('contact.closing', info);
    }
    return;
  }

  if (contact.state === 'closing') {
    // A ship that boards comes right in; one that never docks holds off at its standoff and works from there.
    const boards = BOARDING_WANTS.includes(def.wants);
    headFor(contact, def, est.x, est.y, def.speed.chase, dt, helm, boards || drawn ? 0 : def.standoff);
    contact.chased += dt;
    if (boards && range <= reachOf(def) && !drawn && contact.aware >= AWARE.notice) {
      contact.state = 'alongside';
      contact.held = 0;
      sim.events.emit('contact.alongside', { ...info, hail: def.alongside.hail, seconds: def.alongside.seconds });
    } else if (contact.chased >= def.chase) {
      lose(sim, contact, contact.fooled ? 'decoy' : burning(sim) || speedOf(sim) > 0.2 ? 'outrun' : 'quiet'); // a long chase is not worth the fuel
    } else if (contact.aware < AWARE.drop) {
      contact.state = 'shadowing';
      contact.sprint = true;
      contact.lostFor = 0;
      contact.burnFor = 0;
      sim.events.emit('contact.searching', info);
    }
    return;
  }

  // Alongside: it holds station on us while it readies the clamp (or its pods). A ship that can outpace it can still pull clear.
  const speed = Math.hypot(helm.vx, helm.vy);
  const cap = speed > def.speed.chase ? def.speed.chase / speed : 1;
  steer(contact, def, helm.vx * cap, helm.vy * cap, dt);
  if (contact.podsOut) return; // its party is in the air: it waits to see how many get there
  contact.held += dt;
  // A second ship waits its turn alongside while one is clamped on, or while pods are in the air.
  const free = !sim.state.boarding && !sim.state.scope.pods.length;
  if (range > reachOf(def) * 2.5) {
    contact.state = 'closing';
    sim.events.emit('contact.closing', info);
  } else if (contact.held >= def.alongside.seconds && free && def.pods) launchPods(sim, contact, def, info);
  else if (contact.held >= def.alongside.seconds && free) {
    contact.state = 'docked';
    sim.events.emit('contact.docked', { ...info, wants: def.wants });
    record(sim, contact, 'docked');
    remove(sim, contact);
    // The clamp goes on and its party comes to our lock (H.2, boarders.js).
    startBoarding(sim, def, { contact: contact.id });
  }
}

/** How close a boarding ship has to be to put its party across: alongside for a clamp, further off for pods. */
const reachOf = (def) => (def.pods ? def.pods.range : ALONGSIDE);

/** A grapple tender puts its party across in pods, one boarder to a pod (D-176). Point defence gets a go at each. */
function launchPods(sim, contact, def, info) {
  const { scope, tick } = sim.state;
  const size = def.party.size;
  for (let n = 0; n < size; n++) scope.pods.push({ id: scope.next++, contact: contact.id, encounter: def.id, lands: tick + Math.round(def.pods.flight * 20) });
  contact.launched = size;
  contact.podsOut = size;
  contact.podsLanded = 0;
  sim.events.emit('pods.launched', { ...info, pods: size, lands: tick + Math.round(def.pods.flight * 20) });
}

/** The last of a contact's pods is down or in: its party, what is left of it, comes to our lock. */
function podsSettled(sim, contactId, encounter) {
  const contact = findContact(sim, contactId);
  const def = sim.encounters.byId.get(encounter);
  const landed = contact ? contact.podsLanded : 0;
  if (contact) {
    contact.podsOut = 0;
    const info = { contact: contact.id, encounter: def.id, name: def.name, tick: sim.state.tick };
    if (contact.state !== 'lost') {
      if (landed > 0) {
        contact.state = 'docked';
        sim.events.emit('contact.docked', { ...info, wants: def.wants, pods: landed });
        record(sim, contact, 'docked');
        remove(sim, contact);
      } else {
        sim.events.emit('contact.deterred', { ...info, why: 'pods' });
        lose(sim, contact, 'deterred');
      }
    }
  }
  if (landed > 0) startBoarding(sim, def, { contact: contactId, size: landed });
}

// ---------- what else a contact does about us (H.3) ----------

/** Is this contact's gun cleared to fire on us, by any of its `guns.when`? */
function gunCleared(sim, contact, def, range) {
  const near = contact.state === 'closing' || contact.state === 'alongside';
  return def.guns.when.some((when) => {
    if (when === 'running') return near && burning(sim);
    if (when === 'shot') return contact.shotAt;
    if (when === 'closing') return near;
    return contact.tolled && sim.state.tick >= contact.tollEnds && range <= def.toll.zone; // 'toll'
  });
}

/** A contact with a gun fires on us when it is cleared to, from inside its range, with a track on us. Warning shots first. */
function stepContactGun(sim, contact, def, range, dt) {
  const guns = def.guns;
  if (!guns || sim.state.hull.points === 0) return;
  const cleared = contact.state !== 'unseen' && contact.target === null && contact.aware >= AWARE.notice && range <= guns.range && gunCleared(sim, contact, def, range);
  if (!cleared) {
    if (contact.reload !== null) contact.reload = Math.max(contact.reload, guns.every * 0.5);
    return;
  }
  contact.reload = contact.reload === null ? guns.every * 0.5 : contact.reload - dt;
  if (contact.reload > 0) return;
  contact.reload = guns.every;
  const warn = contact.fired < (guns.warn ?? 0);
  contact.fired += 1;
  // A round finds us as well as it knows where we are, and less well from further off.
  const chance = clamp01(guns.hit * contact.aware * (1 - (0.5 * range) / guns.range));
  const shot = fireOn(sim, { contact: contact.id, weapon: guns.weapon, miss: 1 - chance, warn });
  if (shot) sim.events.emit('contact.fired', { contact: contact.id, encounter: def.id, name: def.name, weapon: guns.weapon, warn, chance, lands: shot.lands, tick: sim.state.tick });
}

/** A carrier with us in reach puts drones out, up to its most at once and all it carries; when they are spent, so is it. */
function stepDroneBay(sim, contact, def, range) {
  const spec = def.drones;
  if (!spec) return;
  const { scope, tick } = sim.state;
  const out = scope.drones.filter((drone) => drone.contact === contact.id).length;
  if (contact.launched >= spec.total) {
    if (!out) {
      sim.events.emit('contact.spent', { contact: contact.id, encounter: def.id, name: def.name, tick });
      lose(sim, contact, 'swarmed');
    }
    return;
  }
  const near = contact.state === 'closing' || contact.state === 'alongside';
  if (!near || contact.target !== null || contact.aware < AWARE.notice || range > spec.range || out >= spec.max) return;
  if (contact.lastLaunch !== null && tick - contact.lastLaunch < Math.round(spec.every * 20)) return;
  contact.lastLaunch = tick;
  contact.launched += 1;
  const drone = { id: scope.next++, contact: contact.id, lands: tick + Math.round(DRONE.flight * 20), on: false, next: null };
  scope.drones.push(drone);
  sim.events.emit('drone.launched', { contact: contact.id, drone: drone.id, name: def.name, out: out + 1, left: spec.total - contact.launched, tick });
}

/** A gunnery drone close enough builds a scan of us; finished, it calls in a ship that will do something about it. */
function stepScan(sim, contact, def, range, dt) {
  const spec = def.scan;
  if (!spec) return;
  const near = contact.state === 'shadowing' || contact.state === 'closing';
  const info = { contact: contact.id, encounter: def.id, name: def.name, tick: sim.state.tick };
  if (near && contact.target === null && contact.aware >= AWARE.notice && range <= spec.range) {
    if (contact.scan === 0) sim.events.emit('contact.scanning', { ...info, seconds: spec.seconds });
    contact.scan += dt;
  } else contact.scan = Math.max(0, contact.scan - SCAN_DECAY * dt);
  if (contact.scan < spec.seconds) return;
  sim.events.emit('contact.scanned', { ...info, calls: spec.calls ?? null });
  const caller = spec.calls ? sim.encounters.byId.get(spec.calls) : null;
  if (caller) {
    const rng = sim.rng.stream('encounters');
    spawnContact(sim, caller, { range: rng.range(SPAWN.near, SPAWN.far), bearing: rng.range(0, 360), state: 'closing' });
  }
  lose(sim, contact, 'scanned');
}

/** A bulwark with us inside its zone calls its toll once, and gives us its grace to pay before its gun clears. */
function stepToll(sim, contact, def, range) {
  const spec = def.toll;
  if (!spec || contact.tolled) return;
  const near = contact.state === 'shadowing' || contact.state === 'closing';
  if (!near || contact.aware < AWARE.notice || range > spec.zone) return;
  contact.tolled = true;
  contact.tollEnds = sim.state.tick + Math.round(spec.grace * 20);
  sim.events.emit('contact.toll', { contact: contact.id, encounter: def.id, name: def.name, cost: spec.cost, text: spec.demand, seconds: spec.grace, tick: sim.state.tick });
}

/** Everything a contact does besides moving: its gun, its drones, its scan, its toll. */
function stepThreat(sim, contact, dt) {
  if (contact.state === 'lost' || contact.state === 'docked' || contact.state === 'unseen') return;
  const def = defOf(sim, contact);
  const range = rangeOf(contact.x, contact.y);
  stepToll(sim, contact, def, range);
  stepContactGun(sim, contact, def, range, dt);
  stepDroneBay(sim, contact, def, range);
  if (contact.state !== 'lost') stepScan(sim, contact, def, range, dt);
}

/** Drones crossing to the hull, and those on it zapping a room every few seconds. Their carrier gone, they fall dead. */
function stepDrones(sim) {
  const { scope, tick } = sim.state;
  for (const drone of [...scope.drones]) {
    const carrier = findContact(sim, drone.contact);
    if (!carrier || carrier.state === 'lost') {
      scope.drones.splice(scope.drones.indexOf(drone), 1);
      sim.events.emit('drone.lost', { drone: drone.id, cause: 'carrier', tick });
      continue;
    }
    const spec = defOf(sim, carrier).drones;
    if (!drone.on) {
      if (tick < drone.lands) continue;
      drone.on = true;
      drone.next = tick + Math.round(spec.fire * 20);
      drone.dies = tick + Math.round(DRONE.life * 20);
      sim.events.emit('drone.attached', { drone: drone.id, contact: carrier.id, tick });
      continue;
    }
    if (tick >= drone.dies) {
      scope.drones.splice(scope.drones.indexOf(drone), 1);
      sim.events.emit('drone.lost', { drone: drone.id, cause: 'spent', tick });
      continue;
    }
    if (tick < drone.next) continue;
    drone.next = tick + Math.round(spec.fire * 20);
    if (sim.state.hull.points > 0) fireOn(sim, { contact: carrier.id, weapon: DRONE_WEAPON, miss: DRONE.miss, drone: drone.id });
  }
}

/** Pods in the air come in on our hull; a contact whose pods are all down or in settles what is left of its party. */
function stepPods(sim) {
  const { scope, tick } = sim.state;
  const settled = new Map();
  for (const pod of [...scope.pods]) {
    if (tick < pod.lands) continue;
    scope.pods.splice(scope.pods.indexOf(pod), 1);
    const contact = findContact(sim, pod.contact);
    if (contact) contact.podsLanded += 1;
    sim.events.emit('pod.landed', { pod: pod.id, contact: pod.contact, tick });
    settled.set(pod.contact, pod.encounter);
  }
  for (const [id, encounter] of settled) if (!scope.pods.some((pod) => pod.contact === id)) podsSettled(sim, id, encounter);
}

// ---------- our gun and our point defence, as they meet a contact (combat.js fires them) ----------

/** We open fire on a contact: it knows exactly where we are now, comes for us, and its faction hears of it. */
export function shotAt(sim, contact) {
  const def = defOf(sim, contact);
  const first = !contact.shotAt;
  contact.shotAt = true;
  contact.wary = true;
  contact.aware = 1;
  contact.target = null;
  Object.assign(contact.est, { x: 0, y: 0, vx: sim.state.helm.vx, vy: sim.state.helm.vy });
  if (contact.state === 'unseen' || contact.state === 'shadowing') {
    contact.state = 'closing';
    sim.events.emit('contact.closing', { contact: contact.id, encounter: def.id, name: def.name, tick: sim.state.tick });
  }
  if (first && def.party?.faction) changeReputation(sim, def.party.faction, GUN.standing, 'fired-on');
}

/** Our round comes down by it: a hit, or a warning shot across its bow. Enough of either and it breaks off. */
export function struck(sim, contact, hit) {
  const def = defOf(sim, contact);
  contact.fear += hit ? GUN.fear.hit : GUN.fear.miss;
  const info = { contact: contact.id, encounter: def.id, name: def.name, hit, fear: contact.fear, nerve: def.nerve ?? 0, tick: sim.state.tick };
  sim.events.emit('contact.struck', info);
  if ((def.nerve ?? 0) > 0 && contact.fear >= def.nerve - 1e-9) {
    sim.events.emit('contact.deterred', { ...info, why: 'gun' });
    lose(sim, contact, 'deterred');
  }
}

/** What point defence would shoot at now: a pod in the air first, then a drone on its way, then one on the hull. */
export function pdTarget(sim) {
  const { pods, drones } = sim.state.scope;
  if (pods.length) return { kind: 'pod', item: pods[0] };
  const flying = drones.find((drone) => !drone.on);
  if (flying) return { kind: 'drone', item: flying };
  if (drones.length) return { kind: 'drone', item: drones[0] };
  return null;
}

/** A pod or a drone is shot down (or a drone burns out in a brace: `cause`). */
export function pdShot(sim, target, cause = 'pd') {
  const { scope, tick } = sim.state;
  const list = target.kind === 'pod' ? scope.pods : scope.drones;
  const index = list.findIndex((item) => item.id === target.item.id);
  if (index < 0) return;
  const [item] = list.splice(index, 1);
  if (target.kind === 'drone') {
    sim.events.emit('drone.lost', { drone: item.id, cause, tick });
    return;
  }
  sim.events.emit('pod.downed', { pod: item.id, contact: item.contact, tick });
  if (!scope.pods.some((pod) => pod.contact === item.contact)) podsSettled(sim, item.contact, item.encounter);
}

// ---------- each tick ----------

function stepHelm(sim, dt) {
  const { helm } = sim.state;
  const share = driveShare(sim);
  // She only comes round with the engines up and someone at the helm.
  if (helm.heading !== helm.wanted && share > 0 && hasPilot(sim)) {
    const turn = turnBetween(helm.heading, helm.wanted);
    const step = HELM.turn * dt;
    helm.heading = Math.abs(turn) <= step ? helm.wanted : norm360(helm.heading + Math.sign(turn) * step);
  }
  if (helm.burn && share > 0) {
    const way = unit(helm.heading);
    helm.vx += way.x * HELM.accel * share * dt;
    helm.vy += way.y * HELM.accel * share * dt;
    const speed = Math.hypot(helm.vx, helm.vy);
    const top = HELM.speed * share;
    if (speed > top) {
      // Over the top speed (the engines were turned down): the push only bends the course, and the excess bleeds off.
      const to = Math.max(top, speed - HELM.accel * dt);
      helm.vx *= to / speed;
      helm.vy *= to / speed;
    }
  }
}

/** The helm, the decoys, every contact, and the scope's picture of them. */
export function stepEncounters(sim, dt) {
  stepHelm(sim, dt);
  const { scope, helm } = sim.state;
  if (!scope.contacts.length && !scope.decoys.length && !scope.drones.length && !scope.pods.length) return;
  const rng = sim.rng.stream('encounters');
  for (const decoy of scope.decoys) {
    decoy.x += (decoy.vx - helm.vx) * dt;
    decoy.y += (decoy.vy - helm.vy) * dt;
    decoy.left -= dt;
  }
  const loud = signature(sim).total;
  for (const contact of [...scope.contacts]) {
    stepContact(sim, contact, dt, loud);
    if (!scope.contacts.includes(contact)) continue;
    stepThreat(sim, contact, dt);
    if (!scope.contacts.includes(contact)) continue;
    contact.x += (contact.vx - helm.vx) * dt;
    contact.y += (contact.vy - helm.vy) * dt;
    stepTrack(sim, contact, dt, rng);
  }
  stepDrones(sim);
  stepPods(sim);
  // A decoy that has burned out or drifted off: anything still chasing it finds nothing there.
  for (const decoy of scope.decoys.filter((d) => d.left <= 0)) {
    scope.decoys.splice(scope.decoys.indexOf(decoy), 1);
    for (const contact of scope.contacts) {
      if (contact.target !== decoy.id) continue;
      contact.target = null;
      contact.fooled = true;
      contact.aware = 0;
      sim.events.emit('contact.wise', { contact: contact.id, encounter: contact.encounter, name: defOf(sim, contact).name, decoy: decoy.id, tick: sim.state.tick });
    }
    sim.events.emit('decoy.spent', { decoy: decoy.id, kind: decoy.kind, tick: sim.state.tick });
  }
}

function dropDecoy(sim, kind, extra = {}) {
  const { scope, helm, tick } = { ...sim.state, tick: sim.state.tick };
  const spec = DECOYS[kind];
  const astern = unit(helm.heading + 180);
  const decoy = { id: scope.next++, kind, x: 0, y: 0, vx: helm.vx + astern.x * spec.kick, vy: helm.vy + astern.y * spec.kick, left: spec.seconds };
  scope.decoys.push(decoy);
  if (spec.flash) flash(sim, spec.flash);
  sim.events.emit('decoy.dropped', { decoy: decoy.id, kind, ...extra, tick });
  return decoy;
}

/** Wire the scope to the rest of the sim: a jettisoned crate is a decoy, a jump leaves everyone behind, and arriving somewhere may bring company. */
export function attachEncounters(sim) {
  sim.events.on('crate.jettisoned', (event) => {
    if (event.kind !== 'ammo') dropDecoy(sim, 'crate', { crate: event.crate, label: event.label });
  });
  sim.events.on('sector.jumped', () => {
    const { scope, helm } = sim.state;
    for (const contact of [...scope.contacts]) {
      if (contact.state !== 'lost') record(sim, contact, 'jumped');
    }
    scope.contacts = [];
    scope.decoys = [];
    scope.drones = [];
    scope.pods = [];
    Object.assign(helm, { vx: 0, vy: 0, burn: false, wanted: helm.heading });
  });
  sim.events.on('sector.arrived', (event) => {
    const chance = sim.state.run?.contactChance?.[event.kind] ?? 0;
    if (!(chance > 0) || !sim.encounters.all.length || sim.state.run.delivered) return;
    const rng = sim.rng.stream('encounters');
    if (!rng.chance(chance)) return;
    const pool = sim.encounters.all.filter((def) => (def.weight ?? 1) > 0 && (!def.at || def.at.includes(event.kind)));
    if (!pool.length) return;
    const def = rng.weighted(pool, (item) => item.weight ?? 1);
    // Far enough out that a ship with her sensors up sees it before it can see her: there is time to do something.
    spawnContact(sim, def, { range: rng.range(SPAWN.near, SPAWN.far), bearing: rng.range(0, 360), miss: rng.range(0, SPAWN.miss), side: rng.chance(0.5) ? 1 : -1 });
  });
}

// ---------- orders ----------

/** A contact on the board by its id, or null. */
export const findContact = (sim, id) => sim.state.scope.contacts.find((contact) => contact.id === id) ?? null;

/** Why we cannot hail this contact with this bluff right now, or null. */
export function whyNoHail(sim, cmd) {
  const contact = findContact(sim, cmd.contact);
  if (!contact) return `no contact "${cmd.contact}" on the scope`;
  if (!BLUFFS[cmd.bluff]) return `bluff must be one of ${Object.keys(BLUFFS).join(', ')}`;
  if (contact.state === 'lost') return 'it is already breaking off';
  if (!contact.track.shown) return 'there is nothing on the scope to hail';
  if (contact.tried.includes(cmd.bluff)) return 'they have heard that one';
  if (contact.wary) return 'they have stopped listening';
  if (negotiation(sim) < 1) return 'nobody aboard can talk their way past a hail';
  if (!(defOf(sim, contact).bluffs?.[cmd.bluff] > 0)) return contact.track.known ? `the ${defOf(sim, contact).name.toLowerCase()} will not believe that` : 'Margo cannot tell what it is, let alone what it would believe';
  return null;
}

/** Why we cannot pay this contact's toll right now, or null. */
export function whyNoPay(sim, id) {
  const contact = findContact(sim, id);
  if (!contact) return `no contact "${id}" on the scope`;
  const toll = defOf(sim, contact).toll;
  if (!toll) return 'it is not asking for anything';
  if (!contact.tolled) return 'it has not called a toll';
  if (contact.state === 'lost') return 'it is already breaking off';
  if (sim.state.money < toll.cost) return `it wants ${toll.cost} and we have ${sim.state.money}`;
  return null;
}

export const ENCOUNTER_COMMANDS = {
  // Come round to a new heading (degrees clockwise from the top of the scope).
  'helm.heading': {
    check(sim, cmd) {
      if (!(typeof cmd.heading === 'number' && Number.isFinite(cmd.heading))) return 'needs a heading in degrees';
      if (sim.state.systems.engines.power < 1) return 'the engines have no power to bring her round';
      if (!hasPilot(sim)) return 'nobody is at the helm';
      return null;
    },
    apply(sim, cmd) {
      sim.state.helm.wanted = norm360(cmd.heading);
      sim.events.emit('helm.heading', { heading: sim.state.helm.wanted, tick: sim.state.tick });
    },
  },
  // Light the drive, or cut it and drift on as we are going.
  'helm.burn': {
    check(sim, cmd) {
      if (typeof cmd.on !== 'boolean') return 'needs on: true or false';
      if (cmd.on === sim.state.helm.burn) return cmd.on ? 'the drive is already burning' : 'the drive is already cold';
      if (!cmd.on) return null;
      if (sim.state.systems.engines.power < 1) return 'the engines have no power';
      if (!hasPilot(sim)) return 'nobody is at the helm';
      return null;
    },
    apply(sim, cmd) {
      sim.state.helm.burn = cmd.on;
      sim.events.emit('helm.burn', { on: cmd.on, tick: sim.state.tick });
    },
  },
  // Put a flare out astern: bright and hot for a short while, for something to chase instead of us.
  'decoy.flare': {
    check: (sim) => (sim.state.helm.flares > 0 ? null : 'no flares left'),
    apply(sim) {
      sim.state.helm.flares -= 1;
      dropDecoy(sim, 'flare', { left: sim.state.helm.flares });
    },
  },
  // Hail a contact with a lie. It turns away, or it knows exactly where we are and stops listening.
  'contact.hail': {
    check: (sim, cmd) => whyNoHail(sim, cmd),
    apply(sim, cmd) {
      const contact = findContact(sim, cmd.contact);
      const def = defOf(sim, contact);
      const chance = bluffChance(sim, contact, cmd.bluff);
      const ok = sim.rng.stream('tactics').chance(chance);
      contact.tried.push(cmd.bluff);
      sim.events.emit('contact.hailed', { contact: contact.id, encounter: def.id, name: def.name, bluff: cmd.bluff, ok, chance, tick: sim.state.tick });
      if (ok) return lose(sim, contact, 'bluff');
      // A transmission is a bearing: it has us now, and it has heard enough.
      contact.wary = true;
      contact.aware = 1;
      contact.target = null;
      Object.assign(contact.est, { x: 0, y: 0, vx: sim.state.helm.vx, vy: sim.state.helm.vy });
      if (contact.state === 'unseen' || contact.state === 'shadowing') {
        contact.state = 'closing';
        sim.events.emit('contact.closing', { contact: contact.id, encounter: def.id, name: def.name, tick: sim.state.tick });
      }
    },
  },
  // Pay a bulwark's toll: it lets us through the lane.
  'contact.pay': {
    check: (sim, cmd) => whyNoPay(sim, cmd.contact),
    apply(sim, cmd) {
      const contact = findContact(sim, cmd.contact);
      const def = defOf(sim, contact);
      sim.state.money -= def.toll.cost;
      sim.events.emit('contact.paid', { contact: contact.id, encounter: def.id, name: def.name, cost: def.toll.cost, tick: sim.state.tick });
      lose(sim, contact, 'paid');
    },
  },
  // Debug panel and tests: put a contact on the board, or clear it.
  'debug.contact': {
    check(sim, cmd) {
      if (cmd.clear === true) return null;
      if (!sim.encounters.byId.has(cmd.encounter)) return `no encounter "${cmd.encounter}"`;
      if (cmd.state !== undefined && !['unseen', 'shadowing', 'closing'].includes(cmd.state)) return 'state must be unseen, shadowing or closing';
      for (const key of ['range', 'bearing', 'miss']) if (cmd[key] !== undefined && !(typeof cmd[key] === 'number' && Number.isFinite(cmd[key]) && cmd[key] >= 0)) return `${key} must be a number, 0 or more`;
      return null;
    },
    apply(sim, cmd) {
      if (cmd.clear) {
        Object.assign(sim.state.scope, { contacts: [], decoys: [], drones: [], pods: [] });
        return;
      }
      spawnContact(sim, sim.encounters.byId.get(cmd.encounter), { range: cmd.range, bearing: cmd.bearing, miss: cmd.miss, state: cmd.state });
    },
  },
};

// ---------- invariants ----------

export function checkEncounterInvariants(sim) {
  const problems = [];
  const { helm, scope } = sim.state;
  const finite = (...values) => values.every((value) => typeof value === 'number' && Number.isFinite(value));
  if (!(helm.heading >= 0 && helm.heading < 360) || !(helm.wanted >= 0 && helm.wanted < 360)) problems.push(`helm: heading ${helm.heading}, wanted ${helm.wanted}`);
  if (!finite(helm.vx, helm.vy)) problems.push('helm: velocity is not a number');
  else if (Math.hypot(helm.vx, helm.vy) > HELM.speed + 1e-6) problems.push(`helm: speed is ${Math.hypot(helm.vx, helm.vy)}`);
  if (!(Number.isInteger(helm.flares) && helm.flares >= 0)) problems.push(`helm: ${helm.flares} flares`);
  for (const contact of scope.contacts) {
    const where = `contact ${contact.id}`;
    if (!sim.encounters.byId.has(contact.encounter)) problems.push(`${where}: no encounter "${contact.encounter}"`);
    if (!STATES.includes(contact.state) || contact.state === 'docked') problems.push(`${where}: on the board in state "${contact.state}"`);
    if (!finite(contact.x, contact.y, contact.vx, contact.vy, contact.est.x, contact.est.y, contact.est.vx, contact.est.vy)) problems.push(`${where}: its position is not a number`);
    if (!(contact.aware >= 0 && contact.aware <= 1)) problems.push(`${where}: awareness is ${contact.aware}`);
    if (!(contact.track.q >= 0 && contact.track.q <= 1)) problems.push(`${where}: return quality is ${contact.track.q}`);
    if (contact.target !== null && !scope.decoys.some((decoy) => decoy.id === contact.target)) problems.push(`${where}: chasing a decoy that is not there`);
  }
  for (const drone of scope.drones) {
    if (!scope.contacts.some((contact) => contact.id === drone.contact)) problems.push(`drone ${drone.id}: its carrier is not on the board`);
    if (drone.on ? !Number.isInteger(drone.next) : !Number.isInteger(drone.lands)) problems.push(`drone ${drone.id}: no clock`);
  }
  for (const pod of scope.pods) if (!(pod.lands >= sim.state.tick)) problems.push(`pod ${pod.id}: should have landed at tick ${pod.lands}`);
  for (const contact of scope.contacts) {
    if (contact.podsOut && contact.state !== 'alongside' && contact.state !== 'lost') problems.push(`contact ${contact.id}: has pods out while ${contact.state}`);
    if (!(contact.fear >= 0)) problems.push(`contact ${contact.id}: fear is ${contact.fear}`);
  }
  for (const decoy of scope.decoys) {
    if (!DECOYS[decoy.kind]) problems.push(`decoy ${decoy.id}: of no known kind`);
    if (!finite(decoy.x, decoy.y, decoy.vx, decoy.vy, decoy.left)) problems.push(`decoy ${decoy.id}: its position is not a number`);
  }
  return problems;
}
