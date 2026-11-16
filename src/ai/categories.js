// The ship AI's trigger categories and their targets. The brief (§9) asks for
// 3,280 lines across these; Eric capped the library at 500 to start
// (2026-11-16, DECISIONS D-100), so each target here is the brief's scaled
// by 500 / 3,280 and rounded so the column adds up to 500. BRIEF_AI_LINES
// keeps the old floor on file for when he lifts the cap.
// The content checker's coverage report is built from this list.

export const AI_CATEGORIES = Object.freeze([
  { id: 'greeting', label: 'Greeting / run start', target: 12 },
  { id: 'jump', label: 'Jump', target: 18 },
  { id: 'port_arrival', label: 'Port arrival', target: 23 },
  { id: 'trade', label: 'Trade', target: 18 },
  { id: 'combat_start', label: 'Combat start', target: 15 },
  { id: 'combat_progress', label: 'Combat progress', target: 30 },
  { id: 'combat_end', label: 'Combat end', target: 18 },
  { id: 'hazard', label: 'Hull damage / fire / breach', target: 23 },
  { id: 'crew_injury', label: 'Crew injury', target: 15 },
  { id: 'crew_death', label: 'Crew death', target: 18 },
  { id: 'crew_conflict', label: 'Crew conflict', target: 15 },
  { id: 'crew_bonding', label: 'Crew bonding', target: 12 },
  { id: 'order_confirm', label: 'Order confirmations', target: 30 },
  { id: 'argument', label: 'Arguments before risky orders', target: 23 },
  { id: 'refusal', label: 'Refusals', target: 9 },
  { id: 'override', label: 'Captain overrides', target: 9 },
  { id: 'cargo', label: 'Cargo comments', target: 30 },
  { id: 'threat', label: 'Creature sighting / threat', target: 40 },
  { id: 'sensor_uncertain', label: 'False / uncertain sensor reports', target: 12 },
  { id: 'idle', label: 'Idle ship-quiet', target: 40 },
  { id: 'past_run', label: 'Past-run memories', target: 23 },
  { id: 'glitch', label: 'Damaged AI glitch', target: 12 },
  { id: 'mutiny_warning', label: 'Mutiny warning signs', target: 9 },
  { id: 'traitor', label: 'Traitor suspicion', target: 8 },
  { id: 'contract', label: 'Contract-specific', target: 23 },
  { id: 'rare', label: 'Rare', target: 15 },
]);

/** Slots a line may use (brief §9, plus `room` from S2.10: the brief's own example names one). Filled at runtime. */
export const AI_SLOTS = Object.freeze(['crew_name', 'room', 'port', 'faction', 'cargo', 'past_crew_name', 'memory_event']);

/** Floors for the whole library (capped, D-100) and for other counted content (brief §14, §15). */
export const CONTENT_TARGETS = Object.freeze({ aiLines: 500, scenes: 120, events: 150 });
/** What the brief asked for before the cap. */
export const BRIEF_AI_LINES = 3000;
