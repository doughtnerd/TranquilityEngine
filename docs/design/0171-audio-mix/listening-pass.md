# M5 listening pass: the audio mix, the full pass (ADR 0171 amended by 0172 and 0173)

The owner's listening pass for M5 in one document. It joins the three milestone sections (M5-0 the stamped bus path, M5b loudness, M5c live mixing and level ducking) with the capture-from-an-exported-game step and the device items, and ends in an overall sign-off. Do it in one sitting or split it by part: each part starts from a fresh page and leaves it as it found it.

The sections it inlines stay as they are, and each keeps the longer "what the walker confirms" detail: [M5-0](listening-notes/m5-0.md), [M5b](listening-notes/m5b.md), [M5c](listening-notes/m5c.md). Earlier passes for the shape: [M4's](../0166-audio-music/listening-pass.md).

**Nobody has auditioned any of this yet.** Every "correct" line is what the engine is built to do and what the headless walker's readings agree with, not a finding. Mark each step **heard OK** or **issue** (with a note) in its sign-off block, then sign the overall block at the end.

Two things are not final when this was written:

- **M5c's section (`m5c.md`) was written on branch `m5/e3` and was not merged yet.** Part 3 follows that file; if E3 changed it before merging, the merged file wins and the coordinator reconciles this part.
- **The capture round trip from an exported game (Part 4) has no automated check yet:** automated check pending (X3). The trigger itself (F9, three fingers) has its own unit tests and an export spec that has not been run in a browser (`tests/e2e/export-capture.spec.ts`, marked an unverified draft). Treat Part 4 as the first time anyone has done it end to end.

## What you need

| Device | Used for | Notes |
|---|---|---|
| **Headphones on a desktop** (**H**) | Parts 1 to 4 | Wired is best (a Bluetooth output adds 100 ms or more and blurs "on the frame"). Chromium (Chrome or Edge) for the walker. **Set the volume low before Part 2**: step M5b S3 plays a tone about 22 dB louder than the reference. |
| **The lab VM** (**V**) | the same parts walked again (Part 5, DEV1) | If the VM has no output device, run the headless walker and say so; the ear steps stay unsigned there. |
| **An Android phone or emulator, with `adb`** (**P**) | the export on a device (DEV2), the capture trigger on touch (CAP3), the device items DEV3 to DEV5 | The supported floor is Android 14 (API 34) with Chrome 113 ([ADR 0169](../../decisions/0169-the-supported-mobile-floor-is-android-14-with-chrome-113.md)). An emulator can sign the trigger, the 16-file rotation and the `adb pull`; only a real phone can sign DEV3 to DEV5. |

From the repository root, once: `npm install`, then `npm run test:e2e:install` (the walker uses Playwright's Chromium).

## How to run it

```bash
npm run dev
```

Open `http://localhost:3000/editor.html?sample=sound-lab`, press **Play**, and click the game view once (sound starts after a gesture, and the click gives the game the keys). Keys go to the game view, so keep it focused. The **Sound Lab** is read-only when opened as a sample; Part 3 needs a writable copy (see there).

**The walker's listen mode** prompts you step by step and checks each step afterwards. It waits for your key, reads the page, and says in the terminal which step ran as built. It never times out while it waits for you. One section per run, one command each:

```bash
E2E_LISTEN=1 npm run test:e2e:slow -- audio-mix-listening --headed --workers 1 -g "M5-0 \(owner"
E2E_LISTEN=1 npm run test:e2e:slow -- audio-mix-listening --headed --workers 1 -g "M5b \(owner"
E2E_LISTEN=1 npm run test:e2e:slow -- audio-mix-listening --headed --workers 1 -g "M5c \(owner"
```

A card over the page lists the keys and the terminal prints `[listen] ...` lines with what to do and listen for. The `M5-0 (listen mode)`, `M5b (listen mode)` and `M5c (listen mode)` cases are the same keys at human pace (a late key, a key twice, a key held): they run headless and are the checks behind each section's last step.

**Headless, without you** (proves the page does what the steps say, not how it sounds; use it on the lab VM and before a session):

```bash
npm run test:e2e:slow -- audio-mix-listening --project chromium-slow --workers 1
```

If a check fails in the terminal, the step did not run as built: note it as an issue with the message, and carry on with the next step.

**Reading the numbers while you listen.** **Window > Audio Debug** shows the bus rows (effective gain and a peak meter per bus). The Sound Lab's own readouts are on keys: **D** (loudness readout on the main page; the duck lanes on the Mixer page). Words you will see in the guide chapters: [Audio mixing](../../guide/audio-mixing.md), [Loudness](../../guide/audio-loudness.md), [Audio profiler](../../guide/audio-profiler.md).

## Part 1. M5-0: the stamped bus path

Bus changes that land on a **stamp** (a frame the core was told ahead of time) instead of "as soon as the next block comes", a presence duck that starts on **the sound's own frame**, and a reverb send that **goes quiet with its bus's fader** (post-fader).

**Scene:** the Sound Lab main page. Broadband, percussive material, because a sine hides a post-fader mute, a duck or a dip.

| Key | Does | Bus |
|---|---|---|
| **P** | pauses or resumes the Music tone (the page's own background loop) | Music |
| **B** | starts or stops the drum loop (120 bpm, kick on 1 and 3, snare on 2 and 4, hats on every eighth) | Music |
| **A** | starts or stops a looping noise (sends to the reverb) | Ambience |
| **3** | fades Music to a quarter over 0.5 s; pressed again, back up | Music |
| **4** | the Underwater snapshot on or off (Music 0.6 and low-pass 500 Hz, Ambience 0.5 and 900 Hz, SFX low-pass 1500 Hz) | all |
| **5** | a 0.3 s noise burst now | SFX |
| **X** | the same burst, scheduled **1 s after the key** | SFX |
| **2**, **N** | mute or unmute Music, Ambience | Music, Ambience |
| **Z** | fades Ambience to a quarter and back (not used by a step; there to try) | Ambience |

The page also plays the project's **hum** on Ambience from the start (the quiet constant under every step). The project's rules: Music's authored volume is 0.6; Music is ducked by SFX, presence mode, **amount 0.3, attack 0.05 s, release 0.4 s**; Ambience has a reverb send of 0.5.

### M5-0 S0. Setup (do it once). Keys **P**, **B**

Press **P** (the tone pauses) and **B** (the drums start). **Correct:** a clean drum bar looping at 120 bpm with the hum faintly behind it. If the drums are not there, wait a second (the clip decodes on its first play) and press B again only if Audio Debug shows no `drum-loop` voice on Music.

*Walker:* the `drum-loop` voice is playing on Music and Music's meter is above 0.02.

Each step below starts from this state (drums on, everything else at rest).

### M5-0 S1. A scripted fade lands on its stamp. Keys **3**, **3**

- **Press 3.** Correct: the drums get quieter in one smooth slope over half a second, starting a fraction of a second after the key (the engine stamps it a little ahead so it can start on an exact frame), ending at a quarter of the level (0.6 x 0.25 = 0.15). A plain level change: no click at the start, no staircase or graininess on the way (zipper), no jump at the end. The hum does not move.
- **Press 3 again.** Correct: the same slope up to the full 0.6; the drums are back at the level they had.
- **A defect sounds like:** a click at the start; a staircase or buzz; the whole change as one jump; the fade starting so late the key feels broken (over about a third of a second); the drums not returning to the original level.
- *Walker:* a stamped ramp on Music, ahead of the core's frame and within half a second of the key; one `BUS_RAMP` (gain 0.25, 0.5 s), nothing re-sent while it runs; gain lands on 0.15; never rises on the way down; no quantum split; the second press returns to 0.6.

### M5-0 S2. A snapshot lands on one stamp. Keys **4**, **4**

- **Press 4.** Correct (Underwater): over half a second the drums go **muffled** (hats and the snare's hiss first, then the whole kit as if behind a door) and **quieter** (0.6 x 0.6 = 0.36); the hum goes quieter and duller at the same moment. Everything changes together: the hum must not muffle before or after the drums.
- **Press 4 again.** Correct: it opens up again over half a second to exactly how it was.
- **A defect sounds like:** quieter but not duller (or the reverse); hum and drums changing at different instants; a click at the start or end; coming back darker or quieter than before (a lane that did not release).
- *Walker:* snapshot ramps for Music, Ambience and SFX with **one stamp**; after stamp + 0.5 s Music reads 0.36, Ambience 0.4, SFX 1; the clear press sends Music back to gain 1 and low-pass off (24000 Hz). **Limit:** `Audio.debug()` has no filter value for a bus, so the low-pass is checked in the record main sent, not in the sound: the muffling is for your ear.

### M5-0 S3. A presence duck. Key **5**

- **Press 5.** Correct: a short noise burst (0.3 s). The drums **dip hard as it starts** (to 0.3 of their level, about 0.18 in all) within a few hundredths of a second, stay down while the burst sounds, then **swell back over about half a second**, taking a second or so to be fully back. Smooth: no click, no pumping.
- **A defect sounds like:** no dip; the drums stepping down instead of sliding; staying down after the burst, or coming back with a jump; a double dip (a second duck after the burst ended).
- *Walker:* Music's duck lane falls below 0.35 and not below 0.28; effective gain below 0.2; no ducked reading before the key; a `BUS_PRESENCE` with SFX's bit went out and, when the burst ended, one without it; the lane returns to exactly 1.

### M5-0 S4. A presence duck on the sound's own frame. Key **X**

The step that tells a stamped duck from an early or a late one.

- **Press X.** Correct: nothing happens for about a second. Then the burst sounds and **the drums dip at the same instant**: the dip belongs to the burst's very first sample. Then it releases exactly as in S3.
- **A defect sounds like:** the drums dipping **before** the burst (a dip with nothing to explain it, up to a second early); the burst's first instant over **full-level** drums and the dip arriving after it (late); a click at the dip.
- *Walker:* the duck record is stamped 0.8 to 1.5 s ahead of the core's frame at the key and the burst's `PLAY` carries **the same frame**; the duck reads exactly 1 and the SFX meter below 0.01 up to the quantum holding that frame; the first ducked reading and first SFX reading come after it.

### M5-0 S5. A muted bus's reverb send goes silent after its tail (post-fader). Keys **A**, **2**, **N**, **N**

- **Press A.** Correct: a steady broadband noise with a room around it, plus the hum.
- **Press 2** (mute Music) so only Ambience is left. Correct: the drums go quiet in one short ramp.
- **Press N** (mute Ambience). Correct: the **noise and the hum stop at once** (a few milliseconds), and **the room rings out over about two and a half seconds**, getting quieter smoothly, then **silence**. The tail is what was already in the reverb; nothing new feeds it, because the send follows the bus's fader.
- **Press N again.** Correct: noise, hum and room come back, no click.
- **A defect sounds like:** after N, a quiet **hiss or wash that never stops** while the bus stays muted (the send taking the signal before the fader: the old pre-fader behaviour); the tail **chopped off** with a click or thump; a pop on unmute.
- Then press **2** (Music back), **A** (noise off), **B** (drums off) and **P** (the tone back).
- *Walker:* master meter above 0.02 for Ambience alone; after N Ambience's gain reads 0 and its voices `busMuted`; the master meter is still above 0.005 within 0.6 s (the tail rings, not cut) and **below 0.002 from 4 s on**, measured over audio-clock time; after the second N Ambience reads 0.8.

### M5-0 S6. The owner's way with the keys: late, twice, held

Do each once by ear (the headless `M5-0 (listen mode)` case runs the same).

- **A late key.** Leave the page alone (drums on) about 12 seconds, then press **3**. Correct: exactly S1, no lurch at the start. A defect: the first fade after a long idle jumps, or starts noticeably later.
- **A key twice.** Press **3**, and **3** again about a quarter of a second later, mid-fade. Correct: the level turns around **from wherever it had got to** and rises to full, no click, no jump to either end; the page ends at 0.6. A defect: a jump to the low level or to full at the second press.
- **A key held.** Hold **3** for a second (the keyboard repeats). Correct: **one** fade, down, once; releasing does nothing. A defect: the fade flipping up and down while you hold. Press 3 once more to bring it back.
- **Mute at human pace, twice.** S5's N, wait for the silence, N to unmute; again after a pause. Correct both times as in S5.
- *Walker:* the late key's stamp is ahead of the frame the key saw and within 0.75 s; the double press sends two ramps in order (gain 0.25 then 1), the second stamped no earlier than the first, gain ends at 0.6; the held key sends exactly one ramp; the mute is silent after its tail both rounds.

### Part 1 sign-off

| Step | Key(s) | Heard OK / issue | Note |
|---|---|---|---|
| M5-0 S0 | P, B | | |
| M5-0 S1 | 3, 3 | | |
| M5-0 S2 | 4, 4 | | |
| M5-0 S3 | 5 | | |
| M5-0 S4 | X | | |
| M5-0 S5 | A, 2, N, N | | |
| M5-0 S6 | 3 late, 3 twice, 3 held, N at human pace | | |

## Part 2. M5b: loudness against a reference

The **loudness meters** (momentary M, short-term S, integrated I, range LRA, true peak) read against a **reference file at -23 LUFS**, the **target verdict** (ok, low, high, peak over) that warns and never adjusts, reset and pause, a hot bus's true peak, and the ladder flag. A meter is a number; your ear says whether the number belongs to the sound. Three things the walker cannot do: hear that the reference is a clean, steady tone (nothing for a meter to be wrong about), hear that the hot signal is as loud as the meter says (about 23 LU above the reference), and hear that the page goes back to how it was.

**Volume first.** Set the reference (S1) to a comfortable level, then leave the volume alone. If you know your chain's gain, set it so -23 LUFS is the level you work at (mastering rooms use 79 to 83 dB SPL per channel); the readings do not depend on your volume.

**Scene:** the Sound Lab main page. **D** shows the readout (top left): for Master and UI, M, S and I in LUFS, LRA in LU, the true peak in dBTP, the seconds metered, flags in brackets, and the target's verdict on a second line.

| Key | Does | Bus |
|---|---|---|
| **L** | the **reference**: pauses every other sound, plays `loudness-reference.wav` (a 1 kHz sine at **-23 dBFS** peak, both channels, looped with no seam: EBU Tech 3341 case 1), resets Master's and UI's meters; again, stops it and gives the other sounds back | UI |
| **W** | the **hot signal**, once, 2 s: the same sine at **-0.5 dBFS** | UI |
| **C** | resets Master's and UI's meters (`reset("all")`) | |
| **F** | pauses or resumes Master's and UI's meters | |
| **V** | the next target: console (-24 LUFS +/- 2 LU), then mobile (-18 LUFS +/- 2 LU), then round | |
| **D** | shows or hides the readout | |

The hum goes through Ambience's reverb, which rings for about two and a half seconds after the hum stops: **wait for M to settle on -23 before pressing C**. Master (always metered, after the reverb and limiter) and UI (`meter: "loudness"`) are the two meters; both targets have a true-peak ceiling of -1 dBTP; console is in force at start. The reference reads **-22.99** (the engine's measurement of the EBU signal; the standard allows +/- 0.1 LU).

### M5b S0. Setup. Key **D**

Press **D**. **Correct:** the readout top left with the page's music and hum under it: Master's M somewhere below 0 LUFS and moving a little (the hum orbits), UI's numbers `-` (nothing on UI yet), a verdict line under each (`console (-24 LUFS +/- 2, -1 dBTP): waiting` for UI).

*Walker:* the readout key was seen and Master's momentary reads a finite number below 0.

### M5b S1. The reference reads -22.99. Keys **L**, then **C**

- **Press L.** Correct: the music and the hum stop at once (the hum's room rings out quietly over a couple of seconds) and a **steady 1 kHz tone** starts: a plain, pure beep that does not move, pulse, crackle or change pitch, and does not click when it starts. M climbs through the room's tail and settles on **-23.0**. Then **press C**: the clock restarts at 0 s and runs on.
- **After about six seconds of the clock,** for Master and UI alike: **M, S and I all read -23.0 or -22.99** (within 0.1), **LRA 0.00**, **peak -23.0 dBTP**, no flags, verdict **`console ... ok, +1.01 LU`**.
- **A defect sounds like:** a tone that wobbles in level or pitch; a click, tick or burst of noise on L; the music or hum still audible under the tone after the first second or so (L did not pause them); the tone in one ear only (the reading would be 3 dB low). **Reads like:** M, S, I settled on different numbers; I not within 0.1 of -23; a flag (`incomplete`, `tainted`) without reason; UI and Master a tenth or more apart; the clock not running.
- *Walker:* the reference plays on UI and nothing on Music or Ambience; M settled within 0.05 of -22.99; after C both read 0 s, and after **6 s of rendered audio** M, S, I within 0.1, LRA 0 to 0.1, true peak -23.4 to -22.8, neither meter incomplete, tainted or paused, console says ok with +1.01.

### M5b S2. The verdict warns, never adjusts. Keys **V**, **V**

- **Press V.** Correct: the second line becomes `mobile (-18 LUFS +/- 2, -1 dBTP): low, -4.99 LU`. **The sound does not change at all**: no level change, no click. M, S, I keep their values (a new target is not a reset) and the clock keeps running.
- **Press V again.** Correct: back to `console ... ok, +1.01 LU`; the sound has not moved.
- **A defect sounds like:** the tone getting louder or quieter when the target changes (something is adjusting). **Reads like:** the verdict not changing, or the numbers restarting.
- *Walker:* `Audio.loudnessTarget` reads `mobile` then `console`; verdict `low` at -4.99 then `ok`; I within 0.1 of -22.99 and the clock not reset.

### M5b S3. A hot signal's true peak. Keys **L**, **C**, **W**, **C**

**Check the volume first:** this tone is 22 dB louder than the reference.

- **Press L** (the reference stops; music and hum come back), **press C**, then **press W.** Correct: a **loud steady tone** for two seconds, then silence on UI (music and hum go on under it). UI's line, once its clock reads 3 s or more: **I about -1 LUFS** (a little under the tone's own -0.5: the blocks at the start and end are partly tone), **peak about -0.5 dBTP**, verdict **`console ... high, about +23 LU, PEAK OVER`**. `PEAK OVER` stays on after the tone ends.
- **Press C.** Correct: the flag clears, the verdict goes back to `waiting`, the clock restarts.
- **A defect sounds like:** the tone **clipping or crackling** (a -0.5 dBFS sine is clean; a harsh edge would be the limiter working); the tone much quieter than the number suggests (compared with the reference it should be a very large step, about 22 dB). **Reads like:** `PEAK OVER` missing with a peak above -1; `PEAK OVER` on a meter that carried nothing hot; the flag not clearing on C.
- *Walker:* the hot voice plays on UI; after 3 s UI's verdict is `high` with a deviation 22.6 to 23.6, `peakOver` true, true peak -0.8 to -0.2; after C the peak flag is false.

### M5b S4. Pause, resume and reset. Keys **L**, **C**, **F**, **F**, **C**

- **Press L, wait for M to settle on -23, press C**, let the clock run a couple of seconds. **Press F.** Correct: the readout **freezes**, every number **including the clock**, while the tone plays on unchanged. A `[paused by script]` flag shows on both lines.
- **Wait a few seconds, then press F again.** Correct: the readout moves again, I is **the value it held** (-23.0), the clock continues from where it stopped; M reads `-` for the first 0.4 s and S for 3 s, then both read -23.0. **No `incomplete` flag:** a pause you asked for is not a gap in the programme.
- **Press C.** Correct: clock to 0, I, LRA and the peak go to `-`, then fill again.
- **Reads like a defect:** numbers moving while paused, or a clock that keeps counting; I jumping on resume; an `incomplete` flag after your own pause. (A tone that changes on F is a defect of the page: F touches only the meters.)
- *Walker:* both meters `paused` with `pausedBy script` and `Audio.debug().mix.metersPaused` 2; across **2 s of the audio clock** the clock and I do not move; after F they count again, I within 0.1 of -22.99, not incomplete; after C the clock is under 1 s.

### M5b S5. The ladder flag. No key (the walker's step; yours is on a loaded device, see DEV5)

When the audio thread runs late for long enough, the **shedding ladder** takes its first step: it pauses every loudness meter except Master's, reports it, and gives it back last. A key cannot provoke that on a healthy machine, so the walker sets the same flag the core's STATUS carries and reads what the page does. On a **loaded device** you would see:

- **While in force:** UI's line shows **`[paused by ladder]`**, its clock stops, **Master does not pause**; Audio Debug shows `Loudness ladder step 1` (flagged bad) and `Meters paused 1`. The sound is unaffected.
- **When given back:** UI meters again and its line shows **`[incomplete]`** (the shed time is a gap in its measurement) until you press C. Master is never marked.
- **A defect reads like:** Master pausing with the others; UI pausing with no `ladder` in its flag; the step in force but the debug row at 0; UI back with no `incomplete`.
- *Walker (the seam, not a real step):* the `loudShed` flag sets UI paused by `ladder`, Master not, `mix` reads `loudnessLadderStep 1` and `metersPaused 1`; over 1.5 s UI's clock holds and Master's runs on; on release UI is `incomplete`, Master is not; C clears it.

### M5b S6. The owner's way with the keys: late, twice, held

- **A late key.** Leave the page alone about 12 s (music and hum play), then press **L**. Correct: exactly S1. A defect: the reference starts late, clicks, or leaves the music audible.
- **A key twice.** Press **C**, and **C** again a quarter of a second later. Correct: the clock restarts from the second press, no jump in M, S or I once they refill.
- **A key held.** Hold **F** for a second. Correct: **one** pause, not a flutter; the readout stays frozen until you press F once more. Hold **L** (reference off): **one** reference starts, one tone, not two stacked (a doubled tone would read +3 LU).
- **V at human pace.** Press it twice with a pause: console, mobile, console, the verdict following each time.
- *Walker:* the late key leaves one reference voice and Master settles on -22.99; after two quick C presses the clock is under 1 s and I settles on -22.99; a held F is one pause; a held L leaves exactly one reference voice; the target ends on console.

### Part 2 limits

The walker cannot judge that the number belongs to the sound: a meter that agrees with the engine's own tone generator proves the filter and gating, which the goldens already do (the synthesised EBU Tech 3341/3342 set). Your ear and, if you have one, a second meter on the same file say it is the loudness you hear. Monitor mute and solo, Compare and every reset option's taint rules are `tests/e2e/audio-mix-b.spec.ts`'s.

### Part 2 sign-off

| Step | Key(s) | Heard OK / issue | Note |
|---|---|---|---|
| M5b S0 | D | | |
| M5b S1 | L, C | | |
| M5b S2 | V, V | | |
| M5b S3 | L, C, W, C | | |
| M5b S4 | L, C, F, F, C | | |
| M5b S5 | (walker only; a loaded device: DEV5) | | |
| M5b S6 | L late, C twice, F held, L held, V at human pace | | |

Volume the reference was set at, and output device:

## Part 3. M5c: live mixing and level ducking

**The Mixer panel's faders** (the zipper test), **structural edits and their dip** (a bus moved, inserted mid-tree, removed), **level ducking against presence ducking on the same target**, and **Compare**. The tests read gains, duck lanes and counters; they cannot say that a fader moves without zipper noise, that a bus moved mid-sound dips cleanly instead of clicking, or that a level duck sounds like a mixer's and not a switch.

**A writable copy first.** The Sound Lab sample opens read-only (a live edit in it is shown but neither reaches the mixer nor is saved). In the editor's start screen choose the Sound Lab and **copy it to an empty folder**; the copy opens. Do Part 3 in the copy and throw it away afterwards. (The walker does the same with an in-memory copy.)

**Run it.** `npm run dev`, open `http://localhost:3000/editor.html` (no `?sample=`), open the copy, press **Play**, click the game view once. On the tour page press **-** (minus) for the Mixer page (**B** goes back). Then open **Window > Audio Mixer**: the Audio Mixer and the Project panel are tabs of the same dock, so use the tab (or the Window menu) to go between the strips and **Project > Audio**.

| Control | Does |
|---|---|
| **1** (game view) | the **voice** on or off: `audio/mixer/voice-loop.wav` on the Voice bus, a speech-like loop with phrases and gaps |
| **2** | a **burst** on SFX, once |
| **3** | the **tour**: the page cycles the triggers (voice alone, burst alone, both, quiet), for hands-free listening |
| **4**, **5** | the Music bed, the Ambience bed on or off |
| **D** | the readout: each ducked bus's duck lane (`Bus.duckGain`, 1 = not ducked) |
| Mixer fader | the bus's volume: **arrows** move it 0.02 of its travel, **PageUp/PageDown** 0.1, **Home/End** the ends, **Shift or Alt** a tenth of that, **double-click** unity, a drag follows the pointer (**Shift** a tenth). Every key press and every released drag is **one** edit and **one** undo step; the travel is a dB scale, unity at three quarters |
| Mixer **M**, **MM**, **S** | mute (saved), monitor mute, monitor solo (neither monitor control is saved) |
| Mixer **Compare** | plays the **saved mix from Play start**, faders locked, until switched off; saves nothing |
| **Project > Audio** | the buses' parents (the select beside each name), **+ child**, **x** |
| **Undo** (Project panel's toolbar) or **Ctrl+Z** with a fader focused | one step back, in one shared history |

The project's rules: **SFX ducks Music** (presence: Music to 0.3 while a sound plays on SFX, attack 0.05 s, release 0.4 s); **Voice ducks Music** (level: RMS detector, threshold -30 dBFS, Music to 0.35, attack 0.05 s, release 0.5 s); **Voice ducks Ambience** (level: peak detector, threshold -20 dBFS, Ambience to 0.5, attack 0.1 s, release 0.8 s). A level rule follows how loud the trigger is, not whether it plays: the voice's gaps release it.

### M5c S0. Setup (do it once)

Play the copy, press **-**, open the Audio Mixer. **Correct:** one strip per bus (Master, Music, SFX, Ambience, UI, Filters, Tape, Load, Foley, Engine, Voice) with the music and the bed audible; the **Music** and **Ambience** strips show a **gain reduction meter** (they are targets of a level rule, so it shows even at rest); loudness readouts on Master and UI. Press **D** in the game view for the duck readout.

*Walker:* the Mixer page's behaviour is up, the Voice bus exists, the buses are live.

### M5c S1. Level against presence, on the same target. Keys **1**, **1**, **2**, **1** then **2**, **1**

- **Press 1.** Correct: the voice plays and **Music dips inside each phrase and comes back in the gaps**; the bed (Ambience) dips too, less (to 0.5, slower to come back). The Music strip's gain reduction meter follows: about **-9.1 dB** at the bottom of a dip (0.35), Ambience's about -6 dB. A **smooth duck**, not a click or step; the release a little slower than the attack.
- **Press 1 again.** Correct: the voice stops and both ducks release to 0 dB within about a second and a half.
- **Press 2.** Correct: a short burst on SFX; **Music dips to 0.3 (-10.5 dB) for as long as the burst plays** and releases. The presence rule does not care how loud the burst is, only that it plays.
- **Press 1, wait a moment, press 2 inside the voice.** Correct: Music takes **the lower of its two ducks** (about 0.3 while the burst plays, 0.35 otherwise), no jump when the second rule joins.
- **A defect sounds like:** the dip as a click or an audible step (a 50 ms attack; a step is a bug); Music pumping on every syllable (the RMS detector is 10 ms; the 0.5 s release should smooth the gaps); the bed not dipping, or dipping as deep as Music (peak -20 and 0.5 differ from RMS -30 and 0.35); a duck that stays after the sound ends. **Reads like:** the duck lane stuck below 1 with nothing playing; the lowest reading under 0.3.
- *Walker:* the voice plays on Voice; over 7 s of audio clock Music's lane reaches 0.30 to 0.42 and Ambience's 0.45 to 0.56; stopping releases Music to 1 (within 0.005); a burst takes Music to 0.26 to 0.36; both together under 0.36.

### M5c S2. The fader: keys and the zipper test. Down arrow x5, then Undo x5

- **Click Music's fader (or Tab to it) and press the Down arrow slowly, five times.** Correct: Music steps down in small, even steps, **each press one smooth change** (a 10 ms ramp), no crackle or zipper noise; the strip's readout, authored value and effective gain follow each press. Then **hold** the Down arrow for a second: the level glides down; **it must not buzz, crackle or stair-step audibly** (every auto-repeat is its own committed, ramped edit).
- **Drag the fader** up and down, quickly and slowly. Correct: the level follows the pointer with no zipper; letting go keeps the value. **Escape during a drag** puts the start value back. **Shift-drag** moves a tenth as far. **Double-click** puts the fader on 0 dB.
- **Press Ctrl+Z with the fader focused** (or Undo in the Project panel), five times. Correct: Music climbs back through the same five values, **one press one step**, smoothly; **Ctrl+Shift+Z** goes forward again.
- **A defect sounds like:** a zipper; a click at the start or end of a drag; a step bigger than the key's size; a value that jumps on release. **Reads like:** effective gain not following the authored value; an undo that takes more than one press per key; a drag that saves before release.
- *Walker:* after five Down presses Music's saved volume is under its start and the effective gain equals it (within 0.001); five undos restore the start exactly; no record late, early or refused.

### M5c S3. Structural edits and the dip. In **Project > Audio**: Engine's parent, **+ child**, **x**

- **Set Engine's parent to Music** (the select beside Engine's name; open its row if folded). Correct: **a very short dip** (20 ms down, 20 ms up) and Engine sits under Music: its effective gain is now its volume times Music's. No click. **Press Undo:** another dip, Engine back under Master.
- **Press + child on Music**, then **set Engine's parent to the new bus**: a bus inserted between Music and Engine. Correct: the new bus appears at once (a direct edit, no dip), the move is one dip, Engine's level as before the insert.
- **Press x on a bus with sounds on it** (the walker uses **Load**): the bus leaves the mixer and the strips at once, its sounds **dip and move to Master** and keep playing; **Undo** brings the bus back.
- **A defect sounds like:** a click, pop or burst at a dip; a bus's sounds stopping instead of moving to Master; a level other than the product of the tree; a dip longer than a few tens of ms. **Reads like:** a strip that does not move to its new depth; a removed bus still in the strips; an Undo that leaves the bus gone.
- *Walker:* the saved parent changes and Engine's gain lands on Engine's volume times Music's (within 0.001), and back after Undo; the added bus exists live; after the removal no voice remains on it; after three undos the tree is as it was; `lateCommands`, `traps`, `busRecordsEarly`, `sidechainLate` and `liveRefused` unchanged. **Limit:** the dip's shape (the 20 ms V) and its click-freedom are the core's goldens' and `Ck1`'s checks; headless Chromium reads a few meter readings per dip, not the dip.

### M5c S4. Compare. Down arrow x3, then **Compare**, then **Compare**

- **Press Down three times on Music's fader**, then **press Compare.** Correct: Music jumps back to its **Play-start level** (a quick smooth fade, no click), a banner says you hear the saved mix and the faders are locked (arrows do nothing). **Press Compare again:** your edit is back. Nothing was saved; **Ctrl+Z** x3 undoes the three presses.
- **A defect sounds like:** a click at either switch; no level change on Compare; the faders still moving while it is on. **Reads like:** the saved value changing during Compare.
- *Walker:* with Compare on, Music's effective gain equals the Play-start volume and `project.json` still holds the edited one; off, the edit is back; three undos restore the start value.

### M5c S5. The owner's way: late, twice, held

- **A late key.** Leave the page alone about 12 s, then press **1**. Correct: exactly S1, Music ducks inside the phrases at once. A defect: the first voice after a long idle starts late or does not duck.
- **A key twice.** Press **2** and **2** again a quarter of a second later. Correct: two bursts, Music at 0.3 for as long as either plays, released afterwards, no jump when the second starts. A defect: a stuck duck, or Music popping back up between the bursts.
- **A key held.** Focus Music's fader and **hold the Down arrow** for a second. Correct: the level glides down with no zipper; **each repeat is one edit** and the held key is as many undo steps (press Ctrl+Z until it is back).
- *Walker:* a key after 12 s idle still ducks Music to 0.30 to 0.42; two bursts a quarter second apart take Music under 0.36 and it is released; holding Down lowers the fader (never raises it), the gain follows, and at least four undo steps bring it back.

### Part 3 limits

The walker cannot show a dip (a few meter readings per 40 ms), cannot open the read-only sample itself, and does not add a fifth effect through the Project panel (the audio core runs four; that refusal is `audio-mix-c.spec.ts`'s check, not a step here).

### Part 3 sign-off

| Step | Control(s) | Heard OK / issue | Note |
|---|---|---|---|
| M5c S0 | Play, -, Window > Audio Mixer, D | | |
| M5c S1 | 1, 1, 2, 1 then 2, 1 | | |
| M5c S2 | Down x5, drag, Escape, Undo x5 | | |
| M5c S3 | Engine's parent, + child, x, Undo x3 | | |
| M5c S4 | Down x3, Compare, Compare | | |
| M5c S5 | 1 late, 2 twice, Down held | | |

## Part 4. Capture from an exported game

A game exported with the capture option records its own audio mix on a key press (or a three-finger touch), saves a `.mycap` file, and the editor's **Audio Profiler** opens that file. This is the whole loop a tester would use. **Automated check pending (X3):** the round-trip test has not run yet; the steps below are written from [the profiler guide](../../guide/audio-profiler.md) and the trigger's source, and nobody has run them end to end. Report anything that differs from what they say.

### CAP1. Export with capture and record. Desktop browser

```bash
npm run build
npm run export -- samples/sound-lab --out /tmp/lab-cap --audio-capture
cd /tmp/lab-cap && node serve.mjs 8083
```

(`--out` needs an empty folder. The export prints the address; `8083` is the port argument.) Open `http://localhost:8083/` in Chromium, click once to unlock the audio, play something on the main page (**1** a one-shot, **B** the drums, **A** the noise).

- **Press F9.** Correct: a one-line toast **"Recording audio..."** at the bottom of the page.
- Play for ten seconds or so, with a fade or two (**3**) so the take has events in it. **Press F9 again.** Correct: a toast **"Saved capture-YYYYMMDD-HHMMSS.mycap"** and a file with that name in the browser's downloads.
- **A defect reads like:** no toast; the second F9 starting a new take instead of saving; no file; an error toast (read it: it names the problem). Exporting **without** `--audio-capture` and pressing F9 must do nothing at all (no toast, no download).

### CAP2. Open it in the editor

Run `npm run dev`, open `http://localhost:3000/editor.html?sample=sound-lab`, open **Window > Audio Profiler**, press **Open** and choose the `.mycap` (or drop the file on the panel). Only `.mycap` files are accepted.

- **Correct:** a progress bar, then the timeline with the **Viewing, not replaying** banner; nothing plays. The tracks show the take: CPU, voices, bus levels, loudness (Master metered; the readout agrees with what the game showed), the voices table at the cursor lists what played. Click on the timeline to scrub; the keys (Left and Right step a status block, U underruns, L late commands, D ladder steps, M markers, Space pause) work while focus is in the panel.
- **A defect reads like:** a refusal banner for a file the same build just wrote (the banner names the code); an empty timeline; the **different audio section** banner for the project you exported from (the editor's project is the sample, so it should not appear); a loudness track that disagrees with the game's own meter.
- Also try a refusal once: choose any non-`.mycap` file. Correct: turned away with a banner before it is read, and a capture already open stays open.

### CAP3. The touch trigger and rotation. Phone or emulator

Export with capture as above, open it on the device (DEV2 says how). **Hold exactly three fingers on the screen for one second.** Correct: the same "Recording audio..." toast; another three-finger hold stops and saves. Fewer or more than three fingers, or lifting early, does nothing. On a **web** page the file goes to Chrome's downloads; in a **Tauri app** (desktop or Android) it goes to `<appData>/cache/capture-YYYYMMDD-HHMMSS.mycap.bin` and keeps the newest 16 auto-named files (a file you named is never deleted; a browser stops at 16 saves per page session, with a toast saying so).

- **Rotation (emulator or desktop app):** save 17 auto-named takes. Correct: 16 files remain, the oldest deleted. (A browser cannot delete downloads, so there the 17th press gives the "Capture limit reached" toast; reload the page to record again.)

### CAP4. Getting the file off the phone

- **Web export in the phone's Chrome:** the file is in the phone's Downloads. `adb pull /sdcard/Download/capture-YYYYMMDD-HHMMSS.mycap .` (list first with `adb shell ls /sdcard/Download`).
- **Tauri app** (the desktop export's Tauri project, or an Android Tauri build if you have one): the file is in the app's private data folder, `cache/`. On a debuggable build: `adb exec-out run-as <the app's package id> cat files/cache/<name>.mycap.bin > <name>.mycap` (the data directory's exact path depends on the build; `adb shell run-as <package> find . -name "*.mycap.bin"` finds it). The saved file has a `.bin` ending: **rename it to `.mycap` before opening it**, because the Profiler accepts only `.mycap`. On desktop the path is shown in the Profiler's bar and the toast names the file.

Then open it as in CAP2 and check that the phone's take shows the phone's load (its CPU line, or the "CPU not yet measured" or "clock too coarse" reason, DEV3).

### Part 4 sign-off

| Step | Do | Heard OK / issue | Note |
|---|---|---|---|
| CAP1 | export with capture, F9 twice, file downloaded | | |
| CAP2 | open in the Audio Profiler; a non-capture refused | | |
| CAP3 | three-finger hold; the 16-file rotation | | |
| CAP4 | `adb pull`, rename, open | | |

## Part 5. The lab VM, the phone, and the real-device items

### The lab VM

| Id | Item | Do | Record |
|---|---|---|---|
| DEV1 | The whole pass on the VM | `npm run dev` on the VM (or a build you copy there) and Parts 1 to 3 as on the desktop if the VM has an output device. For a desktop app on the VM: `npm run tauri:build` (installers; needs the Rust toolchain), or the Sound Lab as a desktop game: `npm run export -- samples/sound-lab --target desktop --out <empty folder>` (runs `tauri build` when Rust is installed; `--no-build` only writes the Tauri project). The desktop game takes `--audio-capture` too (CAP1, CAP3). Without an output device run the headless walker and say so. | The walker's pass or fail for each section, the machine, and which steps you could hear. |

### The phone

| Id | Item | Do | Record |
|---|---|---|---|
| DEV2 | The Sound Lab and a capture on a phone | The editor is not a phone page, so the phone runs an **export** (the Android export target of ADR 0155 is not in the exporter yet: `--target` is `web` or `desktop`, so use the web export in the phone's Chrome). `npm run build`, then `npm run export -- samples/sound-lab --out /tmp/lab-web --audio-capture`, `cd /tmp/lab-web && node serve.mjs 8083`; USB debugging on, `adb reverse tcp:8083 tcp:8083`, open `http://localhost:8083/` in Chrome (`localhost` is a secure context, so the AudioWorklet works). Tap once to unlock audio. The tour page has buttons along the bottom (Events, Spatial, Music, Rhythm, Mixer); the music and rhythm pages have buttons for their keys, but the main page's keys (Part 1 and 2) and the Mixer page's keys (Part 3) have **no** on-screen buttons, so they need a Bluetooth keyboard (or `adb shell input keyevent`) on the phone; Parts 1 to 3 stay desktop work. Then CAP3 and CAP4 (a three-finger hold needs no key). | Device, Android and Chrome versions, which pages and keys worked from the touch screen, and what you heard. |

### The real-device items (ADR 0169, deferred under M4 and M5)

These need a **real** Android phone. An emulator's audio runs through the host and its timing is not a device's, so none of these can be signed on one; the emulator readings are a useful load test only. If no real phone exists they stay deferred with their tickets (RS1 in [api-and-models](api-and-models.md)); nothing is wrong in the meantime, because the CPU line shows its reason where the clock is coarse.

| Id | Item | Do | Record |
|---|---|---|---|
| DEV3 | **The CPU figure on real Android, and the worklet clock** (RS1) | The DEV2 page, Sound Lab main page, a few sounds playing. Over remote DevTools (`chrome://inspect` on the desktop) run `JSON.stringify(__myco.Audio.debug().cpu)` a few times over a minute. | `loadPermille` (a real number, not `null`; 100 per cent of a block is 1000), `windowMs`, `clockStepMs` (the worklet clock's smallest step), `clockSteps`, and `hidden`. **`hidden` reads "clock too coarse (n ms)" when the clock is above 2 ms: that is the coarse-clock rule working, not a failure; record the n.** Also open a capture from the phone (CAP4) and see that the CPU track agrees. Do it on Chrome and, if you have the Tauri shell, its WebView; Firefox and WebKit are the same two readings on their devices (RS1). |
| DEV4 | **The recorder's floor cost** (est. x8 the desktop's) | Same page. Read `cpu.loadPermille` and `Audio.debug().underruns` (and `minSlackFrames`) for a minute **without** recording, then press F9 (three fingers) to record for a minute with the same sounds, and read them again; stop and save. | The two `loadPermille` readings, underruns before and during, the file size (`ls -l` after the `adb pull`; the desktop figures are 0.27 MB a minute at 64 live voices, 0.84 at 256, 2.45 at 1,024, measured files 12 to 19 per cent above). Recording must add no underruns on a healthy phone. |
| DEV5 | **The real ladder step** (M5b S5's device half) | On a loaded or throttled phone (or the stress sample while it underruns) play until Audio Debug shows the ladder shedding. | UI's loudness line `[paused by ladder]` while in force, Master unpaused; after it clears UI is `[incomplete]` and Master is not; the sound itself did not change (it is the engine saving time). `Loudness ladder step 1` and `Meters paused 1` in the debug rows. |

### Part 5 sign-off

| Id | Machine, OS, browser or app | Heard OK / issue / not run (no real device) | Note and numbers |
|---|---|---|---|
| DEV1 | | | |
| DEV2 | | | |
| DEV3 | | | |
| DEV4 | | | |
| DEV5 | | | |

## What the walker cannot do (all parts)

- **Hear.** Headless Chromium has no sound output: every "correct" and "defect sounds like" sentence is yours. The walker reads lane values, duck gains, the records main sent, the meters and the core's counters, so it proves a step ran as built and on which frame.
- **Clicks and zipper, objectively.** The sample-to-sample jump (`maxStep`) of the M5-0 scenes and the Mixer scene is the goldens' check (tasks DS0, DSd), and `Ck1`'s click tests cover every edit class at eight phases; they are not substitutes for your ear on the page, but they are why the walker does not try.
- **True latency.** "A fraction of a second" is a stamp ahead of the clock, not key to ear.
- **A real device.** Parts 4 and 5 are yours.

## Overall sign-off

| Part | Steps | All heard OK? | Issues (step ids) |
|---|---|---|---|
| 1. M5-0, the stamped bus path | S0 to S6 | | |
| 2. M5b, loudness | S0 to S6 | | |
| 3. M5c, live mixing | S0 to S5 | | |
| 4. Capture from an export | CAP1 to CAP4 | | |
| 5. VM, phone, real device | DEV1 to DEV5 | | |

Walker runs (listen mode and headless): pass or fail for each case, date, note.

Output device and machine, and the volume the reference was set at:

Signed:                                                      Date:
