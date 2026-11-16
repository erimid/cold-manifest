// Crew roles and skills (Eric, 2026-11-16, D-130 to D-132): six crew, one per
// role, each faster at the work their skill covers, and nobody slower for
// lacking one.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateContent } from '../src/engine/content-schema.js';
import { MEDBAY_HEAL, MELEE_SECONDS, REPAIR_RATE, newCrewMember, spotIn } from '../src/sim/crew.js';
import { ROLES, ROLE_IDS, SKILL_STEP, roleOf, skillFactor, skillWords } from '../src/sim/roles.js';
import { MARGO_RATING, crewRating, operatorOf } from '../src/sim/stations.js';
import { TICK_RATE } from '../src/sim/sim.js';
import { CREW, newCrewedSim } from './helpers.js';

const seconds = (sim, s) => {
  for (let i = 0; i < Math.round(s * TICK_RATE); i++) sim.step();
};
/** Stand a crew member in a room at once, at their own spot in it. */
function place(sim, id, room) {
  const member = sim.state.crew[id];
  const at = spotIn(sim.layout.room(room), member.index);
  Object.assign(member, { room, x: at.x, y: at.y, px: at.x, py: at.y, path: [], goal: null, task: 'idle' });
  return member;
}
const go = (sim, command) => {
  sim.enqueue(command);
  sim.step();
};

test('each level of a skill speeds its work; no skill is the old pace, never slower', () => {
  assert.equal(skillFactor(0), 1);
  assert.equal(skillFactor(undefined), 1);
  assert.ok(Math.abs(skillFactor(3) - (1 + 3 * SKILL_STEP)) < 1e-12);
  assert.equal(skillFactor(9), skillFactor(5), 'capped at 5');
});

test('the starting crew are six, one for each role, each best at their role\'s skill', () => {
  assert.equal(CREW.length, 6);
  assert.deepEqual(CREW.map((c) => c.role).sort(), [...ROLE_IDS].sort());
  for (const member of CREW) {
    const best = Math.max(...Object.values(member.skills));
    assert.equal(member.skills[ROLES[member.role].skill], best, `${member.name} excels at ${ROLES[member.role].skill}`);
  }
  const sim = newCrewedSim('roles');
  assert.equal(roleOf(sim.state.crew.dace).name, 'Engineer');
  assert.ok(sim.state.crew.dace.engineer, 'an engineer may use the crawlways');
  assert.equal(skillWords(sim.state.crew.ilse), 'Piloting 3, Negotiation 1');
});

test('an engineer repairs faster than anyone else', () => {
  const time = (who) => {
    const sim = newCrewedSim('repair');
    sim.state.systems.shields.damage = 1;
    place(sim, who, 'shields');
    let ticks = 0;
    for (; ticks < 120 * TICK_RATE && sim.state.systems.shields.damage > 0; ticks++) sim.step();
    assert.equal(sim.state.systems.shields.damage, 0);
    return ticks;
  };
  const dace = time('dace');
  const okoro = time('okoro');
  assert.ok(dace < okoro, `Dace ${dace} ticks, Okoro ${okoro}`);
  assert.ok(REPAIR_RATE > 0);
});

test('security hits harder hand to hand', () => {
  const blow = (who) => {
    const sim = newCrewedSim('melee-skill');
    const room = sim.state.crew[who].room;
    const raider = newCrewMember(sim.layout, { id: 'raider', name: 'raider' }, room, 7, 'enemy');
    sim.state.crew.raider = raider;
    seconds(sim, 2);
    return 1 - raider.health;
  };
  const halloran = blow('halloran'); // combat 3
  const ilse = blow('ilse'); // no combat
  assert.ok(Math.abs(halloran / ilse - skillFactor(3)) < 0.05, `${halloran} against ${ilse}`);
  assert.ok(ilse <= 2 / MELEE_SECONDS + 1e-9);
});

test('a medic on the medbay station heals everyone in it faster than Margo does', () => {
  const sim0 = newCrewedSim('medbay');
  const heal = (withMedic) => {
    const sim = newCrewedSim('medbay');
    go(sim, { type: 'station.stand', station: 'medbay', down: false });
    const patient = place(sim, 'dace', 'medbay');
    patient.health = 0.5;
    if (withMedic) {
      place(sim, 'okoro', 'medbay');
      assert.equal(operatorOf(sim, 'medbay')?.id, 'okoro');
    }
    seconds(sim, 4);
    return patient.health - 0.5;
  };
  const alone = heal(false);
  const tended = heal(true);
  assert.ok(alone > 0 && alone <= 4 * MEDBAY_HEAL * 2 + 1e-9);
  assert.ok(Math.abs(tended / alone - crewRating(sim0.state.crew.okoro, 'medicine') / MARGO_RATING) < 0.02, `${tended} against ${alone}`);
});

test('a gunner on the guns charges them faster than Margo does', () => {
  const charge = (keepGunner) => {
    const sim = newCrewedSim('guns');
    go(sim, { type: 'station.stand', station: 'weapons', down: false });
    if (!keepGunner) place(sim, 'pruitt', 'hold');
    seconds(sim, 3);
    return sim.state.weapons[1].charge; // the slug thrower: point defence fills in a moment either way
  };
  const manned = charge(true);
  const empty = charge(false);
  assert.ok(manned > empty * 1.3, `${manned} against ${empty}`);
});

test('the content check holds a role to its skill', () => {
  const file = (person) => ({ path: 'crew/test.json', type: 'crew', data: { items: [{ id: 'x', name: 'X', ...person }] } });
  const errors = (person) => validateContent([file(person)]).errors.join('\n');
  assert.equal(errors({ role: 'medic', skills: { medicine: 3 } }), '');
  assert.match(errors({ role: 'chef', skills: { medicine: 3 } }), /no role "chef"/);
  assert.match(errors({ role: 'medic', skills: { medicine: 1 } }), /needs medicine at 2/);
  assert.match(errors({ role: 'medic', skills: { medicine: 2, combat: 3 } }), /excel at the wrong thing/);
});
