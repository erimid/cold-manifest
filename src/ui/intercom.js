// The intercom (S2.9, D-094): every order to one of our crew gets a short
// spoken reply in their own voice, and from S2.10 that includes "no", and
// what they say when they put a lamp back on. Replies come from the crew's content file;
// nothing in the sim waits on them. Which line is said is fixed by how many
// times that crew member has answered that kind of order, so a replay hears
// the same words.
//
// How they answer an order to go somewhere depends on what they think of the
// captain (F.6): shortly when they have soured, gladly when they have warmed,
// and they may say what they remember that made it so ({memory}).

import { REPLY_KINDS } from '../engine/content-schema.js';

/** What a `crew.ordered` event is asking for, as a reply kind. */
export function replyKind(event) {
  if (event.rule) return 'refuse'; // a `crew.refused` event (S2.10)
  if (event.lamp) return 'lamp'; // a `crew.lit` event, marked by the caller
  if (!event.job) return event.mood ?? 'move'; // a walk: 'sour' or 'warm' when the sim says how they take it (F.6)
  return event.job === 'move' ? 'carry' : event.job;
}

/** A plain fallback for crew with no lines of their own. */
const FALLBACK = Object.freeze({ move: ['Going to {room}.'], open: ['Opening it.'], carry: ['Carrying it to {room}.'], jettison: ['Spacing it.'], load: ['Fetching rounds.'], refuse: ['No. Not in there.'], lamp: ['I need the light.'], sour: ['{room}. If I must.'], warm: ['{room}. Gladly, Captain.'] });

/**
 * `replies` maps a crew id to their content `replies`. Returns `reply(event,
 * roomName)`, giving { crew, kind, text } for an order, or null if the event
 * is not one we answer.
 */
export function createIntercom(replies = {}) {
  const said = new Map(); // `${crew}:${kind}` -> how many times
  return {
    reply(event, roomName = 'there') {
      const kind = replyKind(event);
      if (!REPLY_KINDS.includes(kind) || !event.crew) return null;
      // A line that names a memory is only said while there is one to name.
      const all = replies[event.crew]?.[kind] ?? FALLBACK[kind];
      const sayable = event.remembers ? all : all.filter((line) => !line.includes('{memory}'));
      const lines = sayable.length ? sayable : FALLBACK[kind];
      const key = `${event.crew}:${kind}`;
      const n = said.get(key) ?? 0;
      said.set(key, n + 1);
      const text = lines[n % lines.length].replaceAll('{room}', roomName).replaceAll('{memory}', event.remembers ?? '');
      return { crew: event.crew, kind, text };
    },
  };
}
