# Audio M3 bed spike (throwaway)

Measurement spike for the M3 design (`docs/design/0162-audio-spatial/`), written against the real
`audio-dsp` crate by path. Nothing here ships. Everything is in this folder; nothing outside it was changed.

**Question.** What does a shared 3rd-order ambisonic bed cost per 128-frame quantum (encode N voices, decode once
through M1's HRIR set and microfft), what do ambisonic clips, Doppler and a panner-kind crossfade add, and how closely
does the bed's binaural output match M1's per-voice HRTF? Plus two inputs the coordinator asked for: how to handle
the HRIR grid having nothing below -45 degrees, and whether M1's decoder stack reads ambisonic clips.

**Smoke timings only.** Every timing table below was produced here on a shared VM while another process
(`spike bench`, not ours) was spinning a core, with the minimum run shape (5 x 2,000 quanta). They show the runner
works and the order of magnitude; they are **not** the numbers to design from. The coordinator does the timed runs.
Correctness numbers are deterministic and are final.

## What was built

| Piece | File | Notes |
|---|---|---|
| 3rd-order encode, ACN/SN3D, 16 ch | `src/sh.rs`, `src/encoder.rs` | Per-voice per-quantum SH from the unit vector (polynomials, no trig), then one pass `bed[c][i] += x[i]*a_c + x[i]*(i+1)/128*s_c`: a per-channel linear coefficient ramp from `g0*SH0` to `g1*SH1`. SH0 = the previous quantum's SH (direction interpolated across the quantum) or the new SH (direction held, gain still ramps). Both cost the same |
| Binaural decode | `src/decoder.rs` | Built **both**: (a) **virtual loudspeakers**, Lebedev-26 (a 7-design, verified exact), a 16x26 gain matrix and 26 feeds each convolved with the HRIR pair of its direction (ITD re-inserted); (b) **SH-domain**, 16 filter pairs (`ShQuad` = the speaker decode folded into 16 filters, identical to (a) to 3e-7; `ShLs` = weighted ridge least squares over the whole measured grid; `ShMagLs` = LS below 1.5 kHz and magnitude-LS above). **The bed cases use `ShMagLs`.** All use M1's 256-point real FFT (`audio_dsp::hrtf::fft`, microfft underneath) and uniform 128-frame partitions, 2 partitions per filter (256 taps) like the HRTF panner at 48 kHz |
| Ambisonic clip rotate + decode | `src/sh.rs` (`RotBuilder`, `apply_rot_ramp`), `src/cases.rs` (`ClipCase`) | FOA (4 ch) and 3rd order (16 ch). The rotation matrix is built per quantum from nine fixed sample directions and precomputed pseudo-inverses (no trig, no solve), applied block-diagonally (1+9+25+49 products a frame) with a per-sample ramp from the previous matrix. Either summed into the bed (`_rot`: rotate and add) or decoded directly (`_dec`: rotate and decode only the active 4 or 16 channels) |
| Doppler | `src/cases.rs` (`DopplerCase`) | M1's `resample::lagrange` with a per-sample `steps` array from `ramp::Ramp::fill`. Three modes on 256 voices: `const` (rate 1.0 through the same ramp fill and resampler), `pitch` (the quantum's rate is given, as if main sent it: ramp fill only), `full` (the core derives it: integrate position, distance, radial velocity, rate `c/(c+vr)` clamped 0.5..2, ramp) |
| Kind 1 to kind 2 crossfade | `src/cases.rs` (`XfadeCase`) | 16 moving voices on M1's real `HrtfPannerN<2>` (with the core's kernel budget of 2 per quantum via `kernels_needed`/`pan_held`) ramping out while the bed encode ramps in. `hrtf16` (kind 1 only) and `bed16` (kind 2 only) bracket it |
| Runner | `run.mjs`, `worklet/` | native binary, Node wasm, Chromium AudioWorklet (see below) |
| Correctness | `src/bin/check.rs` | prints every number in this README |
| Ambisonic clip decode probe | `clips/` | `gen.py` writes WAV and Opus test files, `probe/` decodes them with M1's symphonia |

Content is real-looking: every voice has its own note (4 decaying harmonics, tremolo, noise floor, from its own seed)
in its own 8,192-frame (bed) or 32,768-frame (Doppler) buffer, 32 MB for 1,024 bed voices; clips are 4 s per channel
of distinct notes. Voices move (every voice's direction changes every quantum, gains random-walk) so the
coefficient ramps are always live.

## How to run (one command each)

```
cd spikes/audio-spatial/bed
node run.mjs                                   # build, then native + Node wasm + Chromium AudioWorklet, all 16 cases
node run.mjs --runs 7 --quanta 6000 --warm 500 # suggested for the coordinator's timed run on an idle machine
node run.mjs --targets native --cases bed256   # one target, some cases
cargo run --release --offline --bin check      # all correctness numbers (3 s)
(cd clips && python3 gen.py && cd probe && cargo run --release --offline -- ../out/*)   # symphonia probe
```

`run.mjs` builds with `cargo build --release` (native) and `RUSTFLAGS="-C target-feature=+simd128" cargo build --release
--target wasm32-unknown-unknown` (the flags the core's wasm uses), then per case does **>= 5 runs** (default 5) of
**>= 2,000 timed quanta** (default 2,000, after 300 untimed warm-up quanta, with the state reset at the start of each
run) and writes `results/results.json` (every run) and `results/results.md`. Percentiles are nearest-rank per run;
the tables take the **median over runs of each run's p50, p99 and p99.9, and the worst run's max**. Quantum = 2,666.7 us.

- **Native**: `Instant` around each quantum (timer cost 0.03 us).
- **Node wasm**: `performance.now()` around each `case_quantum()` call (0.15 us timer cost).
- **Chromium (153, Playwright, `/opt/pw-browsers/chromium`, headless)**: an `OfflineAudioContext` with an
  `AudioWorkletNode`; one `process()` call is one quantum of the case, running the same wasm. `AudioWorkletGlobalScope`
  has **no `performance`**, so time comes from a spinning worker writing `performance.now()` into a
  `SharedArrayBuffer` (the page is served cross-origin isolated). Consequences: the clock steps in 5 us (visible in
  the data), the spinner occupies one core, and a case whose quantum costs under 60 us is timed as the **mean of k
  quanta** per sample (k is calibrated in the constructor and stored per entry in the JSON: 8 to 115 for the cheap
  cases), so its p99 and p99.9 are of batch means and understate the tail. The cases with a k of 1 are real
  per-quantum timings quantised to 5 us.
- **Checksums**: after 50 quanta every case's output checksum is **bit-identical in native, Node wasm and Chromium**
  for all 16 cases (listed at the end of `results/results.md`), so the three targets run the same arithmetic.

## Results: smoke timings (marked: not for design decisions)

us per quantum, (% of the 2,667 us quantum). Median of 5 runs x 2,000 quanta. Full p50/p99/p99.9/max tables per target
are in `results/results.md`; every run is in `results/results.json`.

SMOKE:

| case | native p50 | native p99.9 | Node wasm p50 | Node wasm p99.9 | Chromium worklet p50 | Chromium worklet p99.9 |
|---|---|---|---|---|---|---|
| bed64 | 45.1 (1.7%) | 107.3 (4.0%) | 53.3 (2.0%) | 105.1 (3.9%) | 60.0 (2.3%) | 265.0 (9.9%) |
| bed256 | 120.9 (4.5%) | 320.4 (12.0%) | 154.2 (5.8%) | 426.0 (16.0%) | 165.0 (6.2%) | 380.0 (14.2%) |
| bed1024 | 449.1 (16.8%) | 991.7 (37.2%) | 675.7 (25.3%) | 1436.6 (53.9%) | 750.0 (28.1%) | 2830.0 (106.1%) |
| bed256_spk | 142.3 (5.3%) | 252.2 (9.5%) | 176.9 (6.6%) | 439.4 (16.5%) | 195.0 (7.3%) | 540.0 (20.3%) |
| decode_sh | 22.4 (0.8%) | 48.2 (1.8%) | 21.9 (0.8%) | 104.8 (3.9%) | 20.7 (0.8%) | 36.8 (1.4%) |
| decode_spk | 39.1 (1.5%) | 103.3 (3.9%) | 41.7 (1.6%) | 111.6 (4.2%) | 40.0 (1.5%) | 80.0 (3.0%) |
| clip_foa_rot | 0.88 (0.03%) | 13.0 (0.5%) | 1.19 (0.04%) | 16.4 (0.6%) | 1.17 (0.04%) | 4.57 (0.17%) |
| clip_foa_dec | 7.56 (0.28%) | 40.6 (1.5%) | 8.13 (0.30%) | 46.7 (1.8%) | 7.30 (0.27%) | 20.1 (0.8%) |
| clip_o3_rot | 5.92 (0.22%) | 39.2 (1.5%) | 4.74 (0.18%) | 49.9 (1.9%) | 4.92 (0.18%) | 7.71 (0.29%) |
| clip_o3_dec | 25.7 (1.0%) | 87.4 (3.3%) | 26.2 (1.0%) | 56.9 (2.1%) | 23.9 (0.9%) | 50.4 (1.9%) |
| dop256_const | 301.9 (11.3%) | 792.3 (29.7%) | 383.6 (14.4%) | 773.1 (29.0%) | 370.0 (13.9%) | 595.0 (22.3%) |
| dop256_pitch | 318.5 (11.9%) | 582.0 (21.8%) | 373.0 (14.0%) | 555.4 (20.8%) | 380.0 (14.2%) | 900.0 (33.8%) |
| dop256_full | 325.4 (12.2%) | 814.6 (30.5%) | 376.6 (14.1%) | 948.3 (35.6%) | 385.0 (14.4%) | 1385.0 (51.9%) |
| hrtf16 | 189.2 (7.1%) | 258.9 (9.7%) | 236.7 (8.9%) | 721.4 (27.1%) | 220.0 (8.3%) | 745.0 (27.9%) |
| bed16 | 27.0 (1.0%) | 45.2 (1.7%) | 50.5 (1.9%) | 102.3 (3.8%) | 29.6 (1.1%) | 76.7 (2.9%) |
| xfade16 | 222.6 (8.3%) | 454.0 (17.0%) | 265.2 (9.9%) | 683.9 (25.6%) | 250.0 (9.4%) | 1385.0 (51.9%) |

What the smoke numbers say, with the caveat above (the p99.9 and max columns here are mostly the VM, as in
`architecture.md` §6.1):

- **Encode** is about 0.4 us per voice native and 0.5 to 0.7 us in wasm (`(bed256 - decode_sh) / 256` and
  `(bed1024 - decode_sh) / 1024`): 6 to 9% of M1's 7 us per HRTF voice (and under 1/5 of a 3.4 us mixed voice).
  It is linear in voices; the decode is a fixed ~22 us.
- **Decode alone**: SH-domain 22 us (16 FFTs, 16x2x2 complex MACs of 128 bins, 2 inverse FFTs); the 26-speaker form
  39 us (a 26x16x128 gain matrix, 26 FFTs, 26x2x2 MACs): the SH fold is ~1.8x cheaper for identical output.
- **Break-even against per-voice HRTF**: decode (22 us) plus encode is below `N x 7 us` from the fourth voice up.
  1,024 bed voices at 0.45 ms native / 0.68 ms wasm in Node is 17 to 25% of the quantum at p50.
- **Ambisonic clips** are cheap: FOA rotation 1 us, with direct decode 8 us; 3rd-order rotation 5 us, with direct
  decode 26 us (about 3 us above the shared decode alone, and a clip rotated into the bed costs only its rotation).
- **Doppler** on 256 voices: native 302 us constant rate, 318 us with the rate given (+5%, +0.06 us per voice), 325 us
  with the core deriving it from motion (+8%, +0.09 us per voice). In wasm the three are within the noise of each
  other (373 to 384 us). The resampler itself is 1.2 to 1.5 us per voice here; the extra Doppler cost is the ramp
  fill and (in `full`) one sqrt and a division per voice.
- **Crossfade**: 16 voices in their crossfade quantum cost 223 us native (HRTF 189 + bed encode and decode ~34),
  against 189 for kind 1 alone and 27 for kind 2 alone; so the transition quantum costs ~18% more than the kind-1
  voices it replaces, and the bed-only steady state is ~7x cheaper than kind 1 for 16 voices.

**Sizes** (release, `+simd128`, no `wasm-opt` on this machine, so none was run; `wasm-opt -O3` would shrink these):

| Item | Bytes |
|---|---|
| Whole spike wasm (`bedspike.wasm`): encode, decode, rotation, filter design (LS, MagLS), M1's HRTF panner, resampler and FFT, content generators, all cases | 198,031 |
| Runtime-only wasm (`--features min`, `src/wasm_min.rs`): encode, SH decode, rotation, filters loaded as data, 16 voice buffers' generator, std allocator and panic code | 115,345 |
| Decoder data, SH-MagLS (16 ch x 2 ears x 2 partitions x 128 bins, complex f32) | 65,536 (`target/filters_sh_magls.bin` from `dumpfilters`); 32,768 as 256-tap f32 time responses; int16 not tried |
| Decoder data, 26 speakers (spectra plus the 16x26 gain matrix) | 108,160 |
| HRIR asset the decoder is built from (shared with kind 1; M1's `myco_hrir.bin`) | 245,776 |
| Decoder state per decoder (SH): history 16 ch x 2 partitions x 128 bins x 8 B + previous blocks | 40,960 (speakers: 66,560) |
| The bed | 8,192 |

The 115 KB runtime number is not the increment over M1's 178 KB mixer: the FFT, the allocator and the panic
machinery are already in the mixer. The increment was **not** measured (it needs the code inside `audio-wasm`).
The filter design (a few ms for LS, 2 s for MagLS in Node wasm's `init_shared`, which builds four filter sets)
belongs in a tool, not the worklet.

## Correctness (`results/check.txt`; all pass)

**Encoder energy.** The sum of squared SN3D gains is 4.0000 (one per order 0..3) for 200,000 random directions:
min 3.9999972, max 4.0000027 (f32 rounding). Per order: 1.000000 each. The Lebedev-26 quadrature integrates every
(2l+1) Y_a Y_b product exactly (max error 9e-16).

**Rotation.** Rotate by random yaw/pitch/roll and then by the inverse, 200 trials x 16 ch x 128 frames of noise:
**max error 1.2e-6** (limit 1e-5); the yaw +90 degree and back case is trial 0. `Y(Rd) = M Y(d)`: max error 5.5e-7.
Yaw +90 turns an encoded front source into an encoded left source (max diff 6e-8). The ramped rotation lands on the
new matrix (1.8e-7). The FOA path equals the first four channels of the 3rd-order path exactly.

**Doppler** (the case's own `rate_from_motion`, ramp and `lagrange`; 1 kHz tone, 16,384-sample Hann FFT, bin 2.93 Hz):

| Source toward listener | Expected | FFT peak | Error |
|---|---|---|---|
| +34.3 m/s | 1111.11 Hz | 1110.35 | 0.26 bin |
| +68.6 m/s | 1250.00 | 1250.98 | 0.33 bin |
| -34.3 m/s | 909.09 | 908.20 | 0.30 bin |
| 0 | 1000.00 | 999.02 | 0.33 bin |
| +10 m/s | 1030.03 | 1031.25 | 0.42 bin |

All within one bin (parabolic interpolation: within 0.1 Hz).

**Encode then decode against M1's per-voice HRTF** (white noise, az/el on the HRIR grid: el 0, 30, -30, 60 at 12
azimuths = 48 directions; 48 blocks of 1,024; M1's `HrtfPannerN<2>` fed the same noise and the same direction):

*Points the right way.* At el 0 for 12 azimuths, the right ear louder and earlier for az > 0 (|ITD| > 150 us at
the sides), balanced at front and back (|ILD| < 3 dB, |ITD| < 120 us): **12/12 for `ShLs` and `ShMagLs`**. The plain
quadrature decode (= the 26 speakers) gets 10/12: at az +-150 its 2-4 kHz ILD has the wrong sign (-0.6 dB against
M1's +4.0), ITD right. That is the reason the speaker layout is not the one to ship as is.

*How close, `ShMagLs` (the default), in dB.* The difference of the interaural level difference (R minus L) and of the
worse ear's level, per octave band:

| Band | mean abs dILD | max abs dILD | mean worst-ear level diff | max worst-ear level diff |
|---|---|---|---|---|
| 200-500 Hz | 0.26 | 1.05 | 0.32 | 0.84 |
| 500-1000 | 0.46 | 1.39 | 0.56 | 1.30 |
| 1-2 kHz | 0.53 | 1.67 | 0.78 | 2.41 |
| 2-4 kHz | 0.90 | 5.45 | 1.18 | 5.36 |
| 4-8 kHz | 1.51 | 8.49 | 1.66 | 8.79 |
| 8-16 kHz | 2.04 | 8.77 | 3.27 | 8.84 |

ITD (group delay of the interaural cross spectrum, 200 to 1,200 Hz): mean difference from M1 19.7 us, max 69.6 us
(43 us at el 0, against a head ITD of up to ~740 us). Stated match: **ILD within 1.7 dB up to 2 kHz over all 48 directions and ITD within 43 us at el 0; per-ear
level within 1.2 dB on average to 4 kHz and 3.3 dB on average to 16 kHz, worst case 9 dB (above 4 kHz)**. Without MagLS (`ShLs`) the same errors are 2.3 / 5.0 / 9.5 dB mean
dILD at 2-4 / 4-8 / 8-16 kHz and 5 / 10 / 12 dB mean level, i.e. an order-3 least-squares decode loses 5 to 12 dB at
the near ear above 2 kHz; **MagLS is what makes the bed match the per-voice HRTF, not an option**. Per direction
(`results/check.txt`): at az 90 the ILD at 2-4 kHz is +11.0 / +11.1 dB (bed / M1) and the ITD -744 / -702 us.

**Direction interpolation across the quantum.** A direction jump from front to left with a constant input: the Y
channel's step at the quantum boundary is 0.0078 with interpolation and 1.0000 without (one sample, a click).

**Panner-kind crossfade** (HRTF to bed over N quanta, linear; table in `results/check.txt` section 6). The
steady-state level after the switch is within 0.2 to 0.7 dB at 440 Hz, 0.4 dB at 4 kHz and 0.8 to 1.4 dB for
white noise (L/R), and there is no click (the largest sample step in the transition is within 1.5x of the kind-1
steps). In the transition quanta the level of the output dips below the kind-1 level: **1 quantum: up to 4.3 dB at
440 Hz; for noise 0.6 to 3.3 dB at every N tested (1, 2, 4, 16)**. Two causes, neither fixed by a longer ramp: the bed
decoder has no history of the entering voice, so its first two quanta build up (the 440 Hz dip falls from 4.3 dB
at N = 1 to 0.8 dB at N = 16); and above 1.5 kHz MagLS matches magnitude but not phase, so HRTF and bed outputs are
partly uncorrelated and a linear (amplitude) crossfade dips (an equal-power law would be the first thing to try;
not tried). Per-quantum RMS of noise also fluctuates by about +-1.5 dB by itself.

## Below the listener: the HRIR grid ends at -45 degrees (coordinator item a)

`myco_hrir.bin` (IRCAM Listen IRC_Composite_C) has 240 directions, elevations -45 to +90 in 15-degree steps, none below.
What the decoders do, and what it does to sources below:

- **M1's per-voice HRTF** clamps the elevation index at the grid (`index_from_elevation_angle`): every elevation below
  -45 reads the -45 responses at the source's azimuth. Spectral elevation cues stop at -45; ITD and ILD stay those of
  -45 (a source at -90 pointing straight down at az 90 would keep a 614 us ITD, which is wrong).
- **Speaker decode** (Lebedev-26): the lower speakers (the nadir, the four at -35 degrees and the four at -45) all read the
  -45 data, by the same clamp. Result: sources below the horizon are badly matched (az 90, el -60: 2-4 kHz ILD -2.7
  dB against +15.9 for M1; the speakers' lobes mix the clamped data).
- **SH LS / MagLS** (built): the measured directions are used as they are, and **three filled rows are added so the
  fit has data over the lower cap**: -60 and -75 degrees at all 24 azimuths and one nadir direction, all reading the -45
  responses (a clamp, i.e. no mirroring and no extrapolation), under a ridge term (lambda = 1% of the mean
  diagonal of Y^T V Y) with area-like weights (cos el, floored at 0.1 so the poles count). Result (`ShMagLs`, bed vs M1, 2-4 kHz
  ILD and ITD): el -30: +17.5 / +14.3 dB and -663 / -690 us; el -45: +14.8 / +15.9 and -586 / -614;
  el -60: +15.3 / +15.9 and -489 / -614; el -75: +8.3 / +15.9 and -290 / -614; straight down: balanced, 0 us.
  The bed's ITD falls toward 0 as the source nears the nadir, which is physically right and **differs from M1's
  clamp** (so a source that moves from kind 1 to kind 2 below -60 degrees changes its ITD by up to 300 us).
  The worse-ear level differences below the horizon are larger than above (to 8 to 20 dB in the 4-16 kHz bands for
  -45 to -75 degrees; table in `results/check.txt`).
- **What is not done**: mirroring the upper hemisphere (does not give correct pinna cues), regularising with a different
  data set (SADIE II covers the full sphere and is the research survey's fallback), or fitting elevation cues
  below -45. The honest limit is: below the listener the bed is as good as the data, i.e. only ITD, ILD and
  coarse spectrum.

## Ambisonic clips in M1's decoder stack (coordinator item b)

Probe: `clips/probe` uses **symphonia =0.6.1 with the same features as `audio-decode`** (`wav pcm flac mp3 ogg vorbis`),
the same decoder crate. Test files from `clips/gen.py` (channel c holds the constant (c+1)/40, so the order shows in
the first frame); `ffmpeg` **is installed** here (libopus included). Output: `clips/probe-output.txt`.

| File | Result | Channel order and labels returned |
|---|---|---|
| WAV 4 ch and 16 ch, PCM16 (format tag 1) | **decodes** | identical to the file's interleaved order (1..N); labelled `Positioned` speaker positions (FL FR FC LFE ...), not ambisonic |
| WAV 4 ch and 16 ch, float32 (tag 3) | **decodes** | same |
| WAVE_FORMAT_EXTENSIBLE, PCM16 and float32, channel mask 0 | **decodes** | same; 4 ch positions FL FR FC LFE |
| WAVE_FORMAT_EXTENSIBLE with the **AMBISONIC_B_FORMAT_PCM** subformat GUID (and its float twin), 4 ch and 16 ch | **decodes** | file order again; labelled `AmbisonicBFormat(W X Y Z)` for 4 ch and `W X Y Z R S T U V K L M N O P Q` (FuMa/Furse-Malham letters) for 16 ch. The labels are names only: **the samples are returned in file order and are not reordered or renormalised**, so ACN/SN3D (AmbiX) in the file arrives as ACN/SN3D |
| Ogg Opus, **mapping family 0** (stereo control) | **recognised** (codec id 0x1001, 48 kHz) but **cannot be decoded**: `unsupported audio codec` | |
| Ogg Opus 4 ch and 16 ch, **mapping family 2** (made two ways: ffmpeg `-mapping_family 2`, which it accepts, and a family-255 stream with the header rewritten to 2) | **the file is not even opened**: `PROBE FAILED: unexpected end of file` | none |
| Ogg Opus 4/16 ch, family 255 | same probe failure | none |
| Ogg Opus family 3 (projection, RFC 8486) | not generated (ffmpeg's libopus wrapper cannot write it; a hand-made header without a real demixing matrix would prove nothing about decoding). By the source below it fails the same way | |

**Why** (`symphonia-common-0.6.1`, `xiph/audio/opus/mod.rs`; `symphonia-format-ogg-0.6.1`): symphonia 0.6.1 has no Opus
codec crate (this repository's feature list has no `opus`, and the registry holds no `symphonia-codec-opus`), so **even
stereo Opus does not decode**. Its Ogg Opus header parser accepts only mapping families 0 and 1 (Vorbis channel
order) and returns `unsupported channel mapping family` for the rest; the Ogg demuxer then finds no mapper and
the probe fails. So ambisonic Opus (families 2 and 3) needs, in addition to the container fix, an Opus decoder
(libopus-class, with the multistream and projection modes; a Rust port or a C build to wasm: a dependency and a new
decision, not tried here).

**Also**: the decoder is not the only limit. M1's clip arena refuses clips with more than 2 channels
(`audio-core/src/clips.rs`: `reserve` returns an error unless `channels` is 1 or 2, and the resampler `Source` is 1 or 2
channels), so 4/16-channel clips need new arena and streaming support whatever decodes them, and
`audio-decode`'s own ABI was not driven here (the probe uses its symphonia directly; `decoder.rs` takes the channel
count from the codec parameters and returns interleaved samples at that count).

## Findings

1. **The bed is cheap to run and the decode is the fixed cost.** Encode ~0.4 to 0.7 us per voice (1/10 of M1's HRTF
   voice); decode 22 us (SH-domain) fixed. 1,024 voices are ~0.45 to 0.75 ms at p50 on this VM (17 to 28% of a quantum),
   against 7 ms for 1,024 HRTF voices. The coordinator's idle-machine run replaces these.
2. **Fold the decode into 16 SH filters.** 26 virtual speakers cost 1.8x the decode for the same output and
   need 108 KB against 65 KB.
3. **Quality needs MagLS, offline.** Plain order-3 LS (and the speaker layout) mismatch M1's per-voice HRTF by 5 to 12 dB
   at the near ear above 2 kHz and can flip the ILD sign at the rear; magnitude-LS brings the mean per-ear level difference to
   1.2 dB (2-4 kHz) and 3.3 dB (8-16 kHz), ITD within ~43 us at el 0. This is filter design, done once in a tool.
4. **Doppler is nearly free** (~+5 to 8% of a resampled voice, in the noise in wasm); the real costs are design ones
   (clamping, smoothing, who computes the rate), not DSP.
5. **A crossfade from kind 1 to the bed costs one quantum of both paths and dips 1 to 4 dB**; use an equal-power law
   and a ramp of several quanta, or pre-roll the bed (not tried).
6. **Ambisonic WAV works today in the decoder; Ogg Opus does not at all**, and the clip arena is mono/stereo only.

## Unverified

- **All timing numbers**: smoke runs on a shared, noisy VM; no idle-machine run, no phone, and no reference-class
  machine. p99.9 and max here are mostly VM noise. Chromium timings use a spinner clock (5 us steps) and batch means
  for the cheap cases.
- The wasm size increment inside `audio-wasm`, and any `wasm-opt` effect (not installed).
- The two M1 interfaces this spike stubs: voices read their samples directly (not through the mixer's resampler
  and pan stage: the bed cases measure encode, not `c_v`), and the Doppler/crossfade cases have no bus, limiter, effects
  or wire traffic. Nothing here ran inside `audio-core`.
- The HRIR set was resampled to 48 kHz by linear interpolation (`hrir.ts` uses Chromium's sinc resampler): the
  ILD/ITD/level numbers are for this table, at 48 kHz only.
- MagLS here is my implementation (10 iterations from the LS phase, cutoff 1.5 kHz, ridge 1%, no time-alignment): filters
  keep their ITD but their time spread is large (6% of the energy of the worst filter lies beyond 256 taps and is
  cut with a 16-tap fade; 3 partitions would keep it, at +50% decode MACs; not tried). Not compared with a published
  implementation (SAF's) nor listened to.
- Elevations off the 15-degree grid, and the quality of the below-listener rows beyond the ILD/ITD/level numbers.
- Whether the audible crossfade dip (1 to 4 dB for one quantum) matters; no listening pass.
- Decoding Ogg Opus family 2/3 at all (no decoder exists in the stack), family 3 files, and 4/16-channel clips through
  `audio-decode`'s C ABI and the arena; FuMa-ordered files (the WAV labels say FuMa letters, the data order is
  whatever the file has).
- Android/WebView, and Chromium on other OSes: one headless Chromium 153 on Linux.
