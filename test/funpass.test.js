// Fun-pass tuning (F.8, D-246 to D-250): a party may come through the lock
// suited or not, rolled at the lock and shown there, and the Reach's lanes and
// deadlines are the tuned ones.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BOARD, validateParty } from '../src/sim/boarders.js';
import { TICK_RATE, checkInvariants, createSim } from '../src/sim/sim.js';
import { CATALOG, CREW, SHIP, content } from './helpers.js';

const ENCOUNTERS = content.all('encounters');
const boardSim = (seed) => createSim({ seed, ship: SHIP, crew: CREW, ...CATALOG, encounters: ENCOUNTERS });

test('a party can come suited by chance: rolled at the lock, and what comes aboard wears what was rolled', () => {
  const raider = ENCOUNTERS.find((def) => def.id === 'raider-skiff');
  assert.equal(typeof raider.party.suits, 'number', 'raiders come suited some of the time');
  const seen = { true: 0, false: 0 };
  for (let i = 0; i < 30; i++) {
    const sim = boardSim(`suits-${i}`);
    sim.enqueue({ type: 'debug.boarding', encounter: 'raider-skiff' });
    sim.step();
    const boarding = sim.state.boarding;
    assert.equal(typeof boarding.suited, 'boolean');
    seen[boarding.suited] += 1;
    if (i < 4) {
      sim.enqueue({ type: 'boarding.admit' });
      for (let t = 0; t < 15 * TICK_RATE && !Object.values(sim.state.crew).some((member) => member.party === boarding.id); t++) sim.step();
      const party = Object.values(sim.state.crew).filter((member) => member.party === boarding.id);
      assert.ok(party.length > 0, 'they came aboard');
      assert.ok(party.every((member) => member.suit === boarding.suited), 'they wear what was rolled');
      assert.deepEqual(checkInvariants(sim), []);
    }
  }
  assert.ok(seen.true > 0 && seen.false > 0, `suited ${seen.true}, not ${seen.false}`);
  // A party that always or never wears suits rolls nothing.
  const tender = boardSim('tender');
  tender.enqueue({ type: 'debug.boarding', encounter: 'bounty-tender' });
  tender.step();
  assert.equal(tender.state.boarding.suited, true);
  assert.ok(BOARD.demand > 0);
});

test('the checker takes suits as true, false or a chance, and nothing else', () => {
  const base = { size: 2, stay: 100, demand: 'Open up.' };
  for (const suits of [true, false, 0, 0.5, 1]) assert.ok(!validateParty({ ...base, suits }, 'cargo').some((p) => p.includes('suits')), `${suits}`);
  for (const suits of [2, -0.1, 'yes']) assert.ok(validateParty({ ...base, suits }, 'cargo').some((p) => p.includes('suits')), `${suits}`);
});

test('the Reach is tuned for a 3 to 4 minute crossing with room on the deadline', () => {
  const reach = content.require('sectors', 'the-reach');
  assert.deepEqual(reach.hours, { base: 1.75, column: 1.35, climb: 3.5, min: 2, max: 8 });
  assert.deepEqual(reach.slack, [0.5, 0.7]);
});
