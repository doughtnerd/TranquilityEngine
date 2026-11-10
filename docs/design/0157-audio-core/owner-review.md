# Decisions for the owner's review (ADR 0157, M1)

The owner asked (2026-11-10) that, while the build runs unattended, decisions that would normally go to the owner are made by the coordinator in line with the design goals and industry practice, and listed here for review. Each entry gives the question, what was chosen and why, and what changes if the owner decides otherwise. Newest last. Entries the owner has already confirmed are marked.

## Made before the unattended run (not yet explicitly confirmed)

### 1. Voice presets "low" and "high" (A2.4)
- **Question:** the design gives numbers only for the default preset.
- **Chosen:** low = 48 mixed, 1,024 logical, 4 HRTF, 64 MB clip memory; high = 256 mixed, 8,192 logical, 32 HRTF, 256 MB. Only low's 4 HRTF voices come from the design. Low is provisional until the C3 soak on the low-end Android phone sets it.
- **Why:** low is about a third of the default, which is typical for mobile tiers; high doubles the default.
- **If changed:** edit `VOICE_PRESETS` in `src/plugins/audio/editor/audioSettingsModel.ts`.

### 2. An `at` time already reached plays at once, uncounted (A3.2)
- **Question:** what counts as a late command.
- **Chosen:** an `at` not after the frame the core will be rendering when the batch arrives (up to about 50 ms ahead of `Audio.time`) plays as soon as possible and isn't counted late. Only commands sent ahead of time that arrive late count.
- **Why:** that's the signal the adaptive cap needs (main-thread lateness, not game code scheduling in the past).
- **If changed:** `isStamped` in `src/plugins/audio/runtime/core/lookahead.ts`.

### 3. Limiter look-ahead at 192 kHz (A2.9)
- **Question:** the delay line was sized for 5 ms at 96 kHz.
- **Chosen:** kept; at 192 kHz the longest look-ahead is 2.5 ms (the 1.5 ms default is unaffected).
- **Why:** 192 kHz output is rare in games; sizing for it costs about 11.5 KB more per core.
- **If changed:** the delay-line capacity in `native/audio/crates/audio-dsp/src/limiter.rs`.

### 4. Underrun bound in the Sound Lab spec (A2.6)
- **Chosen:** 0 underruns at start, at most 2 by the end of the run, in headless CI.
- **Why:** headless software rendering shares the CPU; a real fault underruns every quantum. The strict zero applies to the C3 soak machines.

### 5. A rebuild keeps the running preset (A3.4a)
- **Chosen:** a rebuild after a trap uses the preset the core started with, not a changed one (`pendingPreset`).
- **Why:** the voice table, the clock's latency and the bus count are sized for it; changes take effect on the next start, like the limiter look-ahead.

### 6. Per-voice pause holds where its 5 ms fade ends (A3.7)
- **Chosen:** a paused voice holds 5 ms (240 frames at 48 kHz) past the pause point and resumes from there.
- **Why:** the 192-byte voice slot is full; holding at the exact pause point needs 8 more bytes per voice, over architecture §5.1's slot size. Nothing is skipped or repeated.

### 7. One compressor per bus on the core (bus-memory change)
- **Chosen:** a bus runs its first 4 effects and at most one compressor; extras are kept in the settings with a problem and skipped by the core.
- **Why:** cuts bus memory from about 10.9 KB to 4.2 KB; mixers rarely stack two compressors on one bus.

## Made during the unattended run

(Entries are added below as they are made.)

### 8. Stall recovery timing (A3.4c)
- **Question:** §3.7 says a stalled context is rebuilt, but not how long to wait or when to give up on the same context.
- **Chosen:** a stall first rebuilds in the same context and waits 2 s for the new core's first STATUS; if none arrives, or the page stalls again within 10 s, it moves to a new context. Both attempts count against the 3-per-60 s limit.
- **Why:** a same-context rebuild is cheaper and fixes most worklet stalls; 2 s is well under the 5 s start-up limit; counting both attempts keeps a crash loop bounded.
- **If changed:** `STALL_REBUILD_STATUS_TIMEOUT_MS` and `STALL_ESCALATE_WINDOW_MS` in `src/plugins/audio/runtime/core/recovery.ts`.

### 9. MS5 merged to master
- MS5 (A3.1–A3.4c, A3.6, A3.7, A2.9) merged after its exit check, under the standing instruction. Not run: WebKit and Firefox (no Docker), a real hidden tab, a real device change.

### 10. Decoder build choices (B1)
- **Chosen:** symphonia `=0.6.1` (the newest release; the design pins 0.6.1); default formats WAV, FLAC, MP3, Ogg Vorbis, with AAC/MP4 behind a cargo feature `aac`; the decoder **exports** its own memory (it runs alone in a worker, unlike the mixer, which imports); the wasm name section is **stripped** (−112 KB; stack traces show function indices); built with `+simd128` like the mixer; seeks drop leading frames inside the decoder; reads stop at a container's stated length.
- **Why:** each keeps the decoder small and its worker simple; stripping names is standard for shipped wasm.
- **Licences:** symphonia is MPL-2.0 (file-level copyleft, shipped unmodified, with the source location in `THIRD_PARTY_NOTICES.md`); the rest MIT/Apache/Zlib. No GPL/LGPL.
- **Open for B4:** the `aac` build is 1,037 KB, over the 900 KB gate, and symphonia's MP4 reader ignores the edit list, so AAC keeps 1,024 priming frames (gapless AAC must trim them).

### 11. A flaky test outside audio (noted, not fixed)
- `src/engine/tests/navSample.test.ts` (navigation, ADR 0065) fails about one run in three, even alone (`expected true to be false`, or a timeout in the full run). No navigation code changed in this work. Left alone rather than fixed inside the audio milestones; worth a separate task: make the test deterministic (fixed-step frames or fake timers) without loosening what it checks.

### 12. HRTF panner bank: 32 panners, allocated when the table loads (H3)
- **Question:** the bank holds 32 HRTF panners (the `voices.hrtf` maximum): 682 KB at ≤ 88.2 kHz, 1.04 MB at 96 kHz; the architecture estimated about 300 KB for 16.
- **Chosen:** keep 32, allocated only once the HRIR loads (so `"equalPower"` and `voices.hrtf: 0` pay nothing).
- **Why:** sizing it to `voices.hrtf` needs that number in the core, which is a wire or ABI change (K1 is frozen); the owner has accepted higher HRTF memory for M1 with optimisation after the roadmap (2026-11-09).
- **If changed:** pass `voices.hrtf` at init (an ABI addition like A2.9's) and size the bank to it.

### 13. HRTF kernel budget: 2 kernel computations per quantum (H3)
- **Question:** the architecture says 4; a kernel costs about 43 µs native (≈2× in wasm).
- **Chosen:** 2 per quantum. A direction change past the budget keeps panning on the last direction one more quantum; new panners start one per quantum.
- **Why:** keeps the worst quantum bounded (p99 ≈ 0.5 ms with 16 HRTF voices turning, in wasm) while 16 moving voices still crossfade as often as a crossfade can run. Industry HRTF engines similarly spread filter updates across blocks.
- **Open, for A3.5:** a moving HRTF voice costs about 20 µs per quantum in wasm, over the work-unit model's 6,600 (≈6.6 µs; static voices are 5–7 µs). A3.5 re-measures and should model kernel computations in the cap.

### 14. Strip the mixer wasm's name section (coordinator)
- **Chosen:** `--strip-all` on the mixer wasm (as B1 does for the decoder): 135.2 KB → 122.4 KB after HRTF, output unchanged.
- **Why:** standard for shipped wasm; restores headroom under the 150 KB gate before streaming lands. Cost: a trap's stack trace shows function indices (debug natively, or drop the line in `audio-wasm/build.rs`).
