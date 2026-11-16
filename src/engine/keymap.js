// Keyboard shortcuts (brief §18), as data: physical key code -> action name.
// The input module turns key presses into { type: 'key', action } events.
// Number keys pick crew (S1.6). The Q row routes power: the key adds a bar to
// that slot of the power panel, Shift with the key takes one back.
// The A row picks a weapon to aim (S2.1). B braces the shields (S2.8). P opens
// or folds the breaker board (S2.9). O overrides an order Margo is holding,
// and Escape stands down from it (S2.10). M puts the route chart up or takes it
// down, and J jumps: down the plotted course, or out of a fight (S3.1).
// V lights the drive or cuts it, and X puts out a flare (H.1).

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
  KeyQ: 'power-1',
  KeyW: 'power-2',
  KeyE: 'power-3',
  KeyR: 'power-4',
  KeyT: 'power-5',
  KeyY: 'power-6',
  KeyU: 'power-7',
  KeyI: 'power-8',
  KeyA: 'weapon-1',
  KeyS: 'weapon-2',
  KeyD: 'weapon-3',
  KeyF: 'weapon-4',
  KeyB: 'brace',
  KeyP: 'breakers',
  KeyO: 'override',
  KeyM: 'chart',
  KeyJ: 'jump',
  KeyV: 'burn',
  KeyX: 'flare',
});
