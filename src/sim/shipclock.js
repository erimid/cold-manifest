// The ship clock (H.8, D-206): days, hours and watches, read off the tick.
//
// An hour on the ship clock is SHIP_HOUR seconds of ship time (sim time; 1
// game second at normal speed). A watch is WATCH_HOURS of them, so three
// watches make the ship's day and the change of the watch falls on the hour:
// 0800, 1600 and midnight. The clock starts at START_HOUR on day 1, which is
// when the first watch takes the deck. Everything that counts hours (lane
// lengths, the deadline, a situation's lapse, the follower's lead, the lanes'
// chances an hour) counts these.
//
// How fast these hours go by in real time is the tempo's business (tempo.js):
// faster when nothing is happening. Pure and DOM-free.

/** Seconds of ship time to an hour on the ship clock (10 in H.6 and H.7, DF-61). */
export const SHIP_HOUR = 30;
/** Hours in a watch: three of them make a day. */
export const WATCH_HOURS = 8;
/** The hour on the clock at tick 0, day 1: the first watch takes the deck. */
export const START_HOUR = 8;

const TICKS = 20;

/** Ship hours since the clock started at tick 0. */
export const hoursAt = (tick) => tick / TICKS / SHIP_HOUR;

/** The clock at `tick`: { day (from 1), hour (0 to 23), minute (0 to 59), hours (since day 1, 0000) }. */
export function shipTime(tick) {
  const minutes = Math.floor((START_HOUR + hoursAt(tick)) * 60 + 1e-6);
  return { day: Math.floor(minutes / 1440) + 1, hour: Math.floor(minutes / 60) % 24, minute: minutes % 60, hours: minutes / 60 };
}

/** "Day 2 1430", the way it reads on the ship's bar. */
export function clockText(tick) {
  const t = shipTime(tick);
  return `Day ${t.day} ${String(t.hour).padStart(2, '0')}${String(t.minute).padStart(2, '0')}`;
}

/** A number of ship hours in words: "40 min", "1 h", "3 h 20 min". */
export function hoursText(hours) {
  const minutes = Math.max(0, Math.round(hours * 60));
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}
