# Autoplay report

Command: `node tools/autoplay.js --runs 100 --minutes 10 --seed auto`

```
Cold Manifest autoplay
  runs:              100 (seeds auto-1 to auto-100), each played as chaos, as a hazard scenario, under fire and as a duel with every enemy, each twice
  ship:              Margin of Error, crew of 3, 76 AI lines
  crashed or bad:    0

Chaos (10 game minutes each, 12000 ticks): a bot doing everything at random
  orders per run:    397.4 given, 196.4 refused up front, 0.5 dropped
  door moves:        83.0 completed per run
  power per run:     32.8 bars routed, 1.1 brownouts, door control dark 30% of the time
  hazards per run:   5.4 fires lit, 3.2 spread, 8.3 went out, 2.5 system bars burned, 1.7 rooms jettisoned
  crew per run:      59.3 sent, 28.3 arrived, 0.5 blocked, 3.0 of 3 died
  crew work per run: 1.7 fires put out, 1.6 breaches patched, 3.8 system bars repaired
  air:               rooms were unbreathable 43% of room-time
  fights per run:    9.7 started, 31.7 shots fired (17.4 hit, 13.2 stopped by shields, 2.4 missed), 0.1 enemies destroyed
  boarding per run:  0.4 of ours crossed, 2.3 of theirs crossed, 0.3 killed hand to hand, 0.0 captured
  fight endings:     destroyed 13, our hull gave out 384, their crew is dead 5, surrendered 1, we jumped away 0, they jumped away 2, talked down 2, paid off 7, broke off 169
  AI lines per run:  19.4 (about one every 31 seconds)
  pauses per run:    47.7 (state checked every paused frame)

Hazard scenarios (5 game minutes each): fires and breaches at once, and a bot trying to save the ship
  completed:         100 of 100
  emergencies:       2.0 fires and 0.9 breaches at the start; at worst 2.5 rooms burning at once
  ship saved:        93 of 100 (93%) ended with no fire and no breach
  time to clear:     median 29s, slowest 216s
  crew alive at end: 2.99 of 3 on average; everyone lived in 99% of runs, nobody in 0%
  system damage:     0.8 bars left broken at the end
  AI lines:          7.8 per scenario

Under fire (5 game minutes each): shots land on the ship for 2 minutes, then the same bot cleans up
  completed:         100 of 100
  hits per run:      11.5 landed; between them 3.2 fires, 4.7 breaches, 8.9 system bars broken, 0.6 crew hurt
  ship saved:        80 of 100 (80%) ended with no fire and no breach; median 20s after the last shot
  crew alive at end: 2.65 of 3 on average; everyone lived in 85% of runs
  deaths by cause:   fire 17, suffocation 17, hit 1
  hull left:         1.7 of 20 on average; 2.4 system bars still broken at the end

Duels (up to 8 game minutes each): every enemy in turn, and a bot fighting it
  Gunnery drone: 100 fights
    endings:        destroyed 100
    length:         median 46s, longest 74s
    our shots:      7.1 per fight; 73% hit, 16% stopped by shields, 9% missed
    their shots:    0.0 per fight, 0.0 hit; our hull at the end 20.0 of 20, crew alive 3.00 of 3
  Salvager skiff: 100 fights
    endings:        surrendered 51, destroyed 20, broke off 10, talked down 8, paid off 8, we jumped away 3
    length:         median 68s, longest 205s
    our shots:      8.2 per fight; 56% hit, 24% stopped by shields, 18% missed
    their shots:    6.7 per fight, 1.3 hit; our hull at the end 17.8 of 20, crew alive 2.40 of 3
    boarding:       1.0 of theirs crossed to us, 0.0 of ours to them per fight; 25 of theirs and 59 of ours killed hand to hand, 3 captured
    hails answered: talk 22, fight 70, pay 8; 71 surrender offers made
  Salvager skiff, and we board them: 100 fights
    endings:        surrendered 43, destroyed 22, broke off 10, paid off 8, talked down 7, we jumped away 7, their crew is dead 2, our hull gave out 1
    length:         median 74s, longest 235s
    our shots:      8.1 per fight; 56% hit, 26% stopped by shields, 15% missed
    their shots:    6.8 per fight, 1.7 hit; our hull at the end 17.2 of 20, crew alive 1.86 of 3
    boarding:       0.9 of theirs crossed to us, 1.3 of ours to them per fight; 63 of theirs and 107 of ours killed hand to hand, 33 captured
    hails answered: pay 8, fight 64, talk 28; 57 surrender offers made

```

PASSED: no crashes, no stuck doors, no crew stuck on a path, power never over supply, no fire without air, no fight left hanging, nothing moved while paused, every run replays from its seed.
