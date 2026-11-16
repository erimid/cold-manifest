# Autoplay report

Command: `node tools/autoplay.js --runs 100 --minutes 10 --seed auto`

```
Cold Manifest autoplay
  runs:              100 (seeds auto-1 to auto-100), each played as chaos, as a hazard scenario and as target practice, each twice
  ship:              Margin of Error, crew of 3, 47 AI lines
  crashed or bad:    0

Chaos (10 game minutes each, 12000 ticks): a bot doing everything at random
  orders per run:    402.9 given, 209.4 refused up front, 0.3 dropped
  door moves:        98.7 completed per run
  power per run:     39.5 bars routed, 0.8 brownouts, door control dark 30% of the time
  hazards per run:   4.2 fires lit, 3.3 spread, 7.0 went out, 2.9 system bars burned, 1.8 rooms jettisoned
  crew per run:      66.0 sent, 43.1 arrived, 0.8 blocked, 2.7 of 3 died
  crew work per run: 2.5 fires put out, 1.2 breaches patched, 4.2 system bars repaired
  air:               rooms were unbreathable 32% of room-time
  fights per run:    4.8 started, 27.7 shots fired (4.9 hit, 20.0 stopped by shields, 2.8 missed), 0.5 enemies destroyed
  AI lines per run:  15.2 (about one every 40 seconds)
  pauses per run:    47.9 (state checked every paused frame)

Hazard scenarios (5 game minutes each): fires and breaches at once, and a bot trying to save the ship
  completed:         100 of 100
  emergencies:       2.0 fires and 0.9 breaches at the start; at worst 2.1 rooms burning at once
  ship saved:        99 of 100 (99%) ended with no fire and no breach
  time to clear:     median 22s, slowest 63s
  crew alive at end: 2.97 of 3 on average; everyone lived in 99% of runs, nobody in 1%
  system damage:     0.1 bars left broken at the end
  AI lines:          7.2 per scenario

Target practice (up to 5 game minutes each): a gunnery drone alongside, and a bot feeding and aiming the guns
  completed:         100 of 100; drone destroyed in 100
  time to destroy:   median 85s, fastest 72s, slowest 138s
  shots:             15.4 per fight; 32% hit, 59% stopped by shields, 10% missed

```

PASSED: no crashes, no stuck doors, no crew stuck on a path, power never over supply, no fire without air, no fight left hanging, nothing moved while paused, every run replays from its seed.
