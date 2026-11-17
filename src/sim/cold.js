// The cold (F.2, D-220). DOM-free, and imports nothing, so crew, stations and the air can all read it.
//
// With the air plant stood down or dark the ship cools toward TEMP_COLD, a share COLD_RATE of the gap a second
// (it takes a minute or so to get cold), and warms back at WARM_RATE once it runs (atmosphere.js). A crew member
// in a room below COLD.below works, walks and keeps a station at down to COLD.pace: the colder, the slower.

export const TEMP_COLD = -15;
export const COLD_RATE = 0.012;
export const WARM_RATE = 0.05;
export const COLD = Object.freeze({ below: 8, numb: -5, pace: 0.75 });

/** How a room's cold slows someone in it: 1 when warm enough, down to COLD.pace at COLD.numb and below. */
export function chillOf(temperature) {
  if (!(temperature < COLD.below)) return 1;
  const depth = Math.min(1, (COLD.below - temperature) / (COLD.below - COLD.numb));
  return 1 - (1 - COLD.pace) * depth;
}

/** How the cold slows a crew member where they stand (1: not at all). */
export function chill(sim, member) {
  const r = member && sim.state.rooms?.[member.room];
  return r ? chillOf(r.temperature) : 1;
}
