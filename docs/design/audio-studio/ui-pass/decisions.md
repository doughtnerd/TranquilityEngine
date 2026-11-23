# UI pass: owner decisions and coordinator defaults (2026-11-23)

## Owner answers
1. Game session: SHOW the spec's "Game session" pill and "Linked to game" badge in the player bar (spec §3.5/§3.7),
   but they drive take replay (as today) until a live game link is built later. No live link in this pass.
2. Deleting a sample: delete from disk, through a trash so Undo brings it back.
3. Saving on Samples: Ctrl+S / Save saves project data (sidecar, ADR 0342); a Save split button offers
   "Write to file…" for the WAV, with the review dialog.
4. Music stems: clips on parallel tracks that start together are all Sync to the sequence clock; "follows" (and its
   warning) only for a clip chained after another on the same track. No warning on stems.

## Coordinator defaults (spec wins where it is the newer decision; recorded decisions stand otherwise)
- Snapshot API stays `Audio.snapshot(...)` (ADR 0344). Bed modes keep Off (D19). Bus delete keeps its confirm when
  referenced. Effect catalogues keep ADR 0345/D11 (a superset of spec B.1/B.3); add the spec's bus Formant/Pitch
  shift only if those kernels already run on buses.
- Delay and Reverb are NOT offered on clips (spec B.2 + ADR 0345); existing data still plays.
- Loudness targets per spec: add PC/web; mobile −16 LUFS.
- Badge codes stay CLP/QUE/SW/1D/2D/LAY/SEQ; colours follow the prototype (CLP purple, QUE pink, SW amber, 1D teal,
  2D green, SEQ blue, LAY neutral).
- Clip random level keeps the min..max format. Linked copies get the dashed indicator in the tree.
- Samples keys: add spec `[`/`]` = trim to playhead (I/O stay). Play-mode names per spec (Pickup → loop, Loop → exit,
  Cycle loop, Whole). Tap tempo resets after 2.5 s. Entry marker stays (ADR 0350). "Can leave at" is covered by Exit
  markers (D38): no field.
- Import format/sample rate stay encoding settings (ADR 0351), not in the import dialog.
- Take: Takes and Sequences as tabs (spec); Profiler: Why it played in the bottom dock (spec); Take mixer keeps
  faders; Profiler effects show instance counts by level where captures carry them; Take and Profiler stay separate.
- One Studio undo history (ADR 0341). Spectrogram, ADSR handles, crossfade visuals and reverse ARE to be built (spec
  §4.2.9; previously logged gaps).
- §1.3 "explanations live in tooltips": inline helper paragraphs become tooltips (empty states keep their one line).
- Spatial occlusion: keep ADR 0347's per-material table, and add the spec's summary (Rays per voice, Fully blocked
  readout, Curves button for occlusion volume/low-pass) on top of it.
- Curves "And by" (Morph/Scale/Rate, per label, Table): the spec lists it as decided, so build it.
- The Curves window floats (non-modal, draggable) per the prototype.
