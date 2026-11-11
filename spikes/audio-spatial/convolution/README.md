# Audio M3 spike: reverb-zone convolution cost

Throwaway measurement code for the M3 (spatial) design, ADR 0162's technical design. Nothing outside this directory was touched. **Every timing in this file is a smoke run** (5 runs x 2,000 quanta on a shared 4-vCPU VM that was also doing other work; maxima in particular are dominated by OS jitter). The coordinator's timed runs on an idle machine replace them. Correctness results and the deterministic figures (sizes, transform counts, modelled load) are final.

## Question

Can M1's ported staged convolver serve **reverb zones**: several convolvers at once, a listener blending between two, a zone switch that loads a new IR while playing, and per-event filter and send, inside the audio thread's per-quantum budget (architecture §6: 2.667 ms per quantum, the reserve nearly spent, p99.9 matters more than the mean)? Specifically: what does the worst quantum cost, and does moving tail work between quanta ("tail phase offsets", architecture §10) help?

## What M1 already is (so item 5 was not needed)

`native/audio/crates/audio-dsp/src/convolver.rs` is already non-uniform. Per channel, a **head** of 32 uniform 128-frame partitions (the first 4,096 frames, 256-point FFT, one forward and one inverse transform a quantum, zero latency) and a **tail** of 2,048-frame partitions on one shared 4,096-point transform (a frequency-domain delay line of input spectra, one spectrum multiply-add per partition), run on a 16-quantum schedule: forward FFT at slot `f`, the multiply-adds spread over the slots between, inverse FFT at slot `i`, slot = `(k + 1) % 16`. M1 already staggers its two channels (left `(0, 15)`, right `(1, 14)`). So no new variant was written; the comparison for item 5 is M1 against M1 with moved tail work.

M1's convolver reads one fixed generated 1.8 s IR out of a byte region. To measure 1, 2 and 4 s IRs and several instances, `src/conv.rs` is a copy of M1's `process` over owned buffers (same head, tail, schedule arithmetic, kernel scaling, and M1's own FFT functions from `audio_dsp::convolver::fft`), generalised in two ways:

- **Schedule per channel.** Any `(f, i)` with `f + 2 <= i <= 15`. The block grid, the transformed input, the multiply-add order and the accumulation frame are unchanged, so **the output is bit-identical for every schedule**: only the quantum that does the work moves. (A forward at slot `f` transforms the input that ended `f` quanta ago; an inverse at slot `i` adds at frame `128 (k + 17 - i)`, still ahead of the read position.)
- **`Prep`**, the spectra builder: M1's `init` work (the rms normalisation pass, then one forward FFT per channel and partition: 256-point for head partitions, 4,096-point for tail partitions) cut into "units" that run any number per call, so a zone switch can spread it across quanta.

`plan_stagger` picks schedules for N zones: the smallest cap on any quantum's modelled load (a 4,096-point transform = 1.0, one partition multiply-add = 0.055, from `examples/micro.rs`: 20.7 us and 1.06 us native) for which a depth-first search finds an assignment. `plan_unique` instead caps transforms per quantum at the floor `ceil(4N / 16)` first.

## Method

One crate (`Cargo.toml`, standalone, not in `native/audio`'s workspace) depending on `audio-dsp` by path, built natively and to `wasm32-unknown-unknown` (+simd128, release, as the mixer). One list of cases (`src/cases.rs`), three runners over it (native, wasm in Node, wasm in Chromium), one `Case` per scene: `step()` is one 128-frame quantum of the audio thread's work, timed individually.

- **IRs:** distinct per zone and per run: decaying noise (M1's cubic envelope, seeded) and a "room" shape (direct sound, 28 early reflections in the first ~110 ms, a diffuse exponential tail with RT60 about 0.9 x length that darkens with time). Zones alternate the two. All normalised as M1 does.
- **Inputs:** distinct looping stereo buffers per zone and per run (gated noise bursts over a low tone, 2^17 frames), read a quantum at a time at a per-zone offset.
- **Statistics:** per case, >= 5 runs of >= 2,000 quanta (the runner defaults to 7 x 4,000); 300 warm-up quanta per run; per-quantum wall time (clock pair overhead is included: 27 ns native, 70 ns Node, 5 us resolution in Chromium's main thread); p50, p99, p99.9 and max over the pooled samples; each JSON row also has per-run p99.9 and max. "%" is of 2,666.7 us.
- **Cases:** `single_{1,2,4}s_{noise,room}`, `m1_real_1.8s` (`audio_dsp::convolver::{init, process}` untouched); `zones_{N}x{2,4}s_{unstaggered,staggered,unique}` (N = 1, 2, 4, 8; unstaggered = M1's schedule in every zone, the case where all tails land in the same quanta); `blend_2x{2,4}s_*` (two convolvers, send levels equal-power crossfaded over 375 quanta with a per-sample linear ramp, ping-pong with holds); `prep_atonce_{1,2,4}s` (a whole preparation as one timed step: the stall) and `prep_spread_{1,2,4}s_u{1,2,4}` (the playing zone's quantum plus `U` preparation units per quantum, while preparing the next IR over and over); `event_{16,64,256}_{route_only,filter,filter_send,filter_send_auto}` (4 voices per instance: each voice's block added into an instance buffer, M1's `Biquad` low-pass, the result added to the bus and `send x signal` added to the reverb input; `route_only` is today's routing with no instance buffer, the baseline; `_auto` changes the cutoff every quantum so the coefficients are recomputed).
- `tail FFTs in busiest quantum` and `modelled busiest quantum` in the notes column are deterministic: counted from the schedules, not timed.

## Commands

Everything is run from `spikes/audio-spatial/convolution/`. Needs the Rust toolchain with the `wasm32-unknown-unknown` target (cargo offline works once the registry is cached), Node 22, and for the browser runner Chromium (`/opt/pw-browsers/chromium-*` is found automatically; `CHROMIUM=/path/to/chrome` overrides) and Playwright from the repo's `node_modules`.

| Runner | Command (timed, for the coordinator) |
|---|---|
| Native | `cargo run --release -- bench --runs 7 --quanta 20000 --json results/native.json \| tee results/native.md` |
| wasm in Node | `./build_wasm.sh && node run_wasm.mjs bench --runs 7 --quanta 20000 --json results/wasm-node.json \| tee results/wasm-node.md` |
| wasm in Chromium, main thread (per-quantum, 5 us clock) | `node run_browser.mjs main --runs 7 --quanta 20000 --json results/chromium-main.json \| tee results/chromium-main.md` |
| wasm in an AudioWorklet (OfflineAudioContext; mean per quantum only, no clock in the worklet) | `node run_browser.mjs worklet --runs 7 --quanta 20000 \| tee results/chromium-worklet.md` |
| Correctness, native | `cargo run --release -- check` (about 12 s) |
| Correctness, wasm | `node run_wasm.mjs check --stride 24 --secs 3` (about 7 s; `--secs` is a bitmask of the 1, 2, 4 s IRs) |
| Side-by-side tables from the JSON | `node tables.mjs native=results/native.json wasm-node=results/wasm-node.json chromium=results/chromium-main.json` |
| Memory per zone, `micro` unit costs | `cargo run --release -- memory`, `cargo run --release --example micro` |
| Everything, smoke sizes (about 12 min) | `./run_smoke.sh` |

A full `--quanta 20000 --runs 7` pass over the 55 cases takes roughly 15 to 30 minutes per runner (about 53 s of audio per run per case). `--filter a,b` runs the cases whose names contain a substring (`--filter zones_,blend_` for the headline).

## Correctness (final; native and wasm agree)

All against a direct time-domain convolution in `f64` of the same input and IR (IR scaled in `f32` exactly as the convolver bakes the scale in), compared at a stride of output samples (native every 5th, wasm every 24th, plus the first 300 samples and the last two quanta) with a bound of **rel RMS < 1e-4**; the inputs run `IR length + 1 s`, so the whole IR is exercised. Full text: `results/check-native.txt` (29 checks, 0 failures) and `results/check-wasm.txt` (27 checks, 0 failures, 1 and 2 s IRs only).

| Check | Result |
|---|---|
| Owned-buffer zone vs `audio_dsp::convolver::process` (M1's code, 1.8 s generated IR, 5 s of input) | **bit-identical** |
| 1, 2 and 4 s IRs, noise and room shapes, M1 schedule vs direct (5 s of input at 4 s) | rel RMS **2.5e-7 to 3.1e-7**, max abs / peak <= 3.6e-7 |
| 1 and 2 s IRs on a far-staggered schedule `(5,11),(7,13)` vs direct | rel RMS 2.5e-7 to 2.8e-7 (same as unstaggered) |
| 8 zones x 2 s, distinct IRs and inputs, 4 s: staggered plan vs unstaggered | **bit-identical** (schedule moves when work runs, not the block grid) |
| Extreme schedules `(0,2),(13,15)`, `(13,15),(0,2)`, `(7,9),(2,10)` vs M1's | **bit-identical** |
| Blend: 2 x 2 s noise/room IRs, staggered, one full A-B-A crossfade (2.7 s), vs direct convolution of the gained inputs | rel RMS 2.7e-7 |
| Blend continuity: smooth resonant IRs and tone inputs, max sample-to-sample step of the mix | **1.00 x** the pure zones' own max step (bound 1.5 x). Control: a hard cut A to B steps 8.5 x that, so the check can see a discontinuity |
| Zone switch (spread preparation at U = 1 and 4, then a 375-quantum crossfade): spectra vs at-once preparation | **bit-identical**; output vs direct rel RMS 2.7e-7; continuity 1.00 x (control 8.5 x) |
| Event effects, 16 instances x 4 voices, 300 quanta: bus and reverb-send vs a scalar `f64` direct-form biquad with the same coefficients | rel RMS 4.9e-7 and 5.4e-7 (bound 1e-5) |

Native and wasm give the same errors to the digits shown. Not checked: native vs wasm bit equality across the board.

## Results (SMOKE: 5 runs x 2,000 quanta, shared VM, not for decisions)

Columns per runner: p50, p99, p99.9, max in us, then p99.9 and max as % of a 2,666.7 us quantum. "native" is `cargo run --release`; "wasm-node" is Node 22 on the +simd128 wasm; "chromium" is the same wasm on Chromium's main thread (HeadlessChrome 153, cross-origin isolated, 5 us clock). Prep "at once" rows are one whole preparation per sample (ms scale; % not meaningful).

#### Single convolver (M1 as is)

| case | native p50 | p99 | p99.9 | max | p99.9 % | max % | wasm-node p50 | p99 | p99.9 | max | p99.9 % | max % | chromium p50 | p99 | p99.9 | max | p99.9 % | max % |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| single_1s_noise | 12.7 | 44.0 | 83.2 | 2005 | 3.1 | 75.2 | 12.8 | 42.7 | 54.2 | 444.4 | 2.0 | 16.7 | 15.0 | 50.0 | 80.0 | 100.0 | 3.0 | 3.7 |
| single_1s_room | 13.2 | 53.4 | 116.6 | 334.7 | 4.4 | 12.5 | 12.5 | 41.4 | 51.2 | 58.9 | 1.9 | 2.2 | 15.0 | 55.0 | 80.0 | 180.0 | 3.0 | 6.7 |
| single_2s_noise | 17.4 | 68.8 | 102.3 | 1004 | 3.8 | 37.7 | 17.8 | 47.7 | 75.3 | 730.5 | 2.8 | 27.4 | 20.0 | 50.0 | 75.0 | 165.0 | 2.8 | 6.2 |
| single_2s_room | 17.2 | 46.5 | 67.6 | 106.2 | 2.5 | 4.0 | 17.4 | 45.2 | 56.5 | 581.1 | 2.1 | 21.8 | 20.0 | 50.0 | 95.0 | 595.0 | 3.6 | 22.3 |
| single_4s_noise | 26.0 | 50.4 | 64.0 | 87.5 | 2.4 | 3.3 | 28.0 | 73.2 | 166.0 | 1156 | 6.2 | 43.4 | 25.0 | 65.0 | 110.0 | 220.0 | 4.1 | 8.2 |
| single_4s_room | 26.5 | 50.8 | 62.8 | 73.4 | 2.4 | 2.8 | 26.9 | 52.2 | 64.4 | 181.2 | 2.4 | 6.8 | 25.0 | 55.0 | 75.0 | 360.0 | 2.8 | 13.5 |
| m1_real_1.8s | 16.8 | 46.8 | 56.8 | 883.2 | 2.1 | 33.1 | 16.3 | 45.7 | 59.7 | 455.7 | 2.2 | 17.1 | 20.0 | 65.0 | 95.0 | 150.0 | 3.6 | 5.6 |

#### Several zones

| case | native p50 | p99 | p99.9 | max | p99.9 % | max % | wasm-node p50 | p99 | p99.9 | max | p99.9 % | max % | chromium p50 | p99 | p99.9 | max | p99.9 % | max % |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| zones_1x2s_unstaggered | 17.1 | 45.4 | 57.5 | 89.2 | 2.2 | 3.3 | 17.7 | 46.2 | 57.9 | 375.8 | 2.2 | 14.1 | 20.0 | 45.0 | 60.0 | 95.0 | 2.2 | 3.6 |
| zones_1x2s_staggered | 15.2 | 45.8 | 54.6 | 62.8 | 2.0 | 2.4 | 15.8 | 43.9 | 56.9 | 178.2 | 2.1 | 6.7 | 20.0 | 45.0 | 60.0 | 65.0 | 2.2 | 2.4 |
| zones_2x2s_unstaggered | 34.5 | 85.7 | 101.0 | 260.4 | 3.8 | 9.8 | 36.3 | 88.5 | 119.2 | 201.6 | 4.5 | 7.6 | 35.0 | 90.0 | 140.0 | 760.0 | 5.2 | 28.5 |
| zones_2x2s_staggered | 41.8 | 86.3 | 124.2 | 556.0 | 4.7 | 20.9 | 45.2 | 70.7 | 83.3 | 111.0 | 3.1 | 4.2 | 40.0 | 65.0 | 80.0 | 145.0 | 3.0 | 5.4 |
| zones_4x2s_unstaggered | 73.7 | 164.7 | 215.3 | 717.8 | 8.1 | 26.9 | 80.7 | 256.9 | 317.1 | 628.6 | 11.9 | 23.6 | 70.0 | 165.0 | 225.0 | 625.0 | 8.4 | 23.4 |
| zones_4x2s_staggered | 87.6 | 175.8 | 392.0 | 3095 | 14.7 | 116.1 | 91.4 | 169.2 | 245.6 | 631.3 | 9.2 | 23.7 | 90.0 | 145.0 | 205.0 | 880.0 | 7.7 | 33.0 |
| zones_4x2s_unique | 98.3 | 157.5 | 200.0 | 631.0 | 7.5 | 23.7 | 102.5 | 139.3 | 160.5 | 684.1 | 6.0 | 25.7 | 95.0 | 160.0 | 225.0 | 1415 | 8.4 | 53.1 |
| zones_8x2s_unstaggered | 169.9 | 328.6 | 359.5 | 632.3 | 13.5 | 23.7 | 177.5 | 350.1 | 386.3 | 711.5 | 14.5 | 26.7 | 175.0 | 355.0 | 535.0 | 805.0 | 20.1 | 30.2 |
| zones_8x2s_staggered | 188.5 | 241.9 | 374.4 | 2253 | 14.0 | 84.5 | 200.6 | 252.9 | 289.9 | 2900 | 10.9 | 108.7 | 190.0 | 330.0 | 380.0 | 430.0 | 14.2 | 16.1 |
| zones_8x2s_unique | 170.2 | 352.1 | 505.2 | 2311 | 18.9 | 86.7 | 176.7 | 320.6 | 395.3 | 938.8 | 14.8 | 35.2 | 165.0 | 305.0 | 345.0 | 560.0 | 12.9 | 21.0 |
| zones_1x4s_unstaggered | 29.1 | 68.0 | 92.8 | 130.1 | 3.5 | 4.9 | 28.2 | 62.6 | 120.5 | 645.5 | 4.5 | 24.2 | 25.0 | 50.0 | 60.0 | 90.0 | 2.2 | 3.4 |
| zones_1x4s_staggered | 27.8 | 49.4 | 59.5 | 83.0 | 2.2 | 3.1 | 29.2 | 63.8 | 91.8 | 339.2 | 3.4 | 12.7 | 30.0 | 50.0 | 65.0 | 375.0 | 2.4 | 14.1 |
| zones_2x4s_unstaggered | 55.4 | 124.0 | 203.6 | 2285 | 7.6 | 85.7 | 57.4 | 106.2 | 138.7 | 688.4 | 5.2 | 25.8 | 50.0 | 90.0 | 105.0 | 115.0 | 3.9 | 4.3 |
| zones_2x4s_staggered | 54.8 | 87.9 | 277.6 | 2036 | 10.4 | 76.3 | 58.6 | 97.5 | 139.0 | 560.4 | 5.2 | 21.0 | 55.0 | 85.0 | 260.0 | 1040 | 9.7 | 39.0 |
| zones_4x4s_unstaggered | 118.2 | 232.2 | 304.3 | 2161 | 11.4 | 81.0 | 126.4 | 265.2 | 362.8 | 2583 | 13.6 | 96.9 | 115.0 | 255.0 | 590.0 | 1115 | 22.1 | 41.8 |
| zones_4x4s_staggered | 119.8 | 158.6 | 172.0 | 223.4 | 6.4 | 8.4 | 130.5 | 179.5 | 535.2 | 5728 | 20.1 | 214.8 | 125.0 | 165.0 | 205.0 | 270.0 | 7.7 | 10.1 |
| zones_4x4s_unique | 140.6 | 256.8 | 533.0 | 999.2 | 20.0 | 37.5 | 148.3 | 227.2 | 415.9 | 1490 | 15.6 | 55.9 | 145.0 | 205.0 | 265.0 | 805.0 | 9.9 | 30.2 |
| zones_8x4s_unstaggered | 239.4 | 366.1 | 417.6 | 1190 | 15.7 | 44.6 | 252.3 | 422.7 | 629.3 | 2510 | 23.6 | 94.1 | 255.0 | 435.0 | 595.0 | 900.0 | 22.3 | 33.7 |
| zones_8x4s_staggered | 240.3 | 309.0 | 443.3 | 1717 | 16.6 | 64.4 | 266.3 | 462.6 | 654.5 | 1185 | 24.5 | 44.4 | 255.0 | 400.0 | 855.0 | 3060 | 32.1 | 114.7 |
| zones_8x4s_unique | 208.3 | 583.0 | 1545 | 8539 | 57.9 | 320.2 | 213.8 | 466.5 | 538.0 | 1771 | 20.2 | 66.4 | 205.0 | 430.0 | 455.0 | 610.0 | 17.1 | 22.9 |

#### Zone blending (two convolvers, crossfaded sends)

| case | native p50 | p99 | p99.9 | max | p99.9 % | max % | wasm-node p50 | p99 | p99.9 | max | p99.9 % | max % | chromium p50 | p99 | p99.9 | max | p99.9 % | max % |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| blend_2x2s_unstaggered | 33.4 | 93.6 | 325.9 | 582.5 | 12.2 | 21.8 | 36.8 | 133.4 | 173.4 | 2494 | 6.5 | 93.5 | 35.0 | 80.0 | 100.0 | 190.0 | 3.7 | 7.1 |
| blend_2x2s_staggered | 40.0 | 67.9 | 169.8 | 2087 | 6.4 | 78.3 | 42.6 | 67.9 | 116.3 | 699.2 | 4.4 | 26.2 | 40.0 | 65.0 | 75.0 | 305.0 | 2.8 | 11.4 |
| blend_2x4s_unstaggered | 51.0 | 95.5 | 125.0 | 758.3 | 4.7 | 28.4 | 57.2 | 140.2 | 196.0 | 962.7 | 7.4 | 36.1 | 55.0 | 95.0 | 110.0 | 190.0 | 4.1 | 7.1 |
| blend_2x4s_staggered | 55.5 | 93.7 | 128.3 | 656.2 | 4.8 | 24.6 | 58.4 | 94.6 | 151.0 | 558.8 | 5.7 | 21.0 | 55.0 | 90.0 | 115.0 | 155.0 | 4.3 | 5.8 |

#### Zone switch: preparing an IR

| case | native p50 | p99 | p99.9 | max | p99.9 % | max % | wasm-node p50 | p99 | p99.9 | max | p99.9 % | max % | chromium p50 | p99 | p99.9 | max | p99.9 % | max % |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| prep_atonce_1s | 1263 | 3392 | 5280 | 5280 | - | - | 1404 | 2488 | 2648 | 2648 | - | - | 1275 | 1520 | 2080 | 2080 | - | - |
| prep_atonce_2s | 2402 | 2982 | 4832 | 4832 | - | - | 2702 | 4984 | 5729 | 5729 | - | - | 2515 | 2960 | 3335 | 3335 | - | - |
| prep_atonce_4s | 4884 | 6241 | 9671 | 9671 | - | - | 5207 | 7546 | 8737 | 8737 | - | - | 5100 | 6010 | 6155 | 6155 | - | - |
| prep_spread_1s_u1 | 29.0 | 57.9 | 71.8 | 87.8 | 2.7 | 3.3 | 31.0 | 61.1 | 73.1 | 871.9 | 2.7 | 32.7 | 30.0 | 60.0 | 75.0 | 130.0 | 2.8 | 4.9 |
| prep_spread_1s_u2 | 34.4 | 84.3 | 96.3 | 105.3 | 3.6 | 3.9 | 38.6 | 144.5 | 196.5 | 2099 | 7.4 | 78.7 | 35.0 | 90.0 | 105.0 | 275.0 | 3.9 | 10.3 |
| prep_spread_1s_u4 | 54.5 | 134.5 | 152.3 | 759.7 | 5.7 | 28.5 | 59.4 | 211.2 | 255.2 | 670.6 | 9.6 | 25.1 | 55.0 | 130.0 | 160.0 | 365.0 | 6.0 | 13.7 |
| prep_spread_2s_u1 | 36.1 | 63.8 | 76.2 | 129.6 | 2.9 | 4.9 | 38.7 | 70.7 | 87.0 | 120.1 | 3.3 | 4.5 | 35.0 | 65.0 | 85.0 | 145.0 | 3.2 | 5.4 |
| prep_spread_2s_u2 | 57.3 | 91.1 | 110.6 | 639.1 | 4.1 | 24.0 | 60.9 | 91.7 | 105.7 | 125.6 | 4.0 | 4.7 | 55.0 | 90.0 | 115.0 | 2725 | 4.3 | 102.2 |
| prep_spread_2s_u4 | 92.7 | 136.4 | 154.3 | 699.0 | 5.8 | 26.2 | 105.6 | 155.0 | 232.2 | 2183 | 8.7 | 81.9 | 100.0 | 140.0 | 275.0 | 900.0 | 10.3 | 33.7 |
| prep_spread_4s_u1 | 45.0 | 72.6 | 101.0 | 636.0 | 3.8 | 23.8 | 48.4 | 85.1 | 181.6 | 266.9 | 6.8 | 10.0 | 50.0 | 100.0 | 130.0 | 315.0 | 4.9 | 11.8 |
| prep_spread_4s_u2 | 66.2 | 98.8 | 132.3 | 920.4 | 5.0 | 34.5 | 71.1 | 148.9 | 192.1 | 259.0 | 7.2 | 9.7 | 70.0 | 115.0 | 140.0 | 695.0 | 5.2 | 26.1 |
| prep_spread_4s_u4 | 108.9 | 148.6 | 175.5 | 774.6 | 6.6 | 29.0 | 115.7 | 164.5 | 471.6 | 1486 | 17.7 | 55.7 | 115.0 | 160.0 | 230.0 | 1000 | 8.6 | 37.5 |

#### Event effects (all instances per quantum)

| case | native p50 | p99 | p99.9 | max | p99.9 % | max % | wasm-node p50 | p99 | p99.9 | max | p99.9 % | max % | chromium p50 | p99 | p99.9 | max | p99.9 % | max % |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| event_16_route_only | 2.4 | 2.9 | 17.2 | 24.9 | 0.6 | 0.9 | 3.1 | 6.7 | 26.7 | 47.0 | 1.0 | 1.8 | 5.0 | 10.0 | 30.0 | 40.0 | 1.1 | 1.5 |
| event_16_filter | 15.2 | 28.6 | 37.4 | 63.0 | 1.4 | 2.4 | 16.1 | 31.2 | 41.5 | 52.4 | 1.6 | 2.0 | 15.0 | 30.0 | 40.0 | 50.0 | 1.5 | 1.9 |
| event_16_filter_send | 16.9 | 32.2 | 54.5 | 120.9 | 2.0 | 4.5 | 16.5 | 31.2 | 38.8 | 50.8 | 1.5 | 1.9 | 15.0 | 35.0 | 45.0 | 85.0 | 1.7 | 3.2 |
| event_16_filter_send_auto | 19.4 | 44.3 | 62.0 | 79.8 | 2.3 | 3.0 | 19.1 | 34.5 | 45.2 | 57.2 | 1.7 | 2.1 | 20.0 | 35.0 | 50.0 | 80.0 | 1.9 | 3.0 |
| event_64_route_only | 13.2 | 33.4 | 41.5 | 63.0 | 1.6 | 2.4 | 14.0 | 34.1 | 45.4 | 58.7 | 1.7 | 2.2 | 15.0 | 35.0 | 50.0 | 70.0 | 1.9 | 2.6 |
| event_64_filter | 68.4 | 101.1 | 262.0 | 1462 | 9.8 | 54.8 | 70.4 | 95.2 | 112.1 | 148.5 | 4.2 | 5.6 | 70.0 | 95.0 | 125.0 | 1890 | 4.7 | 70.9 |
| event_64_filter_send | 69.9 | 96.2 | 127.7 | 252.7 | 4.8 | 9.5 | 67.2 | 97.3 | 116.0 | 861.4 | 4.3 | 32.3 | 70.0 | 95.0 | 110.0 | 870.0 | 4.1 | 32.6 |
| event_64_filter_send_auto | 68.4 | 98.1 | 149.8 | 763.1 | 5.6 | 28.6 | 71.4 | 100.4 | 116.3 | 304.1 | 4.4 | 11.4 | 75.0 | 105.0 | 115.0 | 180.0 | 4.3 | 6.7 |
| event_256_route_only | 56.8 | 97.1 | 175.4 | 1142 | 6.6 | 42.8 | 62.4 | 96.6 | 134.0 | 770.2 | 5.0 | 28.9 | 70.0 | 115.0 | 145.0 | 195.0 | 5.4 | 7.3 |
| event_256_filter | 278.3 | 371.8 | 428.0 | 2482 | 16.1 | 93.1 | 294.7 | 369.3 | 656.6 | 1581 | 24.6 | 59.3 | 290.0 | 355.0 | 445.0 | 660.0 | 16.7 | 24.7 |
| event_256_filter_send | 280.6 | 334.1 | 362.3 | 489.3 | 13.6 | 18.3 | 302.5 | 416.1 | 518.5 | 731.5 | 19.4 | 27.4 | 295.0 | 365.0 | 465.0 | 580.0 | 17.4 | 21.7 |
| event_256_filter_send_auto | 293.0 | 351.2 | 548.9 | 953.8 | 20.6 | 35.8 | 323.9 | 474.0 | 927.5 | 2556 | 34.8 | 95.9 | 310.0 | 375.0 | 430.0 | 1460 | 16.1 | 54.7 |

**In-AudioWorklet means** (Chromium OfflineAudioContext, wall time of the render per quantum minus an empty processor's 2.8 us; `Date.now()` gap is the largest time between two `process()` calls at 1 ms resolution; smoke, 3 runs x 4,000 quanta):

| case | wall us per quantum, median of runs | min | max | minus empty processor (median) | % of quantum | max Date.now() gap between process() calls, worst run (ms) |
|---|---|---|---|---|---|---|
| (empty processor) | 2.82 | 2.77 | 3.01 | - | - | 0 |
| single_2s_noise | 25.14 | 24.32 | 26.53 | 22.32 | 0.84 | 1 |
| single_4s_noise | 33.12 | 32.87 | 33.28 | 30.30 | 1.14 | 1 |
| m1_real_1.8s | 23.74 | 23.37 | 35.03 | 20.92 | 0.78 | 1 |
| zones_4x2s_unstaggered | 93.23 | 92.02 | 94.45 | 90.41 | 3.39 | 1 |
| zones_4x2s_staggered | 91.29 | 90.53 | 93.08 | 88.47 | 3.32 | 1 |
| zones_8x2s_unstaggered | 200.99 | 196.11 | 209.95 | 198.17 | 7.43 | 2 |
| zones_8x2s_staggered | 199.04 | 198.24 | 207.97 | 196.22 | 7.36 | 3 |
| blend_2x2s_staggered | 47.37 | 46.98 | 47.95 | 44.55 | 1.67 | 1 |
| event_256_filter_send | 313.61 | 312.68 | 327.79 | 310.79 | 11.65 | 2 |

### Memory per zone and wasm size (final, deterministic)

| IR | partition spectra (kernels) | whole zone (kernels + input-spectra delay lines + rings + accumulators) | head / tail partitions |
|---|---|---|---|
| 1 s stereo | 768 KB | 1,665 KB | 32 / 22 |
| 2 s stereo | 1,504 KB | 3,137 KB | 32 / 45 |
| 4 s stereo | 3,008 KB | 6,145 KB | 32 / 92 |

Shared by all zones on a core: twiddles and FFT scratch, 64 KB. M1's whole region for its 1.8 s IR: 2,945 KB. A zone switch holds the new zone's buffers next to the old one's until the crossfade ends (a 2 s to 2 s switch: 3.1 MB extra). Eight 4 s zones resident: 49 MB.

Wasm (release, +simd128, `std`, with the name section, no wasm-opt; measured as separate cdylib probes so only the convolution code differs):

| Probe | Bytes | Over the empty probe (std + allocator, 18,778) |
|---|---|---|
| `probe_m1`: M1's `convolver::init` + `process` (incl. its IR generator) | 38,827 | +20,049 |
| `probe_zone`: the owned-buffer zone `process`, `Prep` (incremental spectra builder), scratch | 45,680 | +26,902 |

The planner is not in `probe_zone` (schedules would be a table the scheduler holds; it was not measured, expect a few KB for the search and its sort). The whole spike wasm (`convolution_spike.wasm`, 209,937 B) includes the cases and the checks and is not representative. For scale, the mixer's gate is 256 KB and `fft.rs` records that microfft's `rfft_4096` alone would add 92 KB.

## Findings

Smoke numbers: read them as orders of magnitude and ratios, not as budgets.

1. **One zone is cheap.** A stereo zone costs p50 about 13 us at 1 s, 17 us at 2 s and 26 us at 4 s per quantum (0.5%, 0.65%, 1.0% of 2,667 us): roughly 8.5 us fixed (the head stage) plus 4.5 us per second of IR (the tail). M1's own 1.8 s IR measures the same as the generalised copy (17 us). p99.9 is 55 to 120 us (2 to 4%) in smoke. Native and wasm (Node and Chromium) are within about 10% of each other at p50; the earlier spike's "wasm FFT 2 to 4x slower" does not show up with +simd128 here.
2. **Zones add linearly; the peak is the issue.** p50 for 1, 2, 4, 8 zones of 2 s: 17, 35, 74, 170 us native (0.6%, 1.3%, 2.8%, 6.4%); of 4 s: 29, 55, 118, 239 us (1.1%, 2.1%, 4.4%, 9.0%). Memory grows with them: 3.1 MB or 6.1 MB each.
3. **Unstaggered, every zone's transforms land in the same four quanta.** With M1's schedule in each zone the busiest quantum carries N tail transforms (8 zones: 8 x 20.7 us = 166 us of FFT plus the head and multiply-adds; modelled peak 9.4 transform-equivalents at 2 s, 10.9 at 4 s against an average of 4.7 and 7.1). Moving tail work changes the output by 0 bits, so staggering is free to turn on.
4. **"Never share a tail quantum" is only possible up to 4 stereo zones, and is the wrong objective.** A 16-quantum cycle has 16 transform slots and a stereo zone needs 4, so strictly non-sharing schedules exist for N <= 4 (`zones_4x*_unique`: 1 transform in the busiest quantum), but the multiply-adds then have to fit between squeezed forward and inverse slots. For 8 zones the floor is 2 per quantum. The modelled busiest quantum (transform + multiply-add load) says: 4 zones of 2 s: M1 schedule 4.7, load-balanced 2.4, transform-unique 2.9; 8 zones of 2 s: 9.4, 4.7, 7.4; 8 zones of 4 s: 10.9, 7.1, 13.0 (unique is worse than doing nothing). At 4 s the average per quantum is already 7.1 transform-equivalents for 8 zones, so staggering can only remove the peak above that average. **Plan to balance the modelled load, not to keep transforms apart** (`plan_stagger`); it needs to know each zone's partition count.
5. **Measured, the staggering benefit is visible in p99 and hidden in p99.9 and max by jitter at smoke.** p99 native, unstaggered vs load-balanced: 4 zones x 4 s 232 vs 159 us, 8 x 2 s 329 vs 242 us; wasm-node 4 x 2 s 257 vs 169 us. p99.9 and max flip sign between pairs from run to run on this machine. The coordinator's idle run decides whether staggering buys the p99.9; the modelled peak halves for 4 to 8 zones at 2 s and falls by a third at 8 x 4 s.
6. **Blending is two zones plus a negligible gain ramp.** `blend_2x2s` p50 33 to 40 us against `zones_2x2s` 35 to 42: the per-sample send ramp is within noise. Both convolvers must run for the whole crossfade (and its tail afterwards); the engine can drop an idle zone at gain 0 only after its tail has rung out. The crossfade has no discontinuity (checks above).
7. **A zone switch cannot build the IR at once on the audio thread.** At once: 1.3 ms (1 s IR), 2.4 to 2.8 ms (2 s), 4.9 to 5.3 ms (4 s) native, 1.4, 2.7 and 5.2 to 5.8 ms wasm-node, 1.5, 3.0 and 6.0 ms Chromium: 0.5, 1 and 2 quanta in one go. Spread: a 2 s IR is 178 units (rms pass and one FFT per channel and partition; 120 for 1 s, 295 for 4 s). At 1 unit per quantum the playing zone's quantum goes from about 17 us to about 36 us (+19 us) for 178 quanta (0.47 s); at 4 units, +75 us for 45 quanta (0.12 s), p99.9 about 150 us. The spread result is bit-identical to the at-once one, so the cost is only the stretch of time (0.08 to 0.8 s) before the new zone can take over, plus a second set of buffers. The alternative (build on the main thread or a worker and hand the spectra over) was not measured. Before the crossfade the new zone's input history is empty, so its tail builds up from silence; pre-roll was not tried.
8. **Event effects: about 0.9 us per instance, constant in the instance count.** The per-event low-pass costs (event_N_filter minus event_N_route_only) 0.80 us per instance at 16, 0.86 at 64, 0.87 at 256 (native; 0.91 wasm-node): 4 voices per instance, M1's `Biquad`, the instance buffer and its add into the bus. The per-event reverb send adds about 0.01 us more; recomputing the cutoff's coefficients every quantum adds about 0.05 us. At 256 instances the whole scene is 0.28 ms at p50 (10.4% of a quantum) against route-only's 0.06 ms; p99.9 is 0.36 to 0.55 ms native in smoke. For scale, a mixed voice costs 3.0 to 3.8 us (architecture §6.1), so an instance's filter costs about a quarter of one voice. 16 instances (typical) cost 0.015 ms.
9. **Headline for the budget.** On this VM: 4 zones of 2 s cost about 2.8% at p50 and 8 to 15% at p99.9 (smoke); 8 zones of 2 s about 6.4% at p50 and 11 to 19% at p99.9. Whether these fit M3's own budget (owner option c) is the coordinator's call after the idle runs; the low preset (phone) needs its own numbers, and was not measured.

## Unverified

- **All timings.** Shared 4-vCPU VM with other load, smoke sizes; maxima are OS jitter. The staggering effect on p99.9 and max is unresolved; only p99 and the deterministic counts show it.
- **Phone, WebView, other browsers.** Only Chromium 153 headless (`--no-sandbox`) was run; no WebKit or Firefox, no Android, no real audio device. The AudioWorklet runner is an OfflineAudioContext: it runs the wasm in a worklet but renders faster than real time, so it has no device callback jitter, no GC from other tabs, and only mean time (the worklet has no clock; the Date.now() gap has 1 ms resolution).
- **Cache-cold behaviour.** The runs loop hot. Each zone touches its whole kernel and delay line every 16 quanta (3 to 6 MB per zone; 8 zones of 4 s is 49 MB, past most L2/L3 shares), and the real thread shares the cache with 64 to 1,024 voices. The architecture's `pace=1` cold-cache mode was not used.
- **`MAC_WEIGHT`.** The planner's cost model (multiply-add = 0.055 transforms) was measured natively once; wasm's ratio may differ, which would change the best plan.
- **Denormals.** No silent-tail or decayed-state test (IR tails end near 1e-9, inputs never fully silent in the loop; biquad state decaying to zero was not exercised).
- **Event effects scope.** Coefficient changes are applied at the quantum boundary with no smoothing (clicks not examined); voices are table reads rather than real voices (only the routing adds are counted, not the mixing); 4 voices per instance fixed; one reverb bus, not per-zone sends; the `group` plumbing and parameter-batch cost were not built.
- **Zone switch.** Preparation runs on the audio thread in units; off-thread preparation and hand-off over shared memory, pre-rolling the new zone's history, and the allocation of the second buffer set (done in `Prep::new`, untimed) were not measured. `Prep::new` takes the IR as a `Vec` (a copy); the engine would read the decoded clip in place.
- **Correctness coverage.** Direct convolution is compared at a stride of output samples, not every sample; the 4 s IR is checked only on M1's schedule (staggered schedules at 1 and 2 s, extremes bit-identical at 1 s); the wasm check covers 1 and 2 s IRs. 48 kHz only (44.1 and 96 kHz change partition counts, not code).
- **Item 5 (a new non-uniform variant)** was not built: M1's convolver is already non-uniform.
