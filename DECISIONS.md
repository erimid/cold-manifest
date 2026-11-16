# DECISIONS

Read this file at the start of every session. It is the project's memory across sessions.

- The brief is [`docs/BRIEF.md`](docs/BRIEF.md). The build plan is [`PLAN.md`](PLAN.md).
- Log every decision that departs from the brief, and every shortcut or deferral, with: **what** was done, **why**, and the **stage where it must be revisited**.
- Keep the Deferred list current: add items when you take a shortcut, strike them when they're done.
- At the end of every stage, add a stage note (what was built, what changed and why, known issues).

---

## Deferred

Items here are known shortcuts. Each names the stage that must clear it.

| # | What | Revisit in | Status |
|---|---|---|---|
| DF-01 | 76 placeholder AI lines (`content/ai-lines/placeholder.json`, flagged `placeholder: true`) stand in for the real library. They carry no personality stage, relationship or degradation conditions yet. | Stage 5 (all removed by end of S5.7) | Open |
| DF-02 | Placeholder audio: 14 synthesised patches in `src/audio/patches.js` (hum, clicks, alarms, door, hiss). No music, no volume slider, no positional sound. | Stage 11 (S11.2) | Open |
| DF-03 | Placeholder crew portraits in the crew panel. | Stage 8 (S8.2) | Open |
| DF-04 | Faction and port names are provisional (see D-012). | Stage 7 (S7.4) | Open |
| DF-05 | Vent graph is data only, not used by anything, until the creature exists. | S2.6 (redrawn as service crawlways and ducts, D-072), Stage 6 (S6.1, creature uses them) | Open. S2.6 replaced vents with crawlways that engineers use (D-080); the creature-only ducts wait for S6.1 |
| DF-06 | Talking an enemy down uses `NEGOTIATION_PLACEHOLDER` (0.5) in `combat.js` in place of a crew skill, and no reputation. A bribe always works if we can pay. | Stage 4 (S4.1, crew skills), Stage 7 (reputation, prices) | Open |
| ~~DF-07~~ | ~~The sim's only contents were test-bay probes and `reactorDrift`.~~ | S1.3 | Done in S1.3: the ship replaced the test bay; probes and `reactorDrift` are gone |
| ~~DF-08~~ | ~~GitHub Pages must be switched on once in the repo settings.~~ | Stage 1 | Done: Eric confirmed 2026-11-15 |
| ~~DF-09~~ | ~~No Playwright touch tests in CI yet.~~ | S1.2 | Done in S1.2 |
| DF-10 | Pinch-zoom and two-finger pan are not handled: the input module tracks one pointer at a time. | S1.3 if the ship view needs a camera, otherwise S11.5 | Open |
| ~~DF-11~~ | ~~Auto-pause triggers and their settings (brief §7) were not wired.~~ | S1.7 | Done in S1.7: fire, breach and death pause the game, each with its own switch (D-044) |
| DF-12 | Noise only comes from fire. | Stage 6 (noise sources) | Narrowed in S2.7: noise now comes from fire, breaches, running systems, crew walking, working and fighting, guns firing and hits landing (D-083). Nothing listens to it yet except the signature; the creature will in Stage 6. The hit half was done in S2.2 (D-051) |
| DF-13 | Hull damage, heat and cold have no visual of their own beyond fire glow and breach frost; temperature only shows in the status panel and has no effect on crew or systems. No smoke or sparks yet. | S11.1 (look pass) | Open |
| ~~DF-14~~ | ~~Doors open by remote from anywhere with no power or crew needed.~~ | S1.4 | Done in S1.4: doors need door control power or hands at the door (D-031) |
| DF-15 | Autoplay takes about 300 s for 100 runs on the build machine after S2.7 (150 s at first; the senses step and two more duel postures added to it), and the CI job limit went from 10 to 15 minutes to leave room (three modes, each twice, with invariants and stuck checks every tick). Sample the checks or cut the replay pass if it grows further. | Stage 3 | Open |
| ~~DF-16~~ | ~~"Hands at the door" read an empty crew list, so an unpowered door could not be moved in play.~~ | S1.6 | Done in S1.6: crew exist. A crew member in a room on either side counts as hands; walking crew open doors themselves (D-039) |
| ~~DF-17~~ | ~~Life support is a flat rate on every room with no flow between rooms.~~ | S1.5 | Done in S1.5: air flows through doors, airlocks and breaches (D-034). Crew still do not breathe air down (S1.6) |
| DF-18 | Sensors and medbay power do little yet (the medbay heals; sensors do nothing). AI core power and damage only feed `aiCoreStatus()` and whether Margo speaks. Since S2.7 sensors give cover of our own rooms, the scan, the lock and the jump fix, and engines only add burn to the signature and power the jump (D-083 to D-087). | Stage 3 (jumps), Stage 5 (AI degradation), Stage 6 (sensors) | Open |
| DF-19 | Power panel tiles show system codes (SHD, ENG...) with no on-screen legend on touch; the codes match the stencils on the room floors. | S2.9 (breaker board replaces the panel, D-078) | Open |
| ~~DF-20~~ | ~~Crew hazards acted on bare crew entries that only tests created.~~ | S1.6 | Done in S1.6 |
| DF-21 | Jettison has no cost beyond the room: no cargo loss, no hull or handling penalty, no AI argument first, and the vent graph still lists vents into the missing room. | Stage 3 (cargo), Stage 5 (AI argues before risky orders), Stage 6 (vents) | Open |
| DF-23 | The three starting crew (Ilse, Dace, Okoro) are placeholders in `content/crew/placeholder.json` with no skills, traits, needs or stress; everyone works at the same rate. | S4.1 (crew generation, skills, traits) | Open |
| DF-24 | Suits are a free, instant toggle with endless air. Crew do not use up a room's oxygen. Crew never refuse an order or flee danger by themselves. | S2.10 (first refusals, D-070), Stage 4 (traits, wider refusal), Stage 9 (equipment) | Open |
| DF-25 | Crew walk in straight lines between doors and pass through each other. Routes count doors, not distance. The crew bar is sized for three and will wrap with eight. | S11.5 (touch polish), Stage 4 (bigger rosters) | Open |
| ~~DF-22~~ | ~~Nothing put a fire out except starving or venting it, and nothing patched a breach.~~ | S1.6 | Done in S1.6: crew extinguish, patch, repair and unjam (D-040) |
| ~~DF-26~~ | ~~The 60 fps check at 4x CPU throttle could not be confirmed on the build machine, which has no graphics card.~~ | Eric's Stage 1 playtest | Done: Eric played PR #8 on his iPad on 2026-11-15 and reported good fps and no issues |
| DF-27 | Margo only reacts to Stage 1 events and speaks in one voice. Lines are picked by trigger and category only; she is silent when the AI core has no power but does not otherwise degrade. Crew injury lines fire once per crossing below half health. | Stage 5 | Open |
| DF-28 | Settings hold sound on/off and the three auto-pause switches only. No reduced-motion, text size, colour or key rebinding yet. Auto-pause on creature sighting arrives with the creature. | Stage 6 (creature), S11.5 (accessibility) | Open. S2.2 added auto-pause on fight start and a screen shake switch (D-053) |
| DF-29 | The autoplay scenario bot plays one fixed competent strategy (send the nearest crew, suit up for breaches, shut doors round fires). It does not vent, jettison or re-route power, so it does not prove those are balanced. | Stage 3 onward as the bot grows (PLAN.md §4) | Open |
| ~~DF-30~~ | ~~A hit only took hull points and room integrity.~~ | S2.2 | Done in S2.2: hits break systems, start fires, hole the hull and hurt crew (D-051), with shake, flash and auto-pause on fight start (D-052, D-053) |
| DF-31 | Fights start only from the debug panel, and losing our hull ends the fight but not the run. There are two enemies, the drone and the salvager skiff. | Stage 3 (fights from the map, run end), S2.5 (enemy types) | Open. S2.3 added enemies that shoot back and every ending in brief §7 (D-055 to D-058) |
| DF-32 | Weapons take power in hardpoint order with no way to reorder or switch one off, and there is no way to fit, remove or buy a weapon; the third weapon (breaching lance) and the third hardpoint are unused. Every enemy room and its state is visible whatever the sensors are doing. | Stage 9 (shipyard), S2.7 (sensors gate what you see, D-074) | Narrowed in S2.7: enemy rooms are static until the sensors resolve them, and only resolved rooms can be aimed at (D-085). The weapon fitting half is still open |
| DF-33 | Our own hull, shields and evasion only show in the weapons bar, which only appears in a fight (S2.2 added what each hit did, in words, where it lands). The fight view gives the enemy 27% of the width; with four weapon tiles the bar will be tight on a 1024 px screen. | S2.6 (screen rebuilt as Margo's monitor with an enemy inset, D-073), S11.5 (touch polish) | Narrowed in S2.6: the enemy is a sensor inset of about 29% of the monitor (D-082); the weapons bar is unchanged and still tight with four tiles |
| DF-34 | Combat numbers (charge times, shield recharge of 6 s a layer, evasion, hull points, and S2.2's hit effects in `HIT` and the weapon files) are first guesses. With one laser alone the drone's shield never stays down. In the under-fire bot mode, 12 hits in two minutes leave our hull at about 2 of 20. The skiff lands about 1 of 8 shots on a careful bot that turns off lights for two shield layers, and the bot beats it in every duel; a player who leaves the lights on has no shields at all. Tune the skiff and the starting power together. Shields and evasion are replaced in S2.7 and S2.8, so tune after those. | S2.5 (balance from the bot's fight report, now after S2.9) | Open. S2.7 replaced evasion with the lock (D-086): against the skiff the bot takes 52% of shots as hits with the lamps on and 7% running dark, and wins 50% lit against 81% dark. Running dark costs the bot nothing yet, so it is too strong; tune `SIGNATURE`, `LOCK` and `MISS` in `senses.js` in S2.5, once crew fear of the dark (S2.10) gives it a price |
| DF-36 | Money, cargo and intel are bare lists in the sim state (`money`, `cargo`, `intel`). Money starts at 120 (`START_MONEY`) and only bribes spend it; cargo from a surrender is a name and a count, not a good; intel is a sentence nobody reads. No salvage from a wreck. The jump drive only works in a fight, and only to leave it. | Stage 3 (run, map, jumps), Stage 7 (goods, economy) | Open |
| DF-37 | Enemy crew stay on their own ship and only fight fires, patch and repair. They never board, and our crew cannot reach them. | S2.4 (boarding) | Closed in S2.4 (D-060 to D-064) |
| DF-38 | Boarding placeholders: captured boarders vanish (no brig, no prisoners to question or ransom); melee ignores skills and traits; the docking tube is instant to attach and cannot be cut; a boarder walking through a room never stops to fight; the duel bot's boarding parties lose most fights hand to hand (2 against 3). | Stage 4 (skills, traits), Stage 3 or 7 (brig, prisoners), combat rework session (tube, numbers) | Open |
| DF-39 | Decks placeholders: the lift car has no state of its own (it is drawn with whoever rides it, and a powered ride is just a faster leg); crawling is a 2.5 s hop between two rooms that share a wall, not a long tunnel; nothing blocks a crawlway (no hatches to shut, no creature yet); "engineer" is a flag on Dace (D-072); enemy ships are still plan views drawn as sensor returns, not decks. | S2.8 (the hold), S4.1 (engineer from skill), S6.1 (creature, hatches), S2.5 (enemy ships redrawn if needed) | Open |
| DF-40 | The monitor look is a first pass: drawn bezel, scanlines (with a Scanlines switch), Margo's face as a camera eye in CSS, stencils and crates drawn in code. The sensor inset shows every enemy room and its hazards, with a sweep that does nothing yet. | S2.7 (sensors resolve the return, D-074), S11.1 (look pass) | Narrowed in S2.7: the return starts as static and resolves room by room; the sweep is still decoration. The look is still a first pass |
| DF-35 | A room's hull integrity, worn by hits, never comes back: patching closes the breach but not the wear. The flash and shake are placeholders (a filled rectangle, a red screen edge, a fixed wobble); no sparks or debris. | Stage 3 (repairs at port), S11.1 (look pass), S11.3 (juice) | Open |
| DF-41 | Senses placeholders: sensors cover the whole of our ship or none of it (no per-room cameras, no sensor damage short of losing the bar); crew in the dark work at full speed and feel no fear; an enemy with no sensors room scans with a built-in gain of 0.8; enemy captains never run dark or switch their own lamps; the lock and the scan ignore range and bearing; Margo is never wrong about what she sees, only blind; the 24 new Margo lines are placeholders. | S2.10 (crew refuse the dark), S2.5 (enemies that run dark, balance), Stage 5 (Margo uncertain or wrong), Stage 6 (creature reads `sense()`, per-room sensor cover) | Open |

---

## Decisions

### D-001 Simulation is DOM-free (Stage 1)
**What:** Everything in `src/sim/`, `src/ai/`, `src/narrative/` and the RNG runs in plain Node with no `window` or `document`. Rendering, UI and audio only read sim state and send commands.
**Why:** The brief requires headless batch autoplay (§19). Keeping the sim pure also keeps saves simple and makes tests fast.

### D-002 Fixed 20 Hz sim tick (Stage 1)
**What:** The sim clock steps at 50 ms. Rendering runs at display rate and interpolates between sim states.
**Why:** The brief needs one fixed-timestep clock (§7). 20 Hz is enough for crew movement, fire and combat at this scale, and leaves frame budget on an iPad. Revisit only if movement looks steppy after interpolation.

### D-003 Commands in, events out (Stage 1)
**What:** UI and bot talk to the sim only through a command queue. The sim emits typed events on a bus. AI lines, memories, the run log, auto-pause, audio and the run summary all subscribe to the bus.
**Why:** It gives pause queuing for free (commands wait for the next tick), lets the bot use exactly the same interface as a player, and gives every later stage one place to hook in.

### D-004 One condition/effect language (Stage 3)
**What:** Events, scenes, AI lines, contracts and traits share one small JSON condition/effect DSL, introduced in S3.3 and validated by the content checker.
**Why:** Four separate condition formats would be four sets of bugs and four checkers.

### D-005 Seeded RNG with named substreams (Stage 1)
**What:** One seeded PRNG per subsystem (`map`, `combat`, `crew`, `events`, `ai`, `threat`, `market`), all derived from the run seed. `Math.random()` is banned and the checker lints for it.
**Why:** Seeds stay useful for bug reports even after code changes add rolls to one system.

### D-006 Content as JSON with two loaders (Stage 1)
**What:** All content is JSON under `content/`. The browser loads it via Vite `import.meta.glob`; Node (checker, autoplay, tests) loads it from disk. The engine never imports a content file by name.
**Why:** JSON is easy to validate and diff, and dropping a new file into a folder is enough to add content (brief §4).

### D-007 Tests and CI (Stage 1)
**What:** Unit tests use Node's built-in `node:test` (no test framework dependency). Touch and layout tests use Playwright with iPad emulation. GitHub Actions runs tests, the content checker, an autoplay batch and the build on every PR.
**Why:** Keeps dependencies minimal while making the brief's "each stage ends with checker passing and autoplay with no crashes" an automatic gate rather than a habit.
**Note:** Emulation does not replace a real iPad; real-device checks happen at the end of Stages 1, 6 and 11.

### D-008 Project scaffolding lives in Stage 1 (Stage 1)
**What:** Scaffolding, RNG, content loader, checker skeleton, autoplay skeleton and CI are the first session of Stage 1 (S1.1), not a separate stage.
**Why:** Keeps the brief's 11 stages intact while making sure the tools needed for every stage's exit gate exist from day one.

### D-009 AI lines are also written in Stages 6 to 9 (departure from brief §9)
**What:** The brief says to spread AI writing across Stages 5 and 10. The plan writes the first 1,000 in Stage 5, then adds lines for each new system in the stage that builds it (S6: 250, S7: 220, S8: 120, S9: 150), and the remaining ~1,540 in Stage 10.
**Why:** Creature, economy, scene and past-run lines are much easier to write well, and to test, when their system exists. It also makes Stage 10 smaller. Stage 10 still carries the bulk.

### D-010 Contract type order (Stage 3 onward)
**What:** S3 builds Smuggling, Courier and Salvage claim. Prisoner transport comes in S4, Specimen haul in S6, Rescue in S10.
**Why:** Each type arrives when the systems it depends on exist: prisoners need crew opinions and the brig, specimens need the creature, rescue needs survivors with infection and traitor hooks.

### D-011 Saves are versioned snapshots (Stage 3)
**What:** A save is a JSON snapshot of sim state plus RNG state with a `schemaVersion`, migrated forward on load. Export/import is that JSON compressed and base64-encoded.
**Why:** The build runs across many stages and sessions; old saves must keep loading.

### D-012 Names: the AI is M.A.R.G.O.; factions provisional (Stage 1, revisit Stage 7)
**What:** The ship AI is **M.A.R.G.O.** (Manifest Audit and Route Guidance Operator), a salvaged company cargo-custody intelligence. The crew calls it **Margo**, which also happens to be what's left of the ship's name, *Margin of Error*. Name confirmed by Eric on 2026-11-15 (he asked for an acronym). Factions use the brief's working descriptions (Receivers, miners' union, religious order, pirate confederation, research collective) as internal ids; final names are chosen in S7.4.
**Why:** Placeholder lines in Stage 1 need something to call the AI, and ids need to be stable even if display names change. Display names live in content, so renaming later is a content edit.

### D-013 Session and PR rhythm
**What:** One PR per session, each passing the green gate (see PLAN.md §0). Stage notes and autoplay reports at the end of each stage.
**Why:** Small reviewable steps that are always playable.

### D-014 Preview deploys on GitHub Pages (Stage 1; departs from brief §4)
**What:** The game is published to GitHub Pages from a `gh-pages` branch that `.github/workflows/pages.yml` maintains. `main` goes to `https://erimid.github.io/cold-manifest/` and each pull request goes to `https://erimid.github.io/cold-manifest/pr/<number>/` (removed when the PR closes). PR descriptions link the preview so Eric can test on his iPad.
**Why:** Eric asked for github.io instead of Cloudflare on 2026-11-15. The brief names Cloudflare Pages as an example and requires only static output that works on any static host; the Vite build uses a relative base, so it still deploys to Cloudflare or anywhere else unchanged.
**Note:** GitHub Pages has no built-in per-PR previews, so the workflow builds them as subfolders. Pages must be switched on once in the repo settings (source: `gh-pages` branch, root folder).

### D-015 Content file shape (S1.1)
**What:** Every content file is `{ "items": [ { "id": ... }, ... ] }` in the folder for its type (`content/ai-lines/`, `content/events/`, ...). Ids are lowercase with `.`, `_` or `-` separators and are unique per type. AI lines carry `category`, `text`, and optional `weight`, `conditions`, `placeholder`. Category ids and targets live in `src/ai/categories.js`.
**Why:** One shape for every type keeps the loader and checker simple. Extra top-level keys such as `note` are allowed for comments, since JSON has none.

### D-016 Coverage is reported, not enforced, until Stage 10 (S1.1)
**What:** `npm run check` fails on invalid content and on any `Math.random` in `src/` or `tools/`. Coverage below target is printed but does not fail. `npm run check -- --strict` also fails on missed targets and leftover placeholder lines.
**Why:** The brief requires the checker to pass at the end of every stage, long before the library reaches its targets. `--strict` becomes the CI default at the end of Stage 10.

### D-017 Exact-wording duplicates are checked now; near-duplicates in S5.1 (S1.1)
**What:** The checker already rejects AI lines whose wording matches after slots, case and punctuation are stripped. Fuzzy near-duplicate detection is built in S5.1 with the real library.
**Why:** The exact check is cheap and enforces the "slots add context, not count" rule from the first line written. Fuzzy thresholds need real lines to tune.

### D-018 The sim is a stub until S1.2 (S1.1)
**What:** `src/sim/sim.js` only has a tick counter and one seeded drifting value (`reactorDrift`). Autoplay checks no crashes, invariants, and exact replay from the seed, with no bot decisions.
**Why:** S1.1 is about proving the pipeline end to end. S1.2 replaces the stepping with the real clock, pause and command queue; `reactorDrift` goes when the reactor exists (S1.4).

### D-019 Node 22 and DOM buttons (S1.1)
**What:** Node 22 or newer is required (`.node-version`), because `node --test` with a glob needs it. Menu buttons use ordinary DOM click events for now.
**Why:** S1.2 builds the input module and decides how DOM UI and canvas taps are routed through it; nothing in S1.1 touches the canvas.

### D-020 How pause works (S1.2)
**What:** `src/engine/clock.js` is the only caller of `sim.step()`. While paused it calls nothing, so nothing simulated changes, and the render interpolation freezes too. Orders go through `sim.enqueue()` and are applied at the start of the next tick, so orders given while paused wait and start on resume; the queue is part of the save. A stall is capped at 5 ticks per frame (the game slows instead of racing). The clock only runs on live screens. A pause requested from inside a tick stops the clock before the next tick (for auto-pause).
**Why:** Brief §7 asks for this to be defined once and never broken. Unit tests and the autoplay bot both assert that the state hash does not change across paused frames.

### D-021 Test bay and probes are temporary (S1.2)
**What:** The sim holds three "probes" that move around an empty bay, and a Test bay screen exercises the clock and input. Neither is part of the game.
**Why:** The clock, command queue, interpolation and touch input needed something real to act on before the ship exists. S1.3 replaces the bay with the ship view and S1.6 replaces probes with crew; the browser tests are rewritten against the ship then.

### D-022 Input rules (S1.2)
**What:** `src/engine/input.js` is the only file that listens to pointer or keyboard events. DOM controls are registered with `input.press(element, fn)` (via `el(..., { press })`), not click listeners. A press that starts on DOM UI never reaches the canvas. Tap thresholds: 6 px mouse, 8 px pen, 12 px touch. Long-press: 450 ms. Hit padding: 2 px mouse, 6 px pen, 14 px touch; a point inside a target always beats a near miss. Right-click and long-press both produce the same `info` event. Space always pauses, even when a button has focus; Enter presses the focused control.
**Why:** Brief §4. The numbers are starting values to tune on a real iPad.

### D-023 Browser tests (S1.2)
**What:** `npm run test:e2e` drives the built site with Playwright on an emulated iPad (touch) and a desktop (mouse, keyboard). Playwright is not in `package.json`; CI installs a pinned version in its own job, and local runs use a globally installed one.
**Why:** Keeps `npm ci` small and avoids a second browser download on machines that already have Playwright. Emulation does not replace a real iPad (D-007).

### D-024 Ship layout format (S1.3)
**What:** A ship is one item in `content/ships/`: rooms as whole-tile rectangles, doors as a point on the wall two rooms share (or `"b": "space"` for an airlock), vents as room-to-room links, and a hull outline. `src/sim/ship.js` validates it (no overlaps, doors on shared walls, every room reachable, every system in exactly one room, at least one airlock) and builds the graphs. The content checker runs the same validation. Corridors are rooms with `kind: "corridor"`; the bridge is `kind: "helm"` and holds no system, since the brief's system table has none for it.
**Why:** Stage 9 adds two more ships, so the format has to be content from the start. The *Margin of Error* has 15 rooms, 17 interior doors, 4 airlocks and 9 vents.

### D-025 Door state lives on doors (S1.3; clarifies brief §6)
**What:** The brief lists "a door state" among each room's values. Doors here are their own objects between two rooms, each with a state (open, closed, locked, jammed) and an `openness` from 0 to 1 that slides over 0.35 s. Air, crew and the creature will read `openness`.
**Why:** A door belongs to two rooms; storing its state on either would duplicate it.

### D-026 What a tap on the ship does (S1.3)
**What:** Tapping a room selects it and shows its status. Tapping an interior door selects it and toggles it open or closed. Tapping an airlock or a locked door only selects it: those are worked from the status panel. A jammed door refuses everything.
**Why:** Brief §18 asks for door control by tapping a door. Airlocks kill, so they need a deliberate second press (and brief §7 worries about a slip of the finger).

### D-027 Hit-test priority (S1.3; replaces the rule in D-022)
**What:** Among targets within reach of a pointer, the highest priority wins (crew over doors over rooms) even on a near miss; within one priority, inside beats a near miss, then nearest edge, then smallest. D-022 originally said a point inside any target always beat a near miss.
**Why:** A door sits on a room's wall, so every near miss on a door is inside a room. Under the old rule touch padding could never help with doors, which are the smallest targets on the ship. Caught by the browser test.

### D-028 Rendering split (S1.3)
**What:** `src/ui/ship-render.js` draws hull, floors, walls and stencils once to an offscreen canvas, and lighting, doors, fire, frost and alarms on top each frame. Animation runs on game time, so flames and alarm pulses freeze on pause. Alarms pair colour with a shape and letter (triangle F, diamond B, circle O); locked doors carry a pip and jammed doors hazard stripes.
**Why:** Performance on iPad, the pause rule, and the brief's colourblind requirement (§17).

### D-029 Power model (S1.4)
**What:** Every system has a `level` (bars it can take), `damage` (bars broken) and `power` (bars routed), all whole numbers. The reactor's level is its output; its damage cuts supply. Eight systems take power (shields, engines, weapons, life support, doors, sensors, medbay, AI core); cargo, quarters and brig do not. Orders move one bar at a time (`power.add` with delta 1 or -1) so two quick presses can never overdraw. Starting levels and routing are ship content (`power` block in `content/ships/`); the *Margin of Error* makes 8 bars and starts with all 8 in use.
**Why:** Brief §6. Whole bars keep the choice legible on a small screen and make "power never exceeds supply" an exact check.

### D-030 Lights and brownouts (S1.4)
**What:** Lights draw from the same pool: one bar per 5 lit rooms, rounded up (`lightsPerBar` in ship data). A room cannot be lit if that needs a bar that is spent. When supply falls below use, the ship sheds one bar at a time in a fixed order: weapons, shields, sensors, medbay, engines, lights (rooms go dark from the end of the room list), doors, AI core, life support last. Power never returns by itself after a repair; the player routes it back.
**Why:** Brief §6 ("lights draw power too"). A fixed order is deterministic and lets the player learn what a reactor hit will cost.

### D-031 Doors without power (S1.4)
**What:** With no bar on door control, a door moves only if a living crew member is in a room on either side of it, and it moves slowly (1.2 s instead of 0.35 s). Locks are electric: no locking or unlocking without power, so locked doors stay locked. A door order given with power is dropped if the power is gone when it starts.
**Why:** Brief §6 ("without power, doors must be opened by hand"). Locks holding through a power cut gives the brig and the creature stage something to lean on. See DF-16.

### D-032 Power keys are the Q row, not number keys (S1.4; departs from PLAN S1.4)
**What:** Q W E R T Y U I add a bar to the eight power tiles in panel order; Shift with the key takes one back. The key hints hide on touch-only devices. On touch each tile has its own minus and plus buttons, 44 px or larger.
**Why:** The plan said number keys, but brief §18 gives number keys to crew selection (S1.6). One tap per bar with separate minus and plus avoids any long-press or right-click on the most-used control in a fight.

### D-033 Refusals are shown, not swallowed (S1.4)
**What:** When the ship refuses an order (no spare power, door control dark), the status panel shows the sim's own reason for a couple of seconds. Disabled buttons cover the cases that are obvious from the panel; door buttons stay pressable when door control is dark so a press can explain itself.
**Why:** A tap that does nothing reads as a broken touch screen.

### D-034 Air model (S1.5)
**What:** `oxygen` is how full of breathable air a room is, 0 to 1, and bigger rooms hold more. Each tick: life support adds a flat amount per bar to every room (or the air goes slowly stale without it), air evens out through open doors in proportion to how far they are open, an open airlock empties its room in a few seconds, and a breach drains its room at a rate set by its size. The rates are named constants at the top of `src/sim/atmosphere.js` and are starting values to tune by play.
**Why:** Brief §6. Room-level air (no per-tile gas) is enough for doors to matter and cheap enough to run thousands of bot ticks a second.

### D-035 Fire (S1.5)
**What:** Fire is an intensity from 0 to 1. It burns oxygen, grows in good air, starves below 12% and is out at once at zero. It heats the room, makes noise, breaks one bar of the room's system for every 15 seconds of full-size fire, and hurts anyone in the room (a suit halves that). Each tick it may jump to a neighbouring room: readily through an open door, at 4% of that rate through a shut one, never into a room with too little air to catch. Spread uses the seeded `hazard` RNG stream. With life support running, a small fire is fed faster than it burns, so a closed door alone will not kill it: vent it, cut life support to it, or (from S1.6) send someone.
**Why:** Brief §6. Closed doors as firebreaks and venting as the sure cure give the player door and power decisions rather than a timer.

### D-036 Jettison (S1.5)
**What:** Rooms flagged `jettison: true` in the ship data can be cut loose: on the *Margin of Error* that is cargo, brig, door control, shields, weapons, medbay, quarters and sensors. The reactor, engines, life support, AI core, bridge and corridors cannot. Every interior door into the room must be fully shut first. The room is then gone for good: no air, no fire, no lights, its system lost and unrepairable, its doors welded, anyone inside dead whatever they are wearing. The button takes two presses within four seconds.
**Why:** Brief §6 calls it a last resort that loses whatever is inside. The spine of the ship stays so a run cannot be ended by a single press; losing door control or weapons is survivable and costly.

### D-037 Tick order (S1.5)
**What:** Each tick runs orders, then air and fire, then power, then doors, then lights.
**Why:** Fire can break a system mid-tick, so power must settle after it or a broken system would hold power for a tick. The autoplay bot caught this.

### D-038 Crew model for Stage 1 (S1.6)
**What:** A crew member is an object in `state.crew` with a room, a position in tiles, health, a suit flag, a goal room, a list of waypoints and a current task. The roster comes from content (`content/crew/`) and the ship data says where they start (`crewStart`). Stage 4 adds skills, traits, needs, stress and memory to the same objects.
**Why:** Brief §8 starts every run with three crew. Keeping them plain data means saves, replays and the bot work with no extra code.

### D-039 Movement and doors (S1.6)
**What:** `crew.move` sends someone to a room. The route is the fewest doors through the room graph, never through an airlock, a locked or sealed door, or a door jammed shut. Crew open shut doors themselves and close behind them only the doors they opened; a door the player left open stays open. With door control unpowered they still get through, at the slow hand-worked speed. If a door on the way is locked while they walk, they go round, or stop and raise `crew.blocked` if there is no other way. A move with no route is refused up front with the reason. Walking speed is 3 tiles a second, 0.7 of that in a suit.
**Why:** Brief §6 and §18. Closing doors behind them keeps crew from spreading fire and bleeding air by walking around, which would make door control pointless.

### D-040 Crew work without being told (S1.6)
**What:** Someone standing in a room with nowhere to be deals with the worst thing in it: fire, then a breach, then the room's damaged system, then a jammed door on one of its walls. With nothing to fix, a powered medbay heals whoever is in it. More hands are faster. Work is slower when hurt, in a suit (0.75) or in the dark (0.5, except firefighting). The rates are constants at the top of `src/sim/crew.js`.
**Why:** One tap on a crew member and one on a room is the whole order on a touch screen; a second menu to pick the job would be slower in exactly the moments that are already frantic. Stage 4 traits can override the priority.

### D-041 Selecting crew (S1.6)
**What:** Tap a crew member on the ship or in the crew bar, or press their number key, to select them; do the same again or press Escape to let go. While someone is selected, tapping a room sends them there and they stay selected. Doors still toggle on a tap. With nobody selected, tapping a room shows its status as before. Crew sit above doors and rooms in hit-test priority.
**Why:** Brief §18. Keeping the selection after an order lets the player redirect quickly; room status is one Escape away.

### D-042 The AI voice box (S1.7)
**What:** Game events ask for a line by trigger (`run.start`, `idle`, `crew.ordered`, `power.brownout`, `crew.hurt`, `fire.started`, `breach.opened`, `room.jettisoned`, `crew.died`). Each trigger has a category, a priority, a time-to-live, a cooldown and a chance, in one table at the top of `src/ai/voice.js`. Requests wait in a queue of at most six, highest priority first. One line is on screen at a time and is never cut off; a request that has waited past its time-to-live is dropped unsaid. Lines are picked with the `ai` random stream, avoiding recent repeats, and the queue, cooldowns and log are part of the saved state. With the AI core unpowered Margo says nothing. The box types the line out; the Log button shows the last 60 lines. Placeholder hazard lines name their trigger in `conditions.trigger`.
**Why:** Brief §9: lines must never overlap and a stale line is worse than silence. Keeping the choice inside the sim makes what she said part of the replay and lets the bot count lines.

### D-043 Sound (S1.7)
**What:** `src/audio/engine.js` plays patches that are plain data (`src/audio/patches.js`): oscillators and filtered noise with an envelope, no audio files. Sound starts on the player's first tap, click or key, because browsers require that. A table maps game events to patches. The reactor hum loops while the ship screen is up and drops when the game is paused. The engine takes its audio context as a parameter, so tests run it against a fake with no browser. Noise is generated from the seeded generator.
**Why:** Brief §4 and §15: data-defined placeholder sound now, real sound in Stage 11 by swapping the patch table.

### D-044 Auto-pause and settings (S1.7)
**What:** The game pauses itself when a fire starts, a breach opens or a crew member dies, and the pause button says why. Each has its own switch in Settings. On a touch screen all three default to on; with a mouse and keyboard they default to off, since the space bar is right there. Settings are kept in the browser's local storage under `cold-manifest.settings.v1`, not in the save. `?autopause=0` and `?sound=0` in the address override them for tests.
**Why:** Brief §7 and §18: touch players cannot hit a space bar in a hurry. Settings belong to the device, not the run.

### D-045 Debug additions (S1.7)
**What:** With `?debug=1`: a Step button advances one tick while paused, a Hurt button on the crew panel halves the selected crew member's health (`debug.crew`), and the overlay lists crew alive, fires, Margo's line counts and the sound state. These join the earlier room, door and system controls.
**Why:** PLAN.md §4: every system gets a debug control in the session that builds it.

### D-046 Autoplay v1 (S1.7)
**What:** Each seed is now played two ways, each twice to prove it replays: ten minutes of random orders (chaos), and a five minute hazard scenario that starts with seeded fires and breaches and a bot that tries to save the ship. The run fails on a crash, a bad number, a broken invariant, a door or crew member stuck, or anything moving while paused. `--report FILE` writes the summary; `reports/stage-1.md` is the Stage 1 report.
**Why:** Stage 1 exit check. Chaos finds crashes; the scenario shows the hazards can actually be beaten.

### D-047 A fight is two whole ships (S2.1)
**What:** In a fight the enemy is a complete ship held in `state.fight.enemy`: rooms, doors, systems, air, fire, crew, the same shape as the player's. `enemyOf(sim)` wraps it so every ship function (air, fire, power, doors, lights, crew) runs on it unchanged, on the same tick, after the player's ship. What happens aboard it is announced as `enemy.<event>` so our alarms, auto-pause and Margo are not triggered by their fire. An enemy ship is a normal ship file with `"enemy": true`, which lets it leave systems out, carry no crew and mount no weapons. Ship state is built by one function, `newShipState`, for both sides.
**Why:** Brief §7 wants their ship as a cutaway you target room by room, and S2.2 needs hits to cause fires and breaches with the exact Stage 1 code. One code path for both ships means boarding (S2.4) and enemy crew need no second simulation.

### D-048 Weapons, shields and evasion (S2.1)
**What:** Weapons are content (`content/weapons/`): power needed, charge time, flight time, damage, shield layers ignored, and effect chances for S2.2. A ship lists its hardpoints (2 to 4) and the weapons fitted to them. The weapons system's bars are dealt to weapons in hardpoint order; a weapon with its bars charges, one without drains at twice the rate. A charged weapon with a target fires by itself and recharges. The shot is in the air for its flight time, then: it misses (the target's evasion), a shield layer stops it and drops, or it hits and takes hull points. Shields hold one layer per bar routed to them and regain a layer every 6 seconds. Evasion is 0 with engines unpowered, otherwise 5% plus 6% per engine bar plus 8% with someone alive at the helm, capped at 45%. At 0 hull points the fight is decided and the guns stop.
**Why:** Brief §6 and §7. Every number the player fights with comes from a power bar, which keeps routing power the main decision. Automatic fire means a touch player aims once and then manages the ship.

### D-049 Fight controls and layout (S2.1)
**What:** In a fight the enemy ship stands bow-up in a column on the right (27% of the width) and a weapons bar appears above the status panel with our hull, shields and evasion, one tile per weapon, and theirs. Tap a weapon tile (or press A, S, D, F), then a room on their ship, to aim it; the weapon stays selected to change its mind, and Hold fire clears the target. Tapping their room with no weapon picked shows that room. It all works paused, as queued orders. Shots, shield hits, hits and misses are drawn with a word as well as a colour. Enemy ships are drawn tall so the column can be narrow.
**Why:** Brief §7 and §18: target their rooms, works paused, and nothing relies on colour alone. A narrow column keeps our own ship large enough to keep tapping doors and crew mid-fight.

### D-050 Autoplay in fights (S2.1)
**What:** The chaos bot now picks fights, aims at random, sets fires aboard the enemy and walks away. A third mode, target practice, puts the drone alongside and has a bot feed and aim the guns; it fails if the drone survives five minutes. The report gains fight lines.
**Why:** PLAN.md §4: the bot grows with each system. S2.1's done-when is "the player can charge and fire at a dummy target ship", and this proves it for 100 seeds.

### D-051 What a hit does (S2.2)
**What:** A shot that gets past evasion and shields takes hull points and wears the room (`room.hull`), then: breaks one bar of the room's system per point of damage (power on it lets go in the same tick, D-037); may start a fire (`effects.fire`, only where there is air for one to catch; a hit on a burning room feeds it); may hole the hull (`effects.breach`, plus 0.6 times the room's lost integrity, so lasers never hole a sound room but often hole a battered one); and may hurt each person in the room (`effects.crew` each, 0.2 health per point of damage). All rolls are on the `combat` stream and are made whatever the room holds, so one change does not reshuffle a seed's fight. A hit only sets `fire` or `breach` on the room: the Stage 1 code in `atmosphere.js` announces and runs it from there, and crew harm goes through `harmCrew`, the same function bad air and fire use. A test proves a fire or breach from a hit plays out tick for tick the same as one set by hand. The numbers are in `HIT` at the top of `combat.js`.
**Why:** Brief §6 and §7, and S2.2's done-when: hazards from hits use the exact Stage 1 code. One system bar per point of damage keeps the result easy to read on the power panel.

### D-052 Hits are shown, not just counted (S2.2)
**What:** A hit flashes the room it lands in, and the label under the result says what it did (`HIT 2`, then `SYS -2  FIRE  BREACH  CREW`). A hit on our ship shakes the screen (more for heavier hits) and flashes the screen edge red. The shake runs on game time and stops while paused; it is a fixed wobble, not dice. A hit on our ship raises `hull.hit` (Margo has three placeholder lines for it); one on theirs raises `enemy.hull.hit`, and she sometimes remarks on it (`combat_progress`, three placeholder lines).
**Why:** Brief §17 (screen shake, impact flashes) and §7. Words beside colour keep the colour-blind rule.

### D-053 Auto-pause on fight start; screen shake switch (S2.2)
**What:** A fight starting pauses the game and the pause button names the ship ("Gunnery drone alongside"). Like the other auto-pauses it has its own switch, on by default on touch and off with a mouse. Settings also gain a Screen shake switch (on by default), ahead of the accessibility pass, because brief §17 asks for a way to turn shake down and shake now exists.
**Why:** Brief §7 lists fight start first among the auto-pause options.

### D-054 Debug hits and the under-fire bot (S2.2)
**What:** `debug.hit` lands a shot at once on either ship (`at: 'us' | 'them'`), on a named room or a random one, through the normal miss / shield / hit rules, or as a sure hit with `force`. The debug bar's Hit us button strikes our selected room (or any room) with the heaviest gun we carry. The chaos bot now uses it instead of poking the enemy's rooms directly. Autoplay gains a fourth mode, under fire: unforced shots land on our ship every 6 to 13 seconds for two minutes, then the hazard bot has three minutes to clean up. The hazard bot now also gives power back to systems after repairs (air first), since nothing else does (D-030).
**Why:** Enemies do not shoot back until S2.3, and S2.2's hits on our ship still need proving: the bot shows the hazards they cause can be beaten.

### D-055 Enemy captains (S2.3)
**What:** An enemy ship file names an archetype in `tactics` (`drone`, `gunner`, `raider`, `tank`, `boarder`; the table is in `src/sim/tactics.js`). Every half second its captain routes power down the archetype's list (taking bars from the bottom when the top needs one, engines first when running), aims its guns at our rooms by the archetype's weights on a new `tactics` random stream, and works its crew: the first living one holds the helm and the others go to the worst trouble aboard, suited for a breach, then back to their posts. It gives the same `power.add`, `crew.move` and `crew.suit` orders a player gives, applied straight to its own ship. Captains fire all their powered guns together, so one layer of shield cannot stop every shot, and pick a fresh room after each shot. An enemy ship lists its own `crew`.
**Why:** Brief §7 ("they do the same to you") and the plan's "power and targeting by archetype". Reusing the player's orders means enemies cannot do anything the player cannot, and S2.5's four types are new data, not new code.

### D-056 The hail, talking and bribes (S2.3)
**What:** An enemy with a `hail` opens the fight talking: nobody fires (guns may charge and be aimed) until we open fire, a talk fails, or 30 seconds pass. A card above the weapons bar shows what they say, with Talk (one try, chance shown on the button), Pay (their price, refused if we cannot afford it) and Open fire. Money is `state.money`, 120 at the start. The talk chance is the ship's `hail.talk` adjusted by a placeholder negotiation value (DF-06).
**Why:** Brief §7: talk or bribe your way out before shooting starts. Showing the odds on the button keeps a touch player from guessing.

### D-057 Surrender, running and jumping (S2.3)
**What:** A crewed enemy at or below `surrender.at` of its hull offers once to give up: money, cargo or information, rolled from its list. It holds fire while the offer stands (30 s). Accept takes the offer and ends the fight; Refuse, or silence, and it fights on. Below `flee.at` it runs: engines first, and when its drive is charged it is gone. Both ships have a jump drive that charges by engine power with someone at the helm: 60 engine-bar seconds (60 s on one bar, 30 s on two). Our Jump button shows the charge and jumps us out when it is full. The drive starts empty in each fight and does nothing outside one until Stage 3.
**Why:** Brief §7's endings. Surrender comes before running (the checker enforces `flee.at` below `surrender.at`) so the player sees an offer before the enemy tries to escape.

### D-058 Nine endings, and the stalemate rule (S2.3)
**What:** Every fight ends through `decide()` in one of nine ways (`OUTCOMES` in `combat.js`): destroyed, lost, crew dead, surrendered, escaped, fled, talked down, paid off, or broke off. An ending stops every gun, clears shots in the air and is announced as `fight.over`, plus `fight.won`, `fight.parted` or `fight.lost` for Margo. The stalemate rule: once shooting has started, 90 seconds with no hull point lost on either side ends the fight as broke off. Hull points never come back mid-fight, so a fight lasts at most 90 seconds per hull point on both ships. The debug sheet (More, with `?debug=1`) starts a fight with any enemy and has a button that leads to each ending.
**Why:** Brief §7 and the plan's done-when: every ending reachable from the debug panel, and no fight runs forever. A unit test and a browser test walk through all nine.

### D-059 Duels replace target practice in autoplay (S2.3)
**What:** Each seed now fights every enemy in turn against a duel bot. The bot answers a hail (shoots 70% of the time, talks 20%, pays 10%), turns off the lights it does not need to free a bar, feeds guns, then shields, then engines, holds fire until all its guns are charged and then fires them together at their shields (then at their guns once the shields are broken), keeps someone at the helm, sends the others to trouble, takes 75% of surrenders and jumps out below 30% hull. A duel still going after eight minutes is a failure. The chaos bot also tries every new order and debug ending at random, and the report counts how chaos fights ended.
**Why:** PLAN.md §4: Stage 2's bot plays seeded fights against each enemy type. Two enemies times 100 seeds is the stage's 200 fights.

### D-060 Boarding by docking tube (S2.4)
**What:** Boarding is docking, not teleporting. A crew member sent to a room on the other ship walks to the nearest airlock on the ship they are on, spends `BOARD_SECONDS` (5) in the docking tube, comes out of the other ship's airlock nearest the room they were sent to, and walks on (`boarding.js`). Crossing onto a ship needs its shield layers at 0 and the battle phase; crossing home is always open. Nobody gets into the tube with someone of the other side in the room. The airlock door itself is not opened, so no air is lost. The order is `crew.move` with `ship: 'us' | 'them'`; on the ship view, select one of ours and tap a room of theirs.
**Why:** Brief §7 allows teleport or dock. Docking uses the airlocks every ship already has, gives a visible walk and a window to react in, and makes shields the thing that keeps boarders out. A teleporter can be a system later if the rework wants one.

### D-061 Whose crew, not which ship (S2.4)
**What:** Every crew member has an `owner` ('player' or 'enemy') and is held in the crew map of the ship they are aboard; they move between maps when they cross. News about a crew member (hurt, died, ordered, arrived, boarded) is announced by owner, so `crew.died` is always one of ours, wherever they died, and `enemy.crew.died` always one of theirs. Only a ship's own crew can pilot it, repair it or be healed by its medbay. Their crew are renamed `foe-<id>` if an id clashes with ours. `findCrew` and `ourCrew` in `combat.js` find people on either ship.
**Why:** Margo should mourn our dead aboard their ship and not their dead aboard ours; auto-pause and the crew bar follow the same rule. Moving the objects keeps every ship function working on "the crew aboard" without a second notion of position.

### D-062 Hand to hand and sabotage (S2.4)
**What:** In any room, anyone not walking or in the tube fights the other side's people there: each hits the weakest, taking `(0.5 + 0.5 × own health) / MELEE_SECONDS` (14 s) of health a second. A boarder alone in a room with a system breaks a bar every `SABOTAGE_SECONDS` (9 s, slower when hurt) and fixes nothing. Brief §7's stats and traits that decide who wins wait for Stage 4 crew skills.
**Why:** Simple, deterministic and readable: two on one wins, a hurt fighter loses. The numbers are first guesses for the combat rework session.

### D-063 Enemy boarding parties (S2.4)
**What:** A ship whose `tactics` has `board: { party, after }` sends `party` of its fittest crew (never the first, who holds the helm) once the shooting has gone on `after` seconds (default `BOARD_AFTER_SECONDS`, 20), our shields are down and nobody of theirs is already across. Aboard us they head for rooms by the archetype's target weights, move on when a system is wrecked, and go home below 35% health, when running, or while an offer stands. Their crew at home treat boarders as the worst trouble (4 per boarder). The salvager skiff sends two.
**Why:** The plan's boarding enemy type arrives in S2.5; the skiff gives the code a real user now. The 20 s wait is because our shields start unpowered: without it they boarded in the first second.

### D-064 Boarders when a fight ends (S2.4)
**What:** On every ending but `lost`, ours come home, except from a ship that is destroyed: they die with it (cause `wreck`) and their bodies come back on our roster. Theirs go home if the ending lets their ship take them (surrendered, talked, bribed, stalemate, or the fight dismissed); otherwise (destroyed, crew dead, they fled, we escaped) they are captured: removed, with a `crew.captured` event. We cannot jump with one of ours aboard them or in the tube. The crew-dead ending counts their crew on both ships.
**Why:** "Don't be aboard when it blows" is easy to understand. Prisoners need a brig and the run structure, so for now they are only an event (DF-38).

### D-070 Stage 2 grows to set the game apart from FTL (plan change, 2026-11-16)
**What:** After playing S2.3, Eric said the game seemed "almost exactly like FTL". He approved five new sessions: S2.6 decks and Margo's monitor, S2.7 visibility and running dark, S2.8 brace, ammo and the hold, S2.9 breaker board and intercom, S2.10 Margo pushes back and crew refuse. S2.5 runs after S2.9 so it balances the new rules. Run order: S2.4, S2.6, S2.7, S2.8, S2.9, S2.5, S2.10. S2.10 pulls forward Margo's personality file and voice sample (S5.1), trust, arguing, refusals and override (S5.3), and a small memory log with crew refusal (S4.3, S4.5); those later sessions now extend what S2.10 builds, and S3.3 ports its hard-coded rules into the DSL. Plan size goes from about 75 to about 80 sessions.
**Why:** Brief §3 makes copying FTL's look, UI or exact rules a failure even if the game works. Stages 1 and 2 had followed FTL's shape closely (top-down room row, power-bar strip, enemy cutaway on the right, one shield layer per bar, evasion from engines plus a pilot, charge-then-fire guns, a charging jump drive). The game's own pillars (crew who remember, Margo's voice, something aboard, the smuggler's hold) were all scheduled for Stage 4 or later.

### D-071 The ship is drawn side-on as stacked decks (departs from brief §6, §17, §18)
**What:** From S2.6 the ship view is a side elevation: decks stacked vertically, joined by corridors, ladders and a lift that needs power (with it off, crew use ladders). The *Margin of Error* becomes a hauler that is mostly cargo hold. The sim keeps its room-and-door graph; only the layout format and renderer change, and room ids are kept where possible so saves, tests and content still line up.
**Why:** A top-down cutaway of rooms in a row is the core FTL image. Decks also give the creature ceilings and floors to move through and make a trip from the hold to the guns a real distance.

### D-072 Service crawlways replace the vent network (departs from brief §6)
**What:** Narrow utility crawlways run through the whole ship. Only engineers and the creature can use them; a few narrow ducts fit the creature alone. Crawling is slow and needs both hands: no firefighting or carrying in there, but it gets an engineer past a fire, a locked door or a breached corridor to a system. Until Stage 4, "engineer" is a flag on one starting crew member; from S4.1 it comes from engineering skill or a trait. Vent grilles (brief §6 upgrades) become crawlway hatches that block the creature and engineers alike. The in-game name is "service crawlways" ("SERVICE WAY" on the hatches), with no borrowed name (brief §21).
**Why:** Eric's call (2026-11-16): narrow utility corridors that run all through the ship, used only by engineers, while everyone else uses corridors, ladders and lifts. Sharing them with the creature puts an engineer and the thing in the same tunnels.

### D-073 The screen is Margo's monitor; the enemy is a sensor return (departs from brief §7, §17, §18)
**What:** From S2.6 the ship view is drawn as Margo's monitor: a cheap company schematic on a CRT, with her portrait and voice at the centre of the screen rather than in a strip. The enemy ship is shown in an inset as a sensor return that resolves into rooms as it is scanned; you still target its rooms. Room codes painted on floors (RX, O2, MED) give way to faded company stencils, crates and pipes.
**Why:** Brief §2 makes the AI the voice you hear most; framing the ship through her makes that visible from the first second. There is no room for a full second cutaway beside a side-on hauler, Margo and the breaker board, and a full enemy cutaway on the right is FTL's layout.

### D-074 One signature model; running dark replaces evasion; the jump needs a sensor fix (departs from brief §6, §7)
**What:** From S2.7 both ships have a signature built from light, noise, heat and engine burn. A low signature makes enemy shots miss or lose lock (running dark), replacing evasion from engines plus a pilot. Our own unlit, unmanned rooms outside sensor cover show only their last-known state behind static. Enemy rooms resolve as our sensors scan them. The jump drive needs a sensor fix rather than a charge meter. Stage 6's creature reads the same model for its senses.
**Why:** Evasion from engine bars plus a helm, and a charging jump drive, are FTL's exact rules. One model shared by combat, fog and the creature ties the horror and the fights together: going dark hides you from both, but frightens crew and slows repairs (brief §6).

### D-075 Shields are a capacitor you dump as a brace (departs from brief §6, §7)
**What:** From S2.8 shield power charges a capacitor; the player dumps it as a brace to soak an incoming volley. Bracing spikes the ship's signature. Replaces one regenerating shield layer per power bar.
**Why:** One layer per bar that recharges on a timer is FTL's exact rule. A brace is a timing decision that fits pausable play.

### D-076 Heavy guns are hand-loaded from the hold (S2.8)
**What:** The slug thrower and the breaching lance take ammo crates that a crew member carries from the cargo hold. The pulse laser needs no ammo. The cargo hold becomes a place you play in: crates drawn in the hold, opened, moved and jettisoned. Hiding crates in compartments comes with inspections in S7.3.
**Why:** It makes the smuggler's hold part of every fight and gives crew a reason to cross the ship mid-fight. Laser only, so a fight never stalls on ammo alone.

### D-077 Boarding by docking, never by teleporter (narrows PLAN S2.4)
**What:** Boarders cross through a docked airlock (S2.4 built this as a docking tube, D-060), both ways. No crew teleporter.
**Why:** Crew teleporting across is an FTL signature.

### D-078 Breaker board and intercom orders (departs from brief §18)
**What:** From S2.9 a breaker board drawn as cheap company hardware replaces the bottom power strip. It opens on demand, keeps 44 px targets and the Q-row keys (D-032). Orders keep the same two taps (crew member, then room); crew answer over the intercom in their own short line and nothing waits on the reply. From S2.10 Margo argues on the intercom before risky orders, with a one-tap captain's override. Minor systems may be merged if the board needs fewer breakers; if so it is logged here.
**Why:** A strip of reactor bars with plus and minus per system is FTL's most recognisable screen. Spoken replies bring the crew forward as people (brief §2) long before Stage 4.

### D-079 Side-on layout format: decks, hatches with ladders, and a lift on door power (S2.6)
**What:** A ship file may list `decks` (bands of `y` and `h`); every room's ceiling and floor must line up with a deck's. A door on a horizontal wall is a hatch with a ladder; climbing goes at 0.4 of walking speed. A room of `kind: "lift"` is a shaft that carries crew at twice walking speed while door control has power; without it the shaft is no way through (it can still be a destination), so crew take the ladders. Routes are found by time (Dijkstra), not door count. The *Margin of Error* is four decks with 17 rooms (16 plus the lift shaft), a two-deck cargo hold, a 15-tile main hold and a cargo ramp airlock; every old room and door id is kept; `airlock_weapons` is gone and four doors are new. Crew stand on the floor.
**Why:** D-071. Time-costed routes make ladders and a dead lift matter, which a door count cannot.

### D-080 Service crawlways: short hops through a shared wall, engineers only (S2.6)
**What:** `crawlways` replace `vents`. Each joins two rooms that share a wall, with a "SERVICE WAY" hatch on each side; `creature: true` marks a duct only the creature fits. A crew member with `engineer: true` (Dace, until S4.1) may route through crawlways; a crawl takes 2.5 s plus the walk, and shows as "In a service crawlway". Nobody else ever does, and nobody uses the ducts. The Margin of Error has 10 crawlways and 2 ducts. "Show crawlways" in debug draws them.
**Why:** D-072. Keeping each crawlway a single hop keeps the room graph whole; longer tunnels can come with the creature in S6.1.

### D-081 Margo's monitor (S2.6)
**What:** The ship is drawn inside a CRT bezel ("M.A.R.G.O. schematic, company issue") with faint scanlines that a new Scanlines setting turns off. Margo's box moves directly under the schematic, with her face (a camera eye that widens and talks while she types and turns red when urgent) and her words in amber phosphor. Room codes on floors are gone: each room has a faded company stencil on its back wall ("REACTOR / KEEP CLEAR · RADIATION", "MAIN HOLD / STACK NO HIGHER THAN 3"), pipes under the ceiling, and crates in the holds. The power panel is now one row on a 1024 px screen.
**Why:** D-073. Putting Margo between the ship and the controls puts her at the centre of the screen without taking a strip away from the ship.

### D-082 The enemy as a sensor return in the corner of the monitor (S2.6)
**What:** In a fight the enemy is drawn in a small green screen inside Margo's monitor (about 29% of its width): phosphor room outlines, range rings and a sweep, labelled "Sensor return" and the ship's name. Its rooms are still tapped to aim, board or inspect. Enemy ship files are turned on their side (bow to the left, `facing: "left"`), so their rooms stay 44 px or larger in the inset; they are still plan views, not decks. Until S2.7 the return shows every room and hazard.
**Why:** D-073, and the brief's 44 px targets on an iPad at 1024×768. An upright enemy ship would not fit the inset at a usable size.

### D-083 The senses model: light, noise, heat and movement per room, one signature per ship (S2.7)
**What:** `src/sim/senses.js` is the one place that says what can be sensed. `sense(ship, roomId)` gives a room's light, noise, heat and movement, each 0 to 1, for any ship. Noise comes from fire and breaches, running systems (louder for the reactor, drive and sensors), crew walking, working and fighting, a gun firing (0.9) and a hit landing (1.0); bangs fade at 0.5 a second. A ship's signature is light 0.20 + noise 0.10 + heat 0.35 + engine burn 0.20, plus a muzzle flare of 0.15 a weapon bar that fades at 0.08 a second, capped at 1. Heat is mostly reactor load, so shedding power is the biggest lever; lamps and the drive are the next. Both ships run the same code, and the model is plain serialisable state.
**Why:** D-074. One model for combat, fog and the creature: Stage 6's creature calls `sense()` for the room it is in or next to and gets the same numbers the enemy's sensors add up. A unit test reads it the way the creature will.

### D-084 Fog on our own ship: Margo sees by sensors, light or crew (S2.7)
**What:** A room is watched if the sensors have power, or its light is 0.35 or more, or one of our crew is in it. An unwatched room keeps only what was last seen: it is drawn as static with a dashed outline and "NO EYES m:ss", and its panel shows the remembered numbers with how old they are. A fire or breach that starts unwatched raises no alarm, no auto-pause and no line from Margo; when the room is seen again the sim emits `fire.found` or `breach.found`, and those do. A fire lights its own room, so a fire is usually found by its glow; a breach in the dark stays hidden. Boarders in an unwatched room are not drawn. We always know our own lamp switches.
**Why:** D-074 and brief §6: turning the lights and sensors off has to cost information, or running dark is free. The knowledge lives in the sim (`seen`), not the renderer, so the bot, Margo and the UI all know exactly the same things.

### D-085 Scanning: the enemy resolves room by room, and only a resolved room can be aimed at (S2.7)
**What:** In a fight each ship holds a `contact` on the other. Each enemy room resolves at a rate set by our sensor gain (0.5 passive with sensors unpowered, 1.0 with one bar, +0.25 a bar after) times how much that room gives off; a bright, loud, hot room takes about 3 seconds, a dark quiet one up to ten times longer. An unresolved room is static in the sensor return, its panel reads "Unresolved return" with a percentage, and `weapon.target` on it is refused. With our sensors off the picture goes stale: resolved rooms keep their last-known state. The enemy captain obeys the same rule and aims only at rooms it has resolved. The debug sheet gains "Perfect lock", which most older tests use.
**Why:** D-074 and D-073: the enemy is a sensor return, so what we know of it should come from the sensors. It also clears DF-32's "every enemy room is visible".

### D-086 The lock replaces evasion; shots without one are fired blind (S2.7)
**What:** `EVASION` and the helm bonus are gone. Each contact has a lock from 0 to 1 that climbs toward the target's signature times our sensor gain (mapped from 0.12 to 0.6) at 0.15 a second and falls at 0.3 a second. A lock is held from 0.25 and dropped below 0.2. A shot's chance to go wide is (1 − lock) × 0.85, so a perfect lock never misses. With no lock a weapon still fires, but blind: it lands on a random room. The fight bar shows both signatures and both locks in words ("Their lock on us 43%", "They have no lock on us"), and a wild shot is labelled. Firing adds flare to the shooter's own signature.
**Why:** D-074. Evasion from engine bars and a pilot was FTL's rule; here being hard to hit is a choice about power, lamps and guns that also blinds us (D-084) and, later, hides us from the creature.

### D-087 The jump needs a sensor fix (S2.7)
**What:** The jump charge meter is gone. A ship builds a fix over 25 seconds while its sensors and drive have power and someone is on the bridge; taking a hit knocks 25% off it, firing a gun 10%, and it drains at 5% a second while the sensors are down. The Jump button reads "Fix N%", "Ready", or what is missing ("No sensors", "No pilot", "No drive"). The enemy uses the same rule to run.
**Why:** D-074. It sets running dark against getting away: the sensors and drive that build the fix are the things that light us up.

### D-088 Go dark, the ship panel, and the bot's two postures (S2.7)
**What:** A new order, `lights.all`, switches every lamp at once. With nothing selected the status panel shows the ship: signature, its four parts, whether Margo has eyes, and a Go dark / Lights up button. Margo has lines for going dark, hidden rooms, things found late, and locks won and lost (24 placeholder lines, 100 in all). Autoplay fights every duel in two postures, lit on odd seeds and dark on even ones, keeps its sensors powered, aims only at resolved rooms, and reports hits, wide shots, blind shots, locks and signatures for each posture.
**Why:** PLAN S2.7's done-when asks for a bot report that shows running dark changing hit rates. Review gate decided without Eric under his standing approval (2026-11-16): the numbers are first guesses and running dark is too strong until it has a price (DF-34, DF-41).

---

## Stage notes

### Stage 1: the ship is alive (built 2026-11-15 to 2026-11-16)

**What exists:** one ship, the *Margin of Error*, as a lit cutaway with 15 rooms and 21 doors; a fixed 20 Hz simulation that runs with no browser; pause at any time with every order still accepted; a reactor power pool with brownouts; air, fire, breaches, temperature and jettison; three crew who walk, open doors, fight fires, patch, repair and heal; Margo's text box; placeholder sound; auto-pause; a debug panel; and a bot.

**Exit checks:**
- Green gate: 144 unit tests, 47 browser checks, content check, build. Passed.
- Autoplay: 100 chaos runs and 100 hazard scenarios, no crash, no bad number, nobody stuck. The bot saved the ship in 99 of 100 scenarios, median 22 seconds to clear. Passed (`reports/stage-1.md`).
- 60 fps with a fire at 4x CPU throttle: could not be measured on the build machine (no graphics card); Eric confirmed good fps on the iPad. The game's own work is 1.1 ms a frame under throttle.
- Eric plays 10 minutes on his iPad: done 2026-11-15. "Good FPS, no issues." Stage 1 is closed.

**Carried forward:** the open DF items above. Nothing in Stage 1 was left out of the plan's scope.

### Session log

- **S1.1 (2026-11-15):** Vite scaffold, folder layout, seeded RNG with substreams, content registry with browser and Node loaders, content checker, autoplay skeleton, title screen with stub screens, debug overlay, CI. 30 unit tests. GitHub Pages deploy workflow with per-PR previews. Known gap: DF-08 (Pages must be switched on in repo settings).
- **S1.2 (2026-11-15):** Fixed-timestep clock with pause, command queue, game event bus, input module (tap, drag, long-press, padded hit areas, keyboard), temporary test bay screen, autoplay bot that gives orders and pauses, 59 unit tests, 18 browser checks. DF-08 cleared: Eric switched Pages on and confirmed the preview works. DF-09 cleared. Eric tested on his iPad: looks, responds and feels good.
- **S1.3 (2026-11-15):** Ship layout format and validation, the *Margin of Error* (15 rooms, 21 doors, 9 vents), room and door state in the sim, door and light orders, debug room/door commands, cutaway renderer with per-room lighting, fire, frost and alarms, ship view with status panel. Test bay and probes removed. 76 unit tests, 25 browser checks.
- **S1.4 (2026-11-15):** Reactor power pool, system levels and damage, one-bar routing orders, lights as a power draw, brownout shedding, door control (remote with power, by hand without, electric locks), flat-rate life support, AI core status stub, power panel with touch buttons and Q-row keys, refusal messages. 91 unit tests, 30 browser checks. DF-14 cleared.
- **S1.5 (2026-11-15):** Oxygen flow through doors, airlocks and breaches; fire that grows, starves, spreads, heats, and breaks systems; temperature; hazards to crew (suffocation, burns); emergency jettison with a two-press control; jettisoned rooms and sealed doors in the renderer and panels; `hazard` RNG stream. 106 unit tests, 33 browser checks. DF-17 cleared.
- **S1.6 (2026-11-15):** Three placeholder crew from content; pathfinding on the room and door graph; move and suit orders; crew open and close doors, by hand when door control is dark; automatic extinguish, patch, repair and unjam work; medbay healing; crew bar, crew panel, selection by tap and number keys, path preview. Autoplay bot runs a crew and checks nobody gets stuck on a path. 123 unit tests, 38 browser checks. DF-16, DF-20, DF-22 cleared.
- **S1.7 (2026-11-16):** Margo's text box with a priority queue, stale-line dropping and a log; 41 placeholder lines; WebAudio engine with 14 data-defined patches, unlocked by the first tap; settings sheet and auto-pause on fire, breach and death; debug Step and Hurt; autoplay v1 with hazard scenarios and a written report. 144 unit tests, 47 browser checks. DF-11 cleared. Stage 1 is built; its last exit check is Eric's iPad playtest.
- **S2.1 (2026-11-16):** Weapons as content (pulse laser, slug thrower, breaching lance), hardpoints, charging by power, automatic fire, shots in flight, shield layers, evasion from engines and helm, hull points. The enemy as a second whole ship on the same code; the gunnery drone. Split fight view, weapons bar, tap-weapon-then-room targeting, A/S/D/F keys, debug Fight button. Autoplay picks fights and runs target practice. 158 unit tests, 61 browser checks. DF-26 cleared (Eric's playtest).
- **S2.2 (2026-11-16):** Hits break systems (a bar per point of damage), start fires, hole the hull (likelier in a worn room) and hurt crew, all through the Stage 1 hazard code; a test proves a fire or breach from a hit plays out exactly like one set by hand. Room flash, damage words, screen shake and a red edge flash; Screen shake switch; auto-pause on fight start; Margo remarks on hits (6 placeholder lines). Debug `debug.hit` and a Hit us button. Autoplay gains an under-fire mode, and the hazard bot re-routes power after repairs. 173 unit tests, 67 browser checks. DF-30 cleared; DF-12 and DF-28 narrowed; DF-35 added.
- **S2.3 (2026-11-16):** Enemy captains by archetype (power, volleys, targeting, crew who repair and hold the helm); the salvager skiff, a crewed pirate with two guns; the hail with talk, pay and open fire; surrender offers of money, cargo or information; enemies that run; jump drives for both ships; the stalemate rule; nine endings, each reachable from a new debug sheet; Margo lines for hails, offers, runs and each kind of ending (14 placeholder lines); enemy crew drawn red. Autoplay duels both enemies for every seed. 193 unit tests, 78 browser checks. DF-31 narrowed; DF-06 updated; DF-36 and DF-37 added.
- **S2.4 (2026-11-16):** Boarding by docking tube through the airlocks (D-060): either side crosses once the other's shields are down; crew are held by the ship they are aboard and announced by whose they are (D-061); hand to hand in rooms and sabotage by lone boarders (D-062); the skiff sends a party of two after 20 s of shooting (D-063); boarders die with a destroyed ship, come home, or are captured (D-064). Crew bar, selection and taps work across both ships; a "They board us" debug action; a "Boarders get aboard" auto-pause; 9 placeholder lines (76). Autoplay adds boarding duels against the skiff and watches both ships' crews for anyone stuck. 211 unit tests, 84 browser checks. DF-37 closed; DF-38 added.
- **Plan change (2026-11-16):** Eric approved reworking Stage 2 so the game stops reading as FTL: side-on decks, service crawlways, Margo's monitor, a signature model with running dark, capacitor shields, hand-loaded ammo, a playable hold, a breaker board, intercom orders, boarding by clamp, and Margo's pushback and crew refusal pulled forward. PLAN.md Stage 2 now runs S2.4, S2.6, S2.7, S2.8, S2.9, S2.5, S2.10. D-070 to D-078.
- **S2.6 (2026-11-16):** The ship side-on as four decks with hatches, ladders and a powered lift (D-079); service crawlways for engineers, with creature-only ducts (D-080); the *Margin of Error* redrawn as a hauler that is mostly hold, keeping every room and door id; routes by time; Margo's monitor with her face at the centre and a Scanlines switch (D-081); the enemy as a sensor return inset, enemy ships turned on their side (D-082); stencils, pipes and crates replace floor codes; power panel in one row. 214 unit tests. DF-05 and DF-33 narrowed; DF-39 and DF-40 added.
- **S2.7 (2026-11-16):** The senses model (D-083): light, noise, heat and movement per room and one signature per ship, the same code for both ships and ready for the creature. Fog on our own unwatched rooms with last-known state behind static, and fires and breaches that are found late (D-084). The enemy return resolves room by room and only resolved rooms can be aimed at (D-085). The lock replaces evasion, with blind fire when there is none (D-086). The jump needs a sensor fix (D-087). Go dark button, ship signature panel, lock readouts, 24 placeholder lines (100), and a bot that fights lit and dark (D-088): against the skiff 52% of shots hit a lit ship and 7% a dark one. 223 unit tests, 94 browser checks. DF-12, DF-32 and DF-40 narrowed; DF-34 and DF-15 updated; DF-41 added.
