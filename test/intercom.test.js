import assert from 'node:assert/strict';
import { test } from 'node:test';
import { REPLY_KINDS, validateContent } from '../src/engine/content-schema.js';
import { createIntercom, replyKind } from '../src/ui/intercom.js';
import { readContentFiles } from '../tools/lib/load-content.js';

const crewFile = (items) => ({ path: 'crew/test.json', data: { items } });
const replies = Object.fromEntries(REPLY_KINDS.map((kind) => [kind, [`${kind} one {room}`, `${kind} two`]]));

test('an order is answered by kind: a walk, or one of the hold jobs', () => {
  assert.equal(replyKind({ crew: 'ilse', room: 'bridge' }), 'move');
  assert.equal(replyKind({ crew: 'ilse', job: 'move' }), 'carry');
  for (const job of ['open', 'jettison', 'load']) assert.equal(replyKind({ crew: 'ilse', job }), job);
});

test('replies take turns, fill in the room, and are the same on a replay', () => {
  const hear = () => {
    const intercom = createIntercom({ ilse: replies });
    return [intercom.reply({ crew: 'ilse', room: 'bridge' }, 'Bridge'), intercom.reply({ crew: 'ilse', room: 'hold' }, 'Main hold'), intercom.reply({ crew: 'ilse', room: 'x' }, 'X')].map((r) => r.text);
  };
  assert.deepEqual(hear(), ['move one Bridge', 'move two', 'move one X']);
  assert.deepEqual(hear(), hear());
  // Someone with no lines of their own still answers.
  assert.equal(createIntercom({}).reply({ crew: 'nobody', job: 'load' }).text, 'Fetching rounds.');
});

test('every crew member in content has a reply for every kind of order', () => {
  const crew = readContentFiles().filter((f) => f.path.startsWith('crew/')).flatMap((f) => f.data.items);
  assert.ok(crew.length >= 3);
  for (const member of crew) for (const kind of REPLY_KINDS) assert.ok(member.replies?.[kind]?.length, `${member.id} has no "${kind}" replies`);
});

test('the content check catches a bad reply list', () => {
  const ok = validateContent([crewFile([{ id: 'a', name: 'A', replies }])]);
  assert.deepEqual(ok.errors, []);
  const bad = validateContent([crewFile([{ id: 'b', name: 'B', replies: { ...replies, move: ['Going to {port}.'], sing: ['La.'], load: [] } }])]);
  assert.ok(bad.errors.some((e) => /unknown slot "\{port\}"/.test(e)), bad.errors.join('\n'));
  assert.ok(bad.errors.some((e) => /unknown kind "sing"/.test(e)));
  assert.ok(bad.errors.some((e) => /"load" lines/.test(e)));
});
