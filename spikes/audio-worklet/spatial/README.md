# Spatialisation and convolution reverb cost (spike)

What binaural (HRTF) spatialisation and convolution reverb cost per 128-frame quantum in wasm, to size the audio core's spatial design. The impulse responses are synthetic decaying noise. Cost depends only on their length, and 256 taps is the length of SADIE II's 48 kHz HRIRs (the HRTF set the research picked).

- `src/lib.rs`: the cases (see its header). FFT is `realfft` 3 (on `rustfft`); convolution is uniformly partitioned overlap-save with 128-sample partitions, FFT size 256.
- `examples/native.rs`: native baseline. `run.mjs`: Node, Playwright Chromium and WebKit. `wasm/`: scalar and `simd128` builds (309 KB and 406 KB, mostly rustfft's planners).
- `linux.json`: raw results from Linux Chromium and WebKit (Docker, `mcr.microsoft.com/playwright:v1.64.1-noble`).

```bash
cd spikes/audio-worklet/spatial && cargo run --release --example native
node spikes/audio-worklet/spatial/run.mjs        # from the repo root
```

## Results (2026-11-09, AMD Ryzen AI Max+ 395, one core; ms per quantum, budget 2.667 ms)

| Case | Native (AVX) | Chromium wasm | Chromium `simd128` | WebKit wasm | WebKit `simd128` |
|---|---|---|---|---|---|
| Direct FIR HRTF, 256 taps, 1 voice | 0.036 | 0.031 | 0.032 | 0.027 | 0.031 |
| FFT HRTF, 256 taps, 1 voice | 0.0017 | 0.0066 | 0.0063 | 0.008 | 0.009 |
| FFT HRTF, 256 taps, **32 voices** | 0.064 (2.4%) | 0.132 (5.0%) | 0.140 (5.2%) | 0.191 (7.2%) | 0.170 (6.4%) |
| Moving source (two HRTFs crossfaded), 1 voice | 0.0037 | 0.0104 | 0.0103 | 0.011 | 0.010 |
| 3rd-order ambisonics, 64 voices + binaural decode | 0.054 (2.0%) | 0.142 (5.3%) | 0.162 (6.1%) | 0.148 (5.5%) | 0.094 (3.5%) |
| 3rd-order ambisonics, **256 voices** + binaural decode | 0.108 (4.0%) | 0.348 (13.0%) | 0.221 (8.3%) | 0.353 (13.2%) | 0.177 (6.6%) |
| Convolution reverb, 2 s IR, stereo | 0.286 (10.7%) | 0.498 (18.7%) | 0.556 (20.9%) | 0.426 (16.0%) | 0.500 (18.8%) |
| Convolution reverb, 4 s IR, stereo | 0.573 (21.5%) | 1.076 (40.4%) | 1.118 (41.9%) | 0.890 (33.4%) | 0.940 (35.3%) |

Linux Chromium and WebKit (`linux.json`) are within noise of the Windows figures. Single-voice rows are a few microseconds and noisy; read the multi-voice rows.

## Findings

- **Use FFT convolution for HRTF, not direct FIR.** It is about 5× cheaper in wasm. Per-voice HRTF costs about **4–6 µs per voice per quantum**, so 32 binaural voices take 5–7% of the budget, and 128 would take about 25%.
- **Ambisonics scales better.** Third-order (16 channels) costs a fixed ~0.1 ms for the binaural decode plus a cheap per-voice encode (16 gains). 256 spatial voices fit in 7–13%. With `simd128` the encode vectorizes, giving about 2× at 256 voices. Proposed split:
  - the nearest or most important sounds get direct per-voice HRTF (sharpest image);
  - everything else is encoded into the ambisonic bed;
  - roughly what Resonance Audio and Steam Audio's mixed mode do.
- **Moving sources cost about 1.7×** a static one (two filter sets during the crossfade). This is only paid while a voice's direction changes enough to switch HRTF.
- **Long convolution reverb is the expensive item.** A 4 s stereo IR costs 0.9–1.1 ms in wasm (33–42%) with uniform 128-sample partitions. Before shipping, it needs non-uniform partitioning, with small partitions first and large FFT partitions for the tail; that's normally 3–5× cheaper. One or two such reverbs, plus algorithmic reverbs for the rest, is the realistic budget.
- **Wasm FFT runs at 2–4× native**, against near-parity for the plain mixer: rustfft uses AVX natively, and its wasm SIMD path barely helped here. That leaves room for a hand-tuned FFT or for running long convolutions on the native desktop path.
- **`simd128` helps loops that vectorize** (the ambisonic encode) and not filter recurrences. Ship both builds and feature-detect, or ship `simd128` only: Chromium, WebKit and Node all accept it.
