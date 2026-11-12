# S1: loudness metering cost and correctness (audio M5)

**Question.** How does M5 meter BS.1770 / EBU R128 loudness (momentary, short-term, gated integrated, LRA, true peak) on master plus project-picked buses inside the audio core, what runs on the audio thread, what runs on main, and what does it cost per 128-frame quantum (2,667 us at 48 kHz)?

## Layout
- `src/loud.rs`: the implementation. Audio-thread half `Loudness` (K-weighting, 100 ms sub-block energies, true peak; no allocation, no panics on the hot path), main half `Feed` / `Gating` (exact) / `Hist` (fixed memory).
- `src/checks.rs`: correctness (`mode=check`, also `cargo test --release`). `src/ebur.rs`: the `ebur128` crate behind the same interface. `src/signals.rs`: test signals. `src/lib.rs`: cost bench (`mode=cost`) plus a counting global allocator.
- `size/`: wasm size probes (base, own, crate). `run.mjs`: the runner. `results/short-loaded-*`: a short run on the shared VM (3 runs x 8,000 quanta, other agents compiling): plumbing and rough figures only.

## Method
- Design: the core computes, per metered stereo bus, K-weighted L+R mean-square per 100 ms sub-block and publishes the last 4 completed sub-blocks (ring) with a sequence number, plus the true-peak maximum since the last STATUS take. Momentary = mean of the last 4 sub-blocks (400 ms, 75% overlap by construction), short-term = last 30, gated integrated = 400 ms blocks (every sub-block) with the -70 LUFS and -10 LU gates, LRA = 3 s blocks at a 1 s hop (Tech 3342 / libebur128; a 100 ms hop gave 1.5 LU on a gated step case where libebur128 reads 0), -70 / -20 LU gates, 10th to 95th percentile. All gating is on main.
- STATUS payload per metered bus: seq u32 + 4 x f32 energies + 2 x f32 true peak = **28 B** (8 buses: 224 B per STATUS, about 14 kB/s at the 6-quantum cadence). The ring of 4 exists because the idle STATUS cadence (48 quanta = 128 ms, `audio-wire/src/schema.rs:76`) is longer than a sub-block; tested with zero lost sub-blocks at both cadences. Main memory: two 1000-bin histograms = 24 kB per bus.
- Existing per-bus metering: `meters.rs:41` peak update per bus per quantum, called at `bus.rs:569` after the bus's effects and gain; the loudness taps go at the same place (bus output).
- Costs: `Instant` natively, `performance.now()` through an import in Node 22 for wasm (`+simd128`, release, LTO as `native/audio/build.mjs:37` builds). Each statistic is per quantum for all k buses together. The metered wasm (`tools/audio-bench/meter.mjs`) gives deterministic instruction counts, which do not depend on machine load.
- Signals: synthesized (sines, music-like noise plus partials with level swings, tone bursts with digital silence). No real content: the cost of IIR and FIR does not depend on the content except through denormals (tested with the burst signal; states below 1e-200 are flushed per quantum).

## Findings
See the reply's tables and `results/`. Key points:
- Own implementation and the crate agree to better than 1e-3 LU on I, M, S, to 1e-3 dB on true peak, and to <0.01 LU on LRA, at 48 and 44.1 kHz, native and wasm (189 checks).
- The crate's `add_frames` does not allocate in steady state, but its p99.9 is 180 to 240 us per bus (the 100 ms gating-block work: 400 ms of f64 samples summed), and the spikes of all buses line up. It allocates 2.39 MB per stereo bus at construction (f64 audio window), and its history queue is pre-sized to 5,000 blocks (about 8 minutes) and then grows unless `Mode::HISTOGRAM` or `set_max_history` is used (`ebur128-0.1.11/src/history.rs:168`).
- True-peak FIR with explicit simd128 intrinsics: 25.8 k instructions per quantum versus 41.3 k from the autovectorized array form.

## Unverified [U]
- The BS.1770-4 Annex 2 coefficient table was not available (ITU hosts blocked); the interpolator is the Hann-windowed sinc libebur128 generates. It reads +0.10 dB high on the fs/4 45-degree sine (Tech 3341's true-peak tolerance is +0.2/-0.4 dB from memory).
- The Tech 3341/3342 expected values are from memory and the signals are synthesized, not the EBU files.
- Real-device and real-content cost; wasm numbers on this shared VM beyond p50/p99; wasm-opt (not on PATH here) would shrink the size figures.
- The true-peak gate (-6 dBFS sample peak) is exact for sine-like inter-sample overshoot (up to +3 dB at fs/4) but a crafted signal can exceed that.

## Reproduce
`CARGO_TARGET_DIR=<dir> node run.mjs --smoke` (about 15 s), `node run.mjs` (the timed run, 5 runs x 20,000 quanta per case, native and wasm: about 2.5 min on an idle machine, est. from the 19 s short run), `cargo test --release`.
