# Autoplay report

Command: `node tools/autoplay.js --runs 100 --minutes 10 --seed auto`

```
Cold Manifest autoplay
  runs:              100 (seeds auto-1 to auto-100), each played as chaos, as a hazard scenario, under fire and as a duel with every enemy, each twice
  ship:              Margin of Error, crew of 3, 100 AI lines
  crashed or bad:    0

Chaos (10 game minutes each, 12000 ticks): a bot doing everything at random
  orders per run:    392.3 given, 203.7 refused up front, 0.4 dropped
  door moves:        86.0 completed per run
  power per run:     33.8 bars routed, 1.4 brownouts, door control dark 33% of the time
  hazards per run:   5.3 fires lit, 3.0 spread, 8.1 went out, 2.7 system bars burned, 1.8 rooms jettisoned
  crew per run:      60.2 sent, 29.0 arrived, 0.5 blocked, 3.0 of 3 died
  crew work per run: 1.5 fires put out, 1.5 breaches patched, 4.5 system bars repaired
  air:               rooms were unbreathable 41% of room-time
  fights per run:    8.3 started, 42.5 shots fired (13.5 hit, 13.7 stopped by shields, 17.5 missed), 0.1 enemies destroyed
  boarding per run:  0.5 of ours crossed, 2.8 of theirs crossed, 0.5 killed hand to hand, 0.0 captured
  fight endings:     destroyed 7, our hull gave out 261, their crew is dead 5, surrendered 0, we jumped away 0, they jumped away 1, talked down 0, paid off 6, broke off 167
  AI lines per run:  22.0 (about one every 27 seconds)
  pauses per run:    48.0 (state checked every paused frame)

Hazard scenarios (5 game minutes each): fires and breaches at once, and a bot trying to save the ship
  completed:         100 of 100
  emergencies:       2.0 fires and 0.9 breaches at the start; at worst 2.5 rooms burning at once
  ship saved:        93 of 100 (93%) ended with no fire and no breach
  time to clear:     median 29s, slowest 216s
  crew alive at end: 2.99 of 3 on average; everyone lived in 99% of runs, nobody in 0%
  system damage:     0.8 bars left broken at the end
  AI lines:          7.9 per scenario

Under fire (5 game minutes each): shots land on the ship for 2 minutes, then the same bot cleans up
  completed:         100 of 100
  hits per run:      12.8 landed; between them 3.5 fires, 5.3 breaches, 9.9 system bars broken, 0.6 crew hurt
  ship saved:        78 of 100 (78%) ended with no fire and no breach; median 26s after the last shot
  crew alive at end: 2.51 of 3 on average; everyone lived in 81% of runs
  deaths by cause:   suffocation 33, fire 14, hit 2
  hull left:         0.4 of 20 on average; 2.5 system bars still broken at the end

Duels (up to 8 game minutes each): every enemy in turn, and a bot fighting it
  Gunnery drone: 100 fights
    endings:        destroyed 100
    length:         median 46s, longest 46s
    our shots:      6.0 per fight; 83% hit, 17% stopped by shields, 0% missed
    their shots:    0.0 per fight, 0.0 hit; our hull at the end 20.0 of 20, crew alive 3.00 of 3
  Salvager skiff: 100 fights
    endings:        surrendered 61, destroyed 13, paid off 10, broke off 7, talked down 6, our hull gave out 2, they jumped away 1
    length:         median 54s, longest 271s
    our shots:      6.9 per fight; 67% hit, 24% stopped by shields, 6% missed
    their shots:    6.2 per fight, 2.3 hit; our hull at the end 16.7 of 20, crew alive 2.66 of 3
    boarding:       0.9 of theirs crossed to us, 0.0 of ours to them per fight; 12 of theirs and 31 of ours killed hand to hand, 3 captured
    hails answered: talk 19, fight 71, pay 10; 75 surrender offers made
  Salvager skiff, and we board them: 100 fights
    endings:        surrendered 42, destroyed 13, paid off 12, our hull gave out 12, broke off 10, talked down 8, their crew is dead 2, we jumped away 1
    length:         median 60s, longest 298s
    our shots:      5.8 per fight; 65% hit, 30% stopped by shields, 1% missed
    their shots:    7.3 per fight, 2.8 hit; our hull at the end 15.8 of 20, crew alive 2.11 of 3
    boarding:       0.8 of theirs crossed to us, 1.3 of ours to them per fight; 59 of theirs and 75 of ours killed hand to hand, 8 captured
    hails answered: pay 12, fight 64, talk 24; 52 surrender offers made

Running dark (S2.7): the same duels, split by how the bot fought. Odd seeds lit (every lamp on, drive burning), even seeds dark (lamps off, drive cold)
  Gunnery drone, lit : 50 fights; it never fired. Our signature 59% on average
  Gunnery drone, dark: 50 fights; it never fired. Our signature 35% on average
  Salvager skiff, lit : 100 fights; their shots 52% hit, 31% went wide, 8% were fired blind
                        our signature 55% on average; they held a lock 93% of the fight and lost it 0.1 times; we won 50%, lost the ship 14%, hull left 13.1
  Salvager skiff, dark: 100 fights; their shots 7% hit, 56% went wide, 5% were fired blind
                        our signature 34% on average; they held a lock 87% of the fight and lost it 0.2 times; we won 81%, lost the ship 0%, hull left 19.5

```

PASSED: no crashes, no stuck doors, no crew stuck on a path, power never over supply, no fire without air, no fight left hanging, nothing moved while paused, every run replays from its seed.
