// Hit testing for taps on the canvas (brief §4). Touch gets a generous hit
// area: a tap slightly outside a target's drawn edge still picks it up.
// Pure and DOM-free.

/** Extra reach, in CSS pixels, by pointer type. */
export const HIT_PADDING = Object.freeze({ mouse: 2, pen: 6, touch: 14 });

/** Distance from a point to a target's edge. 0 means the point is inside. */
export function distanceToTarget(target, x, y) {
  if (target.r !== undefined) {
    return Math.max(0, Math.hypot(x - target.cx, y - target.cy) - target.r);
  }
  const dx = Math.max(target.x - x, 0, x - (target.x + target.w));
  const dy = Math.max(target.y - y, 0, y - (target.y + target.h));
  return Math.hypot(dx, dy);
}

function areaOf(target) {
  return target.r !== undefined ? Math.PI * target.r * target.r : target.w * target.h;
}

/**
 * The target a pointer at (x, y) means, or null.
 *
 * Targets are rectangles { id, x, y, w, h } or circles { id, cx, cy, r },
 * with an optional `priority` (higher wins; doors beat the rooms they sit on).
 * A point inside a target always beats a near miss on another. Among targets
 * the point is inside, higher priority wins, then the smaller target. Among
 * near misses, the closest edge wins.
 */
export function pickTarget(targets, x, y, pointerType = 'mouse') {
  const padding = HIT_PADDING[pointerType] ?? HIT_PADDING.mouse;
  let best = null;
  let bestKey = null;
  for (const target of targets) {
    const distance = distanceToTarget(target, x, y);
    if (distance > padding) continue;
    const inside = distance === 0;
    // Lower key wins, compared field by field.
    const key = inside
      ? [0, -(target.priority ?? 0), areaOf(target)]
      : [1, distance, -(target.priority ?? 0)];
    if (!bestKey || key[0] < bestKey[0] || (key[0] === bestKey[0] && (key[1] < bestKey[1] || (key[1] === bestKey[1] && key[2] < bestKey[2])))) {
      best = target;
      bestKey = key;
    }
  }
  return best;
}
