# Audio M5 (profiler and live mix) spikes

Step 2 of the M5 design pipeline: the survey, and the measurements that the decision record (0170, provisional number) and the technical design will cite. The owner confirmed the goal on 2026-11-12 in [docs/design/0170-audio-mix/goal.md](../../docs/design/0170-audio-mix/goal.md). The shared rules for the spike agents are in [BRIEFS.md](BRIEFS.md).

Each sub-spike has its own README with its method, raw tables and an unverified list. This file collects the answers.

## How the numbers were taken

- **Who ran what.**
  - The agents built each spike and checked its correctness while sharing the machine.
  - The coordinator ran every timed run one after another on an idle machine, 2026-11-12 18:43–18:48 UTC. The load was 0.07 at the start. S2's own spinner Worker raised it to 2.3 during S2, by design, and S3 ran after it at about 2.0. [timed-runs.log](timed-runs.log) records the load at each stage, and [timed-runs.sh](timed-runs.sh) reproduces the runs.
  - Each spike's `timed-*.out` and `results/` folder hold the raw output.
- **The machine:** this session's container, a shared 4-vCPU VM. A quantum is 128 frames, which is **2,667 µs at 48 kHz**.
- **What these numbers are not.**
  - This container is not the lab VM the 0157 budgets were set on, nor the reference machine (assumed 2× faster, provisional).
  - It is not the low-end device either (ADR 0169's floor). Phone numbers stay **unverified**.
  - **Only p50 and p99 can be trusted here.** p99.9 and max follow the VM's scheduling.
  - The wasm instruction counts don't depend on load. They are the stable cost measure, as in M4.
- **Network.** The proxy blocks the documentation hosts (Audiokinetic, FMOD, Unity docs, Epic, ITU, docs.rs, crates.io's API). S0 verified what it could on GitHub: FMOD Core headers vendored in a public repo, Unity's C# reference source, Godot, libebur128 and the Rust `ebur128` crate. Everything else is marked [U].

## Answers

| Question | Answer | Source |
|---|---|---|
| How do others build profilers? | **FMOD Core** exposes the profiler's data to the game too: CPU split into dsp, stream, geometry, update and convolution (`getCPUUsage`), real vs virtual channel counts, and per-DSP peak and RMS metering [V]. Wwise, FMOD Studio, Unity and Unreal all record a **timestamped stream** (a socket or a file) and scrub it with a cursor; Wwise shows voices with kill reasons, Unreal writes `.utrace` files [U]. | [research](research/README.md) Q1 |
| How do others meter loudness? | **FMOD's Loudness Meter is a DSP effect placed on any bus.** It has states RESET_INTEGRATED, RESET_MAXPEAK, RESET_ALL, PAUSED and ANALYZING, and reports momentary, short-term, integrated, 10th and 95th percentiles, a 66-bin histogram, max true peak and max momentary [V]. Wwise meters the selected bus [U]. **Metering master plus the buses the project picks is the industry model.** The game targets (Sony -24 ±2 LUFS and -1 dBTP; mobile -18) are [U]. | research Q2 |
| How do others edit the mix live? | **Unity:** "Edit in Play Mode" (`AudioSettings.editingInPlaymode`); its tooltip says changes are saved automatically while it is on [V]. Wwise, FMOD and Unreal treat the mix as project data that live edits change [U]. M5 keeps live edits always, with no toggle (owner). | research Q4 |
| How do others duck by signal? | **Godot's** compressor sidechain reads the trigger bus's buffer from the same mix pass, so bus order matters. It is a per-sample peak detector with no lookahead [V]. **FMOD** has a compressor sidechain input and an envelope follower [V, parameters only]. **Unity** has a send-based Duck Volume effect [V, UI only]. Wwise auto-ducking is presence-based, with a Meter effect driving an RTPC for signal ducking [U]. | research Q5 |
| Loudness: own code or a crate? | **Own code.** The `ebur128` crate (MIT, 0.1.11) gives the same answers (within 1e-3 LU), but its 100 ms block sums spike. Native per quantum for 8 buses: **p50 30 µs, p99 249 µs, p99.9 1.9 ms**, against **11 / 26 / 41 µs** for our own. The crate also allocates 2.39 MB per stereo bus, needs std, and adds 85.8 KB of wasm against **20.8 KB** (est. before wasm-opt). Our own code is 1,512 B of state per bus, flat from quantum to quantum, and allocates nothing. It keeps libebur128's formulas, with MIT notices. | [loudness](loudness/README.md); timed run `loudness/results/2026-11-12T18-43-39-839Z/` |
| Loudness: correct? | **189 of 189 checks pass**, native and wasm, at 48 and 44.1 kHz (re-run by the coordinator): a 1 kHz stereo tone at -23 dBFS reads -22.99 LUFS; relative and absolute gates; LRA 10 / 5 / 20 LU; ours = the crate on 60 s of music. **True peak reads +0.10 dB high**, because it uses libebur128's interpolator rather than BS.1770 Annex 2's table, which the blocked ITU host serves. That is assumed within EBU Tech 3341's tolerance [U]. The EBU test files themselves weren't run [U]. | loudness |
| Loudness: what runs where? | **On the audio thread:** K-weighting (two f64 biquads per channel), 100 ms sub-block energies and 4× true peak (48 taps, simd128). **On main:** momentary, short-term, gated integrated and LRA from those energies, with a fixed 24 kB histogram per bus (within 0.11 LU of exact). **STATUS carries 28 B per metered bus**, and a ring of 4 sub-blocks so the idle cadence (48 quanta = 128 ms) loses none. | loudness |
| Loudness: what does it cost? (wasm, all buses together, µs per quantum, p50 / p99) | Master with full true peak: **2.2 / 3.1**. 8 buses with full true peak: **20.7 / 45.0**. 8 buses with **true peak gated** to quanta whose sample peak is ≥ -6 dBFS: **10.3 / 24.7** (13.8 / 36.3 on a hot signal). The gated true peak matched full true peak exactly on music. Instructions: 42.6k per bus with full true peak, 23.9k gated. For reference, today's peak meter for 8 buses costs 4.1 µs. | loudness |
| Audio-thread CPU: how to measure it in a worklet? | AudioWorkletGlobalScope has **no `performance`**. `Date.now` steps in whole ms. `SharedArrayBuffer` needs cross-origin isolation, and **no host in the repo sends COOP/COEP** (`src/export/webBuild.ts:286`, `vite.config.ts`, `src-tauri/tauri.conf.json`; coordinator-checked). Chromium has no `renderCapacity`; `playbackStats` counts underruns only. **Method: sum `Date.now()` deltas around each `process()` and report a windowed average.** Unbiased (bias ≤ 3.6 permille at every load). p50 error is **7–15 permille at a 96-quantum window (256 ms)** and 3–4 at 384. A single STATUS block is ±23–32. Two clock reads cost 94 ns each. | [cpu-clock](cpu-clock/README.md); `timed-s2.out` |
| Audio-thread CPU: per section? | **The core's work-unit model, refitted live** against the measured total, gives each section's share. At a 24-quantum window it is within 1–20 permille p50; the build constant `NS_PER_WU = 1` (`native/audio/crates/audio-core/src/cap.rs:101`) was 2× off without the refit. A SharedArrayBuffer counter (recalibrated) is a little better but needs isolation and costs a whole core for its spinner Worker. | cpu-clock |
| Capture: how big? | Binary records (STATUS as received, main-side events, a voice-table keyframe each second), compressed only on save. Per minute at 64 / 256 / 1,024 live voices: **0.51 / 1.59 / 5.04 MB in memory, 0.08 / 0.15 / 0.25 MB saved** (deflate-raw, `CompressionStream` = zlib byte for byte). JSON is **8.4 / 18.7 / 49.4 MB**. The scenes are **synthetic**, with real STATUS bytes but invented activity (est.). The coordinator re-ran the size pass: identical. | [capture](capture/README.md); `timed-s3.out` |
| Capture: what does recording cost main? (µs, p50 / p99, at 64 / 256 / 1,024 voices) | STATUS raw copy **0.6 / 1.3 / 3.2** (p99 1.4 / 2.2 / 8.5). Binary delta 2.8 / 4.9 / 10.7. Keyframe (once a second) 5.5 / 18 / 63. Event 0.1–0.2. JSON costs 3–8× the time and allocates 2.4–10.7 KB per STATUS. **The delta encoder still allocates ≈ 370 B per STATUS block**; the design must remove that (a preallocated ring). At 1,024 voices recording is ≈ 0.7 ms per second of main time (est. from p50 × 62.5 blocks per second + one keyframe). | capture |
| Capture: editor side (10-minute capture) | Index from keyframe headers: 2.2 / 5.0 / 14.7 ms. Full decode with overview: **241 / 413 / 834 ms**. **Jump to any moment: p50 0.2 / 0.3 / 0.7 ms, p99 0.7 / 1.0 / 1.9 ms**, whatever the capture's length. | capture |
| Capture: saving per platform | **Web:** a Blob download (`showSaveFilePicker` on Chromium desktop only). **Desktop and Android (Tauri):** `Storage.save(key, bytes, "cache")` through `TauriStorage` to app data, already allowed in `src-tauri/capabilities/default.json`. **Getting it off Android:** `adb exec-out run-as` on a debug build [U]; no route on a release build without a share-sheet plugin [U]. The file header (magic `MYCAP`, format, wire `SCHEMA_HASH`, rates, preset, name table) refuses a mismatched wire cleanly (tested). | capture |
| Sidechain ducking: cost | **One rule (peak or RMS detector per sample, gain computer once per quantum, gain interpolated per sample): 0.5–0.6 µs wasm p50** (6.8–8.1k instructions). **8 rules: 5.0 / 11.4 µs** p50 / p99. The once-per-quantum computer is within 0.024 dB of per-sample. Attack and release time constants verified. | [mix-core](mix-core/README.md); timed run `mix-core/results/2026-11-12T18-44-59-758Z/` |
| Sidechain ducking: bus order | The core mixes children before parents, siblings by index. **The default "Voice ducks Music" (`src/engine/audio/settings.ts:14`) and sound-lab's SFX → Music read the trigger a quantum late** (36 of 90 bus pairs in sound-lab, 438 of 992 in stress). A late quantum costs at most 0.54 / 1.06 / 2.45 dB at a 50 / 25 / 10 ms attack, in the first 2.7 ms only. **Adding trigger → target edges to the bus sort at BUS_CONFIG removes the delay for every rule in both samples, at no audio cost.** Only a trigger that is the target's ancestor is a cycle. | mix-core |
| Bus fades and snapshots | **Today's real fault is lag, not zipper.** Main sends BUS_MIX ramps of one frame interval, clamped to 5–50 ms (`src/plugins/audio/runtime/core/lookahead.ts:33-37`, coordinator-checked). The heard gain trails the intended curve by **18 ms at 60 fps and 35 ms at 30 fps** (21–38 ms with late updates), with error at -38 to -49 dB rms and no audible step. **A stamped bus ramp is exact (5e-8) and cheaper**: 8 ramping buses cost 0.48 µs wasm against 1.27 µs today, with no quantum split. | mix-core |
| Live edits | **Every edit applies in place, with no core rebuild, in the same quantum.** They fall into three classes:<br>- **Clean:** bus volume (ramped), filter cutoff, a reverb send's level or first send, appending an effect or a bus.<br>- **Clicks unless smoothed:** a compressor threshold step (-18 dBFS step for 6 dB; blended per quantum over ≥ 20 ms it's smooth).<br>- **Clicks unless crossfaded:** an edit that shifts effect slots (-19 dBFS, state reset), moving a voice or changing a parent, inserting a bus mid-tree (-17 to -13 dBFS), removing the last send (the tail cuts, and a stale tail replays on re-add).<br>Index-stable bus and slot numbering avoids most crossfades. | mix-core |
| Effect-parameter blending | Recomputing biquad coefficients once per quantum costs **+370 instructions** and adds nothing audible over per-sample (1.01–1.19× the per-sample second difference; a hard switch is 3.5×). Exact per-sample recompute costs 115k instructions and isn't needed. | mix-core |

## What this means for the design

1. **The audio-thread cost is small and flat.** Loudness, sidechain and stamped ramps together cost tens of µs, about 1% of a quantum, with p99 close to p50 (no block-boundary spikes). The risks are elsewhere: main-thread recording, editor UI, wasm size.
2. **The loudness meter is our own small `no_std` module in the core,** with libebur128's formulas and MIT notices. The audio thread does filtering, energies and true peak. Main does all gating and statistics from 28 B per bus per STATUS. True peak runs always on master and is gated by sample peak elsewhere. Its state and reports follow FMOD's model (reset, pause, M/S/I/LRA, max true peak).
3. **`loadPermille` gets real values everywhere, with no new headers.** It comes from `Date.now()` sums averaged over ≈ 256 ms. Per-section shares come from the work-unit model refitted live. The profiler labels the figure as smoothed. Cross-origin isolation is a separate decision, not M5's.
4. **The profiler's data is a binary stream:** STATUS blocks as received, main-side events with reason codes, and a keyframe each second. It is held in a preallocated ring and compressed only on save. The same stream is the capture file and, later, the live link's payload. The recorder must stop allocating (a design requirement) and must not ship in release exports unless the developer asks for it.
5. **The mix moves into the core where timing matters:**
   - stamped bus and master ramps for fades and snapshots (exact, and cheaper);
   - sidechain detectors in the core, with trigger → target edges in the bus sort;
   - per-quantum parameter smoothing for compressor thresholds and filter blends.
6. **Live edits need index-stable bus and slot numbering.** Edits that shift structure (parent changes, slot moves, mid-tree inserts, removing sends) crossfade between the old and new routing. Everything else applies directly.
7. **Android capture export is the open platform gap.** A debug-build adb route exists [U]. A release build needs a share sheet, which is a Tauri plugin and a new dependency, or no capture on release builds at all. That's for the owner.

## Performance targets (proposed, for the record)

**Audio thread, per quantum.** The figures are this container's wasm p50 / p99, with at least 50% headroom. The reference-machine factor (assumed 2× faster) is not applied, so the allowances are conservative.

| Item | Typical case | Worst case | Measured here (wasm p50 / p99) | Allowance |
|---|---|---|---|---|
| Loudness | master + 3 picked buses, gated true peak | master + 7 buses, full true peak | 1 bus 2.2 / 3.1; 8 gated 10.3 / 24.7; 8 full 20.7 / 45.0 | typical **0.01 ms**, worst **0.07 ms** |
| Sidechain | 2 rules | 8 rules | 1 rule 0.6 / 0.7; 8 rules 5.0 / 11.4 | typical **0.002 ms**, worst **0.02 ms** |
| Stamped bus ramps | — | 8 ramping | 0.48 µs, less than today's 1.27 | **0** (a saving) |
| Parameter smoothing | — | compressor + filter blends | +370 instructions per filter; compressor blend ≈ settled | in the effects' existing cost |
| CPU clock | — | 2 `Date.now` reads | 0.19 µs | **0.001 ms** |
| **M5 total, high** | | | | **typical 0.015 ms, worst 0.09 ms** |
| default / low | low meters master only; default master + 3 | | cost model (est.) | default 0.015 / 0.05 ms; low 0.005 / 0.01 ms |

**Main thread.**

| Item | Measured (p50 / p99) | Target |
|---|---|---|
| Recorder, per STATUS (62.5 per second while active) | raw copy 0.6–3.2 / 1.4–8.5 µs; delta 2.8–10.7 µs | ≤ 1 ms per second at 1,024 voices, **zero allocation per block** |
| Keyframe, once per second | 5.5–63 / 15–98 µs | inside the above |
| Loudness gating and statistics | not measured (a histogram update per 100 ms sub-block) | ≤ 50 µs per second (est.) |
| Editor: jump to a moment in a capture | 0.2–0.7 / 0.7–1.9 ms | < 16 ms (one frame) |
| Editor: open a 10-minute capture | 0.24–0.83 s | < 2 s, off the UI thread if needed |

**Memory and size.**
- **Per metered bus:** 1.5 KB of core state and a 24 kB histogram on main.
- **Capture ring:** about 4 / 16 / 32 MB on low / default / high (est.). It holds 6–7 minutes at 1,024 voices.
- **The wasm mixer** grows by ≈ 21 KB for loudness (est., before wasm-opt) from 318,306 B. That **passes the 320 KB tripwire.** Per the owner's rule, the build log records the reason; no feature is held back to stay under it.

## Still unverified

- **Everything about real devices.** The phone, Firefox and WebKit worklet scopes (`Date.now` resolution, isolation), big.LITTLE effects on the CPU figure, and a real audio sink rather than the null one.
- **True peak's +0.10 dB** against BS.1770 Annex 2's own table, and the real EBU Tech 3341/3342 test files (the ITU and EBU hosts are blocked).
- **The game loudness targets** (Sony ASWG -24 LUFS ±2, -1 dBTP; mobile -18), and Wwise's, FMOD Studio's and Unreal's profiler and live-edit behaviour, beyond FMOD Core's headers and Unity's source.
- **Capture data rates on real scenes** through the real core. The scenes were synthetic.
- **Main-to-worklet latency for a live edit:** the core applies an edit in the same quantum it arrives, but main's own wait wasn't measured.
- **The compressor's click cause:** inferred as an unsmoothed gain step; `compressor.rs` wasn't read.
- **Getting a capture off an Android device:** adb on a debug build; a share sheet on a release build.
- **The lab-VM and reference-machine runs** (the owner's).
