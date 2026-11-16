// Shared test setup: the real content, loaded the way the tools load it.

import { createContent } from '../src/engine/content.js';
import { newCrewMember } from '../src/sim/crew.js';
import { createSim } from '../src/sim/sim.js';
import { readContentFiles } from '../tools/lib/load-content.js';

export const content = createContent(readContentFiles());
export const SHIP = content.require('ships', 'margin-of-error');

/** The placeholder starting crew. */
export const CREW = content.all('crew').map(({ id, name }) => ({ id, name }));

/** A fresh sim on the starting ship with its three crew aboard. */
export const newCrewedSim = (seed = 'test') => createSim({ seed, ship: SHIP, crew: CREW });

/** The AI line library. */
export const LINES = content.all('ai-lines');

/** A crewed sim with the ship AI able to speak. */
export const newTalkingSim = (seed = 'test') => createSim({ seed, ship: SHIP, crew: CREW, lines: LINES });

/** Stand a new crew member in a room of a sim. */
export function putCrew(sim, id, room, extra = {}) {
  const member = Object.assign(newCrewMember(sim.layout, { id }, room, Object.keys(sim.state.crew).length), extra);
  sim.state.crew[id] = member;
  return member;
}

/** A fresh sim on the starting ship, with nobody aboard. */
export const newSim = (seed = 'test') => createSim({ seed, ship: SHIP });

/** A deep copy of the ship layout data, safe to break in tests. */
export const shipCopy = () => {
  const { _file, ...data } = SHIP;
  return structuredClone(data);
};
