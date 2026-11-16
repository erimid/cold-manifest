// The passive scope (Stage H, H.1; D-151): a small green screen let into the corner of Margo's monitor.
// We are the centre. Drones and boarding pods on their way in are drawn as small marks (H.3). A contact is not a dot: it is the
// patch of space it could be in, a wedge as wide as the bearing is unsure and as deep as the range is.
// Drawing and hit-testing only: what is on the scope comes from scopeView() in sim/encounters.js.

import { KM_PER_UNIT } from '../sim/encounters.js';

const FONT = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace";
const GREEN = '#7fe39a';
const AMBER = '#ffb347';
const RED = '#ff8a2b';
const RAD = Math.PI / 180;

/** A bearing as three digits, the way a helm calls it. */
export const bearingText = (deg) => String(Math.round(deg) % 360).padStart(3, '0');
/** A range in scope units as kilometres, rounded to what the return is good for. */
export const rangeText = (units, error = 0) => {
  const km = units * KM_PER_UNIT;
  const step = error > 0.2 ? 100 : error > 0.06 ? 50 : 10;
  return `${Math.max(step, Math.round(km / step) * step)} km`;
};

/** Where the dial sits in the scope's box: { cx, cy, r }, in CSS pixels. */
export function scopeDial(box) {
  const r = Math.max(40, Math.min((box.w - 28) / 2, (box.h - 96) / 2));
  return { cx: box.x + box.w / 2, cy: box.y + 30 + r, r };
}

/** A point on the dial: `bearing` degrees clockwise from the top, `range` in scope units. */
function at(dial, view, bearing, range) {
  const k = (Math.min(range, view.range * 1.02) / view.range) * dial.r;
  return { x: dial.cx + Math.sin(bearing * RAD) * k, y: dial.cy - Math.cos(bearing * RAD) * k };
}

/** Every contact's mark on the dial: [{ id, x, y }], for taps and tests. */
export function scopeMarks(box, view) {
  const dial = scopeDial(box);
  return view.contacts.map((contact) => ({ id: contact.id, ...at(dial, view, contact.bearing, contact.range) }));
}

/**
 * What a tap on the scope means: { contact: id } on a return (fingers get a wider reach than a mouse),
 * { heading: degrees } anywhere else on the dial, or null outside it.
 */
export function scopeHit(box, view, x, y, pointerType = 'mouse') {
  if (!box || x < box.x || x > box.x + box.w || y < box.y || y > box.y + box.h) return null;
  const dial = scopeDial(box);
  const reach = pointerType === 'touch' ? 26 : 16;
  let best = null;
  for (const mark of scopeMarks(box, view)) {
    const gap = Math.hypot(mark.x - x, mark.y - y);
    if (gap <= reach && (!best || gap < best.gap)) best = { id: mark.id, gap };
  }
  if (best) return { contact: best.id };
  const dx = x - dial.cx;
  const dy = y - dial.cy;
  if (Math.hypot(dx, dy) > dial.r + 10 || Math.hypot(dx, dy) < 8) return { none: true };
  return { heading: (Math.atan2(dx, -dy) / RAD + 360) % 360 };
}

function wedge(ctx, dial, view, contact) {
  const inner = (Math.max(0, contact.range * (1 - contact.rangeError)) / view.range) * dial.r;
  const outer = (Math.min(view.range, contact.range * (1 + contact.rangeError)) / view.range) * dial.r;
  // Canvas angles run clockwise from the x axis; bearings run clockwise from the top.
  const from = (contact.bearing - contact.bearingError - 90) * RAD;
  const to = (contact.bearing + contact.bearingError - 90) * RAD;
  ctx.beginPath();
  ctx.arc(dial.cx, dial.cy, Math.max(inner, 0.5), from, to);
  ctx.arc(dial.cx, dial.cy, Math.max(outer, inner + 3), to, from, true);
  ctx.closePath();
}

/**
 * Draw the scope. `view` is scopeView(sim); `selected` a contact id or null; `time` game seconds (for the
 * sweep, which stops with the clock); `active` whether the sensors have power; `reduce` stills the sweep.
 */
export function drawScope(ctx, box, view, { selected = null, time = 0, active = true, reduce = false, marks = [] } = {}) {
  const dial = scopeDial(box);
  const { cx, cy, r } = dial;
  ctx.save();
  ctx.fillStyle = '#04100a';
  ctx.strokeStyle = '#2f5a3c';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.roundRect(box.x, box.y, box.w, box.h, 8);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = GREEN;
  ctx.font = `700 11px ${FONT}`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.fillText(`SCOPE · ${active ? 'SENSORS UP' : 'PASSIVE'}`, box.x + 10, box.y + 8, box.w - 20);
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(127, 227, 154, 0.6)';
  ctx.fillText(`${view.range * KM_PER_UNIT} KM`, box.x + box.w - 10, box.y + 8);

  // The dial: range rings, the cross, and a sweep going round while the clock runs.
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = '#020a06';
  ctx.fill();
  ctx.clip();
  ctx.strokeStyle = 'rgba(127, 227, 154, 0.16)';
  ctx.lineWidth = 1;
  for (let ring = 1; ring <= 3; ring++) {
    ctx.beginPath();
    ctx.arc(cx, cy, (r * ring) / 3, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.moveTo(cx - r, cy);
  ctx.lineTo(cx + r, cy);
  ctx.moveTo(cx, cy - r);
  ctx.lineTo(cx, cy + r);
  ctx.stroke();
  if (!reduce) {
    const angle = (time * 1.1) % (Math.PI * 2);
    const sweep = ctx.createConicGradient(angle - Math.PI / 2, cx, cy);
    sweep.addColorStop(0, 'rgba(127, 227, 154, 0)');
    sweep.addColorStop(0.92, 'rgba(127, 227, 154, 0)');
    sweep.addColorStop(1, `rgba(127, 227, 154, ${active ? 0.22 : 0.1})`);
    ctx.fillStyle = sweep;
    ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
  }

  // Decoys: ours, so we know exactly where they are.
  for (const decoy of view.decoys) {
    if (decoy.range > view.range) continue;
    const p = at(dial, view, decoy.bearing, decoy.range);
    ctx.strokeStyle = decoy.kind === 'flare' ? AMBER : 'rgba(233, 220, 195, 0.8)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (decoy.kind === 'flare') {
      for (let i = 0; i < 4; i++) {
        const a = (i * Math.PI) / 4;
        ctx.moveTo(p.x - Math.cos(a) * 5, p.y - Math.sin(a) * 5);
        ctx.lineTo(p.x + Math.cos(a) * 5, p.y + Math.sin(a) * 5);
      }
    } else ctx.rect(p.x - 3.5, p.y - 3.5, 7, 7);
    ctx.stroke();
  }

  // Drones and pods coming in: a small diamond for a drone, a triangle for a pod; a drone on our hull rings the centre.
  for (const item of view.incoming ?? []) {
    const p = at(dial, view, item.bearing, item.range);
    ctx.strokeStyle = RED;
    ctx.fillStyle = RED;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    if (item.on) ctx.arc(p.x, p.y, 7, 0, Math.PI * 2);
    else if (item.kind === 'drone') {
      ctx.moveTo(p.x, p.y - 4);
      ctx.lineTo(p.x + 4, p.y);
      ctx.lineTo(p.x, p.y + 4);
      ctx.lineTo(p.x - 4, p.y);
      ctx.closePath();
    } else {
      ctx.moveTo(p.x, p.y - 4);
      ctx.lineTo(p.x + 4, p.y + 3);
      ctx.lineTo(p.x - 4, p.y + 3);
      ctx.closePath();
    }
    if (item.on) ctx.stroke();
    else ctx.fill();
  }

  // Contacts: the patch each could be in, then the best guess at where in it.
  for (const contact of view.contacts) {
    const hot = contact.state === 'closing' || contact.state === 'alongside';
    const colour = contact.stale ? 'rgba(127, 227, 154, 0.45)' : hot ? RED : GREEN;
    wedge(ctx, dial, view, contact);
    ctx.fillStyle = contact.stale ? 'rgba(127, 227, 154, 0.07)' : hot ? 'rgba(255, 138, 43, 0.2)' : 'rgba(127, 227, 154, 0.16)';
    ctx.fill();
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1;
    ctx.setLineDash(contact.stale ? [3, 3] : []);
    ctx.stroke();
    ctx.setLineDash([]);
    const p = at(dial, view, contact.bearing, contact.range);
    ctx.fillStyle = colour;
    ctx.beginPath();
    if (contact.known && !contact.stale) {
      // Made out: a solid diamond. Until then, a hollow ring.
      ctx.moveTo(p.x, p.y - 5);
      ctx.lineTo(p.x + 5, p.y);
      ctx.lineTo(p.x, p.y + 5);
      ctx.lineTo(p.x - 5, p.y);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    if (contact.id === selected) {
      ctx.strokeStyle = '#fff3d6';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(p.x - 9, p.y - 9, 18, 18);
    }
  }

  // Things that are not ships (H.7): a beacon, a dead hull alongside. A hollow square, where a ship is a diamond or a ring.
  for (const mark of marks) {
    const p = at(dial, view, mark.bearing, mark.range * view.range);
    ctx.strokeStyle = AMBER;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(p.x - 4, p.y - 4, 8, 8);
  }

  // Us: the hull, the way the bow points, and where we are actually going.
  const bow = view.heading * RAD;
  if (view.speed > 0.01) {
    const way = view.course * RAD;
    const len = 10 + view.speed * 26;
    ctx.strokeStyle = 'rgba(233, 220, 195, 0.65)';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 3]);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.sin(way) * len, cy - Math.cos(way) * len);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (Math.abs(((view.wanted - view.heading + 540) % 360) - 180) > 0.5) {
    const want = view.wanted * RAD;
    ctx.strokeStyle = 'rgba(255, 179, 71, 0.55)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.sin(want) * r, cy - Math.cos(want) * r);
    ctx.stroke();
  }
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(bow);
  ctx.fillStyle = view.burning ? AMBER : '#e9dcc3';
  ctx.beginPath();
  ctx.moveTo(0, -9);
  ctx.lineTo(5, 6);
  ctx.lineTo(0, 3);
  ctx.lineTo(-5, 6);
  ctx.closePath();
  ctx.fill();
  if (view.burning) {
    ctx.strokeStyle = RED;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(0, 6);
    ctx.lineTo(0, 13);
    ctx.stroke();
  }
  ctx.restore();
  ctx.restore();

  ctx.strokeStyle = '#2f5a3c';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  // Labels sit outside the clip so one at the rim is not cut off; words, never colour alone.
  ctx.font = `700 10px ${FONT}`;
  ctx.textBaseline = 'middle';
  for (const contact of view.contacts) {
    const p = at(dial, view, contact.bearing, contact.range);
    const left = p.x > cx + r * 0.45;
    ctx.textAlign = left ? 'right' : 'left';
    ctx.fillStyle = contact.stale ? 'rgba(127, 227, 154, 0.6)' : contact.state === 'closing' || contact.state === 'alongside' ? RED : GREEN;
    ctx.fillText(`${contact.label}${contact.stale ? '?' : ''}`, p.x + (left ? -9 : 9), p.y - 8);
  }

  for (const mark of marks) {
    const p = at(dial, view, mark.bearing, mark.range * view.range);
    const left = p.x > cx + r * 0.45;
    ctx.textAlign = left ? 'right' : 'left';
    ctx.fillStyle = AMBER;
    ctx.fillText(mark.label.toUpperCase(), p.x + (left ? -9 : 9), p.y + 9);
  }

  // The helm, in words, under the dial.
  const lines = [
    `HDG ${bearingText(view.heading)}${Math.abs(((view.wanted - view.heading + 540) % 360) - 180) > 0.5 ? ` > ${bearingText(view.wanted)}` : ''} · ${view.burning ? 'BURNING' : view.speed > 0.01 ? 'DRIFTING' : 'AT REST'}`,
    `${(view.speed * KM_PER_UNIT).toFixed(1)} KM/S${view.speed > 0.01 ? ` ON ${bearingText(view.course)}` : ''} · FLARES ${view.flares}`,
    view.contacts.length ? `${view.contacts.length} CONTACT${view.contacts.length === 1 ? '' : 'S'} · TAP ONE TO READ IT` : 'NO CONTACTS · TAP THE DIAL TO TURN',
  ];
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.font = `700 10px ${FONT}`;
  const top = cy + r + 8;
  lines.forEach((line, i) => {
    ctx.fillStyle = i === 0 && view.burning ? AMBER : i === 2 ? 'rgba(127, 227, 154, 0.6)' : GREEN;
    if (top + i * 14 + 12 <= box.y + box.h) ctx.fillText(line, box.x + 10, top + i * 14, box.w - 20);
  });
  ctx.restore();
}
