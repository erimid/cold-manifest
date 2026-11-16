# Cold Manifest: Full Game Brief

You are building **Cold Manifest** (working title), a crew-management spaceship roguelite with survival horror, a smuggler's economy, and character-driven crew scenes. This document covers the whole game. Build it in stages (see "Build order"), keep each stage playable, and treat this brief as the source of truth. If something here is ambiguous, make a sensible call, write it down in `DECISIONS.md`, and keep going.

Quality is the goal. This should feel like a finished indie game, not a prototype.

---

## 1. The pitch

You're the captain of the *Margin of Error*, a worn-out freighter working the Reach: a long corridor of failing colonies, mining stations, and orbital ports left behind after the company that built them went bankrupt. Nobody polices the Reach anymore. Ports run themselves, factions fight over what's left, and anything can be bought if you'll carry it.

You take contracts, carry cargo nobody else will touch, and try to keep your crew alive and loyal. Your ship's AI has opinions about all of it. Sometimes the cargo is alive. Sometimes something gets aboard. And the ports you deal with remember what you did, run after run.

**The feeling we want:** long stretches of tense, careful management (routing power, haggling, patching up crew relationships) broken by bursts of panic when a fight starts or something starts moving in the vents.

## 2. Design pillars

Every feature should serve at least one. If a feature serves none, cut it.

1. **The crew are people.** They remember what you did to them and to each other. Their bonds and grudges change how they act.
2. **The ship has a voice.** The ship's AI is a character with a personality, opinions, and limits. It's the voice you hear most.
3. **The Reach remembers.** Ports and factions treat you based on your history, within a run and across runs.
4. **Something is aboard.** The horror threat puts pressure on every other system: power, doors, crew morale, trust in the AI.
5. **Every run is a story.** A failed run should still produce a memorable story, and it should have consequences for the next one.

## 3. Anti-goals (failures even if the game technically works)

- The AI repeats itself noticeably within the first several runs.
- Crew feel like stat blocks with names attached.
- The horror threat is a timer or a random damage event instead of a thing that moves and hunts.
- The economy is decorative and doesn't affect decisions.
- It looks like programmer art or a generic purple-neon sci-fi template.
- It copies the look, names, UI, or exact rules of FTL or any other existing game. Use the genre, not someone else's game.

---

## 4. Platform and tech

- **Runs in the browser.** Landscape layout. Must work well with a mouse and keyboard on a PC, and must be fully playable by touch on an iPad (no hover-only interactions, tap targets at least 44px).
- **Multi-file project, no heavy framework.** Vanilla JavaScript with ES modules, HTML5 Canvas 2D for the ship view, and DOM/CSS for menus, dialogue and panels. A lightweight dev server (e.g. Vite) is fine, but the build output must be static files that deploy to Cloudflare Pages or any static host with no backend.
- **No server, no API keys, no paid services.** Everything runs offline once loaded.
- **Content is data, not code.** All AI lines, crew scenes, events, contracts, goods, factions, and ports live in separate content files (JSON or JS data modules) under `content/`. Game code reads them. Adding content should never require touching engine code.
- **Save system:** autosave to `localStorage` at every port and every jump. One active run plus a persistent meta-profile (faction memory, unlocks, heard-line history). Include export/import of the save as a text string so it can move between devices.
- **Input layer (build in Stage 1):** one input module built on Pointer Events handles mouse, touch and pen the same way, and everything else in the game asks it what happened. Taps are checked against the DOM UI first and the canvas second, so a tap on a panel never also hits a room underneath it. It tells taps apart from drags with a movement threshold, gives touch a generous hit area (rooms and doors pick up taps slightly outside their drawn edge), and supports long-press as the touch stand-in for right-click and hover info. No other code reads raw mouse or touch events.
- **Audio:** synthesized with WebAudio (ambient hum, alarms, UI clicks, creature sounds, music pads). No external audio files unless they're generated in code. Audio starts after the first tap (iOS requirement). Keep it modular: a small library of reusable synth "patches" (a few oscillators, an envelope and a filter each) defined as data, and game events trigger patches by name. Stages 1 to 10 use simple placeholder patches; real sound design happens in Stage 11. Don't spend more than a short session tuning any one sound.
- **Art:** drawn in code (Canvas shapes, gradients, pre-rendered sprites to offscreen canvases). No external image assets.
- **Performance:** steady 60fps on an iPad with the full ship, all crew, a fire, and an active creature.

### Suggested folder layout

```
/index.html
/src/
  main.js            boot, loop, state machine
  engine/            rendering, input, audio, save, rng (seeded)
  sim/               ship, rooms, systems, crew, combat, threat, economy
  ai/                ship AI personality + line selection
  narrative/         scenes, events, contracts, reputation
  ui/                HUD, panels, dialogue, map, menus
/content/
  ai-lines/          one file per category
  scenes/            crew scenes
  events/            transit events
  contracts/  ports/  factions/  goods/  crew/  threats/
/tools/
  content-check.js   validation + coverage report (see §15)
  autoplay.js        bot that plays runs (see §15)
DECISIONS.md
```

---

## 5. Run structure

```
META HUB ──► PICK CONTRACT ──► PORT ──► JUMP ──► TRANSIT EVENT ──► PORT ──► ... ──► DELIVERY
(between      (cargo, pay,      (trade,   (fuel)   (fight, distress,                 (pay, rep
 runs)         risk, route)      recruit,           derelict, inspection,             changes)
                                 repair,            crew drama, threat)
                                 scenes)
```

- A **run** is one contract, roughly 45 to 75 minutes. It spans 6 to 10 jumps across a sector map of about 15 to 25 nodes (ports, empty space, hazards, derelicts, faction checkpoints).
- After a successful delivery, the player can **take another contract** and continue the same run with the same crew and ship (a "career"), or **retire** and bank the run's results to the meta-profile. A career of 3 contracts is a full "win."
- **Fuel and time pressure:** each jump costs fuel. Some contracts have a deadline counted in jumps. A pursuing faction, an outbreak, or the threat itself can also push you forward.
- **Run ends** when: the ship is destroyed, the whole crew is dead, the crew mutinies and takes the ship, or the player retires. A failed contract doesn't end the run on its own, but it damages your reputation with the client faction and costs you money.

---

## 6. The ship

### Layout
- Top-down cutaway view of the ship's interior, with roughly 12 to 16 rooms connected by doors and corridors. There's also a **vent network**: a separate graph of crawlspaces linking some rooms. Crew can't use the vents, but the creature can.
- Each room has: oxygen level, temperature, light level, noise level, a door state (open, closed, locked, jammed), hull integrity, fire, and a breach.

### Systems (each lives in a room)
| System | What it does |
|---|---|
| Reactor | Makes power. Damage reduces output. |
| Engines | Evasion in combat, needed to jump. |
| Shields | Absorb incoming fire. |
| Weapons | 2 to 4 hardpoints; each weapon needs power and charges over time. |
| Life support | Keeps oxygen up ship-wide. |
| Sensors | Shows enemy ship interiors, hazards, and the creature's position. Damaged sensors make the AI's sensor reports less reliable (see §9). |
| Doors | Remote door control. Without power, doors must be opened by hand. |
| Medbay | Heals crew. |
| Cargo hold | Holds cargo and contraband (has hidden compartments as an upgrade). |
| AI core | The ship AI's "body." Damage degrades the AI (glitched lines, slower responses, missed warnings). |
| Crew quarters / mess | Rest and morale recovery. Where scenes happen. |
| Brig | Holds prisoners, captured crew, or a suspected traitor. |

### Power
- The reactor gives a limited pool of power bars that the player routes between systems at any time. This is the main moment-to-moment decision in a fight.
- Lights draw power too. Turning off lights in a room saves power and hides crew from the creature, but frightens the crew and makes repairs slower.

### Hazards
- **Fire** spreads to adjacent rooms, burns oxygen, and damages systems and crew. Venting a room's air (open its outer door) puts fire out but kills anyone inside without a suit.
- **Hull breaches** drain oxygen until repaired.
- **Emergency jettison:** a damaged section can be sealed and ejected as a last resort. Whatever's inside, crew included, is lost.

### Upgrades
- Bought at ports with money or scrap: system levels, extra reactor bars, weapons, hidden cargo compartments, reinforced doors, vent grilles (block parts of the vent network), motion sensors, a better AI core.

---

## 7. Combat

- **Pausable real time.** Space bar or a big on-screen pause button. The player can pause anytime to give orders, route power, and target weapons.
- **What pause means (define in Stage 1, never break later):** the whole simulation runs on one clock with a fixed timestep. Every simulated system steps only from that clock: crew movement, fire, oxygen, breaches, weapon charge, enemy AI, creature movement and senses, stress, the AI's line timers. When paused, the clock stops and nothing simulated changes. The player can still look at everything, open panels, and give orders, and orders given while paused are queued and start when time resumes. Text that's mid-typing may finish, but no new lines start.
- **Auto-pause options** (in settings, on by default for touch): pause automatically when a fight starts, the creature is sighted, a crew member dies, a breach or fire starts, or a crew member refuses an order. This keeps a slip of the finger from turning into a disaster.
- **Ship-to-ship:** the enemy ship appears on the right side of the screen, also as a cutaway. You target their rooms (weapons, shields, engines, crew). They do the same to you. Shields absorb hits, evasion makes shots miss, and weapons charge over time.
- **Boarding:** enemies can teleport or dock and board you. Your crew can board them. Crew fight hand-to-hand in rooms; stats and traits decide who wins.
- **Ways a fight can end:** destroy them, kill their crew, make them surrender (they offer cargo, money or information), escape by jumping once engines charge, or talk/bribe your way out before shooting starts (based on reputation and crew skills).
- **Enemy variety:** at least 8 ship types across the factions, each with a clear style (glass cannon, boarders, drone carriers, shield tanks, stealth). Pirates, faction patrols, bounty hunters, and automated company security drones still running after the collapse.

---

## 8. The crew

### Each crew member has
- **Name, look, background, and voice** (a short description of how they talk, used when writing their lines).
- **Skills:** piloting, engineering, weapons, medicine, combat, negotiation. Skills improve with use.
- **Two or three traits** from a pool of at least 30 (e.g. Reckless, Devout, Coward, Greedy, Former Company, Insomniac, Protective, Superstitious, Ex-Con, Sentimental). Traits change behavior, not just numbers. A Coward may refuse to enter a room with the creature; a Protective crew member runs to help a bonded friend.
- **Needs:** rest, food, safety, and morale. Unmet needs lower performance and raise stress.
- **Stress:** goes up from fear, injury, deaths, bad orders and horror events. At high stress, crew can freeze, panic, lash out, or break (a lasting negative trait).
- **Health and injuries**, including lasting ones (a bad leg slows them).

### Memory (core feature)
- Every crew member keeps a **memory log** of significant events, each with an emotional weight: "Captain left Dace behind on the derelict," "Captain spent our cut on my medical bills," "Ilse saved my life in the reactor fire."
- Memories involve the captain, other crew, factions, and the AI. They fade over time unless they're strong.
- Memories drive **opinions** of the captain, of each other crew member, and of the AI, on a scale from hatred to devotion.
- Memories show up in play: in what they say (lines reference specific past events by name), in whether they follow orders, in who they help in a crisis, and in which scenes become available.

### Relationships
- Each pair of crew members has a relationship (friendship, rivalry, romance, mentorship, grudge) that changes based on shared events and scenes.
- Strong bonds give bonuses when they work in the same room. Grudges cause friction, refused cooperation, and eventually fights.

### Loyalty, refusal, and mutiny
- Crew can **refuse orders** that are suicidal or that go against their traits or memories. The UI shows why ("Dace won't go back into the hold. She remembers what happened to Petrov.").
- If enough crew lose faith in the captain, a **mutiny** starts building, with warning signs (whispered lines, crew gathering, the AI noticing). The player can head it off through scenes, decisions, or the brig. If it goes off, it plays out as an event and can end the run.
- **Secret traitor (optional per run):** occasionally one crew member is working for a faction. They act on it at a key moment (sabotage, signaling a pursuer, letting the creature out). Their behavior leaves subtle tells that a careful player can notice.

### Recruitment
- Hire at ports, rescue from derelicts and distress calls, or take prisoners who switch sides. Start each run with 3 crew; the ship holds up to 8.
- Procedurally generated crew from name, background, trait, and voice pools, plus about 10 hand-authored "special" characters who show up rarely and have their own scene chains.

---

## 9. The ship AI

The AI is the single most important character in the game. It's scripted (no live language model), with a very large line library.

### Personality
- The AI has a fixed core personality: dry, observant, quietly loyal, with its own moral lines. Write it like a specific person. Pick a name for it (the crew calls it something informal).
- It has **opinions** of the captain and of each crew member, built from the same memory system the crew use.
- It has a **trust** value toward the captain. High trust: it volunteers information and goes along with risky orders. Low trust: it gets curt, holds information back, and argues.

### Behaviors
- **Comments** on what's happening: decisions, fights, trade, crew behavior, cargo, ports, the creature.
- **Argues** before risky orders ("You're venting the medbay. Ilse is in the medbay."). The player can override.
- **Refuses** an order it considers clearly suicidal or monstrous, at most a few times per run, and the player can force it with a captain's override (which damages trust and crew opinion).
- **Withholds or lies** in specific cases: to protect a crew member it likes, when its trust in the captain is low, or when the AI core is damaged. Its sensor reports about the creature may be wrong. The player can cross-check with the sensors system and learns to read the AI's reliability.
- **Remembers past runs.** The AI core is salvaged and reinstalled into each new ship. It remembers previous captains (you), crews who died, and how runs ended, and brings them up. This is the main cross-run voice of the game.

### The line library (hard requirements)
- **Minimum 3,000 AI lines at launch**, organized by trigger category in `content/ai-lines/`.
- Each line has: an id, a trigger category, conditions (trust range, stress, AI damage level, which crew are alive, faction involved, threat state, run number, etc.), a weight, and optional **slots** filled at runtime (`{crew_name}`, `{port}`, `{faction}`, `{cargo}`, `{past_crew_name}`, `{memory_event}`).
- **Coverage targets (minimum lines per category):** greeting/run start 80, jump 120, port arrival 150 (including per-faction and per-port variants), trade 120, combat start 100, combat progress 200, combat end 120, hull damage/fire/breach 150, crew injury 100, crew death 120 (including references to that crew member's memories), crew conflict 100, crew bonding 80, order confirmations 200, arguments before risky orders 150, refusals 60, captain overrides 60, cargo comments by cargo type 200, creature sighting/threat 250, false or uncertain sensor reports 80, idle ship-quiet moments 250, past-run memories 150, damaged AI glitch lines 80, mutiny warning signs 60, traitor suspicion 50, contract-specific lines 150, rare lines (very low weight, surprising, for long-time players) 100.
- **Slots add context, not count.** Slots let one line fit many situations ("{crew_name} is still in the reactor"), but every slot variant of a line counts as **one** line toward the 3,000. The near-duplicate checker treats lines that differ only in slots as duplicates. The target is 3,000 genuinely different things the AI can say.
- **How to produce the library:** write it in batches of about 50 to 100 lines per category, in the AI's voice as defined in its personality file. Run the content checker after every batch to check coverage and catch near-duplicates before moving on. Spread the writing across Stages 5 and 10 so the library never blocks the build.
- **No-repeat tracking:** every line the player hears is recorded in the meta-profile. The selector strongly prefers unheard lines that match the conditions, then lines heard longest ago. A line should never repeat within the same run, and an average player should go at least 10 runs before noticing repeats.
- **Variety in delivery:** lines are short (most under 25 words). Quiet moments get the occasional longer one. The AI speaks through a text box with a typed-out effect and a synthesized "voice" blip, and lines should not interrupt each other (queue with priorities, drop stale ones).
- **Frequency:** the AI should feel present but not chatty. Tune it so it speaks about once every 30 to 90 seconds in calm periods, more in crises, with no talking over important events.

---

## 10. Contracts and cargo

### Contract types (at least 6, at least 3 in the first playable version)
1. **Smuggling:** carry contraband past checkpoints. Inspections can find it (hidden compartments, bribes, or negotiation help).
2. **Rescue:** reach a stranded station or ship and bring survivors back. Survivors take space and supplies, and some may be infected, traitors, or useful recruits.
3. **Prisoner transport:** a dangerous prisoner in the brig. They talk to your crew, try to turn them, and may try to escape. Their faction may try to free them.
4. **Specimen haul:** a sealed container with a living creature in it. It's the most common source of the horror threat. Pays the most.
5. **Salvage claim:** strip a derelict and bring back the goods. Something may still be on the derelict.
6. **Courier:** sensitive data or a passenger with a secret. Multiple factions want it.

### Cargo with effects
- Some cargo affects the ship and crew while aboard: a specimen that makes noises at night (stress), a religious relic (Devout crew love it, others are spooked), a sick passenger (contagion risk), a prisoner (morale and loyalty pressure), unstable fuel (fire risk), a sealed company crate the AI refuses to discuss.
- The player chooses whether to open, inspect, or jettison cargo, and each has consequences (contract failure, rep loss, or finding out what's actually inside).

---

## 11. Ports, factions, and reputation

### Factions (at least 5)
Each has a name, a look, values, what it buys and bans, how it treats smugglers, its ship types, and its own AI and crew lines. Suggested set (rename and develop them):
- The **Receivers**: what's left of the bankrupt company's administrators, trying to reclaim assets.
- A **miners' union** that runs the outer stations.
- A **religious order** that sees the Reach's emptiness as holy.
- A **pirate confederation** with its own code.
- A **medical and research collective** that pays very well for specimens and asks no questions.

### Reputation and memory
- Each faction tracks reputation with you, plus a **record of specific deeds** ("delivered the prisoner to their enemies," "saved their station from the outbreak," "sold them out at Kessel Port").
- **Individual ports** also remember you: the dockmaster you stiffed, the bar where your crew started a fight.
- Reputation changes: prices, which contracts are offered, whether you're inspected, whether patrols attack on sight, which recruits will join, and what NPCs and the AI say.
- **Across runs:** faction and port memory persists in the meta-profile, softened over time (memory decays a bit per run, but major deeds stay). Ports greet a new run by referring to past ones ("Last captain who flew that tag left without paying.").

---

## 12. Economy

- **Goods:** at least 20 trade goods (fuel, food, medicine, ore, machine parts, luxury goods, weapons, contraband types). Each port has supply and demand, so prices vary by port and drift over time.
- **Events move markets:** an outbreak at a station raises medicine prices there, a blockade raises everything, a faction war changes what's banned where.
- **Black markets** at some ports buy contraband and stolen goods, at a risk.
- **Contraband and inspections:** what's illegal depends on the faction controlling the port or checkpoint. Inspections can be passed by hiding cargo, bribing, negotiating (crew skill), or fighting.
- **Money uses:** fuel, repairs, upgrades, crew wages (unpaid crew lose morale and remember it), medical care, bribes.
- **Cargo space is limited**, so trading competes with contract cargo and survivors.

---

## 13. The horror threat ("something aboard")

### Sources
- A specimen breaking containment, a stowaway boarding at a port or derelict, an infected survivor or crew member who transforms, or a creature that crawls in through a breach.
- Not every run has a threat. Roughly half should, and contracts like specimen hauls make it much more likely.

### How it behaves
- The creature is a real agent that moves through the room graph **and the vent network**. It has states (hiding, stalking, hunting, feeding, fleeing) and senses (noise, light, movement, heat).
- It's attracted by noise (combat, running systems, fire), avoids or is drawn to light depending on its type, and can be blocked by locked doors for a while (it can break weak doors).
- At least 3 creature types with different rules (e.g. one that hunts by sound and hates light, one that mimics a crew member, one that spreads an infection).
- **The player fights back with systems, not just guns:** lock doors to trap or channel it, cut lights, vent rooms to space, lure it with noise, seal the vents with upgrades, flush it with fire, or jettison the section it's in.
- **Crew react** based on traits and stress: some hunt it, some hide, some panic and run, some refuse to go near it. Crew in a room with the creature are terrified and can be killed or taken.
- **Information is a tension tool:** the creature only shows on the map when crew can see it, when sensors pick it up, or when the AI reports it, and the AI's reports may be uncertain or wrong (see §9). Show uncertainty clearly (a pulsing "last seen" marker, static on the sensor display).
- **Presentation:** flickering lights, a heartbeat sound when it's near a crew member, scratching in vents, short sharp alarms. Creepy, not gory: no graphic violence; deaths are shown through the alarm, a light going out, and the crew's and AI's reaction.

---

## 14. Crew scenes (visual-novel style)

- At ports and during quiet transit, the player can open short **scenes** with one or two crew members: a conversation shown as portraits and text, with 2 to 4 choices.
- Choices change relationships, morale, stress, memories, and sometimes unlock skills, traits, or later scenes.
- **Scene types:** getting-to-know-you, conflict between two crew members (the captain mediates or takes a side), grief after a death (referencing the dead crew member by name and memory), a crew member's personal story chain (3 to 5 scenes across a career for special characters), confession scenes that can reveal the traitor, and scenes that include the AI as a participant.
- **Minimum 120 scenes at launch**, with conditions so they appear when they make sense (who's alive, relationship values, recent events). Use slots so generic scenes adapt to the specific crew.
- Scenes cost time or a resource (e.g. one scene per port visit, or it uses a rest period), so they're a choice, not a free buffet.
- Portraits are drawn in code: stylized busts with variation in face shape, hair, skin tone, clothing, scars and accessories, generated from each crew member's data.

---

## 15. Transit events

- Between ports, each jump can trigger an event: distress calls, derelicts, faction patrols, inspections, pirates, anomalies, traders, refugees, malfunctions, and crew-driven events (a fight breaks out, someone's stealing supplies, someone's sick).
- **Minimum 150 events at launch**, each with choices whose results depend on crew skills, traits, reputation, cargo, and the ship's systems. Some choices are only available if a specific crew member, trait, or upgrade is present (show these with a label, like "[Ilse, Medicine]").
- Events can lead into combat, boarding, scenes, or the threat.

---

## 16. Meta-progression (between runs)

- **The AI core persists.** It remembers runs, previous crews, and how they died, and its trust in "the captain" carries over in a softened form.
- **Faction and port memory** persists (see §11).
- **Unlocks:** new starting ships (at least 3 layouts with different strengths), new starting crew backgrounds, new contract types, and AI core upgrades. Unlocks come from achievements and milestones (delivered a specimen alive, survived a mutiny, finished a 3-contract career).
- **The Wall:** a memorial screen listing every crew member who has died across all runs, with the AI's one-line epitaph for each, based on their memories.
- **Run summary:** at the end of each run, show a short "story of the run" recap generated from the event log: key decisions, deaths, betrayals, best moments.

---

## 17. Look and feel

- **Setting style:** a used, industrial future. Worn metal, hand-painted company warning stencils that the old owners left behind, cables, condensation, flickering fluorescent panels.
- **Palette:** warm amber and sodium-orange interior lighting against cold blue-black space. Emergency red for alarms. Sickly green for the creature and infection. Avoid generic purple-and-pink neon.
- **Ship view:** top-down cutaway with soft lighting per room (lights visibly turn off when power is cut), animated crew sprites with readable silhouettes, visible fire, smoke, sparks, and frost on breached rooms.
- **UI:** looks like a ship's terminal from a cheap company: monospace font for the AI and readouts, chunky labeled buttons, slight scanline or CRT glow (subtle, and possible to turn off).
- **Juice:** screen shake on hits, impact flashes, alarms that pulse the room borders, a heartbeat vignette when the creature is near.
- **Accessibility:** text size setting, option to reduce flicker and screen shake, colorblind-safe alarm colors (use shape and icon as well as color), pause available always.

---

## 18. UI and controls

- **Main screens:** title, meta hub (ship select, the Wall, unlocks, stats), contract board, sector map, ship view (main gameplay), port (market, shipyard, recruit, bar for scenes and rumors), scene view, event view, run summary.
- **Ship view controls:** tap or click a crew member, then a room, to move them. Tap a room to see its status. Power bars panel at the bottom. Door controls by tapping a door. Weapons panel with targeting. A big pause button.
- **AI dialogue box:** fixed position, never covers the critical parts of the ship view. Show a short history log the player can scroll back through.
- **Crew panel:** portraits with health, stress, and a mood icon. Tap a portrait to see traits, skills, relationships, and the most important memories.
- **Keyboard on PC:** space to pause, number keys for crew selection, shortcuts for weapons and power.

---

## 19. Tooling and verification (required)

### Content checker (`tools/content-check.js`, run with Node)
- Validates every content file: required fields, valid conditions, slots that exist, unique ids, no broken references to scenes, crew, factions or ports.
- Prints a **coverage report:** line counts per AI category against the targets in §9, scene count, event count, and flags any category under target.
- Flags **near-duplicate lines** (very similar wording) so the library has real variety.

### Autoplay bot (`?auto=1` in the URL, plus `tools/autoplay.js` for headless batch runs)
- Plays full runs with a simple strategy so balance and stability can be tested at scale.
- Batch mode runs at least 100 seeded runs and reports: win rate, average run length, causes of death and run end, money and reputation curves, how often the threat appears and how it ends, mutiny rate, and **how many AI lines repeated within a run** (target: zero) and across runs.
- Any crash or stuck state in a bot run is a bug to fix before moving to the next stage.

### Debug panel (`?debug=1`)
- Spawn the creature, start a fight, trigger any event or scene by id, set reputation, add money, kill or injure crew, fast-forward time, show the creature's position and state, show AI trust and each crew member's opinions.

### Seeded randomness
- All randomness goes through a seeded RNG so any run can be replayed from its seed for bug reports.

---

## 20. Build order

Build in this order. Each stage ends with a playable build, the content checker passing, and a batch of autoplay runs with no crashes.

**`DECISIONS.md` discipline.** This project runs across many sessions, so this file is its memory. Read it at the start of every session. Log every decision that departs from this brief, and especially every shortcut or deferral (simplifying the vent graph, faking breach physics, stubbing a system), each with: what was done, why, and the stage where it must be revisited. Keep a running "Deferred" list at the top, and clear items off it when they're done. At the end of each stage, add a short note: what was built, what changed and why, and known issues.

1. **Ship and crew simulation:** the input layer and the pause/sim clock (§4, §7) come first, since everything else depends on them. Then rooms, systems, power routing, doors, oxygen, fire, breaches, crew movement, and repairs. Placeholder AI lines and placeholder audio patches. Test touch on an iPad-sized screen before this stage counts as done.
2. **Combat:** ship-to-ship, targeting, boarding, enemy AI, at least 4 enemy ship types.
3. **Run structure:** sector map, jumps, fuel, ports (basic), events (first 30), contracts (first 3 types), run end and summary, save and load.
4. **Crew depth:** traits, needs, stress, memory log, opinions, relationships, order refusal, mutiny.
5. **The ship AI:** personality, trust, arguing, refusing, withholding, the line selection system with no-repeat tracking, and the first 1,000 lines.
6. **Horror threat:** creature agent, vents, senses, the 3 creature types, crew reactions, uncertain sensor reports.
7. **Economy and factions:** goods, markets, black markets, inspections, faction and port reputation and memory.
8. **Crew scenes:** scene system, portraits, the first 60 scenes.
9. **Meta-progression:** persistent AI core memory, faction memory across runs, unlocks, the Wall, extra ships.
10. **Content expansion:** bring the AI library to 3,000+ lines, scenes to 120+, events to 150+, all 6 contract types, all enemy types, the special characters and their scene chains. Run the near-duplicate checker and rewrite anything flagged.
11. **Polish and balance:** juice, audio, accessibility options, tutorial (a short guided first contract), iPad touch pass, performance pass, and balancing from autoplay data. A good player should complete a 3-contract career roughly one run in four or five.

---

## 21. Writing guidance (for all lines, scenes and events)

- Grounded, dry, a little dark, with humor that comes out of character, not jokes for their own sake.
- The AI sounds like one specific person in every line. Crew sound like themselves, based on their voice descriptions.
- Refer to specific things: names, ports, past events, cargo. Generic lines ("Watch out!") should be the rare exception.
- Keep most lines short. Let silence work; not everything needs a comment.
- No real-world brand names, no references to other games, books or films by name.
- No graphic gore or sexual content. Horror comes from tension, sound and implication.

---

## 22. Definition of done

- A new player can start, learn the basics in the guided first contract, and play a full 3-contract career without hitting a bug.
- The content checker passes with every category at or above target.
- 100 autoplay runs complete with no crashes, no stuck states, and zero repeated AI lines within any single run.
- It runs at 60fps on an iPad in Safari and plays fully by touch.
- Someone who plays it for an evening comes away with a story about their crew.
