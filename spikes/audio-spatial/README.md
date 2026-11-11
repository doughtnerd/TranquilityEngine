# Audio M3 (spatial) spikes

Step 2 of the M3 design pipeline: the survey and the measurements the decision record (0162) and the technical design will cite. The goal and constraints are in [docs/design/0162-audio-spatial/goal.md](../../docs/design/0162-audio-spatial/goal.md) (owner-confirmed 2026-11-11). Each sub-spike has its own README with method, raw tables and an unverified list; this file collects the answers.

**How the numbers were taken.** Timed runs by the coordinator on 2026-11-11 with nothing else running (load ≈ 1.0, the benchmark's own thread; `timed-runs.log` records the load before and after each stage), on this session's container: a shared 4-vCPU Intel Xeon VM. ≥ 7 runs each (bed 7 × 6,000 quanta; convolution 7 × 20,000 quanta; occlusion 5 × 600 frames). Cells give the median over runs of each run's p50 / p99 / p99.9; "max" is the worst single quantum or frame of any run. A quantum is 128 frames at 48 kHz = **2,667 µs**.

**What these numbers are not.** This container is not the lab VM the 0157 budgets were set on, nor the reference machine (assumed 2× the lab VM, provisional), nor the low-end phone. **p50 and p99 are solid here; p99.9 and max are not:** every spike, native code included (no garbage collector), shows single quanta of 1–30 ms that track the VM's scheduling rather than the code. The design uses p50 and p99 with headroom, and the tails wait for a lab-VM run (the owner's, as for M2) and the phone (unverified for now, owner).

## Answers

| Question | Answer | Source |
|---|---|---|
| Is a 3rd-order ambisonic bed cheap enough for distant voices? | **Yes.** Encoding costs 0.4–0.7 µs per voice against ≈ 11–13 µs per voice for M1's per-voice HRTF. 256 voices + decode: 108 µs native, 142 µs Node wasm, 175 µs Chromium worklet at p50 (p99 144 / 262 / 330 µs). The binaural decode alone: ≈ 20 µs. Output is bit-identical across native, Node wasm and Chromium. | [bed](bed/README.md), `bed/results/` |
| Which decode? | **MagLS** (least-squares below 1.5 kHz, magnitude-only above) on M1's HRIR set: interaural cues point the right way at 12/12 test azimuths, level within 1.7 dB of M1's per-voice HRTF below 2 kHz. Plain least-squares and virtual loudspeakers lose 5–12 dB at the near ear above 2 kHz. | bed |
| Can M1's HRIR data feed it? | Yes (IRCAM Listen IRC_Composite_C, 245,776 B, public, any use), but it has **no data below −45° elevation**: below the listener the decode's timing cue collapses toward 0 and levels are off 8–20 dB above 4 kHz. A design choice (better data, mirroring, or accept). | bed; [research](research/README.md) §6 |
| Ambisonic clips? | Rotation + decode of a 3rd-order clip ≈ 23 µs, first-order ≈ 7 µs (p50). **But:** symphonia reads 4- and 16-channel WAV (channels in file order) and has **no Opus decoder** (its Ogg parser also rejects ambisonic mapping families); **M1's clip arena refuses clips with more than 2 channels.** So M3 clips are WAV/FLAC, and the arena must grow. | bed `clips/` |
| Doppler? | Effectively free: 256 voices with per-sample Doppler pitch vs constant pitch, p50 292.7 vs 283.0 µs native, 347.6 vs 348.1 µs wasm. M1's 4-point Lagrange resampler suffices (band-limited resampling, #110, stays open). Correctness: FFT peak within 0.42 bin of the expected shift. | bed |
| Panner switch HRTF → bed? | 16 voices crossfading cost 208 / 242 µs (native / wasm) for that quantum (both paths run). The level dips 1–4 dB for one quantum (the bed has no history for the entering voice; MagLS doesn't match phase above 1.5 kHz). **Not yet listened to.** | bed |
| Reverb zones on M1's convolver? | **Yes; M1's staged convolver is already non-uniform** (128-frame head, 2,048-frame tail over 16 quanta): no new algorithm. One stereo 2 s zone: 20 µs p50, 72 µs p99 (wasm); 4 s: 30 / 76 µs. Cost is linear in zones: 8 × 2 s ≈ 263 µs p50, 494 µs p99 (staggered). | [convolution](convolution/README.md), `convolution/results/` |
| "Extra convolvers never share a tail quantum" (architecture §10)? | **Holds only up to 4 stereo zones**, and is the wrong objective: balancing modelled load (`plan_stagger`) lowers p99 by ≈ 25–35%; keeping tail transforms apart can make the peak worse. | convolution |
| Zone blending and switching? | Two-zone equal-power blend: 40–68 µs p50 (2–4 s IRs), no discontinuity (max step 1.0× the pure zones'). **Preparing an IR takes 1.3 / 2.5 / 5.3 ms (1 / 2 / 4 s) at once: never on the audio thread.** Spread over quanta: +23 µs/quantum for 0.47 s or +84 µs for 0.12 s (2 s IR); off-thread preparation untested. | convolution |
| Event effects (deferred from 0158)? | ≈ **0.85 µs per instance** for an instance filter (4 voices), constant in instance count; a send adds ≈ 0.01 µs, per-quantum coefficient recompute ≈ 0.05 µs. 16 instances ≈ 15 µs. | convolution |
| Occlusion rays through the engine's physics? | `Physics.raycast` (first hit only; a layer mask filter, free) costs **3.1–3.7 µs per ray**, ≈ 300 rays/ms (main thread, Node). Every source every frame is too expensive (1,024 sources × 1 ray ≈ 3.5 ms p50). | [occlusion](occlusion/README.md), `occlusion/results.log` |
| A frame-share scheme? | **0.25 ms/frame (≈ 64–70 rays)**: a tier of the 16 most audible sources recast every frame, round-robin for the rest; every source refreshed within 3 frames (64 sources), 5 (256), 22 (1,024; worst 26); moving sources ≈ 1% wrong at 256 and 4.5% at 1,024. 0.5 ms as "high" (1,024 sources refreshed in 8 frames, 2.2% wrong). Recasting only the top N leaves 41–73% wrong: round-robin is required. Extra rays per source only for the top few. Smoothing and the transmission lookup: ≈ 60–75 ns per source. | occlusion |
| Libraries to depend on? | **None.** Own encoder/decoder (SAF core ISC and Resonance Apache-2.0 as references; libspatialaudio LGPL and IEM GPL reference-only); Steam Audio (Apache-2.0) as a later layer for frequency-dependent transmission. | research |

## Performance targets (proposed, for the record; container p50/p99, est. for the reference machine)

**Audio thread, per quantum (high preset).** 0157's budget left ≈ 0.11 ms of the 0.5 ms reserve after M1 (design README); M2's automation took ≈ 0.03 ms (0158 estimate; 39–56 µs p99.9 on this container, lab-VM run pending). The owner chose option (c): M3 gets its own budget **and** makes room by mixing fewer per-voice HRTF voices.

| Item | Measured (wasm p50 / p99) | Proposed M3 allowance (est.) | Note |
|---|---|---|---|
| Bed decode (once) | 20 / 33 µs | | fixed |
| Bed encode, 240 voices | ≈ 0.5 µs/voice → ≈ 120 µs (from bed256 142 / 262 µs incl. decode) | | grows with voices in the bed |
| Ambisonic clip, 3rd order (×1) | 23 / 37 µs | | per clip |
| Reverb zones: 2 × 2 s, blending | 47 / 107 µs | | per extra zone ≈ +25 µs p50 |
| Event effects, 16 instances | ≈ 15 µs | | |
| Doppler | ≈ 0 | | |
| **Subtotal (typical scene)** | **≈ 225 / ≈ 440 µs** | **0.30 ms** | |
| Room made: HRTF voices 16 → 8 | saves ≈ 8 × (13.4 − 1.7) ≈ 94 µs (hrtf16 214 vs bed16 28 µs) | **−0.09 ms** | owner option (c) |
| **Net new on the audio thread** | | **≈ 0.21 ms (est.)** | over 0157's remaining reserve: the high preset's total rises; the record states the new total |

Headroom: the 0157 rule is ≥ 50% headroom on the reference machine; with the reference assumed 2× this container's speed (est.), the typical M3 scene's p99 (≈ 0.44 ms here) is ≈ 0.22 ms there. The tails need the lab VM.

**Main thread, per frame.**

| Item | Measured | Proposed | Note |
|---|---|---|---|
| Occlusion rays | ≈ 300 rays/ms | **0.25 ms** default, 0.5 ms "high" | frame p50 tracks the budget (≈ 260 µs at 0.25 ms); p99 0.3–0.9 ms here (VM jitter and per-hit allocation: unverified) |
| Occlusion bookkeeping (rank, smooth, transmission) | ≈ 60–75 ns/source | inside the above | |

**Memory and size.**

| Item | Measured |
|---|---|
| Reverb zone memory | 1.7 / 3.1 / 6.1 MB per stereo zone (1 / 2 / 4 s IR): the dominant M3 cost, and the phone's concern |
| Bed decoder data | 64 KB (complex spectra; 32 KB as time responses); HRIR shared with M1 (246 KB) |
| Bed state | 8 KB bed + ≈ 120 B per voice; decoder history 40 KB |
| Wasm | bed runtime build 115 KB (not the increment over M1's mixer: unmeasured); convolver + spread preparation +27 KB over an empty probe; `wasm-opt` not installed (numbers before optimisation) |

## Still unverified

- **Every p99.9 and max** (container jitter); the lab VM and the reference machine; the low-end phone (owner: unverified for now); WebKit and Firefox (not run; no Docker here).
- The HRTF → bed crossfade dip and the below-horizon decode, by ear (the owner's listening pass).
- The bed inside `audio-core` (the spike skips the mixer's resample and pan stage); the bed's wasm increment over M1's mixer.
- Off-thread IR preparation; pre-rolling a new zone's input history; event-effect coefficient smoothing.
- Occlusion inside the real audio system (`audioSystem.ts`/selection), dynamic and trimesh occluders, wall thickness in multi-wall transmission, GC from per-hit allocation.
- Whether 4- and 16-channel WAVs pass `audio-decode`'s C ABI; Opus ambisonics (no decoder).
- Research items behind blocked hosts (Steam Audio docs, SADIE II and OpenAIR pages, RFC 8486): listed in `research/README.md`.
- The convolution spike's Chromium main-thread run was stopped (owner): it would duplicate Node wasm (same V8, main thread, not the worklet); the bed spike measured the Chromium worklet.
