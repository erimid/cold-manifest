// The ship AI's trigger categories and their launch targets (brief §9).
// The content checker's coverage report is built from this list.

export const AI_CATEGORIES = Object.freeze([
  { id: 'greeting', label: 'Greeting / run start', target: 80 },
  { id: 'jump', label: 'Jump', target: 120 },
  { id: 'port_arrival', label: 'Port arrival', target: 150 },
  { id: 'trade', label: 'Trade', target: 120 },
  { id: 'combat_start', label: 'Combat start', target: 100 },
  { id: 'combat_progress', label: 'Combat progress', target: 200 },
  { id: 'combat_end', label: 'Combat end', target: 120 },
  { id: 'hazard', label: 'Hull damage / fire / breach', target: 150 },
  { id: 'crew_injury', label: 'Crew injury', target: 100 },
  { id: 'crew_death', label: 'Crew death', target: 120 },
  { id: 'crew_conflict', label: 'Crew conflict', target: 100 },
  { id: 'crew_bonding', label: 'Crew bonding', target: 80 },
  { id: 'order_confirm', label: 'Order confirmations', target: 200 },
  { id: 'argument', label: 'Arguments before risky orders', target: 150 },
  { id: 'refusal', label: 'Refusals', target: 60 },
  { id: 'override', label: 'Captain overrides', target: 60 },
  { id: 'cargo', label: 'Cargo comments', target: 200 },
  { id: 'threat', label: 'Creature sighting / threat', target: 250 },
  { id: 'sensor_uncertain', label: 'False / uncertain sensor reports', target: 80 },
  { id: 'idle', label: 'Idle ship-quiet', target: 250 },
  { id: 'past_run', label: 'Past-run memories', target: 150 },
  { id: 'glitch', label: 'Damaged AI glitch', target: 80 },
  { id: 'mutiny_warning', label: 'Mutiny warning signs', target: 60 },
  { id: 'traitor', label: 'Traitor suspicion', target: 50 },
  { id: 'contract', label: 'Contract-specific', target: 150 },
  { id: 'rare', label: 'Rare', target: 100 },
]);

/** Slots a line may use (brief §9). Filled at runtime. */
export const AI_SLOTS = Object.freeze(['crew_name', 'port', 'faction', 'cargo', 'past_crew_name', 'memory_event']);

/** Launch floors for the whole library and for other counted content (brief §9, §14, §15). */
export const CONTENT_TARGETS = Object.freeze({ aiLines: 3000, scenes: 120, events: 150 });
