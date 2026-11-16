// Shared test setup: the real content, loaded the way the tools load it.

import { createContent } from '../src/engine/content.js';
import { createSim } from '../src/sim/sim.js';
import { readContentFiles } from '../tools/lib/load-content.js';

export const content = createContent(readContentFiles());
export const SHIP = content.require('ships', 'margin-of-error');

/** A fresh sim on the starting ship. */
export const newSim = (seed = 'test') => createSim({ seed, ship: SHIP });

/** A deep copy of the ship layout data, safe to break in tests. */
export const shipCopy = () => {
  const { _file, ...data } = SHIP;
  return structuredClone(data);
};
