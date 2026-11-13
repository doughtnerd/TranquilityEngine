# M5b listening section: loudness against a reference (ADR 0171 amended by 0172, task LSb)

The owner's section for milestone M5b: the **loudness meters** (momentary, short-term, integrated, range, true peak) read against a **reference file at -23 LUFS**, the **target verdict** (ok, low, high, peak over) that warns and never adjusts, **reset and pause**, **a hot bus's true peak**, and the **ladder flag**. It is the second of three M5 sections (M5-0 is [m5-0.md](m5-0.md); M5c, live edit, follows; Ls1 joins them into `listening-pass.md`).

It was written from the running Sound Lab, with its headless walker beside it (`tests/e2e/audio-mix-listening.spec.ts`, cases `M5b`), not from the design. The numbers below are what the walker reads in the page. **Nobody has auditioned this yet:** every "correct" line is what the engine is built to do and the walker's readings agree with, not a finding. Mark each step **heard OK** or **issue** (with a note) in the sign-off block at the end.

What this section is for. A loudness meter is a number; the owner's ear is what says whether the number belongs to the sound. So the section asks you to do three things the walker can't: hear that the reference is a clean, steady tone (nothing in it for a meter to be wrong about), hear that the hot signal is as loud as the meter says (about 23 LU above the reference), and hear that the page goes back to how it was.

## What you need

- **Headphones or monitors, volume low before you start.** Step S3 plays a tone at -0.5 dBFS, about 22 dB louder than the reference. Set the reference (S1) to a comfortable level first, then leave the volume alone. Wired if you can. Chromium (Chrome or Edge).
- The repository with M5b built (`npm install` once, then `npm run test:e2e:install` for the walker).
- For a true reference, a calibrated level: if you have a sound-level meter or know your chain's gain, set the volume so the reference at -23 LUFS is the level you work at (mastering rooms use 79 to 83 dB SPL per channel). The section does not need it; the readings do not depend on your volume.

### Run it

```bash
npm run dev
```

Open `http://localhost:3000/editor.html?sample=sound-lab`, press **Play**, and click the game view once (sound starts after a gesture, and the click gives the game the keys). Keys go to the game view, so keep it focused. **D** shows the readout (top left): for Master and UI, the momentary (M), short-term (S) and integrated (I) loudness in LUFS, the range (LRA) in LU, the true peak in dBTP, the seconds metered, any flags in brackets, and the target's verdict on a second line.

To let the walker prompt you step by step and check each step afterwards (it waits for your key, reads the page, and says in the terminal which step ran as built):

```bash
E2E_LISTEN=1 npm run test:e2e:slow -- audio-mix-listening --headed --workers 1 -g "M5b \(owner"
```

A card over the page lists the keys; the terminal prints `[listen] M5b: press N ...` with what to listen for. The spec never times out while it waits for you.

The same walk without you (the headless check; it proves the page does what the steps say, not how it sounds):

```bash
npm run test:e2e:slow -- audio-mix-listening --project chromium-slow --workers 1 -g M5b
```

It has two cases: `M5b (owner or headless)` (S0 to S5 below, pressing the keys itself) and `M5b (listen mode)` (the same meters with the keys at human pace: a late key, a quick double tap, a held key; step S6).

## The test material (what each key does)

| Key | Does | Material | Bus |
|---|---|---|---|
| **L** | the **reference**: pauses every other sound on the page, plays the reference, resets Master's and UI's meters; pressed again, stops it and gives the other sounds back | `loudness-reference.wav`: a 1 kHz sine at **-23 dBFS** (peak) on both channels, 2 s looped with no seam (EBU Tech 3341 case 1) | UI |
| **W** | the **hot signal**, once, 2 s | `loudness-hot.wav`: the same sine at **-0.5 dBFS** | UI |
| **C** | resets Master's and UI's meters (`reset("all")`: integrated, range, maxima, flags, and the window) | | |
| **F** | pauses or resumes Master's and UI's meters | | |
| **V** | the next target: console (-24 LUFS +/- 2 LU), then mobile (-18 LUFS +/- 2 LU), then round | | |
| **D** | shows or hides the readout | | |

The page also plays its own sounds from the start (the music tone on Music, the hum on Ambience); L pauses them so Master carries the reference alone. The hum goes through the Ambience bus's reverb, which rings out for about two and a half seconds after the hum stops: **wait for the readout's M to settle on -23 before pressing C**, or the reset keeps a little of the room. The project's meters: **Master** (always metered: it reads the final output after the reverb and the limiter) and **UI** (`meter: "loudness"`). Both targets have a true-peak ceiling of -1 dBTP; the first target (console) is in force at start.

A meter measures with the BS.1770 K-weighting; for a stereo sine at X dBFS the integrated loudness is X LUFS to within a few hundredths, which is why the reference reads **-22.99** (the engine's own measurement of the EBU signal, -22.993; the standard allows +/- 0.1 LU).

## Setup (S0, do it once)

Press **D**. You should see the readout top left, with the page's music and hum playing under it: Master's M somewhere below 0 LUFS and moving a little (the hum orbits), UI's numbers `-` (nothing on UI yet), and the verdict line under each (`console (-24 LUFS +/- 2, -1 dBTP): waiting` for UI, a verdict for Master).

**Walker:** the readout key was seen and Master's momentary reads a finite number below 0.

## The steps

Do them in order the first time; each one leaves the page as it found it, except S5 which has nothing to press.

### S1. The reference reads -22.99. Key **L**, then **C**

- **Press L and listen.** Correct: the music and the hum stop at once (the hum's room rings out over a couple of seconds, quietly) and a **steady 1 kHz tone** starts: a plain, pure "beep" that does not move, pulse, crackle or change pitch, and does not click when it starts. Watch the readout's M: it climbs through the room's tail and settles on **-23.0**. Then **press C**: the clock restarts at 0 s and runs on.
- **After about six seconds of the readout's clock**, read it. Correct, for Master and for UI alike: **M, S and I all read -23.0 or -22.99** (within 0.1), **LRA 0.00** (a steady tone has no range), **peak -23.0 dBTP**, no flags, and the verdict **`console ... ok, +1.01 LU`** (the tone is 1 LU above the console's -24).
- **A defect sounds like:** a tone that wobbles in level or pitch (the meter would be right and the tone wrong); a click, tick or burst of noise when L is pressed; the music or the hum still audible under the tone after the second or so of tail (L did not pause them); the tone playing in one ear only (the reading would be 3 dB low). **A defect reads like:** M, S and I settled on different numbers; I not within 0.1 of -23; a flag in brackets (`incomplete`, `tainted`) without reason; UI and Master a tenth or more apart; the clock not running.
- **Walker confirms (not by ear):** the reference voice plays on UI and no other sound is playing on Music or Ambience; Master's momentary settled within 0.05 of -22.99; after C both meters read 0 s, and after **6 s of rendered audio** (the meters' own clock, not wall time) M, S and I are each within 0.1 of -22.99, LRA is between 0 and 0.1, the true peak is between -23.4 and -22.8, neither meter is incomplete, tainted or paused, the console target says ok with a deviation of +1.01.

### S2. The verdict warns, never adjusts. Key **V**, then **V** again

- **Press V and look.** Correct: the readout's second line changes to `mobile (-18 LUFS +/- 2, -1 dBTP): low, -4.99 LU`: the same tone, now 5 LU under the target. **The sound does not change at all**: no level change, no click. The verdict is a warning; the engine never turns anything up or down for it. M, S and I keep their values (a new target is not a reset) and the clock keeps running.
- **Press V again.** Correct: back to `console ... ok, +1.01 LU`; the sound still has not moved.
- **A defect sounds like:** the tone getting louder or quieter when the target changes (something is adjusting). **A defect reads like:** the verdict not changing, or the numbers restarting.
- **Walker confirms:** `Audio.loudnessTarget` reads `mobile` then `console`; Master's verdict is `low` with a deviation of -4.99 (within 0.05) and then `ok`; integrated stays within 0.1 of -22.99 and the clock has not been reset.

### S3. A hot signal's true peak. Keys **L**, **C**, **W**

**Check the volume first:** this tone is 22 dB louder than the reference.

- **Press L** (the reference stops; the music and the hum come back), **press C** (both meters restart at 0 s), then **press W.** Correct: a **loud steady tone** for two seconds, then silence on UI (the music and the hum go on under it). The readout's UI line, once its clock reads 3 s or more: **I about -1 LUFS (a little under the tone's own -0.5: the blocks at the burst's start and end are only partly tone), peak about -0.5 dBTP, verdict `console ... high, about +23 LU, PEAK OVER`** (the peak is over the targets' -1 dBTP ceiling). The `PEAK OVER` stays on after the tone ends.
- **Press C.** Correct: the flag clears, the verdict goes back to `waiting` (nothing integrated yet), the clock restarts.
- **A defect sounds like:** the tone **clipping or crackling** (a distorted tone is not a -0.5 dBFS sine: a true-peak bug would show as a limiter working, or a harsh edge); the tone much quieter than the readout's number suggests (compare it with the reference: it should be a very large step, about 22 dB). **A defect reads like:** `PEAK OVER` missing with a peak above -1; `PEAK OVER` showing on a meter that carried nothing hot; the flag not clearing on C.
- **Walker confirms:** the hot voice plays on UI; after 3 s of rendered audio UI's console verdict is `high` with a deviation between 22.6 and 23.6, `peakOver` is true and the true peak is between -0.8 and -0.2; after C the peak flag is false.

### S4. Pause and resume, and reset. Keys **L**, **C**, **F**, **F**, **C**

- **Press L, wait for M to settle on -23, press C**, let the clock run a couple of seconds. **Press F.** Correct: the readout **freezes**, every number, **including the clock**, while the tone plays on unchanged (the tone is the signal, the meters are the thing paused). A `[paused by script]` flag shows on both lines.
- **Wait a few seconds, then press F again.** Correct: the readout moves again, I is **the value it held** (-23.0), the clock continues from where it stopped; M reads `-` for the first 0.4 s (the window restarts) and S for 3 s, then both read -23.0 again. **No `incomplete` flag:** a pause you asked for is not a gap in the programme.
- **Press C.** Correct: clock to 0, I, LRA and the peak go to `-`, then fill again as above.
- **A defect reads like:** numbers that keep moving while paused, or a clock that keeps counting; I jumping on resume; an `incomplete` flag after a pause you made yourself. (A tone that changes when F is pressed would be a defect of the page, not of the meter: F touches only the meters.)
- **Walker confirms:** both meters report `paused` with `pausedBy script` and `Audio.debug().mix.metersPaused` reads 2; across **2 s of the audio clock** the clock and I do not move; after F the meters count again (a second of rendered audio past the held value), I is within 0.1 of -22.99 and not incomplete; after C the clock is under 1 s.

### S5. The ladder flag. No key (the walker's step; the owner's check is on a loaded device)

When the audio thread runs late for long enough, the engine's **shedding ladder** takes its first step: it pauses every loudness meter except Master's ("meters paused to give the time back"), reports it, and gives it back last. You cannot provoke that with a key on a healthy machine (it needs the adaptive voice cap at its floor and seconds of underruns), so the walker sets the same flag the core's STATUS carries and reads what the page does with it. On a **loaded device** (the lab VM, a phone, or the stress sample while it underruns), you would see:

- **While the step is in force:** UI's line shows **`[paused by ladder]`**, its clock stops, **Master's does not pause** and keeps measuring; **Window > Audio Debug** shows `Loudness ladder step 1` (flagged bad) and `Meters paused 1`. The sound is unaffected (this is the engine saving time, not changing the mix).
- **When it is given back:** UI meters again, and its line shows **`[incomplete]`**: the time it was shed is a gap in its measurement, so its integrated value is marked as not covering the whole programme until you press C. Master is never marked.
- **A defect reads like:** Master pausing with the others; UI pausing with no `ladder` in its flag; the step in force but the debug row at 0; UI back with no `incomplete`.
- **Walker confirms (the seam, not a real step):** the `loudShed` the core reports sets UI to paused by `ladder`, Master not paused, `Audio.debug().mix` reads `loudnessLadderStep 1` and `metersPaused 1`; across 1.5 s of the audio clock UI's clock holds and Master's runs on; when the flag goes back to 0 UI meters again and is `incomplete`, Master is not; C clears it. **Limit:** the core's own trigger and the step order (loudness first, given back last) are `audio-core`'s and `ladderRecoveryLoopback.test.ts`'s checks, not this walker's.

### S6. The owner's way with the keys: late, twice, held

You press at human pace, and not always at a good moment. These are the cases the headless walker also runs in its `M5b (listen mode)` case; do each once by ear.

- **A late key.** Leave the page alone for about 12 seconds (the music and the hum play), then press **L**. Correct: it is exactly S1: the reference starts clean, the readout settles on -23.0. A defect: the first reference after a long idle starts late, clicks, or leaves the music audible.
- **A key twice.** Press **C**, and **C** again a quarter of a second later. Correct: the clock restarts from the second press, with no jump in M, S or I once they refill. A defect: a stale reading after the second press.
- **A key held.** Hold **F** down for a second (the keyboard repeats). Correct: **one** pause, not a flutter; the readout stays frozen until you press F once more. Hold **L** (with the reference off): **one** reference starts, one tone, not two stacked (a doubled tone would read +3 LU). A defect: the readout toggling while you hold; the tone twice as loud.
- **V at human pace.** Press it twice with a pause: console, mobile, console, with the verdict following each time.
- **Walker confirms (listen-mode case):** the late key's reference voice count is 1 and Master settles on -22.99; after two quick C presses the clock is under 1 s and I settles on -22.99; a held F is one pause (paused, and one F resumes); a held L leaves exactly one reference voice playing; the target ends on console.

## What the walker cannot do

- **Hear.** Headless Chromium has no sound output: every "correct" and "defect" sentence above about how it sounds (a steady tone, a click, a distorted peak, a doubled tone) is yours. The walker reads the meters' numbers, the verdict, the flags and `Audio.debug()`.
- **Judge that the number belongs to the sound.** A meter that agrees with the engine's own tone generator proves the filter and gating, which the goldens already do (the synthesised EBU Tech 3341/3342 set, task Ld6). Your ear and, if you have one, a second meter on the same file are what say the engine's number is the loudness you hear.
- **A real ladder step.** See S5: the walker sets the flag; the device sets the real one.
- **Monitor mute and solo, Compare, and the mixer panel's meters.** The taint rules (a monitor mute taints that bus, its ancestors and master; solo and Compare taint every meter; a mark stays until a reset) and every reset option are checked by `tests/e2e/audio-mix-b.spec.ts`. The Mixer panel's strips and the Profiler's loudness track are M5c and the profiler sections.

## Sign-off

| Step | Key(s) | Heard OK / issue | Note |
|---|---|---|---|
| S0 | D | | |
| S1 | L, C | | |
| S2 | V, V | | |
| S3 | L, C, W, C | | |
| S4 | L, C, F, F, C | | |
| S5 | (walker only; a loaded device) | | |
| S6 | L late, C twice, F held, L held, V at human pace | | |

Walker run (owner mode, or headless): pass / fail, date, note. Output device, machine and the volume the reference was set at:

Signed:
