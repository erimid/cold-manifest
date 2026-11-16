# Cold Manifest: Build Plan

This is the step-by-step plan for building Cold Manifest from the brief in [`docs/BRIEF.md`](docs/BRIEF.md). The brief is the source of truth for *what* the game is. This file is the source of truth for *the order we build it in* and *how we know each step is done*. [`DECISIONS.md`](DECISIONS.md) is the project's memory: every departure from the brief, every shortcut, and every deferral goes there.

The plan follows the brief's 11 stages (§20) exactly. Each stage is broken into **sessions**. A session is one focused working block that ends with a merged pull request, green checks, and a playable build. Sessions are numbered `S<stage>.<n>` so commits, PRs and `DECISIONS.md` entries can point at them.

---

## 0. How every session works

**Start of session**
1. Read `DECISIONS.md` (Deferred list first), then the section of this plan for the current session, then the brief sections it cites.
2. Branch from `main`.

**During the session**
- Keep the game playable at every commit. If a system is half-built, put it behind a debug flag rather than leaving the main loop broken.
- New content goes in `content/`. If adding content requires touching engine code, that's a design bug: fix the engine so it doesn't.
- All randomness goes through the seeded RNG (no `Math.random()` anywhere; the content checker's lint step enforces this).

**End of session (the "green gate")**
```
npm test             # unit tests (node:test), sim is DOM-free so this runs in Node
npm run check        # tools/content-check.js: schema, references, coverage, near-duplicates
npm run autoplay -- --runs <N>   # tools/autoplay.js: headless seeded runs, no crashes, no stuck states
npm run build        # static output in dist/, deployable to any static host
```
- Update `DECISIONS.md`: new decisions, new deferrals (with the stage that must revisit them), cleared deferrals.
- Open a PR. The PR description lists what's playable now, how to try it (URL flags, debug commands), and the GitHub Pages preview link (`/pr/<number>/`) for testing on iPad.

**End of stage (in addition to the green gate)**
- A stage note in `DECISIONS.md`: what was built, what changed and why, known issues.
- An autoplay batch at the stage's run count (see §4) with a saved report in `reports/stage-<n>.md`.
- A short playtest checklist for Eric (what to try, on PC and on iPad).

---

## 1. Architecture rules that must be set in Stage 1 and never broken

These are the decisions that are expensive to change later. They are recorded in `DECISIONS.md` as D-001 to D-010.

1. **The simulation is DOM-free.** Everything under `src/sim/`, `src/ai/`, `src/narrative/` and `src/engine/rng.js` runs in plain Node. Rendering, UI and audio read sim state and send it commands; they never own game state. This is what makes `tools/autoplay.js` possible and keeps saves simple.
2. **One fixed-timestep clock.** The sim steps at 20 Hz (50 ms). Rendering runs at display rate and interpolates. Pause stops the clock; nothing in the sim changes while paused. Orders given while paused go into a command queue that is applied on the next tick.
3. **Commands in, events out.** The UI and the bot both talk to the sim only through commands (`moveCrew`, `setPower`, `setDoor`, `fireWeapon`, ...). The sim announces what happened through a typed **game event bus** (`fire.started`, `crew.died`, `door.forced`, ...). The AI line selector, memory log, run log, auto-pause, audio and run summary are all listeners on that bus.
4. **One condition language.** Events, scenes, AI lines, contracts and traits all use the same condition/effect DSL (introduced in S3.3, used from then on). Placeholder AI lines in Stage 1 use triggers only.
5. **Seeded RNG with named substreams** (`map`, `combat`, `crew`, `events`, `ai`, `threat`, `market`). Adding a roll to one system doesn't shift every other system's results, so seeds stay useful for bug reports across code changes.
6. **Content is data.** JSON files under `content/`, loaded by a loader with a browser backend (Vite `import.meta.glob`) and a Node backend (fs). The engine never imports a specific content file by name.
7. **One input module** (`src/engine/input.js`) on Pointer Events. DOM UI first, canvas second; tap vs drag by threshold; padded hit areas; long-press as right-click/hover stand-in. No other code reads raw mouse/touch events.
8. **Sim state is serializable.** Saves are a versioned JSON snapshot plus the RNG state, with explicit migrations per schema version.

---

## 2. Stage-by-stage plan

Session counts are estimates. A stage is done when its exit checks pass, not when its sessions run out.

### Stage 1: Ship and crew simulation  (≈7 sessions)

**Goal:** one ship, three placeholder crew, power routing, doors, oxygen, fire, breaches, movement and repairs, all pausable and fully usable by touch.

| Session | Work | Done when |
|---|---|---|
| S1.1 Scaffold | Vite project, folder layout from brief §4, `index.html`, `main.js` state machine stub, seeded RNG with substreams (+ tests), content loader (browser + Node), `tools/content-check.js` skeleton (schema check for files that exist, ID uniqueness, `Math.random` lint), `tools/autoplay.js` skeleton, GitHub Actions running the green gate on every PR. GitHub Pages deploys with a preview per PR (see D-014). | `npm run dev` shows a title screen; all four gate commands run in CI; the PR has a working preview link that opens on Eric's iPad. |
| S1.2 Clock and input | Fixed-timestep sim clock, pause/resume, command queue, render interpolation. Input module (Pointer Events, DOM-first routing, tap/drag threshold, padded hit areas, long-press). Keyboard map (space = pause). | Unit test: 1,000 ticks paused leaves the sim state hash unchanged. Playwright test with iPad touch emulation: tap on a panel never hits the canvas under it; long-press opens info. |
| S1.3 Ship model and renderer | Ship layout format (`content/ships/`): 12 to 16 rooms, doors, corridors, vent graph (data only for now), system placement. The *Margin of Error* layout. Room state (O2, temp, light, noise, door state, hull, fire, breach). Canvas cutaway renderer with per-room lighting, pre-rendered offscreen layers, landscape fit. Tap a room to see its status. | Ship renders crisply at 1024×768, 1366×1024 and 1920×1080. Room status panel works by tap and click. |
| S1.4 Power and systems | Reactor power pool, power routing panel (bottom of screen, chunky buttons + Q-row keys, see D-032), system levels and damage, lights as a power draw, door system (remote control with power, by hand without), life support, AI core damage level (stub value). | Routing works with mouse, touch and keyboard. Unit tests: power never exceeds supply; unpowered doors need a crew member present. |
| S1.5 Atmosphere and hazards | Oxygen per room with flow through open doors, temperature, fire spread / O2 burn / system and crew damage, hull breaches draining O2, venting via outer doors, frost on breached rooms, emergency jettison of a sealed section. | Unit tests: fire dies at zero O2; venting kills unsuited crew; jettison removes the section and everything in it. Debug panel can start fires and breaches. |
| S1.6 Crew movement and repairs | Crew entities (placeholder stats), pathfinding on the room/door graph (respects locked and jammed doors), select by tap or number keys, move orders, repair / extinguish / patch tasks, health and suffocation, suits as an equipment flag. | You can fight a fire and patch a breach with three crew, entirely by touch. Orders given while paused start on resume. |
| S1.7 Voice, sound, debug, bot | AI text box (typed-out effect, priority queue, drop stale lines, scrollable history), ~40 placeholder lines flagged `placeholder: true`. WebAudio engine with data-defined patches, unlocked by first tap. Debug panel (`?debug=1`). Auto-pause settings (fire, breach, death). Autoplay v1 (see §4). Touch pass on iPad-sized viewport. | Stage exit checks below. |

**Exit checks:** green gate; autoplay v1 at 100 seeded hazard scenarios with no crash, no NaN state, no crew stuck on a path; 60 fps with a fire in the frame on the dev machine with CPU throttled 4×; Eric plays 10 minutes on his iPad from the PR preview link.

### Stage 2: Combat and identity  (≈10 sessions)
**Depends on:** Stage 1 (clock, power, damage, crew).

**Why this stage grew (2026-11-16, D-070):** after S2.3, Eric found the build "almost exactly like FTL": a top-down row of rooms, a power-bar strip, the enemy cutaway on the right, and FTL's exact shield, evasion, charge and jump rules. Brief §3 rules that out. Sessions S2.6 to S2.10 rebuild the view, the controls and the fight rules so the game reads as a haunted cargo hauler seen through Margo's monitor, and bring Margo's pushback and crew refusal forward so the first runs already feel unlike FTL. S2.5 (enemy types and balance) moves after them so it balances the new rules. Run order: S2.4, S2.6, S2.7, S2.8, S2.9, S2.5, S2.10. Departures from the brief are D-070 to D-078.

| Session | Work | Done when |
|---|---|---|
| S2.1 Weapons and layout | Weapon data (charge time, power, damage, effects), 2 to 4 hardpoints, shields as hit absorption, evasion from engines + pilot. Split view with the enemy ship cutaway on the right. Targeting UI: tap a weapon, tap an enemy room (works paused). | Player can charge and fire at a dummy target ship. |
| S2.2 Hits and effects | Shot resolution (miss / shield / hit), system damage, fires and breaches from hits, crew injury. Placeholder screen shake and impact flash. Auto-pause on fight start. | Fires and breaches from hits use the exact Stage 1 hazard code. |
| S2.3 Enemy AI and fight endings | Enemy power and targeting by archetype. Surrender offers (cargo, money, info), escape by jumping when engines charge, pre-fight hail (talk/bribe stub driven by money and a placeholder negotiation skill). Stalemate rule so no fight can run forever. | Every ending in brief §7 is reachable from the debug panel. |
| S2.4 Boarding | Enemy boarding by docking clamp or umbilical through an airlock (never by teleporter, D-077), hand-to-hand resolution in rooms, player crew boarding the enemy, win by killing their crew. | Boarding fights resolve with no stuck crew in 100 bot fights. |
| S2.6 Decks and Margo's monitor | Ship drawn **side-on as stacked decks** (D-071): new layout format with decks, ladders and a powered lift; the *Margin of Error* redrawn as a hauler that is mostly cargo hold, keeping room ids where it can. **Service crawlways** (D-072) through the whole ship: engineers and the creature only, plus a few creature-only ducts; they replace the vent graph and are drawn on the schematic. Screen rebuilt as **Margo's monitor** (D-073): a cheap company CRT schematic with her portrait and voice at the centre; the enemy as a sensor-return inset that you still target room by room. Room codes painted on floors replaced by faded company stencils, crates and pipes. Touch targets stay 44 px or larger on decks. | Crew path by corridor, ladder, lift and (engineers) crawlway; every Stage 1 and S2.1 to S2.4 test passes on the new layout; ship and inset readable at 1024×768 on iPad. |
| S2.7 Visibility and running dark | One **signature model** for both ships (D-074): light, noise, heat and engine burn per room and per ship. Fog on our own ship: unlit, unmanned rooms out of sensor cover show last-known state behind static. Enemy rooms resolve as our sensors scan them (clears DF-32's "everything visible"). **Running dark** replaces evasion: a lower signature makes their shots miss or lose lock. **Jump needs a sensor fix** instead of a charge meter. | Bot report shows running dark changing hit rates; a scripted test shows a dark room hiding its state; the creature stage can read the same model. |
| S2.8 Brace, ammo and the hold | **Capacitor shields** (D-075): shield power charges a capacitor that the player dumps as a brace to soak a volley, and bracing spikes the signature. **Hand-loaded heavy guns** (D-076): the slug thrower and lance take ammo crates a crew member carries from the hold; the laser needs none. **Playable cargo hold**: crates drawn in the hold, opened, moved and jettisoned (hiding in compartments stays with S7.3). | A fight can be won with brace timing and ammo runs; the bot can fetch ammo; no crew stuck on an ammo run. |
| S2.9 Breaker board and intercom | **Breaker board** (D-078) replaces the bottom power strip: cheap company hardware with breakers per system, 44 px targets, Q-row keys kept, opened on demand so the bottom of the screen is free outside a fight. **Intercom orders**: still tap a crew member, then a room; crew answer in their own short spoken line (placeholder crew lines), nothing waits on the reply. Minor systems may be merged if the board needs fewer breakers (logged if done). | Routing works by touch, mouse and keyboard on the board; every order gets a crew reply; browser tests updated. |
| S2.5 Four enemy types + bot | Glass cannon, boarders, shield tank, drone carrier (with a simple drone mechanic), built and balanced on the S2.6 to S2.9 rules. Autoplay v2. | Each enemy type has a visibly different win rate and fight length. |
| S2.10 Margo pushes back, crew refuse | Pulled forward from S5.1, S5.3, S4.3 and S4.5 (D-070). Margo's personality file and **50-line voice sample, approved by Eric first**. AI trust value; risk detector for risky orders (venting or jettisoning an occupied room, cutting life support with crew in a breach, sending someone into fire); Margo argues on the intercom, refuses a few times per run, one-tap captain's override that costs trust. A small **memory log** (hard-coded event types for now) and crew who refuse an order with a reason that names a remembered event. | Stage exit checks; each behaviour reachable from the debug panel and seen in bot runs. |

**Exit checks:** green gate; 200 seeded bot fights (50 per enemy type) with no crashes or endless fights; each enemy type has a visibly different win rate and fight length in the report; Margo argues and crew refuse at non-zero, non-dominant rates; Eric plays a fight on his iPad and it no longer reads as FTL (brief §3).

### Stage 3: Run structure  (≈7 sessions)
**Depends on:** Stage 2.

| Session | Work | Done when |
|---|---|---|
| S3.1 Sector map | Map generation (15 to 25 nodes: ports, empty space, hazards, derelicts, checkpoints), map UI, jumps cost fuel, deadlines in jumps, a pursuit-pressure hook. | Seeded maps are always connected and always have a reachable delivery. |
| S3.2 Screens | All screens from brief §18 as working stubs and navigation: title, meta hub, contract board, map, ship view, port, event view, scene view (empty), run summary. | You can click through a whole run loop, even if most screens are thin. |
| S3.3 Condition/effect DSL and events | The shared condition/effect language (see §1.4), event data format with choices, requirement labels like "[Ilse, Medicine]", outcomes that can start combat, a scene, or the threat (hooks only). Event view UI. Port S2.10's hard-coded memory types and refusal rules into the DSL. | Content checker validates every condition and effect and every reference. |
| S3.4 Contracts and basic ports | Contract format; **Smuggling, Courier, Salvage claim** as the first 3 types; delivery, failure, pay, reputation change; a basic inspection; ports with refuel, repair, sell contract cargo, hire (stub). | A full contract can be completed or failed. |
| S3.5 First content | **30 events**, 5 factions as stubs (provisional names, see DECISIONS D-012), ~18 named ports, 10 contract templates. | Checker: 30/150 events, no broken references. |
| S3.6 Save, end, summary | Autosave at every port and jump, versioned schema with migrations, export/import as a text string, meta-profile skeleton. Run end conditions (destroyed, all dead, retire; mutiny wired in Stage 4). Run event log and a first run summary. Career: continue or retire after delivery. | Save at a port, reload in a new tab, export, import on another browser: identical state. |
| S3.7 Bot v3 | Autoplay plays complete runs headlessly and reports the §19 metrics that exist so far. | Stage exit checks. |

**Exit checks:** green gate; 100 full seeded runs with no crash or stuck state; save/load round-trip test across every screen; a real contract takes 30 to 75 minutes to play by hand (time it once).

### Stage 4: Crew depth  (≈6 sessions)
**Depends on:** Stage 3 (events, run log, DSL).

| Session | Work | Done when |
|---|---|---|
| S4.1 Crew generation and traits | Name, background, look and voice pools in `content/crew/`; skills that improve with use (engineering skill or a trait decides who may use the service crawlways, replacing S2.6's flag); **30+ traits** as data with behavior hooks (not just stat modifiers). | Every trait changes at least one behavior that the bot report can count. |
| S4.2 Needs and stress | Rest, food, safety, morale; stress sources; freeze / panic / lash out / break (break adds a lasting negative trait); lasting injuries. | Unit tests per break state. |
| S4.3 Memory and opinions | Extend S2.10's memory log: memory log from bus events with emotional weight, decay, strong memories that stick; opinions of captain, each crew member, and the AI, from hatred to devotion; memory text templates ("Captain left {crew_name} behind on {location}"). | Crew panel shows each member's top memories with names and places. |
| S4.4 Relationships | Pair relationships (friendship, rivalry, romance, mentorship, grudge), same-room bonuses and friction, fights. Crew panel: portraits (placeholder), health, stress, mood icon, traits, skills, relationships. | Relationship changes trace back to specific memories. |
| S4.5 Refusal, mutiny, prisoners | Widen S2.10's order refusal: reasons built from memories ("Dace won't go back into the hold. She remembers what happened to Petrov."), mutiny meter with warning signs, brig, mutiny event that can end the run. **Prisoner transport** contract (4th type). **+10 crew-driven events.** | Refusal and mutiny both appear in bot runs at non-zero, non-dominant rates. |
| S4.6 Bot v4 and balance | Bot reports mutiny rate, refusals, breaks, deaths by cause. Tune. | Stage exit checks. |

**Exit checks:** green gate; 100 runs; mutiny rate between roughly 5% and 25% for the bot's default strategy (tunable target, logged in DECISIONS); no crew can be permanently stuck in a refused state.

### Stage 5: The ship AI  (≈8 sessions)
**Depends on:** Stage 4 (memory and opinions), S3.3 (DSL).

| Session | Work | Done when |
|---|---|---|
| S5.1 Voice and tooling | (Personality file and 50-line sample are done in S2.10; review them here.) AI personality file (`content/ai-lines/_personality.md`) for M.A.R.G.O. ("Margo"): history, voice rules, do's and don'ts, 50 sample lines across categories. Line schema (id, category, conditions, weight, slots, priority). Slot system with fallbacks. Near-duplicate checker that treats slot variants as one line (slot-normalized n-gram similarity plus edit distance). | **Eric approves the voice sample before any bulk writing.** Checker flags a planted near-duplicate. |
| S5.2 Selector | Triggers from bus events, condition matching, weights, no-repeat tracking (hard rule: never within a run; prefer unheard, then heard longest ago, across the meta-profile), priority queue with stale-drop, calm-period pacing (one line per 30 to 90 seconds), no talking over important events. When nothing eligible is left, stay silent rather than repeat. | Unit tests for every selection rule. |
| S5.3 Trust and behavior | Builds on S2.10 (trust, risk detector, arguing, refusals and override already exist): AI opinions of each crew member; override effects on crew opinion; withholding and lying hooks (low trust, protecting a liked crew member, damaged core); glitch rendering for a damaged core. | Each behavior reachable via debug panel and seen in bot runs. |
| S5.4 to S5.7 Lines, 1,000 (about 150 under the 500 cap, D-100; likely one or two sessions) | Four writing sessions of about 250 lines each, in batches of 50 to 100 per category, running the checker after every batch. Allocation in §3. Remove all Stage 1 placeholder lines. | Checker shows the S5 column of §3 met, zero near-duplicates, zero placeholders. |
| S5.8 Bot v5 | Bot reports repeated AI lines within a run (must be 0), across runs, and lines per minute in calm vs crisis. | Stage exit checks. |

**Exit checks:** green gate; 100 runs with zero in-run repeats; calm-period AI frequency inside 30 to 90 seconds on average.

### Stage 6: Horror threat  (≈6 sessions)
**Depends on:** Stage 5 (AI reports and uncertainty), Stage 4 (crew reactions).

| Session | Work | Done when |
|---|---|---|
| S6.1 Creature agent | Creature moves through rooms, the S2.6 service crawlways (shared with engineers) and creature-only ducts; states (hiding, stalking, hunting, feeding, fleeing); senses (noise, light, movement, heat) read from S2.7's signature model; door breaking (weak doors). | Debug view shows creature state and what it currently senses. |
| S6.2 Types and sources | **3 creature types** as data (sound hunter that hates light; mimic of a crew member; infection spreader). Sources: specimen breach, port/derelict stowaway, infected survivor or crew transformation, crawl-in through a breach. About half of runs get a threat. | Bot report shows threat rate near 50% and each type appearing. |
| S6.3 Fighting back | Locking and channeling, cutting lights, venting, noise lures, crawlway hatches (block the creature and engineers alike), fire flush, jettison; crew reactions by trait and stress (hunt, hide, panic, refuse); crew killed or taken. | Each countermeasure can end or contain a threat in a scripted test. |
| S6.4 Information | Creature only visible to crew sight, sensors, or AI report, using S2.7's fog and static; pulsing last-seen marker, sensor static; AI reports that can be uncertain or wrong (sensor damage, trust, core damage). Placeholder flicker, heartbeat, vent scratching patches. Auto-pause on sighting. | A player can catch the AI being wrong by cross-checking sensors. |
| S6.5 Specimens and content | **Specimen haul** contract (5th type). **+15 threat events.** AI lines: 150 creature, 60 sensor, 20 arguments, 20 contract-specific. | Checker shows S6 column met. |
| S6.6 Bot v6 and perf | Bot reports threat frequency and how threats end. Performance check: full ship + all crew + fire + active creature. | Stage exit checks. |

**Exit checks:** green gate; 100 runs; the creature is never stuck (no room/vent dead ends); 60 fps worst case on the throttled profile.

### Stage 7: Economy and factions  (≈6 sessions)
**Depends on:** Stage 3. (Could run before Stage 6 if useful; see §5.)

| Session | Work | Done when |
|---|---|---|
| S7.1 Goods and markets | **20+ goods**, per-port supply and demand, drifting prices, market UI, cargo space shared with contract cargo and survivors. | Buying low and selling high is possible and visible. |
| S7.2 Market events and money | Outbreak, blockade and war effects on prices and bans; black markets; contraband by controlling faction; crew wages (unpaid crew lose morale and remember it). | Bot report shows event-driven price swings. |
| S7.3 Inspections | Hiding crates in the S2.8 hold, hidden compartments (upgrade), bribes, negotiation (crew skill), fighting; checkpoints on the map. | All four inspection outcomes reachable. |
| S7.4 Factions and memory | Full faction writeups (names, look, values, buys/bans, smuggler policy, ship types, voice); reputation plus deed records; per-port memory (dockmaster, bar); rep effects on prices, contracts offered, inspections, patrol hostility, recruits, dialogue. Shipyard with the full upgrade list from brief §6. | Two runs with opposite rep get visibly different ports. |
| S7.5 Content | **+25 events.** AI lines: 60 port arrival, 60 trade, 60 cargo, 40 contract-specific. Faction and port greeting variants. | Checker shows S7 column met. |
| S7.6 Bot v7 | Money and reputation curves; compare a "trader" bot strategy against a "contracts only" one to prove the economy changes outcomes. | Stage exit checks. |

**Exit checks:** green gate; 100 runs; the two bot strategies produce measurably different money curves (the economy is not decorative).

### Stage 8: Crew scenes  (≈6 sessions)
**Depends on:** Stage 4 (memory, relationships), Stage 5 (AI as participant).

| Session | Work | Done when |
|---|---|---|
| S8.1 Scene system | Scene format (nodes, 2 to 4 choices, effects, conditions, slots, participants including the AI), cost rule (one scene per port visit or per rest period), scene view UI. | A scene can change memory, relationships, stress, traits, and unlock other scenes. |
| S8.2 Portraits | Code-drawn busts from crew data: face shape, hair, skin tone, clothing, scars, accessories; seeded and cached offscreen. | 50 random crew look distinct at a glance. |
| S8.3 Availability and traitor | Scene availability engine; grief scenes that name the dead and their memories; optional **secret traitor** per run with subtle tells, a key-moment action, and confession scenes. | Traitor appears in a minority of bot runs and is catchable. |
| S8.4 to S8.6 Scenes, 60 | Three writing sessions of 20 scenes: getting-to-know-you, conflict/mediation, grief, AI-participant, confession, plus one special-character chain prototype (2 scenes) to prove chains work. AI lines: 30 conflict, 30 bonding, 40 idle, 20 traitor. | Checker: 60/120 scenes, S8 column met. Stage exit checks. |

**Exit checks:** green gate; 100 runs; every scene in the library becomes available in at least one seeded bot run (or is flagged as intentionally rare).

### Stage 9: Meta-progression  (≈4 sessions)
**Depends on:** Stages 5, 7, 8.

| Session | Work | Done when |
|---|---|---|
| S9.1 Persistent memory | AI core memory across runs (previous crews, deaths, endings), softened trust carry-over; faction and port memory with per-run decay where major deeds stay. | A second run's port greeting references the first run. |
| S9.2 Unlocks and hub | Milestones and achievements, unlocks (ships, backgrounds, contract types, AI core upgrades), meta hub UI with stats. | Each unlock has a reachable trigger. |
| S9.3 The Wall and the story | The Wall memorial with AI epitaphs built from each dead crew member's memories; run summary v2, the "story of the run" from the event log. | Epitaphs reference specific memories, not just names. |
| S9.4 Ships and content | **2 more starting ship layouts** (3 total, different strengths). AI lines: 100 past-run, 20 greeting, 30 rare. | Stage exit checks. |

**Exit checks:** green gate; 100 chained runs on one meta-profile without save corruption; save migration test from a Stage 3 save file.

### Stage 10: Content expansion  (≈13 sessions)
**Depends on:** all of the above. This stage is mostly writing, with two engineering sessions.

| Session | Work |
|---|---|
| S10.1 Rescue + enemies | **Rescue** contract (6th type) with survivors (space, supplies, infected, traitors, recruits). Enemy types to **8+**: add stealth, bounty hunter, faction patrol, company security drones. |
| S10.2 to S10.7 AI lines | Six writing sessions of about 250 to 260 lines to reach every category target (the S10 column in §3, about 1,540 lines). |
| S10.8 to S10.10 Scenes | **10 special characters** with 3 to 5 scene chains each (about 40 scenes) plus 20 more generic scenes, reaching **120+**. |
| S10.11 to S10.12 Events | **+70 events**, reaching **150+**. |
| S10.13 Variety pass | Run the near-duplicate checker across everything, rewrite flagged lines, read a random 200-line sample aloud for voice drift, confirm zero placeholders. |

**Exit checks:** green gate with **every coverage category at or above target**; 100 runs with zero in-run repeats; across-run repeat rate low enough that a typical 10-run player shouldn't notice (target logged in DECISIONS).

### Stage 11: Polish and balance  (≈7 sessions)

| Session | Work |
|---|---|
| S11.1 Look | Finish the look S2.6 started (monitor frame, stencils): worn metal, company stencils, cables, condensation, flickering panels; fire, smoke, sparks, frost; animated crew silhouettes; subtle scanlines/CRT glow with an off switch. |
| S11.2 Sound | Real sound design of the patch library: hum, alarms, UI, AI voice blip, creature, music pads. One short session max per sound. |
| S11.3 Juice and accessibility | Screen shake, impact flashes, pulsing alarm borders, heartbeat vignette; text size, reduce flicker/shake, colorblind-safe alarms (shape + icon), pause always available. |
| S11.4 Tutorial | A short guided first contract that teaches pause, power, doors, crew, map, port. |
| S11.5 iPad and performance | Full touch pass on a real iPad in Safari; profiling and fixes to hold 60 fps in the worst case. |
| S11.6 Balance | Tune from autoplay data so a good player finishes a 3-contract career roughly one run in four or five (calibrate a "careful" bot strategy as the proxy). |
| S11.7 Release candidate | Definition of done (brief §22) checklist, static deploy, an evening-long playtest. |

**Exit checks:** brief §22 in full.

---

## 3. Content plan

Content is spread so that every system gets its first real content in the stage that builds it, the library never blocks engineering, and the big writing push lands in Stage 10 when every system it refers to exists.

**Writing protocol (all content):** write in batches of 50 to 100 per category (5 to 10 for scenes and events), in the voice defined in the personality or crew voice file, run `npm run check` after each batch, fix near-duplicates before moving on. Follow brief §21 (grounded, dry, specific, short, no brand names, no references to other works by name, no gore).

### AI lines by category and stage (minimum targets from brief §9)

Stage 1 to 4 use about 40 placeholder lines flagged `placeholder: true`. They don't count toward targets and must all be gone by the end of Stage 5.

| Category | Target | S5 | S6 | S7 | S8 | S9 | S10 |
|---|--:|--:|--:|--:|--:|--:|--:|
| Greeting / run start | 80 | 40 |  |  |  | 20 | 20 |
| Jump | 120 | 60 |  |  |  |  | 60 |
| Port arrival | 150 | 50 |  | 60 |  |  | 40 |
| Trade | 120 | 30 |  | 60 |  |  | 30 |
| Combat start | 100 | 50 |  |  |  |  | 50 |
| Combat progress | 200 | 80 |  |  |  |  | 120 |
| Combat end | 120 | 60 |  |  |  |  | 60 |
| Hull damage / fire / breach | 150 | 80 |  |  |  |  | 70 |
| Crew injury | 100 | 50 |  |  |  |  | 50 |
| Crew death | 120 | 50 |  |  |  |  | 70 |
| Crew conflict | 100 | 40 |  |  | 30 |  | 30 |
| Crew bonding | 80 | 30 |  |  | 30 |  | 20 |
| Order confirmations | 200 | 80 |  |  |  |  | 120 |
| Arguments before risky orders | 150 | 70 | 20 |  |  |  | 60 |
| Refusals | 60 | 30 |  |  |  |  | 30 |
| Captain overrides | 60 | 30 |  |  |  |  | 30 |
| Cargo comments | 200 | 40 |  | 60 |  |  | 100 |
| Creature sighting / threat | 250 |  | 150 |  |  |  | 100 |
| False / uncertain sensor reports | 80 |  | 60 |  |  |  | 20 |
| Idle ship-quiet | 250 | 50 |  |  | 40 |  | 160 |
| Past-run memories | 150 |  |  |  |  | 100 | 50 |
| Damaged AI glitch | 80 | 30 |  |  |  |  | 50 |
| Mutiny warning signs | 60 | 20 |  |  |  |  | 40 |
| Traitor suspicion | 50 |  |  |  | 20 |  | 30 |
| Contract-specific | 150 | 30 | 20 | 40 |  |  | 60 |
| Rare | 100 |  |  |  |  | 30 | 70 |
| **Total** | **3,280** | **1,000** | **250** | **220** | **120** | **150** | **1,540** |

The category minimums add up to 3,280, so meeting every category also clears the 3,000-line floor. Lines that differ only in slots count once.

**Capped at 500 to start (Eric, 2026-11-16, D-100).** The table above is the brief's. Until Eric lifts the cap, every figure in it is scaled by 500 / 3,280: the per-category targets the checker enforces are in `src/ai/categories.js` (for example idle 40, creature 40, order confirmations 30, arguments 23, refusals 9, overrides 9), and each stage writes about 15% of its column (Stage 5 about 150 lines, Stage 6 about 40, Stage 10 about 235). The 50-line voice sample from S2.10 already counts toward the 500.

### Other content by stage

| Content | Target | Where it lands |
|---|---|---|
| Transit events | 150+ | S3: 30 · S4: +10 crew-driven · S6: +15 threat · S7: +25 economy/faction · S10: +70 |
| Crew scenes | 120+ | S8: 60 (incl. a 2-scene chain prototype) · S10: +60 (40 special-character chain scenes, 20 generic) |
| Contract types | 6 | S3: Smuggling, Courier, Salvage · S4: Prisoner transport · S6: Specimen haul · S10: Rescue |
| Enemy ship types | 8+ | S2: 4 · S10: +4 |
| Factions | 5+ | S3: stubs · S7: full writeups, ships, voice |
| Ports | ~18 | S3: names and basic services · S7: markets, memory, dockmasters |
| Goods | 20+ | S7 |
| Traits | 30+ | S4 |
| Creature types | 3+ | S6 |
| Starting ships | 3 | S1: *Margin of Error* · S9: +2 |
| Special characters | ~10 | S8: 1 prototype · S10: the rest with chains |

---

## 4. How the tools grow

The content checker and autoplay bot exist from S1.1 and gain a capability every stage, so "checker passes and bot runs clean" is always a meaningful gate.

| Stage | Content checker adds | Autoplay bot plays | Batch size |
|---|---|---|---|
| 1 | Schema, unique ids, ship layout validity (connected rooms, doors reference real rooms), `Math.random` lint | 10-minute hazard scenarios: random fires and breaches, bot routes power and repairs; checks invariants (no NaN, O2 in bounds, no stuck paths) | 100 scenarios |
| 2 | Weapon and enemy ship data | Seeded fights against each enemy type | 200 fights |
| 3 | DSL validation, event/contract/port/faction references | Full runs end to end | 100 runs |
| 4 | Traits, crew pools, memory templates | Runs with crew behavior; mutiny and refusal metrics | 100 runs |
| 5 | AI line schema, slots, coverage report, near-duplicate detection | AI repeat counts in and across runs; lines per minute | 100 runs |
| 6 | Creature types, crawlway and duct graph validity | Threat frequency and outcomes; creature stuck detection | 100 runs |
| 7 | Goods, markets, faction bans | Money and rep curves; two strategies compared | 100 runs × 2 |
| 8 | Scenes (graph validity, unreachable nodes) | Scene availability coverage; traitor rate | 100 runs |
| 9 | Unlocks, meta-profile schema | Chained runs on one profile | 100 chained runs |
| 10 | Full coverage against every target | Everything | 100 runs |
| 11 | No change | Balance calibration with a "careful" strategy | 500+ runs |

The debug panel (`?debug=1`) grows the same way: each stage adds the controls for what it built (start fire in S1, start fight in S2, trigger event by id in S3, set opinions in S4, show AI trust in S5, spawn creature in S6, set reputation and money in S7, trigger scene by id in S8).

---

## 5. Dependencies and what can move

```
S1 ship sim ─► S2 combat ─► S3 run structure ─┬─► S4 crew depth ─► S5 ship AI ─► S6 horror ─┐
                                              │                     │                     ├─► S9 meta ─► S10 content ─► S11 polish
                                              └─► S7 economy ───────┴─► S8 scenes ────────┘
```

- **Strict order:** 1 → 2 → 3, then 4 → 5. Stage 5 needs crew memory; Stage 6 needs the AI's reporting and the crew's reactions.
- **Can swap:** Stage 7 only needs Stage 3, so it can move earlier (before 4, 5 or 6) if we want the economy in hand sooner. Stage 8 needs 4 and 5, not 6 or 7.
- **Must not start early:** Stage 10's bulk writing, because lines written before their system exists usually reference things that change.

---

## 6. Risks and how the plan handles them

| Risk | Mitigation |
|---|---|
| The AI's voice drifts across 3,000 lines written over many sessions | Personality file with approved samples (S5.1 gate); every writing session starts by rereading it; S10.13 voice-drift read. |
| Near-duplicates slip in at volume | Slot-normalized near-duplicate check runs after every batch, not just at the end. |
| The sim gets coupled to the DOM and autoplay can't run | Architecture rule 1; CI runs autoplay in plain Node from S1.1, so coupling breaks the build immediately. |
| iPad performance discovered too late | Perf check at the end of Stages 1, 6 and 11 against a throttled profile, plus real-device checks by Eric. |
| Pause semantics leak (something moves while paused) | Unit test on the paused state hash from S1.2, extended every time a system is added. |
| Saves break between stages | Versioned schema and migrations from S3.6; a saved fixture from each stage is replayed in tests. |
| Looking like another game | Brief §3 anti-goals reviewed at every stage note; no borrowed names, UI layouts or exact rules. Stage 2 was rebuilt for this after S2.3 (D-070). |

---

## 7. Rough size

About 80 sessions in total: Stage 1 (7), 2 (10), 3 (7), 4 (6), 5 (8), 6 (6), 7 (6), 8 (6), 9 (4), 10 (13), 11 (7). Stages 1 to 3 (about 24 sessions) give a playable run loop; Stages 1 to 6 (about 44) give the full core experience with placeholder art and sound.
