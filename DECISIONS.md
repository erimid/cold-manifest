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
| DF-01 | Placeholder AI lines (~40, flagged `placeholder: true`) stand in for the real library. | Stage 5 (all removed by end of S5.7) | Open |
| DF-02 | Placeholder audio patches. | Stage 11 (S11.2) | Open |
| DF-03 | Placeholder crew portraits in the crew panel. | Stage 8 (S8.2) | Open |
| DF-04 | Faction and port names are provisional (see D-012). | Stage 7 (S7.4) | Open |
| DF-05 | Vent graph is data only, not used by anything, until the creature exists. | Stage 6 (S6.1) | Open |
| DF-06 | Pre-fight talk/bribe uses a placeholder negotiation value until crew skills exist. | Stage 4 (S4.1) | Open |
| ~~DF-07~~ | ~~The sim's only contents were test-bay probes and `reactorDrift`.~~ | S1.3 | Done in S1.3: the ship replaced the test bay; probes and `reactorDrift` are gone |
| ~~DF-08~~ | ~~GitHub Pages must be switched on once in the repo settings.~~ | Stage 1 | Done: Eric confirmed 2026-11-15 |
| ~~DF-09~~ | ~~No Playwright touch tests in CI yet.~~ | S1.2 | Done in S1.2 |
| DF-10 | Pinch-zoom and two-finger pan are not handled: the input module tracks one pointer at a time. | S1.3 if the ship view needs a camera, otherwise S11.5 | Open |
| DF-11 | Auto-pause triggers and their settings (brief §7) are not wired; the clock supports a pause requested mid-tick. | S1.7 | Open |
| DF-12 | Hull integrity is stored but nothing changes it; breaches only come from the debug command until weapons exist. Noise only comes from fire. | Stage 2 (hits), Stage 6 (noise sources) | Open |
| DF-13 | Hull damage, heat and cold have no visual of their own beyond fire glow and breach frost; temperature only shows in the status panel and has no effect on crew or systems. No smoke or sparks yet. | S11.1 (look pass) | Open |
| ~~DF-14~~ | ~~Doors open by remote from anywhere with no power or crew needed.~~ | S1.4 | Done in S1.4: doors need door control power or hands at the door (D-031) |
| DF-15 | Autoplay takes about 35 s for 100 runs because invariants and stuck checks run every tick. Fine for now; sample them if it grows. | Stage 3 | Open |
| ~~DF-16~~ | ~~"Hands at the door" read an empty crew list, so an unpowered door could not be moved in play.~~ | S1.6 | Done in S1.6: crew exist. A crew member in a room on either side counts as hands; walking crew open doors themselves (D-039) |
| ~~DF-17~~ | ~~Life support is a flat rate on every room with no flow between rooms.~~ | S1.5 | Done in S1.5: air flows through doors, airlocks and breaches (D-034). Crew still do not breathe air down (S1.6) |
| DF-18 | Shields, engines, weapons, sensors and medbay take power but do nothing with it yet. AI core power and damage only feed `aiCoreStatus()`. Damage comes only from the debug command, and nothing repairs it in play. | Stage 2 (combat systems), S1.6 (repairs), Stage 5 (AI degradation) | Open |
| DF-19 | Power panel tiles show system codes (SHD, ENG...) with no on-screen legend on touch; the codes match the stencils on the room floors. | S11.4 (tutorial), S11.5 (touch polish) | Open |
| ~~DF-20~~ | ~~Crew hazards acted on bare crew entries that only tests created.~~ | S1.6 | Done in S1.6 |
| DF-21 | Jettison has no cost beyond the room: no cargo loss, no hull or handling penalty, no AI argument first, and the vent graph still lists vents into the missing room. | Stage 3 (cargo), Stage 5 (AI argues before risky orders), Stage 6 (vents) | Open |
| DF-23 | The three starting crew (Ilse, Dace, Okoro) are placeholders in `content/crew/placeholder.json` with no skills, traits, needs or stress; everyone works at the same rate. | S4.1 (crew generation, skills, traits) | Open |
| DF-24 | Suits are a free, instant toggle with endless air. Crew do not use up a room's oxygen. Crew never refuse an order or flee danger by themselves. | Stage 4 (traits, refusal), Stage 9 (equipment) | Open |
| DF-25 | Crew walk in straight lines between doors and pass through each other. Routes count doors, not distance. The crew bar is sized for three and will wrap with eight. | S11.5 (touch polish), Stage 4 (bigger rosters) | Open |
| ~~DF-22~~ | ~~Nothing put a fire out except starving or venting it, and nothing patched a breach.~~ | S1.6 | Done in S1.6: crew extinguish, patch, repair and unjam (D-040) |

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

---

## Stage notes

_None yet. Stage 1 note goes here when Stage 1 is done._

### Session log

- **S1.1 (2026-11-15):** Vite scaffold, folder layout, seeded RNG with substreams, content registry with browser and Node loaders, content checker, autoplay skeleton, title screen with stub screens, debug overlay, CI. 30 unit tests. GitHub Pages deploy workflow with per-PR previews. Known gap: DF-08 (Pages must be switched on in repo settings).
- **S1.2 (2026-11-15):** Fixed-timestep clock with pause, command queue, game event bus, input module (tap, drag, long-press, padded hit areas, keyboard), temporary test bay screen, autoplay bot that gives orders and pauses, 59 unit tests, 18 browser checks. DF-08 cleared: Eric switched Pages on and confirmed the preview works. DF-09 cleared. Eric tested on his iPad: looks, responds and feels good.
- **S1.3 (2026-11-15):** Ship layout format and validation, the *Margin of Error* (15 rooms, 21 doors, 9 vents), room and door state in the sim, door and light orders, debug room/door commands, cutaway renderer with per-room lighting, fire, frost and alarms, ship view with status panel. Test bay and probes removed. 76 unit tests, 25 browser checks.
- **S1.4 (2026-11-15):** Reactor power pool, system levels and damage, one-bar routing orders, lights as a power draw, brownout shedding, door control (remote with power, by hand without, electric locks), flat-rate life support, AI core status stub, power panel with touch buttons and Q-row keys, refusal messages. 91 unit tests, 30 browser checks. DF-14 cleared.
- **S1.5 (2026-11-15):** Oxygen flow through doors, airlocks and breaches; fire that grows, starves, spreads, heats, and breaks systems; temperature; hazards to crew (suffocation, burns); emergency jettison with a two-press control; jettisoned rooms and sealed doors in the renderer and panels; `hazard` RNG stream. 106 unit tests, 33 browser checks. DF-17 cleared.
- **S1.6 (2026-11-15):** Three placeholder crew from content; pathfinding on the room and door graph; move and suit orders; crew open and close doors, by hand when door control is dark; automatic extinguish, patch, repair and unjam work; medbay healing; crew bar, crew panel, selection by tap and number keys, path preview. Autoplay bot runs a crew and checks nobody gets stuck on a path. 123 unit tests, 38 browser checks. DF-16, DF-20, DF-22 cleared.
