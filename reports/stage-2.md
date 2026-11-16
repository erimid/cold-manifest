# Autoplay report

Command: `node tools/autoplay.js --runs 100 --minutes 10 --seed auto`

```
Cold Manifest autoplay
  runs:              100 (seeds auto-1 to auto-100), each played as chaos, as a hazard scenario, under fire and as a duel with every enemy, each twice
  ship:              Margin of Error, crew of 3, 179 AI lines
  crashed or bad:    0

Chaos (10 game minutes each, 12000 ticks): a bot doing everything at random
  orders per run:    378.5 given, 209.1 refused up front, 0.7 dropped
  door moves:        88.6 completed per run
  power per run:     30.7 bars routed, 1.6 brownouts, door control dark 35% of the time
  hazards per run:   6.1 fires lit, 2.9 spread, 8.8 went out, 1.9 system bars burned, 1.7 rooms jettisoned
  crew per run:      42.5 sent, 25.1 arrived, 0.7 blocked, 3.0 of 3 died
  crew work per run: 1.3 fires put out, 1.7 breaches patched, 3.9 system bars repaired
  air:               rooms were unbreathable 46% of room-time
  fights per run:    11.9 started, 35.8 shots fired (24.1 hit, 2.5 stopped by a brace, 18.8 missed), 0.1 enemies destroyed
  boarding per run:  0.3 of ours crossed, 1.9 of theirs crossed, 0.4 killed hand to hand, 0.1 captured
  fight endings:     destroyed 13, our hull gave out 721, their crew is dead 9, surrendered 1, we jumped away 0, they jumped away 5, talked down 5, paid off 8, broke off 55
  AI lines per run:  23.9 (about one every 25 seconds)
  pauses per run:    48.0 (state checked every paused frame)

Hazard scenarios (5 game minutes each): fires and breaches at once, and a bot trying to save the ship
  completed:         100 of 100
  emergencies:       2.0 fires and 0.9 breaches at the start; at worst 2.2 rooms burning at once
  ship saved:        97 of 100 (97%) ended with no fire and no breach
  time to clear:     median 25s, slowest 80s
  crew alive at end: 3.00 of 3 on average; everyone lived in 100% of runs, nobody in 0%
  system damage:     0.2 bars left broken at the end
  AI lines:          8.9 per scenario

Under fire (5 game minutes each): shots land on the ship for 2 minutes, then the same bot cleans up
  completed:         100 of 100
  hits per run:      12.8 landed; between them 3.0 fires, 4.1 breaches, 10.0 system bars broken, 0.4 crew hurt
  ship saved:        92 of 100 (92%) ended with no fire and no breach; median 8s after the last shot
  crew alive at end: 2.97 of 3 on average; everyone lived in 98% of runs
  deaths by cause:   fire 3
  hull left:         1.4 of 20 on average; 1.0 system bars still broken at the end

Duels (up to 12 game minutes each): every enemy in turn, and a bot fighting it
  Gunnery drone: 100 fights
    endings:        destroyed 100
    length:         median 71s, longest 71s
    our shots:      6.0 per fight; 91% hit, 9% stopped by a brace, 0% missed
    braces:         we braced 0.0 times a fight and stopped n/a of their shots; they braced 0.5 times
    ammo:           0.0 runs to the hold per fight (theirs 0.0); a heavy gun of ours sat empty 2% of the fight
    their shots:    0.0 per fight, 0.0 hit; our hull at the end 20.0 of 20, crew alive 3.00 of 3
  Salvager skiff: 100 fights
    endings:        surrendered 62, destroyed 12, paid off 10, broke off 6, talked down 6, our hull gave out 3, they jumped away 1
    length:         median 72s, longest 245s
    our shots:      6.3 per fight; 83% hit, 12% stopped by a brace, 4% missed
    braces:         we braced 1.9 times a fight and stopped 22% of their shots; they braced 0.8 times
    ammo:           0.1 runs to the hold per fight (theirs 0.3); a heavy gun of ours sat empty 5% of the fight
    their shots:    6.4 per fight, 2.5 hit; our hull at the end 16.6 of 20, crew alive 2.52 of 3
    boarding:       1.3 of theirs crossed to us, 0.0 of ours to them per fight; 25 of theirs and 45 of ours killed hand to hand, 5 captured
    hails answered: talk 19, fight 71, pay 10; 77 surrender offers made
  Salvager skiff, and we board them: 100 fights
    endings:        surrendered 35, broke off 25, destroyed 13, paid off 12, talked down 8, our hull gave out 3, they jumped away 2, their crew is dead 2
    length:         median 102s, longest 491s
    our shots:      5.8 per fight; 85% hit, 11% stopped by a brace, 4% missed
    braces:         we braced 2.3 times a fight and stopped 24% of their shots; they braced 0.7 times
    ammo:           0.1 runs to the hold per fight (theirs 0.3); a heavy gun of ours sat empty 8% of the fight
    their shots:    7.2 per fight, 2.4 hit; our hull at the end 16.7 of 20, crew alive 1.97 of 3
    boarding:       1.2 of theirs crossed to us, 1.1 of ours to them per fight; 47 of theirs and 85 of ours killed hand to hand, 8 captured
    hails answered: pay 12, fight 64, talk 24; 46 surrender offers made
  Knife cutter: 100 fights
    endings:        destroyed 76, our hull gave out 16, they jumped away 5, we jumped away 3
    length:         median 79s, longest 247s
    our shots:      6.5 per fight; 83% hit, 9% stopped by a brace, 6% missed
    braces:         we braced 4.5 times a fight and stopped 17% of their shots; they braced 0.6 times
    ammo:           0.0 runs to the hold per fight (theirs 0.7); a heavy gun of ours sat empty 1% of the fight
    their shots:    22.8 per fight, 9.2 hit; our hull at the end 9.5 of 20, crew alive 2.87 of 3
    boarding:       0.0 of theirs crossed to us, 0.0 of ours to them per fight; 0 of theirs and 0 of ours killed hand to hand, 0 captured
  Knife cutter, and we board them: 100 fights
    endings:        destroyed 41, their crew is dead 27, our hull gave out 19, they jumped away 7, we jumped away 4, broke off 2
    length:         median 78s, longest 331s
    our shots:      5.7 per fight; 81% hit, 9% stopped by a brace, 9% missed
    braces:         we braced 5.0 times a fight and stopped 17% of their shots; they braced 0.5 times
    ammo:           0.0 runs to the hold per fight (theirs 0.7); a heavy gun of ours sat empty 1% of the fight
    their shots:    26.0 per fight, 9.4 hit; our hull at the end 9.2 of 20, crew alive 1.50 of 3
    boarding:       0.0 of theirs crossed to us, 1.8 of ours to them per fight; 76 of theirs and 116 of ours killed hand to hand, 0 captured
  Grapple tender: 100 fights
    endings:        surrendered 55, destroyed 18, broke off 8, talked down 8, paid off 7, our hull gave out 3, they jumped away 1
    length:         median 96s, longest 442s
    our shots:      8.0 per fight; 80% hit, 12% stopped by a brace, 7% missed
    braces:         we braced 2.1 times a fight and stopped 11% of their shots; they braced 1.1 times
    ammo:           0.3 runs to the hold per fight (theirs 0.0); a heavy gun of ours sat empty 20% of the fight
    their shots:    9.3 per fight, 3.2 hit; our hull at the end 16.8 of 20, crew alive 2.25 of 3
    boarding:       2.2 of theirs crossed to us, 0.0 of ours to them per fight; 21 of theirs and 70 of ours killed hand to hand, 4 captured
    hails answered: pay 7, fight 72, talk 21; 74 surrender offers made
  Grapple tender, and we board them: 100 fights
    endings:        surrendered 60, broke off 12, destroyed 11, paid off 7, our hull gave out 5, talked down 4, they jumped away 1
    length:         median 105s, longest 480s
    our shots:      8.3 per fight; 78% hit, 13% stopped by a brace, 8% missed
    braces:         we braced 2.2 times a fight and stopped 9% of their shots; they braced 1.2 times
    ammo:           0.4 runs to the hold per fight (theirs 0.0); a heavy gun of ours sat empty 14% of the fight
    their shots:    11.5 per fight, 4.0 hit; our hull at the end 15.9 of 20, crew alive 2.18 of 3
    boarding:       2.2 of theirs crossed to us, 0.0 of ours to them per fight; 31 of theirs and 66 of ours killed hand to hand, 7 captured
    hails answered: fight 75, talk 18, pay 7; 77 surrender offers made
  Bulwark: 100 fights
    endings:        broke off 52, surrendered 14, we jumped away 12, talked down 10, paid off 9, our hull gave out 2, destroyed 1
    length:         median 134s, longest 525s
    our shots:      14.7 per fight; 16% hit, 81% stopped by a brace, 1% missed
    braces:         we braced 4.2 times a fight and stopped 41% of their shots; they braced 8.6 times
    ammo:           1.2 runs to the hold per fight (theirs 1.8); a heavy gun of ours sat empty 23% of the fight
    their shots:    7.4 per fight, 2.5 hit; our hull at the end 14.9 of 20, crew alive 3.00 of 3
    boarding:       0.0 of theirs crossed to us, 0.0 of ours to them per fight; 0 of theirs and 0 of ours killed hand to hand, 0 captured
    hails answered: pay 9, fight 71, talk 20; 15 surrender offers made
  Bulwark, and we board them: 100 fights
    endings:        broke off 75, talked down 10, paid off 9, destroyed 2, we jumped away 1, surrendered 1, their crew is dead 1, our hull gave out 1
    length:         median 92s, longest 394s
    our shots:      11.3 per fight; 13% hit, 82% stopped by a brace, 2% missed
    braces:         we braced 5.0 times a fight and stopped 54% of their shots; they braced 7.9 times
    ammo:           0.3 runs to the hold per fight (theirs 1.6); a heavy gun of ours sat empty 15% of the fight
    their shots:    6.8 per fight, 1.3 hit; our hull at the end 17.4 of 20, crew alive 2.01 of 3
    boarding:       0.0 of theirs crossed to us, 1.1 of ours to them per fight; 12 of theirs and 97 of ours killed hand to hand, 0 captured
    hails answered: talk 17, fight 74, pay 9; 3 surrender offers made
  Drone carrier: 100 fights
    endings:        surrendered 65, destroyed 18, our hull gave out 16, we jumped away 1
    length:         median 93s, longest 204s
    our shots:      8.6 per fight; 81% hit, 9% stopped by a brace, 9% missed
    braces:         we braced 3.7 times a fight and stopped 14% of their shots; they braced 0.8 times
    ammo:           0.2 runs to the hold per fight (theirs 0.0); a heavy gun of ours sat empty 14% of the fight
    their shots:    18.6 per fight, 7.8 hit; our hull at the end 12.2 of 20, crew alive 2.96 of 3
    boarding:       0.0 of theirs crossed to us, 0.0 of ours to them per fight; 0 of theirs and 0 of ours killed hand to hand, 0 captured
  Drone carrier, and we board them: 100 fights
    endings:        surrendered 47, their crew is dead 26, our hull gave out 14, destroyed 12, we jumped away 1
    length:         median 74s, longest 190s
    our shots:      7.6 per fight; 83% hit, 8% stopped by a brace, 8% missed
    braces:         we braced 2.9 times a fight and stopped 13% of their shots; they braced 0.7 times
    ammo:           0.1 runs to the hold per fight (theirs 0.0); a heavy gun of ours sat empty 14% of the fight
    their shots:    15.9 per fight, 6.9 hit; our hull at the end 13.1 of 20, crew alive 1.90 of 3
    boarding:       0.0 of theirs crossed to us, 1.9 of ours to them per fight; 104 of theirs and 83 of ours killed hand to hand, 0 captured

Enemy types (S2.5): the plain duels side by side, lit and dark together
  enemy              won   parted  lost   median length   our hull lost   their shots that hit
  Gunnery drone      100%     0%     0%             71s             0.0   never fired
  Salvager skiff      74%    23%     3%             72s             3.4   39%
  Knife cutter        76%     8%    16%             79s            10.5   40%
  Grapple tender      73%    24%     3%             96s             3.2   34%
  Bulwark             15%    83%     2%            134s             5.1   34%
  Drone carrier       83%     1%    16%             93s             7.8   42%

Running dark (S2.7): the same duels, split by how the bot fought. Odd seeds lit (every lamp on, drive burning), even seeds dark (lamps off, drive cold)
  Gunnery drone, lit : 50 fights; it never fired. Our signature 59% on average
  Gunnery drone, dark: 50 fights; it never fired. Our signature 34% on average
  Salvager skiff, lit : 100 fights; their shots 56% hit, 26% went wide, 5% were fired blind
                        our signature 56% on average; they held a lock 93% of the fight and lost it 0.1 times; we won 61%, lost the ship 6%, hull left 15.1
  Salvager skiff, dark: 100 fights; their shots 17% hit, 54% went wide, 20% were fired blind
                        our signature 32% on average; they held a lock 68% of the fight and lost it 1.1 times; we won 63%, lost the ship 0%, hull left 18.2
  Knife cutter, lit : 100 fights; their shots 54% hit, 18% went wide, 0% were fired blind
                      our signature 63% on average; they held a lock 99% of the fight and lost it 0.0 times; we won 75%, lost the ship 17%, hull left 8.8
  Knife cutter, dark: 100 fights; their shots 29% hit, 60% went wide, 36% were fired blind
                      our signature 32% on average; they held a lock 63% of the fight and lost it 2.6 times; we won 69%, lost the ship 18%, hull left 9.9
  Grapple tender, lit : 100 fights; their shots 56% hit, 42% went wide, 29% were fired blind
                        our signature 50% on average; they held a lock 83% of the fight and lost it 0.1 times; we won 70%, lost the ship 6%, hull left 16.3
  Grapple tender, dark: 100 fights; their shots 25% hit, 61% went wide, 32% were fired blind
                        our signature 31% on average; they held a lock 69% of the fight and lost it 1.7 times; we won 74%, lost the ship 2%, hull left 16.5
  Bulwark, lit : 100 fights; their shots 45% hit, 17% went wide, 0% were fired blind
                 our signature 59% on average; they held a lock 100% of the fight and lost it 0.0 times; we won 13%, lost the ship 3%, hull left 12.3
  Bulwark, dark: 100 fights; their shots 0% hit, 38% went wide, 0% were fired blind
                 our signature 40% on average; they held a lock 97% of the fight and lost it 0.0 times; we won 6%, lost the ship 0%, hull left 20.0
  Drone carrier, lit : 100 fights; their shots 71% hit, 20% went wide, 0% were fired blind
                       our signature 61% on average; they held a lock 99% of the fight and lost it 0.0 times; we won 82%, lost the ship 17%, hull left 11.2
  Drone carrier, dark: 100 fights; their shots 27% hit, 57% went wide, 23% were fired blind
                       our signature 35% on average; they held a lock 81% of the fight and lost it 1.4 times; we won 86%, lost the ship 13%, hull left 14.1

Margo and the crew (S2.10): orders she held, and orders the crew would not take
  chaos, per run:    she argued 0.6 times and refused 0.1; the bot overrode her 0.3 times, stood down 0.3, let 0.1 lapse
                     crew refused 6.9 of 49.4 orders to move (14%); the dark got to someone 0.6 times and 0.5 lamps went on by a crew hand
  hazard scenarios:  she argued in 50% of runs (17% of orders to move); crew refused in 1% of runs (0% of orders): burns 1
  under fire:        she argued in 13% of runs (1% of orders to move); crew refused in 4% of runs (0% of orders): burns 5, a room where someone died 1
  duels, lit :       the dark got to someone 0.0 times a fight and 0.0 lamps went on by a crew hand; 16.0 of 17 rooms lit on average
                     crew refused in 4% of fights (1% of orders to move): a room where someone died 20, burns 2
  duels, dark:       the dark got to someone 1.2 times a fight and 1.1 lamps went on by a crew hand; 0.4 of 17 rooms lit on average
                     crew refused in 9% of fights (6% of orders to move): the dark 98, a room where someone died 15, burns 4
  her trust:         51 of 100 at the end of a hazard scenario, 50 under fire (it starts at 50)

```

PASSED: no crashes, no stuck doors, no crew stuck on a path, power never over supply, no fire without air, no fight left hanging, nothing moved while paused, every run replays from its seed.
