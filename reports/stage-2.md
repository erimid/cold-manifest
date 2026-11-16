# Autoplay report

Command: `node tools/autoplay.js --runs 100 --minutes 10 --seed auto`

```
Cold Manifest autoplay
  runs:              100 (seeds auto-1 to auto-100), each played as chaos, as a hazard scenario, under fire and as a duel with every enemy, each twice
  ship:              Margin of Error, crew of 3, 67 AI lines
  crashed or bad:    0

Chaos (10 game minutes each, 12000 ticks): a bot doing everything at random
  orders per run:    398.4 given, 206.4 refused up front, 0.6 dropped
  door moves:        87.1 completed per run
  power per run:     35.0 bars routed, 1.0 brownouts, door control dark 30% of the time
  hazards per run:   5.6 fires lit, 2.4 spread, 7.8 went out, 2.2 system bars burned, 1.8 rooms jettisoned
  crew per run:      58.4 sent, 37.2 arrived, 0.7 blocked, 2.9 of 3 died
  crew work per run: 2.2 fires put out, 2.3 breaches patched, 5.2 system bars repaired
  air:               rooms were unbreathable 42% of room-time
  fights per run:    9.6 started, 33.3 shots fired (17.3 hit, 14.9 stopped by shields, 2.8 missed), 0.2 enemies destroyed
  fight endings:     destroyed 20, our hull gave out 350, their crew is dead 6, surrendered 0, we jumped away 0, they jumped away 1, talked down 3, paid off 8, broke off 169
  AI lines per run:  18.2 (about one every 33 seconds)
  pauses per run:    47.7 (state checked every paused frame)

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

Duels (up to 8 game minutes each): every enemy in turn, and a bot fighting it
  Gunnery drone: 100 fights
    endings:        destroyed 100
    length:         median 46s, longest 74s
    our shots:      7.1 per fight; 73% hit, 16% stopped by shields, 9% missed
    their shots:    0.0 per fight, 0.0 hit; our hull at the end 20.0 of 20, crew alive 3.00 of 3
  Salvager skiff: 100 fights
    endings:        surrendered 59, destroyed 24, talked down 8, paid off 8, we jumped away 1
    length:         median 75s, longest 173s
    our shots:      10.1 per fight; 46% hit, 32% stopped by shields, 18% missed
    their shots:    8.2 per fight, 1.1 hit; our hull at the end 18.1 of 20, crew alive 3.00 of 3
    hails answered: talk 22, fight 70, pay 8; 83 surrender offers made

```

PASSED: no crashes, no stuck doors, no crew stuck on a path, power never over supply, no fire without air, no fight left hanging, nothing moved while paused, every run replays from its seed.
