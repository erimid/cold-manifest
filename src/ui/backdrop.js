// The space behind every screen: cold blue-black with a sparse, seeded
// starfield. Drawn once to the canvas and redrawn only on resize.

import { createRng } from '../engine/rng.js';

export function createBackdrop(canvas, seed) {
  const ctx = canvas.getContext('2d');

  function draw() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const sky = ctx.createLinearGradient(0, 0, w, h);
    sky.addColorStop(0, '#0d1420');
    sky.addColorStop(0.55, '#070b12');
    sky.addColorStop(1, '#04060a');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    // A far-off sodium glow, low on one side: the last lit port behind you.
    const glow = ctx.createRadialGradient(w * 0.16, h * 1.05, 0, w * 0.16, h * 1.05, Math.max(w, h) * 0.7);
    glow.addColorStop(0, 'rgba(255, 138, 43, 0.20)');
    glow.addColorStop(0.5, 'rgba(255, 138, 43, 0.05)');
    glow.addColorStop(1, 'rgba(255, 138, 43, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, w, h);

    // Same seed, same sky, at any size: positions are stored as fractions.
    const rng = createRng(`backdrop:${seed}`);
    const count = 260;
    for (let i = 0; i < count; i++) {
      const x = rng.next() * w;
      const y = rng.next() * h;
      const size = rng.next() < 0.06 ? rng.range(1.2, 1.9) : rng.range(0.4, 1.0);
      const warm = rng.next() < 0.18;
      ctx.globalAlpha = rng.range(0.25, 0.9);
      ctx.fillStyle = warm ? '#ffd9a8' : '#c9d8ee';
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  draw();
  window.addEventListener('resize', draw);
  return { draw };
}
