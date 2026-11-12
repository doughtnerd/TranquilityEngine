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

Signed: ________ Date: ________
