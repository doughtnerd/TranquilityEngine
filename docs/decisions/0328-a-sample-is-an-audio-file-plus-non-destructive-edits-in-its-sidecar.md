# 0328. A sample is an audio file plus non-destructive edits in its sidecar

- **Status:** Accepted
- **Date:** 2026-11-22
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0040 (amended: the sidecar gains a `sample` block), 0085, 0119, 0141, 0157, 0166, 0293, 0327, 0329, 0331, 0332

## Context

The engine calls an audio file a *clip*. Its sidecar `<file>.meta.json` (`myco.import@1`, 0040) holds `volume`,
`stream`, `loopStart`/`loopEnd` and `ambisonic`. WAV `cue`, `LIST/adtl/labl`, `smpl` and `acid` chunks are read only by
the editor's music import, which copies them once into a music segment (`editor/music/importHints.ts`); nothing keeps
cues, markers, tempo, root note, trims, fades or loudness with the clip.

The prototype's Samples screen makes the audio file a **Sample** with its own edit data: trim, several loops (direction,
crossfade, repeat count, activation, exit and re-entry; a zero-length loop is a hold point), markers of four types
(note, Exit, Hit point, Cue), tempo and meter, root note, loudness normalisation, a baked effect chain, razor cuts with
closed gaps, source versions on re-import, a file-versus-project diff with per-field revert, a changed-on-disk merge,
"Write to WAV", and derived samples (snippets, forks that follow or pin their parent, duplicates). Playlists and
sequences use a sample's loops and markers (0329). The owner chose sidecars over rewriting the WAV (2026-11-22).

## Decision

We will keep every sample edit in the audio file's sidecar, never change the source audio unless the user asks, and
let derived samples be small asset files that name their source.

**A `sample` block in the sidecar** (`<file>.meta.json`, still `myco.import@1`: the block is optional, so old sidecars
and old readers keep working). Times are seconds in the source file. Every loop and marker has a stable `id` so clip
overrides (0329) survive reordering.

```jsonc
"sample": {
  "kind": "oneshot",            // oneshot | loop | sustain | music: defaults and display only
  "trim": [0.02, 2.58],         // null = whole file; must contain every loop
  "loops": [{ "id": "l1", "start": 0.45, "end": 1.55,   // start == end: a hold point
    "direction": "forward",     // forward | pingPong | backward (smpl types 0/1/2)
    "crossfadeMs": 35, "count": 0,                      // 0 = endless
    "active": "held",           // always | held | parameter (the binding lives on the clip, 0329)
    "exit": "finish", "exitFadeMs": 40, "reentry": "ignore",
    "file": { "chunk": "smpl", "index": 0, "start": 0.45, "end": 1.55, "direction": "forward", "count": 0 } }],
  "markers": [{ "id": "m1", "type": "cue", "name": "brake_lockup", "at": 0.30,
    "note": "Game spawns tyre smoke", "file": null }],  // note (may have "end" and "color") | exit | hit | cue
  "tempo": { "bpm": 120, "meter": "4/4", "map": [], "source": "file" },  // file | detected | set
  "root": { "note": "C3", "cents": 0, "source": "file" },
  "normalize": { "mode": "loudness", "target": -16, "gainDb": 3.5 },     // off | loudness | peak
  "effects": [ /* baked chain, 0331 */ ], "frozen": false,
  "cuts": [1.2], "deleted": [1.2], "closedGaps": [[0.8, 0.4]],
  "stinger": false, "snapToZero": true
}
```

- The `file` object on a loop or marker is what the WAV said when it was imported or last written. The diff, per-field
  revert, Detach and the changed-on-disk merge compare against it. `null` means project-only.
- Legacy `loopStart`/`loopEnd` read as one loop when there is no `sample` block; the Studio writes only `loops`.
- Marker types: **note** (annotation; the only type that can be a range), **exit** ("music may leave here"; Switch
  change rules and sync clips use it, 0329), **hit** (a stinger's landing beat), **cue** (the game is told when playback
  passes it). WAV cue points import as notes. The UI names the types Note, Exit, Hit point and Cue.
- `normalize.gainDb` is computed when the setting is changed (target minus measured integrated LUFS, or target minus
  sample peak) and applied after the baked effects; a warning shows when the peak would pass −0.1 dBFS. Measured values
  are cached in `.myco/cache/`, not stored.
- Tempo `map` holds tempo changes (the engine's tempo markers, 0166) when a file has more than one tempo.

**Derived samples are asset files** `*.sample.json` (`myco.sample@1`), so they can be referenced, moved and renamed like
any asset:

```jsonc
{ "format": "myco.sample@1", "source": "audio/brake_skid.wav", "range": [0.8, 1.6],
  "lineage": { "kind": "fork", "parent": "audio/brake_skid.wav", "mode": "follow", "baseline": { /* sample block */ } },
  "sample": { /* same block as above */ } }
```

- **Snippet:** `range` set, `kind: "snippet"`. **Duplicate:** an independent copy of the edits, no audio copied.
- **Fork, follow:** a field equal to `baseline` is read live from the parent; a field that differs is the fork's own.
  **Fork, pin:** the resolved edits are frozen. "Parent changed" compares a hash of the parent's resolved block with
  the one stored at pin time (not the parent's history node id, which changes on undo).

**Source versions.** Re-import copies the new file over the asset's path and keeps the previous audio in
`.myco/sample-versions/<path>/v<n>.<ext>` (per machine, like asset history), recorded as one undo step ("Re-import ·
v2"); undo puts the old audio back. Re-import and an outside change to the file open the same **merge review**: per
changed cue, region or loop, Keep project / Use file (new ones: Add / Skip), conflicts flagged where the project edited
the item. Edits past a shorter new source are flagged, never dropped ("Fit to v2"). **Flatten** renders the baked
effects into a new file beside the source (`brake_skid.flat1.wav`) and points the sample at it; the original stays.

**Writing to the WAV is explicit.** "Write to file…" (with a review listing what is written) writes `cue`, `labl`,
`note`, `ltxt`, `smpl`, `acid` and `bext` chunks into the source, keeps a backup in `.myco/sample-versions/`, and
refreshes every `file` snapshot. The audio data is not changed. The sidecar stays authoritative: marker types the WAV
cannot carry are kept in the sidecar.

**Baked effects are rendered offline.** The Rust DSP that plays effects (0331) renders the chain, trim, closed gaps and
normalisation offline in a worker: the Studio and the editor's Play use the render cached by content hash in
`.myco/cache/samples/`; `npm run export` renders and ships the result. The clip resolver (0293) picks the render, so the
runtime and the backend seam see an ordinary clip.

**Import.** The Studio's import picks files or folders (keeping the folder structure by default), shows the metadata
kinds found (cue points and labels, regions, sampler loops, root note, tempo and beats, timecode origin, detection of
what's missing) with a toggle per kind, and copies the files into the chosen project folder (0085's copy rules). The
Load choice is the existing `stream` flag; Format and Sample rate are export settings (0119). Samples are assets: the
Samples tree shows the project's audio files and derived samples by folder; rename, move and delete are the engine's
asset operations with reference rewriting (0314), not display names.

**Runtime.** Loops play in the core voice with crossfade, ping-pong and backward direction, repeat counts and the three
activation modes, so a held loop releases by its exit setting. Passing a **cue** marker reports to the game through the
playing handle (`onMarker`, 0329). These are core and wire changes.

## Alternatives considered

- **Rewrite the WAV on every save (the prototype's Save)** — other tools see the edits, but every save modifies source
  assets and marker types don't round-trip; the owner chose sidecars.
- **A separate `*.sample.json` for every sample** — doubles the file count; the sidecar already exists per file (0040).
- **Keep musical metadata only in music segments (today)** — every use would re-import it; the prototype makes tempo,
  loops and markers properties of the sample that every playlist and sequence shares.

## Consequences

**Positive**
- Source audio is never touched by accident; edits diff, merge and undo like any JSON asset.
- One place for loops, markers and tempo, shared by every playlist, sequence and Switch rule.

**Negative / costs**
- Core work: loop crossfade, ping-pong, backward, counts and activation in the voice; cue reporting.
- An offline render path and a cache; exports must render baked samples.
- Source versions are per machine (in `.myco/`), like history; a teammate sees only the current source.

## Deprecates

- The music import's one-time copy of WAV metadata into segments (`editor/music/importHints.ts`, `import.ts`): the
  readers move to the sample import.
- `loopStart`/`loopEnd` as the only loop fields: read for compatibility, no longer written.

## Open questions

- Which offline-only effects (noise reduction, reverse) are worth building first; the catalogue (0331) marks them.

## References

- Prototype Samples screen (`File.dc.html`), Journeys j2, j7, j11.
- `src/engine/scene/importSettings.ts`, `src/plugins/audio/runtime/loopPointsReader.ts`,
  `native/audio/crates/audio-decode/src/loop_points.rs`, `src/plugins/audio/editor/music/importHints.ts`.
