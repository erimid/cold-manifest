// The ship's systems (brief §6). Each lives in one room. Pure data.
// `code` is the stencil painted on the room's floor.

export const SYSTEMS = Object.freeze({
  reactor: { name: 'Reactor', code: 'RX', blurb: 'Makes power. Damage reduces output.' },
  engines: { name: 'Engines', code: 'ENG', blurb: 'Evasion in a fight, and needed to jump.' },
  shields: { name: 'Shields', code: 'SHD', blurb: 'Absorb incoming fire.' },
  weapons: { name: 'Weapons', code: 'WPN', blurb: 'Hardpoints. Each weapon needs power and charges over time.' },
  life_support: { name: 'Life support', code: 'O2', blurb: 'Keeps oxygen up across the ship.' },
  sensors: { name: 'Sensors', code: 'SNS', blurb: 'Shows enemy interiors, hazards, and what else is aboard.' },
  doors: { name: 'Door control', code: 'DR', blurb: 'Remote door control. Without power, doors are opened by hand.' },
  medbay: { name: 'Medbay', code: 'MED', blurb: 'Heals crew.' },
  cargo: { name: 'Cargo hold', code: 'CGO', blurb: 'Holds cargo, and contraband.' },
  ai_core: { name: 'AI core', code: 'AI', blurb: "M.A.R.G.O.'s body. Damage here degrades her." },
  quarters: { name: 'Crew quarters', code: 'QTR', blurb: 'Rest and morale. Where the crew talk.' },
  brig: { name: 'Brig', code: 'BRG', blurb: 'Holds prisoners, or anyone you no longer trust.' },
});

export const SYSTEM_IDS = Object.freeze(Object.keys(SYSTEMS));

/** Door states (brief §6). A jammed door cannot be operated until it is repaired. */
export const DOOR_STATES = Object.freeze(['open', 'closed', 'locked', 'jammed']);

/** The id used in door data for the outside of the ship. */
export const SPACE = 'space';
