# 0166 interactive music: the architect's contracts for `api-and-models.md` (round 2B)

This file lists what [architecture.md](architecture.md) needs from the senior engineer's document, numbered **C1–C19**. It is revised under the coordinator's rulings R1–R24 ([rulings.md](rulings.md)). Each contract states fields, ranges, semantics, who writes them and when. Byte layouts, names, opcodes, ids and parse rules are the senior engineer's. "Arch §n" points to the section that relies on the contract.

## Core, wire and STATUS

**C1. Music ring class** (Arch §2.3, §4.2).
- `InitParams` gains `max_music_rings`: 8 / 12 / 16 by preset, range 0..16.
- Rings hold 32,768 frames of up to 2 channels, 300 KiB each.
- STREAM_OPEN gains a `music` flag. A music open takes only a music ring, and a non-music open never takes one.
- A full music pool is reported as stream event **4** (`musicFull`).
- Written by: main at init; the worker on STREAM_OPEN.

**C2. `musicRings` in STATUS** (R7; Arch §4.2).
- Every STATUS lists every open music ring as `{streamId, epoch, flags}`.
  - Flag bit 0, **primed**: at least 4,096 frames committed in the ring's *current* epoch, or its input has ended.
  - Flag bit 1, **bound**: a voice has bound the ring.
- At most 16 items.
- It is a level, not an event, so a lost report repairs itself.
- Main accepts only its current epoch for each stream.
- Written by: the core.

**C3. PLAY gate and the group table** (R4, R8, R9; Arch §4.3).
- PLAY carries a gate: a 10-bit group id (0 means ungated) and a 6-bit size.
- Every member of a group arrives in one batch with one stamp.
- The core's group table has **16 entries**. Each entry holds:
  - id and size;
  - members present, as voice ids, up to 64;
  - state: stamped, started, held or abandoned;
  - stamp frame, start frame and hold start.
- An entry is freed when every member has ended or been stopped, when the group is abandoned, or on RESET.
- A started group keeps its entry, because the hold needs it. 8 entries aren't enough (Arch §4.3).
- A PLAY that finds no free entry starts ungated and counts `groupTableFull`.
- Voice flags in `flags2`: due, gated, and a 4-bit group index. The slot stays 192 B.
- Semantics are the table in Arch §4.3:
  - gate at the stamp;
  - hold every member on a would-be starve;
  - resume together;
  - abandon after 1 s, either unstarted past the stamp or held;
  - a member STOPped leaves the group;
  - virtual members stay members.
- Written by: main sends the PLAYs; the core owns the table.

**C4. Group events and counters** (R7, R10, R11; Arch §3.6, §4.3, §4.5).
- One event per group per start, resume or abandon: `{groupId, kind, slipFrames, startFrame (u64)}`.
  - `kind` is one of start, resume, abandon.
  - On-time starts may be omitted.
- At most 8 events per STATUS; the rest carry over.
- Counters, cumulative and saturating:
  - `groupsLate`, `groupHolds`, `groupsAbandoned`;
  - `streamStartsLate`, which also covers ungated stream voices;
  - `maxSlipFrames`.
- Written by: the core, reported in the next STATUS.

**C5. Laws, start phase and the fade-at-zero PLAY** (R5; Arch §3.2, §4.4).
- FADE, SET_PARAMS gain and STOP-with-fade carry a **law**: `linear`, `sCurve`, `equalPowerIn` or `equalPowerOut`. The default is linear.
- They also carry a **start phase u₀** in [0, 1), with resolution of 1/65,536 or finer.
  - The ramp starts at law(u₀) and covers the remaining (1 − u₀) of the law over the record's frames.
  - REPLAY uses it to resume a running curve fade.
- A PLAY flag starts the voice's `fade` ramp at 0. A crossfade-in is that PLAY plus a stamped FADE to 1.
- The FADE `from` field is dropped.
- Written by: main (player, mixer, Replayer).

**C6. Curve pool** (R4; Arch §4.4).
- A pool of **255** entries for curve state (law, u, du), linked from the slot's spare byte.
- A fade whose curve can't get an entry runs linear and counts `curvePoolFull`.
- Freed when the fade settles, when the voice ends, or on RESET.

**C7. Split counters** (R3; Arch §4.4, §9).
- **`splitQuanta`**: quanta in which a record split the whole quantum. These are records that aren't per voice (bus, master, listener, tables) plus due-list overflow.
- **`voiceSplits`**: class S voice-local splits.
- Both are cumulative, in STATUS.
- M4-0 exit: `splitQuanta` reads 0 in the music scenes and in a scene of stamped spatial plays with sends.

## Worker protocol

**C8. `primeGroup`, re-target and the instance cache** (R16; Arch §4.2).
- Main → worker, per group: group id and instance id. Per member:
  - stream id and epoch;
  - start frame, in file frames;
  - loop region and looping flag;
  - the music flag and the convention;
  - either the encoded bytes (transferred) or a reference to the bytes the worker holds for that path in that instance.
- Order: every member's STREAM_OPEN and first chunk go out before any member's second chunk. Top-ups then go round-robin.
- **Re-target:** the same message with new epochs restarts open members at new start frames, in the same breadth-first order.
- **Cache:** the worker keeps each path's bytes, refcounted per instance, until main posts the instance's release. Past the preset's encoded threshold (48 / 96 / 160 MiB, est.), the least recently closed file is dropped (Arch open point 1).
- Worker → main: `groupOpened`, with open times per member and any errors. It is diagnostics only and never the primed signal; C2 is.

## Settings, format and public API

**C9. Settings.**
- Presets gain `music.rings` (8 / 12 / 16).
- Project setting `audio.rhythmMode`; changing it at runtime rebuilds the context through the device path (rate-limited).
- Everything else in Arch §5.3 is a constant.

**C10. Backend seam** (Arch §1, §10).
- `MusicBackendCaps` on the backend: primes, stamps with laws, heard clock, rhythm.
- Operations:
  - admit and prime a group;
  - read `musicRings`;
  - stamp a group with its records;
  - cancel a group;
  - release an instance's cache;
  - receive group events and per-voice end, starve and error.
- The player branches on capabilities, not on backend type.

**C11. `Audio.debug().music`** (Arch §9).
- Per instance:
  - position, including the tick;
  - the pending transition with the matched rule and its tier, or the common parent that supplied it;
  - group states and primed n/N;
  - last prime time, Ê and lead;
  - re-plans by reason, refusals (temporary, permanent), holds, abandons, late groups and max slip;
  - recoveries by cause;
  - `missedBeats`;
  - stinger outcomes.
- Totals:
  - pool used, pool size and high-water mark;
  - `groupTableFull`, `curvePoolFull`;
  - `splitQuanta`, `voiceSplits`.
- One task (R21). Units on every field.

**C12. Input mapping** (R18; Arch §4.6).
- `Audio.timeAt(performanceTime)` is the raw clock map, in seconds.
- `positionAt().judged = offset − Audio.calibration`.
- `Audio.latency.reliable` follows Arch §4.6.
- The calibration is marked stale on `devicechange`; its value is kept.

**C13. Validation the runtime relies on** (Arch §3.5, §4.3, §10).
- Stems of a segment share one length within 1,024 frames, one channel layout and one file rate.
- A tail lies after its region's end and inside the file.
- Alternatives have the stem's length.
- Pre-entry is at most the entry cue.
- The ring lint counts a sequence's peak rings, and decoded bridges count none (R15).
- Pitch automation on music tracks is dropped. `pitch` on `AudioSource` and `EventOptions` is ignored for music with one warning; this is owner list item 2.
- At most 4 concurrent stingers per instance, as a format limit (R20).

**C14. Span clips for loop tails** (R15; Arch §3.5).
- The clip registry decodes a frame span `[start, end)` of an asset as its own clip id. Spans are at most 30 s and count against the clip ceiling.
- A refused span is reported, so the player can drop the tail with one warning.

**C15. Callback fields.**
- `MusicEvent` as in [API §1.1], plus `skippedCues: string[]` on a coalesced cue event (R20).

**C16. Replayer hand-off** (Arch §3.7, §4.4).
- `Replayer.restore` passes music-group voices to the player by group, never to `reopenStreams` (`core/replay.ts:500`).
- For other voices it keeps the last stamped class G record and any stamped STOP, and re-sends a running curve fade with u₀.

**C17. `engine.AudioMusic`** (R17; Arch §4.5).
- Update phase, `before: ["engine.UpdateScripts"]`, after `engine.Lobby` and `engine.PredictionSmooth`.
- It calls `beginFrame` and dispatches.
- It is listed in the system catalog test.

**C18. Positions and conversion** (Arch §4.5).
- 960 ticks per beat.
- One module, `musicGrid.ts`, does the conversion for runtime, validator and editor, with the stated rounding: integer ticks; seconds summed per tempo span in float64; frames = round(seconds × rate) once per stamp.

**C19. Per-voice record routing** (R2; Arch §4.4).
- Every queued per-voice record goes to the due list:
  - **class G**: FADE, gain-only SET_PARAMS, STOP;
  - **class S**: any other SET_PARAMS mask, SET_VOICE_FX, SET_PAUSED, SEEK, SET_LOOP.
- The pending queue keeps a held voice's records across quanta. At a group's start or resume, it rebases a member's records stamped at or after the stamp (or after the hold start) by the slip (R10).
