# Audio Studio build: decision log

For the owner. Decisions taken while building unattended (owner instruction 2026-11-22: "make any architecture changes
or technical decisions… following industry standards"). Each entry: the question, the choice, why, how to revert.

## ADR renumbering (merge with master, 2026-11-23)

Master took 0327–0340 for its own records (core memory export, INIT wire record, linker, browser-spec rules, decoder
HRIR/MagLS prep, script compiler settings, WebRTC transport, snapshot parts, input system, UI focus navigation). The
Audio Studio's records were renumbered by +14, keeping their order. Every reference on the audio branch (records,
code comments, tests, guides, this folder) was rewritten before master was merged, so in this tree 0327–0340 always
mean master's records. Old numbers in commit messages before the merge mean the audio records below.

| Old | New | Record |
|---|---|---|
| 0327 | 0341 | The Audio Studio is its own app and replaces the editor's audio panels |
| 0328 | 0342 | Samples: an audio file plus non-destructive edits in its sidecar |
| 0329 | 0343 | Playlists replace audio events and interactive music |
| 0330 | 0344 | The mix moves to `audio.json` (returns, VCAs, blending snapshots) |
| 0331 | 0345 | One effect catalogue runs at four levels |
| 0332 | 0346 | One curve model (Bézier keys, time as a core parameter) |
| 0333 | 0347 | Attenuation curves on playlists, audio zones and spatial test scenes |
| 0334 | 0348 | Takes record what the game asked of audio; captures stay telemetry |
| 0335 | 0349 | Studio screens are built from one component kit |
| 0336 | 0350 | Playlists shape blends, fades, tails and quantised automation |
| 0337 | 0351 | Audio is encoded per platform at export and shipped in packages |
| 0338 | 0352 | Third-party audio effects are sandboxed wasm modules (DSP plugins) |
| 0339 | 0353 | Quantise reaches pitch, pan, filters and entry voice curves |
| 0340 | 0354 | Localised audio in per-language folders, voice-over from line tables |
| 0341 | 0355 | Dynamic dialogue events |
| 0342 | 0356 | Text localisation through keyed string tables |
| 0343 | 0357 | Subtitles from string tables and a built-in display |
| 0344 | 0358 | Plugin glue, fuel and worklet compile rules (B0 spike) |
| 0345 | 0359 | Audio encoding follows the A0 spike |
| 0346 | 0360 | Sound generators |

The spike reports moved with them: `spikes/0337-a0.md` → `spikes/0351-a0.md`, `spikes/0338-b0.md` → `spikes/0352-b0.md`.

## Summary

- Needs the owner: (none yet)
- Biggest calls: see entries D1–D3.

## Entries

**D1. Records 0341–0349 accepted.** Owner: "Any new ADRs that need to be approved, go ahead and implement them."
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
payload ADR 0343 names) and a debug field `Audio.debug().playlistTotals` — covered by ADR 0343's `onMarker` and debug
rules; flagged for review. Gaps warned once: voice pan, high-pass curves, non-filter playlist effects (need submixes),
attenuation curves (M7), Sequences and musical timing (M5).

**D15. Samples screen (W2-D, merged).** Edits stay in source time (ADR 0342) and the timeline draws edited time;
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
`AudioZone`, `AudioReverbZone.levelDefault`, four preset names (ADR 0347).

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

**D27. Spatial screen (W5-A, merged).** The screen reaches the Studio runtime World through `World.active` while the host
is playable (a host seam is a follow-up); changing the active listener is an undo step (it's in the file); no 100×70 m
clamp (engine space is unbounded); height range grows to fit; bypassed or flat attenuation lanes are left out on Apply;
new obstacles use the project's default occlusion material; Space pans inside the Scene panel and plays elsewhere;
scene "Move" changes the scene's folder field, not the file; deleting a scene is undone by recreating it. Gaps: base
game scenes aren't loaded under the audition (no loader into the Studio World), A/B replacement UI, 3D physics in the
Studio for test-scene occlusion, live positions/zoneDepth in the readout, shared field rows still in the Playlists
folder (to lift into components).

**D28. Engine follow-ups (W5-C, merged).** Playlist instance automation counts voiceTime from when that playlist level
starts (FMOD-style instance timeline); playlist markers/beats/bars arrive in late update; `onMusic("cue")` on a playlist
is a no-op (cues are markers); the MIXOP origin is a synchronous dynamic scope (`withMixOpOrigin`) rather than an
argument on `Mixer.apply`; sequence pick `choice` = clip index over all tracks; music-kind samples default to Sync via
`defaultClipSync`; the editor's Profiler opens takes (by extension, decode still checks the take flag). New public
API: `onAudioMarker` lifecycle hook, `EventOptions.minDistance/maxDistance`, `handle.onMusic` for playlists, format
fields `PlaylistBody.automation`, `SampleEdits.automation`. Gaps closed: D20 (onAudioMarker, beat callbacks), D22
(sequence picks, MIXOP origins), D23 (format fields). Still open: Studio parameter renames don't rewrite playlist
instance automation inputs; Studio undo/redo MIXOP origin.

**D29. Native mix model (W6-C, merged).** The runtime mixer runs `audio.json`'s model; `toRuntimeSettings` is replaced
by views (`runtimeView.ts`: the backends' bus tree, the editor's legacy view). One snapshot model shared by the runtime
and the Studio (`project/snapshots.ts`, `snapshotPlayer.ts`): overrides crossfade from what lies under them while
fading (FMOD intensity style), interrupted fades turn round proportionally, linear-dB fades sent as ≤50 ms linear-gain
segments; the VCA lane rides the wire's authored lane (fader × VCA); returns live on the main thread (the core has no
bus-to-bus sends) and reach the core through each bus's reverb send level; mute silences sends on main; insert cap 8
(the core's 4-effect limit stays a warning rule); seven project live ops (upsert by name, `from` for renames).
**Behaviour change:** `Audio.snapshot(name)` with one argument now returns an `AudioSnapshot` handle without starting
it (ADR 0344); `Audio.snapshot(name, fade)` still starts it. Revert: make the one-argument form start with 0.5 s.
Core features still needed (listed for a core task): bus-to-return sends with slots, a dB-linear ramp law, a VCA wire
lane, 8 effects per bus and the catalogue's bus effects, smoothed effect parameters, automation of any effect parameter
and send, core-side send muting, ducking with returns.

**D30. Core pan/high-pass, start offsets, submixes (W6-A, merged via a merge task).** Mono pan is equal-power
normalised so centre is unchanged (+3 dB hard-panned), stereo is balance; spatial voices ignore pan (FMOD 2D panner
practice); sends are unpanned; a high-pass floor ≤ 20 Hz is no floor (ABI 4.4). Start offsets ride the existing PLAY
`startOffsetFrames` (sample-exact, no fade); `offset` applies to whatever an instance starts synchronously. **New public
API:** `OneShotOptions.offset`, `EventOptions.offset` (needed by audition, sequence transport and take seek; covered by
ADR 0343/0348's seek and audition requirements — flagged for review). Submixes: a fixed 64-slot core pool, one per
instance carrying the root playlist's/sequence's effects (track, clip and nested effects keep per-voice mapping),
routing only for voices on the submix's bus, unknown effect kinds pass through (ABI 4.5). Mixer wasm 403,838 B; the
tripwire was raised 400 KB → 512 KB (native/audio/build.mjs, reason: ADR 0345 submixes and the DSP catalogue to come).
Merge decision: pan/high-pass time lanes become core bindings per voice start (one conversion point). Known follow-ups:
the core curve table (1024, never freed) can fill with per-voice shifted curves on long instances with time-keyed
pan/high-pass lanes (fix: a time origin per binding); instance low-pass automation can't open above a submix's fixed
cutoff (needs submix parameter automation).

**D31. Editor audio panels retired (W7-A, merged).** Removed: the Event editor, music panels, editor Mixer and
Profiler, Audio Debug panel, Project Settings > Audio (now a pointer with "Open in Audio Studio"), the op log, "Create
event from clips". The editor's D2 legacy adapter is gone (D2 retired): the editor no longer edits audio data; the
runtime serves `coreSectionOf`. Double-clicking a Studio file whose kind has no panel opens it in the Studio. The
occlusion-rays toggle moved to a Scene toolbar "Audio" popover. Migration on open in both apps asks once; declining
in the Studio opens the project read-only with a "Migrate now" banner. New internal SDK member
`editor.openAudioStudio(target?)` (`@internal`, keeps plugins importing only `editor/sdk`; flagged). The `audioEvent`
kind keeps format/references so old files still list and play until the runtime half retires them. E2E specs whose
subject was a removed panel were deleted (7 specs, 2 helpers); others were edited (listed in the W7-A report) — none
run yet. Lost authoring paths with no Studio equivalent yet: "Create playlist from clips" in the editor. Closes D11's
"auto-migrate not yet enabled".

**D32. Event and music player runtime retired (W7-B, merged).** Samples migrated by `npm run audio:migrate`, then
hand-fixed: the migration turns a looping clip into an async clip in a looping sequence, which plays its sample once,
so the engines went silent; their loop regions are now held loops in sidecars (follow-up: the migration should do this).
Not restored in the samples: the engine blend's overlapping fades (now neighbour crossfades), `music-loop`'s tail,
`music-world`'s linear/S-curve transitions (now equal-power), bridge fades, beat-quantised intensity automation. Two
playlist runtime bugs fixed (sequence loop wrap within float noise; an Exit marker exactly at a sequence's end). The
`audioEvent` editor kind stays as a listing "Audio Event (old format: migrate)" with clip references, so a declined
migration can't lose clips. `engine.AudioMusic` system removed; music node/rule types dropped from `myco` exports (ADR
0343 deprecates them; handle and event types stay). `Audio.debug().music` kept as `[]` so public types hold. E2E specs
that used events or music players (`audio-music-*`, `audio-events`, `sound-lab-touch`, `projects`) need porting at the
e2e phase.

**D33. Migration places loops in sidecars (W8, merged).** A plain looping clip → Clip playlist with `loop: "inherit"`
and an endless sidecar loop; a sustain clip → a one-clip Sequence with a held sidecar loop (`exit: finish`); clips under
a sustain's loop section → held with the sustain's exit (release now+fade → crossfade, now → jump, loopEnd → finish),
exactly as the old runtime behaved. Equal sidecar loops are reused; a conflicting one makes a derived sample
`<name>.loop<n>.sample.json` (lineage duplicate/follow, holding only that loop). Risk accepted (as in the hand fix): a
sidecar loop applies to every use of the file. Found: the runtime didn't resolve derived samples at all — a task
(W8-B) is adding it to the clip resolver.

**D34. Core DSP catalogue and bus sends (W7-C, merged).** All kernels live once in `audio-dsp::fx` with caller-owned
memory (buses, submixes and a future offline render share them); large state in a 20 s stereo `FxMem` region (7.7 MB
at 48 kHz, first-fit, swept after configure; starving passes through and counts). Choices worth review: delay lines
1.5× time (250 ms–2 s); saturation `tanh(gx)/g` (level-safe); EQ corners fixed 250 Hz/1 kHz/4 kHz; limiter without
look-ahead, sample peak (no delay compensation in the mix); sidechain attack fixed 5 ms; formant shift by order-16 LPC
(costliest: 20.6 M instructions a quantum per submix); a second legacy compressor now runs instead of being dropped.
Merge fixes: the live-op merge (`legacy.ts`) mapped effects by the old shown-set while the view showed the core's, so
an edit on a bus with an EQ would hit the wrong effect — now maps by `coreShown` and writes catalogue params by name;
a bus past the insert cap no longer also warns about compressors. Mixer wasm 469,339 B (512 KB tripwire not raised).

**D35. Derived samples at runtime (W8-B, merged).** The backend sees the source file (`PlayRequest.path`), so the
decoded buffer is shared; a snippet's range intersects the block's trim; a following fork of a fork reads its
parent's *resolved* block (ADR wording) — the Studio's `sampleSession.ts` reads one level only (to align).

**D36. Owner decision (2026-11-22): restore the lost music/blend behaviours as format features.** "Yes, I want all
4. The 5th sounds useful for rhythm games though." Task W9-D adds to playlists (new ADR 0350 amending 0343/0346):
blend overlap widths, music tails (post-exit), transition fade shapes, bridge fades, and beat-quantised automation
(on the instance's musical clock, for rhythm games); the migration maps the old fields and the sample projects regain
what D32 lists as not restored.

**D37. Sample plan on every play; what a render contains (W9-C, merged).** A flattened render keeps the source's
timeline and bakes only the effect chain, its automation and the normalisation gain; trim, cuts, closed gaps, loops
and markers stay in source time and still apply (the reading where loops and markers keep working; ADR 0342 was not
explicit). `sample.source` is a project path, else a bare name beside the source. Clip voices (one-shots,
AudioSource, zones) loop the first loop region forward and endlessly (held until `release()`); full loop programs stay
playlist-only. One-shots never loop. The render task was told to match this.

**D38. Music tails come from Exit markers, not a new field (coordinator, after an owner question).** The Samples
screen's Pickup and Tail are derived loop-playback regions (trim start → first loop, last loop → trim end) and already
play. The musical post-exit tail (W9-D) is the audio after a sample's or sequence's Exit marker, Wwise's exit-cue model:
on a handover the outgoing section rings past it to its end; no Exit marker = no tail (today). Exit markers work on
any sample, looped or not, so no extra "mark a tail" tool is needed. Optional Entry/pre-entry likewise.

**D39. Blend overlaps are per-entry regions (coordinator, after an owner question).** Today a 1D entry is a point:
layers ramp in from the previous point and never end; crossfades span the whole gap. W9-D gives each 1D entry an
optional region (start, end, fade-in and fade-out widths with shapes), like FMOD parameter-sheet instruments and Wwise
blend-track ranges; unset regions derive from today's rules so old files keep their weights. The 1D lane draws
draggable trapezoids. 2D blends unchanged.

**D40. 2D blends get per-entry weight curves; fade shapes everywhere (coordinator, after an owner question).** 2D
regions aren't the norm (Wwise/FMOD blend 1D per parameter and nest for 2D; Unity's 2D blend trees shape by point
placement) and can't end without holes, so a 2D entry instead gets an optional weight curve (raw blend weight → gain)
edited in the shared curve editor, with presets matching the fade shapes; the same curve is an advanced override on
1D entries. Fade shapes (one shared type and evaluator) apply to every crossfade: Switch transitions, Queue continuous
overlaps, loop crossfades, bridges, tails, 1D regions. Unset = today's equal-power behaviour.

**D41. Offline render (W9-B, merged).** Separate wasm (`audio-offline`, 136,571 B, own 256 KB tripwire) reusing
`audio_dsp::fx` and the core's curve evaluator (`Curve::from_keys` added, ABI unchanged). Render = 32-bit float WAV on
the source timeline (D37); normalize applied after the chain (ADR 0342 order); tails until −90 dBFS (cap 10 s).
Choices to review: reverse left out of renders with a warning (would move every source time); every effect type
bakes, even those not allowed at sample level; fades and the envelope span the whole file. Note for later native
work: the shared source hash changed, so any branch touching `native/audio/**` must re-run `npm run build:audio`
after merging. Float WAV playback relies on symphonia's `wav`+`pcm` (IEEE float supported).

**D42. ADRs 0351 (per-platform encoding, packages) and 0352 (DSP plugins) accepted (W10-C).** Choices to review in
0351: strict packages by default (Wwise/FMOD; `strict: false` = Unity-style on demand); unload fades voices 50 ms;
`auto` codec re-encodes WAV/FLAC to Vorbis (changes existing exports; `codec: "source"` restores); converted files keep
path and extension; streamed media ships loose; Opus in the default decoder build; contributors rebuilding the
encoder need wasi-sdk. In 0352: plugins are sandboxed wasm with no imports, called inside every chain; fuel metering
always on (est. 20–50% on tight loops, to measure); ABI 5.0 widens effect records to 16 params; no latency
compensation or custom UIs in v1; fault policy dry-pass, recreate, disable after 3 faults/s. Both start with spikes
whose numbers may change the records.

**D43. Base scenes in the Studio (W10-B, merged).** The base is a filtered copy (audio components + 3D colliders,
with ancestors) loaded additively through `SceneManager`, never the full scene (game scripts and unrun plugins would
throw); `AudioListener`, `RigidBody`, character controllers and 2D colliders are left out (static snapshot, the test
scene's listener hears); per-World filters dropped. The Studio now activates the physics + Rapier runtime halves
(lazy-loaded). `core/zoneIr.test.ts` failed again under full-suite load (passes alone) — recurring, needs a task.

**D44. W9 and W10 merged: returns on the core, playlist shaping (ADR 0350), takes and renames.** Full Vitest after:
804 files, 8926 passed, 0 failed. Choices to review:
- *Returns (W9-A):* returns share the core's 32 slots after the buses (a non-reverb return that doesn't fit is left
  out with a warning); `Audio.buses` now lists returns too (behaviour change); a removed send fades out muted; the old
  `addEffect {type:"reverb"}` op is refused (use `setSend`); >4 sends is a warning; a presence duck keyed by a return
  never ducks (no voices; FMOD/Wwise use level). Babylon fallback plays returns silent.
- *ADR 0350 (W9-D):* `ChangeHow.tail` on by default, so an existing cut at an Exit marker now rings its tail;
  `SequenceLoop.tail` off; tails ring only on cuts (crossfades fade, as Wwise); quantise is per lane and gain-only
  (non-gain targets warn) — for rhythm games, quantising pitch/filter/effect params is a follow-up; log/exp shapes use
  exponents 1.41/2/3 as 12 stamped pieces; a beat-timed cut now fades exactly at the boundary (bug fix: it stopped
  0.25 s early). Seen: a sequence started with no stamp is first heard ~22 ms late on loopback.
- *Takes (W10-A):* META `seed` now holds the World's generator state (older takes may pick differently on replay);
  pictures on by default (game builds opt out in `game.json`); effects-cost track is a per-section estimate until the
  core reports per-effect cost; renames follow the runtime's instance-wide local-parameter shadowing.

**D45. Owner (2026-11-22): agrees with all recommendations; moving emitters must really work.** "a user does have
the ability to have an emitter follow a path (to test Doppler type stuff, etc). I do want that to actually work - Im
fine if that movement is in the spatial scene only though." The route motion existed in the test scene player with a
position-only fake-backend test; W11-F makes it work end to end in the Spatial screen (the Studio's frame loop drives
the player, Doppler heard on the core and measured in a loopback test, no pitch spike at a loop wrap, live position in
the plan view).

**D46. Moving emitters (W11-F, merged).** Most of it already worked (the Engine's own frame loop steps the Studio
World; Doppler correct on the core); broken were a pitch spike (+150 cents, ~50 ms) when a looping route ends near its
start (the wrap jump was under the teleport guard's threshold) and the plan view never showing motion. Velocity now
carries across a near-closed wrap (gap ≤ max(5 m, 2·maxSpeed·dt)); longer gaps jump and are zeroed. The Inspector
shows Doppler as ratio + cents.

**D47. Samples detection, re-import, render cache (W11-C, merged).** Detection uses the existing UI (Detect buttons,
the import's "Detect what's missing", the "Detected" chip; checked against the prototype's Samples artboard, which
has exactly these plus Tap tempo, already built). Choices to review: the 120 BPM octave prior (a plain click track
above ~185 BPM reads at half tempo; 2× is offered); confidence floors 0.35 tempo / 0.5 root at import, 0.2 on
demand; re-import defaults to Keep seconds (Wwise/FMOD keep absolute marker times), keeps the file extension, and
undo restores the old audio via `sample.sourceVersion`; exports render baked samples as `<stem>.render-<hash12>.wav`
(normalize-only isn't rendered; non-WAV sources ship without effects, with a warning); Entry markers reuse the exit
marker token, dotted. Measured: 60–179 BPM click tracks within ±0.26 BPM; 204 test tones, 0 wrong notes.

**D48. W11-E merged (smaller items).** Quantise on pitch/pan/filters and entry curves is recorded as ADR 0353
(amends 0350; quantum-accurate, not sample-accurate). An unstamped sequence whose clips are still loading now starts
as late as its data (was up to 588 frames ahead of its sound); picks are redrawn on each restart. "Create playlist
from clips" lives in the Playlists Library (one sample → Clip, several → Queue of Clips; undo is a toast that deletes
the file, since creating a file isn't a document step). An emptied number box now restores its value instead of
committing 0. `--no-take-pictures` requires `--audio-take`. `zoneIr.test.ts` fixed (waited a fixed 20 ms; now waits
for the service's answers: 5/5 under heavy load).

**D49. Per-level submixes (W11-B, merged, ABI 4.9).** One submix per level with effects (nested playlist, sequence
track, clip), not a chain per voice: a clip's delay or reverb must ring after its voice ends; per-voice delay lines
would drain `FxMem`; overlapping voices of one level share one chain (FMOD's model). Routing costs nothing measurable
(metered `submix-levels` 6.97 M vs `submixes` 7.14 M instructions/quantum); shaped loop seams cost +0.9% mean.
Mixer wasm 471,630 B. Supersedes D30's "track, clip and nested effects keep per-voice mapping" while a submix is free.
Coordinator choice: gain added to the instance level in the catalogue (the core runs it there). Tails ring after a
stop with fade (FMOD allow-fadeout). Known red after merging: the clip-delay loopback (interaction with W11-E's
unstamped restart or quantised bindings); a fix task is running.

**D50. The post-merge red was a real ordering bug (fixed).** A voice's ROUTE (its level submix) was staged asap, and
the writer's frame sort moved it ahead of a stamped PLAY, which clears the voice's route on the core — so any stamped
voice in a level with effects played dry. It showed only once W11-E's restart began stamping loading voices. ROUTE now
carries its PLAY's stamp, as AUTOMATE and LOOPS already did; covered by a writer unit test and a loopback test.

**D51. Mix automation in the core (W11-A, merged, ABI 4.10).** Full Vitest after: 827 files, 9072 passed, 0 failed.
Choices to review: a snapshot override wins over core automation while it holds a parameter (glides back after);
automated effects always travel as catalogue effects; frequency curves are sent as log2; send automation sums dB per
receiving slot; submix automation is dropped when its group changes (ringing tail); submix inputs can't be
`voiceTime`/`clipTime` (those lanes keep the per-voice path); undo vs redo is read from the history tree. New members
flagged: `Audio.debug().mix.fxStarved`/`fxStarvedOwner` (public debug type), `AudioSubmixes.automate`/`SubmixLane`
(backend seam, internal). Mixer wasm 472,160 B.

**D52. ADRs 0354 (localised audio, voice-over) and 0355 (dynamic dialogue) accepted (W13 design).** The engine has
no text localisation, so subtitle text lives in line tables keyed so a later text record can move it. **Owner
questions, each proceeding on its default unless answered:** (1) UI text localisation now? default no; (2) which
languages? default per project, new projects `en` only; (3) built-in subtitle widget? default no — text +
`Audio.onLine` + a guide recipe; (4) lip-sync generator in the Studio? default no, import Rhubarb output; (5) playing
VO on language change? default finishes; (6) on-demand language packs? default every shipped language in the build;
(7) remember the player's language? default yes; (8) one line per speaker, max 3 at once? default yes; (9) dialogue
memory in saves? default engine provides memory()/restore(), saving is the game's; (10) languages in `project.json`,
Studio edits only without an editor lock? default yes. Choices to review: per-language folders with references to the
reference language's file; project-unique line keys and event names; subtitle-only playback for lines missing in
every language; dialogue as its own asset (not a playlist type); take replay re-decides by default.

**D53. Owner answers on localisation (2026-11-22).** (1) Text/UI localisation: "Yes, add it" — a new record (0356)
designs string tables for UI text, and subtitles move into them (0357 amends 0354). (2) Subtitles: after comparing
engines (Unreal ships basic built-in subtitles; Unity, Godot, Wwise, FMOD give data and callbacks only;
accessibility guidance expects adjustable size, a background box and speaker names), the owner chose "Optional
built-in": text + `Audio.onLine` events as the base, plus a drop-in subtitle component built only on those public
events, with a player on/off setting; games can replace it. (3) Language packs: all shipped languages in the build.
(4) Lip-sync: import only (Rhubarb output). Other 0354/0355 questions proceed on their defaults (D52).

**D54. ADRs 0356 (text localisation) and 0357 (subtitles) accepted.** Owner questions proceeding on defaults unless
answered: script API named `Locale` (`Text` is taken); no bundled CJK/Arabic fonts (guide points to Noto); subtitles
on by default on first run, sound captions off; RTL layout mirroring deferred (RTL text works). Choices to review:
an engine-owned ICU MessageFormat 1 (<4 KB est.) instead of `intl-messageformat` (9.8 KB) or Fluent; `t:<field>`
attributes in UI documents; line-table `text` removed (one copy of each subtitle, in string tables); voice follows the
text language by default; 15 chars/s reading speed with per-language defaults; captions via a new public
`Audio.onCaption`; `textAlign` default becomes `start`; `myco.subtitles` is its own plugin, on in new projects.

**D55. Native spatial (W11-G, merged, ABI 4.11).** Spread = point part + decorrelated diffuse part (w = s/360; an
amplitude-only spread can't decorrelate a mono source on two ears — Unreal/Resonance diffuse practice); zone spread wins
over the playlist's; anything inside a zone (edge or inside kind, and an inside zone's feather) goes to the bed at 360°
(ADR 0347's "plays non-spatially", rendered enveloping); bedBeyond and zone beds are decided on main in the panner pick
(ADR 0162's split); stream loops are forward only (ping-pong/backward play forward with a warning; FMOD/Wwise streams
also loop forward); preset times from EAX families. Mixer 475,285 B; metered +0.07%. Wave 11 complete.

**D56. W12 first round merged (0351 A1/A2, 0352 B1/B2).** Choices to review: encoding settings fall through a profile
chain (nearest profile → rule's → default → built-in) rather than 0351's single profile; the encoder has its own
source hash so core contributors never need wasi-sdk; Opus encodes mono/stereo only (ambisonic files fall back to
Vorbis); loose ADPCM has no container (packages carry frames) — A3/A4 decide; no dither on 16-bit/ADPCM; plugin
`maxInstances` cap 128 (default 16), ≤ 256 effects per plugin; plugin params arrive in declared units; fuel mode caps a
plugin's memory at `memoryMB`; start functions refused; SDK at `native/fx-sdk/`.

**D57. Export and package runtime (W12-A3/A5, merged).** Sound Lab (51 sounds, 6.3 MB sources) exports to 0.64–0.81 MB
per platform with the built-in defaults. Choices to review: loose ADPCM ships as Vorbis (ADPCM lives in packages, as in
Unity/FMOD/Wwise banks); lenient packaging in a build skips the play and starts one load; `audio-report.json` sits at
the build folder root (inside a plain web build); an unknown package name rejects `load()` with one warning; script
loads are owned by the active World and dropped at Play stop. Public API added (0351 §9): `Audio.package`,
`Audio.packages`, `AudioPackageLoader`, `AudioPackage`, reason `notLoaded`, `Audio.debug().packages`. Coordinator
fixes found by the merge: `npm run build:player` failed the lazy-only rule (the take service from W4/W10 sat in the
capture folder; now exempt with a reason), and the export CLI couldn't resolve vite's bin.

**D58. Core codecs (W12-A4/A7, merged).** ADPCM on the core measures 49.9 dB SNR; Opus 38.3 dB from a 64 kb/s
fixture. Choices to review: ADPCM cursor memory always laid out (2,176 B per mixed voice, ≈278 KB at 128); Opus seek
pre-roll 0.5 s (80 ms measured too coarse; ≈1.5 ms of worker time per seek); libopus symbols renamed via a committed
`rename.h` (regenerate if the vendored opus changes); building the decoder now needs a clang with the WebAssembly
backend (no wasi-sdk); the decoder client keeps a main-thread copy of packages for respawn (doubles their memory; the
integration task decides). Merge fix: the runtime's `media` seam and the core's `codecs` capability were the same
thing built twice; unified on `codecs`. The two halves of package playback (runtime blob URLs vs decoder packs) were
never connected — an integration task is wiring them. Mixer 497,970 B of the 512 KB tripwire.

**D59. Plugins in the core and package playback wired (W12-B3/B4 and integration, merged).** Full Vitest
(engine, audio, Studio, export) after: 630 files, 7205 passed. Plugin glue on the real core: 0.18–0.33 µs per call
(matches the spike); 32 tremolos on 4 buses 163 µs per quantum. Mixer 501,602 B (tripwire 512 KB not raised). Choices
to review: plugins are on wherever the core runs (no engine gate; 0358 §6 asked for one only if JSC/SpiderMonkey fail,
still unmeasured); the fuel cap is per chain level; "disabled" is per effect type; `myco_ext` has five imports
(describe and sweep added); package bytes are re-fetched on a decoder restart rather than kept twice; a load counts as
complete once its copies are queued while output is locked (no gesture yet); the stream-head hand-over is two stamped
voices (no ABI change; pitch or pause during the head can shift the seam). Merge fix: both branches added a capability
to `AudioBackend` at the same spot; kept both.

**D60. W12 finished except docs/e2e; W13 formats merged.** Plugins: sets load in editor, Studio and player; exports
ship modules; offline renders run plugin effects; Studio cards, health and Reset. **Engine gate on by default** (0358
§6, conservative): plugin modules run only on Chromium/V8 until JSC and SpiderMonkey are measured; override
`project.json` `plugins.audioEffectEngines: "all"` — the owner may prefer them on everywhere. Encoding Studio: Packages
is screen 7 in a new "Ship" group (Wwise/FMOD treat banks as a build stage); an all-platforms `load` override mirrors the
legacy `stream` flag; Hear as serves converted audio under each sound's own path; exact sizes on a button (CPU, cap 2).
Open owner question: should derived samples get their own `encoding` block? W13 L1/T1/S1/D1 formats are pure and
unexported; the playlist `line` entry waits on a side branch until the runtime/Studio switches handle it; ICU
parse+format is 3.0 KB gzip; `@formatjs/icu-messageformat-parser` added as a devDependency (test oracle only).

**D61. Locale runtime (W13 T2–T4, merged).** Public API added (0356 §6): `Locale`, `LocalText`, `LocaleLanguage`,
`MessageArg(s)` from `src/engine/index.ts`; `LocalizedText` from `myco`; `UITextAlign` gains `start`/`end` (default
`start`, identical in LTR). Choices to review: `keep-all` keeps meaning "never wrap" (CSS meaning would change Latin
wrapping, against 0356 §12); a superseded `setLanguage` resolves without switching (no unhandled rejections); system
language counts only for drawing runtimes; editor Play doesn't persist the language; `Locale` is a process global like
`Graphics`; in RTL the input field aligns to its start edge.

**D62. Studio Dialogue screen (W13 L5/L6/D4/S4, merged).** Dialogue is screen 8 (Author). Choices to review: a
duplicated line is `<key>_2` keeping the original's subtitle via `textKey`; a key rename keeps the subtitle and
recording names (`textKey`/`file` = old key); script CSV columns `key,table,speaker,notes,<languages…>`, deleting lines
missing from a CSV only on an opt-in; the preview chip is hidden for single-language projects; the Studio rewrites
`project.json` whole when editing `languages`, only while no editor lock is held; "Duck Music under Voice" is −6 dB,
80/400 ms; coverage runs synchronously (capped) rather than in a worker. Auditions use the Studio's clip path until the
audio runtime (L2/D2) merges.

**D63. ADR 0360 (sound generators) accepted.** Owner questions, proceeding on defaults unless answered: (1) edited
inside the Playlists screen; (2) blips band-limited (no "retro aliased" option); (3) the Babylon fallback renders
generators through the offline module; (4) mono generator voices; (5) pool size derived from `max_mixed`; (6) no
snapshot overrides of generator parameters in v1; (7) no automatic bake at export; (8) bakes are float32 mono 48 kHz.
Per-voice costs are estimates until G2 measures them.

**D64. Audio localisation and dialogue runtime (W13 L2/S2/D2/D3, merged).** Public API added: `Audio.language`,
`setLanguage`, `pendingLanguage`, `subtitleLanguage`, `languages`, `line`, `onLine`, `onCaption`, `say`, `dialogue`;
`EventOptions.line`; nine reasons; `AudioSpeaker` and line/dialogue types. Choices to review: SAY records carry the
generator state so replay is exact anywhere in a take; arguments matching only `*` replay as defaults; the playlist
`{event}` form updates dialogue memory but skips event cooldown, chance and channels (0355 §3); under `followText` the
voice ignores its own remembered language. Follow-ups: `settings.dialogue` must join the `audio.json` format
(coordinator item), take keyframes don't hold lines.

**D65. W13 localisation export and editor, W14 G1 merged.** Choices to review: exports keep variant files that any
shipped language's chain reaches (fr-CA → fr resolves in builds as in the project); the build's `project.json` marks
left-out languages `ship: false`; line tables ship stripped instead of a richer index; an imported translation over
`maxLength` is skipped (not imported as needs review); the editor preview language shares the Studio's key; Extract
from the Inspector never writes Studio-owned tables; changing a language code doesn't rename files; exports of
translation files download through the browser. Live texture swap on a language switch waits on the renderer
listening to `Assets.onChanged`. Coordinator fix: `Audio.setLanguage` in separate mode now loads package parts before
committing (it had a placeholder); a switch with nothing to load stays synchronous. G1: locks are arguments not file
data; Mutate advances the seed; blip `level` in dB; synth waves default to saw.

**D66. Subtitles plugin and generator core merged.** Subtitles: public API `SubtitleDisplay`, `Subtitles`,
`SubtitleSettings`; the overlay toggle lives in the plugin's editor half (import rules); paging uses a character
estimate. Generator core (ABI 5.1): mixer +37.3 KB, tripwire 512 → 576 KB (record estimated 10–15 KB). **Raised with
the owner:** the blip costs 2.38× a sample voice (0360's tripwire 1.5×, estimate 1.1×), and two-sample PolyBLEP leaves
the worst alias at −25 dB at 3.5 kHz (estimate −40 to −60 dB). Other defaults built: blip parameters latch at trigger
(only `level` glides, as sfxr); sfxr's ×0.05 master volume dropped for `level` in dB (−12 default); GEN seed 0 keeps the
voice's seed. Coordinator fix: `LocalizedText` declared before `UIDocumentSync`.

**D67. Owner (2026-11-23) on generator cost and aliasing.** Blip at 2.38×: "Optimise further" — a task works the blip
kernel toward 0360's 1.5× tripwire without losing sfxr accuracy. Aliasing: "Make it a setting" — a per-generator
quality parameter, standard (two-sample PolyBLEP, as built) or high (a higher-order band-limited method or
oversampling for saw/square/pulse, more CPU), declared in the catalogue so it saves, automates and shows in the Studio.

**D68. Merge with master (2026-11-23).** The Studio's records became 0341–0360 (table at the top). Calls made while
joining master's 73 commits: (1) **core ABI 6.0**: master's 5.0 (INIT record, memory exports) and the Studio's 5.1
(16-parameter effect records, `myco_ext`, generators) were both incompatible changes from 4.0, so the joined core is a
new major; the version is generated from `schema.rs` (master's ADR 0328), which now carries the Studio's history.
(2) **Decoder ABI 1.6**: both sides added different 1.4s (stream seams; HRIR/MagLS prep), so the union is 1.6.
(3) Master's memory answer replaces the Studio's TypeScript headroom terms (FxMem, ADPCM cursors, the 18 MiB M2 share):
the core's own layout already holds those regions; `openCore` binds the plugin glue (the throwaway instance gets a fresh
`EffectGlue`). (4) One curve-size helper (master's generated `curveBytes`; the Studio's `coreCurveBytes` removed).
(5) Capture format stays 2 (takes) with master's rule that `CAPTURE_ABI_VERSION` is the generated core ABI and the header
stamps the running core's. (6) The decoder's 1,000 KB tripwire raised to 1,056 KB (master's `spatial.rs`, +17.5 KB,
took it 411 B over). (7) Export links through master's linker; the Studio's audio-effect, localisation and line-index
steps run before the link, and `DEPS_DIR` now comes from `projectCode/buildTarget.ts`. (8) The e2e fixture's
`audioBackend` option answers the sample's `audio.json` (`settings.backend`), not `project.json`, since project.json
holds no audio here. (9) E2E specs the Studio deleted stay deleted (master only converted them to `openEditor`).
Revert: per item in the merge commit.

**D69. PR #187 merged into master; generator runtime integrated after it.** Owner chose "Merge now, e2e after". The
generator runtime (G3) was moved onto the renumbered base (180 reference lines renumbered; capture ABI follows
`CORE_ABI_VERSION`; the core's memory answer already covers GenEntries). Choices to review: cost weights only lower the
mixed-voice cap (the core's pool is a count); the PLAY loop flag only for `untilStopped` playlists; a sequence
generator clip keys off at the clip's end (a blip plays its whole envelope); embedded generators are named
`<playlist>#<kind>` in debug and captures; hot reload diffs stored values.

**D70. Generators complete apart from e2e (G2b, G4, G5, finish merged).** Owner's "Optimise further": blip 2.38× →
1.47× (sfxr-accurate; vibrato now a phasor). "Make it a setting": `quality` standard/high (high = 16-tap minBLEP, 2
samples late; `gen-blip-high` 1.57×, over the 1.5× tripwire as an opt-in). Mixer tripwire 640 KB; offline module
213 KB. Choices to review: presets/Randomise/Mutate keep `quality` and `level`; blip latches `quality` at its trigger;
Rebake overwrites the sample's own file with the same variation; the JS reference preview was removed (the preview is
the real offline render); generators are listed in the Playlists Library; locks are session-only; the Babylon fallback
has no release envelope for looping generators; existing bakes show "out of date" once after `quality` joined the
patch text. Windows desktop build notes (CMake ≥ 4.2 with Visual Studio 2026, JetBrains' bundled CMake, preview VS
instances, Ninja) are in `docs/wiki/guide/editor.md`.

**D71. UI fidelity pass (2026-11-23).** The owner found the Studio far from their prototype. Seven auditors drove the
rendered prototype and the owner's spec (`owner-spec.md`, committed) against the real Studio: ~550 findings
(`ui-pass/`). Owner answers: the player bar shows the spec's Game session pill and "Linked to game", driving take
replay until a live link exists (amends 0341's removal); deleting a sample moves it and its sidecar to the project
trash `.myco/trash/` with toast Undo (newest 20 kept; edit history not kept); Ctrl+S saves project data and a Save
split button offers Write to file… and Fork…; stems that start together on parallel tracks sync to the sequence clock,
"follows" only for a clip chained on the same track. Coordinator defaults are in `ui-pass/decisions.md` (spec wins
where newer; recorded decisions stand otherwise). Behaviour changes: loudness target defaults are now console −24,
PC/web −18, mobile −16 LUFS (amends 0171 decision 4; projects with an authored list keep it, so the samples still
show two targets); deleting a test scene is immediate with toast Undo; "Profile this replay" always replays from the
take's start so Take and Profiler share one review position (`profiler/reviewLink.ts`); hovering Spatial's plan takes
keyboard focus unless a field, menu or dialog has it.

**D72. UI pass waves 1–3 (2026-11-23).** Shared kit (W2-A): Studio form controls, label scrubbing with the prototype's
rules (ParameterRow keeps D12's share-of-range rate), NumberField/SliderField/Checkbox/ColourPicker/InfoTip/KitDialog;
Studio dialog primary buttons are moss (prototype `.btn.play`). Chrome (W2-B): FloatingPortal for floating UI under
container-query bars (the calibration dialog never opened before), per-screen stacked default docks
(`SCREEN_ARRANGEMENTS`, same storage key), timecode `mm:ss.mmm`. Playlist spatial `occlusion` defaults to on (0162);
3D on writes it on. "+ New parameter…" creates global parameters from any parameter select. Hold areas in sequences
use a dot pattern (hatch means disabled). Play modes use the spec's names (stored `through` reads as Whole). Saved
custom colours are per user (localStorage) until a project palette exists. Take/capture delete uses the samples'
`.myco/trash` with toast Undo. Why it played ties a voice to its playlist instance by record order and instant
(captures carry no voice→instance id). The Effects bus chip counts the current mix's bus chains. Mixer mute on is
solid amber (saved), solo on warning-soft (monitor). Engine/format work the owner chose to finish is ADR 0362.

**D73. UI pass waves 4–6 and verification (2026-11-23).** ADR 0362 built in full (pause, clip Amp envelope, reverse,
marker/range/folder colours, "And by", occlusion curves). Decisions taken: the audition pause holds at the earliest
stampable time and a held voice's stamped records wait on the core (no ABI bump, D67 precedent); the clip envelope is a
per-voice core kernel (sample-accurate; key-off = clip end − release, stages squeezed attack→hold→decay, release gives
way first); reversed voices count positions from the clip's end, a reversed sample never gives the musical clock, and
reversed ADPCM is silent rather than wrong; "And by" plays slices re-defined when the second parameter changes (rate
scales the clock without integrating; a change of the second parameter jumps); occlusion blocked-ness is the combined
loss over the −60 dB floor, mean over rays, and a curve replaces the materials' value for its property; take/capture
readers accept another minor of the core ABI major. Verification found and fixed: unstamped sequences of streamed
samples restarting every frame (D44 regression), `preact/compat` loaded by `FloatingPortal` rewiring every input's
onChange (guard test keeps compat out), and panel histories registering a frame late. Left: export M5b reference tone
reads −22.93 LUFS against −22.99 ±0.05 in a 44.1 kHz context (not investigated on master).
