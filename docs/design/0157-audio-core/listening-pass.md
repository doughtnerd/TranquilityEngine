# Audio core M1: the listening pass (C4)

The owner runs this pass and signs it before MS8 ships ([api-and-models §9](api-and-models.md), row C4: "checklist signed by the owner"; [architecture §11](architecture.md), "Still open": "the owner runs it, per effect, preset, resampler mode and HRTF, before each milestone ships"). It has two halves:

1. **Objective thresholds:** every automated quality and timing check, its threshold, the value measured when it landed, and the test that enforces it. These run in CI; the owner only reads them.
2. **Listening items:** what a person hears that the checks can't judge (clicks, zipper noise, character, where a sound seems to be). Each item gives the setup, what to listen for, when it passes, and where the code is.

It takes about an hour. **Headphones are required** (HRTF can't be judged on speakers). Speakers are optional for the limiter and loudness items.

## Before you start (about 8 minutes)

1. **Machine:** the build to sign (master after MS8, or the commit you're signing), on a desktop browser with a normal audio device (Chromium-based for the main pass; Safari or Firefox is an optional second run). Note the browser version and the output device's sample rate (Windows Sound settings, macOS Audio MIDI Setup, `pactl info` on Linux).
2. **Run:** `npm run dev`, open `http://localhost:3000/editor.html?sample=sound-lab`, press **Play**, then **click the game view** (the click unlocks audio and gives the game the keys).
3. **Watch:** Window > Audio Debug (status, counters, buses, voices at 4 Hz) and Project Settings > Audio (the bus meter strip). In the browser's devtools console, `__myco.Audio.debug()` gives the same data as an object.
4. **Level:** with only the Music loop playing, set the OS volume so it's comfortable, and don't change it during the pass. Loudness items compare against this.
5. **Changing settings:** the sample opens read-only, and the core reads its preset and limiter look-ahead only when it starts. So for each configuration below, **edit the `audio` block of `samples/sound-lab/project.json`, save, and reload the page** (then Play and click again). Put the file back when you're done (`git checkout samples/sound-lab/project.json`).
6. **Wait for the clips:** the first seconds after Play decode the clips. Start an item once Audio Debug lists Music and Emitter as `playing` (not `waitingForData`).

### The Sound Lab's keys

Keys 1–6 are the sample's tour; the rest were added for this pass (`samples/sound-lab/scripts/behaviors/`).

| Key | What it does | Script |
|---|---|---|
| 1 | a click and a pitched beep on UI | `OneShots.ts` |
| 2 / 3 | mute Music / fade Music to 0.15 and back over 0.5 s | `Buses.ts` |
| 4 | the "Underwater" snapshot on/off (0.5 s; low-pass on Music, SFX, Ambience) | `Snapshots.ts` |
| 5 / 6 | a noise burst on SFX (compressor; ducks Music) / a beep on Ambience (reverb send) | `Effects.ts` |
| 7 | a bright sawtooth at pitch 0.5, 1, 1.5, 2, 4, 1.25 s apart | `ListeningBench.ts` |
| 8 | eight near-full-scale tones at once (about +18 dBFS before the limiter) | `ListeningBench.ts` |
| 9 | 300 sounds in 1.5 s: half on the Load bus (`maxVoices` 12), half around the listener | `ListeningBench.ts` |
| 0 | the sawtooth dry, then through the Filters bus (high-pass 500 Hz and low-pass 3 kHz, Q 6 dB) | `ListeningBench.ts` |
| Q | the "Sweep" snapshot on/off over 4 s (low-pass to 250 Hz on Tape, 400 Hz on Music) | `ListeningBench.ts` |
| O | the sawtooth stopped with a 0.25 s fade, then again stopped at once | `ListeningBench.ts` |
| I / K | block the main thread for 300 ms / 800 ms | `ListeningBench.ts` |
| T | start/stop the Tape: a streamed melody (24 kHz file, 8 rising notes, 4 s loop) | `Tape.ts` |
| Y | seek the Tape to the 5th note (2 s), then back to the 1st | `Tape.ts` |
| U / P | pause/resume the Tape (stream voice) / the Music loop (clip voice) | `PauseToggle.ts` |
| G | loop the same 1 s file as WAV, FLAC, Ogg Vorbis, MP3 (LAME tag), then off; the console names each | `LoopCycler.ts` |
| H / J | start/stop a broadband noise source circling the listener at 3 m (10 s a turn) / two more at 7 m and 11 m | `Toggle.ts`, `Orbit.ts` |

### Configurations

Run most items in **A**, then reload into **B** and **C** for the items that need them. **D** is optional.

| Config | `audio` block changes in `project.json` | Used by |
|---|---|---|
| A (default) | none | L1–L4, L6, L7 (HRTF), L9, L10, L11 (1.5 ms), L12, L13, L14 (mute), L16 |
| B | `"voices": { "mixed": 48, "logical": 1024, "hrtf": 1 }, "clipMemoryMB": 64, "limiterLookaheadMs": 0, "background": "pause"` | L5 (low), L8, L9 (low), L11 (0 ms), L14 (pause) |
| C | `"voices": { "mixed": 256, "logical": 8192, "hrtf": 32 }, "clipMemoryMB": 256, "limiterLookaheadMs": 5, "background": "play", "spatial": "equalPower"` | L5 (high), L7 (equal power), L11 (5 ms), L14 (play) |
| D (optional) | `"backend": "babylon"` | L7 against Chromium's own HRTF; the dry path against the fallback |

B is the low preset (`VOICE_PRESETS` in `src/plugins/audio/editor/audioSettingsModel.ts`) except `hrtf` 1 instead of 4, so the HRTF voice set changes with only four spatial sources. C is the high preset.

## Objective thresholds

What CI enforces. "Measured" is the value recorded when the check landed ([build log](build-log.md)); a better result later ratchets the threshold. Paths are from the repository root. `cargo test` runs in `native/audio/`; the Vitest files run in `npm test` and in `.github/workflows/audio-quality.yml`; the Playwright specs are `@slow` (`npm run test:e2e:slow`).

### Quality

| Metric | Threshold | Measured | Enforced by |
|---|---|---|---|
| Resampler THD+N, whole ratios (1 kHz at pitch 1 and 2) | ≤ −150 dB | −153.7 dB (bit-exact to linear) | `native/audio/crates/audio-dsp/tests/quality_thdn.rs` (`THDN_LIMITS`) |
| Resampler THD+N, 200 Hz at pitch 1.5 / ±1 semitone / 0.75 / 0.5 / ⅓ | −145 / −125, −135 / −145 / −135 / −120 dB | −151.8 / −129.4, −139.4 / −149.7 / −140.3 / −127.2 dB | same |
| Resampler THD+N, 1 kHz at pitch 1.5 / +1 st / −1 st / 0.75 / 0.5 | −120 / −105 / −105 / −95 / −80 dB | −123.3 / −112.5 / −111.4 / −101.8 / −85.2 dB (linear was −66.4 … −47.3) | same |
| Resampler THD+N, 5 kHz at 1.5 / +1 st / −1 st; 10 kHz at +1 st | −60 / −55 / −50; −30 dB | −67.6 / −59.7 / −55.7; −35.6 dB | same |
| 4-point kernel against linear | ≥ 10 dB better THD+N on every fractional row; bit-identical at whole ratios | 12–57 dB better | same (`lagrange_thd_n_beats_linear_on_every_row`) |
| Image and alias spurs (1 kHz at 0.5 / 1.5 / +1 st; 5 kHz at 1.5 / 0.75) | −80 / −120 / −115; −65 / −45 dBc | −87.0 / −125.1 / −119.4; −69.3 / −49.7 dBc | same (`SPUR_LIMITS`) |
| Folds past Nyquist on pitch-up (no anti-alias filter: **accepted by the owner, 2026-11-10**, band-limiting is post-M1, #110) | ≤ 0 dB (17 kHz at 1.7: ≤ +5 dB); a whole-ratio fold keeps its full level | −2.3 to −6.3 dB; 15 kHz at pitch 2: 0.0 dB | same (`FOLD_LIMITS`, `whole_ratio_pitch_up_folds_without_rejection`) |
| Unity null through the core (root bus; nested buses and MASTER; after gain ramps away and back) | residual < −120 dBFS | bit-exact | `native/audio/crates/audio-core/tests/quality_null_pan_limiter.rs` |
| Pan power (`L² + R²`) over all azimuths: the bare kernel, stereo per channel, a spatial voice through the core | within 0.01 dB of unity | 2.5e-7 dB through the core | same |
| Limiter ceiling: one full-scale voice; four summed voices (+12 dBFS); four tones at 44.1, 48, 96 kHz | output peak ≤ 0 dBFS (1.0), and > 0.99 when over (level kept up to the ceiling) | exactly 1.0 on the summed DC | same; `native/audio/crates/audio-dsp/src/limiter.rs` unit tests (impulses, squares, summed tones at every rate and look-ahead 0–5 ms) |
| Limiter release | back within 0.1 dB about 240 ms after the last peak (−0.105 to −0.08 dB at 240 ms) | as designed (10 ms hold, 60 ms release) | `limiter.rs` (`hold_then_release_at_the_documented_time_constant`) |
| Limiter look-ahead shape | at 1.5 ms the error against the scaled sine over the first 20 ms is ≥ 6 dB below the instant limiter's; below the ceiling the output is the input delayed, bit for bit | 100 Hz −18.0 → −27.0 dB, 440 Hz −24.4 → −45.7 dB, 1 kHz −27.9 → −55.5 dB | `limiter.rs` (`the_lookahead_attack_does_not_reshape_the_waveform`, `under_the_ceiling_the_output_is_the_input_delayed_bit_for_bit`) |
| Web Audio parity: biquad and snapshot low-pass sweeps, compressor, pan at 13 directions (100 scenes, 48 and 44.1 kHz) | levels within 0.1 dB; waveform nulls ≤ −90 dB (owner, 2026-11-10) | 0.000 dB; nulls exact or −103 to −165 dB | `tests/e2e/audio-parity.spec.ts` (Chromium `OfflineAudioContext`), `src/plugins/audio/testing/webAudioParity.test.ts` (Node, committed digests); `TOLERANCES` in `tests/e2e/audio-parity/analysis.ts` |
| Web Audio parity: reverb send (wet and dry, energy decay) | levels within 0.1 dB; nulls ≤ −80 dB | ≤ 0.01 dB; nulls −104.5 dB (48 kHz), −109 dB (44.1 kHz) | same |
| HRTF parity against `PannerNode` HRTF (30 scenes, 44.1 and 48 kHz) | band levels and ILD within 0.1 dB; ITD within 0.1 frame; window nulls ≤ −35 dB | levels ≤ 0.05 dB, ILD ≤ 0.001 dB, ITD ≤ 0.01 frame, nulls −42 to −75 dB (az100/el40 and az112: −40 to −50 dB) | `tests/e2e/audio-parity-hrtf.spec.ts`, `src/plugins/audio/testing/hrtfParity.test.ts`; `HRTF_TOLERANCES` in `tests/e2e/audio-parity/hrtfAnalysis.ts` |
| Ported DSP against upstream | biquad coefficients within 1.15e-8 of the cookbook; compressor within 1e-5 of a line-by-line upstream reference (measured 7.3e-7) | as stated | `native/audio/crates/audio-dsp/tests/ports_biquad.rs`, `ports_compressor.rs`, `ports_hrtf.rs` |
| Convolver accuracy against direct convolution | ≤ 1e-6 of peak | 2.0e-7 to 4.4e-7 | `native/audio/crates/audio-dsp/tests/convolver_direct.rs` |
| Golden renders (21 scenes incl. pitch, loops, effects, HRTF, MP3/Vorbis/AAC loop seams) | SHA-256 of the f32 output, exact | stable | `src/plugins/audio/runtime/audioGolden.test.ts`, `src/plugins/audio/runtime/golden/` |
| Gapless loops (WAV, FLAC, MP3 with a LAME tag, Vorbis, AAC in M4A) | the decode is exactly the source's frames; the looped output is the decode repeated, bit for bit (clip and stream voices) | bit-exact; a streamed `town.mp3` matched its looped decode at 150 dB | `native/audio/crates/audio-decode/tests/loop_seam.rs`, `src/plugins/audio/runtime/core/loopSeam.test.ts` |
| Preset loudness (api-and-models §8) | **no automated check**: presets change voice counts, not gains | — | listening item L5 |

### Fades and timing (no-click contracts)

| Behaviour | Contract | Enforced by |
|---|---|---|
| Promote / demote (selection) and steals | 5 ms linear `mix` fade at the core rate; a promote during a demote turns round without a jump | `native/audio/crates/audio-core/tests/mixed_virtual.rs`; steal fade `STEAL_FADE_SECONDS` 0.005 in `src/plugins/audio/runtime/core/coreBackend.ts` |
| Per-voice pause / resume | 5 ms fade out, hold exactly, 5 ms fade in from the held frame (it holds where the fade ends: owner review 6) | `native/audio/crates/audio-core/tests/paused.rs`, `src/plugins/audio/runtime/core/pauseLoopback.test.ts` |
| Seek (clip and stream voices) | 5 ms fade out from a tail copy, then the target faded in; no sample from before the seek after the fade | `native/audio/crates/audio-core/tests/seek.rs`, `src/plugins/audio/runtime/core/streamLoopback.test.ts`, `clipSeekLoopback.test.ts` |
| Stream starvation | 5 ms fade to silence (`waitingForData`), 5 ms fade back in from the held frame | `streamLoopback.test.ts` ("starvation fades to silence …") |
| Equal-power ↔ HRTF change | 45 ms linear crossfade both ways, also when the table arrives; no step above the signal's own | `native/audio/crates/audio-core/tests/hrtf.rs` (`a_kind_change_crossfades_over_45_ms_both_ways`, `the_table_arriving_crossfades_a_flagged_voice_in`) |
| Background | `mute`: master to 0 over 50 ms; `pause`: 30 ms fade, then the context suspends; `play`: untouched | `src/plugins/audio/runtime/core/backgroundLoopback.test.ts` |
| Bus gain (volume, mute, snapshot, ducking) | ramped per frame from the next quantum; the snapshot low-pass ramped per quantum | `native/audio/crates/audio-core/tests/bus.rs`, `golden_buses.rs` |
| `at` scheduling | lands on its exact frame (also after a context swap); late commands counted | `src/plugins/audio/runtime/core/clockLoopback.test.ts`, `native/audio/crates/audio-core/src/scheduler.rs` tests |

### Robustness and budgets

| Metric | Threshold | Measured | Enforced by |
|---|---|---|---|
| Underruns in the Sound Lab (headless Chromium, A2.6) | 0 at start, ≤ 2 by the end (owner review 4; the strict 0 is C3's soak) | 0–1 | `tests/e2e/audio-core.spec.ts` |
| Streaming under a 300 ms main-thread stall (B3) | no starve, no underrun, output exact | 0 / 0 / exact | `src/plugins/audio/runtime/core/streamLoopback.test.ts` |
| Adaptive cap (A3.3) | drops on an underrun, recovers after 5 s calm | 40 → 34 (6 quietest demoted) → 40 | `src/plugins/audio/runtime/core/adaptiveCapLoopback.test.ts`, `native/audio/crates/audio-core/tests/cap_controller.rs` |
| Trap rebuild (A3.4a) | voices back with the same handles at the right position; the 4th trap in 60 s goes silent with one warning | sound back after 24 quanta (≈ 64 ms) in the loopback; 350 ms in Chromium | `src/plugins/audio/runtime/core/recovery.test.ts`, `hrtfLoopback.test.ts` |
| Device / rate rebuild into a new context (A3.4c) | a voice resumes within one quantum of its position; `Audio.time` continuous | 127 clip frames; within 0.1 ms; Chromium 557–865 ms | `src/plugins/audio/runtime/core/contextRebuild.test.ts` |
| Selection, 4,096 voices (A3.1) | p99 ≤ 0.25 ms per frame (Node) | 0.093–0.131 ms | `src/plugins/audio/runtime/core/selectionBench.test.ts` |
| Reverb cost per quantum | average ≤ 0.1 ms, p99.9 ≤ 0.35 ms (native) | 0.025–0.030 / 0.10–0.20 ms | `native/audio/crates/audio-dsp/tests/convolver_budget.rs` |
| Limiter cost per quantum | average ≤ 0.01 ms; bypass cheaper than limiting | ≈ 0.0018 ms limiting | `native/audio/crates/audio-dsp/tests/limiter_budget.rs` |
| Mixer wasm size | ≤ 150 KB | 141.8 KB (145,201 B) | `native/audio/build.mjs` (`MIXER_LIMIT`) |
| Decoder wasm size | ≤ 900 KB (AAC build ≤ 1,100 KB) | 726.0 KB (1,042.7 KB) | `native/audio/build.mjs` |
| `process()` allocation | none, under a counting allocator | none | `native/audio/crates/audio-core/tests/golden_native.rs`, `paused.rs`, `convolver_budget.rs` |

A3.5 (MS8 wave 1) re-measures the per-voice costs and freezes the budget table in [architecture §6](architecture.md); its numbers supersede the cost rows here where they differ.

## Listening items

Mark each **pass**, **fail** or **pass with note** in the sign-off table. A fail gets an issue; a note that the owner accepts stays a note. "Accepted" behaviours are listed under each item and at the end: hearing them isn't a fail.

### L1. Baseline: one-shots and bus moves (Config A, 2 min)

- **Setup:** Play; Music (chord loop) and Emitter (600 Hz hum orbiting) play.
- **Do:** press 1 a few times; 2 (mute), 2 again; 3 (fade down), 3 again.
- **Listen for:** clicks at the start and end of the one-shots, at mute and unmute, and during the fade.
- **Pass:** the one-shots are clean; mute and unmute are instant but click-free; the fade is smooth. Audio Debug shows 0 underruns.
- **Code:** `native/audio/crates/audio-core/src/bus.rs` (BUS_MIX ramps), `src/engine/audio/mixer.ts`, `src/plugins/audio/runtime/core/coreBackend.ts`.

### L2. Effects: filters, compressor, reverb (Config A, 4 min)

- **Do:** press 0 (sawtooth dry, then through Filters), several times; 5 (noise burst on SFX's compressor); 6 (low beep on Ambience's reverb send), and let the tail ring out.
- **Listen for:** the filtered note sounds band-limited with a resonant edge at each corner (a thin, nasal tone), not distorted; the burst is loud but controlled, with no crackle as the compressor clamps or a pop as it releases; the reverb tail decays smoothly to silence with no flutter, grain, repeating pattern or abrupt cut.
- **Pass:** all three sound like ordinary studio effects, with no artefact. (Their match with Chromium's Web Audio nodes is objective: 0.000 dB for filters and compressor, ≤ 0.01 dB for the reverb. The Babylon fallback has no bus effects, so there is nothing to A/B in Config D.)
- **Accepted:** removing every reverb send freezes the tail, which resumes from stale state if a send returns (build log, MS4 wave 2); Sound Lab never does this.
- **Code:** `native/audio/crates/audio-dsp/src/biquad.rs`, `compressor.rs`, `convolver.rs` and `convolver/`; `native/audio/crates/audio-core/src/fx.rs`.

### L3. Snapshot transitions and the filter sweep (Config A, 3 min)

- **Do:** press 4 (Underwater on, 0.5 s), wait, 4 (off). Then T (start the Tape), Q (Sweep on: a 4 s low-pass glide down on Tape and Music), wait 5 s, Q (glide back up), T (stop).
- **Listen for:** zipper noise (a fine buzz or stepping) while the cut-off moves, clicks at the start or end of a transition, level jumps.
- **Pass:** each transition is a smooth glide.
- **Code:** `native/audio/crates/audio-core/src/bus.rs` (`lpHz` ramped per quantum, the snapshot low-pass at Q 1 dB), `src/engine/audio/mixer.ts` (`snapshot`, `retarget`, `update`).

### L4. Ducking (Config A, 1 min)

- **Do:** press 5 several times, once quickly in succession.
- **Listen for:** Music dips while the burst plays (to 0.3, 50 ms attack) and comes back over 0.4 s.
- **Pass:** the dip and recovery are smooth, with no click or zipper and no pumping beyond the intended dip.
- **Code:** `src/engine/audio/mixer.ts` (ducking), `coreBackend.ts` (`applyMix`).

### L5. Presets: low, default, high (Configs A, B, C; 4 min across the three)

- **Do:** in each configuration, listen to Music and the Emitter for 10 s; press H and J (four spatial sources); press 9 once.
- **Listen for:** a change of overall loudness between presets (there should be none: presets change voice counts, not gain); in B (48 mixed voices) more stealing and virtual voices during 9, still without clicks.
- **Pass:** no audible loudness difference between A, B and C on the same material; no artefacts in any preset.
- **Code:** `VOICE_PRESETS` in `src/plugins/audio/editor/audioSettingsModel.ts`; `presetFromSettings` in `src/plugins/audio/runtime/core/context.ts`.

### L6. Resampler: pitch 0.5, 1, 1.5, 2, 4 (Config A, 3 min)

M1 has one resampler mode, the 4-point Lagrange kernel (A3.6), so "per resampler mode" means this item.

- **Do:** press 7 and listen to the five notes; repeat. Then T: the Tape is a 24 kHz file played at the device rate (a constant non-integer ratio).
- **Listen for:** each note at the right pitch relation (an octave down, the reference, a fifth up, an octave up, two octaves up); crackle, clicks at the note edges, level jumps. At 0.5 the note is duller (expected). At 1.5 and 2 a faint inharmonic shimmer in the top octave, and at 4 clearly gritty, metallic partials, are the **accepted aliasing** of bright content at large pitch-ups (owner, 2026-11-10; band-limiting is post-M1, #110). The Tape's melody is in tune and clean.
- **Pass:** pitches right, edges clean, and the only artefact is the accepted aliasing at ≥ 1.5×.
- **Code:** `native/audio/crates/audio-dsp/src/resample.rs`; the guide's Limits section, `docs/guide/audio-mixer.md`.

### L7. HRTF and equal-power around the head (Configs A and C, optional D; 5 min)

- **Do (A):** press H (one broadband noise source circling the listener at 3 m, one turn in 10 s). Close your eyes for two turns. Press H again to stop. The listener is the camera, which looks 20° down, so the circle passes a little above ear level in front and below it behind.
- **Do (C, `spatial: "equalPower"`):** the same.
- **Do (D, optional):** the same on the Babylon fallback, which uses Chromium's own `PannerNode` HRTF with the same IRCAM set.
- **Listen for:** in A, the source circles around you, outside the head, with smooth movement through front, sides and back; some front/back ambiguity is normal for a generic HRTF. In C, it pans left/right only and sits closer to or inside the head. In D, it sounds the same as A.
- **Pass:** A is clearly more externalised than C; movement is continuous with no zipper, clicks or jumps (in particular as it passes straight ahead and straight behind); D, if run, is indistinguishable from A.
- **Code:** `native/audio/crates/audio-dsp/src/hrtf/`, `native/audio/crates/audio-core/src/panner.rs`, `src/plugins/audio/runtime/core/hrir.ts`, `hrtfPick.ts`.

### L8. HRTF voice-set changes: the 45 ms crossfade (Config B, 3 min)

- **Setup:** `voices.hrtf` is 1, so only the most audible spatial voice gets HRTF; the rest pan equal-power.
- **Do:** press H and J (three noise sources circling at 3, 7 and 11 m at different speeds, plus the Emitter). Listen for a minute. Audio Debug's core section shows `hrtfFlagged`; the HRTF voice changes as the sources pass each other.
- **Listen for:** clicks, dropouts or level bumps when the HRTF voice changes; a voice handing over should at most shift its image slightly over 45 ms.
- **Pass:** no clicks or bumps at the hand-overs.
- **Code:** `native/audio/crates/audio-core/src/panner.rs` (crossfade), `src/plugins/audio/runtime/core/hrtfPick.ts` (1.2× hysteresis).

### L9. Voice load: stealing, promote and demote (Configs A and B, 3 min)

- **Do:** press 9 (300 sounds over 1.5 s: half on the Load bus, which holds 12 at once, half around the listener). Repeat once. In B (48 mixed voices), repeat.
- **Listen for:** a dense cloud of bright notes; clicks or crackle on top of it as voices are stolen (5 ms), demoted and promoted (5 ms).
- **Pass:** the cloud is dense but clean; Audio Debug shows `stolen` and `virtual` voices during it and 0 underruns. `mixedCap` may dip for a few seconds after the burst (the 300 plays in one frame count as late commands) and recovers.
- **Accepted:** some plays are refused when every candidate on the Load bus has a higher priority (`droppedPlays` grows); that's the priority rule.
- **Code:** `src/plugins/audio/runtime/core/selection.ts`, `voiceTable.ts`; `native/audio/crates/audio-core/src/voices.rs`, `cap.rs`, `cap_controller.rs`.

### L10. Pause, resume, seek and stop with a fade (Config A, 4 min)

- **Do:** P (pause Music), P (resume); T (start the Tape), U (pause), U (resume); Y (jump to the 5th note), Y (back to the 1st), a few times at random moments; O (a note faded out over 0.25 s, then a note stopped at once); T (stop the Tape).
- **Listen for:** clicks at pause, resume and seek; after a seek, nothing of the old position (the jump is clean: fade out, then the target note); the 0.25 s stop is a smooth fade.
- **Pass:** pause, resume, seek and the faded stop are click-free, and resume continues from where it paused.
- **Accepted:** the second note of O (`stop()` with no fade) is cut at once and may click on a bright sound: that's `stop()`'s contract (use `stop(seconds)` to fade). A paused voice resumes 5 ms past the pause point (owner review 6). Seek isn't public API yet (owner review 21); the Tape script reaches it directly.
- **Code:** `native/audio/crates/audio-core/src/voices.rs` (`set_paused`, `seek`, `stop`), `src/plugins/audio/runtime/AudioSource.ts`, `coreBackend.ts`.

### L11. The master limiter: look-ahead 0, 1.5 and 5 ms (Configs A, B, C; 4 min across the three)

- **Do:** in each configuration press 8 (eight near-full-scale tones at once, about 18 dB over full scale), three times. Speakers are fine for this item; keep the level moderate.
- **Listen for:** harsh clipping or crackle while the chord holds; the onset; any pumping or slow recovery afterwards (Music should be at its normal level within about a quarter of a second after the chord ends).
- **Pass:** at 1.5 ms (A, default) and 5 ms (C) the chord is loud and clean from its first moment; at 0 ms (B) the same, except that a short crunch at the onset is **accepted** (the instant limiter shapes the first over-the-ceiling half-cycle, which is why the look-ahead exists). No pumping at any setting.
- **Accepted:** the Master bus meter (Audio Debug, Project Settings) reads well over 0 dB during this item: bus meters are before the limiter, which runs on the output.
- **Code:** `native/audio/crates/audio-dsp/src/limiter.rs`; `bus::mixdown` in `native/audio/crates/audio-core/src/bus.rs`; `audio.limiterLookaheadMs`.

### L12. Gapless loops (Config A, 4 min; flappy optional)

- **Do:** press G and listen to at least five repeats of each format (the console logs which one is playing): WAV, FLAC, Ogg Vorbis, MP3 with a LAME tag. The file is one second of steady tones with whole cycles and no fades, so any gap or click shows at each second.
- **Listen for:** a tick, gap, dropout or level dip once a second.
- **Pass:** all four loop seamlessly and sound the same (the lossy formats are perceptually identical at this content).
- **Known exception (not a fail):** flappy's music (`samples/flappy/music/town.mp3`, `foo.mp3`) has no LAME/Info tag, so its loop keeps about 54 ms of near-silence at the seam (owner review 25). Optional check: open `?sample=flappy`, Play, and listen at about 1:22, where `town.mp3` wraps. Re-encoding the sample's music with LAME removes it.
- **Code:** `native/audio/crates/audio-decode/` (trimming), `src/plugins/audio/runtime/decoder/`, `src/plugins/audio/runtime/core/clipRegistry.ts`.

### L13. Streaming under a main-thread stall (Config A, 2 min)

- **Do:** T (start the Tape, which streams), then I (a 300 ms stall: the game view freezes); then K (800 ms). Let the Music and Emitter play too.
- **Listen for:** a gap, glitch or repeat in the melody, the Music or the hum during or after the freeze.
- **Pass:** audio continues unbroken through both stalls; afterwards Audio Debug shows `streamStarves` 0 and underruns 0. (The decoder worker feeds the worklet directly, so the main thread isn't in the streaming path.)
- **Code:** `native/audio/crates/audio-core/src/stream.rs`, `src/plugins/audio/runtime/core/streams.ts`, `src/plugins/audio/runtime/decoder/streams.ts`.

### L14. Background: mute, pause, play (Configs A, B, C; 4 min across the three)

- **Do:** with Music playing and the Tape started (T), switch to another browser tab for about 3 s and back. Note which note the Tape is on when you leave and return.
- **Listen for:** **A (`mute`):** a quick fade out (50 ms) when hidden, a smooth return; the voices kept time while silent, so the Tape comes back further on. **B (`pause`):** a quick fade (30 ms), then silence; on return the Tape resumes on the note it left. **C (`play`):** sound continues while hidden.
- **Pass:** each mode behaves as described, with no click at either transition.
- **Code:** `src/plugins/audio/runtime/core/background.ts`, `audio.background`.

### L15. Device change (if possible; Config A, 3 min)

- **Do:** with Music and the Tape playing, plug in or unplug headphones, or change the system's default output device. If the OS allows it, also change the output device's sample rate between 44.1 and 48 kHz.
- **Listen for:** audio moving to the new device, and how long it is silent.
- **Pass:** sound continues on the new device within about 2 s, at the right pitch and level, without a stuck tone or noise. A rate change rebuilds into a new context (measured 0.6–0.9 s of silence); `rebuilds` in Audio Debug's core section counts it. If the browser itself doesn't follow the default device, note it: that's the browser, not the core.
- **Code:** `src/plugins/audio/runtime/core/deviceChange.ts`, `context.ts` (`_replaceContext`), `recovery.ts`.

### L16. The rebuild after a trap (Config A, 2 min; dev server only)

- **Special setup:** a real trap needs the test-hooks wasm (`myco_audio_debug_trap_next`), which only the loopback tests load. In the browser, the same rebuild runs from the devtools console of the **dev server** page (`npm run dev`; a production build has no `/src/` modules). With Music, the Emitter and the Tape playing:
  ```js
  await (await import("/src/plugins/audio/runtime/core/recovery.ts")).rebuild("trap")    // same context, new core
  await (await import("/src/plugins/audio/runtime/core/recovery.ts")).rebuild("device")  // new AudioContext
  ```
  Each returns `"rebuilt"`. Don't run more than three in a minute: the fourth is refused by design and leaves audio silent with one warning until you reload.
- **Listen for:** the length of the gap and how sound returns.
- **Pass:** a short gap (about 0.35 s for "trap", up to about 0.9 s for "device"), then every voice back at the same level and about where it would have been (the Tape on the expected note), with no burst, click or doubled sound. `recoveries` and `rebuilds` in Audio Debug's core section count them.
- **Code:** `src/plugins/audio/runtime/core/recovery.ts`, `replay.ts`, `context.ts` (`_replaceCore`, `_replaceContext`).

## Accepted behaviours (not fails)

- Aliasing of bright content at pitch-ups of about 1.5× and more (L6; owner, 2026-11-10; #110).
- Flappy's MP3 music keeps about 54 ms of near-silence at its loop seam (L12; owner review 25).
- `stop()` with no fade cuts at once (L10); a paused voice resumes 5 ms past the pause point (owner review 6).
- The 0 ms limiter shapes the first half-cycle over the ceiling (L11); bus meters are before the limiter.
- The Babylon fallback has no bus effects, no stereo pan, and streamed clips there have no pitch and play flat (`docs/guide/audio-mixer.md`, Limits).
- Plays refused under a full bus when every candidate outranks them (L9).

## Sign-off

| Field | Value |
|---|---|
| Date | |
| Build (commit) | |
| Machine and OS | |
| Browser and version | |
| Output device and sample rate | |
| Headphones (model) | |
| Speakers (if used) | |
| Signed by | |

| Item | A | B | C | D | Result | Notes |
|---|---|---|---|---|---|---|
| L1 Baseline | ✓ | | | | | |
| L2 Effects | ✓ | | | | | |
| L3 Snapshot and sweep | ✓ | | | | | |
| L4 Ducking | ✓ | | | | | |
| L5 Presets | ✓ | ✓ | ✓ | | | |
| L6 Resampler | ✓ | | | | | |
| L7 HRTF and equal-power | ✓ | | ✓ | opt. | | |
| L8 HRTF crossfade | | ✓ | | | | |
| L9 Voice load | ✓ | ✓ | | | | |
| L10 Pause, seek, stop | ✓ | | | | | |
| L11 Limiter | ✓ | ✓ | ✓ | | | |
| L12 Gapless loops | ✓ | | | | | |
| L13 Streaming stall | ✓ | | | | | |
| L14 Background | ✓ | ✓ | ✓ | | | |
| L15 Device change | ✓ | | | | | |
| L16 Rebuild | ✓ | | | | | |

Overall: **pass** / **pass with notes** / **fail** (circle one). Issues opened:
