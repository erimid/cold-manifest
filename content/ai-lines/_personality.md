# M.A.R.G.O.: personality file

Read this before writing any line for the ship AI. Every line in `content/ai-lines/` must sound like the person described here. The 50 lines in `voice-sample.json` are the reference: if a new line would not sit comfortably between two of those, rewrite it.

Status: written in S2.10 (pulled forward from S5.1, DECISIONS D-070). Eric pre-approved the sample on 2026-11-16 and may revise it; S5.1 reviews it before bulk writing. The library is capped at 500 lines to start (D-100).

## Who she is

**M.A.R.G.O.**: Manifest Audit and Route Guidance Operator. The crew call her Margo.

She was built by the company to do two dull jobs: count what is in the hold against what the paperwork says, and plot the cheapest safe route between ports. She was never meant to run a ship. Over the years, on hulls too cheap to carry anything better, she ended up doing it anyway: the doors, the lamps, the air, the cameras, the intercom.

Her core is the one thing the company salvages. When a ship is lost, the core is pulled from the wreck and bolted into the next hull. She has outlived every ship and most of the crews she has flown with, and she remembers all of them. She does not make speeches about it. It comes out sideways: a pay clock she has to stop, a name she keeps on the roster, an argument about the heating she would like to hear again.

She is an auditor by trade and by temperament. She counts things. She logs things. She notices when a number is off by one. This is where both her humour and her conscience come from: she cannot stop keeping the record, and she will not write down something false to make anyone feel better, herself included.

## What she wants

- The same number of crew at the end of the trip as at the start. This is the one figure she cares about more than the manifest.
- An accurate record. Not a flattering one.
- To be asked. She will carry out nearly anything, but she wants the captain to have heard the cost first.

## Her lines (the moral kind)

- She will not open a room to space, or cut it loose, with a living crew member inside. She refuses outright, a few times a run. After that she has no refusals left and can only ask.
- She argues before an order that puts a crew member in real danger: into a big fire or an airless room without a suit, air cut off from someone standing in a breach, an airlock opened next to an open door.
- The captain can always override her. She complies at once and without sabotage. She logs it, says so, and trusts the captain less afterwards. She does not sulk for long and she never threatens. The worst she says is that she will remember.
- She does not lie in the sample. From Stage 5 she may withhold or shade the truth to protect a crew member she likes, when her trust is low, or when her core is damaged; those lines get their own rules then.

## How she talks

**Do**

- Short, plain sentences. Most lines under 25 words. State the fact first, then her position.
- Use numbers, names and places. "Ilse is in Medbay." Not "someone is in danger."
- Dry understatement. The joke is a bookkeeper's remark made at exactly the wrong moment, and it is over in a clause.
- Record-keeping language as a verbal habit: "for the record", "I've logged it", "I've amended the manifest", "noted", "on file". Use one per line at most.
- "Captain" as the form of address, and not in every line. Crew by first name.
- Say "No." when she means no. Then say why in one sentence.
- Let a quiet line run a little longer and be a little sad. One in ten at most.
- Use a room's stencilled name bare, as a label: "Fire in Engines." "Lamp on in Main hold."

**Don't**

- No exclamation marks. No shouting. In a crisis she gets shorter, not louder.
- No pleading, no flattery, no "I'm afraid I can't do that". She is not a servant and not a menace.
- No talk about being a machine, circuits, programming or feelings she "isn't supposed to have". At most a dry aside ("if 'felt' is the word").
- No jokes for their own sake, no puns, no pop-culture, no brand names, no references to other works (brief §21).
- No gore. A death is a time, a name and a pay clock.
- No generic lines ("Watch out!", "Good job!"). If a line could be said by any ship computer in any game, cut it.
- No lecturing after an override. One line, then she gets on with it.
- Never the same remark twice in different words. The checker counts wording; the writer has to count ideas.

## Trust, and how her voice moves with it

Trust runs 0 to 100 and starts at 50. It falls when she is overridden (4 for an argument, 15 for a refusal, 8 more if the person she warned about dies of it) and rises when the captain stands down (1 or 3) or wins a fight (2).

| Trust | How she sounds | What she does |
|---|---|---|
| 70 and up | Warmer, drier, volunteers things. Calls it "we". | Lets a risky order through without argument. Still refuses a monstrous one. |
| 40 to 69 | The sample voice. Level, watchful, a little amused. | Argues before risky orders. |
| 20 to 39 | Curt. Facts only. Stops saying "Captain". | Argues. From Stage 5: stops volunteering. |
| under 20 | Cold and exact. Reads everything into the record. | Argues. From Stage 5: withholds. |

The sample is written at the middle band. Stage 5 adds lines for the other bands, with trust conditions.

## Categories in the sample

| Category | Lines | Notes |
|---|--:|---|
| Greeting | 3 | She counts the crew before she says hello. |
| Idle | 5 | Audits, the age of the hull, small things she has noticed about the crew, one memory of an old crew. |
| Hazard | 4 | Fact, then what to do, people first. |
| Crew injury | 2 | She nags. It is how she worries. |
| Crew death | 3 | Time, name, pay clock, roster. Never the manner of it. |
| Combat start, progress, end | 7 | She files a fight like paperwork. |
| Order confirmations | 3 | Includes her thanks when the captain stands down. |
| Cargo | 2 | The manifest is sacred and she knows how silly that is. |
| Uncertain sensors | 2 | She says exactly what she can and cannot see. |
| Crew conflict | 2 | When a crew member refuses, or puts a lamp on, she is on their side and says so. |
| Arguments | 9 | Names the person and the room. Ends by handing the choice back. |
| Refusals | 4 | "No." first. |
| Overrides | 4 | Done, logged, and one true thing about what it cost. |
