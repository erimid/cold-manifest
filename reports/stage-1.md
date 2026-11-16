# Autoplay report

Command: `node tools/autoplay.js --runs 100 --minutes 10 --seed auto`

```
Cold Manifest autoplay
  runs:              100 (seeds auto-1 to auto-100), each played as chaos and as a scenario, each twice
  ship:              Margin of Error, crew of 3, 41 AI lines
  crashed or bad:    0

Chaos (10 game minutes each, 12000 ticks): a bot doing everything at random
  orders per run:    408.3 given, 212.6 refused up front, 0.2 dropped
  door moves:        97.4 completed per run
  power per run:     44.4 bars routed, 1.1 brownouts, door control dark 32% of the time
  hazards per run:   5.2 fires lit, 3.0 spread, 7.9 went out, 3.1 system bars burned, 2.1 rooms jettisoned
  crew per run:      65.2 sent, 42.9 arrived, 0.7 blocked, 2.8 of 3 died
  crew work per run: 2.3 fires put out, 1.6 breaches patched, 4.7 system bars repaired
  air:               rooms were unbreathable 32% of room-time
  AI lines per run:  15.1 (about one every 40 seconds)
  pauses per run:    46.9 (state checked every paused frame)

Hazard scenarios (5 game minutes each): fires and breaches at once, and a bot trying to save the ship
  completed:         100 of 100
  emergencies:       2.0 fires and 0.9 breaches at the start; at worst 2.1 rooms burning at once
  ship saved:        99 of 100 (99%) ended with no fire and no breach
  time to clear:     median 22s, slowest 63s
  crew alive at end: 2.97 of 3 on average; everyone lived in 99% of runs, nobody in 1%
  system damage:     0.1 bars left broken at the end
  AI lines:          7.2 per scenario

```

PASSED: no crashes, no stuck doors, no crew stuck on a path, power never over supply, no fire without air, nothing moved while paused, every run replays from its seed.
