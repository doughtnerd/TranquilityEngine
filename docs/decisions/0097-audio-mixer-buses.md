# 0097. Audio mixer buses, snapshots and ducking over one shared AudioContext

- **Status:** Proposed; amended by 0157 (the model is kept, the Web Audio bus graph is replaced by the core) and 0166 and 0167 (presets gain the music ring pool and the rhythm-mode setting)
- **Date:** 2026-11-07
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0006, 0074 (resolves its open question on mixer buses), 0010, 0098

## Context

Audio is `AudioSource` and `Audio.playOneShot` on Howler (0006, 0074) with a single master volume. Games need Music, SFX, UI and Voice volumes in an options menu, music that ducks under dialogue, and a muffled mix in the pause menu. Howler already owns one `AudioContext` and a master `GainNode`, so buses can be Web Audio nodes in that context.

## Decision

- **Project setting.** `project.json` gets an `audio` section: `buses` (a tree; the first is the root, default `Master` with `Music`, `SFX`, `UI`, `Voice`), `snapshots`, `ducking`, `backend` (0098). Parsed leniently by `parseAudioSettings` (`engine/audio/settings.ts`); problems are warned at start and shown in Project Settings.
- **Bus.** Name, `parent`, `volume` (0..2 linear), `mute`, and an ordered `effects` list: `lowpass`, `highpass` (frequency, q), `compressor` (threshold, knee, ratio, attack, release) and `reverb` (a send to one shared convolver with a generated impulse response, so no file ships). Up to 32 buses.
- **Mixer model** (`audio/mixer.ts`) is pure state: effective gain is volume × snapshot × ducking up the tree, zero when muted or when another bus is soloed (a soloed bus, its descendants and the ancestors it passes through stay audible). It is backend-independent.
- **Snapshots** are named sets of per-bus volume multipliers and low-pass cutoffs; `Audio.snapshot(name, fade)` fades to one, `Audio.clearSnapshot(fade)` back.
- **Ducking** rules (`target`, `trigger`, `amount`, `attack`, `release`): while the trigger bus has playing voices, the target eases down to `amount` and back. Trigger detection is voice activity, not signal level.
- **Web Audio graph** (`audio/busGraph.ts`, Howler backend): per bus `input → effects → snapshot low-pass → gain → parent input`; the root feeds Howler's master gain. Sounds are re-routed from Howler's master gain to their bus input (the panner when spatial). Clips streamed as HTML5 audio (0040 `stream`) can't be routed: they only get their bus's effective gain as volume, no effects.
- **API (engine only, no Howler types).** `AudioSource.output` (bus name, a dropdown in the Inspector fed from the project's buses; empty or unknown falls back to the root with a warning), `Audio.playOneShot(clip, { bus })`, `Audio.bus(name)` returning a `Bus` with `volume`, `mute`, `solo`, `fadeTo`, `activeVoices`, `effectiveGain`, `Audio.buses`, `Audio.snapshot`, `Audio.clearSnapshot`. Script-set volumes are runtime state and are not saved to `project.json`; persisting a player's volume is the game's job (`Storage`).
- **Editor.** Project Settings > Audio edits buses, effects, snapshots, ducking and backend through the panel's undo history. One mixer and one audio context are shared by all Worlds, as Howler already was.

## Alternatives considered

- **Per-World mixers.** Only the viewing World plays sound (0074), so one global mixer is enough and keeps one AudioContext.
- **Gain-only buses (Howler's `volume`).** Cheap, but no effects, no solo-through-tree, and every voice's volume needs recomputing on every bus change.
- **Level-based ducking (analyser sidechain).** More accurate, costs an analyser per trigger bus per frame; voice activity covers dialogue, the common case. Can be added behind the same rule shape.
- **Authoring the mixer only in FMOD Studio.** See 0099.

## Consequences

**Positive**
- Options-menu volumes, ducking and pause muffling without a library change; the same settings drive a future FMOD backend's buses.

**Negative / costs**
- Re-routing uses Howler internals (`_soundById`, `_node`, `_panner`), which can break on a Howler upgrade; the unit tests mock Howler, so routing is only verified by hand in a browser (see the guide).
- Streamed clips bypass effects. Changing the bus tree at runtime (`configure`) rebuilds the graph; sounds already playing keep their old routing until they restart.
- Master volume is still Howler's master, outside the bus tree.

## Deprecates

The "no mixer buses" limitation in 0074.

## Open questions

- Level-based ducking; per-bus metering for the editor; reverb zones; persisting `Audio.bus` volumes automatically.

## Amendment (0166, 0167): the presets gain music settings

The bus graph, snapshots and ducking are unchanged: music plays on the `Music` bus (or the bus a stem names) like any sound, and ducks, fades and snapshots with it. What changes is the voice preset.

- **`audio.music.rings`.** Each voice preset carries a music ring pool, the streamed stems a music instance can hold open at once, including those of the next segment while it is prepared: **low 8, default 12, high 16** (the project value is a whole number 0 to 16, written in `project.json` and edited in Project Settings > Audio > Playback > Music; the preset comparison includes it, and a value that differs from the preset's makes the preset read `custom`). The rings are the last entries of the core's stream table, so general streams and music streams cannot take each other's slots. Each ring is a buffer of about 300 KB, so a preset's stream memory grows by `rings x 300 KB` (low 3.69 MB, default 6.14 MB, high 9.83 MB in all with the general streams).
- **Music voices count inside the preset's mixed-voice cap** (0166 owner decision 3). A stem is a voice and is selected by priority like any other; no voice is added to a preset for music, and the per-preset worst-case allowances were re-set in 0167 §1 item 3.
- **`audio.rhythmMode`** (default `false`), also in Project Settings > Audio > Playback > Music. While it is true the audio context is built with `latencyHint: 0`. It is a project-wide mixer setting, not a per-bus one; a change at run time rebuilds the context, and the music re-enters on the next bar (0167 §2). It refuses nothing.
- **Ducking and the music bus.** Beat callbacks are timed on the heard clock, so a bus fade, snapshot or duck on `Music` never moves a beat. The Flappy sample dips the `Music` bus to 35% over 0.4 s on game over with `Audio.bus("Music").fadeTo`, which is the intended use of this record's API on music.

## References

- `src/engine/audio/`, `docs/guide/audio-mixer.md`
