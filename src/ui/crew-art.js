// Crew bodies on the side-on decks (Eric, 2026-11-16, D-132; pulled forward
// from S11.1's animated silhouettes). Drawn in code like everything else
// (brief §3): a figure in a company jumpsuit in their roster colour, with the
// kit of their role on top so a role reads by shape, not colour alone
// (brief §17):
//
//   pilot          headset with a boom mic
//   engineer       hard hat, tool belt, a wrench in hand
//   gunner         ear defenders and an ammo belt across the chest
//   medic          white cap and a white cross on the chest
//   security       dark visor helmet and a vest
//   quartermaster  flat cap and a clipboard
//
// Poses: standing, walking (legs swing), working (arms forward), fighting
// (fists up), crawling (on their front), carrying (arms up, the crate is drawn
// by the renderer above them), and dead (on their back on the floor). A suit
// covers everything but the roster stripe and the role's headgear outline.
// DOM-free apart from the 2D context it is handed.

/** Bodies are drawn this much bigger than their sketch in tiles, so they read on an iPad. */
const SIZE = 1.2;
/** Body proportions in tiles, as drawn. The feet are on the floor; height is head top to feet. */
export const BODY = Object.freeze({ height: 1.45 * SIZE, width: 0.62 * SIZE });

const SKIN = ['#e7c3a1', '#c58c62', '#8d5a3b', '#f1d4bc', '#a8704a', '#5e3b26'];
const INK = '#05070b';

/** A skin tone for a crew member, steady across a run. */
export const skinOf = (index) => SKIN[(index * 7 + 3) % SKIN.length];

/**
 * Draw one body. All lengths in CSS pixels; `s` is pixels per tile.
 *   x, feet   where they stand: the middle of their feet on the floor
 *   colour    jumpsuit colour; skin, role, facing (1 right, -1 left)
 *   pose      'stand' | 'walk' | 'work' | 'fight' | 'carry' | 'crawl' | 'dead'
 *   phase     0 to 1 through a walking stride
 *   suit      in an environment suit; hostile: one of theirs; label: text on the chest
 */
export function drawBody(ctx, { x, feet, s, colour, skin, role, facing = 1, pose = 'stand', phase = 0, suit = false, hostile = false, label = '', dim = false }) {
  ctx.save();
  ctx.translate(x, feet);
  if (pose === 'dead') {
    // On their back on the deck, head toward where they faced.
    ctx.rotate((facing >= 0 ? -1 : 1) * Math.PI / 2);
    ctx.translate(0, -0.18 * s);
  } else if (pose === 'crawl') {
    ctx.translate(0, -0.25 * s);
    ctx.rotate((facing >= 0 ? 1 : -1) * Math.PI / 2);
    ctx.translate(0, 0.62 * s);
  }
  ctx.scale(facing >= 0 ? 1 : -1, 1);
  const u = s * SIZE; // one tile of the sketch
  const lw = Math.max(1, 0.05 * u);
  const suitColour = hostile ? '#7a2a24' : '#d9dee6';
  const body = dim ? '#3a404b' : suit ? suitColour : colour;
  const limb = dim ? '#2c313a' : shade(body, -0.25);
  const face = dim ? '#4a505b' : skin;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.strokeStyle = INK;

  // Legs.
  const swing = pose === 'walk' ? Math.sin(phase * Math.PI * 2) * 0.2 : pose === 'fight' ? 0.12 : 0;
  const hip = -0.62 * u;
  const legW = 0.15 * u;
  for (const [side, angle] of [[-1, swing], [1, -swing]]) {
    ctx.save();
    ctx.translate(side * 0.08 * u, hip);
    ctx.rotate(angle);
    ctx.fillStyle = limb;
    roundRect(ctx, -legW / 2, 0, legW, 0.6 * u, legW * 0.4);
    ctx.fill();
    ctx.lineWidth = lw;
    ctx.stroke();
    ctx.fillStyle = dim ? '#22262d' : '#1a1d22'; // boots
    roundRect(ctx, -legW / 2 - 0.01 * u, 0.5 * u, legW + 0.08 * u, 0.12 * u, 0.04 * u);
    ctx.fill();
    ctx.restore();
  }

  // Torso: a jumpsuit with a belt line and a chest patch.
  const shoulders = role === 'security' && !suit ? 0.6 : suit ? 0.6 : 0.5;
  const top = -1.12 * u;
  const tw = shoulders * u;
  ctx.fillStyle = body;
  ctx.beginPath();
  ctx.moveTo(-tw / 2, top + 0.06 * u);
  ctx.quadraticCurveTo(-tw / 2, top, -tw / 2 + 0.08 * u, top);
  ctx.lineTo(tw / 2 - 0.08 * u, top);
  ctx.quadraticCurveTo(tw / 2, top, tw / 2, top + 0.06 * u);
  ctx.lineTo(0.2 * u, hip + 0.06 * u);
  ctx.lineTo(-0.2 * u, hip + 0.06 * u);
  ctx.closePath();
  ctx.fill();
  ctx.lineWidth = lw;
  ctx.stroke();
  if (suit && !dim) {
    // The roster stripe across a suit's chest, so they are still theirs.
    ctx.fillStyle = hostile ? '#ff5a4e' : colour;
    ctx.fillRect(-tw / 2 + lw, top + 0.18 * u, tw - 2 * lw, 0.1 * u);
  }
  if (!suit && !dim) roleTorso(ctx, role, u, top, tw, hip, lw);

  // Arms, by pose.
  const armW = 0.13 * u;
  const arm = (side, angle, length = 0.48) => {
    ctx.save();
    ctx.translate(side * (tw / 2 - armW * 0.3), top + 0.08 * u);
    ctx.rotate(angle);
    ctx.fillStyle = limb;
    roundRect(ctx, -armW / 2, 0, armW, length * u, armW * 0.45);
    ctx.fill();
    ctx.lineWidth = lw;
    ctx.stroke();
    ctx.fillStyle = suit ? body : face; // hands
    ctx.beginPath();
    ctx.arc(0, length * u, armW * 0.55, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    // Where the hand is, for a tool.
    const a = angle;
    return { x: side * (tw / 2 - armW * 0.3) - Math.sin(a) * length * u, y: top + 0.08 * u + Math.cos(a) * length * u };
  };
  let hand;
  if (pose === 'fight') {
    arm(-1, 2.2, 0.4);
    hand = arm(1, -2.4 + 0.1 * Math.sin(phase * Math.PI * 4), 0.42);
  } else if (pose === 'carry') {
    arm(-1, Math.PI - 0.25, 0.46);
    hand = arm(1, -Math.PI + 0.25, 0.46);
  } else if (pose === 'work') {
    arm(-1, -0.9 + 0.15 * Math.sin(phase * Math.PI * 4), 0.46);
    hand = arm(1, -1.2 + 0.2 * Math.sin(phase * Math.PI * 4 + 1), 0.46);
  } else if (pose === 'walk') {
    arm(-1, -swing * 0.9, 0.46);
    hand = arm(1, swing * 0.9, 0.46);
  } else {
    arm(-1, 0.12, 0.46);
    hand = arm(1, -0.12, 0.46);
  }
  if (!dim && !suit && pose !== 'carry' && pose !== 'fight') roleHand(ctx, role, u, hand, lw);

  // Head, then the role's headgear over it.
  const headR = 0.17 * u;
  const hy = top - headR * 0.95;
  ctx.fillStyle = face;
  ctx.beginPath();
  ctx.arc(0.01 * u, hy, headR, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = lw;
  ctx.stroke();
  if (!dim) {
    // An eye on the side they face.
    ctx.fillStyle = INK;
    ctx.beginPath();
    ctx.arc(0.08 * u, hy - 0.02 * u, Math.max(0.8, 0.025 * u), 0, Math.PI * 2);
    ctx.fill();
  }
  if (!dim) roleHead(ctx, role, u, hy, headR, lw, hostile);
  if (suit) {
    // The suit's bubble helmet over everything.
    ctx.fillStyle = 'rgba(190, 225, 255, 0.28)';
    ctx.strokeStyle = dim ? '#5a606b' : '#f4f7fb';
    ctx.lineWidth = lw * 1.4;
    ctx.beginPath();
    ctx.arc(0.01 * u, hy, headR * 1.55, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.strokeStyle = INK;
  }

  // A label on the chest: their roster number, or one of theirs' initial.
  if (label && pose !== 'dead' && s >= 18) {
    ctx.save();
    ctx.scale(facing >= 0 ? 1 : -1, 1); // text reads the right way round
    const size = Math.max(8, 0.2 * u);
    const py = top + 0.32 * u;
    ctx.fillStyle = 'rgba(5, 7, 11, 0.78)';
    roundRect(ctx, -size * 0.55, py - size * 0.6, size * 1.1, size * 1.15, size * 0.2);
    ctx.fill();
    ctx.fillStyle = hostile ? '#ff8c84' : '#f4f7fb';
    ctx.font = `700 ${size}px ui-monospace, Menlo, Consolas, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, 0, py + 0.5);
    ctx.restore();
  }
  ctx.restore();
}

/** What the role wears on the body. */
function roleTorso(ctx, role, u, top, tw, hip, lw) {
  if (role === 'medic') {
    // A white smock over the lower half, and a red cross on it.
    ctx.fillStyle = '#eef2f6';
    ctx.beginPath();
    ctx.moveTo(-tw / 2 + 0.04 * u, top + 0.5 * u);
    ctx.lineTo(tw / 2 - 0.04 * u, top + 0.5 * u);
    ctx.lineTo(0.2 * u, hip + 0.06 * u);
    ctx.lineTo(-0.2 * u, hip + 0.06 * u);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#d23b3b';
    const c = (top + 0.5 * u + hip) / 2 + 0.02 * u;
    ctx.fillRect(-0.02 * u, c - 0.06 * u, 0.04 * u, 0.12 * u);
    ctx.fillRect(-0.06 * u, c - 0.02 * u, 0.12 * u, 0.04 * u);
  } else if (role === 'gunner') {
    // An ammo belt from shoulder to hip.
    ctx.strokeStyle = '#5a4a22';
    ctx.lineWidth = 0.08 * u;
    ctx.beginPath();
    ctx.moveTo(-tw / 2 + 0.05 * u, top + 0.04 * u);
    ctx.lineTo(0.18 * u, hip + 0.02 * u);
    ctx.stroke();
    ctx.fillStyle = '#d6b04a';
    for (let i = 1; i < 5; i++) {
      const t = i / 5;
      ctx.fillRect(-tw / 2 + 0.05 * u + t * (0.18 * u + tw / 2 - 0.05 * u) - 0.02 * u, top + 0.04 * u + t * (hip - top - 0.02 * u) - 0.02 * u, 0.04 * u, 0.04 * u);
    }
    ctx.strokeStyle = INK;
  } else if (role === 'security') {
    // A vest over the suit.
    ctx.fillStyle = '#2b3442';
    roundRect(ctx, -tw / 2 + 0.06 * u, top + 0.06 * u, tw - 0.12 * u, hip - top - 0.12 * u, 0.05 * u);
    ctx.fill();
    ctx.lineWidth = lw;
    ctx.stroke();
  }
  if (role === 'engineer') {
    // A tool belt with pouches.
    ctx.fillStyle = '#6b4a2a';
    ctx.fillRect(-0.24 * u, hip - 0.08 * u, 0.48 * u, 0.08 * u);
    ctx.fillStyle = '#8a6136';
    ctx.fillRect(0.08 * u, hip - 0.06 * u, 0.12 * u, 0.13 * u);
    ctx.fillRect(-0.2 * u, hip - 0.06 * u, 0.1 * u, 0.11 * u);
  } else {
    // A plain belt line.
    ctx.fillStyle = 'rgba(5, 7, 11, 0.45)';
    ctx.fillRect(-0.21 * u, hip - 0.06 * u, 0.42 * u, 0.04 * u);
  }
}

/** What the role holds. */
function roleHand(ctx, role, u, hand, lw) {
  if (role === 'engineer') {
    // A wrench.
    ctx.save();
    ctx.translate(hand.x, hand.y);
    ctx.rotate(-0.5);
    ctx.fillStyle = '#b8c0cc';
    ctx.fillRect(-0.025 * u, -0.02 * u, 0.05 * u, 0.3 * u);
    ctx.beginPath();
    ctx.arc(0, 0.3 * u, 0.06 * u, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = lw * 0.8;
    ctx.stroke();
    ctx.restore();
  } else if (role === 'quartermaster') {
    // A clipboard held in front.
    ctx.fillStyle = '#c9b48a';
    ctx.fillRect(hand.x - 0.02 * u, hand.y - 0.22 * u, 0.18 * u, 0.24 * u);
    ctx.lineWidth = lw * 0.8;
    ctx.strokeRect(hand.x - 0.02 * u, hand.y - 0.22 * u, 0.18 * u, 0.24 * u);
    ctx.fillStyle = '#f4f7fb';
    ctx.fillRect(hand.x + 0.01 * u, hand.y - 0.17 * u, 0.12 * u, 0.15 * u);
    ctx.fillStyle = '#7a8392';
    ctx.fillRect(hand.x + 0.03 * u, hand.y - 0.24 * u, 0.08 * u, 0.04 * u);
  } else if (role === 'medic') {
    // A small kit bag.
    ctx.fillStyle = '#f4f7fb';
    ctx.fillRect(hand.x - 0.08 * u, hand.y, 0.18 * u, 0.13 * u);
    ctx.lineWidth = lw * 0.8;
    ctx.strokeRect(hand.x - 0.08 * u, hand.y, 0.18 * u, 0.13 * u);
    ctx.fillStyle = '#d23b3b';
    ctx.fillRect(hand.x - 0.005 * u, hand.y + 0.025 * u, 0.03 * u, 0.08 * u);
    ctx.fillRect(hand.x - 0.03 * u, hand.y + 0.05 * u, 0.08 * u, 0.03 * u);
  }
}

/** What the role wears on the head. */
function roleHead(ctx, role, u, hy, r, lw, hostile) {
  ctx.lineWidth = lw;
  ctx.strokeStyle = INK;
  if (role === 'pilot') {
    // Headset: a band over the top, an earcup, a boom mic to the mouth.
    ctx.strokeStyle = '#2a2f38';
    ctx.lineWidth = 0.05 * u;
    ctx.beginPath();
    ctx.arc(0, hy, r * 1.08, Math.PI * 1.05, Math.PI * 1.95);
    ctx.stroke();
    ctx.fillStyle = '#2a2f38';
    ctx.beginPath();
    ctx.arc(-0.08 * u, hy + 0.01 * u, 0.06 * u, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 0.025 * u;
    ctx.beginPath();
    ctx.moveTo(-0.06 * u, hy + 0.05 * u);
    ctx.quadraticCurveTo(0.06 * u, hy + 0.14 * u, 0.15 * u, hy + 0.08 * u);
    ctx.stroke();
    ctx.fillStyle = '#ffd166';
    ctx.beginPath();
    ctx.arc(0.15 * u, hy + 0.08 * u, 0.025 * u, 0, Math.PI * 2);
    ctx.fill();
  } else if (role === 'engineer') {
    // Hard hat with a brim.
    ctx.fillStyle = '#f2b632';
    ctx.beginPath();
    ctx.arc(0, hy - 0.02 * u, r * 1.05, Math.PI, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillRect(-r * 1.1, hy - 0.04 * u, r * 2.5, 0.05 * u);
    ctx.strokeRect(-r * 1.1, hy - 0.04 * u, r * 2.5, 0.05 * u);
  } else if (role === 'gunner') {
    // Ear defenders.
    ctx.strokeStyle = '#3c3f44';
    ctx.lineWidth = 0.04 * u;
    ctx.beginPath();
    ctx.arc(0, hy, r * 1.1, Math.PI * 1.1, Math.PI * 1.9);
    ctx.stroke();
    ctx.fillStyle = '#c0392b';
    roundRect(ctx, -0.15 * u, hy - 0.07 * u, 0.11 * u, 0.15 * u, 0.04 * u);
    ctx.fill();
    ctx.lineWidth = lw;
    ctx.strokeStyle = INK;
    ctx.stroke();
  } else if (role === 'medic') {
    // A white cap with a red cross.
    ctx.fillStyle = '#f4f7fb';
    ctx.beginPath();
    ctx.arc(0, hy - 0.03 * u, r * 1.02, Math.PI, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#d23b3b';
    ctx.fillRect(-0.015 * u, hy - 0.15 * u, 0.03 * u, 0.09 * u);
    ctx.fillRect(-0.045 * u, hy - 0.12 * u, 0.09 * u, 0.03 * u);
  } else if (role === 'security') {
    // Helmet with a dark visor across the eyes.
    ctx.fillStyle = hostile ? '#4a1e1b' : '#3b4656';
    ctx.beginPath();
    ctx.arc(0, hy - 0.01 * u, r * 1.12, Math.PI * 0.95, Math.PI * 2.05);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#7fd4ff';
    ctx.globalAlpha *= 0.85;
    roundRect(ctx, -0.02 * u, hy - 0.06 * u, r * 1.2, 0.07 * u, 0.02 * u);
    ctx.fill();
    ctx.globalAlpha /= 0.85;
  } else if (role === 'quartermaster') {
    // A flat cap with a peak.
    ctx.fillStyle = '#5b4b3a';
    ctx.beginPath();
    ctx.ellipse(0, hy - 0.07 * u, r * 1.05, r * 0.6, 0, Math.PI, 0);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillRect(0, hy - 0.08 * u, r * 1.6, 0.04 * u);
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** A colour lighter (amount > 0) or darker (< 0). Hex in, hex out. */
export function shade(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const ch = (v) => Math.max(0, Math.min(255, Math.round(amount < 0 ? v * (1 + amount) : v + (255 - v) * amount)));
  const r = ch((n >> 16) & 255);
  const g = ch((n >> 8) & 255);
  const b = ch(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}
