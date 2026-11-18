// The watch bill: who is on, who sleeps, and how tired they are (H.4, D-182,
// D-183; sleep and fatigue pulled forward from S4.2's rest need). DOM-free.
//
// state.roster = { watches, on, t }
//   watches  0  no watch bill is kept: nobody is walked anywhere, nobody tires
//               (a bare test sim; the game always keeps one)
//            1  all hands: everyone is up, at their posts, and wearing down
//            2  watch and watch: half the crew on, half below, turn about
//            3  three watches: a third on, well rested
//   on       which watch has the deck
//   t        ticks into it
//
// Each crew member has a `watch`, a `post` (stations.js), a `fatigue` from 0
// (fresh) to 1 (dead on their feet), and `asleep`. At the change of the watch
// the oncoming hands walk to their posts and the offgoing ones to their bunks
// in the quarters, once they are free of whatever they were doing. Anyone
// below, idle and in the quarters is asleep, and sleep is the only thing that
// takes fatigue off. An order wakes a sleeper and they go; the captain's word
// stands until the next change of the watch or a muster.
//
// Past TIRED.from a hand works worse, on a station or with a patch kit, down
// to TIRED.floor of their pace. Two watches wear a crew down slowly over a
// long crossing; three keep it fresh with fewer hands up; all hands is for
// the bad quarter of an hour.
//
// Hunger (F.7, D-241; pulled forward in small from S4.2): each hand has a
// `hunger` from 0 (fed) to 1 (starving) that climbs while they are awake,
// faster at work. Off watch in the quarters and mess they eat before they
// turn in, and a hand on watch who is hungry eats if they are sent there.
// Past HUNGER.from a hand is slower, down to HUNGER.floor of their pace. All
// hands means nobody goes below to eat: the watch bill is a choice between
// hands at their posts now and hands fit to stand them later. A starving
// hand blames the captain for it (the `hungry` memory). What tiredness and
// hunger make a hand get wrong is slips.js.

import { SHIP_HOUR, WATCH_HOURS } from './shipclock.js';

const TICKS = 20;

/**
 * A watch in seconds (WATCH_HOURS on the ship clock, 240 s: H.8 made the 240 s watch eight hours, D-206), and
 * fatigue gained a second awake (more at work) and lost a second asleep.
 */
export const WATCH = Object.freeze({ seconds: WATCH_HOURS * SHIP_HOUR, tire: 1 / 480, work: 1.5, rest: 1 / 300 });
/**
 * A hand off watch who has been stood idle this many seconds away from the quarters, with nothing waiting for an
 * answer in their room, goes back below on their own (F.7, D-244): an order still wakes them, but once it is done
 * they turn in rather than stand about until the next change of the watch.
 */
export const BACK_BELOW = 30;
/** Fatigue past `from` slows a hand, down to `floor` of their pace at 1. */
export const TIRED = Object.freeze({ from: 0.6, floor: 0.6 });

/**
 * Hunger gained a second awake (WATCH.work times that at work) and asleep, lost a second eating, the point past
 * which it slows a hand (down to `floor` of their pace when starving), when a meal is done, how hungry a hand off
 * watch (`meal`) or on it (`onWatch`) must be to sit down to one in the mess, and when they are starving (the
 * `crew.starving` event, once until fed again).
 */
export const HUNGER = Object.freeze({ awake: 1 / 600, asleep: 1 / 2400, eat: 1 / 20, from: 0.5, floor: 0.75, sated: 0.05, meal: 0.2, onWatch: 0.4, starving: 0.9 });

/** How much of their pace hunger leaves a crew member: 1 when fed, HUNGER.floor when starving. */
export function fed(member) {
  const hunger = member?.hunger ?? 0;
  if (hunger <= HUNGER.from) return 1;
  return 1 - (1 - HUNGER.floor) * Math.min(1, (hunger - HUNGER.from) / (1 - HUNGER.from));
}

/** One word for how hungry someone is, or null when they are not. */
export const hungryWord = (member) => ((member?.hunger ?? 0) >= HUNGER.starving ? 'Starving' : (member?.hunger ?? 0) > HUNGER.from ? 'Hungry' : null);

/** How much of their pace tiredness and hunger together leave a crew member (F.7): on a station, at a job, on their feet. */
export const worn = (member) => tiredness(member) * fed(member);

/** How much of their pace a crew member has left: 1 when fresh, TIRED.floor when dead on their feet. */
export function tiredness(member) {
  const fatigue = member?.fatigue ?? 0;
  if (fatigue <= TIRED.from) return 1;
  return 1 - (1 - TIRED.floor) * Math.min(1, (fatigue - TIRED.from) / (1 - TIRED.from));
}

/** One word for how tired someone is. */
export const tiredWord = (member) => ((member?.fatigue ?? 0) >= 0.9 ? 'Exhausted' : (member?.fatigue ?? 0) > TIRED.from ? 'Tired' : (member?.fatigue ?? 0) > 0.3 ? 'Steady' : 'Fresh');

/** The watch bill of a new sim. */
export const newRosterState = (watches = 0) => ({ watches, on: 0, t: 0 });

const mine = (sim) =>
  Object.values(sim.state.crew)
    .filter((member) => member.owner === 'player')
    .sort((a, b) => a.index - b.index);

/** Deal the crew into watches in roster order, and tell them all where they should be. */
export function dealWatches(sim) {
  const { roster } = sim.state;
  const count = Math.max(1, roster.watches);
  mine(sim).forEach((member, place) => {
    member.watch = place % count;
  });
  roster.on %= count;
  callAll(sim);
}

/** Is this crew member's watch on deck? With one watch, or no bill at all, everyone's is. */
export const onWatch = (sim, member) => sim.state.roster.watches <= 1 || member.watch === sim.state.roster.on;

/** Seconds until the watch changes, or null when there is nothing to change. */
export const watchLeft = (sim) => (sim.state.roster.watches > 1 ? WATCH.seconds - sim.state.roster.t / TICKS : null);

/** The name of a watch: First, Second, Third. */
export const watchName = (index) => ['First', 'Second', 'Third'][index] ?? `Watch ${index + 1}`;

function callAll(sim) {
  for (const member of mine(sim)) if (member.alive) member.due = onWatch(sim, member) ? 'post' : 'bunk';
}

/** Hands free, on their feet and in plain sight: able to walk off to a post or a bunk. */
const free = (member) => !member.path.length && !member.job && !member.carry && !member.hidden && member.task === 'idle';

/** The orders that need someone walked somewhere get `send(sim, member, roomId)` and `roomOfStation` from sim.js. */
export function watchCommands() {
  return {
    // How many watches the crew stands: 1 (all hands), 2 or 3.
    'roster.watches': {
      check(sim, cmd) {
        if (![1, 2, 3].includes(cmd.count)) return 'count must be 1, 2 or 3';
        if (cmd.count === sim.state.roster.watches) return 'that is the watch bill already';
        return null;
      },
      apply(sim, cmd) {
        const { roster } = sim.state;
        roster.watches = cmd.count;
        roster.t = 0;
        dealWatches(sim);
        sim.events.emit('roster.watches', { count: cmd.count, tick: sim.state.tick });
      },
    },
    // Move someone to another watch.
    'crew.watch': {
      check(sim, cmd) {
        const member = sim.state.crew[cmd.crew];
        if (!member?.alive || member.owner !== 'player') return `no crew member "${cmd.crew}" of ours aboard`;
        const count = Math.max(1, sim.state.roster.watches);
        if (!Number.isInteger(cmd.watch) || cmd.watch < 0 || cmd.watch >= count) return count === 1 ? 'there is only one watch' : `watch must be 0 to ${count - 1}`;
        if (member.watch === cmd.watch) return 'they are in that watch already';
        return null;
      },
      apply(sim, cmd) {
        const member = sim.state.crew[cmd.crew];
        member.watch = cmd.watch;
        member.due = onWatch(sim, member) ? 'post' : 'bunk';
        sim.events.emit('crew.watch', { crew: member.id, watch: cmd.watch, tick: sim.state.tick });
      },
    },
    // To your stations: everyone on watch to their post, everyone below to their bunk.
    'roster.muster': {
      check: (sim) => (mine(sim).some((member) => member.alive) ? null : 'there is nobody to muster'),
      apply(sim) {
        callAll(sim);
        sim.events.emit('roster.mustered', { tick: sim.state.tick });
      },
    },
  };
}

/**
 * The watch turns over, people go where they are due, sleepers sleep and everyone else tires.
 * `send(sim, member, roomId)` walks someone off (crew.js); `postRoom(sim, station)` is where a post is (stations.js).
 */
export function stepWatches(sim, seconds, { send, postRoom }) {
  const { roster, tick } = sim.state;
  const crew = mine(sim);
  if (roster.watches > 1) {
    roster.t += 1;
    if (roster.t >= WATCH.seconds * TICKS) {
      roster.t = 0;
      const from = roster.on;
      roster.on = (roster.on + 1) % roster.watches;
      callAll(sim);
      sim.events.emit('watch.changed', { from, to: roster.on, tick });
    }
  }
  const bunks = sim.layout.roomOfSystem('quarters');
  const bunksThere = bunks && !sim.state.rooms[bunks.id].jettisoned;
  for (const member of crew) {
    if (!member.alive) {
      member.asleep = false;
      continue;
    }
    // Where they are due, once they are free to go. Nobody wanders off with strangers aboard.
    if (member.due && !sim.state.boarding && free(member) && (tick + member.index * 7) % TICKS === 0) {
      const to = member.due === 'post' ? (member.post ? postRoom(sim, member.post) : null) : bunksThere ? bunks : null;
      member.due = null;
      if (to && to.id !== member.room && !sim.state.rooms[to.id].jettisoned) send(sim, member, to.id);
    }
    if (!roster.watches) continue;
    // Off watch and idle away from the quarters for a while: back below (D-244).
    if (roster.watches > 1 && bunksThere && !onWatch(sim, member) && !member.due && !sim.state.boarding && member.room !== bunks.id && free(member) && !waitsIn(sim, member.room)) {
      member.offIdle = (member.offIdle ?? 0) + seconds;
      if (member.offIdle >= BACK_BELOW) {
        member.offIdle = 0;
        send(sim, member, bunks.id);
      }
    } else member.offIdle = 0;
    const below = Boolean(bunksThere) && member.room === bunks.id && free(member);
    const hunger = member.hunger ?? 0;
    // In the mess they eat first (F.7): off watch until fed, on watch only once hungry, and the meal goes on until it is done.
    const eating = below && hunger > HUNGER.sated && (member.eating || hunger >= (onWatch(sim, member) ? HUNGER.onWatch : HUNGER.meal));
    if (eating && !member.eating) sim.events.emit('crew.eating', { crew: member.id, hunger, tick });
    member.eating = eating;
    member.asleep = below && !eating && !onWatch(sim, member);
    const busy = member.task === 'idle' || member.task === 'walking' ? 1 : WATCH.work;
    if (member.asleep) member.fatigue = Math.max(0, member.fatigue - WATCH.rest * seconds);
    else member.fatigue = Math.min(1, member.fatigue + WATCH.tire * busy * seconds);
    if (eating) member.hunger = Math.max(0, hunger - HUNGER.eat * seconds);
    else member.hunger = Math.min(1, hunger + (member.asleep ? HUNGER.asleep : HUNGER.awake * busy) * seconds);
    if (member.hunger >= HUNGER.starving && !member.starving) {
      member.starving = true;
      sim.events.emit('crew.starving', { crew: member.id, room: member.room, tick });
    } else if (member.hunger < HUNGER.from) member.starving = false;
  }
}

/** Is something in this room waiting for an answer (a situation aboard, H.7)? */
const waitsIn = (sim, roomId) => Boolean(sim.state.run?.events?.aboard?.some((one) => !one.result && one.room === roomId));

/** Watch bill problems that should never happen. */
export function checkWatchInvariants(sim) {
  const problems = [];
  const { roster } = sim.state;
  if (![0, 1, 2, 3].includes(roster?.watches)) return [`the watch bill has ${roster?.watches} watches`];
  const count = Math.max(1, roster.watches);
  if (!(Number.isInteger(roster.on) && roster.on >= 0 && roster.on < count)) problems.push(`watch ${roster.on} of ${count} has the deck`);
  if (!(Number.isInteger(roster.t) && roster.t >= 0 && roster.t < WATCH.seconds * TICKS)) problems.push(`the watch is ${roster.t} ticks old`);
  for (const member of mine(sim)) {
    if (!(member.fatigue >= 0 && member.fatigue <= 1)) problems.push(`crew ${member.id} fatigue is ${member.fatigue}`);
    if (!((member.hunger ?? 0) >= 0 && (member.hunger ?? 0) <= 1)) problems.push(`crew ${member.id} hunger is ${member.hunger}`);
    if (member.asleep && member.eating) problems.push(`crew ${member.id} is asleep and eating`);
    if (!(Number.isInteger(member.watch) && member.watch >= 0 && member.watch < count)) problems.push(`crew ${member.id} is in watch ${member.watch} of ${count}`);
    if (member.asleep && member.alive && member.path.length) problems.push(`crew ${member.id} is asleep and walking`);
  }
  return problems;
}
