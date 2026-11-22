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

**D10. Bézier curves (W1-T3, merged).** `"bezier"` is a key form (separate `CURVE_KEY_INTERPS`), not a sixth segment
shape, so old editors keep compiling; missing handles default to the flat third-of-segment handle; every CURVES wire
key carries four handle floats (fixed layout), ABI 4.1, wire minor unchanged; the core precomputes control points
(automation table ~2.4 MB at the default preset, was ~1.1 MB); one key limit (64) in `audioCurveLimit.ts`. Mixer wasm
378,644 B; new metered scene `automation-bezier` (+~1,700 instructions per Bézier binding per quantum).

**D11. Data cleanup (W2-B, merged).** Compressor `knee` 0..40 dB default 30 (the runtime's and Web Audio's); the
migrated Reverb return's reverb is 100 % wet (Wwise/FMOD/DAW practice); legacy values outside catalogue ranges are
clamped on conversion; unknown-length segments: an exit at "end" writes no marker (Exit waits fall back to the end),
a whole-segment loop becomes a continuous round-robin Queue; migration skips dot folders, node_modules, dist, target and
reports (doesn't rewrite) scripts; audio lengths come from header magic (WAV/FLAC/Ogg/Opus/MP3); playlists are
accepted wherever an audio event was (`AudioSource.clip`). Auto-migrate on open is not yet enabled.

**D12. Audio parts kit (W2-K, merged).** Fader keys: arrows 0.5 dB, Shift/PageUp 3 dB, Home/End, 0 = unity; meter peak
hold 1.5 s then 20 dB/s, clip latched; label scrub 1/300 of range per px (log for log params); VCA counted exactly once
down the tree; type badge colours by series index; span statuses ok/virtual/stolen/blocked/error.

**D13. Profiler screen (W2-H, merged).** The live view uses the plugin's existing `captureLiveHost` seam (as the
editor's profiler does); captures save into `captures/capture_NN.mycap` on desktop by reading the saved file back from
storage, in the browser they download (a public bytes-returning save needs a small API change: proposed, not made);
loudness warnings are computed from the meters against the capture's target until captures record them; Record is
enabled while the Studio runtime mixes a voice. No effects-cost track (captures lack the data yet), no zoom yet.

**D14. Playlist runtime (W2-A, merged).** Hosted beside the event runtime on one automation sink, curve table, group id
space and seeded generator (one instance id space for debug and captures). Blend weights, envelopes and voice-time
curves run on the main thread per frame until core time parameters land. Samples with no loop in an untilStopped
playlist loop their region as a held loop; `always` loops survive release (FMOD/Wwise key-off). Stop fades 120 ms.
Only the root playlist's playback rules gate; nested playlists add delay. Weight 0 never plays; glide is a one-pole
filter τ = glide/3. Equal-power crossfades. New public types `AudioMarkerEvent` and `AudioMarkerType` (the `onMarker`
payload ADR 0329 names) and a debug field `Audio.debug().playlistTotals` — covered by ADR 0329's `onMarker` and debug
rules; flagged for review. Gaps warned once: voice pan, high-pass curves, non-filter playlist effects (need submixes),
attenuation curves (M7), Sequences and musical timing (M5).

**D15. Samples screen (W2-D, merged).** Edits stay in source time (ADR 0328) and the timeline draws edited time;
sidecars are opened as documents through a Studio-registered sidecar kind with no file ending (the editor's handling of
`.meta.json` is unchanged); derived samples use the plugin's `derivedSample` kind (coordinator removed a duplicate);
a following fork stores only fields it changed; loop count = how many times the body plays; clips under 400 ms are
measured as one loudness block; Write-to-WAV backups in `.myco/sample-versions/`. Known gaps: audition is approximate
(public one-shots have no start offset — a core/API start offset is scheduled), offline render/cache, re-import and
source versions, tempo/root detection (no detector in the engine; Detect is disabled), changed-on-disk needs the Studio
project watch (W3-F).

**D16. Studio wiring (W3-F, merged).** The audio-only World is an internal Engine option (`audioOnly`, stripped from
published types) so it never becomes a `project.json` bootstrap key; while the editor holds the project, the Studio
records pending moves and rewrites only its own JSON (the editor rewrites scenes/prefabs when it applies them); a
handoff naming the open project never reopens it; browser `?project=` resolves by the newest recent folder with that
mount name (two same-named folders could collide); `Audio.debug().coreUnavailable` (new optional debug field) feeds the
Studio banner; captures are written into `captures/` on every platform via an internal bytes path.

**D17. Shared curve editor (W3-D, merged).** Existing inline curve fields stay inline (e2e specs drag keys in place)
with an "Edit…" button opening the dialog; Apply returns curves and the caller commits one undo step; a new key takes
the previous key's shape; Ease presets use the engine's easeIn/easeOut; a linear range holding 0 snaps through 0 so
0 dB can be hit; keys beyond Max compress toward the axis end on stretch; the distance axis ends at max(60 m, 1.5 × Max);
user presets are a per-user preference. Not built: And by (ADR), the clock selector, built-in property sets.

**D18. Playlists screen (W3-B, merged).** Dropping a shared file into a playlist links it (prototype embedded it);
linked entries aren't expanded in the tree (no loops); changing to Clip refuses non-sample entries; a Blend axis
change keeps entries at the same fraction; removing an entry makes its Switch labels play nothing; clip effects run at
instance level (the format stores playlist effects once); embedded playlists have no names (Make shared gives one);
deleting a file may show the screen's choices dialog and then the engine's delete prompt.

**D19. Mixer screen (W3-C, merged).** The live mix is reached through the engine's `mixer` singleton, confined to
`mixerRuntime.ts` (the live link replaces that file); edits apply live whenever the runtime is up; Compare's A is the
mix at runtime start; snapshots affect only what they list (Wwise/FMOD), fades scale dB linearly; picking a snapshot
auditions it; structural effect edits in a snapshot edit the base chain, parameter values go to overrides; deleting a
bus moves children up; Master's name is locked; bed priority 0..255 with Share/Own/Off. Gap: game parameters have no
authoring home now that Project Settings > Audio is retiring — scheduled (a Parameters panel in the Studio).

**D20. Sequences and musical timing (W3-E, merged).** The sequence playhead is exact (event to event), planned 0.1 s
ahead so every clip voice starts stamped (a parameter change or release reaches it ~0.1 s later; a release from a hold
point acts at once); sync clips play as stamped pieces swapped at piece boundaries (2 ms splice), async clips use the
voice loop; voices already sounding at a hold keep playing; muted/unsoloed tracks still drive the playhead; Exit
fallbacks: clip → loop wrap → sample end, sequence → next loop wrap; `hit` stingers land on the next bar; markers fire on
[from, to), delivered on the next frame with exact `time`. Gaps: `onAudioMarker` component hook and playlist beat
callbacks (need an engine hook), group priming of streamed sync clips, voice pan, reverse.

**D21. Spatial runtime (W4-A1, merged).** Attenuation curves are evaluated in the playlist instance on the main thread
(one frame of lag) because the core's attenuation step wasn't in scope; `AudioSource` min/max act as overrides only
when they differ from the defaults (no new public flag); a spatial playlist with no volume curve keeps the inverse law;
the reverb send stays independent of the dry curve (Wwise aux practice), capped by the send range; `zoneDepth` exists
only on zone-played instances; four new reverb presets map onto the five generated reverbs (own reverb times need
native presets). Gaps (core/native): per-voice spread, beds for zone interiors and `bedBeyond`. New public API
`AudioZone`, `AudioReverbZone.levelDefault`, four preset names (ADR 0333).

**D22. Takes (W4-B1, merged).** Request records 0x10–0x19 (skippable by length, refused without the take flag);
capture format 2 (format 1 refused); 256 MiB cap only with the take flag; requests live outside the ring with seqs
from its counter; take clock = performance.now() from start; instance ids = runtime groups (one-shots from 2^30);
pick paths are `pick` EVENTs after `eventStart` (picks can happen later in an instance's life); MIXOP origin is always
`editor` for now; F10 in exported players only (no touch gesture); no picture frames yet (needs a canvas seam). New
editor SDK contribution point `registerPlayToolbarItem` (flagged: may want a decision-record line). Coordinator merge:
reconciled pick hooks with the sequence node split and removed duplicate capture-bytes functions both branches added.

**D23. Integration pass (W4-G, merged).** Parameters appear as curve inputs named `param:<name>` (a parameter called
"time" can't collide); a voice-curve lane is removed only when flat at its plain value (a flat −6 dB lane is a
deliberate offset); Apply writes only changed lanes; global parameter renames rewrite playlists and events without a
confirm (status bar reports the count) and removal drops automation and snapshot conditions that read it; a "Global
parameters" panel lives in the Mixer (and on demand in Playlists). Gap: playlist instance-level effect automation and
sample effect automation need format fields (scheduled).

**D24. Core time parameters and loop programs (W3-A, merged).** Time parameters are a bit in a binding's param (bit 14 +
which) with group clocks computed only when read (ABI 4.2); voiceTime counts paused time (as main's clock did);
selection sees a time-bound volume curve at its loudest key so fade-ins aren't culled; loop programs hold up to 4 loops
in a pool of 256 programs in the automation region (voice slot stays 192 B; a full pool falls back to the first region);
count = total passes (WAV smpl semantics); seam crossfade reads a post-seam tail; ping-pong turns are continuous; hold
points park silent with fades (ABI 4.3). Fixed-region headroom raised 16 → 18 MiB (a reservation, not a platform limit).
Mixer wasm 396,409 B against the 400 KB tripwire (raise scheduled with the next core item). Not done: voice pan and
high-pass automation targets (design in the report; scheduled).

**D25. Sequence view (W4-D, merged).** Split offsets follow loop passes (the prototype added split time) and the right
half's automation is shifted with a key at the cut; a vertical drag onto a wrong-kind track moves in time only; new
hold points default to while-held + jump, new loops always + finish; a playlist dropped below the tracks makes a
playlist track; drags preview locally and commit one step on release; refusals show as toasts; music-kind samples
default to Sync. Gaps: playback from a start offset (needs the API), overlap crossfade visual, ADSR handles, spectrogram.

**D26. Take screen and replay (W5-B, merged).** Notes live at `<take>.mycotake.notes.json`; note colours are the
designer's RGB data (inline variable), all else uses tokens; pause stops sounds with a 50 ms fade and play rebuilds the
state at the playhead; buses the take touched reset at seek and close; held span = start to RELEASE; parameter lanes
step; the Loop button loops the selected note region else the whole take; the replay slot shows on every screen while a
take is open (a screen may hide it). Gaps: World reseed (picks may differ — needs an internal reseed hook), start
offsets for seeks, the replay capture naming its take.
