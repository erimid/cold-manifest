// Draws the ship: a top-down cutaway (brief §6, §17). All art is drawn in
// code. The parts that never change (hull, floors, walls, stencils) are drawn
// once to an offscreen canvas; lighting, doors and hazards are drawn on top
// every frame.
//
// The renderer only reads sim state. It never changes it.

import { createRng } from '../engine/rng.js';
import { SYSTEMS } from '../sim/systems.js';

const MONO = "ui-monospace, 'SF Mono', Menlo, Consolas, 'Liberation Mono', 'Courier New', monospace";

const C = {
  hullTop: '#262d37',
  hullBottom: '#141920',
  hullEdge: '#4c5665',
  floor: '#2b323b',
  corridor: '#232930',
  helm: '#2d333c',
  wall: '#0a0d12',
  amber: '#ffb347',
  amberDim: '#a8742c',
  sodium: '#ff8a2b',
  paper: '#e9dcc3',
  alarm: '#ff4136',
  frost: '#cfe9ff',
  vent: '#9bd15a',
  shield: '#7fd4ff',
  doorLeaf: '#8d6a34',
  doorLocked: '#b3372f',
  airlockLeaf: '#b9c4d1',
};

const DOOR_THICKNESS = 0.3;
const AIRLOCK_THICKNESS = 0.42;

/** Crew are drawn as numbered discs this many tiles across (radius). */
const CREW_RADIUS = 0.42;
const CREW_COLOURS = ['#5ec8ff', '#ffd166', '#ef7bbf', '#8be28b', '#c9a0ff', '#ff9f5e', '#7fe3d0', '#e6e6e6'];

export function createShipRenderer(layout) {
  let cache = null; // { canvas, key }
  const roomArt = new Map(
    layout.rooms.map((room) => {
      const rng = createRng(`ship-art:${layout.id}:${room.id}`);
      return [
        room.id,
        {
          // Where flames sit, as fractions of the room.
          flames: Array.from({ length: 7 }, () => ({ x: rng.range(0.15, 0.85), y: rng.range(0.2, 0.85), phase: rng.range(0, 6.28), size: rng.range(0.7, 1.2) })),
          // Where the hull crack runs: along one wall.
          crack: { side: rng.int(4), at: rng.range(0.25, 0.75), kinks: Array.from({ length: 6 }, () => rng.range(-1, 1)) },
          scuffs: Array.from({ length: 2 + rng.int(3) }, () => ({ x: rng.next(), y: rng.next(), w: rng.range(0.1, 0.4), h: rng.range(0.03, 0.08), a: rng.range(0.05, 0.14) })),
        },
      ];
    }),
  );

  // ---------- geometry ----------

  /** A door's rectangle in tile units. */
  function doorRect(door) {
    const t = door.airlock ? AIRLOCK_THICKNESS : DOOR_THICKNESS;
    return door.vertical ? { x: door.x - t / 2, y: door.y - 0.5, w: t, h: 1 } : { x: door.x - 0.5, y: door.y - t / 2, w: 1, h: t };
  }

  /**
   * The view that fits the whole ship into `area` (CSS pixels):
   * { scale: pixels per tile, ox, oy: where tile (0, 0) lands }.
   */
  function fit(area) {
    const { bounds } = layout;
    const extra = 1.6; // room for engine nozzles: on the left, or underneath a ship whose bow points up
    const up = layout.facing === 'up';
    const w = bounds.w + (up ? 0 : extra);
    const h = bounds.h + (up ? extra : 0);
    const scale = Math.min(area.w / w, area.h / h);
    return {
      scale,
      ox: area.x + (area.w - w * scale) / 2 + ((up ? 0 : extra) - bounds.x) * scale,
      oy: area.y + (area.h - h * scale) / 2 - bounds.y * scale,
    };
  }

  /** The middle of a room, in CSS pixels. */
  function roomCentre(view, roomId) {
    const room = layout.room(roomId);
    return { x: view.ox + (room.x + room.w / 2) * view.scale, y: view.oy + (room.y + room.h / 2) * view.scale };
  }

  /** Where a hardpoint sits, in CSS pixels. */
  function hardpointAt(view, slot) {
    const point = layout.hardpoints[slot] ?? layout.hardpoints[0] ?? { x: layout.bounds.x + layout.bounds.w / 2, y: layout.bounds.y + layout.bounds.h / 2 };
    return { x: view.ox + point.x * view.scale, y: view.oy + point.y * view.scale };
  }

  /** Where a crew member is drawn, in tile units, `alpha` of the way through the current tick. */
  function crewAt(member, alpha = 1) {
    return { x: member.px + (member.x - member.px) * alpha, y: member.py + (member.y - member.py) * alpha };
  }

  /** Everything tappable, in CSS pixels. Crew sit above doors, doors above rooms. */
  function targets(view, crew = {}, { foe = false } = {}) {
    const out = [];
    for (const member of Object.values(crew)) {
      out.push({ id: member.id, kind: 'crew', cx: view.ox + member.x * view.scale, cy: view.oy + member.y * view.scale, r: CREW_RADIUS * view.scale, priority: 3 });
    }
    if (foe) {
      // The other ship: its rooms, to aim at, send boarders to or look at, and any of ours aboard.
      for (const room of layout.rooms) {
        out.push({ id: room.id, kind: 'foe', x: view.ox + room.x * view.scale, y: view.oy + room.y * view.scale, w: room.w * view.scale, h: room.h * view.scale, priority: 1 });
      }
      return out;
    }
    for (const room of layout.rooms) {
      out.push({ id: room.id, kind: 'room', x: view.ox + room.x * view.scale, y: view.oy + room.y * view.scale, w: room.w * view.scale, h: room.h * view.scale, priority: 1 });
    }
    for (const door of layout.doors) {
      // A little fatter than drawn, so a fingertip can find it.
      const fat = 0.5;
      const r = door.vertical ? { x: door.x - fat / 2, y: door.y - 0.5, w: fat, h: 1 } : { x: door.x - 0.5, y: door.y - fat / 2, w: 1, h: fat };
      out.push({ id: door.id, kind: 'door', x: view.ox + r.x * view.scale, y: view.oy + r.y * view.scale, w: r.w * view.scale, h: r.h * view.scale, priority: 2 });
    }
    return out;
  }

  // ---------- the static layer ----------

  function hullPath(ctx) {
    ctx.beginPath();
    layout.hull.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
  }

  function drawStatic(ctx, view) {
    const s = view.scale;
    ctx.save();
    ctx.translate(view.ox, view.oy);
    ctx.scale(s, s);
    const px = 1 / s; // one CSS pixel in tile units
    const { bounds } = layout;

    // Engine nozzles, behind the hull.
    const engines = layout.roomOfSystem('engines');
    if (engines && layout.facing === 'up') {
      const base = bounds.y + bounds.h;
      for (const cx of [engines.x + 1, engines.x + engines.w - 1]) {
        const glow = ctx.createLinearGradient(0, base + 1.5, 0, base);
        glow.addColorStop(0, 'rgba(255, 138, 43, 0)');
        glow.addColorStop(1, 'rgba(255, 138, 43, 0.5)');
        ctx.fillStyle = glow;
        ctx.fillRect(cx - 0.6, base, 1.2, 1.5);
        ctx.fillStyle = '#10141a';
        ctx.strokeStyle = C.hullEdge;
        ctx.lineWidth = 2 * px;
        ctx.beginPath();
        ctx.moveTo(cx - 0.75, base - 0.1);
        ctx.lineTo(cx - 0.95, base + 0.8);
        ctx.lineTo(cx + 0.95, base + 0.8);
        ctx.lineTo(cx + 0.75, base - 0.1);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    } else if (engines) {
      for (const cy of [engines.y + 1.5, engines.y + engines.h - 1.5]) {
        const glow = ctx.createLinearGradient(bounds.x - 1.5, 0, bounds.x, 0);
        glow.addColorStop(0, 'rgba(255, 138, 43, 0)');
        glow.addColorStop(1, 'rgba(255, 138, 43, 0.5)');
        ctx.fillStyle = glow;
        ctx.fillRect(bounds.x - 1.5, cy - 0.6, 1.5, 1.2);
        ctx.fillStyle = '#10141a';
        ctx.strokeStyle = C.hullEdge;
        ctx.lineWidth = 2 * px;
        ctx.beginPath();
        ctx.moveTo(bounds.x + 0.1, cy - 0.75);
        ctx.lineTo(bounds.x - 0.8, cy - 0.95);
        ctx.lineTo(bounds.x - 0.8, cy + 0.95);
        ctx.lineTo(bounds.x + 0.1, cy + 0.75);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }

    // Hull
    const steel = ctx.createLinearGradient(0, bounds.y, 0, bounds.y + bounds.h);
    steel.addColorStop(0, C.hullTop);
    steel.addColorStop(1, C.hullBottom);
    hullPath(ctx);
    ctx.fillStyle = steel;
    ctx.fill();
    ctx.save();
    hullPath(ctx);
    ctx.clip();
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.28)';
    ctx.lineWidth = px;
    ctx.beginPath();
    for (let x = Math.ceil(bounds.x); x < bounds.x + bounds.w; x += 2) {
      ctx.moveTo(x + 0.5, bounds.y);
      ctx.lineTo(x + 0.5, bounds.y + bounds.h);
    }
    ctx.stroke();
    ctx.restore();
    hullPath(ctx);
    ctx.strokeStyle = C.hullEdge;
    ctx.lineWidth = 2 * px;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // Rooms
    for (const room of layout.rooms) {
      const art = roomArt.get(room.id);
      ctx.fillStyle = room.kind === 'corridor' ? C.corridor : room.kind === 'helm' ? C.helm : C.floor;
      ctx.fillRect(room.x, room.y, room.w, room.h);

      // Deck plating, one plate per tile, and some wear.
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.2)';
      ctx.lineWidth = px;
      ctx.beginPath();
      for (let x = 1; x < room.w; x++) {
        ctx.moveTo(room.x + x, room.y);
        ctx.lineTo(room.x + x, room.y + room.h);
      }
      for (let y = 1; y < room.h; y++) {
        ctx.moveTo(room.x, room.y + y);
        ctx.lineTo(room.x + room.w, room.y + y);
      }
      ctx.stroke();
      for (const scuff of art.scuffs) {
        ctx.fillStyle = `rgba(0, 0, 0, ${scuff.a})`;
        ctx.fillRect(room.x + scuff.x * room.w * (1 - scuff.w), room.y + scuff.y * room.h * (1 - scuff.h), scuff.w * room.w, scuff.h * room.h);
      }

      if (room.kind === 'corridor') {
        // A worn guide line down the middle.
        ctx.strokeStyle = 'rgba(168, 116, 44, 0.45)';
        ctx.lineWidth = 2 * px;
        ctx.setLineDash([0.5, 0.35]);
        ctx.beginPath();
        ctx.moveTo(room.x + 0.4, room.y + room.h / 2);
        ctx.lineTo(room.x + room.w - 0.4, room.y + room.h / 2);
        ctx.stroke();
        ctx.setLineDash([]);
      } else {
        // The company's stencil, big and faded, on the floor.
        const code = room.system ? SYSTEMS[room.system].code : room.kind === 'helm' ? 'HELM' : '';
        const size = Math.min(room.h * 0.5, (room.w * 0.82) / (code.length * 0.62));
        ctx.fillStyle = 'rgba(255, 179, 71, 0.13)';
        ctx.font = `700 ${size}px ${MONO}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(code, room.x + room.w / 2, room.y + room.h / 2 + 0.15);
      }

      // Vent grille, in rooms the crawlspaces reach.
      if (layout.ventExits(room.id).length) {
        const gx = room.x + room.w - 0.95;
        const gy = room.y + room.h - 0.65;
        ctx.fillStyle = '#0d1116';
        ctx.fillRect(gx, gy, 0.7, 0.42);
        ctx.strokeStyle = 'rgba(160, 172, 188, 0.5)';
        ctx.lineWidth = px;
        ctx.strokeRect(gx, gy, 0.7, 0.42);
        ctx.beginPath();
        for (let i = 1; i < 5; i++) {
          ctx.moveTo(gx + i * 0.14, gy + 0.06);
          ctx.lineTo(gx + i * 0.14, gy + 0.36);
        }
        ctx.stroke();
      }

      // Walls
      ctx.strokeStyle = C.wall;
      ctx.lineWidth = 3.5 * px;
      ctx.strokeRect(room.x, room.y, room.w, room.h);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.045)';
      ctx.lineWidth = px;
      ctx.strokeRect(room.x + 3 * px, room.y + 3 * px, room.w - 6 * px, room.h - 6 * px);
    }
    ctx.restore();

    // Room names, in screen pixels so the text stays crisp.
    const fontPx = Math.max(9, Math.min(13, s * 0.36));
    ctx.font = `700 ${fontPx}px ${MONO}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(233, 220, 195, 0.62)';
    for (const room of layout.rooms) {
      const text = room.name.toUpperCase();
      const maxWidth = room.w * s - 12;
      if (ctx.measureText(text).width > maxWidth && room.kind === 'corridor') continue;
      ctx.fillText(text, view.ox + room.x * s + 7, view.oy + room.y * s + 6, maxWidth);
    }
  }

  function staticLayer(view, width, height, dpr) {
    const key = `${view.scale}|${view.ox}|${view.oy}|${width}|${height}|${dpr}`;
    if (cache?.key === key) return cache.canvas;
    const canvas = cache?.canvas ?? document.createElement('canvas');
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    drawStatic(ctx, view);
    cache = { canvas, key };
    return canvas;
  }

  // ---------- the live layer ----------

  function drawRoomLive(ctx, view, room, r, time, reduceFlicker) {
    const s = view.scale;
    const x = view.ox + room.x * s;
    const y = view.oy + room.y * s;
    const w = room.w * s;
    const h = room.h * s;
    const art = roomArt.get(room.id);

    // Cut loose: nothing there but the scar where it was bolted on.
    if (r.jettisoned) {
      ctx.fillStyle = 'rgba(5, 8, 13, 0.94)';
      ctx.fillRect(x, y, w, h);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      ctx.strokeStyle = 'rgba(255, 65, 54, 0.28)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let d = -h; d < w; d += 16) {
        ctx.moveTo(x + d, y + h);
        ctx.lineTo(x + d + h, y);
      }
      ctx.stroke();
      ctx.restore();
      ctx.fillStyle = 'rgba(233, 220, 195, 0.75)';
      ctx.font = `700 ${Math.max(9, Math.min(13, s * 0.36))}px ui-monospace, Menlo, Consolas, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('JETTISONED', x + w / 2, y + h / 2);
      ctx.textAlign = 'start';
      ctx.textBaseline = 'alphabetic';
      return;
    }

    // Lamp light: a warm pool, strongest in the middle.
    if (r.light > 0) {
      const pool = ctx.createRadialGradient(x + w / 2, y + h / 2, 0, x + w / 2, y + h / 2, Math.max(w, h) * 0.7);
      pool.addColorStop(0, `rgba(255, 190, 110, ${0.2 * r.light})`);
      pool.addColorStop(1, 'rgba(255, 150, 60, 0)');
      ctx.fillStyle = pool;
      ctx.fillRect(x, y, w, h);
    }
    // Darkness where the lamps are off.
    if (r.light < 1) {
      ctx.fillStyle = `rgba(3, 5, 9, ${0.82 * (1 - r.light)})`;
      ctx.fillRect(x, y, w, h);
    }
    // Thin air reads cold and blue.
    if (r.oxygen < 0.6) {
      ctx.fillStyle = `rgba(90, 150, 220, ${(0.6 - r.oxygen) * 0.45})`;
      ctx.fillRect(x, y, w, h);
    }

    // A breach: frost creeping in from the walls, and the crack itself.
    if (r.breach > 0) {
      const reach = Math.min(w, h) * (0.18 + 0.22 * r.breach);
      const alpha = 0.16 + 0.22 * r.breach;
      const edges = [
        [x, y, x, y + reach, x, y, w, reach],
        [x, y + h, x, y + h - reach, x, y + h - reach, w, reach],
        [x, y, x + reach, y, x, y, reach, h],
        [x + w, y, x + w - reach, y, x + w - reach, y, reach, h],
      ];
      for (const [x0, y0, x1, y1, rx, ry, rw, rh] of edges) {
        const frost = ctx.createLinearGradient(x0, y0, x1, y1);
        frost.addColorStop(0, `rgba(207, 233, 255, ${alpha})`);
        frost.addColorStop(1, 'rgba(207, 233, 255, 0)');
        ctx.fillStyle = frost;
        ctx.fillRect(rx, ry, rw, rh);
      }
      const { side, at, kinks } = art.crack;
      const along = side < 2 ? w : h;
      const length = Math.min(along * 0.5, s * (0.8 + 1.6 * r.breach));
      const start = at * along - length / 2;
      ctx.beginPath();
      kinks.forEach((k, i) => {
        const d = start + (length * i) / (kinks.length - 1);
        const off = k * s * 0.16 + s * 0.14;
        const px = side === 0 ? x + d : side === 1 ? x + d : side === 2 ? x + off : x + w - off;
        const py = side === 0 ? y + off : side === 1 ? y + h - off : y + d;
        if (i) ctx.lineTo(px, py);
        else ctx.moveTo(px, py);
      });
      ctx.lineJoin = 'miter';
      ctx.strokeStyle = C.frost;
      ctx.lineWidth = 5;
      ctx.stroke();
      ctx.strokeStyle = '#02040a';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }

    // Fire: its own light, whatever the lamps are doing.
    if (r.fire > 0) {
      ctx.fillStyle = `rgba(255, 110, 20, ${0.1 + 0.2 * r.fire})`;
      ctx.fillRect(x, y, w, h);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      const count = Math.max(1, Math.ceil(r.fire * art.flames.length));
      for (let i = 0; i < count; i++) {
        const f = art.flames[i];
        const wobble = reduceFlicker ? 0.85 : 0.75 + 0.25 * Math.sin(time * 9 + f.phase) * Math.sin(time * 5.3 + f.phase * 2);
        const radius = s * (0.5 + 0.7 * r.fire) * f.size * wobble;
        const fx = x + f.x * w;
        const fy = y + f.y * h - (reduceFlicker ? 0 : Math.sin(time * 7 + f.phase) * s * 0.06);
        const flame = ctx.createRadialGradient(fx, fy, 0, fx, fy, radius);
        flame.addColorStop(0, 'rgba(255, 236, 170, 0.95)');
        flame.addColorStop(0.35, 'rgba(255, 150, 40, 0.8)');
        flame.addColorStop(1, 'rgba(255, 60, 10, 0)');
        ctx.fillStyle = flame;
        ctx.fillRect(fx - radius, fy - radius, radius * 2, radius * 2);
      }
      ctx.restore();
    }

    // Alarm: a pulsing border, plus a shape per hazard so it never relies on colour alone.
    const lowAir = r.oxygen < 0.35;
    if (r.fire > 0 || r.breach > 0 || lowAir) {
      const pulse = reduceFlicker ? 0.8 : 0.55 + 0.45 * Math.sin(time * 6.5);
      ctx.strokeStyle = `rgba(255, 65, 54, ${pulse})`;
      ctx.lineWidth = 3;
      ctx.strokeRect(x + 2.5, y + 2.5, w - 5, h - 5);
      let bx = x + w - 10;
      const by = y + 15;
      const badge = (draw, letter) => {
        ctx.fillStyle = C.alarm;
        ctx.beginPath();
        draw(bx - 9, by);
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.font = `700 10px ${MONO}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(letter, bx - 9, by + 1);
        bx -= 22;
      };
      if (r.fire > 0) badge((cx, cy) => { ctx.moveTo(cx, cy - 10); ctx.lineTo(cx + 10, cy + 8); ctx.lineTo(cx - 10, cy + 8); ctx.closePath(); }, 'F');
      if (r.breach > 0) badge((cx, cy) => { ctx.moveTo(cx, cy - 10); ctx.lineTo(cx + 10, cy); ctx.lineTo(cx, cy + 10); ctx.lineTo(cx - 10, cy); ctx.closePath(); }, 'B');
      if (lowAir) badge((cx, cy) => ctx.arc(cx, cy, 9, 0, Math.PI * 2), 'O');
    }
  }

  function drawDoor(ctx, view, door, d, openness) {
    const s = view.scale;
    const rect = doorRect(door);
    const x = view.ox + rect.x * s;
    const y = view.oy + rect.y * s;
    const w = rect.w * s;
    const h = rect.h * s;

    // The doorway: a frame, then the gap you can see through when it is open.
    ctx.fillStyle = door.airlock ? C.amberDim : '#05070a';
    ctx.fillRect(x - 1.5, y - 1.5, w + 3, h + 3);
    ctx.fillStyle = door.airlock ? '#03050a' : '#1c2128';
    ctx.fillRect(x, y, w, h);

    // Two leaves that slide apart.
    const half = (door.vertical ? h : w) / 2;
    const leaf = half * (1 - openness);
    const jammed = d.state === 'jammed';
    const base = jammed ? C.sodium : d.state === 'locked' ? C.doorLocked : door.airlock ? C.airlockLeaf : C.doorLeaf;
    if (leaf > 0.5) {
      const leaves = door.vertical
        ? [
            [x, y, w, leaf],
            [x, y + h - leaf, w, leaf],
          ]
        : [
            [x, y, leaf, h],
            [x + w - leaf, y, leaf, h],
          ];
      for (const [lx, ly, lw, lh] of leaves) {
        ctx.fillStyle = base;
        ctx.fillRect(lx, ly, lw, lh);
        if (jammed) {
          // Hazard stripes: a jammed door reads as jammed without colour.
          ctx.save();
          ctx.beginPath();
          ctx.rect(lx, ly, lw, lh);
          ctx.clip();
          ctx.strokeStyle = '#0a0d12';
          ctx.lineWidth = 2;
          ctx.beginPath();
          for (let k = -lh; k < lw + lh; k += 5) {
            ctx.moveTo(lx + k, ly + lh);
            ctx.lineTo(lx + k + lh, ly);
          }
          ctx.stroke();
          ctx.restore();
        }
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.lineWidth = 1;
        ctx.strokeRect(lx + 0.5, ly + 0.5, lw - 1, lh - 1);
      }
    }
    if (d.state === 'locked') {
      // A lock bar across the seam.
      ctx.fillStyle = C.paper;
      const cx = x + w / 2;
      const cy = y + h / 2;
      ctx.fillRect(cx - 3.5, cy - 3.5, 7, 7);
      ctx.fillStyle = C.doorLocked;
      ctx.fillRect(cx - 1.5, cy - 1.5, 3, 3);
    }
  }

  function drawCrew(ctx, view, member, alpha, selected) {
    const hostile = member.owner === 'enemy';
    const s = view.scale;
    const at = crewAt(member, alpha);
    const cx = view.ox + at.x * s;
    const cy = view.oy + at.y * s;
    const r = CREW_RADIUS * s;
    // Theirs are alarm red and carry an initial instead of a number, so they never pass for ours.
    const colour = hostile ? C.alarm : CREW_COLOURS[member.index % CREW_COLOURS.length];

    if (selected) {
      // Where they are headed.
      if (member.path.length) {
        ctx.strokeStyle = 'rgba(233, 220, 195, 0.7)';
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 6]);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        for (const p of member.path) ctx.lineTo(view.ox + p.x * s, view.oy + p.y * s);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.strokeStyle = C.paper;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      ctx.arc(cx, cy, r + 5, 0, Math.PI * 2);
      ctx.stroke();
    }

    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = member.alive ? colour : '#3a404b';
    ctx.fill();
    ctx.lineWidth = member.suit ? 3.5 : 2;
    ctx.strokeStyle = member.suit && member.alive ? '#f4f7fb' : '#05070b';
    ctx.stroke();

    // Their number, or a cross for the dead. Never colour alone (brief §17).
    ctx.fillStyle = member.alive ? '#05070b' : '#8b93a1';
    ctx.font = `700 ${Math.max(10, r * 1.15)}px ui-monospace, Menlo, Consolas, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(member.alive ? (hostile ? member.name.charAt(0).toUpperCase() : String(member.index + 1)) : '×', cx, cy + 1);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';

    // Health, once it is not full: a bar under their feet.
    if (member.alive && member.health < 1) {
      const w = r * 2.2;
      ctx.fillStyle = '#05070b';
      ctx.fillRect(cx - w / 2 - 1, cy + r + 3, w + 2, 6);
      ctx.fillStyle = member.health < 0.35 ? C.alarm : '#8be28b';
      ctx.fillRect(cx - w / 2, cy + r + 4, w * member.health, 4);
    }
  }

  /**
   * Draw one frame.
   *   view       from fit()
   *   width, height  the canvas size in CSS pixels
   *   state      sim.state
   *   time       animation time in seconds (game time, so it freezes on pause)
   *   selected   { kind, id } or null
   */
  /** Shield layers: a glow hugging the hull, one band per layer that is up, and a ghost of the one recharging. */
  function drawShield(ctx, view, shield, time, reduceFlicker) {
    const layers = Math.floor(shield.charge + 1e-9);
    const partial = shield.charge - layers;
    if (layers === 0 && partial <= 0) return;
    ctx.save();
    ctx.translate(view.ox, view.oy);
    ctx.scale(view.scale, view.scale);
    const px = 1 / view.scale;
    ctx.lineJoin = 'round';
    const shimmer = reduceFlicker ? 0 : 0.06 * Math.sin(time * 3);
    // Each layer reaches a little further out: fat strokes on the hull outline, stacked, so the inside glows brightest.
    for (let i = layers; i >= 0; i--) {
      const up = i < layers;
      if (!up && partial <= 0.02) continue;
      hullPath(ctx);
      ctx.lineWidth = (8 + i * 8) * 2 * px;
      ctx.strokeStyle = up ? `rgba(127, 212, 255, ${0.14 + shimmer})` : `rgba(127, 212, 255, ${0.07 * partial})`;
      ctx.stroke();
    }
    if (layers > 0) {
      hullPath(ctx);
      ctx.lineWidth = 2 * px;
      ctx.strokeStyle = `rgba(190, 235, 255, ${0.75 + shimmer})`;
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.restore();
  }

  /** A weapon on its hardpoint: a turret, a ring that fills as it charges, and its number. */
  function drawHardpoint(ctx, view, index, slot, fraction, chosen) {
    const at = hardpointAt(view, index);
    const r = Math.max(7, view.scale * 0.34);
    const aim = layout.enemy ? Math.PI : 0; // the two ships face each other across the screen
    ctx.save();
    ctx.translate(at.x, at.y);
    ctx.rotate(aim);
    ctx.fillStyle = '#10141a';
    ctx.strokeStyle = slot.powered ? C.amber : C.hullEdge;
    ctx.lineWidth = 2;
    ctx.fillRect(0, -r * 0.28, r * 1.7, r * 0.56);
    ctx.strokeRect(0, -r * 0.28, r * 1.7, r * 0.56);
    ctx.restore();
    ctx.beginPath();
    ctx.arc(at.x, at.y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#10141a';
    ctx.fill();
    ctx.strokeStyle = C.hullEdge;
    ctx.lineWidth = 2;
    ctx.stroke();
    if (fraction > 0) {
      ctx.beginPath();
      ctx.arc(at.x, at.y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * fraction);
      ctx.strokeStyle = fraction >= 1 ? C.paper : C.amber;
      ctx.lineWidth = 3;
      ctx.stroke();
    }
    if (chosen) {
      ctx.beginPath();
      ctx.arc(at.x, at.y, r + 5, 0, Math.PI * 2);
      ctx.strokeStyle = C.paper;
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    ctx.fillStyle = slot.powered ? C.amber : '#8b93a1';
    ctx.font = `700 ${Math.max(9, r * 1.1)}px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(index + 1), at.x, at.y + 1);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }

  /** Aiming marks on rooms of this ship: corner brackets and the numbers of the weapons pointed there. */
  function drawReticles(ctx, view, aimed, inviting) {
    const s = view.scale;
    if (inviting) {
      // A weapon is waiting for a target: every room says "tap me".
      ctx.strokeStyle = 'rgba(233, 220, 195, 0.55)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 5]);
      for (const room of layout.rooms) ctx.strokeRect(view.ox + room.x * s + 4, view.oy + room.y * s + 4, room.w * s - 8, room.h * s - 8);
      ctx.setLineDash([]);
    }
    for (const [roomId, slots] of aimed) {
      const room = layout.room(roomId);
      if (!room) continue;
      const x = view.ox + room.x * s + 5;
      const y = view.oy + room.y * s + 5;
      const w = room.w * s - 10;
      const h = room.h * s - 10;
      const arm = Math.min(w, h) * 0.28;
      ctx.strokeStyle = C.alarm;
      ctx.lineWidth = 3;
      ctx.beginPath();
      for (const [cx, cy, dx, dy] of [[x, y, 1, 1], [x + w, y, -1, 1], [x, y + h, 1, -1], [x + w, y + h, -1, -1]]) {
        ctx.moveTo(cx + dx * arm, cy);
        ctx.lineTo(cx, cy);
        ctx.lineTo(cx, cy + dy * arm);
      }
      ctx.stroke();
      const label = slots.map((slot) => slot + 1).join(' ');
      ctx.font = `700 12px ${MONO}`;
      const tw = ctx.measureText(label).width + 10;
      ctx.fillStyle = C.alarm;
      ctx.fillRect(x + w / 2 - tw / 2, y + h - 17, tw, 17);
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, x + w / 2, y + h - 8);
      ctx.textAlign = 'start';
      ctx.textBaseline = 'alphabetic';
    }
  }

  /** A ship whose hull has given out: dark, and labelled so. */
  function drawWreck(ctx, view) {
    ctx.save();
    ctx.translate(view.ox, view.oy);
    ctx.scale(view.scale, view.scale);
    hullPath(ctx);
    ctx.fillStyle = 'rgba(5, 8, 13, 0.72)';
    ctx.fill();
    ctx.restore();
    const { bounds } = layout;
    ctx.fillStyle = C.paper;
    ctx.font = `700 ${Math.max(11, Math.min(16, view.scale * 0.5))}px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('DESTROYED', view.ox + (bounds.x + bounds.w / 2) * view.scale, view.oy + (bounds.y + bounds.h / 2) * view.scale);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }

  /**
   * Extra, for fights:
   *   clear      false to draw over what is already on the canvas (the second ship)
   *   charges    each weapon's charge, 0 to 1, by slot
   *   chosenWeapon  the slot picked for aiming, or null
   *   aimed      Map of room id -> [weapon slots of the other ship pointed at it]
   *   inviting   true while the other ship is choosing a room of this one to aim at
   * Crew are drawn by whose they are: the enemy's in alarm red with an initial,
   * wherever they stand. Anyone in the docking tube is drawn faded.
   */
  function draw(ctx, { view, width, height, dpr, state, time, alpha = 1, selected, selectedCrew = null, showVents = false, reduceFlicker = false, clear = true, charges = [], chosenWeapon = null, aimed = null, inviting = false }) {
    if (clear) ctx.clearRect(0, 0, width, height);
    ctx.drawImage(staticLayer(view, width, height, dpr), 0, 0, width, height);
    const s = view.scale;

    for (const room of layout.rooms) drawRoomLive(ctx, view, room, state.rooms[room.id], time, reduceFlicker);
    for (const door of layout.doors) drawDoor(ctx, view, door, state.doors[door.id], state.doors[door.id].openness);

    if (showVents) {
      ctx.strokeStyle = C.vent;
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      for (const vent of layout.vents) {
        const a = layout.room(vent.a);
        const b = layout.room(vent.b);
        ctx.moveTo(view.ox + (a.x + a.w / 2) * s, view.oy + (a.y + a.h / 2) * s);
        ctx.lineTo(view.ox + (b.x + b.w / 2) * s, view.oy + (b.y + b.h / 2) * s);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // The dead first, so the living are drawn over them.
    const crew = Object.values(state.crew);
    for (const member of crew) if (!member.alive) drawCrew(ctx, view, member, alpha, member.id === selectedCrew);
    for (const member of crew) {
      if (!member.alive) continue;
      if (member.task === 'crossing') ctx.globalAlpha = 0.45;
      drawCrew(ctx, view, member, alpha, member.id === selectedCrew);
      ctx.globalAlpha = 1;
    }

    state.weapons.forEach((slot, index) => drawHardpoint(ctx, view, index, slot, charges[index] ?? 0, chosenWeapon === index));
    drawShield(ctx, view, state.shield, time, reduceFlicker);
    if (aimed) drawReticles(ctx, view, aimed, inviting);
    if (state.hull.points === 0) drawWreck(ctx, view);

    if (selected) {
      ctx.strokeStyle = C.paper;
      ctx.lineWidth = 2.5;
      if (selected.kind === 'room' || selected.kind === 'foe') {
        const room = layout.room(selected.id);
        ctx.strokeRect(view.ox + room.x * s - 1, view.oy + room.y * s - 1, room.w * s + 2, room.h * s + 2);
      } else {
        const rect = doorRect(layout.door(selected.id));
        ctx.strokeRect(view.ox + rect.x * s - 5, view.oy + rect.y * s - 5, rect.w * s + 10, rect.h * s + 10);
      }
    }
  }

  return { fit, targets, draw, doorRect, roomCentre, hardpointAt, crewColour: (index) => CREW_COLOURS[index % CREW_COLOURS.length] };
}
