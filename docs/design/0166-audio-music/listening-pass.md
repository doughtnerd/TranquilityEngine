# M4 listening pass: interactive music (ADR 0166, 0167)

The owner's listening pass for M4, the interactive music milestone. It takes the owner's listening items from the [M4 waves plan](../../plans/2026-11-audio-music-m4-waves.md) (one section per milestone) and gives each a key and a scene. The earlier passes are [M1](../0157-audio-core/listening-pass.md), [M2](../0157-audio-core/m2-listening-pass.md) and [M3](../0162-audio-spatial/listening-pass.md).

**Nobody has auditioned this yet.** Every "listen for" line is what the engine is built to do, checked against the code, not a finding. Mark each item pass or fail, add a note, then sign at the end.

## M4-0: in-voice stamped records (task Z5)

- **Run (owner, headphones):** `E2E_LISTEN=1 npm run test:e2e:slow -- audio-music-listening --headed --workers 1`. A card lists the keys; the spec waits for each key, then checks the item ran.
- **Headless smoke (CI-style):** `npm run test:e2e:slow -- audio-music-listening` presses the keys itself.
- **Scene:** the Sound Lab, loaded by the spec (no sample is edited). The Music, Ambience, SFX and Engine buses are muted; 64 quiet looping voices play on UI as a crowd; the item's voices play on the Tape bus. Every record is stamped 1 s ahead of `Audio.time`.

| Key | Item | Listen for | Pass / fail, note |
|---|---|---|---|
| 1 | Stamped linear fade of one voice (the radio loop) to 0.1 over 1.5 s | about 1 s of nothing, then one smooth dip to about a sixth of the level; the crowd doesn't move; no click, no dropout | |
| 2 | Stamped stop of the melody loop with a 0.4 s fade (press twice; the spec checks the bus falls silent) | fades out over about 0.4 s and is gone, no click at the end; the crowd keeps playing | |
| 3 | 2 s crossfade, pad into lead, linear in and out | the pad hands over to the lead with a slight dip in the middle; no jump at either end | |
| 4 | the same crossfade with the S-curve | slow at both ends, quick in the middle; no jump at either end | |
| 5 | the same crossfade with equal power in and out | the level stays steady throughout (the one that should sound right); no jump at either end | |
| 0 | stops everything | | |

**What the spec confirms (not by ear):** each named voice is in the voice table with the right clip; the logged fade has the right voice, law and `stopAtEnd`; the stopped voice leaves the table; the Tape bus falls silent; `splitQuanta` doesn't move. **Limit:** `Audio.debug()` doesn't report which curve ran inside the core; the law check reads the page's own log of its `fadeShaped` calls. The core-side proof is the cargo goldens (`in_voice_goldens.rs`, `in_voice_isolation.rs`) and the metered bench's `splitQuanta == 0`.

## M4a: segments, stems and playlists (task E1)

- **Run (owner, headphones):** `E2E_LISTEN=1 npm run test:e2e:slow -- audio-music-listening --headed --workers 1`. The M4a case shows a card of keys; the spec waits for each key, then checks the item ran.
- **Headless smoke:** `npm run test:e2e:slow -- audio-music-listening` presses the keys itself. The 10-minute exit check is separate: `npm run test:e2e:slow -- audio-music-a --repeat-each 3`.
- **Scene:** the Sound Lab, loaded by the spec (no sample is edited). The spec builds the music events from the lab's 4 s stems (pad, pulse, lead, and a streamed melody) at 120 bpm. The Music, Ambience, SFX and Engine buses are muted, and the item plays alone on the Tape bus.

| Key | Item | Listen for | Pass / fail, note |
|---|---|---|---|
| 1 | Eight stems start together on a cue, 10 s (pad, pulse, lead and melody, each twice; the two melodies stream) | one band entering on a single instant; no stem early or late; no phasing or flam between a stem and its double; a steady loop every 4 s | |
| 2 | The same with a slow ring: the melody file is held back 1.5 s | the music starts about 1.5–3 s after play, and all eight stems begin together; none enters ahead of the others | |
| 3 | A held group: the eight stems play, then the decoder worker is paused until the core holds the group, and resumed at once (Chromium) | when the streamed stems run dry, the whole band dips together over about 5 ms, and every stem, decoded and streamed, goes silent at the same instant, with none left playing alone. After the worker resumes (well under a second) the band returns together and aligned: no stem ahead of or behind the others, no phasing or flam between a stem and its double. The music then plays on as before | |
| 4 | A playlist of three 4 s items (A pad + pulse, B lead + pulse, C melody + pad), 30 s | each change on the beat; no gap, no click, no doubled or missing beat | |
| 5 | The Flappy sample's town music, 20 s (the spec opens the sample) | a steady 105 bpm piece that loops without a gap or click; no warbling | |

**What the spec confirms (not by ear):**
- **Keys 1 and 2:** one group of 8 primed stems, all eight `playing` with a playhead, the six decoded stems on one playhead; the Tape bus audible; no group late, held or abandoned; no slip; no split. Key 2 also checks that the file was requested and that play-to-playing exceeds the delay.
- **Key 3:** `groupsHeld >= 1`; the six decoded stems back on one playhead after the resume; not abandoned; no split. A hold longer than 1 s is given up on by design.
- **Key 4:** the items in order A, B, C; no late group.
- **Key 5:** the stem streams through a ring, at 105 bpm.

**Limit:** headless Chromium has no sound output, so the walker reads the core's meters and counters, not the signal.

## M4b: transitions, stingers and loop exits (task E2)

- **Run (owner, headphones):** `E2E_LISTEN=1 npm run test:e2e:slow -- audio-music-listening --headed --workers 1 -g M4b`. The M4b case shows a card of the page's keys; the spec waits for each key, prints what it does and what to listen for, then checks the item ran.
- **Headless smoke:** `npm run test:e2e:slow -- audio-music-listening -g M4b` presses the keys itself. The exit check is separate: `npm run test:e2e -- audio-music-b --repeat-each 3`.
- **Scene:** the Sound Lab's music page, opened by the spec with M; the keys are the page's own. The world switch starts in explore at 120 bpm, so every change lands on a bar line. The music plays on the Music bus; the Ambience, SFX, Engine and Tape buses are muted.

| Key | Item | Listen for | Pass / fail, note |
|---|---|---|---|
| 2 | Explore to combat: a cut on the next bar line | the old music stops and combat starts at the same instant; no gap, no click, no overlap | |
| 1 | Combat to explore: a 2-beat (1 s) equal-power crossfade on the next bar line | the level stays steady through the hand-over, no dip, no jump | |
| 3 | Explore to calm: a 4-beat (2 s) linear crossfade | a slight dip in the middle of the hand-over; no jump at either end | |
| 1 | Calm to explore: a 4-beat (2 s) S-curve crossfade | slow at both ends, quick in the middle; no jump at either end | |
| 3, then 2 | Explore to calm (the way to the bridge), then calm to combat through the bridge, a one-bar noise riser | on the bar line, calm crossfades (1 beat) into the riser, which plays one bar; combat starts at full level on the riser's last sample; no gap, no click, no doubled beat | |
| 3 | Combat to calm: no rule of its own, so the default rule, a 1-beat (0.5 s) equal-power crossfade | a short, level hand-over on the bar line | |
| L, then L again | The loop: a 2-bar body (4 s) with a 1-bar tail (a crash and a chord); press L again after two or more passes | a steady loop, the tail ringing over the start of each pass and never cut. After the second L, the pass in progress finishes, the tail rings out whole, and the music ends without a click | |
| 1, then T, then Y | Back to the world in explore; a stinger on the next beat (T) and on the next bar line (Y) | the hit lands on the beat, then on the bar line; the music carries on unchanged under it | |
| 3, then 2 within a second | A switch that changes its mind: calm is asked for, then combat before the bar line | the music goes to combat on the bar line, and calm is never heard (if your second press comes after the bar line, the spec notes it rather than failing) | |
| O | Stops | the music stops cleanly | |

**What the spec confirms (not by ear):**
- **Each change:** the debug row's pending change names the rule that chose it (pair, index, tier, parent `world`; the default rule is `*>*`, tier 4), and the new segment lands on a bar line. The bridge goes through `riser`. The Music bus is audible after each change.
- **Headless only:** the crossfade overlaps measure 0 s (cut), 1.1 s, 2.0 s and 0.5 s.
- **Loop exit:** the body's playhead runs past its 4 s loop end after the release (to 5.9 s), so the tail rang out.
- **Stingers:** each is counted as played.
- **Counters:** `groupsLate`, `groupsHeld`, `groupsAbandoned`, `maxSlipFrames` and `splitQuanta` are 0 after every change; no errors, no warnings.

**Limit:** headless Chromium has no sound output, so the walker reads the engine's rows, voice playheads and counters, not the signal.

Signed: ________ Date: ________
