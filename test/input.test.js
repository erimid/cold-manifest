import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LONG_PRESS_MS, TAP_SLOP, createGestureTracker } from '../src/engine/gesture.js';
import { HIT_PADDING, distanceToTarget, pickTarget } from '../src/engine/hit.js';
import { KEYMAP } from '../src/engine/keymap.js';

const types = (events) => events.map((e) => e.type);
const down = (tracker, extra = {}) => tracker.down({ pointerId: 1, pointerType: 'touch', x: 100, y: 100, t: 0, ...extra });

test('a quick press and release is a tap at the press point', () => {
  const tracker = createGestureTracker();
  down(tracker);
  assert.deepEqual(tracker.move({ pointerId: 1, x: 104, y: 103 }), []);
  const events = tracker.up({ pointerId: 1, x: 104, y: 103, t: 120 });
  assert.deepEqual(types(events), ['tap']);
  assert.deepEqual([events[0].x, events[0].y, events[0].pointerType], [100, 100, 'touch']);
  assert.equal(tracker.active, false);
});

test('moving past the threshold is a drag, never a tap', () => {
  const tracker = createGestureTracker();
  down(tracker);
  assert.deepEqual(types(tracker.move({ pointerId: 1, x: 100 + TAP_SLOP.touch + 1, y: 100 })), ['dragstart', 'drag']);
  assert.deepEqual(types(tracker.move({ pointerId: 1, x: 160, y: 130 })), ['drag']);
  const events = tracker.up({ pointerId: 1, x: 170, y: 140, t: 300 });
  assert.deepEqual(types(events), ['dragend']);
  assert.deepEqual([events[0].startX, events[0].startY, events[0].dx, events[0].dy, events[0].cancelled], [100, 100, 70, 40, false]);
});

test('the tap threshold is tighter for a mouse than for a finger', () => {
  const distance = TAP_SLOP.mouse + 2;
  assert.ok(distance < TAP_SLOP.touch);
  const mouse = createGestureTracker();
  down(mouse, { pointerType: 'mouse' });
  assert.deepEqual(types(mouse.move({ pointerId: 1, x: 100 + distance, y: 100 })), ['dragstart', 'drag']);
  const finger = createGestureTracker();
  down(finger);
  assert.deepEqual(finger.move({ pointerId: 1, x: 100 + distance, y: 100 }), []);
});

test('holding still becomes a long-press, and the release is then not a tap', () => {
  const tracker = createGestureTracker();
  down(tracker);
  assert.equal(tracker.longPressDue, LONG_PRESS_MS);
  assert.deepEqual(tracker.poll(LONG_PRESS_MS - 1), []);
  assert.deepEqual(types(tracker.poll(LONG_PRESS_MS)), ['longpress']);
  assert.deepEqual(tracker.poll(LONG_PRESS_MS + 100), [], 'fires once');
  assert.equal(tracker.longPressDue, null);
  assert.deepEqual(tracker.move({ pointerId: 1, x: 200, y: 200 }), [], 'no drag after a long-press');
  assert.deepEqual(tracker.up({ pointerId: 1, x: 200, y: 200, t: 900 }), []);
});

test('a long hold whose timer never fired still counts as a long-press on release', () => {
  const tracker = createGestureTracker();
  down(tracker);
  assert.deepEqual(types(tracker.up({ pointerId: 1, x: 100, y: 100, t: LONG_PRESS_MS + 50 })), ['longpress']);
});

test('dragging cancels the long-press', () => {
  const tracker = createGestureTracker();
  down(tracker);
  tracker.move({ pointerId: 1, x: 200, y: 100 });
  assert.equal(tracker.longPressDue, null);
  assert.deepEqual(tracker.poll(5000), []);
});

test('a second finger is ignored until the first lifts', () => {
  const tracker = createGestureTracker();
  assert.equal(down(tracker), true);
  assert.equal(tracker.down({ pointerId: 2, pointerType: 'touch', x: 300, y: 300, t: 10 }), false);
  assert.deepEqual(tracker.move({ pointerId: 2, x: 400, y: 400 }), []);
  assert.deepEqual(tracker.up({ pointerId: 2, x: 400, y: 400, t: 50 }), []);
  assert.deepEqual(types(tracker.up({ pointerId: 1, x: 100, y: 100, t: 60 })), ['tap']);
  assert.equal(tracker.down({ pointerId: 2, pointerType: 'touch', x: 300, y: 300, t: 70 }), true);
});

test('a cancelled press is never a tap; a cancelled drag ends as cancelled', () => {
  const tracker = createGestureTracker();
  down(tracker);
  assert.deepEqual(tracker.cancel(1), []);
  assert.equal(tracker.active, false);
  down(tracker);
  tracker.move({ pointerId: 1, x: 200, y: 100 });
  const events = tracker.cancel(1);
  assert.deepEqual(types(events), ['dragend']);
  assert.equal(events[0].cancelled, true);
});

const room = { id: 'room', x: 100, y: 100, w: 200, h: 100 };
const door = { id: 'door', x: 290, y: 130, w: 20, h: 40, priority: 2 };
const crew = { id: 'crew', cx: 150, cy: 150, r: 12, priority: 3 };

test('distance to a target is zero inside and measured to the edge outside', () => {
  assert.equal(distanceToTarget(room, 150, 150), 0);
  assert.equal(distanceToTarget(room, 90, 150), 10);
  assert.equal(distanceToTarget(room, 97, 96), 5);
  assert.equal(distanceToTarget(crew, 150, 150), 0);
  assert.equal(distanceToTarget(crew, 150, 172), 10);
});

test('touch reaches past the drawn edge; a mouse barely does', () => {
  assert.ok(HIT_PADDING.touch > HIT_PADDING.pen && HIT_PADDING.pen > HIT_PADDING.mouse);
  assert.equal(pickTarget([room], 90, 150, 'touch')?.id, 'room');
  assert.equal(pickTarget([room], 90, 150, 'mouse'), null);
  assert.equal(pickTarget([room], 99, 150, 'mouse')?.id, 'room');
  assert.equal(pickTarget([room], 80, 150, 'touch'), null);
});

test('higher priority wins where targets overlap', () => {
  assert.equal(pickTarget([room, door, crew], 150, 150, 'touch').id, 'crew');
  assert.equal(pickTarget([room, door, crew], 295, 150, 'mouse').id, 'door');
  assert.equal(pickTarget([crew, door, room], 200, 120, 'mouse').id, 'room');
});

test('a near miss on a more important target beats the room it stands in', () => {
  // 6px outside the crew circle, squarely inside the room: a finger means the crew member.
  assert.equal(pickTarget([room, crew], 150, 168, 'touch').id, 'crew');
  // A mouse is precise, so the same spot is the room.
  assert.equal(pickTarget([room, crew], 150, 168, 'mouse').id, 'room');
  // Just beside a door, inside the room: the door.
  assert.equal(pickTarget([room, door], 280, 150, 'touch').id, 'door');
  assert.equal(pickTarget([room, door], 270, 150, 'touch').id, 'room');
});

test('between targets of the same priority, inside beats a near miss and closer beats farther', () => {
  const a = { id: 'a', x: 0, y: 0, w: 50, h: 50 };
  const b = { id: 'b', x: 62, y: 0, w: 50, h: 50 };
  assert.equal(pickTarget([a, b], 48, 25, 'touch').id, 'a', 'inside a, 14px from b');
  assert.equal(pickTarget([a, b], 54, 25, 'touch').id, 'a');
  assert.equal(pickTarget([a, b], 58, 25, 'touch').id, 'b');
});

test('among same-priority targets the pointer is inside, the smaller one wins', () => {
  const big = { id: 'big', x: 0, y: 0, w: 300, h: 300 };
  const small = { id: 'small', x: 100, y: 100, w: 40, h: 40 };
  assert.equal(pickTarget([big, small], 120, 120).id, 'small');
  assert.equal(pickTarget([small, big], 120, 120).id, 'small');
  assert.equal(pickTarget([], 1, 1), null);
});

test('keymap covers pause, back and crew selection', () => {
  assert.equal(KEYMAP.Space, 'pause');
  assert.equal(KEYMAP.Escape, 'back');
  for (let n = 1; n <= 8; n++) assert.equal(KEYMAP[`Digit${n}`], `select-${n}`);
});
