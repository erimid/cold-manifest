// What a button does, for a long-press on it (H.10, D-257). A touch screen has no hover, so the `title` a mouse
// would show is out of reach on an iPad; a long-press on a control shows its live title (often why it cannot be
// pressed just now) and, under it, a line on what it is for. Pure: tested in test/help.test.js.

/** By control id, or by an id prefix ending in '-'. The longest match wins. */
export const HELP = Object.freeze({
  'btn-pause': 'Stops the clock. Orders can still be given while it is stopped. Space bar on a keyboard.',
  'btn-skip': 'Skips ahead fast to the next sighting, or to anything that needs an answer. N on a keyboard.',
  'btn-chart': 'The chart of the Reach: ports, lanes and the way Margo has plotted. M on a keyboard.',
  'btn-settings': 'Sound, motion, scanlines and the rest.',
  'btn-back': 'Back to the title. The run is kept.',
  'btn-watches-': 'How many watches the crew stand: all at once, or turn about so some can sleep.',
  'btn-muster': 'Everyone awake goes to their post at once.',
  'crew-': 'Tap to pick them, then tap a room to send them there. Tap again to let go.',
  'btn-held-': 'A station nobody is on, so Margo is running it. Tap to open its room.',
  'btn-stand-': 'Stand the station to or down. Down, it does nothing and gives nothing off.',
  'btn-cover-': 'Whether Margo runs this station when nobody is on it.',
  'btn-manner-': 'How hard the station is run: harder gets more done and gives off more heat and hum.',
  'btn-output-': 'How hard the reactor runs. Everything else works off it.',
  'btn-lift': 'The lift motor. Off, the lifts are cranked by hand: slower, but quiet.',
  'btn-lights': 'This room\'s lights. Dark rooms give off less for a scope to find, and are harder to work in.',
  'btn-deck-lights': 'Every light on this deck at once.',
  'btn-vent': 'Opens the room to space: it puts out a fire, and empties the room of air. Anyone in it without a suit starts to choke.',
  'btn-repair': 'Sends the nearest free hand to mend what is broken here.',
  'btn-jettison': 'Cuts the room loose. It does not come back.',
  'btn-door-open': 'Opens the door.',
  'btn-door-close': 'Closes the door: it holds back fire and keeps the air in.',
  'btn-door-lock': 'Locks the door: our crew do not pass it until it is unlocked, and a boarder has to cut through it.',
  'btn-dark': 'Every light out at once. A dark ship is harder to find. Without the air plant it gets cold.',
  'btn-burn': 'A hard burn on the drive: fast, loud and hot, and it costs fuel.',
  'btn-flare': 'A decoy: something hotter than us for a hunting ship to chase.',
  'btn-brace': 'Puts the shield up for a shot coming in.',
  'btn-fetch-rounds': 'Sends a hand to the hold for rounds for the gun.',
  'btn-hail-': 'Answer the ship with a story. Margo\'s guess at the odds is in the title.',
  'btn-gun': 'Lays the gun on this ship. It does not sink anything: it scares.',
  'btn-pay': 'Pay them to let us by.',
  'btn-toll-pay': 'Pay the toll and they let us through the lane.',
  'btn-board-bribe': 'Pay them to go. They might take it and come aboard anyway.',
  'btn-board-yield': 'Hand over what they came for.',
  'btn-board-admit': 'Open the lock and let them search.',
  'btn-board-fight': 'Fight them on our decks.',
  'btn-suit': 'A vacuum suit: they breathe in a room with no air and burn slower in a fire, but walk and work slower.',
  'btn-hide': 'Into a locker, or a crawlway for an engineer, until someone looks hard enough.',
  'btn-post-': 'The station this hand goes to on watch.',
  'btn-watch': 'Moves this hand to the next watch.',
  'btn-posts': 'Choose the station this hand goes to on watch.',
  'btn-crate-open': 'Opens the crate to see what is really in it.',
  'btn-crate-move': 'Have the crate carried: tap the room it goes to.',
  'btn-crate-load': 'Loads the gun from this crate.',
  'btn-crate-jettison': 'Throws the crate out of the lock.',
  'btn-crate-stash': 'Hides the crate in a compartment, out of an inspector\'s way.',
  'btn-override': 'Gives the order again, over what they said.',
  'btn-stand-down': 'Lets the order go.',
  'sit-send-': 'Sends this hand to the room to deal with it.',
  'sit-choice-': 'What we do about it. Whoever is there does it.',
  'sit-dismiss-': 'Puts the card away.',
  'sit-chip-': 'Opens or closes the card for what is happening in this room.',
});

/** The help line for a control's id, or null. */
export function helpFor(id) {
  if (!id) return null;
  if (Object.hasOwn(HELP, id)) return HELP[id];
  let best = null;
  for (const key of Object.keys(HELP)) if (key.endsWith('-') && id.startsWith(key) && (!best || key.length > best.length)) best = key;
  return best ? HELP[best] : null;
}

/**
 * What a long-press on a control says: its live title first (what it is set to, or why it cannot be pressed), then
 * what it is for. A greyed-out button with nothing to say says so.
 */
export function controlInfo({ id = '', title = '', label = '', disabled = false } = {}) {
  const parts = [];
  const name = label.replace(/\s+/g, ' ').trim();
  if (title) parts.push(title.trim());
  else if (disabled) parts.push(`${name || 'That'}: not now.`);
  const help = helpFor(id);
  if (help && help !== title) parts.push(help);
  if (!parts.length) parts.push(name || 'A control.');
  return parts.join(' ');
}
