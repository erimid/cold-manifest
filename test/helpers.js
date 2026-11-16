// Shared test setup: the real content, loaded the way the tools load it.

import { createContent } from '../src/engine/content.js';
import { newCrewMember } from '../src/sim/crew.js';
import { createSim } from '../src/sim/sim.js';
import { readContentFiles } from '../tools/lib/load-content.js';

export const content = createContent(readContentFiles());
export const SHIP = content.require('ships', 'margin-of-error');

/** What the crew remember and refuse and what Margo objects to (content/memories, refusals, risks). */
export const RULES = { memories: content.all('memories'), refusals: content.all('refusals'), risks: content.all('risks') };

/** The weapons, ships and rules the sim looks things up in. */
export const CATALOG = { weapons: content.all('weapons'), ships: content.all('ships'), rules: RULES };

/** The transit events. */
export const EVENTS = content.all('events');

/** The placeholder starting crew. */
export const CREW = content.all('crew').map(({ id, name, engineer, skills, traits }) => ({ id, name, engineer, skills, traits }));

/** A fresh sim on the starting ship with its three crew aboard. */
export const newCrewedSim = (seed = 'test') => createSim({ seed, ship: SHIP, crew: CREW, ...CATALOG });

/** The AI line library. */
export const LINES = content.all('ai-lines');

/** A crewed sim with the ship AI able to speak. */
export const newTalkingSim = (seed = 'test') => createSim({ seed, ship: SHIP, crew: CREW, lines: LINES, ...CATALOG });

/** Stand a new crew member in a room of a sim. */
export function putCrew(sim, id, room, extra = {}) {
  const member = Object.assign(newCrewMember(sim.layout, { id }, room, Object.keys(sim.state.crew).length), extra);
  sim.state.crew[id] = member;
  return member;
}

/** A fresh sim on the starting ship, with nobody aboard. */
export const newSim = (seed = 'test') => createSim({ seed, ship: SHIP, ...CATALOG });

/** A deep copy of the ship layout data, safe to break in tests. */
export const shipCopy = () => {
  const { _file, ...data } = SHIP;
  return structuredClone(data);
};
