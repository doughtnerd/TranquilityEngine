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
