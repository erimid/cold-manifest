// The passive scope (Stage H, H.1; D-151): a small green screen let into the corner of Margo's monitor.
// We are the centre. Drones and boarding pods on their way in are drawn as small marks (H.3). A contact is not a dot: it is the
// patch of space it could be in, a wedge as wide as the bearing is unsure and as deep as the range is.
// Since F.1 (D-215) each contact's search beam is drawn too, with a ring round its mark for how sure of us it is.
// Drawing and hit-testing only: what is on the scope comes from scopeView() in sim/encounters.js.

import { KM_PER_UNIT } from '../sim/encounters.js';

const FONT = "ui-monospace, 'SF Mono', Menlo, Consolas, monospace";
const GREEN = '#7fe39a';
const AMBER = '#ffb347';
const RED = '#ff8a2b';
const RAD = Math.PI / 180;

const LIME = '#cfe07a';
const DIM = 'rgba(127, 227, 154, 0.45)';
/**
 * How each stage of a contact's awareness of us is marked on the scope (F.1, D-215): the colour of its mark and
 * its search beam, the sign after its label, and the words under the dial. Never colour alone. The keys are
 * STAGES_OF_AWARENESS in sim/encounters.js; the sounds are STAGE_SOUNDS in audio/patches.js.
 */
export const STAGE_MARKS = Object.freeze({
  passing: Object.freeze({ colour: GREEN, sign: '', words: 'SWEEPING' }),
  brushed: Object.freeze({ colour: LIME, sign: '~', words: 'BRUSHED US' }),
  sniff: Object.freeze({ colour: AMBER, sign: '?', words: 'HAS A SNIFF' }),
  sure: Object.freeze({ colour: RED, sign: '!', words: 'IS SURE' }),
  searching: Object.freeze({ colour: AMBER, sign: '..', words: 'LOST US, SEARCHING' }),
  gone: Object.freeze({ colour: DIM, sign: '', words: 'LEAVING' }),
});
const markOf = (contact) => (contact.stale || !contact.stage ? null : STAGE_MARKS[contact.stage]);
/** A colour with its alpha set: rgb(a) or #rrggbb in, rgba out. */
function fade(colour, alpha) {
  if (colour.startsWith('#')) return `rgba(${parseInt(colour.slice(1, 3), 16)}, ${parseInt(colour.slice(3, 5), 16)}, ${parseInt(colour.slice(5, 7), 16)}, ${alpha})`;
  return colour.replace(/[\d.]+\)$/, `${alpha})`);
}

/** The contact the words under the dial are about: the one closest to finding us (the surest), or null. */
export function hunter(view) {
  let best = null;
  for (const contact of view.contacts) if (markOf(contact) && contact.stage !== 'gone' && (!best || contact.certainty > best.certainty)) best = contact;
  return best;
}
/** The words under the dial for it: "C1 HAS A SNIFF · 46%". */
export const hunterText = (contact) => `${contact.label} ${STAGE_MARKS[contact.stage].words} · ${Math.round(contact.certainty * 100)}%`;

/**
 * A contact's search beam (F.1): a fan from its mark, pointing where the beam points. It is drawn against the line
 * from the mark to us, so a beam that is on us is drawn across us however far out the mark is. A beam combing a
 * patch has the edges of the patch drawn; one that is sure is a line held on what it is chasing.
 */
function drawSweep(ctx, dial, p, contact, mark) {
  const { sweep } = contact;
  const gap = Math.hypot(dial.cx - p.x, dial.cy - p.y);
  if (gap < 4) return;
  const toUs = Math.atan2(dial.cy - p.y, dial.cx - p.x); // canvas angle from the mark to us
  const reach = Math.max(34, gap * 1.2);
  const line = (angle, alpha, dash = []) => {
    ctx.strokeStyle = fade(mark.colour, alpha);
    ctx.lineWidth = 1;
    ctx.setLineDash(dash);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + Math.cos(angle) * reach, p.y + Math.sin(angle) * reach);
    ctx.stroke();
    ctx.setLineDash([]);
  };
  if (sweep.mode === 'locked') {
    line(toUs + sweep.off * RAD, 0.85);
    return;
  }
  if (sweep.mode === 'narrow') {
    line(toUs + (sweep.centre - sweep.arc) * RAD, 0.3, [2, 4]);
    line(toUs + (sweep.centre + sweep.arc) * RAD, 0.3, [2, 4]);
  }
  const at = toUs + sweep.off * RAD;
  const glow = ctx.createRadialGradient(p.x, p.y, 2, p.x, p.y, reach);
  glow.addColorStop(0, fade(mark.colour, 0.5));
  glow.addColorStop(1, fade(mark.colour, 0.06));
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.moveTo(p.x, p.y);
  ctx.arc(p.x, p.y, reach, at - sweep.beam * RAD, at + sweep.beam * RAD);
  ctx.closePath();
  ctx.fill();
  line(at, 0.7);
}

/** How sure it is, as a ring round its mark filling clockwise from the top, with a notch where a sniff starts and where it is sure. */
function drawCertainty(ctx, p, contact, mark, view) {
  const r = 10;
  ctx.lineWidth = 1;
  ctx.strokeStyle = fade(mark.colour, 0.25);
  ctx.beginPath();
  ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
  ctx.stroke();
  if (contact.certainty > 0) {
    ctx.lineWidth = 3;
    ctx.strokeStyle = mark.colour;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, contact.certainty));
    ctx.stroke();
  }
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#e9dcc3';
  for (const share of [view.notice, view.sure]) {
    if (!(share > 0)) continue;
    const a = -Math.PI / 2 + Math.PI * 2 * share;
    ctx.beginPath();
    ctx.moveTo(p.x + Math.cos(a) * (r - 3), p.y + Math.sin(a) * (r - 3));
    ctx.lineTo(p.x + Math.cos(a) * (r + 3), p.y + Math.sin(a) * (r + 3));
    ctx.stroke();
  }
}

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
 * Draw the scope. `view` is scopeView(sim); `selected` a contact id or null; `active` whether the sensors have
 * power; `reduce` stills the rings a look and a ping throw off.
 */
export function drawScope(ctx, box, view, { selected = null, active = true, reduce = false, marks = [] } = {}) {
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

  // The dial: range rings and the cross.
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
  // No sweep of our own goes round (F.1): the scope only listens, and the beams on it are other ships looking for us.

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

  // Search beams (F.1), under everything else: where each contact is looking, and a ring off us when one crosses us
  // (bright if it read something), and off it when it pings.
  for (const contact of view.contacts) {
    const mark = markOf(contact);
    if (!mark || !contact.sweep) continue;
    const p = at(dial, view, contact.bearing, contact.range);
    drawSweep(ctx, dial, p, contact, mark);
    const { sinceLook, sincePing, found } = contact.sweep;
    if (sinceLook !== null && sinceLook < 0.6 && contact.sweep.mode !== 'locked') {
      ctx.strokeStyle = fade(found ? mark.colour : GREEN, (found ? 0.9 : 0.4) * (1 - sinceLook / 0.6));
      ctx.lineWidth = found ? 2.5 : 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy, reduce ? 16 : 12 + sinceLook * 26, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (sincePing !== null && sincePing < 1.6) {
      for (const lag of [0, 0.35]) {
        const t = sincePing - lag;
        if (t < 0) continue;
        ctx.strokeStyle = fade(AMBER, 0.8 * (1 - t / 1.6));
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(p.x, p.y, reduce ? 18 : 6 + (t / 1.6) * r * 1.3, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }

  // Contacts: the patch each could be in, then the best guess at where in it.
  for (const contact of view.contacts) {
    const mark = markOf(contact);
    const hot = contact.stage === 'sure';
    const colour = mark ? mark.colour : DIM;
    wedge(ctx, dial, view, contact);
    ctx.fillStyle = contact.stale ? 'rgba(127, 227, 154, 0.07)' : fade(colour, hot ? 0.2 : 0.14);
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
    if (mark && contact.stage !== 'gone') drawCertainty(ctx, p, contact, mark, view);
    if (contact.id === selected) {
      ctx.strokeStyle = '#fff3d6';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(p.x - 14, p.y - 14, 28, 28);
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
    const mark = markOf(contact);
    ctx.fillStyle = mark ? mark.colour : 'rgba(127, 227, 154, 0.6)';
    ctx.fillText(mark ? `${contact.label}${mark.sign}` : `${contact.label}?`, p.x + (left ? -14 : 14), p.y - 12);
  }

  for (const mark of marks) {
    const p = at(dial, view, mark.bearing, mark.range * view.range);
    const left = p.x > cx + r * 0.45;
    ctx.textAlign = left ? 'right' : 'left';
    ctx.fillStyle = AMBER;
    ctx.fillText(mark.label.toUpperCase(), p.x + (left ? -9 : 9), p.y + 9);
  }

  // The helm, in words, under the dial; and the ship closest to finding us, with how sure it is (F.1).
  const hunting = hunter(view);
  const lines = [
    `HDG ${bearingText(view.heading)}${Math.abs(((view.wanted - view.heading + 540) % 360) - 180) > 0.5 ? ` > ${bearingText(view.wanted)}` : ''} · ${view.burning ? 'BURNING' : view.speed > 0.01 ? 'DRIFTING' : 'AT REST'}`,
    `${(view.speed * KM_PER_UNIT).toFixed(1)} KM/S${view.speed > 0.01 ? ` ON ${bearingText(view.course)}` : ''} · FLARES ${view.flares}`,
    hunting ? hunterText(hunting) : view.contacts.length ? `${view.contacts.length} CONTACT${view.contacts.length === 1 ? '' : 'S'} · TAP ONE TO READ IT` : 'NO CONTACTS · TAP THE DIAL TO TURN',
  ];
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  ctx.font = `700 10px ${FONT}`;
  const top = cy + r + 8;
  lines.forEach((line, i) => {
    ctx.fillStyle = i === 0 && view.burning ? AMBER : i === 2 ? (hunting ? STAGE_MARKS[hunting.stage].colour : 'rgba(127, 227, 154, 0.6)') : GREEN;
    if (top + i * 14 + 12 <= box.y + box.h) ctx.fillText(line, box.x + 10, top + i * 14, box.w - 20);
  });
  ctx.restore();
}
