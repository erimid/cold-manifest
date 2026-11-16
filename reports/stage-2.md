# Autoplay report

Command: `node tools/autoplay.js --runs 100 --minutes 10 --seed auto`

```
Cold Manifest autoplay
  runs:              100 (seeds auto-1 to auto-100), each played as chaos, as a hazard scenario, under fire and as a duel with every enemy, each twice
  ship:              Margin of Error, crew of 3, 76 AI lines
  crashed or bad:    0

Chaos (10 game minutes each, 12000 ticks): a bot doing everything at random
  orders per run:    389.9 given, 210.0 refused up front, 0.5 dropped
  door moves:        88.8 completed per run
  power per run:     32.7 bars routed, 1.1 brownouts, door control dark 31% of the time
  hazards per run:   5.3 fires lit, 2.1 spread, 7.0 went out, 2.0 system bars burned, 1.8 rooms jettisoned
  crew per run:      52.2 sent, 36.1 arrived, 0.8 blocked, 2.9 of 3 died
  crew work per run: 1.8 fires put out, 2.2 breaches patched, 4.5 system bars repaired
  air:               rooms were unbreathable 44% of room-time
  fights per run:    9.6 started, 31.2 shots fired (17.7 hit, 12.6 stopped by shields, 2.2 missed), 0.2 enemies destroyed
  boarding per run:  0.8 of ours crossed, 2.2 of theirs crossed, 0.6 killed hand to hand, 0.0 captured
  fight endings:     destroyed 16, our hull gave out 382, their crew is dead 4, surrendered 0, we jumped away 0, they jumped away 2, talked down 4, paid off 5, broke off 157
  AI lines per run:  18.0 (about one every 33 seconds)
  pauses per run:    47.8 (state checked every paused frame)

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
    endings:        surrendered 48, destroyed 19, broke off 15, talked down 8, paid off 8, we jumped away 2
    length:         median 74s, longest 233s
    our shots:      8.1 per fight; 55% hit, 25% stopped by shields, 18% missed
    their shots:    6.8 per fight, 1.3 hit; our hull at the end 17.8 of 20, crew alive 2.07 of 3
    boarding:       1.5 of theirs crossed to us, 0.0 of ours to them per fight; 44 of theirs and 91 of ours killed hand to hand, 3 captured
    hails answered: talk 22, fight 70, pay 8; 68 surrender offers made
  Salvager skiff, and we board them: 100 fights
    endings:        surrendered 27, destroyed 25, broke off 20, we jumped away 11, paid off 8, talked down 7, their crew is dead 2
    length:         median 88s, longest 180s
    our shots:      7.9 per fight; 53% hit, 28% stopped by shields, 16% missed
    their shots:    7.6 per fight, 1.8 hit; our hull at the end 16.9 of 20, crew alive 1.64 of 3
    boarding:       1.3 of theirs crossed to us, 1.5 of ours to them per fight; 71 of theirs and 128 of ours killed hand to hand, 50 captured
    hails answered: pay 8, fight 64, talk 28; 33 surrender offers made

```

PASSED: no crashes, no stuck doors, no crew stuck on a path, power never over supply, no fire without air, no fight left hanging, nothing moved while paused, every run replays from its seed.
