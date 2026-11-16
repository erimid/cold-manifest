// Draws a ship. Ours is seen side-on, as stacked decks (D-071): back walls,
// pipes, deck plates, a deck lift under every hatch, the lift shaft, crawlway
// hatches and the old company's stencils. The enemy is drawn as a sensor
// return (D-073): room outlines in phosphor green, nothing else, and only the
// rooms our sensors have resolved; the rest is static (D-074). A room of our
// own that Margo cannot see into is drawn as she last saw it, behind static.
// All art is
// drawn in code. The parts that never change are drawn once to an offscreen
// canvas; lighting, doors, hazards, the lift cars and crew go on top every frame.
//
// The renderer only reads sim state. It never changes it.

import { createRng } from '../engine/rng.js';
import { STAND } from '../sim/crew.js';
import { BODY, drawBody, skinOf } from './crew-art.js';

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
  hold: '#2a2e33',
  deck: '#46505c',
  rail: '#8a929e',
  hazard: '#c9a227',
  phosphor: '#7fe39a',
  shield: '#7fd4ff',
  doorLeaf: '#8d6a34',
  doorLocked: '#b3372f',
  airlockLeaf: '#b9c4d1',
};

const DOOR_THICKNESS = 0.3;
/** Half the width of a deck lift's platform, in tiles. */
const LIFT_HALF = 0.36;
/** How thick the deck plate under every room is drawn, in tiles. */
const FLOOR = 0.16;

/** The stencils the company painted on its walls, by room or by system: [big, small]. */
const STENCILS = {
  engines: ['DRIVE', 'NO NAKED FLAME'],
  reactor: ['REACTOR', 'KEEP CLEAR · RADIATION'],
  life_support: ['AIR PLANT', 'DO NOT OBSTRUCT INTAKES'],
  medbay: ['FIRST AID', 'REPORT ALL INJURIES'],
  quarters: ['BERTHS', 'LIGHTS OUT 22:00'],
  ai_core: ['M.A.R.G.O.', 'AUTHORISED STAFF ONLY'],
  sensors: ['SENSORS', 'DO NOT TOUCH THE DISH'],
  helm: ['BRIDGE', 'COMPANY PROPERTY'],
  cargo: ['CARGO 1', 'MAX LOAD 40 T'],
  hold: ['MAIN HOLD', 'STACK NO HIGHER THAN 3'],
  brig: ['DETENTION', 'ONE PER CELL'],
  doors: ['DOOR CONTROL', 'DO NOT JAM'],
  shields: ['SHIELDING', 'HIGH VOLTAGE'],
  weapons: ['DEFENCE', 'SAFETY ON WHEN DOCKED'],
};
/** How each kind of crate in the hold looks (hold.js, S2.8): colour, size in tiles, and the word stencilled on it. */
const CRATE_LOOK = {
  ammo: { colour: '#3e4a32', w: 1.0, h: 0.7, mark: 'ORDNANCE', stripe: '#c9a63a' },
  cargo: { colour: '#4a3f2c', w: 1.2, h: 0.9, mark: 'MANIFEST', stripe: null },
  salvage: { colour: '#3a424c', w: 1.15, h: 0.8, mark: 'SALVAGE', stripe: null },
};
/** A crate's place along a room's floor, and how many may stand on each other there. */
const CRATE_STEP = 1.45;
const CRATE_STACK = 3;
const AIRLOCK_THICKNESS = 0.42;

/** Crew are drawn as bodies (crew-art.js, D-132); their tap target is the body, never smaller than this in CSS pixels. */
const TAP_MIN = 44;
const CREW_COLOURS = ['#5ec8ff', '#ffd166', '#ef7bbf', '#8be28b', '#c9a0ff', '#ff9f5e', '#7fe3d0', '#e6e6e6'];

/** A renderer for `layout`. `sensor` draws it as a sensor return (the enemy). */
export function createShipRenderer(layout, { sensor = false } = {}) {
  let cache = null; // { canvas, key }
  let liftCar = null; // where the lift car was last drawn, in tiles: the top of the car
  let staticFrames = null; // a few tiles of screen static, made once
  /** Screen static, as a canvas pattern: a few frames to flick between. Seeded, like everything else. */
  const staticPattern = (ctx, time, still) => {
    if (!staticFrames) {
      const rng = createRng(`static:${layout.id}`);
      staticFrames = Array.from({ length: 4 }, () => {
        const tile = document.createElement('canvas');
        tile.width = 64;
        tile.height = 64;
        const t = tile.getContext('2d');
        for (let y = 0; y < 64; y += 2) {
          for (let x = 0; x < 64; x += 2) {
            const v = rng.next();
            // Our own schematic keeps its rooms readable under the snow; an unresolved return is mostly snow.
            const floor = sensor ? 0.45 : 0.72;
            if (v < floor) continue;
            t.fillStyle = sensor ? `rgba(127, 227, 154, ${(v - floor) * 0.9})` : `rgba(233, 220, 195, ${(v - floor) * 2.4})`;
            t.fillRect(x, y, 2, 2);
          }
        }
        return tile;
      });
    }
    return ctx.createPattern(staticFrames[still ? 0 : Math.floor(time * 10) % staticFrames.length], 'repeat');
  };
  const clock = (ticks) => {
    const s = Math.floor(ticks / 20);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  };
  /** The deck lifts (D-093): one under every hatch in a floor, from the hatch down to the floor of the room below. */
  const deckLifts = layout.doors
    .filter((door) => !door.vertical && !door.airlock)
    .map((door) => {
      const rooms = [door.a, door.b].map((id) => layout.room(id)).filter(Boolean);
      const below = rooms.find((r) => Math.abs(r.y - door.y) < 1e-6);
      const above = rooms.find((r) => Math.abs(r.y + r.h - door.y) < 1e-6);
      return below ? { door: door.id, x: door.x, top: door.y, floor: below.y + below.h - FLOOR, below: below.id, above: above?.id ?? null } : null;
    })
    .filter(Boolean);
  const liftPads = new Map(); // where each deck lift's platform was last drawn, in tiles
  /** Places along each room's floor where a crate can stand, clear of deck lifts, doorways and hatches: x offsets in tiles. */
  const crateSpots = new Map(
    layout.rooms.map((room) => {
      // What must stay clear on this floor: deck lifts (any hatch above or below), doorways at floor level, and the spot under a crawlway hatch.
      const floor = room.y + room.h;
      const avoid = [];
      for (const door of layout.doors) if ((door.a === room.id || door.b === room.id) && (!door.vertical || Math.abs(door.y - floor) < 1)) avoid.push(door.x);
      for (const way of layout.crawlways ?? []) if (way.hatches?.[room.id]) avoid.push(way.hatches[room.id].x);
      const spots = [];
      for (let x = 0.3; x + 1.3 < room.w - 0.2; ) {
        const left = room.x + x;
        const blocked = avoid.find((ax) => ax > left - 0.45 && ax < left + 1.3 + 0.45);
        if (blocked === undefined) {
          spots.push(x);
          x += CRATE_STEP;
        } else x = Math.max(x + 0.1, blocked + 0.45 - room.x); // step past whatever is in the way
      }
      return [room.id, spots.length ? spots : [Math.max(0.2, room.w / 2 - 0.6)]];
    }),
  );
  /**
   * Where every crate sitting in a room is drawn, in tiles: { id, crate, x, y, w, h }.
   * Each room fills its spots along the floor first, then stacks, as the stencil says, no higher than three.
   */
  function crateBoxes(state) {
    const boxes = [];
    const counts = new Map();
    for (const crate of Object.values(state.crates ?? {})) {
      if (crate.room === null) continue;
      const room = layout.room(crate.room);
      const spots = crateSpots.get(room.id);
      const n = counts.get(room.id) ?? 0;
      counts.set(room.id, n + 1);
      const look = CRATE_LOOK[crate.kind];
      const level = Math.min(CRATE_STACK - 1, Math.floor(n / spots.length));
      const spot = spots[n % spots.length] + (n >= spots.length * CRATE_STACK ? 0.25 : 0);
      const x = room.x + spot + (1.3 - look.w) / 2;
      const y = room.y + room.h - FLOOR - look.h - level * 0.9;
      boxes.push({ id: crate.id, crate, x, y, w: look.w, h: look.h });
    }
    return boxes;
  }
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
          pipes: Array.from({ length: 1 + rng.int(2) }, () => ({ colour: ['#3f4854', '#4d4436', '#3a4a44'][rng.int(3)], width: rng.range(0.07, 0.12) })),
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
    const extra = sensor ? 0 : 1.6; // room for engine nozzles: on the left, on the right of a ship facing left, or underneath one whose bow points up
    const up = layout.facing === 'up';
    const w = bounds.w + (up ? 0 : extra);
    const h = bounds.h + (up ? extra : 0);
    const scale = Math.min(area.w / w, area.h / h);
    const lead = up || layout.facing === 'left' ? 0 : extra;
    return {
      scale,
      ox: area.x + (area.w - w * scale) / 2 + (lead - bounds.x) * scale,
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

  /** A crew member's body, in CSS pixels: head to feet, at least a fingertip wide. */
  function bodyBox(view, member, alpha = 1) {
    const s = view.scale;
    const at = crewAt(member, alpha);
    const cx = view.ox + at.x * s;
    const feet = view.oy + (at.y + STAND) * s;
    if (!member.alive) {
      const w = Math.max(TAP_MIN, BODY.height * s);
      return { x: cx - w / 2, y: feet - Math.max(TAP_MIN * 0.6, 0.5 * s), w, h: Math.max(TAP_MIN * 0.6, 0.5 * s) };
    }
    const w = Math.max(TAP_MIN * 0.75, BODY.width * 1.3 * s);
    const h = Math.max(TAP_MIN, BODY.height * s);
    return { x: cx - w / 2, y: feet - h, w, h };
  }

  /** Everything tappable, in CSS pixels. Crew sit above doors, doors above rooms. */
  function targets(view, crew = {}, { foe = false, crates = null } = {}) {
    const out = [];
    for (const member of Object.values(crew)) {
      // The whole body is the target, never narrower than a fingertip (brief §4).
      const box = bodyBox(view, member);
      out.push({ id: member.id, kind: 'crew', ...box, cx: box.x + box.w / 2, cy: box.y + box.h / 2, priority: 3 });
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
    // Crates sit on the floor clear of deck lifts and doorways, so they never hide a door; crew still win.
    if (crates) {
      for (const box of crateBoxes({ crates })) out.push({ id: box.id, kind: 'crate', x: view.ox + box.x * view.scale, y: view.oy + box.y * view.scale, w: box.w * view.scale, h: box.h * view.scale, priority: 2 });
    }
    for (const door of layout.doors) {
      // A little fatter than drawn, so a fingertip can find it.
      const fat = 0.5;
      const r = door.vertical ? { x: door.x - fat / 2, y: door.y - 0.5, w: fat, h: 1 } : { x: door.x - 0.5, y: door.y - fat / 2, w: 1, h: fat };
      // A hatch in the deck is often underfoot: it beats the legs of whoever stands on it, and their body above stays theirs (D-132).
      out.push({ id: door.id, kind: 'door', x: view.ox + r.x * view.scale, y: view.oy + r.y * view.scale, w: r.w * view.scale, h: r.h * view.scale, priority: door.vertical ? 2 : 4 });
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
    const engines = sensor ? null : layout.roomOfSystem('engines');
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
      // Facing right, the nozzles stick out of the left end; facing left, out of the right.
      const dir = layout.facing === 'left' ? -1 : 1;
      const edge = dir > 0 ? bounds.x : bounds.x + bounds.w;
      const pairs = engines.h >= 6 ? [engines.y + 1.5, engines.y + engines.h - 1.5] : [engines.y + engines.h / 2];
      for (const cy of pairs) {
        const glow = ctx.createLinearGradient(edge - dir * 1.5, 0, edge, 0);
        glow.addColorStop(0, 'rgba(255, 138, 43, 0)');
        glow.addColorStop(1, sensor ? 'rgba(127, 227, 154, 0.35)' : 'rgba(255, 138, 43, 0.5)');
        ctx.fillStyle = glow;
        ctx.fillRect(Math.min(edge, edge - dir * 1.5), cy - 0.6, 1.5, 1.2);
        ctx.fillStyle = sensor ? '#06100a' : '#10141a';
        ctx.strokeStyle = sensor ? C.phosphor : C.hullEdge;
        ctx.lineWidth = 2 * px;
        ctx.beginPath();
        ctx.moveTo(edge + dir * 0.1, cy - 0.75);
        ctx.lineTo(edge - dir * 0.8, cy - 0.95);
        ctx.lineTo(edge - dir * 0.8, cy + 0.95);
        ctx.lineTo(edge + dir * 0.1, cy + 0.75);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
      }
    }

    if (sensor) {
      hullPath(ctx);
      ctx.fillStyle = 'rgba(4, 16, 9, 0.9)';
      ctx.fill();
      ctx.strokeStyle = C.phosphor;
      ctx.lineWidth = 2 * px;
      ctx.setLineDash([0.4, 0.25]);
      ctx.stroke();
      ctx.setLineDash([]);
    } else {
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
    }

    if (sensor) {
      // Only the outline of the return is fixed: its rooms are drawn live, as the scan makes them out.
      ctx.restore();
      return;
    }

    // Rooms, seen side-on: the back wall, pipes under the ceiling, a deck plate underfoot.
    for (const room of layout.rooms) {
      const art = roomArt.get(room.id);
      if (room.kind === 'lift') {
        drawShaft(ctx, room, px);
        continue;
      }
      ctx.fillStyle = room.kind === 'corridor' ? C.corridor : room.kind === 'helm' ? C.helm : room.kind === 'hold' || room.kind === 'cargo' ? C.hold : C.floor;
      ctx.fillRect(room.x, room.y, room.w, room.h);

      // Wall panels, and some grime.
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.22)';
      ctx.lineWidth = px;
      ctx.beginPath();
      for (let x = 1.5; x < room.w - 0.2; x += 1.5) {
        ctx.moveTo(room.x + x, room.y + 0.45);
        ctx.lineTo(room.x + x, room.y + room.h - FLOOR);
      }
      ctx.stroke();
      for (const scuff of art.scuffs) {
        ctx.fillStyle = `rgba(0, 0, 0, ${scuff.a})`;
        ctx.fillRect(room.x + scuff.x * room.w * (1 - scuff.w), room.y + 0.5 + scuff.y * (room.h - 1) * (1 - scuff.h), scuff.w * room.w, scuff.h * room.h);
      }

      // Pipes and cable trays under the ceiling.
      for (const [i, pipe] of art.pipes.entries()) {
        const py = room.y + 0.14 + i * 0.16;
        ctx.strokeStyle = pipe.colour;
        ctx.lineWidth = pipe.width;
        ctx.beginPath();
        ctx.moveTo(room.x, py);
        ctx.lineTo(room.x + room.w, py);
        ctx.stroke();
      }
      ctx.fillStyle = 'rgba(0, 0, 0, 0.45)';
      for (let x = 0.7; x < room.w; x += 1.6) ctx.fillRect(room.x + x, room.y + 0.06, 0.06, 0.42);


      // The old owners' stencils, faded into the paint.
      const stencil = STENCILS[room.id] ?? (room.system && STENCILS[room.system]) ?? null;
      if (stencil) {
        const [big, small] = stencil;
        const size = Math.min(room.h * 0.2, (room.w * 0.8) / (big.length * 0.64));
        const cx = room.x + room.w / 2;
        const cy = room.y + room.h * 0.45;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(255, 179, 71, 0.16)';
        ctx.font = `700 ${size}px ${MONO}`;
        ctx.fillText(big, cx, cy);
        if (small) {
          ctx.fillStyle = 'rgba(233, 220, 195, 0.13)';
          ctx.font = `700 ${Math.min(0.24, size * 0.42)}px ${MONO}`;
          ctx.fillText(small, cx, cy + size * 0.75);
        }
        // Hazard chevrons under the big ones.
        if (room.system) {
          ctx.fillStyle = 'rgba(255, 179, 71, 0.08)';
          for (let k = -2; k < 2; k++) ctx.fillRect(cx + k * 0.5 + 0.1, room.y + room.h - FLOOR - 0.22, 0.3, 0.12);
        }
      }

      // The deck plate.
      ctx.fillStyle = C.deck;
      ctx.fillRect(room.x, room.y + room.h - FLOOR, room.w, FLOOR);
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)';
      ctx.lineWidth = px;
      ctx.beginPath();
      for (let x = 0.25; x < room.w; x += 0.25) {
        ctx.moveTo(room.x + x, room.y + room.h - FLOOR);
        ctx.lineTo(room.x + x, room.y + room.h);
      }
      ctx.stroke();
    }

    // A deck lift under every hatch (D-093): a narrow shaft with guide rails down to a striped pad, and a hand crank.
    for (const lift of deckLifts) drawLiftRails(ctx, lift, px);

    // Service crawlway hatches, and the narrow ducts only the creature fits.
    for (const way of layout.crawlways ?? []) {
      for (const id of [way.a, way.b]) drawCrawlHatch(ctx, way.hatches[id], way.creature, px);
    }

    // Walls
    for (const room of layout.rooms) {
      ctx.strokeStyle = C.wall;
      ctx.lineWidth = 3.5 * px;
      ctx.strokeRect(room.x, room.y, room.w, room.h);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.045)';
      ctx.lineWidth = px;
      ctx.strokeRect(room.x + 3 * px, room.y + 3 * px, room.w - 6 * px, room.h - 6 * px);
    }
    ctx.restore();
    drawRoomNames(ctx, view, 'rgba(233, 220, 195, 0.62)');
  }

  /** Room names, in screen pixels so the text stays crisp. */
  function drawRoomNames(ctx, view, colour) {
    const s = view.scale;
    const fontPx = Math.max(9, Math.min(13, s * 0.36));
    ctx.font = `700 ${fontPx}px ${MONO}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = colour;
    for (const room of layout.rooms) {
      const text = room.name.toUpperCase();
      const maxWidth = room.w * s - 12;
      if (ctx.measureText(text).width > maxWidth && (room.kind === 'corridor' || room.kind === 'lift')) continue;
      ctx.fillText(text, view.ox + room.x * s + 7, view.oy + room.y * s + (sensor ? 5 : 0.5 * s), maxWidth);
    }
  }

  /**
   * A room on the sensor return (D-074). Until the scan resolves it, it is a
   * smear of static that thickens; then a phosphor outline with its name.
   * Returns true once it is resolved, so its hazards can be drawn over it.
   */
  function drawSensorRoom(ctx, view, room, known, time, still) {
    const s = view.scale;
    const x = view.ox + room.x * s;
    const y = view.oy + room.y * s;
    const w = room.w * s;
    const h = room.h * s;
    const resolve = known ? known.resolve : 1;
    if (resolve < 1) {
      ctx.save();
      ctx.globalAlpha = 0.25 + 0.6 * resolve;
      ctx.fillStyle = staticPattern(ctx, time, still);
      ctx.fillRect(x + 3, y + 3, w - 6, h - 6);
      ctx.restore();
      if (resolve > 0.4) {
        ctx.strokeStyle = `rgba(127, 227, 154, ${(resolve - 0.4) * 0.8})`;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 5]);
        ctx.strokeRect(x + 1.5, y + 1.5, w - 3, h - 3);
        ctx.setLineDash([]);
      }
      return false;
    }
    ctx.fillStyle = 'rgba(20, 60, 36, 0.55)';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = 'rgba(120, 230, 150, 0.16)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let gx = 1; gx < room.w; gx++) {
      ctx.moveTo(x + gx * s, y);
      ctx.lineTo(x + gx * s, y + h);
    }
    for (let gy = 1; gy < room.h; gy++) {
      ctx.moveTo(x, y + gy * s);
      ctx.lineTo(x + w, y + gy * s);
    }
    ctx.stroke();
    ctx.strokeStyle = C.phosphor;
    ctx.lineWidth = 2;
    ctx.strokeRect(x, y, w, h);
    ctx.font = `700 ${Math.max(9, Math.min(13, s * 0.36))}px ${MONO}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(150, 230, 170, 0.75)';
    ctx.fillText(room.name.toUpperCase(), x + 7, y + 5, w - 12);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
    return true;
  }

  /** Static over a room nobody can see into, and how long ago it was last seen. What is drawn under it is a memory. */
  function drawFog(ctx, view, room, age, time, still, label) {
    const s = view.scale;
    const x = view.ox + room.x * s;
    const y = view.oy + room.y * s;
    const w = room.w * s;
    const h = room.h * s;
    ctx.fillStyle = sensor ? 'rgba(2, 10, 6, 0.45)' : 'rgba(40, 46, 58, 0.22)';
    ctx.fillRect(x, y, w, h);
    ctx.save();
    ctx.globalAlpha = sensor ? 0.5 : 0.3;
    ctx.fillStyle = staticPattern(ctx, time, still);
    ctx.fillRect(x, y, w, h);
    ctx.restore();
    if (!sensor) {
      // The schematic still knows the room is there: its outline and name stay on top of the snow.
      ctx.strokeStyle = 'rgba(233, 220, 195, 0.3)';
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(x + 2.5, y + 2.5, w - 5, h - 5);
      ctx.setLineDash([]);
      const name = room.name.toUpperCase();
      ctx.font = `700 ${Math.max(9, Math.min(13, s * 0.36))}px ${MONO}`;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillStyle = 'rgba(233, 220, 195, 0.7)';
      if (ctx.measureText(name).width <= w - 12 || (room.kind !== 'corridor' && room.kind !== 'lift')) ctx.fillText(name, x + 7, y + 0.5 * s, w - 12);
    }
    if (w < 64) return; // a lift shaft has no room for words
    const text = `${label} ${clock(age)}`;
    ctx.font = `700 ${Math.max(9, Math.min(11, s * 0.3))}px ${MONO}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    const tw = Math.min(w - 8, ctx.measureText(text).width + 8);
    ctx.fillStyle = 'rgba(5, 7, 11, 0.85)';
    ctx.fillRect(x + 4, y + h - 19, tw, 15);
    ctx.fillStyle = sensor ? C.phosphor : C.paper;
    ctx.fillText(text, x + 8, y + h - 5, w - 16);
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
  }

  function drawShaft(ctx, room, px) {
    ctx.fillStyle = '#12161c';
    ctx.fillRect(room.x, room.y, room.w, room.h);
    ctx.strokeStyle = '#3d4552';
    ctx.lineWidth = 3 * px;
    ctx.beginPath();
    for (const x of [room.x + 0.18, room.x + room.w - 0.18]) {
      ctx.moveTo(x, room.y);
      ctx.lineTo(x, room.y + room.h);
    }
    ctx.stroke();
    // A landing sill at every deck the shaft passes.
    ctx.fillStyle = C.deck;
    for (const deck of layout.decks ?? []) {
      const bottom = deck.y + deck.h;
      if (bottom > room.y + 1e-6 && bottom <= room.y + room.h + 1e-6) ctx.fillRect(room.x, bottom - FLOOR / 2, 0.35, FLOOR / 2);
    }
    ctx.fillStyle = 'rgba(255, 179, 71, 0.14)';
    ctx.font = `700 0.34px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.save();
    ctx.translate(room.x + room.w / 2, room.y + room.h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText('LIFT · MIND THE GAP', 0, 0);
    ctx.restore();
  }

  /** A deck lift's fixed parts, in tiles: two guide rails from the hatch to the floor, a striped pad, and the crank housing. */
  function drawLiftRails(ctx, lift, px) {
    const { x, top, floor } = lift;
    // The shaft itself, darker than the wall behind it.
    ctx.fillStyle = 'rgba(10, 13, 17, 0.72)';
    ctx.fillRect(x - LIFT_HALF, top, LIFT_HALF * 2, floor - top);
    ctx.strokeStyle = C.rail;
    ctx.lineWidth = 3 * px;
    ctx.beginPath();
    for (const rx of [x - LIFT_HALF, x + LIFT_HALF]) {
      ctx.moveTo(rx, top);
      ctx.lineTo(rx, floor);
    }
    ctx.stroke();
    // Bolts up the rails.
    ctx.fillStyle = '#5a636f';
    for (let y = top + 0.4; y < floor - 0.2; y += 0.7) {
      ctx.fillRect(x - LIFT_HALF - 0.04, y, 0.08, 0.08);
      ctx.fillRect(x + LIFT_HALF - 0.04, y, 0.08, 0.08);
    }
    // The pad on the floor, in hazard stripes.
    ctx.save();
    ctx.beginPath();
    ctx.rect(x - LIFT_HALF, floor - 0.08, LIFT_HALF * 2, 0.08);
    ctx.clip();
    ctx.fillStyle = '#1b1d20';
    ctx.fillRect(x - LIFT_HALF, floor - 0.08, LIFT_HALF * 2, 0.08);
    ctx.fillStyle = C.hazard;
    for (let sx = x - LIFT_HALF - 0.1; sx < x + LIFT_HALF; sx += 0.2) {
      ctx.beginPath();
      ctx.moveTo(sx, floor);
      ctx.lineTo(sx + 0.1, floor);
      ctx.lineTo(sx + 0.18, floor - 0.08);
      ctx.lineTo(sx + 0.08, floor - 0.08);
      ctx.fill();
    }
    ctx.restore();
    // The crank housing, on the right-hand rail about waist height.
    ctx.fillStyle = '#2a3038';
    ctx.strokeStyle = C.rail;
    ctx.lineWidth = 1.5 * px;
    const cy = floor - 0.75;
    ctx.fillRect(x + LIFT_HALF, cy - 0.12, 0.12, 0.24);
    ctx.strokeRect(x + LIFT_HALF, cy - 0.12, 0.12, 0.24);
  }



  function drawCrawlHatch(ctx, at, creatureOnly, px) {
    if (creatureOnly) {
      // A duct grille: round, small, nothing written on it.
      ctx.fillStyle = '#0b0e12';
      ctx.beginPath();
      ctx.arc(at.x, at.y, 0.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(160, 172, 188, 0.4)';
      ctx.lineWidth = px;
      ctx.stroke();
      return;
    }
    const w = 0.62;
    const h = 0.46;
    ctx.fillStyle = '#0d1116';
    ctx.fillRect(at.x - w / 2, at.y - h / 2, w, h);
    ctx.strokeStyle = 'rgba(155, 209, 90, 0.55)';
    ctx.lineWidth = 1.5 * px;
    ctx.strokeRect(at.x - w / 2, at.y - h / 2, w, h);
    ctx.beginPath();
    for (let i = 1; i < 5; i++) {
      ctx.moveTo(at.x - w / 2 + (i * w) / 5, at.y - h / 2 + 0.06);
      ctx.lineTo(at.x - w / 2 + (i * w) / 5, at.y + h / 2 - 0.06);
    }
    ctx.stroke();
  }

  /** One crate, in tile space: its kind's colour and stencil, a hazard stripe on ordnance, and the lid off once its seal is broken. */
  function drawCrate(ctx, crate, x, y, w, h, px, chosen) {
    const look = CRATE_LOOK[crate.kind];
    ctx.fillStyle = look.colour;
    ctx.fillRect(x, y, w, h);
    if (look.stripe) {
      ctx.fillStyle = look.stripe;
      ctx.fillRect(x, y + h * 0.12, w, h * 0.12);
    }
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
    ctx.lineWidth = 1.5 * px;
    ctx.strokeRect(x, y, w, h);
    ctx.beginPath();
    ctx.moveTo(x, y + h * 0.3);
    ctx.lineTo(x + w, y + h);
    ctx.moveTo(x + w, y + h * 0.3);
    ctx.lineTo(x, y + h);
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.22)';
    ctx.stroke();
    if (!crate.sealed && crate.kind !== 'ammo') {
      // The lid, prised up and left askew.
      ctx.strokeStyle = 'rgba(233, 220, 195, 0.55)';
      ctx.lineWidth = 2 * px;
      ctx.beginPath();
      ctx.moveTo(x - 0.05, y - 0.02);
      ctx.lineTo(x + w * 0.9, y - 0.18);
      ctx.stroke();
    } else if (crate.sealed) {
      // The company seal: a red tag on the front.
      ctx.fillStyle = 'rgba(179, 55, 47, 0.85)';
      ctx.fillRect(x + w * 0.42, y + h * 0.55, w * 0.16, h * 0.18);
    }
    ctx.fillStyle = 'rgba(233, 220, 195, 0.32)';
    ctx.font = `700 ${h * 0.2}px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(look.mark, x + w / 2, y + h * 0.42, w * 0.92);
    if (chosen) {
      ctx.strokeStyle = C.paper;
      ctx.lineWidth = 2.5 * px;
      ctx.strokeRect(x - 0.08, y - 0.08, w + 0.16, h + 0.16);
    }
  }

  /** Every crate aboard: on the floor where it sits, or in the arms of whoever carries it. */
  function drawCrates(ctx, view, state, alpha, chosen) {
    if (sensor || !state.crates) return;
    ctx.save();
    ctx.translate(view.ox, view.oy);
    ctx.scale(view.scale, view.scale);
    const px = 1 / view.scale;
    for (const box of crateBoxes(state)) drawCrate(ctx, box.crate, box.x, box.y, box.w, box.h, px, chosen === box.id);
    for (const crate of Object.values(state.crates)) {
      const member = crate.by ? state.crew[crate.by] : null;
      if (!member) continue;
      const at = crewAt(member, alpha);
      drawCrate(ctx, crate, at.x - 0.42, at.y + STAND - BODY.height - 0.5, 0.84, 0.58, px, chosen === crate.id); // held overhead
    }
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
    ctx.restore();
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

    // Lamp light: a warm pool, strongest in the middle. A sensor return shows no lamps.
    if (sensor) {
      // nothing: hazards only
    } else if (r.light > 0) {
      const pool = ctx.createRadialGradient(x + w / 2, y + h / 2, 0, x + w / 2, y + h / 2, Math.max(w, h) * 0.7);
      pool.addColorStop(0, `rgba(255, 190, 110, ${0.2 * r.light})`);
      pool.addColorStop(1, 'rgba(255, 150, 60, 0)');
      ctx.fillStyle = pool;
      ctx.fillRect(x, y, w, h);
    }
    // Darkness where the lamps are off.
    if (r.light < 1 && !sensor) {
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
    if (r.fire > 0 || r.breach > 0 || lowAir || r.vent) {
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
      // An emergency vent open to space (H.2): a square badge.
      if (r.vent) badge((cx, cy) => ctx.rect(cx - 9, cy - 9, 18, 18), 'V');
    }
  }

  /**
   * A broken system (D-118): a red tag under the room name saying how many bars
   * are out and what to do, and a progress bar while someone repairs it.
   */
  function drawSystemDamage(ctx, view, room, state) {
    const system = state.systems[room.system];
    if (!system || system.absent || system.lost || !system.damage || state.rooms[room.id]?.jettisoned) return;
    const s = view.scale;
    const fixing = !system.stripped && Object.values(state.crew).some((m) => m.alive && m.owner === 'player' && m.room === room.id && m.task === 'repair');
    // Stripped by a salvage crew (H.2): the parts are gone, and only a port can fit new ones.
    const text = system.stripped ? 'STRIPPED · NEEDS A PORT' : fixing ? `REPAIRING ${system.damage}/${system.level}` : `DAMAGED ${system.damage}/${system.level} · SEND CREW`;
    const size = Math.max(9, Math.min(12, s * 0.32));
    ctx.font = `700 ${size}px ${MONO}`;
    const maxW = room.w * s - 14;
    const w = Math.min(maxW, ctx.measureText(text).width + 12);
    const h = size + 8;
    const x = view.ox + room.x * s + 7;
    const y = view.oy + room.y * s + 0.5 * s + size + 2;
    ctx.fillStyle = 'rgba(20, 4, 4, 0.85)';
    ctx.fillRect(x, y, w, h);
    if (fixing) {
      ctx.fillStyle = 'rgba(255, 179, 71, 0.35)';
      ctx.fillRect(x, y, w * Math.min(1, system.repair ?? 0), h);
    }
    ctx.strokeStyle = fixing ? C.amber : C.alarm;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    ctx.fillStyle = fixing ? C.amber : C.alarm;
    ctx.textAlign = 'start';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + 6, y + h / 2 + 1, w - 12);
    ctx.textBaseline = 'alphabetic';
  }

  /**
   * Each deck lift's platform: under the feet of whoever is riding it, or parked
   * where it last stopped. With door control dark, the rider turns the crank.
   */
  function drawDeckLifts(ctx, view, state, alpha, time) {
    const s = view.scale;
    const powered = (state.systems.doors?.power ?? 0) > 0;
    const riders = Object.values(state.crew).filter((m) => m.alive);
    for (const lift of deckLifts) {
      let pad = liftPads.get(lift.door) ?? lift.floor;
      let rider = null;
      for (const m of riders) {
        if (m.room !== lift.below && m.room !== lift.above) continue;
        const at = crewAt(m, alpha);
        if (Math.abs(at.x - lift.x) > 0.2) continue;
        const feet = at.y + 0.5;
        if (feet < lift.top - 0.05 || feet > lift.floor + 0.3) continue;
        if (Math.abs(feet - lift.floor) < 0.12 && !(m.path?.length && Math.abs(m.path[0].y - m.y) > Math.abs(m.path[0].x - m.x))) continue; // just walking past the pad
        rider = m;
        pad = feet;
        break;
      }
      pad = Math.max(lift.top, Math.min(lift.floor, pad));
      liftPads.set(lift.door, pad);
      const x = view.ox + (lift.x - LIFT_HALF) * s;
      const w = LIFT_HALF * 2 * s;
      const y = view.oy + pad * s;
      // The platform, and the cage bars that come up round the rider's knees.
      ctx.fillStyle = powered ? '#6b7480' : '#4a5059';
      ctx.fillRect(x - 2, y - 3, w + 4, 4);
      ctx.strokeStyle = powered ? C.amberDim : '#3d4552';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(x, y - 3);
      ctx.lineTo(x, y - 0.45 * s);
      ctx.lineTo(x + w, y - 0.45 * s);
      ctx.lineTo(x + w, y - 3);
      ctx.stroke();
      // The call light on the rail: amber with power, dark without.
      const lampY = view.oy + (lift.floor - 0.75) * s;
      const lampX = x + w + 0.06 * s;
      if (powered) {
        ctx.fillStyle = rider ? C.amber : C.amberDim;
        ctx.beginPath();
        ctx.arc(lampX, lampY - 0.22 * s, Math.max(1.5, 0.05 * s), 0, Math.PI * 2);
        ctx.fill();
      } else {
        // The crank handle: it turns while someone winds the platform up or down.
        const turn = rider ? time * 6 : 0;
        const r = 0.14 * s;
        ctx.strokeStyle = C.paper;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(lampX, lampY);
        ctx.lineTo(lampX + Math.cos(turn) * r, lampY + Math.sin(turn) * r);
        ctx.stroke();
      }
    }
  }

  /** The lift car: with whoever is riding it, or parked where it last stopped. Lit while door control has power. */
  function drawLift(ctx, view, state, alpha) {
    const s = view.scale;
    for (const room of layout.rooms) {
      if (room.kind !== 'lift') continue;
      const deckH = (layout.decks ?? []).find((d) => Math.abs(d.y - room.y) < 1e-6)?.h ?? 3;
      const carH = deckH - 0.2;
      const rider = Object.values(state.crew).find((m) => m.room === room.id && m.alive);
      const bottom = room.y + room.h;
      let top = liftCar ?? bottom - carH;
      if (rider) top = crewAt(rider, alpha).y + 0.5 - carH;
      top = Math.max(room.y + 0.05, Math.min(bottom - carH, top));
      liftCar = top;
      const powered = (state.systems.doors?.power ?? 0) > 0;
      const x = view.ox + (room.x + 0.3) * s;
      const y = view.oy + top * s;
      const w = (room.w - 0.6) * s;
      const h = carH * s;
      ctx.fillStyle = powered ? 'rgba(255, 190, 110, 0.12)' : 'rgba(10, 12, 16, 0.6)';
      ctx.fillRect(x, y, w, h);
      ctx.strokeStyle = powered ? C.amberDim : '#3d4552';
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, w, h);
      // The cage: bars, and the cable it hangs from.
      ctx.beginPath();
      for (let i = 1; i < 4; i++) {
        ctx.moveTo(x + (w * i) / 4, y);
        ctx.lineTo(x + (w * i) / 4, y + h * 0.35);
      }
      ctx.moveTo(x + w / 2, view.oy + room.y * s);
      ctx.lineTo(x + w / 2, y);
      ctx.stroke();
      if (!powered) {
        ctx.fillStyle = C.alarm;
        ctx.font = `700 ${Math.max(9, Math.min(12, s * 0.3))}px ${MONO}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.save();
        ctx.translate(x + w / 2, y + h / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText('HAND CRANK', 0, 0);
        ctx.restore();
        ctx.textAlign = 'start';
        ctx.textBaseline = 'alphabetic';
      }
    }
  }

  /** The crawlways overlaid: a dashed run from hatch to hatch, labelled. */
  function drawCrawlways(ctx, view) {
    const s = view.scale;
    ctx.lineWidth = 2;
    ctx.setLineDash([5, 5]);
    for (const way of layout.crawlways ?? []) {
      const a = way.hatches[way.a];
      const b = way.hatches[way.b];
      ctx.strokeStyle = way.creature ? 'rgba(255, 65, 54, 0.75)' : C.vent;
      ctx.beginPath();
      ctx.moveTo(view.ox + a.x * s, view.oy + a.y * s);
      ctx.lineTo(view.ox + b.x * s, view.oy + b.y * s);
      ctx.stroke();
    }
    ctx.setLineDash([]);
    ctx.font = `700 ${Math.max(8, Math.min(11, s * 0.28))}px ${MONO}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    for (const way of layout.crawlways ?? []) {
      const at = way.hatches[way.a];
      ctx.fillStyle = way.creature ? 'rgba(255, 65, 54, 0.9)' : C.vent;
      ctx.fillText(way.creature ? 'DUCT' : 'SERVICE WAY', view.ox + at.x * s, view.oy + (at.y - 0.3) * s);
    }
    ctx.textAlign = 'start';
    ctx.textBaseline = 'alphabetic';
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

  /** Which way each crew member last faced, so they do not snap round when they stop. */
  const facings = new Map();

  /** The pose a crew member is drawn in, from what they are doing. */
  function poseOf(member) {
    if (!member.alive) return 'dead';
    if (member.task === 'crawling') return 'crawl';
    if (member.carry) return 'carry';
    if (member.task === 'fighting') return 'fight';
    if (member.task === 'walking' || member.task === 'crossing') return member.path?.length && !onLiftNow(member) ? 'walk' : 'stand';
    if (['extinguish', 'patch', 'repair', 'unjam', 'sabotage', 'loading', 'opening', 'lifting', 'cycling', 'stashing', 'forcing', 'searching', 'grabbing'].includes(member.task)) return 'work';
    return 'stand';
  }
  const onLiftNow = (member) => {
    const next = member.path?.[0];
    return Boolean(next && !next.crawl && Math.abs(next.y - member.y) > Math.abs(next.x - member.x));
  };

  function drawCrew(ctx, view, member, alpha, selected, time = 0) {
    const hostile = member.owner === 'enemy';
    const s = view.scale;
    const at = crewAt(member, alpha);
    const cx = view.ox + at.x * s;
    const cy = view.oy + at.y * s;
    const feet = cy + STAND * s;
    const colour = hostile ? C.alarm : CREW_COLOURS[member.index % CREW_COLOURS.length];
    const box = bodyBox(view, member, alpha);

    // Which way they face: the way they are going, or the way they last went.
    const dx = (member.path?.[0]?.x ?? member.x) - member.x;
    let facing = facings.get(member.id) ?? (hostile ? -1 : 1);
    if (Math.abs(dx) > 0.05) facing = dx > 0 ? 1 : -1;
    facings.set(member.id, facing);

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
      // A bracket of light round them, and a pool on the floor.
      ctx.fillStyle = 'rgba(233, 220, 195, 0.16)';
      ctx.beginPath();
      ctx.ellipse(cx, feet, box.w * 0.62, 0.12 * s, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = C.paper;
      ctx.lineWidth = 2;
      const b = 6;
      for (const [x, y, sx, sy] of [[box.x, box.y, 1, 1], [box.x + box.w, box.y, -1, 1], [box.x, box.y + box.h, 1, -1], [box.x + box.w, box.y + box.h, -1, -1]]) {
        ctx.beginPath();
        ctx.moveTo(x, y + sy * b);
        ctx.lineTo(x, y);
        ctx.lineTo(x + sx * b, y);
        ctx.stroke();
      }
    }

    // Walk cycle off the distance they have covered, so it freezes on pause and matches their pace.
    const phase = (((at.x + at.y) * 1.3) % 1 + 1) % 1;
    // Hiding (H.2): drawn faint, behind a locker door or up in the crawlway, so the captain still knows where.
    if (member.hidden) ctx.globalAlpha = 0.35;
    drawBody(ctx, {
      x: cx,
      feet,
      s,
      colour,
      skin: skinOf(member.index),
      role: member.role,
      facing,
      pose: poseOf(member),
      phase: member.task === 'fighting' || poseOf(member) === 'work' ? (time * 1.5) % 1 : phase,
      suit: member.suit,
      hostile,
      // Their roster number, or an initial for one of theirs, so nobody is told apart by colour alone (brief §17).
      label: hostile ? member.name.charAt(0).toUpperCase() : String(member.index + 1),
      dim: !member.alive,
    });
    if (member.hidden) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = C.paper;
      ctx.setLineDash([3, 3]);
      ctx.lineWidth = 1.5;
      ctx.strokeRect(box.x - 2, box.y - 2, box.w + 4, box.h + 4);
      ctx.setLineDash([]);
      ctx.fillStyle = C.paper;
      ctx.font = `700 ${Math.max(9, 0.28 * s)}px ${MONO}`;
      ctx.textAlign = 'center';
      ctx.fillText(member.hidden === 'crawlway' ? 'CRAWLWAY' : 'HIDING', cx, box.y - 4);
      ctx.textAlign = 'start';
    }

    if (!member.alive) {
      ctx.fillStyle = '#8b93a1';
      ctx.font = `700 ${Math.max(10, 0.4 * s)}px ui-monospace, Menlo, Consolas, monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('×', cx, feet - 0.45 * s);
      ctx.textAlign = 'start';
      ctx.textBaseline = 'alphabetic';
    }

    // Health, once it is not full: a bar over their head.
    if (member.alive && member.health < 1) {
      const w = Math.max(18, 0.7 * s);
      const y = box.y - 7;
      ctx.fillStyle = '#05070b';
      ctx.fillRect(cx - w / 2 - 1, y, w + 2, 6);
      ctx.fillStyle = member.health < 0.35 ? C.alarm : '#8be28b';
      ctx.fillRect(cx - w / 2, y + 1, w * member.health, 4);
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
  /**
   * The shield (D-075): a faint glow on the hull as the capacitor charges, and
   * a bright field hugging it while a brace is up, thicker the more it holds.
   */
  function drawShield(ctx, view, shield, time, reduceFlicker) {
    const charge = Math.min(2, shield.charge);
    const field = Math.min(3, shield.field ?? 0);
    if (charge <= 0.02 && field <= 0) return;
    ctx.save();
    ctx.translate(view.ox, view.oy);
    ctx.scale(view.scale, view.scale);
    const px = 1 / view.scale;
    ctx.lineJoin = 'round';
    const shimmer = reduceFlicker ? 0 : 0.06 * Math.sin(time * (field > 0 ? 9 : 3));
    if (field > 0) {
      for (let i = Math.ceil(field); i >= 1; i--) {
        hullPath(ctx);
        ctx.lineWidth = (8 + i * 8) * 2 * px;
        ctx.strokeStyle = `rgba(127, 212, 255, ${0.2 + shimmer})`;
        ctx.stroke();
      }
      hullPath(ctx);
      ctx.lineWidth = 2.5 * px;
      ctx.strokeStyle = `rgba(210, 242, 255, ${0.9 + shimmer})`;
      ctx.stroke();
    } else {
      // Charging: a thin line on the hull, brighter as the capacitor fills. It stops nothing yet.
      hullPath(ctx);
      ctx.setLineDash([6 * px, 6 * px]);
      ctx.lineWidth = 2 * px;
      ctx.strokeStyle = `rgba(127, 212, 255, ${0.12 + 0.22 * Math.min(1, charge)})`;
      ctx.stroke();
      ctx.setLineDash([]);
    }
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
   * What is known, not what is so (senses.js):
   *   rooms      our own rooms as Margo knows them: { id: roomView }. A room with live: false is drawn from memory, behind static
   *   contact    for a sensor return: { id: contactView }. A room is static until its scan resolves it
   * Without them the ship is drawn exactly as it is.
   * Extra, for fights:
   *   clear      false to draw over what is already on the canvas (the second ship)
   *   charges    each weapon's charge, 0 to 1, by slot
   *   chosenWeapon  the slot picked for aiming, or null
   *   aimed      Map of room id -> [weapon slots of the other ship pointed at it]
   *   inviting   true while the other ship is choosing a room of this one to aim at
   * Crew are drawn by whose they are: the enemy's in alarm red with an initial,
   * wherever they stand. Anyone in the docking tube is drawn faded.
   */
  function draw(ctx, { view, width, height, dpr, state, time, alpha = 1, selected, selectedCrew = null, selectedCrate = null, showCrawlways = false, reduceFlicker = false, clear = true, charges = [], chosenWeapon = null, aimed = null, inviting = false, rooms = null, contact = null }) {
    if (clear) ctx.clearRect(0, 0, width, height);
    ctx.drawImage(staticLayer(view, width, height, dpr), 0, 0, width, height);
    const s = view.scale;

    /** Rooms whose people cannot be seen: unresolved or stale on a sensor return, unwatched aboard our own ship. */
    const unseen = new Set();
    for (const room of layout.rooms) {
      const known = sensor ? (contact?.[room.id] ?? null) : (rooms?.[room.id] ?? null);
      if (sensor && !drawSensorRoom(ctx, view, room, known, time, reduceFlicker)) {
        unseen.add(room.id);
        continue;
      }
      drawRoomLive(ctx, view, room, known ?? state.rooms[room.id], time, reduceFlicker);
      if (known && !known.live) {
        unseen.add(room.id);
        drawFog(ctx, view, room, known.age, time, reduceFlicker, sensor ? 'LAST SCAN' : 'NO EYES');
      }
    }
    if (!sensor && state.systems) for (const room of layout.rooms) if (room.system) drawSystemDamage(ctx, view, room, state);
    drawLift(ctx, view, state, alpha);
    if (!sensor) drawDeckLifts(ctx, view, state, alpha, time);
    // A sensor return does not show their doors until the rooms either side are made out.
    for (const door of layout.doors) {
      if (sensor && contact && [door.a, door.b].some((id) => id !== 'space' && (contact[id]?.resolve ?? 1) < 1)) continue;
      drawDoor(ctx, view, door, state.doors[door.id], state.doors[door.id].openness);
    }

    if (showCrawlways) drawCrawlways(ctx, view);

    // The dead first, so the living are drawn over them. The other side's people only show where we can see.
    const crew = Object.values(state.crew).filter((member) => member.owner !== 'enemy' || !unseen.has(member.room));
    for (const member of crew) if (!member.alive) drawCrew(ctx, view, member, alpha, member.id === selectedCrew, time);
    drawCrates(ctx, view, state, alpha, selectedCrate);
    for (const member of crew) {
      if (!member.alive) continue;
      if (member.task === 'crossing') ctx.globalAlpha = 0.45;
      drawCrew(ctx, view, member, alpha, member.id === selectedCrew, time);
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
        if (sensor && contact && (contact[selected.id]?.resolve ?? 1) < 1) ctx.setLineDash([4, 5]);
        ctx.strokeRect(view.ox + room.x * s - 1, view.oy + room.y * s - 1, room.w * s + 2, room.h * s + 2);
      } else {
        const rect = doorRect(layout.door(selected.id));
        ctx.strokeRect(view.ox + rect.x * s - 5, view.oy + rect.y * s - 5, rect.w * s + 10, rect.h * s + 10);
      }
      ctx.setLineDash([]);
    }
  }

  return { fit, targets, draw, doorRect, roomCentre, hardpointAt, crateBoxes, crewColour: (index) => CREW_COLOURS[index % CREW_COLOURS.length] };
}
