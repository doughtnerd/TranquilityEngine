# M4 listening pass: interactive music, the full pass (ADR 0166, 0167)

The owner's listening pass for M4 in one sitting. It joins the four milestone sections (M4-0 in-voice records, M4a stems and playlists, M4b transitions, M4c beat feel and calibration) with the real-device items of the rhythm spike ([`spikes/audio-music/rhythm/README.md`](../../../spikes/audio-music/rhythm/README.md) section 8) and the phone prime lead, and ends in a sign-off block that M4d's exit needs filled. The earlier passes are [M1](../0157-audio-core/listening-pass.md), [M2](../0157-audio-core/m2-listening-pass.md) and [M3](../0162-audio-spatial/listening-pass.md).

**Nobody has auditioned this yet.** Every "listen for" line is what the engine is built to do, checked against the code and the samples' scripts on the day this was written, not a finding. Mark each item **heard OK** or **issue** (with a note) in the sign-off block, then sign.

## What you need

| Device | Used for | Notes |
|---|---|---|
| **Headphones, on a desktop** (**H**) | all 25 listening items (Z, A, B, C), real-device items R1 to R7 and R9 | Wired is best (a Bluetooth output adds 100 ms or more and is item R6's job). Chromium (Chrome or Edge) for the walker; Safari and Firefox are R7's. |
| **The lab VM** (**V**) | the same 25 items walked again, plus four benches (V1 to V4) | If the VM has no output device, run the headless walker (V0) and the benches only, and say so. |
| **A phone** (**P**) | the Flappy town music (A5), the Sound Lab's music page (A1 and A4 by hand, B1 to B10) and rhythm page (C1 to C5) through their on-screen buttons, the device probe (R1, R2, R3, R5, R6, R7, R8, R9) and the prime lead (P1) | The Z items and A2 and A3 stay on the desktop (the spec's own keys and the paused decoder). Two phones for R8. |

Total: **25 listening items** (5 + 5 + 10 + 5), **9 real-device items** (R1 to R9), **1 prime-lead item** (P1), **4 VM benches** (V1 to V4): 40 rows in the sign-off block (V0, the walker on the VM, included).

### Run it (desktop, and the VM)

From the repository root, once: `npm install`, then `npm run test:e2e:install`.

```bash
E2E_LISTEN=1 npm run test:e2e:slow -- audio-music-listening --headed --workers 1 -g "M4-0|M4a|M4b|M4c"
```

A browser window opens on the Sound Lab. A card over the page lists the keys; the terminal prints `[listen] ...` with the key to press and what to listen for. The spec waits for each key, you press it in the page and listen, then it checks the item ran (voice, rule, curve, counters) and moves on. It never times out while it waits for you. One section at a time: `-g M4-0`, `-g M4a`, `-g M4b`, `-g M4c`. Click the game view before the first key of M4b and M4c (the spec does it for M4-0 and M4a).

If a check fails in the terminal, the item did not run as built: note it as an issue with the message, and carry on with the next section.

**Headless smoke (V0, and anyone's CI-style check):** `npm run test:e2e:slow -- audio-music-listening --project chromium-slow --workers 1` presses every key itself and injects the taps. It proves the walker, not the sound.

### Run it (phone and the real-device probe)

The probe is a self-contained page, `spikes/audio-music/rhythm/device-probe.html`. Serve it from the machine you build on:

```bash
node spikes/audio-music/rhythm/device-probe-server.mjs        # plain on 8081, cross-origin isolated on 8082
```

- **Android:** USB debugging on, `adb reverse tcp:8081 tcp:8081 tcp:8082 tcp:8082`, then open `http://localhost:8081/` in Chrome (and later the system WebView or the Tauri or Capacitor shell, if you have one). `localhost` is a secure context, so the isolated page on 8082 works too.
- **iPhone, iPad or a Mac's Safari:** open `http://<the machine's LAN address>:8081/`. The isolated page (R4) needs HTTPS (a tunnel to port 8082), because cross-origin isolation needs a secure context.
- Every result is one JSON line in the box under the buttons. Copy them out (select the box) into the sign-off notes.

The Flappy game on a phone is an export, because the editor is not a phone page:

```bash
npm run build
npm run export -- samples/flappy --out /tmp/flappy-web --target web
cd /tmp/flappy-web && node serve.mjs 8080
```

Android: `adb reverse tcp:8080 tcp:8080`, open `http://localhost:8080/`. On iOS the page needs HTTPS too, or the audio core's AudioWorklet is not available and the engine falls back to the Babylon backend (no music).

The Sound Lab is an export too (the same kind of page as Flappy; tap once to unlock the audio):

```bash
npm run export -- samples/sound-lab --out /tmp/lab-web --target web
```

```bash
cd /tmp/lab-web && node serve.mjs 8083
```

Android: `adb reverse tcp:8083 tcp:8083`, open `http://localhost:8083/`. The tour page has four buttons along the bottom (Events, Spatial, Music, Rhythm); the music and rhythm pages have a button for each of their keys, Back included. On the rhythm page a press anywhere on the game view is a tap (SPACE's form), timed from the pointer event's time stamp. A phone has a big, slow audio path: calibrate (C2) on the phone before the tap game (C4).

## Part 1. M4-0: in-voice stamped records (task Z5)

**Scene:** the Sound Lab main page, loaded by the spec (no sample is edited). The Music, Ambience, SFX and Engine buses are muted; 64 quiet looping voices play on UI as a crowd (the noise, hum, music, orbit-pulse and bright loops at spread pitches: **a steady, quiet buzz and hiss under every item is expected**; it is the "many" that the item's one voice is among, and it must not dip, click or pump when an item fades or stops; 0 stops it too); the item's voices play on the Tape bus. Every record is stamped 1 s ahead of `Audio.time`. The spec takes keys 0 to 5 before the Sound Lab's own handlers see them (on this page 1 is a click and a beep, 4 the Underwater snapshot, 5 a burst), so only the item and the crowd are heard.

| Id | Key | Item | Listen for | Devices |
|---|---|---|---|---|
| Z1 | 1 | Stamped linear fade of one voice (the radio loop) to 0.1 over 1.5 s | About 1 s of nothing, then one smooth dip to about a sixth of the level; the crowd does not move; no click, no dropout. | H, V |
| Z2 | 2 | Stamped stop of the melody loop with a 0.4 s fade (press twice; the spec checks the bus falls silent) | Fades out over about 0.4 s and is gone, no click at the end; the crowd keeps playing. | H, V |
| Z3 | 3 | 2 s crossfade, pad into lead, linear in and out | The pad hands over to the lead with a slight dip in the middle; no jump at either end. | H, V |
| Z4 | 4 | The same crossfade with the S-curve | Slow at both ends, quick in the middle; no jump at either end. | H, V |
| Z5 | 5 | The same crossfade with equal power in and out | The level stays steady throughout (the one that should sound right); no jump at either end. | H, V |
| | 0 | Stops everything | | |

**The spec confirms (not by ear):** each named voice is in the voice table with the right clip; the logged fade has the right voice, law and `stopAtEnd`; the stopped voice leaves the table; the Tape bus falls silent; no Underwater snapshot filters the mix and the page's own click and beep did not play; `splitQuanta` does not move. **Limit:** `Audio.debug()` does not report which curve ran inside the core; the law check reads the page's own log of its `fadeShaped` calls. The core-side proof is the cargo goldens (`in_voice_goldens.rs`, `in_voice_isolation.rs`) and the metered bench's `splitQuanta == 0`.

## Part 2. M4a: segments, stems and playlists (task E1)

**Scene:** the Sound Lab main page again (the Music, Ambience, SFX and Engine buses muted; the item plays alone on the Tape bus). The spec builds the music events from the lab's 4 s stems (pad, pulse, lead and a streamed melody) at 120 bpm and starts them itself when you press the key; the keys are the spec's own. Item A5 opens the Flappy sample. The music page (M from the tour) also starts two of these itself: **4** plays the eight-stem event (`audio/music/music-stems8.audioevent.json`: A1's eight stems, on the Music bus, looping) and **5** the A, B, C playlist (`music-list3.audioevent.json`: A4's items, once through, about 12 s). That is how a phone runs A1 and A4. A2 (the held-back ring) and A3 (the paused decoder) have no page. The 10-minute playlist is a separate exit check: `npm run test:e2e:slow -- audio-music-a --repeat-each 3`.

| Id | Key | Item | Listen for | Devices |
|---|---|---|---|---|
| A1 | 1 | Eight stems start together on a cue, 10 s (pad, pulse, lead and melody, each twice; the two melodies stream) | One band entering on a single instant; no stem early or late; no phasing or flam between a stem and its double; a steady loop every 4 s. | H, V |
| A2 | 2 | The same with a slow ring: the melody file is held back 1.5 s | The music starts about 1.5 to 3 s after the key, and all eight stems begin together; none enters ahead of the others. | H, V |
| A3 | 3 | A held group: the eight stems play, the decoder worker is paused until the core holds the group, then resumed at once (Chromium) | The streamed stems run dry, the whole band dips together over about 5 ms and every stem, decoded and streamed, goes silent at the same instant, none left playing alone. After the worker resumes (well under a second) the band returns together and aligned: no stem ahead of or behind the others, no phasing or flam. The music then plays on as before. | H, V |
| A4 | 4 | A playlist of three 4 s items (A pad and pulse, B lead and pulse, C melody and pad), 30 s | Each change on the beat; no gap, no click, no doubled or missing beat. | H, V |
| A5 | 5 | The Flappy sample's town music, 20 s (the spec opens the sample). **On a phone:** the exported game | A steady 105 bpm piece that loops without a gap or click; no warbling. On the phone also: no dropout while you tap to flap or scroll. At game over the town music dips to about a third of its level (0.4 s) and comes back when the next run starts; it never restarts or gaps across the restart. | H, V, P |

**The spec confirms (not by ear):**
- **A1 and A2:** one group of 8 primed stems, all eight `playing` with a playhead, the six decoded stems on one playhead; the Tape bus audible; no group late, held or abandoned; no slip; no split. A2 also checks the file was requested and that play-to-playing exceeds the delay.
- **A3:** `groupsHeld >= 1`; the six decoded stems back on one playhead after the resume; not abandoned; no split. A hold longer than 1 s is given up on by design.
- **A4:** the items in order A, B, C; no late group.
- **A5:** the stem streams through a ring, at 105 bpm.

## Part 3. M4b: transitions, stingers and loop exits (task E2)

**Scene:** the Sound Lab's music page, opened by the spec with M from the tour (B comes back); the keys are the page's own (`MusicLab.ts`). Every key has a button along the bottom of the view (B is Back); **D** shows the music readout under the label. The world switch starts in explore at 120 bpm, so every change lands on a bar line (2 s). The music plays on the Music bus; Ambience, SFX, Engine and Tape are muted. The items run in this order, because each starts from where the last left the music:

| Id | Key | Item | Listen for | Devices |
|---|---|---|---|---|
| B1 | 2 | Explore to combat: a cut on the next bar line | The old music stops and combat starts at the same instant; no gap, no click, no overlap. | H, V |
| B2 | 1 | Combat to explore: a 2-beat (1 s) equal-power crossfade | The level stays steady through the hand-over, no dip, no jump. | H, V |
| B3 | 3 | Explore to calm: a 4-beat (2 s) linear crossfade | A slight dip in the middle of the hand-over; no jump at either end. | H, V |
| B4 | 1 | Calm to explore: a 4-beat (2 s) S-curve crossfade | Slow at both ends, quick in the middle; no jump at either end. | H, V |
| B5 | 3, then 2 | Explore to calm (the way to the bridge), then calm to combat through the bridge, a one-bar noise riser | On the bar line calm crossfades (1 beat) into the riser, which plays one bar; combat starts at full level on the riser's last sample; no gap, no click, no doubled beat. | H, V |
| B6 | 3 | Combat to calm: no rule of its own, so the default rule, a 1-beat (0.5 s) equal-power crossfade | A short, level hand-over on the bar line. | H, V |
| B7 | L, then L again | The loop: a 2-bar body (4 s) with a 1-bar tail (a crash and a chord). Press L again after two or more passes (at least 8 s) | A steady loop, the tail ringing over the start of each pass and never cut. After the second L the pass in progress finishes, the tail rings out whole, and the music ends without a click. | H, V |
| B8 | 1, then T | Back to the world in explore (the loop is over, so 1 starts the world switch again); a stinger on the next beat | The hit lands on the beat; the music carries on unchanged under it. | H, V |
| B9 | Y | A stinger on the next bar line | The hit lands on the bar line; the music carries on unchanged. | H, V |
| B10 | 3, then 2 within a second | A switch that changes its mind: calm is asked for, then combat before the bar line | The music goes to combat on the bar line and calm is never heard. If your second press comes after the bar line, the spec notes it rather than failing. | H, V |
| | O | Stops | The music stops cleanly. | |

**The spec confirms (not by ear):**
- **Each change:** the debug row's pending change names the rule that chose it (pair, index, tier, parent `world`; the default rule is `*>*`, tier 4), and the new segment lands on a bar line. The bridge goes through `riser`. The Music bus is audible after each change.
- **Headless only:** the crossfade overlaps measure 0 s (cut), 1.1 s, 2.0 s and 0.5 s.
- **Loop exit (B7):** the body's playhead runs past its 4 s loop end after the release, so the tail rang out.
- **Stingers (B8, B9):** each is counted as played.
- **Counters:** `groupsLate`, `groupsHeld`, `groupsAbandoned`, `maxSlipFrames` and `splitQuanta` are 0 after every change; no errors, no warnings.

## Part 4. M4c: beat feel, calibration and the tap game (task E3)

**Scene:** the Sound Lab's rhythm page, opened by the spec with R from the tour (B comes back). Click the game view first (the spec does). The keys are the page's own (`RhythmLab.ts`): **C** calibrate, **SPACE** tap, **G** tap game, **X** reset the calibration to 0, **O** stop. Every key has a button along the bottom of the view; a press on the game view is a tap, like SPACE, timed from the pointer event's own time stamp (a mouse click does the same). **D** shows the music readout under the label. The music plays on the Music bus; Ambience, SFX, Engine and Tape are muted. `Audio.rhythmMode` is off in this sample (the page says "rhythm mode off"); the line `Audio.latency` shows what the browser reports and whether it can be trusted. You tap with the SPACE bar or by pressing the game view, timed by the event's own time stamp.

| Id | Key | Item | Listen for / do | Devices |
|---|---|---|---|---|
| C1 | C | The click track: 120 bpm, a click on every beat, beat 1 (the first of four) higher | Listen for a few bars before tapping. Even, steady clicks; every fourth click is higher; the page's beat marker `(*)` flashes with each click, in step with what you hear, not before or after. | H, V |
| C2 | SPACE x 20 | Calibration: tap on every click, 20 taps (the first 4 are warm-up and dropped) | The page counts the taps (`n/20`) and shows how far the last one was from its click (`+` late, `-` early). At the end it shows the offset and the spread in ms and "Steady: applied to Audio.calibration and stored for this output device". A steady run has a spread within 40 ms (a few ms to 20 ms is typical). "Unsteady: NOT applied" is a bad run, not a bug: press C and tap more evenly. | H, V |
| C3 | (the spec reloads) | The offset persists: the spec reloads the page and opens the rhythm page again | The line `Audio.calibration` shows the same offset as before the reload (to the 0.1 ms the page prints). | H, V |
| C4 | G | The tap game: a drum and bass loop; tap SPACE on the beat, at least 8 taps | Each tap is graded PERFECT (within 30 ms of the beat after the calibration is taken off), GOOD (within 80 ms) or MISS, with early or late in ms; hits, misses and the streak count. With a good calibration, taps that feel on the beat read near 0 ms; the beat marker `(*)` is in step with the drums. | H, V |
| C5 | X | Reset: the calibration goes back to 0 | The line `Audio.calibration` reads `+0.0 ms`. Tap the game again: taps that read near 0 now read early or late by about the offset you calibrated, so the grades get worse (the zero changed). | H, V |
| | O | Stops | The music stops cleanly. | |

**The spec confirms (not by ear):**
- **Click track:** the debug row is the segment `click` at 120 bpm, playing; the page counts two beats a second named `bar:beat`; the Music bus is audible.
- **Calibration:** headless, the 16 injected taps read +35 ms with a spread of about 3 ms; the run is steady and applied, and `Audio.calibration` equals the result. After the reload the stored offset reads back to 6 decimals.
- **Tap game:** headless, a tap on the stored offset is PERFECT, 20 ms before it PERFECT, 55 ms after it GOOD, 120 ms after it a MISS (3 hits, 1 miss). After X the same tap reads about +35 ms and is only GOOD.
- **Counters:** all 0 after each item; no errors, no warnings.

**Limit:** headless Chromium has no sound output and no real key press time, so the walker injects taps with known offsets and reads the page's state; whether the click track feels in step, whether the offset is right for your output device, and whether the game feels fair at 0 ms are for the ear and the hand. On a Bluetooth device the offset is large (100 ms or more) and the spread wider.

## Part 5. The real-device items (rhythm spike, section 8)

These measure the platform, not the engine. The tool for all nine is the device probe page (served as above). Run each item on **every target you have** from the list in the spike: Windows Chrome and Tauri WebView2, macOS Safari and Tauri WKWebView, Linux WebKitGTK if the core loads, Firefox on one desktop, Android Chrome, Android WebView in the Tauri or Capacitor shell, a lowest-Android low-end phone. Record the device and browser with every result.

Buttons on the page: **1 Hints** (R1, R7, R8), **2 Click + flash** (R2), **5 Hit** (R5), **3 Input timing** (R3, R4), **9 Tap spread** (R9). The page logs a `devicechange` line whenever the output device changes (R6). `?seconds=10` is the hints run length (default 10 s), `?taps=32` the tap count (default 32).

| Id | Item | Do | Record | Devices |
|---|---|---|---|---|
| R1 | For hints interactive, 0.005, 0, balanced, playback: `sampleRate`, `baseLatency`, `outputLatency`, `currentTime - getOutputTimestamp().contextTime`, over 10 s | Button **1**; wait about a minute (five runs of 10 s) | The five `hint` lines: `sampleRate`, `baseLatencyMs`, `outputLatencyMs`, `outputKind` (`undefined`, `0`, `constant` or `varies`: note which), `lagMsMin/Mean/Max` (the stability over 10 s) | H, P |
| R2 | True click-to-ear latency per hint: a click at a known context time recorded on an external recorder or loopback cable (desktop) or a 240 fps phone video of screen flash plus audio (phone); compare with the reported (T, P) prediction | Button **2**, pressed twice (the first press builds the audio context; measure the second): the page schedules a click 1 s ahead, flashes the screen at the predicted heard time and logs `predictedPressToHeardMs` and the (T, P) pair. **Desktop:** record the button's own key or mouse click and the heard click together (loopback or a recorder next to the mouse); the gap minus 1000 ms is the true latency, compare with the prediction. **Phone:** film the screen and the speaker (or headphone) at 240 fps; count frames from the flash to the sound. The default hint only; repeat per hint by reloading with the hint set in the page's `hints` run if you want the table | The `click` line, the measured gap, the difference (measured minus predicted: the number that says if `getOutputTimestamp` is honest) | H, P |
| R3 | `event.timeStamp` against `performance.now()` in the handler: delivery lag and its p99, for mouse, keyboard, touch (Android WebView), gamepad polled per rAF; coalescing of touch events | Button **3**, then 20 or more key presses, clicks, touches (on a phone) and gamepad button presses, a few pointer or finger moves; then **Show results** | The `input` line: per kind `n`, `p50Ms`, `p99Ms`, `maxMs`; `coalesced` (events against coalesced events per move) | H, P |
| R4 | The same on a cross-origin-isolated page, to see the resolution gain | The same on the 8082 page (HTTPS for a phone, see above) | The `input` line: `crossOriginIsolated` must read true; `performanceNowResolutionMs` against the plain page's (100 µs expected, 5 µs isolated) | H |
| R5 | Hit-sound round trip: input event to click heard, asap path with postMessage (and the SAB ring if COOP/COEP is available in the shell) | Two clicks to compare. **The raw floor:** the probe's button **5** (a click played from the input handler). **The engine's path:** the Sound Lab main page key 1 (a click and a beep through `Audio.playOneShot`; open it with `npm run dev`, `/editor.html?sample=sound-lab`, press Play, click the view). Record the keystroke or touch and the heard click as in R2 (recorder, or 240 fps video) | The gap for each; the engine's less the raw floor is what the engine adds (expected under 10 ms on the postMessage path). The SAB ring half has no host to run in: none of the repo's servers sends COOP/COEP, so note "not run" | H, P |
| R6 | Bluetooth headphones on phone and desktop: calibration offset and the `devicechange` / `sinkId` behaviour | With wired output, run **C** on the rhythm page (C2) and note the offset. Switch the system output to Bluetooth while the probe page (button 1 or 2 pressed once, so its context exists) and the rhythm page are open. Run **C** again on Bluetooth | The probe's `devicechange` lines and `sinkId`; the rhythm page's `Audio.calibration` line reading **STALE: the output device changed, calibrate again (C)** after the switch (the engine's own response); the Bluetooth offset (expected 100 ms or more) and spread; whether the offset is stored per device and the wired one comes back on switching back | H, P |
| R7 | WebKit: does `outputLatency` return 0? Is `getOutputTimestamp` monotonic? | Button **1** in Safari (macOS and iOS) and the Tauri WKWebView | `outputKind` on every hint line (`0` is the answer to the first question); `monotonic` (must be true; the page records false if a pair ever went backwards) | H, P |
| R8 | Android: the `baseLatency` report on at least two phones (the 3200-frame anecdote) | Button **1** on each phone, Chrome and the WebView shell | `baseLatencyMs` for every hint on each phone; 3200 frames at 48 kHz is about 67 ms, the anecdote's "about 300 ms lag" is the `lagMs` figure | P |
| R9 | Real human tap spread for the calibration model (10 people, 32 taps) to replace the sd 15 to 25 ms assumption | Button **9**: a 120 bpm click track; each person taps on every click with a key, the mouse or a finger (4 warm-up taps, then 32). Ten people | Per person the `tapSpread` line: `medianMs`, `madMs`, `sdMs`, `minMs`, `maxMs`, and the raw taps. The sd across the ten is the number to put into the model | H, P |

**What stays off the page:** the probe's values on a headless Chromium belong to a fake sink and mean nothing (the walker only proves that every button runs to its row). R2, R5 and R9 need hardware or people the walker cannot supply, and R6 needs a Bluetooth output.

## Part 6. The phone prime lead (RS2)

**What it is:** the time the engine allows to prime a group of streamed stems (open, seek, first chunk) before its stamp, `1.25 x Ê + L + Δ̄` (ADR 0167 section 1.2), where Ê is its estimate of the worker's prime time. On a phone the fetch and decode are slower and the encoded cache smaller; the design sized the 8-stem group at about 35 MiB of encoded bytes (RS2, RS10). The number to settle is the lead the engine settles on and whether any group started late.

| Id | Item | Do | Record | Devices |
|---|---|---|---|---|
| P1 | The prime lead on a phone, with the Flappy town music running | Export Flappy (above), open it on the phone, tap to start. Press the round note button in the bottom-right corner (a keyboard's **M** does the same): the top-left of the view shows `music town`, `lead`, `prime` (the smoothed prime time, with the last one) and `late`, `held`, refreshed four times a second. After the town music has played 30 s read it (a photo of the screen will do). Remote DevTools still works: `JSON.stringify(__myco.Audio.debug().music.map(r => ({asset: r.asset, lead: r.leadMs, ema: r.primeEmaMs, last: r.primeLastMs, late: r.lateGroups, held: r.groupsHeld})))` | `lead`, `prime` (`primeEmaMs`, and the last), `late`, `held`, with the phone model and the browser. Expect the lead to settle near 100 ms at 60 Hz on a fast desktop (seed 40 ms); a phone's is the finding. `late` and `held` should stay 0; a "prime lead is longer than one beat" warning in the console is expected where the estimate is large | P |

The one streamed town stem is the lightest group the engine primes. The eight-stem group (music page, key 4, then **D**) is the heavier one: run it on the phone too and note its `lead`, `prime`, `late` and `held` beside P1's.

## Part 7. The lab VM

| Id | Item | Do | Record | Devices |
|---|---|---|---|---|
| V0 | The headless walker | `npm run test:e2e:slow -- audio-music-listening --project chromium-slow --workers 1`, then `npm run test:e2e -- audio-music-a audio-music-b audio-music-c --repeat-each 3 --project chromium` | Pass or fail of each, and the machine | V |
| V1 | The music scenes, typical | `node tools/audio-bench/run.mjs mode=scene name=music-typ pace=1 seconds=60 runs=5`, then the same with `name=music-typ-twin` and `name=music-typ-streamed` | p50, p99 and p99.9 of each; the music's own cost is the scene less its twin | V |
| V2 | The music scenes, transition | The same with `music-trans`, `music-trans-twin`, `music-trans-streamed` | as V1 | V |
| V3 | The music scenes, worst | The same with `music-worst`, `music-worst-twin`, `music-worst-streamed` (16 groups: 12 stems and 4 stingers, every voice fading) | as V1 | V |
| V4 | The stamped scenes | The same with `stamped-g` and `stamped-g-twin`, `stamped-music` and `stamped-music-twin` | as V1; the stamped scene should cost within about 60k instructions of its twin (a tripwire, logged and not traded if missed) | V |

Each run prints one JSON line. The container's own measurements are in the [build log](build-log.md) (Bench1: typical 36 to 37% of its allowance, worst 50 to 53%); the VM's run settles them against 0157's 1.3 ms budget and the worst allowances of about 0.08 ms (default preset) and 0.06 ms (low). These are tripwires, not limits.

## Limits and gaps

- **The walker never hears.** Headless Chromium has no sound output, so it reads the core's meters, voice tables, rows and counters. Every "listen for" line is yours.
- **Z, A2 and A3 are desktop-only.** Z's keys and A2's delayed ring and A3's paused decoder are the spec's own (the main page, the DevTools protocol). The music and rhythm pages, and A1, A4 and A5, run on a phone through their buttons and taps.
- **The prime lead has an on-screen readout** on Flappy (M, or the note button on a touch screen) and on the music and rhythm pages (D, or the button). The numbers come from `Audio.debug().music`; the readout refreshes four times a second and only while it is on.
- **A phone page for the 8-stem group exists** (music page, key 4); A2's held-back ring and A3's pause still have none.
- **Touch taps are timed from the pointer event's stamp, not the frame's,** like SPACE; whether a touch screen's `event.timeStamp` lags is R3's measurement.
- **A3 is Chromium only** (the decoder worker is paused through the DevTools protocol); WebKit and Firefox are run for the other items if you want them signed.
- **R5's SAB ring half and R4 on a device** need a host that sends COOP and COEP; none of the repo's servers (the dev server, the export's `serve.mjs`, the Tauri shell) does yet.

## Sign-off

Fill one row per item: **heard OK**, or **issue** with a note. Use the device codes (H headphones, V lab VM, P phone) and the date of the run. An item run on two devices gets two rows (add a line).

| Machine and OS | |
|---|---|
| Build (commit) | |
| Browser and version | |
| Output device and sample rate | |
| Headphones (model) | |
| Lab VM | |
| Phone(s) (model, OS, browser) | |

### Listening items

| Id | Item | Heard OK / issue and note | Device | Date |
|---|---|---|---|---|
| Z1 | Stamped fade of one voice (1) | | | |
| Z2 | Stamped stop (2) | | | |
| Z3 | Crossfade, linear (3) | | | |
| Z4 | Crossfade, S-curve (4) | | | |
| Z5 | Crossfade, equal power (5) | | | |
| A1 | Eight stems start together (1) | | | |
| A2 | Slow ring (2) | | | |
| A3 | Held group (3) | | | |
| A4 | Playlist A, B, C (4) | | | |
| A5 | Flappy town music (5; phone too) | | | |
| B1 | Explore to combat, cut (2) | | | |
| B2 | Combat to explore, equal-power crossfade (1) | | | |
| B3 | Explore to calm, linear crossfade (3) | | | |
| B4 | Calm to explore, S-curve crossfade (1) | | | |
| B5 | Calm to combat through the bridge (3, 2) | | | |
| B6 | Combat to calm, the default rule (3) | | | |
| B7 | Loop with a tail, and leaving it (L, L) | | | |
| B8 | Stinger on the beat (1, T) | | | |
| B9 | Stinger on the bar (Y) | | | |
| B10 | A switch that changes its mind (3, 2) | | | |
| C1 | Click track (C) | | | |
| C2 | Calibration, 20 taps (SPACE) | | | |
| C3 | The offset persists after a reload | | | |
| C4 | The tap game (G) | | | |
| C5 | Reset to zero (X) | | | |

### Real-device items (spike section 8) and the prime lead

| Id | Item | Result and note (numbers) | Device(s) and browser | Date |
|---|---|---|---|---|
| R1 | Hints: sampleRate, baseLatency, outputLatency, timestamp lag | | | |
| R2 | True click-to-ear latency against the prediction | | | |
| R3 | `event.timeStamp` lag and p99 (mouse, key, touch, gamepad) | | | |
| R4 | The same on a cross-origin-isolated page | | | |
| R5 | Hit-sound round trip (raw floor and the engine; SAB ring not run) | | | |
| R6 | Bluetooth: offset, `devicechange`, `sinkId`, the STALE line | | | |
| R7 | WebKit: `outputLatency` 0? `getOutputTimestamp` monotonic? | | | |
| R8 | Android `baseLatency` on two or more phones | | | |
| R9 | Human tap spread, 10 people, 32 taps | | | |
| P1 | The phone prime lead | | | |

### Lab VM

| Id | Item | p50 / p99 / p99.9 and note | Date |
|---|---|---|---|
| V0 | The headless walker and the repeat runs | | |
| V1 | Music scenes, typical (scene, twin, streamed) | | |
| V2 | Music scenes, transition | | |
| V3 | Music scenes, worst | | |
| V4 | Stamped scenes | | |

### Overall

- Result: [ ] signed off, nothing open [ ] signed off with the issues above logged [ ] not signed off
- Issues to carry (item ids and one line each):
- Signed: ________ Date: ________
