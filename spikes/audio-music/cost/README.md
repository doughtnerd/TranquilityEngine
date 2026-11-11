# S4: what M4 (interactive music) costs the audio thread

Spike S4 of the M4 design pipeline ([BRIEFS](../BRIEFS.md), [goal](../../../docs/design/0166-audio-music/goal.md)). Build and smoke only: **no timed number here comes from an idle machine**. The coordinator runs `run.mjs` on an idle machine and the timed columns below are then filled from its `summary.md`.

Number labels: **metered** = wasm instructions per quantum from the repo's own metering pass (`tools/audio-bench/meter.mjs`): exact, identical on every machine and load, so these are real results now. **smoke** = a 1-run, 2 s timed run on the shared, loaded VM (other agents compiling): plumbing only, p50 at best. **(est.)** = derived, not measured. **[U]** = unverified.

## What I read

`native/audio/crates/audio-bench/src/lib.rs` (header 1-30; `Scene` 117-215; `scene()` 380 with `m3-worst-high` 445 and `m3-high` 457; `Bench::new` / `configure` / `start` / `build_batch` / `run`), `tools/audio-bench/metered-gate.mjs` (1-14, scene list 48), `meter.mjs`, `audio-core/src/{voices,stream,scheduler,automation,panner}.rs`, `audio-dsp/src/ramp.rs`, `src/plugins/audio/editor/audioSettingsModel.ts:235-237`, ADR 0157/0162 budget lines as quoted in the goal doc.

## Method

`cost/` is a standalone crate (`myco-music-cost-spike`) with path deps on `native/audio/crates/{audio-core,audio-dsp,audio-wire}`; nothing in `native/` is edited. `src/lib.rs` is a **copy** of `audio-bench/src/lib.rs` with additions marked `S4:` (new `Scene` fields `src_rate`, `spatial`, `music_stems`, `music_stingers`, `music_rate`, `music_fades`, `music_ramp`, `splits`, `ref_mixed`; music voices in `start`/`build_batch`; an output-peak/starved sanity line appended to each result, measured outside the timed region). `src/music.rs` holds the music scenes and the microbenchmarks.

**Copy is faithful:** the unmodified `audio-bench` built with the same compiler and metered gives the same instruction counts as my copy (`high` 33,708,068 vs 33,708,069; `streams` 1,495,067 vs 1,495,068; `m3-worst-high` 37,233,650 vs 37,233,651). Both are +1.2..3.7% over `tools/audio-bench/metered/baseline.json` because the committed baseline was built with another rustc (this VM has stable 1.97; the pinned 1.99.1 would not install). Compare my counts with each other, not with the baseline.

**Music voices** (what the scenes put in): stems are stream voices (rings fed 4,096 frames at a time), stereo, 44.1 kHz, **non-spatial** (no `PLAY_FLAGS_SPATIAL`), looping, on bus 3 (a group under bus 0 with the preset's low-pass, high-pass, compressor, snapshot low-pass). Stingers are decoded 2 s clips at 44.1 kHz, looping, non-spatial, same bus. A "fading" voice carries one volume automation binding (curve on a seeking global, ADR 0158 E2, `automation.rs:653`); `music_ramp` also sends a SET_PARAMS gain ramp over the frame to every music voice each batch (what today's bus fades do, `mixer.ts:63,155-210`); `splits` sends a **stamped** SET_PARAMS at sample 64 of a quantum (a sample-accurate fade start).

**Scenes** (all on the bench's high preset, 256 mixed voices, 16 rings; see `music::scene()`; `worst` rides M3's `m3-worst-high` content):

| scene | music in it | rides on |
|---|---|---|
| `mus-typ` | 4 stems, 1 fading | `high` |
| `mus-trans` | 12 stems (2 segments x 6) + 2 stingers, all 14 fading and ramping | `high` |
| `mus-worst` | 16 stems (2 x 8, every ring) + 4 stingers, all 20 fading and ramping | `m3-worst-high` |
| `mus-worst-split` | `mus-worst` + a stamped gain record in **every** quantum | `m3-worst-high` |
| `-base` twins | the same scene minus exactly its music voices (same virtual voices, buses, clip set via `ref_mixed`) | |
| `mus-typ-nofade`, `-fades4`, `-ramp`, `mus-trans-nofade`, `mus-worst-nofade` | decompose voice cost from automation cost | |
| `iso-*` | 16 (or 64) looping voices alone on one bus: decoded vs stream, 48 vs 44.1 kHz, spatial vs not (Q4) | |

**Important shape of the delta:** music displaces nothing but slots. The high preset has 256 mixed voices and **16 stream rings** (`stream.rs:119-120`: `max_mixed/16` clamped 4..16 -> low 4, default 8, high 16). `mus-trans` needs 12 of the 16 rings, `mus-worst` all 16 (leaving none for voice-over or SFX streams), and on low (4 rings) four stems take every ring. The twin has `mixed - music` voices, the scene `mixed`: the delta is the cost of music voices added on top of the same 252/242/236 other voices. If music voices count against the 256 cap instead, the net change is smaller (below).

**Runner:** `node run.mjs` (see Reproduce). It builds native and wasm (+simd128, as `npm run build:audio` does), runs checks, micros (5 runs), scenes (5 runs x 20 s, 2 s warm-up, p50/p99/p99.9/max per run, median over runs), native then wasm with one fresh wasm instance per scene, then the metered wasm (instructions/quantum). The metered pass reuses `tools/audio-bench/meter.mjs` read-only on **my** wasm build (the committed `audio_bench.metered.wasm` only holds the committed scenes).

## Results

### Q1. What music adds per quantum

**Metered (exact, wasm instructions per quantum; same seed, 4 s):**

| scene | twin | music adds | ratio | est. us at the twin's ADR time (est.) |
|---|---:|---:|---:|---:|
| `mus-typ` | 33,408,892 | +451,621 | +1.35% | ~16 (of 1.19 ms) |
| `mus-trans` | 32,738,231 | +988,785 | +3.02% | ~36 |
| `mus-worst` | 35,223,977 | +1,316,037 | +3.74% | ~60 (of ~1.61 ms = 1.19 + M3 worst 0.42) |
| `mus-worst-split` (a stamped record every quantum) | 35,223,977 | +13,235,358 | **+37.6%** | ~600 |
| `mus-typ-nofade` (4 stems, no automation) | | +206,394 | +0.62% | ~7 |
| `mus-typ-fades4` | | +455,468 | +1.36% | ~16 |
| `mus-typ-ramp` (4 stems, SET_PARAMS ramps, no automation) | | +212,803 | +0.64% | ~8 |
| `mus-trans-nofade` | | +707,332 | +2.16% | ~26 |
| `mus-worst-nofade` | | +1,025,282 | +2.91% | ~47 |

(est.) = ratio x the ADR's quoted total; the ratio is exact, the base time is not mine. Instructions are not time (cache and memory effects are not counted [U]).

**Cost model that fits all rows (instructions per quantum):** 51.6k per stem (stream, non-spatial) + 40k per stinger (decoded) + **~245k once if any automation binding is live** + ~2.5k per automated voice. Check: `mus-trans` predicts 979k (measured 989k); `mus-worst` 1,281k (1,316k); `mus-typ` 451k (451k).

**Timed (native and Node wasm), smoke only (loaded VM, 1 run x 2 s; do not use):** the deltas scatter between -2.6% and +7.9% of a quantum because the base moves +-10% between runs (`mus-typ` native d-mean -70 us, wasm +54 us). Only the ordering survived: `mus-worst-split` is +560 us native, +956 us wasm (smoke) against +50..160 us for the others. Timed columns (p50/p99/p99.9/max per scene, deltas against twins) are in `run.mjs`'s `summary.md`: **to be filled from the coordinator's run**.

### Q2. Sample-accurate per-voice gain ramps

*What exists.* A stamped SET_PARAMS/FADE already lands at an exact sample: `voices.rs:297-330` pops each due record, renders every live voice up to its offset, applies it, then renders the rest (`scheduler.rs:35-43`: PLAY is written to its slot at once and starts at its own offset **without** cutting the quantum; STOP, SET_PARAMS, FADE and SET_PAUSED wait in the pending queue and **do** cut it). Shapes are linear only (`ramp.rs`); curves exist only as control-rate automation (`ramp_at`, linear between quanta, `automation.rs:195`).

*Finding 1 (metered, exact): a stamped record splits the quantum for ALL live voices, and that dominates.* `mus-worst-split` adds 13.2M instructions per split quantum (+37.6%, ~52k per voice, about one more voice-read) on top of music's own 1.3M. One split costs about 0.6 ms (est.) on high-worst, on that quantum alone. It lands in p99.9 whenever more than ~0.4 splits per second occur (1 per 1,000 quanta = 0.375/s). Sample-accurate fades must therefore not use stamped records at music rates: carry the start sample inside the voice (a scheduled ramp: start-sample compare in that voice's own `voice_chain` loop), so only the faded voice pays. Stamped PLAY (stem starts, stingers, quantised transitions) is free of this.

*Finding 2 (microbench, smoke, ns per voice per 128-frame quantum, copies subtracted, native p50):* settled gain 24; linear ramp running all quantum 100-140 (the per-sample dependency chain, ~1 ns/sample); linear starting at sample 37 (two ranges) ~100; smoothstep S-curve 220-270; sqrt equal-power law 150-250 (native), table equal-power ~400-500; **libm `sinf` per sample 1.3-1.9 us** (10-15 ns per sample), but 490-540 ns when the curve is built into an array first. So per voice: linear/S-curve/sqrt cost 0.1-0.3 us while fading, 20 voices fading = 2-6 us per quantum; `sinf` per sample would be 26-38 us for 20 voices: use the sqrt law (power-complementary: `g_in^2 + g_out^2 = 1`, error 2.4e-7), the table (error 3.6e-7) or a block curve. wasm columns are in the table but unreliable: `sqrtf` shows 1.9 us in wasm, which looks like libm's software `sqrtf` rather than the `f32.sqrt` instruction [U]; the timed run will confirm. Correctness (`mode=check`, native and wasm both PASS): a ramp starting at sample k holds the old gain exactly for 0..k and moves linearly from k; shapes are complementary as stated.

### Q3. A per-instance music clock

Sketch in `music.rs` (`Clock`): cached tempo segment (steps on when the position crosses its end), beat position at the quantum's end (one f64 multiply-add), boundary armed as an **absolute frame** (integer compare per quantum; the tempo map is consulted only when arming), published (frame, beat) pair. Sample-exact: 107 beats at 120 bpm (24,000 frames/beat) and 116 at 130 bpm (22,153.85) land on `ceil(beat x frames/beat)` with 0 frames error, and 34 beats across a 120 -> 90 bpm change with a 4/4 -> 3/4 metre change (exact because arming goes through the map).

Cost (smoke, p50, ns per quantum for all instances; native / wasm): 1 instance 4.7 / 16, 8 instances 34 / 105-112 whatever the map length (1, 8 or 64 segments, cached); a binary search every quantum instead: 1 instance 8-13 / 26-29, 8 instances 60-99 / 165-209. That is at most 0.2 us of a 2,667 us quantum (0.008%): **negligible; cache the segment and search only on seek**. The clock cannot be the budget problem.

### Q4. Stream voice vs decoded voice; 44.1 kHz

Metered, 16 voices on one bus, 48 vs 44.1 kHz, spatial vs non-spatial, minus the empty scene (48,125):

| voice | instructions / voice / quantum |
|---|---:|
| decoded, 48 kHz | 40,271 |
| decoded, 44.1 kHz | 40,271 (identical) |
| decoded 44.1 kHz, spatial (equal-power) | 40,271 (identical) |
| stream ring, 48 kHz | 50,169 (+25%) |
| stream ring, 44.1 kHz | 50,297 (+0.3% over 48 kHz) |
| decoded, 64 voices | 40,316 (linear; no cache effect in instruction count) |

Findings: (1) **44.1 kHz music costs the same as 48 kHz**: `voices.rs:595-597` runs the 4-point Lagrange for every clip voice at any ratio (a ratio of 1.0 is not special-cased), and a stream reads through the same kernel (`voices.rs:645`). (2) Non-spatial voices cost the same as equal-power spatial ones: both go through `mix_range` -> `mix_dry` (`panner.rs:162-163`); there is nothing to save by marking stems non-spatial, and there is no cheaper stereo path today. (3) A stream voice costs ~25% more than a decoded one (ring wrap, tail, start/starve bookkeeping; `voices.rs:645-760`), plus the copy of each 4,096-frame chunk into the ring. (4) Smoke timings agree in order (native 2.2 us decoded, 2.9 us stream per voice, loaded; wasm ~3.0 us decoded, ~2.4 us stream: noisy). Cache effects of arena reads vs ring reads are not in instruction counts [U]; the timed run's native iso rows measure them.

### Q5. M4 audio-thread allowance (proposal, from the timed run)

Reference machine assumed 2x faster than this container (est.). Measured container cost (max of native d p50 and d mean): typical 63 us, transition 79, worst 99; reference (est.) 32 / 40 / 50 us; allowance = reference x 1.5 or more (>= 50% headroom), rounded up.

| preset | rings | typical scene | typical allowance | worst scene | worst allowance |
|---|---:|---|---:|---|---:|
| high | 16 | 4 stems, 1 fade (ref. est. 32 us) | **0.05 ms** | 16 stems + 4 stingers, all fading (ref. est. 50 us) | **0.08 ms** |
| default | 8 | 4 stems, 1 fade (32 us) | 0.05 ms | 8 stems + 2 stingers (model: ~35 us) | 0.06 ms |
| low | 4 | 4 stems, 1 fade (~28 us, model) | 0.04 ms | 4 stems + 1 stinger (~25 us, model) | 0.04 ms |

Default and low rows come from the cost model (instructions per voice), not runs. Stamped splits are outside the allowance: ~270 us (est., reference) on each split quantum (538 us measured native here); keep them under about 1 per second. Phone cost unverified.

Effect on the high total (ADR 0157: 1.3 ms p99.9; M1 1.19; M3 +0.10 typical / +0.42 worst): typical 1.29 + 0.05 = **1.34 ms (0.04 over)**; worst 1.61 + 0.08 = **1.69 ms**. If music voices count inside the 256 cap, 4 stems displacing 4 average voices (~130k vs 52k instructions each) gives about -1% net (est.), so the overshoot disappears; that, plus reserving rings for music (4 on low is too few), is the recommendation. The owner's own-budget decision is needed only if music is added on top of 256 SFX voices.

## Timed run (coordinator, idle container, RUNS=5, SECONDS=10; `results/2026-11-11T18-15-37-670Z/summary.md`)

Medians over 5 runs of each run's statistic, us per quantum. p99.9 and max are VM tails (idle container, 4 vCPUs, other tenants): not usable as budget numbers. Base scenes run 1.64-1.91 ms p50 here against the ADR's 1.19 ms, so this container is about 1.45x slower than the ADR's reference (ADR 1.19 ms is a p99.9 figure, so the real gap is [U]).

| music scene minus its twin | native d p50 | native d p99 | native d mean | wasm d p50 | wasm d p99 | wasm d mean | metered est. on this container's base (us) |
|---|---:|---:|---:|---:|---:|---:|---:|
| `mus-typ` | 43 | 174 | 63 | 39 | -7 | 31 | 23 |
| `mus-trans` | 75 | 145 | 79 | 68 | 141 | 36 | 52 |
| `mus-worst` | 99 | 29 | 91 | 96 | 39 | 92 | 74 |
| `mus-worst-split` | 538 | 1,119 | 570 | 810 | 1,117 | 813 | 741 |
| `mus-typ-nofade` | 53 | -137 | 29 | 39 | 537 | 151 | 11 |
| `mus-typ-ramp` | 12 | 113 | 17 | 9 | 210 | 56 | 11 |

**Measured vs the metered-model estimate.** My first est. column (16/36/60/600 us) used the ADR's 1.19 ms as the base; the container's own base is 1.73/1.71/1.97 ms, so the same ratios give 23/52/74/741 us (last column). Against that, native p50 deltas are 1.9x (typical), 1.4x (transition), 1.3x (worst) and 0.73x (split). The gap that remains in the typical row is mostly noise: `mus-typ-nofade` (+206k instructions) measures +53 us p50 while `mus-typ-ramp` (+213k, the same instructions) measures +12 us, and the wasm typical-nofade mean is +151 us against typical +31, so a 10 s run resolves a delta only to about +-30 us. What is real: (1) instructions are not time: stems read 32,768-frame rings and clips from cold arena memory, and cache misses are not in the count; (2) the split quantum is cheaper per instruction than average (SIMD-heavy, warm) so it comes in below the estimate. The bench's 32 HRTF voices do not explain it: HRTF changes the base, not the absolute cost of a non-spatial stem (iso-clip 2.3 us native per voice either way); with the editor's 8 HRTF voices the base is lower and music's share of the total is higher, its microseconds the same. The Q4 iso rows confirm per-voice cost: decoded 2.27-2.30 us native (3.0-3.2 us wasm), stream 2.86-2.91 us native (2.46 us wasm); 44.1 kHz = 48 kHz and non-spatial = spatial in time too. Stream vs decoded flips in wasm (stream cheaper), unexplained [U]; the instruction counts say stream +25%.

**sqrt in wasm.** Timed micro (ns per voice per quantum, full ramp, per-sample): sqrt native 241, wasm 1,080 (4.5x); sinf native 1,826, wasm 861; smoothstep native 288, wasm 446; table native 534, wasm 683. `libm::sqrtf` is slow in wasm (no `f32.sqrt` instruction in the no_std build [U]) and `sinf` is slower native than wasm. So the sqrt law, the best native choice, is the worst wasm choice. Fade-law choice: do not use `libm::sqrtf` or `sinf` per sample. Use an S-curve polynomial (0.29 native / 0.45 us wasm per fading voice; amplitude-complementary, not power-complementary) or a 1,024-point equal-power table (0.53 / 0.68 us; power-complementary, error 3.6e-7), or evaluate the law at control rate (every 8-16 samples) and interpolate linearly [est., not measured]. 20 fading voices cost 9-14 us per quantum in wasm with the table: more than all the other fade work, so keep fades per-voice and short.

## Findings in one list

1. Music adds +1.35% (typical), +3.0% (transition), +3.7% (worst) of the high scene in wasm instructions (exact); ~0.016 / 0.036 / 0.06 ms (est.).
2. A stamped record cuts the quantum for every voice: +37.6% when it happens every quantum (~0.6 ms est. per split quantum). Do the fade start sample inside the voice.
3. Per-voice sample-accurate ramps are cheap (0.1-0.3 us/voice) in linear, S-curve and sqrt-equal-power forms; avoid `sinf` per sample (1.3-1.9 us/voice native).
4. The clock is noise: <= 0.2 us per quantum for 8 instances.
5. 44.1 kHz = 48 kHz in cost; non-spatial = spatial; stream voice = decoded + 25%.
6. First live automation binding costs ~245k instructions (~9 us est.) wherever it appears; extra bindings ~2.5k each.
7. Music is bounded by stream rings (4/8/16) before CPU: `mus-trans` takes 12 of 16 on high, `mus-worst` all 16.

## Unverified [U]

- Timed numbers are from the coordinator's 10 s x 5 run (not 20 s); deltas resolve to about +-30 us; p99.9/max are VM tails. The 2x reference-machine factor is an assumption (est.).
- (est.) microseconds: derived from metered ratios and the ADR's quoted totals, not measured here.
- Instruction counts exclude cache and memory effects (arena vs ring reads, 44.1 kHz source strides).
- Why automation has a ~245k fixed cost (candidates: `advance_params` over the seeking globals, the per-voice automation lookup in `render_range`); not profiled.
- wasm `sqrtf` speed (libm software routine?).
- Default and low rows of Q5 come from the cost model, not runs. Phone numbers untested.
- Stems are noise streams fed by the harness; real decode, the worker's copy into the ring and the chunk scheduling are S-other spikes' subject.
- The preset in the bench is the older `Scene::preset(high)` (32 HRTF, as ADR 0157's bench); the editor's high preset says 8 HRTF (`audioSettingsModel.ts:238`). Music cost is independent of it; the base totals are not.
- Stingers loop (worst case) instead of one-shotting; a real stinger is idle most of the time.

## Reproduce

```
export CARGO_TARGET_DIR=<shared target dir>
cd spikes/audio-music/cost
node run.mjs --smoke                  # about 2.5 min on the loaded VM: plumbing, not timing
node run.mjs                          # the timed run: 5 runs x 20 s (+2 s warm-up) per scene
node run.mjs --only=native,micro      # parts: check, micro, native, wasm, metered
PACE=1 node run.mjs --only=native     # paced to the 2.667 ms deadline (each run takes its audio seconds in wall time)
cargo run --release -- mode=check     # correctness only
```

**Expected duration of the full timed run on an idle machine: about 50 minutes** (12 heavy scenes x 5 runs x ~17 s ~ 17 min native, ~22 min wasm, `iso-*` ~4 min, micros ~4 min, metered ~3 min; unpaced runs take less wall time than audio time; set `RUNS`, `SECONDS` to change). Output: `results/<stamp>/summary.md` (tables as above) and `raw.jsonl`. `results/smoke-*` here is the smoke output.
