# 0171 audio mix: the architect's contracts for `api-and-models.md` (round 1)

This file lists what [architecture.md](architecture.md) needs from the senior engineer's document, numbered **C1–C26**. Each contract states fields, ranges, semantics, who writes them and when. Byte layouts, names, opcodes, ids, parse rules and the task table are the senior engineer's; where a name appears here it is a placeholder. "Arch §n" points to the section that relies on the contract.

## The profile stream and the capture file

**C1. The record envelope** (Arch §4.1).
- Every record carries: **kind**; **length** (self-delimiting, so an unknown kind can be skipped); **epoch** (u16 or wider, from 0 at the recording's start, +1 per EPOCH); **frame** (the current context's frames, at least 48 bits, never wrapping in a session); **seq** (u32, +1 per record in write order, per recording).
- Main-event records also carry `performance.now()` in ms (f64 or µs in an integer ≥ 40 bits).
- A **deferred** bit: set when the record's frame is F_now because its real stamp is more than 1 s past the newest STATUS frame; the stamp then travels in the payload.
- Canonical order is (epoch, frame, seq). A writer guarantees that within one epoch no record's frame is more than 1 s before the frame of a record written earlier (bounded disorder), so a reader sorts within one segment.
- Written by: the recorder, on main, at the moment of the event.

**C2. EPOCH record** (Arch §3.4, §4.1).
- Fields: reason (trap, stall, device, rate, latency, mode, plus "first" for the recording's start if the format wants it); new sample rate (Hz); the limiter latency in frames at that rate; `timeOffset` in seconds (the clock map's, so the axis stays continuous).
- Written by: the recorder at the first STATUS of a new core; a keyframe follows at once.

**C3. Gap record** (Arch §3.5, §4.1).
- Fields: start and end as `performance.now()` ms; reason: paused (hidden, `pause` mode), rebuild, held (restart after Held), dropped (a later link's back-pressure, with the first and last missing seq), recordTooLarge.
- Written by: the recorder when the gap ends (a rebuild gap ends at the EPOCH).

**C4. Keyframe** (Arch §4.2).
- Main-side state at the keyframe's frame:
  - every voice in the table (not only the 64 most audible): id, clip id, bus slot, state, priority, gain, pitch, audibility, playhead, and the reason it is in its state (virtual why, stolen by whom);
  - event instances (id, asset id, state) and music state (per instance: segment, position, pending transition);
  - per bus slot: name id, live or tombstone, parent slot, each of the six lanes' value and target (A, R, S, G; D and U as last reported), monitor mute and solo;
  - per metered bus: momentary, short-term, integrated, LRA, max true peak, max momentary, elapsed, and the flags (`paused` with reason, `incomplete`, `tainted`, lower bound);
  - the active snapshot and the active loudness target's name.
- Interval: one second of STATUS frames, and at each epoch's first block (Arch §4.2).
- Largest keyframe ≤ 256 KB at 8,192 logical voices (Arch §5.3). If the format can't keep under it, say so: the ring's largest record follows.

**C5. Names** (Arch §4.1).
- The header holds the name table known at the start: clip, bus, event asset, parameter, snapshot and loudness-target names.
- An **in-stream name record** (kind of name, id, string) is written before an id's first use when the name wasn't in the header (a clip loaded after the start, a bus added live).
- Strings are UTF-8 with a length; readers treat them as data and cap each at a length the format states.

**C6. The other records** (Arch §3.1, §3.8, §4.1).
- **STATUS:** the block's bytes exactly as received, length from its envelope.
- **Main events** with reason codes: voice start, stop, steal (thief id), virtualise and realise (reason), refusal (reason), queued; event instance start and stop; parameter, snapshot and state changes; music transitions; **mix operations** (C19's ops with their slot ids, C21), including Compare's swaps; **markers** (`Audio.capture.mark(text)`, owner joins, Compare).
- **Audio section at start:** the whole `audio` section as JSON (or the senior's encoding), plus the project's name and version (record change 3).
- **MASTER state:** volume, mute and the hidden-tab mute, whenever they change (record change 11).
- **Wrap marker:** the writer jumped to offset 0 (ring only; never in a saved file).

**C7. The capture file** (Arch §3.1, §3.7, §4.2).
- Header: magic, format version, the wire schema hash and ABI version (refusal message names both versions), sample rate at the start, quantum frames, STATUS cadence, preset, ring size, `truncated`, `firstFrame` (the oldest kept frame), a `compressed` flag (uncompressed when `CompressionStream` is missing), the name table.
- Body: the ring's records from the oldest kept keyframe to the newest, in seq order, deflate-raw when compressed.
- Limits for untrusted input, checked in the Worker: decompressed size ≤ **64 MB**; every record length within the body; record count bounded by the body; name strings capped; a keyframe index footer (if any) validated against the body before use.
- Optional footer index of keyframe offsets: welcome (S3: makes opening free), not required.

## Wire and core

**C8. STATUS: the shell's CPU fields** (Arch §4.3).
- `busyMsTotal` (cumulative ms of `Date.now()` deltas around `process()`, wrapping u32), `quantaTotal` (cumulative `process()` calls, wrapping u32), `clockStepMs` (the smallest non-zero step seen, u8, 0 before one), `clockSteps` (wall-clock steps clamped, saturating u16).
- `loadPermille` keeps its offset and becomes **the last 96 quanta's busy time** at the posted block (the shell's sliding ring), 0 until 96 quanta have run.
- Written by: the shell after `myco_audio_status_take`, like `underruns` (`coreDriver.ts:1040-1046`).

**C9. STATUS: section work-unit totals** (Arch §4.3).
- Cumulative work units for: voices; buses and effects (lanes and sidechain included); spatial (beds and zones); music; loudness. Each wraps no sooner than once an hour at the high preset's worst load (u64, or u32 in units of 1,024 work units).
- Written by: the core per quantum; reset only by a new core.

**C10. STATUS: loudness per metered bus** (Arch §4.4).
- Per metered bus (master + up to 8): the bus slot; the sub-block `seq` of the newest sub-block; **n** new sub-blocks since the last take (0..32) and their K-weighted mean squares (f32 each); the peak since the last take, max(true peak, sample peak), linear; the cumulative count of quanta whose true peak was gated out; flags: shed, true-peak gate active.
- The core advances each bus's sent cursor only inside `myco_audio_status_take` (a skipped post leaves it).
- Worst case: 9 buses × 32 sub-blocks. With C8, C9, C12 and C13 the block must fit **20 KB** (record change 28); please state the new worst-case sum and keep ≥ 1 KB spare.

**C11. Loudness configuration** (Arch §4.4, §4.8).
- Which slots are metered (master is implicit), sent at BUS_CONFIG and whenever `meter` changes live; the true-peak gate threshold in dBFS (the active target's ceiling − 6 dB), sent when the target changes.
- Pause, resume and reset are main-side only; the core keeps measuring.

**C12. STATUS: duck gains** (Arch §4.5, §4.6).
- For every bus that is the target of at least one ducking rule: the slot and the duck gain (lane D) at the block's last frame. A count field; at most 32.

**C13. STATUS: header growth, the ladder and the ABI** (Arch §4.8).
- A count of the loudness ladder step in force (0 or 1), beside `m3Shed`, which keeps counting bed and zone steps.
- New cumulative counters the architecture names: `busRecordsEarly`, `sidechainLate`, `liveRefused` (main may keep the last), `loudnessLost` (main may derive it from C10).
- An ABI bump, the new schema hash and vectors at the head of M5-0 (record change 28).

**C14. Lane ramp record** (Arch §4.5).
- Fields: bus slot; lane (A authored, R runtime, S snapshot, G gate); start frame, or asap; length in frames (0 = step); target value (f32, ≥ 0, non-finite leaves the target).
- Semantics: linear from **the lane's value at its start frame**; two records for one lane in a quantum apply in frame order; a stamped record is due-list **class B** (no quantum split; `splitQuanta` stays 0); when the due list is full it applies at the quantum's start and counts `busRecordsEarly`.
- Snapshot low-pass travels as today (per-quantum ramp, linear Hz) in the same record family or BUS_MIX's field.
- Main sends it for edits (asap, 10 ms), script fades and snapshot transitions (stamped), mute, solo, monitor controls and the dip (lane G).

**C15. Presence flags** (Arch §4.6).
- One bit per trigger bus slot, "has voices" (virtual and locked included), sent when any bit changes and in a rebuild's replay. A level, not an event.

**C16. BUS_CONFIG as a difference, and the structural record** (Arch §3.3, §4.7).
- A record that changes one slot (parent, effect list, effect parameters) without resending the tree; a slot can be emptied (a tombstone: no effects, parent root, lanes held at 0 by main).
- A **structural** variant carries a frame: the core applies it at the start of the first quantum at or after that frame, never splitting the quantum.
- Effect parameter changes on an unchanged effect kind **glide over 20 ms** in per-quantum steps (filters: frequency and Q; compressor: every parameter; reverb send level).
- The core keeps the shared convolver running until its input has been silent for the IR's length plus `IDLE_MARGIN_QUANTA`, then resets it (no wire field; stated so the test plan covers it).
- **Bit-identity:** an unchanged tree, an asap BUS_MIX and MASTER with lanes R–U at identity render exactly today's samples; M5-0's goldens must show it, and the mix order with no level rules must equal today's (`bus.rs:386-399`).

**C17. Sidechain rules** (Arch §4.6).
- Per rule: target slot, trigger slot, mode (level or presence); for level, detector (peak or RMS), threshold dBFS, amount (0..1), attack and release (seconds, as today's ranges).
- Sent at BUS_CONFIG and when rules change live; replayed on a rebuild.
- **Validation** (settings): at most **8 level-mode rules** per project (the worst-case budget, Arch §7.2); refuse `target === trigger`, a trigger that is the target's ancestor, and **any set of level rules whose trigger → target edges with the tree form a cycle**, naming the rules. Presence rules are exempt from the cycle check.

## Settings and public API

**C18. The `audio` settings the architecture reads** (Arch §4.4, §4.6).
- `meter: "loudness"` on at most 8 buses besides master.
- `audio.loudnessTargets`: each entry's integrated target (LUFS), tolerance (LU) and true-peak ceiling (dBTP); the default table is owner decision 4. The ceiling drives C11's gate.
- The project option "reset loudness at Play start" (record change 21), default on.
- The ducking rule format of record change 24, `mode` required; new rules default to `level` (owner decision 6).

**C19. Mix operations and `mixer.apply`** (Arch §3.2, §3.3, §4.7).
- The op set: set (bus value, effect parameter, snapshot entry, rule field, meter flag), add (bus, effect, send, snapshot, rule), remove, rename (explicit), move (bus parent, effect order, a sound's bus).
- Each op says whether it is **direct** or **structural** as Arch §4.7's table classifies it, so `coreBackend` doesn't re-derive it.
- A **preview** op (a drag in progress) applies live and makes no undo entry; the **commit** on release makes one undo step with the final value.
- Compare with Play start produces ops flagged "no undo, no save".
- `apply` never clears runtime state (script volumes, fades, the active snapshot, duck followers).

**C20. The SDK hook** (Arch §3.2, §4.7).
- `editor.project.changed(sectionKey, ops)` is delivered synchronously in the turn that made the edit (no frame wait), in op order, to the play Engine only while Play runs.
- The audio plugin flushes a mini-batch at once for preview ops on lanes A and G (Arch §3.2's ≤ 50 ms gate).

**C21. The slot table as data** (Arch §2.3, §4.7).
- Mix-op records and keyframes carry slots, not project positions; a rename keeps the slot; a tombstone's slot is reusable only once the dip has ended and no voice references it.
- `Audio.debug()` lists the table (name, slot, state).

**C22. `Bus.loudness` semantics** (Arch §2.2, §4.4).
- `incomplete`: set by lost sub-blocks or a shed span, cleared only by a reset of integrated.
- `tainted`: set while a monitor control affects the bus (solo: every meter; mute of X: X, its ancestors, master), cleared by a reset.
- `paused` with a reason: user or shed.
- A lower-bound indication on `maxTruePeak` (below the ceiling, with gated quanta).
- `elapsed` excludes paused, shed and gap time.
- `-Infinity` until 4 sub-blocks (momentary) and 30 (short-term), as record change 13 says for empty values.

**C23. Capability flags and `Audio.debug()` additions** (Arch §9).
- `loudness`, `levelDucking`, `cpu` with a reason when false (no core, clock too coarse, not yet measured), `stampedBusRamps`.
- Debug fields: recorder state and sizes; `loadPermille` with its window, clock step, `clockSteps`, refit residual; the slot table; `busRecordsEarly`, `sidechainLate`, `liveRefused`; the ladder's loudness step.

**C24. `Audio.capture`** (Arch §2.1, §3.1).
- `start()` returns a Promise (lazy recorder); a start while recording joins and writes a marker; `stop()` releases the caller's hold; `save(name?)` snapshots and resolves the path or file name; with nothing recorded it rejects (record change 33).
- Whether a start from Held appends (with a gap) or clears is the senior's choice; the architecture supports both.
- The built-in trigger rotates at most 16 files.

## Tests and editor models

**C25. Tests the architecture depends on** (Arch §3.3, §4.3, §4.5, §7.4).
- **Click tests** (S4's metric on the loopback host) for every structural edit under the dip, compressor and filter glides, and send removal with the convolver run-out.
- **Fake-clock CPU test:** the shell's `Date.now` injected; cadence switches, skipped posts, a clock step and a 2 ms step clock give the windows of Arch §4.3.
- **Ring tests:** a small ring evicts whole segments and decodes from its tail; a STATUS copy allocates nothing (heap delta over 10,000 blocks).
- **Rebuild replay:** a dip in flight and a lane mid-ramp replay at their end states; slots identical before and after.
- **Loudness integrity:** a 3 s main stall loses nothing; 4 s sets `incomplete`; an EPOCH keeps integrated.
- **Bit-identity goldens** for M5-0 (C16) and the mix-order equality with no level rules.
- **The fader gate** as an e2e spec measuring event to core output (Arch §3.2).
- **Metered scenes:** typical and worst (Arch §7.2), and the ladder step in force.

**C26. The capture Worker's protocol and the timeline model** (Arch §3.7).
- Messages: open (bytes) → summary, warnings, audio section, overview tracks; seek(t) → a snapshot (voice table with reasons, per-bus gain factors, loudness readings and flags, markers near t); range(t0, t1, columns) → downsampled track data for drawing; live segment append while recording.
- All drawing data arrives as preallocated typed arrays (transferred), so the views render without per-block objects (Arch §7.3).
- The timeline model, the mixer-op model and the loudness-reading model are pure and tested, registered through the editor SDK in one place (the owner's UI/UX note).
