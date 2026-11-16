// The one clock that drives the simulation (brief §7, DECISIONS D-002).
//
// The sim only ever changes inside sim.step(), and only this clock calls it,
// in whole fixed ticks. While paused the clock calls nothing, so nothing
// simulated can change: no movement, fire, oxygen, weapon charge, enemy or
// creature logic, stress, or AI line timers. Looking around, opening panels
// and giving orders all still work while paused; orders wait in the sim's
// command queue and start on the first tick after resume.
//
// Rendering runs at display rate and uses `alpha` (how far we are between
// the last tick and the next) to draw smooth movement. Pure and DOM-free.

export function createClock({ sim, tickSeconds, maxTicksPerFrame = 5 }) {
  let paused = false;
  let speed = 1;
  let accumulator = 0;
  const listeners = new Set();

  function setPaused(value, reason) {
    if (paused === value) return;
    paused = value;
    for (const fn of [...listeners]) fn({ paused, reason });
  }

  return {
    get paused() {
      return paused;
    },
    /** 0 to 1: how far real time has run past the last tick. Frozen while paused. */
    get alpha() {
      return accumulator / tickSeconds;
    },
    get speed() {
      return speed;
    },
    /** Debug fast-forward. 1 is normal speed. */
    set speed(value) {
      if (!(value > 0)) throw new RangeError(`clock speed must be above 0, got ${value}`);
      speed = value;
    },
    pause(reason = 'player') {
      setPaused(true, reason);
    },
    resume(reason = 'player') {
      setPaused(false, reason);
    },
    toggle(reason = 'player') {
      setPaused(!paused, reason);
    },
    /** Debug only: run exactly one tick while paused, to watch something happen a frame at a time. */
    stepOnce() {
      if (!paused) return 0;
      sim.step();
      return 1;
    },
    /** Called with { paused, reason } whenever pause changes. Returns a function that stops listening. */
    onChange(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    /**
     * Feed in real seconds since the last frame. Steps the sim in whole ticks
     * and returns how many it ran. A long stall (a background tab, a slow
     * frame) is capped: the game slows down rather than racing to catch up.
     */
    advance(realSeconds) {
      if (paused || !(realSeconds > 0)) return 0;
      accumulator += realSeconds * speed;
      const limit = Math.ceil(maxTicksPerFrame * Math.max(1, speed));
      let ran = 0;
      while (accumulator >= tickSeconds && ran < limit) {
        sim.step();
        accumulator -= tickSeconds;
        ran += 1;
        if (paused) break; // something in that tick asked for a pause (auto-pause)
      }
      if (accumulator >= tickSeconds) accumulator = 0;
      return ran;
    },
  };
}
