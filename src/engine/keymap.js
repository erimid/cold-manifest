// Keyboard shortcuts (brief §18), as data: physical key code -> action name.
// The input module turns key presses into { type: 'key', action } events.
// Number keys pick crew (S1.6). The Q row no longer routes power: bars went with H.4 (D-153).
// A lays the gun on the contact selected on the scope, or holds fire (H.3). B braces the shields (S2.8). P shows the
// helm's card (H.9; it opened the switch panel before), and G calls everyone to their stations. O overrides an order Margo is holding,
// and Escape stands down from it (S2.10). M puts the route chart up or takes it
// down, and J jumps down the plotted course (S3.1).
// V lights the drive or cuts it, and X puts out a flare (H.1). N skips on to the next thing on a quiet crossing (F.3).

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
  KeyA: 'gun',
  KeyB: 'brace',
  KeyP: 'helm',
  KeyG: 'muster',
  KeyO: 'override',
  KeyM: 'chart',
  KeyJ: 'jump',
  KeyV: 'burn',
  KeyX: 'flare',
  KeyN: 'skip',
});
