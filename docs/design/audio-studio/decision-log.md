# Audio Studio build: decision log

For the owner. Decisions taken while building unattended (owner instruction 2026-11-22: "make any architecture changes
or technical decisions… following industry standards"). Each entry: the question, the choice, why, how to revert.

## Summary

- Needs the owner: (none yet)
- Biggest calls: see entries D1–D3.

## Entries

**D1. Records 0327–0335 accepted.** Owner: "Any new ADRs that need to be approved, go ahead and implement them."
Revert: set the records back to Proposed.

**D2. `audio.json` and the editor's legacy audio panels during the transition.** Until the Studio replaces them (M10),
the editor's Project Settings > Audio and Mixer panel keep working by editing `audio.json` through an adapter between
the new mix model and the legacy section shape; fields the legacy shape can't express (extra returns, VCAs, snapshot
effect overrides) are preserved on write, not dropped. Why: keep `main` usable at every merge. Revert: n/a (transitional).

**D3. Contracts first.** The new formats' TypeScript shapes were committed before wave 1
(`src/engine/audio/{playlist,sample,project,effects,attenuation}/types.ts`) so tasks could run in parallel.

**D4. Migration of audio events (W1-T6, merged).** Lossy mappings, each noted per file at migration time: volume
linear→dB (silence −96 dB), pitch rate→semitones; sustain nodes → a Sequence with a held loop (weakest mapping: a
non-clip loop section re-enters each pass); blend children at range midpoints; rolloff laws sampled into volume curve
keys (beyond max now holds); event filters → playlist low/high-pass effects (exact); `sends.reverb` → the reverbSend
attenuation curve, aux sends dropped (buses send instead); segment stems → sync audio tracks, alternatives → a Queue on
a playlist track; finite region counts, tail beats and quantised automation are noted as lost. Callers must pass sample
lengths (`sampleSeconds`) or whole-segment loops are dropped. Revert: n/a (one-way migration; old files kept in
`.myco/migrated/`).

**D5. Playlist contract additions.** Sequence markers carry `type` (note/cue/exit); clip and sequence `length: 0` mean
"to the end"; a negative continuous-queue gap overlaps with an equal-power crossfade. Revert: remove the fields.

**D6. Editor ↔ Studio integration (W1-T2, merged).** One handoff link per open with a 20 s timeout; the browser reuses
one tab (`myco-audio-studio`); the Studio window in the editor's app outlives the editor window; locks carry a pid
from a `process_id` Rust command and stale locks are never guessed at (pending moves wait for the editor's next open);
pending moves are written before files move and applied first in every watch batch; the browser re-reads on focus and
before Play by size/mtime stamps, not polling; scripts keep their own watch. Not verified: real Tauri builds (no
webkit2gtk in the container; `cargo check` passed with stub pkg-config). Open scene tabs don't yet reload on outside
changes (follow-up). Revert: per item in the W1-T2 report (build log).

**D7. Formats (W1-T4, merged).** Effects at a level their type can't run at are kept with a problem (the runtime
skips them) so they can be moved, not lost. Attenuation presets: linear (gain law), inverse (−20·log10 d/min, holds at
max), exponential (straight dB line to −60 at max), inverse square (silent at max, as Wwise/FMOD treat max distance).
Overlapping sample loops: the later is dropped; a trim not containing a loop is widened. Root note: MIDI 60 = C4. Write
to WAV writes notes, loops, root and tempo; Exit/Hit/Cue markers stay in the sidecar. A missing playlist type reads as
Queue; a new Blend defaults to a voice-time axis. Revert: the named functions in `src/engine/audio/{effects,attenuation,sample,playlist}/`.

**D8. `audio.json` (W1-T5, merged).** Hosts (player, server, export) refuse a legacy `project.json` audio section with
one message; the editor migrates it silently on open (backup in `.myco/migrated/`, one log line, no dialog). dB floor
−60 = silence, ceiling +6.02 dB so legacy gain 2 survives. Snapshot/automation low-pass migrates through a neutral
20 kHz "carrier" low-pass per bus. Migrated snapshots start from code, 300 ms fades, priority 0, override. A bus named
"Master" is the master bus, else the first bus. When both exist, `audio.json` wins. Revert: per item in `src/engine/audio/project/{gain,legacy,format}.ts`, `src/editor/audioProjectFile.ts`.

**D9. Studio shell (W1-T1, merged).** Calibration offsets are a per-user preference shared across projects (audio offset
also pushed to `Audio.calibration` while playing); calibration clicks use a separate Web Audio context (no engine click
yet); single-key-shortcut preference covers character keys only (WCAG 2.1.4); the Studio's Engine is `kind: "runtime"`
with an empty World; the Studio activates only the audio plugin; at most 3 toasts, timers pause on hover/focus
(WCAG 2.2.1); switching screens drops the asset selection; Studio panels can't detach in v1; clicking the project name
closes the project. Known gap: the Studio's World needs a hidden 1×1 view because the audio runtime plays only Worlds
with a view — an audio-only World option is scheduled. Revert: per item (`src/studio/`).
