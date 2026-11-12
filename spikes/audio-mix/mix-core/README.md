# S4: the mix in the core (audio M5): sidechain ducking, sample-accurate bus ramps, live bus edits

Question: what do sidechain ducking, stamped (sample-accurate) bus ramps and snapshot blending of effect parameters cost the audio thread, what does ordering do to a sidechain, and which live mix edits are free, which click, and which need a crossfade?

## Method
- `src/` (crate `mixcore`, path deps on `native/audio/crates/audio-dsp`, native and wasm32+simd128): `sidechain.rs` (peak/RMS follower, gain computer with threshold, ratio or gate, knee, max reduction, attack/release smoothing, per-sample gain curve), `busramp.rs` (a stamped ramp record `{start frame, frames, from, to}` filled hold/ramp/hold in one pass, beside today's `Ramp::next` loop), `blend.rs` (biquad blending schemes). Modes: `check`, `micro` (per-call clock reads, p50/p99/p99.9/max, plus 64-call block means), `zipper`, `delay`, `blend`.
- `ordering.mjs`: bus order of `samples/*/project.json` against ducking rules (today's order = `bus.rs` `order`: depth, deepest first, ties by index).
- `live/`: esbuild bundle of the real `createLoopbackHost` (`src/plugins/audio/runtime/testing.ts`) on the committed `myco_audio.wasm`; each edit is sent as main would send it (BUS_CONFIG and/or BUS_MIX and/or SET_PARAMS in one batch) at quantum 12..19 (8 phases, worst reported) and compared with an identical unedited run. Click metric `abrupt` = largest sample step of (edited - unedited) over its peak: a smooth change of these tones (<= 1760 Hz) gives <= 0.23, a jump about 1. Controls: resending the unchanged tree is bit-identical; a gain jump with `rampFrames` 0 reads CLICK.
- `run.mjs`: everything above plus metered wasm instruction counts (deterministic). Smoke run done here (machine shared; timings in it are plumbing only). Full timed run: `node run.mjs` (RUNS=5 x CALLS=60000, native and wasm, about 3-4 min; analyses and live edits add under 30 s).

## What today's code does (read)
- `mixer.ts:183-215`: fades (linear in volume), snapshot transitions and ducking advance on main once per frame; ducking counts voices (`:203-208`), exponential approach with `attack`/`release` as time constants.
- `coreBackend.ts:678-698` `applyMix` sends BUS_MIX with `rampFrames` from `clock.ts:282` -> `lookahead.ts:34`: the frame interval clamped to 5..50 ms (800 frames at 60 fps), **not** 2.7 ms. The core ramps each bus gain per frame from where it is (`bus.rs` gain `Ramp`, mixdown loop) from the start of the next quantum; BUS_CONFIG, BUS_MIX and MASTER apply on arrival, whatever `frameOffset` (`bus.rs` Timing note).
- BUS_CONFIG (`bus.rs:275` `configure`) is applied in place: a bus index that stays keeps its gain, snapshot filter, effect state and meter; a slot that keeps its kind keeps filter/compressor state, a changed kind starts zeroed (`fx.rs:131-135`, tests `a_kept_kind_keeps_its_state...`); new buses start unity; no rebuild. Only buses past the preset's `max_buses`, effects past 4 and a second compressor are dropped (counted).
- The shared reverb has one fixed seeded IR; "changing reverb" is the send level in BUS_CONFIG. The convolver runs only while a send exists (`bus.rs` `has_reverb`).

## Results

### 1. Sidechain cost per quantum (stereo, one rule; wasm instructions deterministic, ns from the smoke run, indicative)
| case | wasm instr | native p50 ns | wasm p50 ns | % of quantum (wasm) |
|---|---:|---:|---:|---:|
| peak detector only | 6,019 | 573 | 578 | 0.022 |
| rule, peak, gain computer per quantum | 8,114 | 731 | 785 | 0.029 |
| rule, RMS, per quantum | 6,828 | 738 | 548 | 0.021 |
| rule, peak, computer every 16 samples | 14,603 | 1,099 | 1,150 | 0.043 |
| rule, peak, computer per sample (upper bound, libm log10/pow) | 126,427 | 7,965 | 8,632 | 0.324 |
| apply gain curve to target | 976 | 67 | 133 | 0.005 |
| 8 rules on one target + apply | 90,859 | 5,982 | 5,107 | 0.192 |

Per-quantum gain computer agrees with per-sample to 0.024 dB (check). The detector dominates (a per-sample dependent chain); a block-max pre-pass would cut it about 4x **(est.)**. Checks pass native and wasm (63% at the attack time, RMS = A/sqrt2, stamped ramp exact).

**Ordering.** Today's order puts a bus before its parent, siblings by index. A trigger is computed before the target only if deeper, or same depth with a lower index. sound-lab's `SFX -> Music` (both under Master, Music index 1): **delayed one quantum**. stress's `Bus01 -> Mix0`: no delay. The default tree (Master, Music, SFX, UI, Voice) and the `settings.ts:14` example (`Voice` ducks `Music`) are the delayed case. Over all ordered pairs: sound-lab 36 of 90, stress 438 of 992 delayed. Adding trigger->target edges to the child->parent edges (Kahn at BUS_CONFIG, no audio cost) removes the delay for every rule in both samples; only a trigger that is an ancestor of the target (9 and 58 pairs) is a cycle and must read last quantum.
**Does a 1-quantum delay matter?** Largest gain error vs a zero-delay detector, 10.5 dB duck, hard onset: attack 50 ms 0.54 dB (5% of depth); 25 ms 1.06 dB; 10 ms 2.45 dB (23%), only in the first 2.7 ms of the onset. Inaudible for the samples' 50 ms; reorder anyway, it is free.

### 2. Bus ramps (per ramping bus per quantum)
| case | wasm instr | native p50 ns | wasm p50 ns |
|---|---:|---:|---:|
| today: `Ramp::next` loop | 5,408 | 220 | 222 |
| stamped, ramp spans quantum | 1,796 | 196 | 232 |
| stamped, starts at sample 64 / ends at 64 | 1,692 / 1,701 | 140 / 141 | 110 / 114 |
| 8 buses ramping, today / stamped | 43,236 / 14,154 | 1,421 / 1,192 | 1,311 / 496 |

A stamped ramp is no dearer than today's (it vectorises: about 3x fewer instructions), never splits the quantum, and is exact to 5e-8 where `Ramp::next` drifts 1.1e-5 over 700 frames. Side finding: the settled `g != 1` branch (`bus.rs`, `iter_mut().chain`) costs 6,703 instr, more than ramping.

Zipper (1 kHz at 0.5 peak; lag removed before error; `rampFrames` as sent today):
| path | fps | lag behind true curve | error rms | gain-step click |
|---|---:|---:|---:|---:|
| 2.7 ms ramp per update (brief's premise) | 60 / 30 | 10.7 / 19.3 ms | -32.9 / -26.6 dB | -72.6 / -66.6 dBFS |
| today (ramp = frame interval) | 60 / 30 | 17.9 / 34.7 ms | -49.3 / -40.9 dB | -86.8 / -88.1 dBFS |
| same, updates up to 3 quanta late | 60 / 30 | 21.3 / 38.0 ms | -37.5 / -35.9 dB | -84.9 / -87.5 dBFS |
| stamped linear ramp | - | 0 | -79 dB (f32) | -88.5 dBFS (the fade's own step) |
Ducking shape gives the same pattern. So today is piecewise-linear, not stepped: the cost is **latency (18-38 ms) and slope kinks**, not audible zipper.

### 3. Live edits (real core)
| edit | click? (abrupt, step dBFS) | state reset? | latency | rebuild? |
|---|---|---|---|---|
| resend unchanged tree | no (bit-identical) | no | - | no |
| bus volume (BUS_MIX, ramp 800 or 128) | no (0.10, -39) | n/a | next quantum + ramp (settles about 139 ms in measure window) | no |
| bus gain with ramp 0 (control) | **click** (0.59, -24) | - | 0 | no |
| filter cutoff, same slot (8k->1.2k; 300 Hz Q12) | no (0.15, 0.10) | kept | next quantum | no |
| compressor threshold | **click** (1.0; -24 dBFS for 6 dB, -6 for 26 dB) | kept | next quantum | no |
| add effect at the end | no (0.05) | new slot zeroed | next quantum | no |
| remove last effect | small click (0.6, -40 dBFS) | - | next quantum | no |
| insert/remove effect so slots shift | **click** (0.75-0.8, -19 dBFS) | reset (kind changes) | next quantum | no |
| add bus at end | none (identical) | - | next quantum | no, up to `max_buses` |
| move voice to new bus; change parent; insert bus mid-tree | **click** (0.94-1.0, -17..-13 dBFS) | index-shifted state | next quantum | no |
| reverb send level / first send | no (0.10, -47) | convolver fresh | next quantum | no |
| remove last send | tail cut to 0 in one quantum (0.25 live) | **frozen, stale tail replays on re-add** (0.041 vs 0.042 reference) | next quantum | no |
Latency in the core is 0 frames from batch to first changed sample (loopback); main adds its postMessage and frame wait (not measured here [U]). The compressor click's cause (an unsmoothed makeup-gain step when the threshold curve changes) is inferred from the step shape [U]; I did not read `compressor.rs` for it.

### 4. Snapshot blending (biquad; compressor)
Per-quantum coefficient recompute costs +370 instr over a settled filter (10,675 vs 10,305); per-sample coefficient lerp +2.9k; exact per-sample recompute 115,573 (about 11 us). Click-free: per-quantum step with log-Hz cutoff, glitch within 1.68x of the per-sample same-trajectory (worst case a fast 500->18k opening), linear Hz (today) 1.19x; coefficient lerp per quantum 1.01x of its per-sample version, stable on the whole path (pole radius <= 0.9993), but its trajectory differs from the log-Hz sweep (2.98x vs exact). An unblended switch glitches up to 3.5x. Compressor threshold blended per quantum over >= 20 ms: abrupt 0.19-0.23, largest step -36/-28 dBFS; hard step 0.78, -18/-7 dBFS. `Compressor::configure` per quantum costs nothing measurable.

## Recommendation
1. Put sidechain detectors in the core: peak or RMS, detector per sample, gain computer once per quantum, gain interpolated per sample: about 0.7 us (8k instr) per rule, 8 rules about 6 us. Budget 10 us for the lot **(est.)**.
2. Compute the mix order at BUS_CONFIG with trigger->target edges; keep a 1-quantum delay only for ancestor triggers.
3. Stamp bus/master ramps (a start frame and a law at control rate, as M4-0 does for voices): cheaper than the loop, removes 18-38 ms of lag, and makes fades and snapshots sample-accurate.
4. Live-edit classes. Cheap, no crossfade: bus volume/mute (ramped), filter parameters, reverb send level, adding a bus at the end, resending an unchanged tree. Need smoothing in the core: compressor threshold (blend per quantum over >= 20 ms), send level steps. Need a crossfade or a dry/wet swap: slot-shifting effect edits, parent changes, voice moves, mid-tree insertion, removing the last reverb send (ring the tail out or keep the convolver running until silent). Make BUS_CONFIG diff-aware so index stability is kept (append, never insert).

## Unverified [U]
Real devices; main-to-worklet latency; arrival jitter model (up to 3 quanta); compressor click cause; wasm size effect; the block-max speed-up; timings here come from a loaded VM.

## Reproduce
`export CARGO_TARGET_DIR=<dir>; node run.mjs [--smoke] [--only=check,micro]`; individual: `cargo run --release -- mode=zipper|delay|blend|check|micro calls=N`, `node ordering.mjs`, `node live/build.mjs && node live/build/live.mjs`.
