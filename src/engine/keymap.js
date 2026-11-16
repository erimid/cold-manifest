// Keyboard shortcuts (brief §18), as data: physical key code -> action name.
// The input module turns key presses into { type: 'key', action } events.
// Later sessions add weapons and power shortcuts here.

export const KEYMAP = Object.freeze({
  Space: 'pause',
  Escape: 'back',
  Digit1: 'select-1',
  Digit2: 'select-2',
  Digit3: 'select-3',
  Digit4: 'select-4',
  Digit5: 'select-5',
  Digit6: 'select-6',
  Digit7: 'select-7',
  Digit8: 'select-8',
});
