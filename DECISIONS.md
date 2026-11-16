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
| DF-07 | The sim's only contents are test-bay probes and `reactorDrift` (D-018, D-021). The test bay screen is temporary. | S1.3 (ship replaces the bay), S1.4 (remove `reactorDrift`), S1.6 (crew replace probes) | Open |
| ~~DF-08~~ | ~~GitHub Pages must be switched on once in the repo settings.~~ | Stage 1 | Done: Eric confirmed 2026-11-15 |
| ~~DF-09~~ | ~~No Playwright touch tests in CI yet.~~ | S1.2 | Done in S1.2 |
| DF-10 | Pinch-zoom and two-finger pan are not handled: the input module tracks one pointer at a time. | S1.3 if the ship view needs a camera, otherwise S11.5 | Open |
| DF-11 | Auto-pause triggers and their settings (brief §7) are not wired; the clock supports a pause requested mid-tick. | S1.7 | Open |

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

---

## Stage notes

_None yet. Stage 1 note goes here when Stage 1 is done._

### Session log

- **S1.1 (2026-11-15):** Vite scaffold, folder layout, seeded RNG with substreams, content registry with browser and Node loaders, content checker, autoplay skeleton, title screen with stub screens, debug overlay, CI. 30 unit tests. GitHub Pages deploy workflow with per-PR previews. Known gap: DF-08 (Pages must be switched on in repo settings).
- **S1.2 (2026-11-15):** Fixed-timestep clock with pause, command queue, game event bus, input module (tap, drag, long-press, padded hit areas, keyboard), temporary test bay screen, autoplay bot that gives orders and pauses, 59 unit tests, 18 browser checks. DF-08 cleared: Eric switched Pages on and confirmed the preview works. DF-09 cleared.
