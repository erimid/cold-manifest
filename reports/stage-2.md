# Autoplay report

Command: `node tools/autoplay.js --runs 100 --minutes 10 --seed auto`

```
Cold Manifest autoplay
  runs:              100 (seeds auto-1 to auto-100), each played as chaos, as a hazard scenario, under fire and as target practice, each twice
  ship:              Margin of Error, crew of 3, 53 AI lines
  crashed or bad:    0

Chaos (10 game minutes each, 12000 ticks): a bot doing everything at random
  orders per run:    408.6 given, 211.3 refused up front, 0.3 dropped
  door moves:        95.8 completed per run
  power per run:     38.9 bars routed, 0.9 brownouts, door control dark 32% of the time
  hazards per run:   4.6 fires lit, 3.3 spread, 7.5 went out, 3.1 system bars burned, 1.8 rooms jettisoned
  crew per run:      64.7 sent, 42.1 arrived, 0.6 blocked, 2.7 of 3 died
  crew work per run: 2.7 fires put out, 1.5 breaches patched, 4.9 system bars repaired
  air:               rooms were unbreathable 33% of room-time
  fights per run:    5.0 started, 25.9 shots fired (10.0 hit, 20.5 stopped by shields, 2.6 missed), 0.7 enemies destroyed
  AI lines per run:  15.5 (about one every 39 seconds)
  pauses per run:    47.6 (state checked every paused frame)

Hazard scenarios (5 game minutes each): fires and breaches at once, and a bot trying to save the ship
  completed:         100 of 100
  emergencies:       2.0 fires and 0.9 breaches at the start; at worst 2.1 rooms burning at once
  ship saved:        99 of 100 (99%) ended with no fire and no breach
  time to clear:     median 22s, slowest 63s
  crew alive at end: 2.97 of 3 on average; everyone lived in 99% of runs, nobody in 1%
  system damage:     0.1 bars left broken at the end
  AI lines:          7.3 per scenario

Under fire (5 game minutes each): shots land on the ship for 2 minutes, then the same bot cleans up
  completed:         100 of 100
  hits per run:      11.4 landed; between them 3.1 fires, 4.7 breaches, 10.7 system bars broken, 0.7 crew hurt
  ship saved:        95 of 100 (95%) ended with no fire and no breach; median 10s after the last shot
  crew alive at end: 2.85 of 3 on average; everyone lived in 94% of runs
  deaths by cause:   suffocation 15
  hull left:         1.7 of 20 on average; 0.9 system bars still broken at the end

Target practice (up to 5 game minutes each): a gunnery drone alongside, and a bot feeding and aiming the guns
  completed:         100 of 100; drone destroyed in 100
  time to destroy:   median 72s, fastest 46s, slowest 124s
  shots:             12.2 per fight; 45% hit, 48% stopped by shields, 6% missed

```

PASSED: no crashes, no stuck doors, no crew stuck on a path, power never over supply, no fire without air, no fight left hanging, nothing moved while paused, every run replays from its seed.
