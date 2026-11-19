// The people-first screen (H.9, D-251): what the crew column and Margo's channel say, worked out from the sim
// without touching the DOM, so the words can be tested on their own. shipview.js lays them out.
//
//   crewCardView(sim, id)   one crew card: name, role, post, watch, what they are doing, their mood, health
//   heldStations(sim)       the stations Margo is running for want of a hand, for the head of her channel
//   roomStation(sim, room)  the station in a room, if it has one: its room card carries the station's switches

import { describeTask } from '../sim/crew.js';
import { findCrew } from '../sim/combat.js';
import { describeJob } from '../sim/hold.js';
import { nerveWord, regardOf, regardWord } from '../sim/memory.js';
import { STATIONS, STATION_IDS, holderOf, margoLoad, roomOfStation, stationOfRoom } from '../sim/stations.js';
import { SYSTEMS } from '../sim/systems.js';
import { roleOf } from '../sim/roles.js';
import { hungryWord, onWatch, tiredWord, watchName } from '../sim/watches.js';

/** Short task names for a crew card, where there is no room for a sentence. */
export const CARD_TASKS = Object.freeze({ walking: 'Walking', crawling: 'Crawling', waiting: 'At a door', extinguish: 'Fighting fire', patch: 'Patching hull', repair: 'Repairing', unjam: 'Freeing door', idle: 'Standing by', fighting: 'Fighting', sabotage: 'Wrecking', lifting: 'Lifting', opening: 'Opening', loading: 'Loading gun', cycling: 'At the airlock', stashing: 'Stashing', hiding: 'Hiding' });

/** A station's three-letter code, the way the old switch panel lamps were labelled. */
export const stationCode = (id) => (STATIONS[id]?.system ? SYSTEMS[STATIONS[id].system].code : 'HLM');

/**
 * One crew card. `taken` when a bounty party carried them off (H.2), `away` when they are aboard another ship.
 * `doing` is a few words; `mood` puts the worst of how they feel first, so the card says what matters.
 */
export function crewCardView(sim, id) {
  const found = findCrew(sim, id);
  if (!found) return { id, taken: true, alive: false, name: sim.state.crew[id]?.name ?? id, doing: 'Taken', mood: '', post: '', watch: '', health: 0, flags: {} };
  const { member, ship } = found;
  const role = roleOf(member);
  const away = ship !== sim && member.alive;
  const base = { id, taken: false, alive: member.alive, away, name: member.name, index: member.index, role: role?.name ?? 'Crew', health: member.alive ? member.health : 0 };
  if (!member.alive) return { ...base, doing: 'Dead', mood: '', post: '', watch: '', flags: { dead: true } };
  const onPost = member.task === 'idle' && member.post && stationOfRoom(sim, member.room) === member.post;
  const doing = away
    ? `Aboard: ${CARD_TASKS[member.task] ?? 'Standing by'}`
    : member.asleep
      ? 'Asleep'
      : member.slip > 0
        ? 'Fumbled it'
        : member.eating
          ? 'Eating'
          : onPost
            ? `On ${STATIONS[member.post].name.toLowerCase()}`
            : (CARD_TASKS[member.task] ?? 'Standing by');
  // The long version, for a title or a screen reader.
  const detail = (ship === sim && describeJob(sim, member)) || describeTask(ship, member);
  const { roster } = sim.state;
  const watch = roster.watches > 1 ? `${watchName(member.watch)}${onWatch(sim, member) ? '' : ' · below'}` : roster.watches === 1 ? 'All hands' : '';
  // The corner of a card has room for a few letters: which watch, and whether it is the one on deck.
  const watchTag = roster.watches > 1 ? ['1st', '2nd', '3rd'][member.watch] ?? `${member.watch + 1}th` : '';
  const hungry = hungryWord(member);
  const tired = tiredWord(member);
  const nerve = nerveWord(member);
  const regard = ship === sim ? regardWord(regardOf(member)) : 'even';
  // Worst first: what would make them fumble or say no.
  const words = [];
  if (member.health < 0.35) words.push('badly hurt');
  if (nerve !== 'steady') words.push(nerve);
  if (regard === 'sour' || regard === 'cool') words.push(regard === 'sour' ? 'sour on you' : 'cool on you');
  if (hungry) words.push(hungry.toLowerCase());
  if (tired === 'Exhausted' || tired === 'Tired') words.push(tired.toLowerCase());
  if (regard === 'warm' || regard === 'loyal') words.push(regard);
  const mood = words.length ? words.slice(0, 2).join(', ') : 'steady';
  const alarm = member.health < 0.35 || nerve === 'shaking' || regard === 'sour' || hungry === 'Starving' || tired === 'Exhausted';
  return {
    ...base,
    doing,
    detail,
    post: member.post ? STATIONS[member.post].name : 'No post',
    watch,
    watchTag,
    below: roster.watches > 1 && !onWatch(sim, member),
    mood,
    alarm,
    flags: { asleep: Boolean(member.asleep), tired: member.fatigue > 0.6, hungry: Boolean(hungry), slipping: member.slip > 0, hurt: member.health < 0.35, hidden: Boolean(member.hidden), suit: Boolean(member.suit) },
  };
}

/** The stations Margo is running for want of a hand, in the order she cares about them, and how stretched she is. */
export function heldStations(sim) {
  const held = STATION_IDS.filter((id) => id !== 'ai_core' && roomOfStation(sim, id) && holderOf(sim, id) === 'margo').map((id) => ({ id, code: stationCode(id), name: STATIONS[id].name, room: roomOfStation(sim, id).id }));
  const load = margoLoad(sim);
  return { held, attention: Math.floor(load.attention), stretched: load.held > load.attention };
}

/** The station whose switches a room's card carries, or null: the system in the room, or the helm. */
export function roomStation(sim, roomId) {
  const id = stationOfRoom(sim, roomId);
  return id && roomOfStation(sim, id)?.id === roomId ? id : null;
}
