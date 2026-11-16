// S2.3: enemies that fight back, and every way a fight can end (brief §7).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateContent } from '../src/engine/content-schema.js';
import { DEBUG_ACTIONS, FIX, HAIL_SECONDS, OFFER_SECONDS, OUTCOMES, STALEMATE_SECONDS, START_MONEY, enemyOf, fixOf, talkChance } from '../src/sim/combat.js';
import { TICK_RATE, checkInvariants } from '../src/sim/sim.js';
import { ARCHETYPES, validateTactics } from '../src/sim/tactics.js';
import { content, newCrewedSim, newTalkingSim } from './helpers.js';

const steps = (sim, n) => {
  for (let i = 0; i < n; i++) {
    sim.step();
    const problems = checkInvariants(sim);
    if (problems.length) throw new Error(`tick ${sim.state.tick}: ${problems.join('; ')}`);
  }
  return sim;
};
const seconds = (sim, s) => steps(sim, Math.round(s * TICK_RATE));
const SKIFF = 'salvager-skiff';
const DRONE = 'target-drone';
const SKIFF_DATA = content.require('ships', SKIFF);

function fight(enemy = SKIFF, seed = 'endings') {
  const sim = newCrewedSim(seed);
  sim.enqueue({ type: 'debug.fight', enemy });
  sim.step();
  return sim;
}
const go = (sim, command) => {
  sim.enqueue(command);
  sim.step();
};
function collect(sim, type) {
  const seen = [];
  sim.events.on(type, (event) => seen.push(event));
  return seen;
}
/** Feed our guns three bars, from sensors, doors and the AI core. */
function armUs(sim) {
  for (const system of ['sensors', 'doors', 'ai_core']) sim.enqueue({ type: 'power.add', system, delta: -1 });
  sim.step();
  for (let i = 0; i < 3; i++) sim.enqueue({ type: 'power.add', system: 'weapons', delta: 1 });
  sim.step();
}

test('the skiff is content: crewed, armed, and a raider that hails, surrenders and runs', () => {
  const enemy = enemyOf(fight());
  assert.equal(Object.keys(enemy.state.crew).length, 3);
  assert.deepEqual(enemy.state.weapons.map((w) => w.id), ['pulse-laser', 'slug-thrower']);
  assert.equal(enemy.layout.tactics.archetype, 'raider');
  assert.ok(ARCHETYPES.raider.power.length);
});

test('tactics are checked: a real archetype, no hail or surrender with nobody aboard, and they surrender before they run', () => {
  assert.deepEqual(validateTactics(SKIFF_DATA.tactics, { crewed: true }), []);
  assert.match(validateTactics({ archetype: 'pacifist' }, { crewed: true }).join(), /archetype must be one of/);
  assert.match(validateTactics({ archetype: 'drone', hail: SKIFF_DATA.tactics.hail }, { crewed: false }).join(), /only a ship with crew aboard can hail/);
  assert.match(validateTactics({ ...SKIFF_DATA.tactics, flee: { at: 0.9 } }, { crewed: true }).join(), /flee.at must be below/);
  assert.match(validateTactics({ ...SKIFF_DATA.tactics, surrender: { at: 0.4, offers: [{ kind: 'money', amount: [9, 1] }] } }, { crewed: true }).join(), /amount must be/);
  const { _file, ...data } = SKIFF_DATA;
  const { errors } = validateContent([
    { path: 'ships/x.json', data: { items: [{ ...data, crew: [] }] } },
    { path: 'weapons/x.json', data: { items: content.all('weapons') } },
  ]);
  assert.ok(errors.some((e) => /only a ship with crew aboard can hail/.test(e)), errors.join('\n'));
});

test('a hail: nobody fires while they talk, even with guns charged and aimed; then they lose patience', () => {
  const sim = fight();
  armUs(sim);
  const fired = collect(sim, 'weapon.fired');
  const engaged = collect(sim, 'fight.engaged');
  go(sim, { type: 'debug.combat', action: 'scan' });
  go(sim, { type: 'weapon.target', slot: 0, room: 'shields' });
  assert.equal(sim.state.fight.phase, 'hail');
  seconds(sim, HAIL_SECONDS - 3);
  assert.equal(fired.length, 0, 'held fire through the hail');
  seconds(sim, 3);
  assert.equal(sim.state.fight.phase, 'battle');
  assert.deepEqual(engaged.map((e) => e.by), ['them']);
  seconds(sim, 2);
  assert.ok(fired.length >= 1, 'the laser, long charged, fires once shooting starts');
});

test('the drone does not hail: shooting starts at once', () => {
  assert.equal(fight(DRONE).state.fight.phase, 'battle');
});

test('talking works about as often as it says, once only, and a failed talk starts the shooting', () => {
  let talked = 0;
  let failed = 0;
  for (let i = 0; i < 120; i++) {
    const sim = fight(SKIFF, `talk-${i}`);
    go(sim, { type: 'fight.talk' });
    if (sim.state.fight.over) {
      assert.equal(sim.state.fight.over.outcome, 'talked');
      talked += 1;
    } else {
      assert.equal(sim.state.fight.phase, 'battle');
      assert.match(sim.whyNot({ type: 'fight.talk' }), /shooting has already started/);
      failed += 1;
    }
  }
  const expected = talkChance(fight()) * 120;
  assert.ok(Math.abs(talked - expected) < 20, `${talked} of 120 talked down (expected about ${expected})`);
  assert.ok(failed > 0);
});

test('paying them off costs the price and ends it; it is refused with too little money', () => {
  const sim = fight();
  const price = SKIFF_DATA.tactics.hail.bribe;
  go(sim, { type: 'fight.bribe' });
  assert.equal(sim.state.fight.over.outcome, 'bribed');
  assert.equal(sim.state.money, START_MONEY - price);
  const poor = fight(SKIFF, 'poor');
  poor.state.money = price - 1;
  assert.match(poor.whyNot({ type: 'fight.bribe' }), new RegExp(`they want ${price}`));
});

test('open fire ends the hail at once', () => {
  const sim = fight();
  go(sim, { type: 'fight.engage' });
  assert.equal(sim.state.fight.phase, 'battle');
  assert.match(sim.whyNot({ type: 'fight.bribe' }), /already started/);
});

test('the enemy captain feeds its guns after a hit, aims by its archetype and fires both guns together', () => {
  const sim = fight();
  const enemy = enemyOf(sim);
  go(sim, { type: 'fight.engage' });
  const volleys = new Map();
  const targets = new Map();
  sim.events.on('weapon.fired', (e) => {
    if (e.side !== 'enemy') return;
    volleys.set(e.tick, (volleys.get(e.tick) ?? 0) + 1);
    targets.set(e.room, (targets.get(e.room) ?? 0) + 1);
  });
  // Break their shields; the bar goes elsewhere, and comes back once their crew mend it.
  enemy.state.systems.shields.damage = 1;
  seconds(sim, 1);
  assert.equal(enemy.state.systems.shields.power, 0);
  seconds(sim, 120);
  assert.ok([...volleys.values()].every((n) => n === 2), `every volley is both guns: ${[...volleys.values()]}`);
  assert.equal(enemy.state.systems.shields.damage, 0, 'their crew repaired it');
  assert.equal(enemy.state.systems.shields.power, 1, 'and the captain powered it again');
  const favourite = [...targets.entries()].sort((a, b) => b[1] - a[1])[0][0];
  assert.ok(['shields', 'weapons', 'engines'].includes(favourite), `a raider goes for what lets us fight or run, not ${favourite}`);
});

test('their crew fight fires aboard their own ship, through the same crew code', () => {
  const sim = fight();
  const enemy = enemyOf(sim);
  enemy.state.rooms.reactor.fire = 0.5;
  const out = collect(sim, 'enemy.fire.out');
  seconds(sim, 40);
  assert.equal(enemy.state.rooms.reactor.fire, 0);
  assert.ok(out.some((e) => e.by), 'one of them put it out');
  assert.ok(Object.values(enemy.state.crew).some((m) => m.room === 'bridge'), 'somebody stayed at the helm');
});

test('a beaten crew offers to surrender, holds fire while the offer stands, and pays up if we accept', () => {
  const sim = fight();
  go(sim, { type: 'fight.engage' });
  const enemy = enemyOf(sim);
  enemy.state.hull.points = Math.floor(enemy.state.hull.max * SKIFF_DATA.tactics.surrender.at);
  sim.step();
  const { offer } = sim.state.fight;
  assert.ok(offer, 'an offer');
  assert.ok(['money', 'cargo', 'info'].includes(offer.kind));
  const fired = collect(sim, 'weapon.fired');
  seconds(sim, 20);
  assert.equal(fired.filter((e) => e.side === 'enemy').length, 0, 'they hold fire');
  const before = { money: sim.state.money, cargo: sim.state.cargo.length, intel: sim.state.intel.length };
  go(sim, { type: 'fight.accept' });
  assert.equal(sim.state.fight.over.outcome, 'surrendered');
  const after = { money: sim.state.money, cargo: sim.state.cargo.length, intel: sim.state.intel.length };
  assert.notDeepEqual(after, before, 'we got something');
});

test('turned down, or left unanswered, they fight on and do not offer twice', () => {
  for (const how of ['refuse', 'wait']) {
    const sim = fight(SKIFF, `refuse-${how}`);
    go(sim, { type: 'fight.engage' });
    const enemy = enemyOf(sim);
    enemy.state.hull.points = 4;
    sim.step();
    assert.ok(sim.state.fight.offer);
    if (how === 'refuse') go(sim, { type: 'fight.refuse' });
    else seconds(sim, OFFER_SECONDS);
    assert.equal(sim.state.fight.offer, null);
    seconds(sim, 5);
    assert.equal(sim.state.fight.offer, null, 'no second offer');
    assert.match(sim.whyNot({ type: 'fight.accept' }), /nobody is offering/);
  }
});

test('badly hurt, they run: engines first, and they are gone when they have a fix; a hit sets it back', () => {
  const sim = fight();
  go(sim, { type: 'fight.engage' });
  const enemy = enemyOf(sim);
  enemy.state.hull.points = 2; // below where they would surrender, and where they run
  sim.step();
  const fleeing = collect(sim, 'fight.fleeing');
  go(sim, { type: 'fight.refuse' });
  seconds(sim, 1);
  assert.equal(sim.state.fight.fleeing, true);
  assert.equal(fleeing.length, 1);
  assert.equal(enemy.state.systems.engines.power, enemy.state.systems.engines.level, 'engines got their bars');
  seconds(sim, FIX.seconds / 2);
  const before = fixOf(enemy);
  assert.ok(before > 0.2 && before < 0.6, `partway to a fix, less what their own guns cost them: ${before}`);
  enemy.state.hull.points = enemy.state.hull.max; // so the hit does not end it
  go(sim, { type: 'debug.hit', at: 'them', room: 'reactor', weapon: 'pulse-laser', force: true });
  assert.ok(Math.abs(fixOf(enemy) - (before - FIX.hit)) < 0.01, 'a hit knocks their fix back');
  enemy.state.hull.points = 2;
  seconds(sim, FIX.seconds * 3); // their own guns keep costing them, so it takes a while
  assert.equal(sim.state.fight.over?.outcome, 'fled');
});

test('a jump needs a sensor fix: sensors, a pilot, and a bar on the engines when the moment comes', () => {
  const sim = fight(DRONE);
  assert.match(sim.whyNot({ type: 'ship.jump' }), /sensor fix is at 0%/);
  seconds(sim, 10);
  assert.ok(Math.abs(fixOf(sim) - 10 / FIX.seconds) < 0.01, 'one sensor bar takes FIX.seconds');
  // No pilot: the fix slips away.
  const pilot = Object.values(sim.state.crew).find((m) => m.room === 'bridge');
  sim.enqueue({ type: 'crew.move', crew: pilot.id, room: 'medbay' });
  seconds(sim, 6);
  assert.ok(fixOf(sim) < 10 / FIX.seconds, 'nobody at the helm, so the fix drained');
  sim.state.fix = 1;
  assert.match(sim.whyNot({ type: 'ship.jump' }), /nobody is at the helm/);
  sim.enqueue({ type: 'crew.move', crew: pilot.id, room: 'bridge' });
  seconds(sim, 10);
  sim.state.fix = 1;
  // No power to the sensors: no fix to be had, and what there was goes.
  go(sim, { type: 'power.add', system: 'sensors', delta: -1 });
  seconds(sim, 2);
  assert.match(sim.whyNot({ type: 'ship.jump' }), /sensors have no power to take a fix/);
  assert.ok(fixOf(sim) < 1 && fixOf(sim) > 0.85, 'and what there was drains');
  go(sim, { type: 'power.add', system: 'sensors', delta: 1 });
  const ready = collect(sim, 'fix.ready');
  seconds(sim, 4);
  assert.equal(ready.length, 1);
  // A hit on us costs a quarter of it; firing a gun costs a tenth.
  go(sim, { type: 'debug.hit', at: 'us', room: 'cargo', weapon: 'pulse-laser', force: true });
  assert.ok(Math.abs(fixOf(sim) - (1 - FIX.hit)) < 0.01);
  sim.state.fix = 1;
  // The drive has to have a bar.
  go(sim, { type: 'power.add', system: 'engines', delta: -1 });
  assert.match(sim.whyNot({ type: 'ship.jump' }), /engines have no power/);
  go(sim, { type: 'power.add', system: 'engines', delta: 1 });
  go(sim, { type: 'ship.jump' });
  assert.equal(sim.state.fight.over.outcome, 'escaped');
  assert.match(newCrewedSim().whyNot({ type: 'ship.jump' }), /nowhere to jump/);
});

test('the stalemate rule: with nobody hurting anybody, the fight is called off after exactly STALEMATE_SECONDS', () => {
  const sim = fight(DRONE);
  steps(sim, STALEMATE_SECONDS * TICK_RATE - 2);
  assert.equal(sim.state.fight.over, null);
  steps(sim, 2);
  assert.equal(sim.state.fight.over?.outcome, 'stalemate');
});

test('no fight runs forever: two ships left alone always finish', () => {
  for (const enemy of [DRONE, SKIFF]) {
    const sim = fight(enemy, `forever-${enemy}`);
    let ticks = 0;
    while (!sim.state.fight.over) {
      sim.step();
      ticks += 1;
      assert.ok(ticks < 30 * 60 * TICK_RATE, `the ${enemy} fight is still going after 30 minutes`);
    }
  }
});

test('killing everyone aboard ends it', () => {
  const sim = fight();
  go(sim, { type: 'debug.combat', action: 'killCrew' });
  assert.equal(sim.state.fight.over.outcome, 'crew-dead');
  assert.match(fight(DRONE).whyNot({ type: 'debug.combat', action: 'killCrew' }), /nobody aboard/);
});

test('every ending in brief §7 can be reached from the debug panel', () => {
  const reach = {
    destroyed: (sim) => {
      go(sim, { type: 'debug.combat', action: 'cripple' });
      go(sim, { type: 'debug.hit', at: 'them', room: 'reactor', weapon: 'pulse-laser', force: true });
    },
    lost: (sim) => {
      go(sim, { type: 'debug.combat', action: 'sinkUs' });
      go(sim, { type: 'debug.hit', at: 'us', room: 'cargo', weapon: 'pulse-laser', force: true });
    },
    'crew-dead': (sim) => go(sim, { type: 'debug.combat', action: 'killCrew' }),
    surrendered: (sim) => {
      go(sim, { type: 'debug.combat', action: 'surrender' });
      go(sim, { type: 'fight.accept' });
    },
    escaped: (sim) => {
      go(sim, { type: 'debug.combat', action: 'chargeJump' });
      go(sim, { type: 'ship.jump' });
    },
    fled: (sim) => go(sim, { type: 'debug.combat', action: 'flee' }),
    talked: (sim) => {
      // Talking is a roll: find a seed where it works.
      for (let i = 0; !sim.state.fight.over; i++) {
        const fresh = fight(SKIFF, `reach-talk-${i}`);
        go(fresh, { type: 'fight.talk' });
        if (fresh.state.fight.over) Object.assign(sim.state, fresh.state);
      }
    },
    bribed: (sim) => go(sim, { type: 'fight.bribe' }),
    stalemate: (sim) => go(sim, { type: 'debug.combat', action: 'stalemate' }),
  };
  assert.deepEqual(Object.keys(reach).sort(), Object.keys(OUTCOMES).sort());
  for (const [outcome, how] of Object.entries(reach)) {
    const sim = fight(SKIFF, `reach-${outcome}`);
    how(sim);
    assert.equal(sim.state.fight.over?.outcome, outcome, outcome);
    assert.deepEqual(checkInvariants(sim), [], outcome);
  }
  assert.ok(DEBUG_ACTIONS.includes('money'));
  const sim = newCrewedSim();
  go(sim, { type: 'debug.combat', action: 'money' });
  assert.equal(sim.state.money, START_MONEY + 100);
});

test('every ending stops the guns and leaves nothing in the air; Leave it clears the fight', () => {
  const sim = fight();
  go(sim, { type: 'fight.engage' });
  seconds(sim, 30);
  go(sim, { type: 'debug.combat', action: 'stalemate' });
  assert.equal(sim.state.fight.shots.length, 0);
  assert.ok(sim.state.weapons.every((w) => w.target === null));
  assert.ok(enemyOf(sim).state.weapons.every((w) => w.target === null));
  go(sim, { type: 'fight.dismiss' });
  assert.equal(sim.state.fight, null);
});

test('Margo speaks to a hail, an offer, and how it ended', () => {
  const sim = newTalkingSim('margo-fight');
  seconds(sim, 8);
  const lines = collect(sim, 'ai.line');
  go(sim, { type: 'debug.fight', enemy: SKIFF });
  seconds(sim, 6);
  go(sim, { type: 'fight.bribe' });
  seconds(sim, 10);
  const triggers = lines.map((l) => l.trigger);
  assert.ok(triggers.includes('fight.parted'), triggers.join(', '));
  assert.ok(triggers.some((t) => t === 'fight.hail' || t === 'fight.started'), triggers.join(', '));
});

test('a fight replays exactly from its seed', () => {
  const run = () => {
    const sim = fight(SKIFF, 'replay');
    armUs(sim);
    go(sim, { type: 'fight.engage' });
    go(sim, { type: 'debug.combat', action: 'scan' });
  go(sim, { type: 'weapon.target', slot: 0, room: 'weapons' });
    seconds(sim, 120);
    return JSON.stringify(sim.snapshot());
  };
  assert.equal(run(), run());
});
