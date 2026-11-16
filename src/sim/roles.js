// Crew roles and what skills do (Eric, 2026-11-16, D-130 to D-132; pulled
// forward from S4.1). DOM-free.
//
// Every crew member has one role: the job they signed on for. A role names the
// skill they are best at and the room they call their post. Skills run 0 to 5;
// 0 (or missing) is an ordinary hand, and each level makes that kind of work
// SKILL_STEP faster. Untrained crew work exactly as they did before skills
// mattered, so a skill only ever helps.
//
//   piloting     the sensor fix at the helm (jumping out)
//   engineering  repairs, hull patches and freeing jammed doors; an engineer may use the crawlways
//   weapons      how fast the guns charge with a gunner in the weapons room
//   medicine     how fast a powered medbay heals everyone in it
//   combat       how hard they hit hand to hand
//   negotiation  the chance that talking works in a hail
//
// Skills improving with use, traits, and the rest of S4.1 stay in Stage 4.

export const ROLES = Object.freeze({
  pilot: { name: 'Pilot', skill: 'piloting', post: 'helm', blurb: 'Takes the sensor fix faster at the helm.' },
  engineer: { name: 'Engineer', skill: 'engineering', post: 'reactor', blurb: 'Repairs and patches faster, and fits through the crawlways.' },
  gunner: { name: 'Gunner', skill: 'weapons', post: 'weapons', blurb: 'Guns charge faster with them in the weapons room.' },
  medic: { name: 'Medic', skill: 'medicine', post: 'medbay', blurb: 'The medbay heals faster with them in it.' },
  security: { name: 'Security', skill: 'combat', post: 'brig', blurb: 'Hits harder hand to hand.' },
  quartermaster: { name: 'Quartermaster', skill: 'negotiation', post: 'hold', blurb: 'Talks better in a hail.' },
});
export const ROLE_IDS = Object.freeze(Object.keys(ROLES));

/** Each level of a skill makes its work this much faster. */
export const SKILL_STEP = 0.15;

/** How much faster someone does work that uses a skill they have at `level`. */
export const skillFactor = (level = 0) => 1 + SKILL_STEP * Math.max(0, Math.min(5, level || 0));

/** A crew member's level in a skill, 0 if they have none. */
export const skillOf = (member, skill) => member?.skills?.[skill] ?? 0;

/** The role of a crew member, or null. */
export const roleOf = (member) => (member?.role ? ROLES[member.role] ?? null : null);

/** Their skills, best first, as words: "Piloting 3, Negotiation 1". */
export function skillWords(member) {
  const entries = Object.entries(member?.skills ?? {}).filter(([, level]) => level > 0);
  entries.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return entries.map(([skill, level]) => `${skill.charAt(0).toUpperCase()}${skill.slice(1)} ${level}`).join(', ');
}

/**
 * The best level in `skill` among the ship's own crew standing in `roomId`, on
 * their feet and working: boarders and people in the docking tube do not count.
 */
export function bestSkillIn(ship, roomId, skill) {
  let best = 0;
  for (const member of Object.values(ship.state.crew)) {
    if (!member.alive || member.room !== roomId || member.path?.length) continue;
    if ((member.owner ?? 'player') !== (ship.side ?? 'player')) continue;
    best = Math.max(best, skillOf(member, skill));
  }
  return best;
}

/** The best level in `skill` among all of a side's living crew, wherever they are. */
export function bestSkillAboard(crewList, skill) {
  return crewList.reduce((best, member) => (member.alive ? Math.max(best, skillOf(member, skill)) : best), 0);
}
