// The intercom (S2.9, D-094): every order to one of our crew gets a short
// spoken reply in their own voice. Replies come from the crew's content file;
// nothing in the sim waits on them. Which line is said is fixed by how many
// times that crew member has answered that kind of order, so a replay hears
// the same words.

import { REPLY_KINDS } from '../engine/content-schema.js';

/** What a `crew.ordered` event is asking for, as a reply kind. */
export function replyKind(event) {
  if (!event.job) return 'move';
  return event.job === 'move' ? 'carry' : event.job;
}

/** A plain fallback for crew with no lines of their own. */
const FALLBACK = Object.freeze({ move: ['Going to {room}.'], open: ['Opening it.'], carry: ['Carrying it to {room}.'], jettison: ['Spacing it.'], load: ['Fetching rounds.'] });

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
      const lines = replies[event.crew]?.[kind] ?? FALLBACK[kind];
      const key = `${event.crew}:${kind}`;
      const n = said.get(key) ?? 0;
      said.set(key, n + 1);
      const text = lines[n % lines.length].replaceAll('{room}', roomName);
      return { crew: event.crew, kind, text };
    },
  };
}
