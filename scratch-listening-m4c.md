## M4c: beat feel, calibration and the tap game (task E3)

- **Run (owner, headphones):** `E2E_LISTEN=1 npm run test:e2e:slow -- audio-music-listening --headed --workers 1 -g M4c`. The M4c case shows a card of the page's keys; the spec waits for each key, prints what it does and what to listen for, then checks the item ran. You tap with the SPACE bar; the spec opens the page, reloads it once, and reads what the page says.
- **Headless smoke:** `npm run test:e2e:slow -- audio-music-listening -g M4c` presses C, G, X and O itself and injects the taps (+35 ms from the beat for the calibration run) through `globalThis.__rhythmLab.tap(performanceTime)`. The exit check is separate: `npm run test:e2e -- audio-music-c --repeat-each 3 --project chromium`.
- **Scene:** the Sound Lab's rhythm page, opened by the spec with R from the tour (B comes back). Click the game view first (the spec does). The keys are the page's own: **C** calibrate, **SPACE** tap, **G** tap game, **X** reset the calibration to 0, **O** stop. The music plays on the Music bus; the Ambience, SFX, Engine and Tape buses are muted. `Audio.rhythmMode` is off in this sample (the page says "rhythm mode off"); the line "Audio.latency" shows what the browser reports, and whether it can be trusted.

| Key | Item | Listen for / do | Pass / fail, note |
|---|---|---|---|
| C | The click track: 120 bpm, a click on every beat, beat 1 (the first of four) higher | Listen for a few bars before tapping. Even, steady clicks; every fourth click is higher; the page's beat marker `(*)` flashes with each click, in step with what you hear, not before or after | |
| SPACE x20 | Calibration: tap on every click, 20 taps (the first 4 are warm-up and are dropped) | The page counts the taps (`n/20`) and shows how far the last one was from its click (`+` late, `-` early). When you finish it shows the offset and the spread in ms and "Steady: applied to Audio.calibration and stored for this output device". A steady run has a spread within 40 ms (a few ms to 20 ms is typical for a good tapper). An "Unsteady: NOT applied" result is a bad run, not a bug: press C and tap more evenly | |
| (reload) | The offset persists: the spec reloads the page and opens the rhythm page again | The line `Audio.calibration` shows the same offset as before the reload (to the 0.1 ms the page prints) | |
| G | The tap game: a drum and bass loop; tap SPACE on the beat, at least 8 taps | Each tap is graded PERFECT (within 30 ms of the beat after the calibration is taken off), GOOD (within 80 ms) or MISS, with early or late in ms; hits, misses and the streak count. With a good calibration, taps that feel on the beat read near 0 ms; the beat marker `(*)` is in step with the drums | |
| X | Reset: the calibration goes back to 0 | The line `Audio.calibration` reads `+0.0 ms`. Tap the game again: taps that were near 0 now read early or late by about the offset you calibrated, so the grades get worse (the zero changed) | |
| O | Stops | the music stops cleanly | |

**What the spec confirms (not by ear):**
- **Click track:** the debug row is the segment `click` at 120 bpm, playing; the page counts two beats a second named `bar:beat`; the Music bus is audible.
- **Calibration:** headless, the 16 injected taps read +35 ms with a spread of about 3 ms; the run is steady and applied, and `Audio.calibration` equals the result. After the reload the stored offset reads back to 6 decimals.
- **Tap game:** headless, a tap on the stored offset is PERFECT, 20 ms before it PERFECT, 55 ms after it GOOD, 120 ms after it a MISS (3 hits, 1 miss). After X the same tap reads about +35 ms and is only GOOD.
- **Counters:** `groupsLate`, `groupsHeld`, `groupsAbandoned`, `maxSlipFrames` and `splitQuanta` are 0 after each item; no errors, no warnings.

**Limit:** headless Chromium has no sound output and no real key press time, so the walker injects taps with known offsets and reads the page's state; whether the click track feels in step, whether the offset is right for your output device, and whether the game feels fair at 0 ms are for the ear and the hand. On a Bluetooth device the offset is large (100 ms or more) and the spread wider.

Signed: ________ Date: ________
