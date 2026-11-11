# Audio M4 (interactive music): goal and constraints

This is step 1 of the design pipeline, the goal interview. The owner confirmed it on 2026-11-11.

The decision record (0163, not yet written) and the technical design build on this statement. Where they differ, this statement wins until the owner changes it.

The working rules in [../0162-audio-spatial/working-notes.md](../0162-audio-spatial/working-notes.md) carry over unchanged:
- no runs that can't change a decision;
- follow industry standards;
- no feature flags or compatibility defaults;
- intensive tests at wave end and milestone end.

## Goal

Interactive music built into the engine, as part of ADR 0157's goal: "AAA-quality mixing and control built into the engine," for an engine meant for fully open-source use. M4 is the interactive-music milestone on 0157's roadmap.

## Scope (owner)

1. **Tempo and bar grid**, including **tempo and metre changes** within a piece of music. Metre is the time signature.
2. **Quantised transitions.** A change of music waits for the next beat, bar, cue or exit point.
3. **Transition segments.** A segment is a piece of music with its own tempo, cues and stem tracks. A transition segment is a bridge, intro or outro chosen per from→to pair (Wwise's transition matrix, FMOD's transition timelines).
4. **Stingers.** Short phrases played over the music that land on the grid.
5. **Stems.** Layers of one piece, faded in and out, for example by a game parameter.
6. **Playlists.** A sequence, random or shuffled order of segments, with loop counts.
7. **Beat callbacks to scripts.** Scripts get beat, bar and cue notifications and can ask for the music's position.

## Authoring model (owner: "both, as one model")

- **One data model** that covers both Wwise's and FMOD's way of working:
  - **Segments** carry a **tempo map** (tempo and metre can change inside a segment, which Wwise can't do), **cues** (entry, exit, custom), **loop regions** and **stem tracks**.
  - **Playlist and switch containers** and a **transition matrix** sit above the segments.
  - **Stingers** attach to containers.
- **Editor in M4:**
  - a **segment view**: a waveform, the bar grid, tempo and metre markers, draggable cues and regions, and one lane per stem;
  - a **transition rules table**.
- **Deferred:** free arrangement of many clips on a timeline (composing inside the engine, FMOD-style).
- **Follows industry practice:**
  - Wwise Interactive Music for the structure;
  - FMOD for tempo markers, regions and quantised transitions on a timeline;
  - Unreal Quartz for the clock and quantised scheduling.

  Where M4 differs from these, the record says so and why.

## Sync target (owner)

- **Default: music-tight.**
  - The music itself is sample-accurate: transitions, stingers and stem starts land exactly on the grid.
  - Scripts hear about beats within about 1–2 frames, through a latency-compensated music clock.
  - Always on.
- **"Rhythm mode": a project setting, not a compatibility flag.** It turns on:
  - lower output latency (a smaller buffer and lookahead, at a cost in CPU headroom and glitch risk);
  - input timestamps judged against the audio clock;
  - a calibration helper ("tap to the beat").

  Action games leave it off and pay nothing for it.

## Budget (owner: own budget)

- M4 gets **its own audio-thread budget**, with a higher total on high or fewer voices elsewhere, decided from measurements.
- Music logic (grid maths, choosing transitions) should still run on the main thread wherever sample accuracy allows. The audio thread's share is measured and capped.
- Size gates remain tripwires for bloat, not design limits (0158).

## Constraints (owner confirmed; carried over from M3)

- **Licence:** open source only, with no per-title licences. BSD, MIT and similarly permissive code may be ported in with its notices kept.
- **Platforms:**
  - the editor on desktop and web;
  - published games on web, desktop and Android (system WebView).
- **Fallback:** **best effort** on the Babylon backend; the full feature set on the core.
- **Low-end device:** an Android phone on the lowest Android version Google Play accepts (the "low" preset). Phone numbers stay **unverified** for now. The lab-VM run is the owner's.
- **Users:**
  - players hear it;
  - developers script it;
  - composers and sound designers author it in the editor.
- **Who uses the engine today:** only the samples. There is no compatibility work; the samples are updated instead.

## What exists today (read from code, 2026-11-11)

| Area | Today | Where |
|---|---|---|
| Musical timing | None: no tempo, beat, bar, cue or stinger anywhere in the audio code. Events have `delay` in seconds (0..60) | `src/engine/audio/eventFormat.ts:103` |
| Scheduled starts | `at` on `playOneShot` and `play` (seconds, on `Audio.time`). Stamped records apply at their sample offset; a late record applies at offset 0 and counts in `lateCommands` | `src/plugins/audio/runtime/Audio.ts:33`; `native/audio/crates/audio-core/src/scheduler.rs:34-43` |
| Earliest exact time | `backend.horizon()` = now + lookahead L, where L = clamp(2 × frame interval, 1024 frames, 100 ms). Not public | `src/plugins/audio/runtime/core/lookahead.ts:11-31`; `coreBackend.ts:995` |
| Heard clock | `Audio.time`, per frame, independent of pause and `Time.scale`. `ClockMap` subtracts output and limiter latency. STATUS every 6 quanta | `Audio.ts:233`; `core/clock.ts:83` |
| Streams | Opt-in per clip (`stream: true`). Count is mixed/16, clamped 4..16 → 4 / 8 / 16. Ring of 32,768 frames. A stream waits for 4,096 frames before it starts. No aligned starts between streams | `native/audio/crates/audio-core/src/stream.rs:24-27, 118-120` |
| Long music | Decoded whole unless the clip sidecar says `stream: true`. Clip memory is 64 MB on low, the default arena on default, 256 MB on high | `audioSettingsModel.ts:235-237` |
| Stems today | sound-lab's `music-intensity` event layers three looping WAV stems; a global parameter fades two of them | `samples/sound-lab/audio/events/music-intensity.audioevent.json` |
| Event chaining | Continuous containers schedule the next child at end + gap from the known clip length. For an unknown length (streams) it starts one frame late | `src/plugins/audio/runtime/events/eventRuntime.ts:1161-1173` |
| Mixer | Bus fades, snapshots and ducking advance on main in `mixer.update(dt)`, ramped over one frame: not sample-accurate. Ducking counts voices, not signal | `src/engine/audio/mixer.ts:63, 155-210` |
| Presets | low 64 mixed / 4 HRTF / 0 beds; default 128 / 8 / 2; high 256 / 8 / 4 | `src/plugins/audio/editor/audioSettingsModel.ts:235-237` |
| Budget | High: 1.19 of 1.3 ms after M1 (≈ 0.11 ms left for M2–M4). M3 adds ≈ 0.10 ms typical and 0.42 ms worst. High is already over 1.3 ms p99.9 on the lab VM | `docs/design/0157-audio-core/README.md:58,67`; `docs/design/0162-audio-spatial/README.md:38,44` |
| Babylon fallback | `at` only for decoded clips (`waitTime`). Streams are HTML5, flat, whole-file loops. No seek, no `horizon()` | `src/plugins/audio/runtime/babylonBackend.ts:85-91, 284-287` |
| Seek | `AudioSource.seek()` is `@internal` and needs a record. The PLAY record carries `start_offset_frames` | `src/plugins/audio/runtime/AudioSource.ts:204-211` |
| Editor | Event editor (tree, properties with the SDK `CurveEditor`, parameters, audition), audio settings, bus meters, debug panel. No timeline or waveform view | `src/plugins/audio/editor/` |
