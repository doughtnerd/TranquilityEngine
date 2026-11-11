# 0166 interactive music: the architect's contracts for `api-and-models.md` (round 1)

What [architecture.md](architecture.md) needs from the senior engineer's document, numbered **C1–C18**. Each states the fields, ranges and semantics, who writes them and when. The byte layouts, names, opcodes, ids and parse rules are the senior engineer's; where a layout is suggested it is only a size bound. "Arch §n" points to the section that relies on it.

## Core, wire and STATUS

**C1. Music ring class** (Arch §4.2, §2.3).
- `InitParams` gains the music ring count: 8 / 12 / 16 on low / default / high (owner decision 2), range 0..16. Rings are 32,768 frames of up to 2 channels, 300 KiB each, as narrow rings. A third class beside narrow and wide (`stream.rs:61-65` comment), with its own region or range.
- STREAM_OPEN names the class (music or not). A music open takes only a music ring and a non-music open never takes one. No music ring free: stream event 3 (error), as today.
- Written by: main at init (count); the worker on STREAM_OPEN (class, from `primeGroup`, C8).

**C2. Primed bits in STATUS** (Arch §4.2).
- Per music ring: the stream id it holds (or none), its epoch, and **primed** = the ring holds ≥ `START_FRAMES` (4,096) frames committed in its current epoch, or its input ended. A bit for **bound** (a voice has bound it) helps the debug panel.
- Every STATUS block (every 6 quanta; 48 when idle). ≤ 16 rings, so ≈ 16 × 8 B or a bitmask plus a stream-id table.
- Written by: the core, at STATUS time, from ring state. Read by: the prime coordinator.

**C3. PLAY sync group** (Arch §4.3, §2.2).
- PLAY gains `syncGroup` (0 = none, else a group id, ≥ 16 live at once, ids reused after the group's end report) and `groupSize` (members, 1..32: 16 stems plus decoded members and tail voices). Distinct from PLAY's existing `group` (the automation instance group, `schema/batch.rs:142, 304`).
- Semantics (the gate): all members carry one stamp and arrive in one batch. At the stamp's quantum, if every streamed member's ring is primed (C2's rule) all start at the stamp; otherwise every member, decoded ones included, holds SCHEDULED and they start together at offset 0 of the first quantum where all are ready. A STOP to a held member ends it (it no longer counts for the gate). RESET clears every group.
- Written by: main (music player), in the batch after all primed bits are seen.

**C4. Group-start event and slip counters** (Arch §3.6, §4.5, §8).
- One event per group start: group id, absolute start frame, slip in frames (start − stamp, 0 when on time). ≤ 8 per STATUS block, carried to the next block when full.
- Cumulative counters: `streamStartsLate` (groups or ungrouped stream voices that started after their stamp because a ring wasn't ready) and `maxSlipFrames`. Today a slip is invisible (S1 Q1).
- Written by: the core, in the quantum of the start, reported in the next STATUS.

**C5. Fade law and start phase on class G records** (Arch §4.4).
- FADE, SET_PARAMS (gain) and STOP-with-fade gain a **law**: `linear` (today's), `sCurve` (smoothstep), `equalPowerIn`, `equalPowerOut` (quarter-sine table, 1,024 points). Default `linear`, so today's senders are unchanged.
- And a **start phase** u₀ in [0, 1) (resolution ≥ 1/65,536): the ramp starts at law(u₀) and runs the remaining (1 − u₀) of its length over the record's frames. Used only by REPLAY of a ramp already under way.
- Semantics: a stamped record of this class applies inside its voice at its frame without splitting the quantum (M4-0). Written by: main (player, mixer, Replayer).

**C6. Per-voice curve state** (Arch §4.4, §6).
- While a curve-law ramp runs, the voice keeps law (2 bits), u (f32) and du per quantum (f32): ≤ 12 B. The slot (192 B, full today: `layout.rs:29`) has one spare byte; this needs either `VOICE_SLOT_BYTES` grown (to 208 or 256) or a parallel per-slot array. Budget: ≤ 16 B per logical voice (16 / 64 / 64 KiB). Layout choice is the senior engineer's.

**C7. Whole-quantum split counter** (Arch §4.4, §7.5, §9).
- A cumulative core counter of quanta in which a record split the whole quantum (the due-list overflow path, Arch §4.4 step 1). Must read 0 in every test and bench after M4-0. In STATUS or in the bench-only counters; the senior engineer chooses.

## Worker protocol

**C8. `primeGroup` and `groupOpened`** (Arch §4.2, §3.1–§3.9).
- Main → worker: group id; per member: stream id, epoch, the asset's encoded bytes (transferred) or a reference to bytes the worker already holds for that stream, start frame (file frames), loop region (or none), looping flag, class music, channel convention.
- Order rule: the worker posts every member's STREAM_OPEN and **first chunk** before any member's second chunk, then tops up round-robin. Today `pump` fills each stream depth-first (`decoder/streams.ts:498-510`).
- Re-target: the same message with new epochs for members already open restarts them at a new start frame (a seek per member, same breadth-first order).
- Worker → main: `groupOpened` with per-member open time (ms) and any error. **Diagnostics only**: it is never the primed signal (C2 is), because chunks travel on another port.

## Settings, format and public API

**C9. Settings** (Arch §5.3, §4.6).
- Presets gain the music ring count (8 / 12 / 16), feeding C1. A project-level `audio.rhythmMode` boolean, off by default; a change rebuilds the context (rate-limited).
- No other music settings: every other constant in Arch §5.3 is a constant.

**C10. Backend seam for music** (Arch §1, §10).
- The player talks to the backend through operations for: admitting and priming a group (C8), reading primed state (C2), stamping a group's PLAYs and class G records, cancelling a group, and receiving group-start, starve, end and error events per voice.
- A capability description per backend: the core supports priming, stamped fades with laws and the heard clock; the Babylon fallback supports stamped starts of decoded clips only, frame-time linear fades, `currentTime` as clock, no rhythm mode. The player branches on capabilities, not on backend type.

**C11. `Audio.debug().music`** (Arch §9). Per instance: event path; segment and pass; bar, beat, tick; tempo and metre; heard time; pending transition (from, to, T as bar:beat, matched rule id and tier, or the common parent that supplied it); each group's state and primed n/N; last prime time, Ê and lead; counters (re-plans by reason, refusals by cause, late groups and max slip, recoveries by cause, missed beats, stinger outcomes). Engine-wide: music rings in use, high-water mark, `musicRingRefused`, whole-quantum splits (C7). Every field states its unit.

**C12. Input mapping and calibration semantics** (Arch §4.6).
- `Audio.timeAt(performanceTimeMs)` returns seconds on `Audio.time`'s base: the ClockMap's offset map applied to the timestamp, **minus** `Audio.calibration` (seconds, signed). Available without rhythm mode.
- `positionAt` adds the instance's grid (bar, beat, beat fraction, nearest beat's heard time, signed offset in seconds, positive = late).
- Calibration result: offset (s), MAD (s), taps used, a confidence value; persisted per output device; a stale flag after `devicechange`.

**C13. Validation rules the runtime relies on** (Arch §3.5, §4.5).
- A segment's stems share one length in seconds and one channel layout (record §1).
- Music tracks carry **no pitch automation** (the beat clock and loop-pass prediction assume pitch 1).
- Pre-entry ≤ the entry cue; a loop tail lies after its region's end and inside the file; alternatives of a stem match its length.
- Streamed FLAC and WAV stems warn on low (record §3); stems without gapless metadata warn (record rev. 2 #11).

**C14. Span clips for loop tails** (Arch §3.5).
- The clip registry can decode a frame span `[start, end)` of an asset as its own clip (id distinct from the whole asset's), so a tail voice can play it stamped at each loop wrap. Spans ≤ 30 s; they count against the clip ceiling.

**C15. Callback event fields** (Arch §4.5).
- Each beat, bar and cue event carries: `time` (the exact heard time, seconds on `Audio.time`'s base), `heardIn` (seconds until heard, ≥ 0 unless missed), `missed` (events of that kind skipped since the previous dispatch, 0 normally), segment, bar, beat, cue name for cues, the handle.
- Delivered from `engine.AudioBeat` (C17), once per kind per dispatch (coalesced).

**C16. Replayer hand-off** (Arch §3.7, §4.4).
- On a hard rebuild the `Replayer` passes every voice that belongs to a music group to the music player (by group), not to `reopenStreams` (`core/replay.ts:500`). It keeps the last stamped class G record and stamped STOP per voice for REPLAY of other voices (C5's start phase).

**C17. `engine.AudioBeat` system** (Arch §4.5).
- A built-in system in the `update` phase, `before: ["engine.UpdateScripts"]`, `after: ["engine.UIDocumentEvents"]`, in every World that plays audio. It calls `clockMap.beginFrame()` and dispatches beat callbacks. The system catalog test lists it.

**C18. Musical position resolution and conversion** (Arch §4.5, §4.1).
- Positions are bar:beat:tick (owner decision 1). The tick resolution must resolve ≤ 1 ms at 300 BPM (≥ 200 ticks per beat; 960 is the DAW norm).
- One conversion function (position ⇄ segment seconds ⇄ frames, f64, a stated rounding rule) is shared by the runtime, the validator and the editor, so the editor's grid and the runtime's stamps agree to the frame.
