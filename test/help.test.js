import assert from 'node:assert/strict';
import test from 'node:test';
import { controlInfo, HELP, helpFor } from '../src/ui/help.js';

test('help: an exact id wins, then the longest prefix', () => {
  assert.equal(helpFor('btn-pause'), HELP['btn-pause']);
  assert.equal(helpFor('btn-cover-fill'), HELP['btn-cover-']);
  assert.equal(helpFor('sit-choice-3-leave'), HELP['sit-choice-']);
  assert.equal(helpFor('crew-ilse'), HELP['crew-']);
  assert.equal(helpFor('btn-nothing-like-it'), null);
  assert.equal(helpFor(''), null);
});

test('help: the live title comes first, then what the control is for', () => {
  const text = controlInfo({ id: 'btn-cover-hers', title: 'Handed to Margo.', label: 'Hers' });
  assert.ok(text.startsWith('Handed to Margo.'));
  assert.ok(text.includes(HELP['btn-cover-']));
});

test('help: a greyed-out button with no title says it cannot be pressed now', () => {
  assert.match(controlInfo({ id: 'btn-flare', label: 'Flare (0)', disabled: true }), /^Flare \(0\): not now\. A decoy/);
});

test('help: a control with nothing written about it still says its name', () => {
  assert.equal(controlInfo({ id: 'btn-x', label: '  Do  it ' }), 'Do it');
});

test('help: every ship-view control id the screen builds has a line', () => {
  for (const id of ['btn-pause', 'btn-skip', 'btn-chart', 'btn-settings', 'btn-back', 'btn-watches-2', 'btn-muster', 'btn-held-sensors', 'btn-stand-sensors', 'btn-manner-push', 'btn-output-hard', 'btn-lift', 'btn-lights', 'btn-deck-lights', 'btn-vent', 'btn-repair', 'btn-jettison', 'btn-door-open', 'btn-door-close', 'btn-door-lock', 'btn-dark', 'btn-burn', 'btn-flare', 'btn-brace', 'btn-fetch-rounds', 'btn-hail-freighter', 'btn-gun', 'btn-pay', 'btn-toll-pay', 'btn-board-bribe', 'btn-board-yield', 'btn-board-admit', 'btn-board-fight', 'btn-suit', 'btn-hide', 'btn-post-helm', 'btn-watch', 'btn-posts', 'btn-crate-open', 'btn-crate-move', 'btn-crate-load', 'btn-crate-jettison', 'btn-crate-stash', 'btn-override', 'btn-stand-down', 'sit-send-1', 'sit-dismiss-1', 'sit-chip-1']) {
    assert.ok(helpFor(id), id);
  }
});
