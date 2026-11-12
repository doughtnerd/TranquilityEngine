# 0171 audio mix: the architect's contracts for `api-and-models.md` (round 2B)

What [architecture.md](architecture.md) (**Arch §n**) needs from the senior engineer's document, numbered **C1–C27**. Revision 2 applies the coordinator's rulings R1–R25 ([rulings.md](rulings.md)) and the senior's round-2A answers (their §4). Byte layouts, names, opcodes and parse rules are the senior's.

**Status key:**
- **met:** the round-1 API already does it;
- **agreed:** the senior's round-2A answer or a ruling settles it, and their round-2B text encodes it (to verify at the coordinator's check);
- **open:** still needs a decision.

No contract is open. One is new: **C27**, the linked structural sequence (R8).

## Closed: met in round 1

| # | Contract | Where in [API] (round-1 numbering) |
|---|---|---|
| C5 | names: META table plus in-stream NAMES before first use; strings as data | §5.2, §5.3 |
| C6 | other records: raw STATUS, events with reasons, MIXOP, MARKER, master and hidden-mute events; plus a ring-only WRAP marker the saver strips (their answer) | §5.3, §5.6 |
| C9 | five cumulative work-unit totals, f64 | §4.3 |
| C11 | `LOUD_CONFIG`: master implicit, metered slots, `tpGateDbfs`; pause, resume and reset main-only | §4.2 |
| C15 | `BUS_PRESENCE`: one bit per trigger slot, a level, in the replay, stamped at the voice's frame (R4) | §4.2 |
| C18 | settings: `meter`, `loudnessTargets`, `loudnessResetOnPlay`, required `mode` | §2 |
| C19 | `MixOp` with `opClass`, preview and commit, Compare ops with no undo and no save, `apply` keeps runtime state | §6.2 |
| C21 | the slot table as data, `busRef` = gen << 8 \| slot; their 2B adds `Audio.debug().mix.slots` | §6.3 |
| C26 | the Worker protocol: open, `seek`, `range` with transferred arrays, **live segments appended every second** (R17: the main-thread `LiveSource` goes; Rc6) | §6, §7 |

## Agreed: to verify in round 2B

| # | Contract | Ruling | What the senior's round-2B text must say |
|---|---|---|---|
| C1 | record envelope | R14 | `flags` bit 0 **deferred**, the real stamp as f64 in the payload; disorder bounded to 1 s within an epoch (Arch §4.1) |
| C2 | EPOCH | R14 | reasons start, trap, stall, device, rate, latency, mode; **no resume**; `timeOffset` f64 s and the limiter latency |
| C3 | GAP | R14 | reasons paused, rebuild, held, dropped (with first and last missing seq), recordTooLarge; `hidden` means `pause` mode only |
| C4 | keyframe | R13 | voice rows ≤ 24 B, cap 8,192; each lane's value **and target**; per-meter readings (M, S, I, LRA, max true peak, max M, elapsed, flags); active snapshot; event state; interval `keyframeIntervalMs` = 1,000 of rendered frames |
| C7 | file header and limits | R16 | `compressed` flag (clear when `CompressionStream` is missing), `ringBytes`, `firstFrame`; `CAPTURE_MAX_UNCOMPRESSED_BYTES` = 64 MiB checked before and during inflate; largest record 256 KB |
| C8 | shell CPU fields | R18 | f64 `busyMsTotal`, `quantaTotal`; `clockStepMs`; u16 `clockSteps`; **`loadPermille` stays 0**, documented as superseded by change 6; main computes the window (one TypeScript implementation, fake-clock tested) |
| C10 | loudness in STATUS | R19 | the 16 B item (new-block count and flags packed; `firstSeq`, `truePeak`, `gatedQuanta`), energies bus-major, oldest first; worst case ≈ 17,824 of 20,480 B (≥ 1 KB spare, met) |
| C12 | duck gains | R19 | rule targets only, `{u16 slot, u16 pad, f32 gain}` |
| C13 | header, ladder, ABI | R19, R21 | `loudShed`, `busRecordsEarly`, `sidechainLate`, `clockSteps` in bytes 244–255; `m3Shed` unchanged; ABI 4.0, envelope 1.3 |
| C14 | lane ramp | R1, R2, R6 | seven lanes (five main-written, `duck` and `automation` core-owned); `frames = 0` a literal step for replay and RESET only; ramps start from the lane's current value; frame order within a quantum; overflow applies at the quantum's start and counts `busRecordsEarly`; asap lone-lane ramps use `Ramp::next` arithmetic (R3) |
| C16 | per-slot record, sends, run-out | R7, R11 | `BUS_SLOT` (0x1C): one slot in the BUS_CONFIG item layout, with a frame at quantum granularity; `BUS_CONFIG` stays the full tree (init, replay); tombstone = silent root (R9); compressor-only smoothing (20 ms); the send scaled by the bus's lanes through a scratch (Arch §4.5: all seven if O1 is (a), `monitor` × `dip` if (b)); the convolver run-out (Rv1); goldens: digests unchanged except R11's named case |
| C17 | rules and validation | R5 | edges for level rules only; any level-rule cycle refused, naming the rules; presence rules keep the ancestor and self check; `MAX_DUCK_RULES` = 32, at most 8 level |
| C20 | the hook | R22 | `onSectionChanged(key, listener)`, fired synchronously from `Session.edit` after `history.push` and from `step`, valid drafts only; previews bypass it (`mixer.apply` + `flushNow`); ADR 0147 gets an appended amendment |
| C22 | `Bus.loudness` | R20 | `tainted` from monitor controls and Compare only (mute of X: X, its ancestors and master; solo: all); MASTER ≠ 1, mutes and the hidden mute set `target.state = "suspended"`; a lower-bound mark on `maxTruePeak`; `elapsed` excludes paused, shed and gap time; a ladder pause sets `incomplete` |
| C23 | debug | R10, R18 | `mixCaps.cpuReason`; recorder state and sizes; CPU window, clock step, `clockSteps`, refit residual; the slot table; `busRecordsEarly`, `sidechainLate`, `liveDeferred`; `loudShed` |
| C24 | `Audio.capture` | R16 | a start from Held begins a new take after a GAP; `save()` writes from the latest take's start keyframe; a start while recording joins with a marker; trigger rotation **16** on Tauri and Android, the web stops at 16 per session with a message |
| C25 | tests | R23 | Ld8 (a 3 s stall loses nothing, 4 s sets `incomplete`, an EPOCH keeps integrated); Rv1's cases in Ck1 (send scaling under the dip and monitor, the run-out); Bn3 at master + 8; the ladder step in `ladderRecoveryLoopback.test.ts`; the fader gate on the audio clock (Fg1) and as an e2e spec; the late-batch shift (C27) |

## New

**C27. The linked structural sequence** (R8; Arch §3.3).
- **Records:** the dip-down `BUS_RAMP` (lane `dip`, 1 → 0 over `DIP_FRAMES` at F0), the `BUS_SLOT` change(s) at B = the first quantum start ≥ F0 + `DIP_FRAMES`, and the dip-up `BUS_RAMP` (0 → 1 at B). For a removal, every removed descendant's records are included; a moved voice's FADE and `SET_PARAMS bus` records also join.
- **Encoding:** the records carry a **sequence tag** (the senior's choice of field: a flags bit on the head plus a sequence id, or a leading marker record) so the core can find all of them when it pops the first.
- **Batching:** main writes a sequence into **one** batch and never splits it across batches. If the batch can't hold it, main flushes and starts a new one.
- **Late arrival:** when the first record's frame is before the quantum being rendered, the core shifts every record of the sequence by s = ⌈(q − F0) / 128⌉ × 128, then counts `lateCommands` + 1 and `maxLatenessFrames` once per sequence.
- **Serialisation:** a sequence whose F0 falls before the in-flight sequence's (possibly shifted) end is shifted to that end. No new STATUS field.
- **Written by:** main (the slot table), for every structural op class of Arch §4.7.
