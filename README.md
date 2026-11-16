# Cold Manifest

A crew-management spaceship roguelite for the browser. You captain the *Margin of Error*, a worn-out freighter working the Reach, with a crew that remembers what you did and a ship AI, M.A.R.G.O., that has opinions about all of it.

- [`docs/BRIEF.md`](docs/BRIEF.md): the full game brief (source of truth for what the game is)
- [`PLAN.md`](PLAN.md): the build plan, stage by stage and session by session
- [`DECISIONS.md`](DECISIONS.md): the project's memory. Read it at the start of every session.

## Run it

Needs Node 22 or newer.

```
npm install
npm run dev        # play at http://localhost:5173
```

URL flags: `?debug=1` shows the debug overlay, `?seed=ABCD-EFGH` fixes the seed, `?auto=1` is reserved for the autoplay bot.

## The green gate

Every pull request must pass all four. CI runs them automatically.

```
npm test                        # unit tests
npm run check                   # content validation and coverage report
npm run autoplay -- --runs 100  # headless seeded runs: no crashes, exact replay
npm run build                   # static site in dist/
```

## Layout

```
src/engine/    rendering, input, audio, save, seeded RNG, content loading
src/sim/       the simulation (no DOM; runs in Node for autoplay)
src/ai/        the ship AI and its line selection
src/narrative/ scenes, events, contracts, reputation
src/ui/        screens and panels
content/       all game content as JSON, one folder per type
tools/         content checker and autoplay bot
test/          unit tests
```

Content is data: adding a JSON file under `content/` is all it takes to add content. No external assets, no server, no API keys. The build output is static files that run on any static host.
